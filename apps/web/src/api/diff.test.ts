import { describe, expect, it } from 'vitest';
import { diffMoodTags, diffText } from './diff';

describe('diffText', () => {
  it('diffs Chinese text character by character', () => {
    expect(diffText('平静而释然', '平静而喜悦')).toEqual([
      { op: 'EQUAL', text: '平静而' },
      { op: 'REMOVED', text: '释然' },
      { op: 'ADDED', text: '喜悦' }
    ]);
  });

  it('diffs multiline text by line', () => {
    const segments = diffText('第一行\n旧句子', '第一行\n新句子');
    expect(segments).toContainEqual({ op: 'REMOVED', text: '旧句子' });
    expect(segments).toContainEqual({ op: 'ADDED', text: '新句子' });
  });
});

describe('diffMoodTags', () => {
  it('groups tags by change type', () => {
    expect(diffMoodTags(['CALM', 'SAD'], ['CALM', 'JOYFUL'])).toEqual({
      added: ['JOYFUL'],
      removed: ['SAD'],
      unchanged: ['CALM']
    });
  });
});
