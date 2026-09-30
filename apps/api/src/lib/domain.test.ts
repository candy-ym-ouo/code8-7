import { describe, expect, it } from 'vitest';
import {
  expectedBookStatusOnRestore,
  isRestoreWindowOpen,
  isStrictlyEditable,
  normalizeMoodTags,
  reflectionEditWindow,
  validatePageRange,
  validateStatusTransition
} from './domain.js';
import { AppError } from './errors.js';

describe('domain rules', () => {
  it('allows declared status transitions', () => {
    expect(() => validateStatusTransition('READING', 'READ')).not.toThrow();
    expect(() => validateStatusTransition('READ', 'READING')).not.toThrow();
  });

  it('rejects illegal status transitions', () => {
    expect(() => validateStatusTransition('TO_READ', 'READ')).toThrow(AppError);
    expect(() => validateStatusTransition('ABANDONED', 'READING')).toThrow(AppError);
  });

  it('validates page ranges and page count', () => {
    expect(() => validatePageRange(42, 44, 300)).not.toThrow();
    expect(() => validatePageRange(44, 42, 300)).toThrow(AppError);
    expect(() => validatePageRange(42, 301, 300)).toThrow(AppError);
  });

  it('normalizes mood tags and rejects empty or duplicate overrun', () => {
    expect(normalizeMoodTags(['MOVED', 'MOVED', 'CALM'])).toEqual(['MOVED', 'CALM']);
    expect(() => normalizeMoodTags([])).toThrow(AppError);
  });

  it('enforces restore and edit windows', () => {
    const now = new Date('2026-09-24T12:00:00.000Z');
    expect(isRestoreWindowOpen(new Date('2026-09-24T00:00:00.000Z'), now)).toBe(true);
    expect(isRestoreWindowOpen(new Date('2026-09-22T00:00:00.000Z'), now)).toBe(false);
    expect(isStrictlyEditable(new Date('2026-09-25T00:00:00.000Z'), now)).toBe(true);
    expect(isStrictlyEditable(new Date('2026-09-23T00:00:00.000Z'), now)).toBe(false);
  });

  it('opens a 7-day edit window from creation', () => {
    const createdAt = new Date('2026-09-24T12:00:00.000Z');
    expect(reflectionEditWindow(createdAt).toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it('derives book status on reflection restore without rearranging rounds', () => {
    // 只有恢复最新一轮才允许，此时书目必须回到 READ。
    expect(expectedBookStatusOnRestore(true)).toBe('READ');
    // 存在更新的未删除轮次时不允许恢复（返回 null 表示调用方应拒绝）。
    expect(expectedBookStatusOnRestore(false)).toBeNull();
  });
});
