import { describe, expect, it } from 'vitest';
import {
  isRestoreWindowOpen,
  isStrictlyEditable,
  normalizeMoodTags,
  resolveReflectionDeletion,
  resolveReflectionUndeletion,
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

  it('keeps book status aligned with the latest active round when deleting reflections', () => {
    // READ + 删除最大轮次 => 回到 READING
    expect(
      resolveReflectionDeletion({ bookStatus: 'READ', deletedRound: 2, activeMaxRoundAfterDelete: 1 })
        .bookGoesReading
    ).toBe(true);
    // READ + 删除较旧轮次（还有更新的有效轮次）=> 状态不动
    expect(
      resolveReflectionDeletion({ bookStatus: 'READ', deletedRound: 1, activeMaxRoundAfterDelete: 2 })
        .bookGoesReading
    ).toBe(false);
    // READ + 删除唯一轮次 => 回到 READING
    expect(
      resolveReflectionDeletion({ bookStatus: 'READ', deletedRound: 1, activeMaxRoundAfterDelete: 0 })
        .bookGoesReading
    ).toBe(true);
    // PAUSED 状态下删除不回 READING（状态变更只能走状态机）
    expect(
      resolveReflectionDeletion({ bookStatus: 'PAUSED', deletedRound: 1, activeMaxRoundAfterDelete: 0 })
        .bookGoesReading
    ).toBe(false);
  });

  it('recomputes book status correctly when undeleting reflections', () => {
    // READING + 恢复成为最新轮次 => READ
    expect(
      resolveReflectionUndeletion({
        bookStatus: 'READING',
        restoredRound: 2,
        activeMaxRoundBeforeRestore: 1
      }).nextBookStatus
    ).toBe('READ');
    // READING + 恢复较旧轮次 => 状态不动
    expect(
      resolveReflectionUndeletion({
        bookStatus: 'READING',
        restoredRound: 1,
        activeMaxRoundBeforeRestore: 2
      }).nextBookStatus
    ).toBeNull();
    // READ + 恢复任何轮次 => 状态不动
    expect(
      resolveReflectionUndeletion({
        bookStatus: 'READ',
        restoredRound: 1,
        activeMaxRoundBeforeRestore: 0
      }).nextBookStatus
    ).toBeNull();
    // PAUSED + 恢复成为最新轮次也不直接跳到 READ
    expect(
      resolveReflectionUndeletion({
        bookStatus: 'PAUSED',
        restoredRound: 3,
        activeMaxRoundBeforeRestore: 1
      }).nextBookStatus
    ).toBeNull();
  });

  it('refuses to restore reflections under TO_READ or ABANDONED books', () => {
    expect(() =>
      resolveReflectionUndeletion({ bookStatus: 'TO_READ', restoredRound: 1, activeMaxRoundBeforeRestore: 0 })
    ).toThrow(AppError);
    expect(() =>
      resolveReflectionUndeletion({
        bookStatus: 'ABANDONED',
        restoredRound: 1,
        activeMaxRoundBeforeRestore: 0
      })
    ).toThrow(AppError);
  });
});
