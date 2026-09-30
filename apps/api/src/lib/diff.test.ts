import { describe, expect, it } from 'vitest';
import { diffMoodTags, diffText, isSameReflectionContent, lcsDiff } from './diff.js';

describe('lcsDiff', () => {
  it('marks equal, added and removed tokens', () => {
    expect(lcsDiff(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual([
      { op: 'EQUAL', text: 'a' },
      { op: 'REMOVED', text: 'b' },
      { op: 'EQUAL', text: 'c' },
      { op: 'ADDED', text: 'd' }
    ]);
  });

  it('coalesces adjacent segments of the same op', () => {
    const segments = lcsDiff(['a', 'b'], ['c', 'd']);
    expect(segments).toEqual([
      { op: 'REMOVED', text: 'ab' },
      { op: 'ADDED', text: 'cd' }
    ]);
  });

  it('falls back for oversized inputs', () => {
    const left = 'a'.repeat(600);
    const right = 'b'.repeat(600);
    const segments = lcsDiff(Array.from(left), Array.from(right), 100);
    expect(segments).toHaveLength(2);
    expect(segments[0].op).toBe('REMOVED');
    expect(segments[1].op).toBe('ADDED');
  });
});

describe('diffText', () => {
  it('diffs single-line Chinese text by character', () => {
    const segments = diffText('平静而释然', '平静而喜悦');
    expect(segments).toContainEqual({ op: 'EQUAL', text: '平静而' });
    expect(segments).toContainEqual({ op: 'REMOVED', text: '释然' });
    expect(segments).toContainEqual({ op: 'ADDED', text: '喜悦' });
  });

  it('diffs multiline text by line and keeps newlines attached', () => {
    const segments = diffText('第一段\n第二段', '第一段\n第三段');
    expect(segments.some((segment) => segment.op === 'REMOVED' && segment.text === '第二段')).toBe(true);
    expect(segments.some((segment) => segment.op === 'ADDED' && segment.text === '第三段')).toBe(true);
  });

  it('handles empty sides', () => {
    expect(diffText('', '新内容')).toEqual([{ op: 'ADDED', text: '新内容' }]);
    expect(diffText('旧内容', '')).toEqual([{ op: 'REMOVED', text: '旧内容' }]);
    expect(diffText('', '')).toEqual([]);
  });
});

describe('diffMoodTags', () => {
  it('splits tags into added removed and unchanged', () => {
    expect(diffMoodTags(['CALM', 'SAD'], ['CALM', 'JOYFUL'])).toEqual({
      added: ['JOYFUL'],
      removed: ['SAD'],
      unchanged: ['CALM']
    });
  });
});

describe('isSameReflectionContent', () => {
  it('treats same tag set in different order as equal', () => {
    expect(
      isSameReflectionContent(
        { moodTags: ['CALM', 'SAD'], reflection: '文字' },
        { moodTags: ['SAD', 'CALM'], reflection: '文字' }
      )
    ).toBe(true);
  });

  it('detects mood or text changes', () => {
    expect(
      isSameReflectionContent(
        { moodTags: ['CALM'], reflection: '文字' },
        { moodTags: ['CALM', 'SAD'], reflection: '文字' }
      )
    ).toBe(false);
    expect(
      isSameReflectionContent(
        { moodTags: ['CALM'], reflection: null },
        { moodTags: ['CALM'], reflection: '' }
      )
    ).toBe(false);
  });
});
