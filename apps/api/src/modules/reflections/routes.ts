import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { MOOD_TAGS, type BookStatus, type MoodTag, type RevisionAction } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import {
  isStrictlyEditable,
  normalizeMoodTags,
  normalizeText,
  resolveReflectionDeletion,
  resolveReflectionUndeletion
} from '../../lib/domain.js';
import { diffMoodTags, diffText, isSameReflectionContent } from '../../lib/diff.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';

const requiredVersionSchema = z.object({
  version: z.number({ message: '必须携带 version' }).int().positive()
});

const updateSchema = z
  .object({
    moodTags: z.array(z.enum(MOOD_TAGS as [MoodTag, ...MoodTag[]])).min(1).max(3).optional(),
    text: z.string().max(5000).optional(),
    version: z.number({ message: '必须携带 version' }).int().positive()
  })
  .refine((value) => value.moodTags !== undefined || value.text !== undefined, {
    message: '至少提供一个要更新的字段'
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

const REVISION_ACTION_LABELS: Record<RevisionAction, string> = {
  INITIAL: '初次记录',
  UPDATED: '内容修订',
  DELETED: '删除',
  RESTORED: '恢复删除',
  VERSION_RESTORED: '恢复历史版本'
};

function serializeRevision(item: {
  id: string;
  reflectionId: string;
  bookId: string;
  revisionNo: number;
  action: RevisionAction;
  moodTags: MoodTag[];
  reflection: string | null;
  createdAt: Date;
}) {
  return {
    id: item.id,
    reflectionId: item.reflectionId,
    bookId: item.bookId,
    revisionNo: item.revisionNo,
    action: item.action,
    actionLabel: REVISION_ACTION_LABELS[item.action],
    moodTags: item.moodTags,
    text: item.reflection ?? '',
    createdAt: item.createdAt
  };
}

type Tx = Prisma.TransactionClient;

async function appendRevision(
  tx: Tx,
  input: {
    userId: string;
    bookId: string;
    reflectionId: string;
    action: RevisionAction;
    moodTags: MoodTag[];
    reflection: string | null;
    createdAt?: Date;
  }
): Promise<void> {
  const latest = await tx.reflectionRevision.aggregate({
    where: { reflectionId: input.reflectionId },
    _max: { revisionNo: true }
  });
  await tx.reflectionRevision.create({
    data: {
      userId: input.userId,
      bookId: input.bookId,
      reflectionId: input.reflectionId,
      revisionNo: (latest._max.revisionNo ?? 0) + 1,
      action: input.action,
      moodTags: input.moodTags,
      reflection: input.reflection,
      ...(input.createdAt ? { createdAt: input.createdAt } : {})
    }
  });
}

async function activeMaxRound(tx: Tx, bookId: string): Promise<number> {
  const result = await tx.completionReflection.aggregate({
    where: { bookId, deletedAt: null },
    _max: { completionRound: true }
  });
  return result._max.completionRound ?? 0;
}

export const reflectionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/reflections', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    const query = request.query as Record<string, unknown>;
    const includeDeleted = String(query.includeDeleted ?? 'false').toLowerCase() === 'true';
    const reflections = await prisma.completionReflection.findMany({
      where: { bookId, userId, ...(includeDeleted ? {} : { deletedAt: null }) },
      orderBy: [{ completionRound: 'desc' }, { updatedAt: 'desc' }]
    });
    const now = new Date();
    return {
      items: reflections.map((item) => ({
        ...serialize(item),
        deleted: item.deletedAt !== null,
        // 删除后的恢复只在 7 天编辑期内开放，前端据此显示“撤销删除”。
        restorable: item.deletedAt !== null && isStrictlyEditable(item.editableUntil, now)
      }))
    };
  });

  app.get('/reflections/:reflectionId/revisions', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const userId = currentUser(request).id;
    // 历史是只读档案：感受删除后（甚至已过编辑期）仍可查看自己的修订历史。
    const reflection = await prisma.completionReflection.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!reflection || reflection.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    const revisions = await prisma.reflectionRevision.findMany({
      where: { reflectionId: id, userId },
      orderBy: [{ revisionNo: 'asc' }]
    });
    const editable = isStrictlyEditable(reflection.editableUntil);
    return {
      reflection: { ...serialize(reflection), deleted: reflection.deletedAt !== null },
      editable,
      items: revisions.map(serializeRevision)
    };
  });

  app.get('/reflections/:reflectionId/revisions/diff', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const userId = currentUser(request).id;
    const query = request.query as Record<string, unknown>;
    const from = parseId(String(query.from ?? ''), 'from');
    const to = parseId(String(query.to ?? ''), 'to');
    const reflection = await prisma.completionReflection.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!reflection || reflection.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    const [fromRevision, toRevision] = await Promise.all([
      prisma.reflectionRevision.findFirst({ where: { id: from, reflectionId: id, userId } }),
      prisma.reflectionRevision.findFirst({ where: { id: to, reflectionId: id, userId } })
    ]);
    if (!fromRevision || !toRevision) throw new AppError(404, 'NOT_FOUND', '修订版本不存在');
    if (fromRevision.revisionNo > toRevision.revisionNo) {
      throw new AppError(422, 'VALIDATION_ERROR', '起始版本必须早于对比版本', {
        from: '起始版本必须早于对比版本'
      });
    }
    return {
      from: serializeRevision(fromRevision),
      to: serializeRevision(toRevision),
      textDiff: diffText(fromRevision.reflection ?? '', toRevision.reflection ?? ''),
      moodTagDiff: diffMoodTags(fromRevision.moodTags, toRevision.moodTags)
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
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期');
    }
    if (parsed.data.version !== existing.version) {
      throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改，请刷新后重试');
    }
    const moodTags = parsed.data.moodTags ? normalizeMoodTags(parsed.data.moodTags) : existing.moodTags;
    const reflection =
      parsed.data.text === undefined
        ? existing.reflection
        : parsed.data.text
          ? normalizeText(parsed.data.text)
          : null;
    if (isSameReflectionContent({ moodTags, reflection }, existing)) {
      return { reflection: serialize(existing), unchanged: true };
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { moodTags, reflection, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改');
      await appendRevision(tx, {
        userId,
        bookId: existing.bookId,
        reflectionId: id,
        action: 'UPDATED',
        moodTags,
        reflection
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'UPDATED',
        payload: {
          completionRound: existing.completionRound,
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
    const parsed = requiredVersionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效，必须携带 version', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期，无法删除');
    }
    if (parsed.data.version !== existing.version) {
      throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改，请刷新后重试');
    }

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${existing.bookId}::uuid FOR UPDATE`;
      const result = await tx.completionReflection.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改');
      await appendRevision(tx, {
        userId,
        bookId: existing.bookId,
        reflectionId: id,
        action: 'DELETED',
        moodTags: existing.moodTags,
        reflection: existing.reflection
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'DELETED',
        payload: { completionRound: existing.completionRound }
      });

      const currentBook = await tx.book.findFirstOrThrow({ where: { id: existing.bookId } });
      const remainingMax = await activeMaxRound(tx, existing.bookId);
      const decision = resolveReflectionDeletion({
        bookStatus: currentBook.status,
        deletedRound: existing.completionRound,
        activeMaxRoundAfterDelete: remainingMax
      });
      if (decision.bookGoesReading) {
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

  app.post('/reflections/:reflectionId/restore', async (request) => {
    const id = parseId((request.params as { reflectionId: string }).reflectionId, 'reflectionId');
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除完成感受不存在');
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期，无法恢复');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');

    const restored = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM books WHERE id = ${existing.bookId}::uuid FOR UPDATE`;
      const book = await tx.book.findFirstOrThrow({ where: { id: existing.bookId } });
      const activeMax = await activeMaxRound(tx, existing.bookId);
      // 同一轮次已有有效感受（理论上由部分唯一索引兜底）时不得恢复，避免轮次重复。
      const roundTaken = await tx.completionReflection.findFirst({
        where: { bookId: existing.bookId, completionRound: existing.completionRound, deletedAt: null }
      });
      if (roundTaken) throw new AppError(409, 'RESTORE_CONFLICT', '该读完轮次已存在有效感受');
      const decision = resolveReflectionUndeletion({
        bookStatus: book.status,
        restoredRound: existing.completionRound,
        activeMaxRoundBeforeRestore: activeMax
      });
      const value = await tx.completionReflection.update({
        where: { id },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await appendRevision(tx, {
        userId,
        bookId: existing.bookId,
        reflectionId: id,
        action: 'RESTORED',
        moodTags: value.moodTags,
        reflection: value.reflection
      });
      let nextBookStatus: BookStatus | null = null;
      if (decision.nextBookStatus) {
        await tx.book.update({
          where: { id: existing.bookId },
          data: { status: decision.nextBookStatus, version: { increment: 1 } }
        });
        nextBookStatus = decision.nextBookStatus;
      }
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: id,
        action: 'RESTORED',
        payload: { completionRound: value.completionRound }
      });
      if (nextBookStatus) {
        await writeEvent(tx, {
          userId,
          bookId: existing.bookId,
          entityType: 'BOOK',
          entityId: existing.bookId,
          action: 'STATUS_CHANGED',
          payload: {
            previousStatus: book.status,
            nextStatus: nextBookStatus,
            reason: 'reflection_restored'
          }
        });
      }
      return value;
    });
    return { reflection: serialize(restored) };
  });

  app.post('/reflections/:reflectionId/revisions/:revisionId/restore', async (request) => {
    const reflectionId = parseId(
      (request.params as { reflectionId: string }).reflectionId,
      'reflectionId'
    );
    const revisionId = parseId((request.params as { revisionId: string }).revisionId, 'revisionId');
    const parsed = requiredVersionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '恢复参数无效，必须携带 version', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const existing = await prisma.completionReflection.findFirst({
      where: { id: reflectionId, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '完成感受不存在');
    if (!isStrictlyEditable(existing.editableUntil)) {
      throw new AppError(409, 'EDIT_WINDOW_EXPIRED', '完成感受已超过 7 天可编辑期，无法恢复历史版本');
    }
    if (parsed.data.version !== existing.version) {
      throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改，请刷新后重试');
    }
    const targetRevision = await prisma.reflectionRevision.findFirst({
      where: { id: revisionId, reflectionId, userId }
    });
    if (!targetRevision) throw new AppError(404, 'NOT_FOUND', '修订版本不存在');
    if (targetRevision.action === 'DELETED') {
      throw new AppError(422, 'VALIDATION_ERROR', '删除节点不是内容版本，不能恢复为正文', {
        revisionId: '请选择一个内容版本'
      });
    }
    if (
      isSameReflectionContent(
        { moodTags: targetRevision.moodTags, reflection: targetRevision.reflection },
        existing
      )
    ) {
      throw new AppError(409, 'REVISION_IDENTICAL', '该版本与当前内容一致，无需恢复');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.completionReflection.updateMany({
        where: { id: reflectionId, userId, deletedAt: null, version: existing.version },
        data: {
          moodTags: normalizeMoodTags(targetRevision.moodTags),
          reflection: targetRevision.reflection,
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '完成感受已在其他位置被修改');
      const value = await tx.completionReflection.findUniqueOrThrow({ where: { id: reflectionId } });
      await appendRevision(tx, {
        userId,
        bookId: existing.bookId,
        reflectionId,
        action: 'VERSION_RESTORED',
        moodTags: value.moodTags,
        reflection: value.reflection
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: reflectionId,
        action: 'REVISION_RESTORED',
        payload: {
          completionRound: existing.completionRound,
          fromRevisionNo: targetRevision.revisionNo,
          moodTags: value.moodTags,
          summary: value.reflection ? value.reflection.slice(0, 120) : ''
        }
      });
      return value;
    });
    return { reflection: serialize(updated) };
  });
};
