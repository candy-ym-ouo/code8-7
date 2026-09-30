import { describe, expect, it } from 'vitest';
import { diffLines, diffMoodTags } from './revisions';

describe('diffLines', () => {
  it('marks identical text as same', () => {
    expect(diffLines('第一行\n第二行', '第一行\n第二行')).toEqual([
      { type: 'same', text: '第一行' },
      { type: 'same', text: '第二行' }
    ]);
  });

  it('detects an added line', () => {
    const rows = diffLines('保留', '保留\n新增');
    expect(rows).toEqual([
      { type: 'same', text: '保留' },
      { type: 'added', text: '新增' }
    ]);
  });

  it('detects a removed line and keeps order', () => {
    const rows = diffLines('旧文字\n保留', '保留');
    expect(rows).toEqual([
      { type: 'removed', text: '旧文字' },
      { type: 'same', text: '保留' }
    ]);
  });

  it('treats empty revisions as a single blank comparison', () => {
    expect(diffLines('', '新感受')).toEqual([{ type: 'added', text: '新感受' }]);
    expect(diffLines('旧感受', '')).toEqual([{ type: 'removed', text: '旧感受' }]);
  });
});

describe('diffMoodTags', () => {
  it('splits added and removed tags', () => {
    expect(diffMoodTags(['MOVED', 'CALM'], ['CALM', 'JOYFUL'])).toEqual({
      added: ['JOYFUL'],
      removed: ['MOVED']
    });
  });
});
