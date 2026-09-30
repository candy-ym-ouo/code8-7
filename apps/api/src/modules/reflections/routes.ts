import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { MOOD_TAGS, type BookStatus, type MoodTag } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { expectedBookStatusOnRestore, normalizeMoodTags, normalizeText } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';

const updateSchema = z
  .object({
    moodTags: z.array(z.enum(MOOD_TAGS as [MoodTag, ...MoodTag[]])).min(1).max(3).optional(),
    text: z.string().max(5000).optional(),
    version: z.number().int().positive()
  })
  .refine((value) => value.moodTags !== undefined || value.text !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const deleteSchema = z.object({ version: z.number().int().positive() });

const restoreHistorySchema = z.object({
  revisionNumber: z.number().int().positive(),
  version: z.number().int().positive()
});

function serialize(item: {
  id: string;
  bookId: string;
  completionRound: number;
  moodTags: MoodTag[];
  reflection: string | null;
  completedAt: Date;
  editableUntil: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: item.id,
    bookId: item.bookId,
    completionRound: item.completionRound,
    moodTags: item.moodTags,
    text: item.reflection ?? '',
    completedAt: item.completedAt,
    editableUntil: item.editableUntil,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function serializeRevision(item: {
  id: string;
  reflectionId: string;
  revisionNumber: number;
  kind: string;
  moodTags: MoodTag[];
  reflection: string | null;
  version: number;
  restoredFromRevision: number | null;
  createdAt: Date;
}) {
  return {
    id: item.id,
    revisionNumber: item.revisionNumber,
    kind: item.kind,
    moodTags: item.moodTags,
    text: item.reflection ?? '',
    version: item.version,
    restoredFromRevision: item.restoredFromRevision,
    createdAt: item.createdAt
  };
}

type RevisionTx = Prisma.TransactionClient;

async function nextRevisionNumber(tx: RevisionTx, reflectionId: string): Promise<number> {
  const latest = await tx.completionReflectionRevision.aggregate({
    where: { reflectionId },
    _max: { revisionNumber: true }
  });
  return (latest._max.revisionNumber ?? 0) + 1;
}

export const reflectionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/reflections', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    const reflections = await prisma.completionReflection.findMany({
      where: { bookId, userId, deletedAt: null },
      orderBy: [{ completionRound: 'desc' }]
    });
    return { items: reflections.map(serialize) };
  });

  // 修订历史：包含完整快照，前端按 revisionNumber 做两版对比。
  app.get('/reflections/:reflectionId/revisions', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const userId = currentUser(request).id;
    const reflection = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null }
    });
    if (!reflection) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    const revisions = await prisma.completionReflectionRevision.findMany({
      where: { reflectionId: id, userId },
      orderBy: { revisionNumber: 'desc' }
    });
    return {
      items: revisions.map(serializeRevision),
      editableUntil: reflection.editableUntil,
      currentVersion: reflection.version
    };
  });

  app.patch('/reflections/:reflectionId', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '完成感受信息无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    const moodTags = parsed.data.moodTags ? normalizeMoodTags(parsed.data.moodTags) : existing.moodTags;
    const reflection =
      parsed.data.text === undefined
        ? existing.reflection
        : parsed.data.text
          ? normalizeText(parsed.data.text)
          : null;

    const updated = await prisma.$transaction(async (tx) => {
      // 行级序列化：多端同时提交时，version 不匹配的一端必然失败，不会互相覆盖。
      await tx.$queryRaw`SELECT id FROM completion_reflections WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.completionReflection.findUniqueOrThrow({ where: { id } });
      if (current.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
      if (new Date().getTime() > current.editableUntil.getTime()) {
        throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期，仅可只读查看');
      }
      if (parsed.data.version !== current.version) {
        throw new AppError(409, 'STALE_WRITE', '完成感受已在其他设备被修改，请刷新后重试');
      }
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: current.version },
        data: { moodTags, reflection, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他设备被修改');
      const revisionNumber = await nextRevisionNumber(tx, id);
      await tx.completionReflectionRevision.create({
        data: {
          userId,
          reflectionId: id,
          bookId: existing.bookId,
          revisionNumber,
          kind: 'UPDATED',
          moodTags,
          reflection,
          version: current.version + 1
        }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'UPDATED',
        payload: {
          completionRound: current.completionRound,
          revisionNumber,
          moodTags,
          summary: reflection ? reflection.slice(0, 120) : ''
        }
      });
      return tx.completionReflection.findUniqueOrThrow({ where: { id } });
    });
    return { reflection: serialize(updated) };
  });

  app.delete('/reflections/:reflectionId', async (request, reply) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${existing.bookId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM completion_reflections WHERE id = ${id}::uuid FOR UPDATE`;
      const currentReflection = await tx.completionReflection.findFirstOrThrow({ where: { id, userId } });
      if (currentReflection.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
      const currentBook = await tx.book.findFirstOrThrow({ where: { id: existing.bookId } });
      if (new Date().getTime() > currentReflection.editableUntil.getTime()) {
        throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期，不能删除');
      }
      if (parsed.data.version !== currentReflection.version) {
        throw new AppError(409, 'STALE_WRITE', '完成感受已在其他设备被修改，请刷新后重试');
      }
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: currentReflection.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他设备被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'DELETED',
        payload: { completionRound: currentReflection.completionRound }
      });
      // 删除的是最新一轮时书目回到 READING；completionRound 保留不重排。
      const latestActive = await tx.completionReflection.aggregate({
        where: { bookId: existing.bookId, deletedAt: null },
        _max: { completionRound: true }
      });
      if (
        currentBook.status === 'READ' &&
        (latestActive._max.completionRound ?? 0) < currentReflection.completionRound
      ) {
        await tx.book.update({
          where: { id: existing.bookId },
          data: { status: 'READING', version: { increment: 1 } }
        });
        await writeEvent(tx, {
          userId,
          bookId: existing.bookId,
          entityType: 'BOOK',
          entityId: existing.bookId,
          action: 'STATUS_CHANGED',
          payload: { previousStatus: 'READ', nextStatus: 'READING', reason: 'reflection_deleted' }
        });
      }
    });
    return reply.status(204).send();
  });

  // 撤销删除（24 小时窗口）。状态与轮次必须在事务内重新判定，不能套用删除前的旧状态。
  app.post('/reflections/:reflectionId/restore', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除完成感受不存在');
    if (new Date().getTime() - existing.deletedAt.getTime() > 24 * 60 * 60 * 1000) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');

    const restored = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${existing.bookId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM completion_reflections WHERE id = ${id}::uuid FOR UPDATE`;
      const reflection = await tx.completionReflection.findFirstOrThrow({ where: { id, userId } });
      if (!reflection.deletedAt) throw new AppError(409, 'RESTORE_CONFLICT', '完成感受未处于删除状态');
      const book = await tx.book.findFirstOrThrow({ where: { id: existing.bookId } });

      // 部分唯一索引兜底：同轮次已有新的未删除记录时禁止恢复。
      const duplicate = await tx.completionReflection.findFirst({
        where: {
          bookId: existing.bookId,
          completionRound: reflection.completionRound,
          deletedAt: null,
          id: { not: id }
        }
      });
      if (duplicate) {
        throw new AppError(409, 'RESTORE_CONFLICT', '该完成轮次已有有效感受，无法恢复');
      }

      const latestActive = await tx.completionReflection.aggregate({
        where: { bookId: existing.bookId, deletedAt: null },
        _max: { completionRound: true }
      });
      const isLatest = (latestActive._max.completionRound ?? 0) < reflection.completionRound;
      if (!isLatest) {
        // 存在更新的完成轮次：恢复旧轮次会让历史轮次与最新状态错配，直接拒绝。
        throw new AppError(409, 'RESTORE_CONFLICT', '已有更新的完成轮次，无法恢复该旧轮次感受');
      }
      // 恢复的是最新轮次：只允许把书从 READING 置回 READ，
      // 搁置 / 弃读等情况下不能借恢复强行变成读完。
      if (book.status !== 'READING') {
        throw new AppError(409, 'RESTORE_CONFLICT', '书目状态已变化，无法恢复该完成感受');
      }
      const nextStatus: BookStatus = expectedBookStatusOnRestore(true) ?? 'READ';

      const value = await tx.completionReflection.update({
        where: { id },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await tx.book.update({
        where: { id: existing.bookId },
        data: { status: nextStatus, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'BOOK',
        entityId: existing.bookId,
        action: 'STATUS_CHANGED',
        payload: { previousStatus: book.status, nextStatus, reason: 'reflection_restored' }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'RESTORED',
        payload: { completionRound: value.completionRound }
      });
      return value;
    });
    return { reflection: serialize(restored) };
  });

  // 恢复某个历史修订为当前内容（只在 7 天可编辑期内，version 必须匹配）。
  app.post('/reflections/:reflectionId/revisions/restore', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const parsed = restoreHistorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '恢复参数无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null }
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');

    const restored = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM completion_reflections WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.completionReflection.findUniqueOrThrow({ where: { id } });
      if (current.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
      if (new Date().getTime() > current.editableUntil.getTime()) {
        throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期，历史版本只读');
      }
      if (parsed.data.version !== current.version) {
        throw new AppError(409, 'STALE_WRITE', '完成感受已在其他设备被修改，请刷新后重试');
      }
      const source = await tx.completionReflectionRevision.findFirst({
        where: { reflectionId: id, userId, revisionNumber: parsed.data.revisionNumber }
      });
      if (!source) throw new AppError(404, 'NOT_FOUND', '历史修订不存在');

      const moodTags = normalizeMoodTags(source.moodTags);
      const reflection = source.reflection;
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: current.version },
        data: { moodTags, reflection, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他设备被修改');
      const revisionNumber = await nextRevisionNumber(tx, id);
      await tx.completionReflectionRevision.create({
        data: {
          userId,
          reflectionId: id,
          bookId: current.bookId,
          revisionNumber,
          kind: 'RESTORED_HISTORY',
          moodTags,
          reflection,
          version: current.version + 1,
          restoredFromRevision: source.revisionNumber
        }
      });
      await writeEvent(tx, {
        userId,
        bookId: current.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'REVISION_RESTORED',
        payload: {
          completionRound: current.completionRound,
          fromRevision: source.revisionNumber,
          revisionNumber
        }
      });
      return tx.completionReflection.findUniqueOrThrow({ where: { id } });
    });
    return { reflection: serialize(restored) };
  });
};
