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

export const REFLECTION_EDIT_WINDOW_DAYS = 7;

export function reflectionEditWindow(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFLECTION_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export function isRestoreWindowOpen(deletedAt: Date | null, now = new Date()): boolean {
  return Boolean(deletedAt && now.getTime() - deletedAt.getTime() <= 24 * 60 * 60 * 1000);
}

export function isStrictlyEditable(editableUntil: Date, now = new Date()): boolean {
  return now.getTime() <= editableUntil.getTime();
}

/**
 * 恢复一条（软删除的）读完感受后书目应当处于的状态。
 * 只有“被恢复的是最新一轮”才允许恢复，此时书目必须回到 READ；
 * 存在更新的未删除轮次时不允许恢复（由调用方先拒绝），避免轮次错配。
 * completionRound 永远不变，轮次不因删除/恢复重排。
 */
export function expectedBookStatusOnRestore(isLatestActiveRound: boolean): BookStatus | null {
  return isLatestActiveRound ? 'READ' : null;
}
