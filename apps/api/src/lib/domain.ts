import { BOOK_STATUSES, MOOD_TAGS, type BookStatus, type MoodTag } from '@paper-book-traces/shared';
import { AppError } from './errors.js';

export const STATUS_TRANSITIONS: Record<BookStatus, BookStatus[]> = {
  TO_READ: ['READING', 'ABANDONED'],
  READING: ['PAUSED', 'READ', 'ABANDONED'],
  PAUSED: ['READING', 'READ', 'ABANDONED'],
  READ: ['READING'],
  ABANDONED: []
};

export function normalizeText(value: string): string {
  return value.normalize('NFC').trim();
}

export function parsePositivePage(value: number, field = 'pageNumber'): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(422, 'VALIDATION_ERROR', '页码必须为大于等于 1 的整数', {
      [field]: '页码必须为大于等于 1 的整数'
    });
  }
  return value;
}

export function validatePageRange(startPage: number, endPage: number, pageCount: number | null): void {
  parsePositivePage(startPage, 'startPage');
  parsePositivePage(endPage, 'endPage');
  if (startPage > endPage) {
    throw new AppError(422, 'VALIDATION_ERROR', '起始页不能大于结束页', {
      endPage: '结束页必须大于等于起始页'
    });
  }
  if (pageCount !== null && endPage > pageCount) {
    throw new AppError(422, 'VALIDATION_ERROR', `页码不能超过总页数 ${pageCount}`, {
      endPage: `页码不能超过总页数 ${pageCount}`
    });
  }
}

export function validateSinglePage(pageNumber: number, pageCount: number | null): void {
  parsePositivePage(pageNumber);
  if (pageCount !== null && pageNumber > pageCount) {
    throw new AppError(422, 'VALIDATION_ERROR', `页码不能超过总页数 ${pageCount}`, {
      pageNumber: `页码不能超过总页数 ${pageCount}`
    });
  }
}

export function assertBookStatus(value: string): asserts value is BookStatus {
  if (!BOOK_STATUSES.includes(value as BookStatus)) {
    throw new AppError(422, 'VALIDATION_ERROR', '书目状态无效', { status: '书目状态无效' });
  }
}

export function validateStatusTransition(current: BookStatus, next: BookStatus): void {
  if (current === next) {
    if (current === 'READ') {
      throw new AppError(409, 'STATUS_UNCHANGED', '当前已是已读完状态');
    }
    return;
  }
  if (!STATUS_TRANSITIONS[current].includes(next)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', '不允许执行该状态变更');
  }
}

export function normalizeMoodTags(tags: MoodTag[]): MoodTag[] {
  const unique = [...new Set(tags)];
  if (unique.length < 1 || unique.length > 3) {
    throw new AppError(422, 'VALIDATION_ERROR', '请选择 1 至 3 个情绪标签', {
      moodTags: '请选择 1 至 3 个情绪标签'
    });
  }
  if (unique.some((tag) => !MOOD_TAGS.includes(tag))) {
    throw new AppError(422, 'VALIDATION_ERROR', '包含未知情绪标签', {
      moodTags: '包含未知情绪标签'
    });
  }
  return unique;
}

export function isRestoreWindowOpen(deletedAt: Date | null, now = new Date()): boolean {
  return Boolean(deletedAt && now.getTime() - deletedAt.getTime() <= 24 * 60 * 60 * 1000);
}

export function isStrictlyEditable(editableUntil: Date, now = new Date()): boolean {
  return now.getTime() <= editableUntil.getTime();
}

export interface ReflectionDeletionState {
  /** 删除完成感受后，书目是否应从“已读完”退回“阅读中”。 */
  bookGoesReading: boolean;
}

/**
 * 删除一条完成感受后的书目状态决策。
 *
 * 不变量：书目处于 READ 时，必须存在至少一条有效完成感受，且其最大轮次
 * 与“最后一次读完”相对应。只有被删的是当前最大的有效轮次时才退回 READING。
 */
export function resolveReflectionDeletion(input: {
  bookStatus: BookStatus;
  deletedRound: number;
  activeMaxRoundAfterDelete: number;
}): ReflectionDeletionState {
  return {
    bookGoesReading:
      input.bookStatus === 'READ' && input.activeMaxRoundAfterDelete < input.deletedRound
  };
}

export interface ReflectionUndeletionState {
  /** 恢复后书目需要切换到的状态；为 null 表示保持原状态。 */
  nextBookStatus: BookStatus | null;
}

/**
 * 恢复（取消删除 / 历史版本回滚）一条完成感受后的书目状态决策。
 *
 * - 恢复的轮次成为新的最大有效轮次，且书目在 READING：书随最后一次读完回到 READ；
 * - 恢复的只是较旧的轮次（已有更新的有效轮次）：状态不动；
 * - 已经是 READ：状态不动；
 * - PAUSED（搁置后恢复旧感受）：状态不动，READ 与 PAUSED 之间不允许直接跳转；
 * - TO_READ / ABANDONED 与“存在读完感受”矛盾，拒绝恢复，由调用方报冲突。
 */
export function resolveReflectionUndeletion(input: {
  bookStatus: BookStatus;
  restoredRound: number;
  activeMaxRoundBeforeRestore: number;
}): ReflectionUndeletionState {
  if (input.bookStatus === 'TO_READ' || input.bookStatus === 'ABANDONED') {
    throw new AppError(409, 'RESTORE_CONFLICT', '书目当前状态不允许恢复完成感受');
  }
  const becomesLatest = input.restoredRound > input.activeMaxRoundBeforeRestore;
  if (input.bookStatus === 'READING' && becomesLatest) {
    return { nextBookStatus: 'READ' };
  }
  return { nextBookStatus: null };
}
