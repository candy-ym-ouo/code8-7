import type { MoodTag } from '@paper-book-traces/shared';

export type DiffRowType = 'same' | 'added' | 'removed';

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/** 按行对比两版文字，返回顺序可读的差异行；空文本以空行参与对比。 */
export function diffLines(from: string, to: string): DiffRow[] {
  const left = from.length ? from.split(/\r?\n/) : [];
  const right = to.length ? to.split(/\r?\n/) : [];

  const lcs = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const row = lcs[i]!;
    const nextRow = lcs[i + 1]!;
    for (let j = right.length - 1; j >= 0; j -= 1) {
      row[j] = left[i] === right[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const leftLine = left[i];
    const rightLine = right[j];
    if (leftLine !== undefined && rightLine !== undefined && leftLine === rightLine) {
      rows.push({ type: 'same', text: leftLine });
      i += 1;
      j += 1;
    } else if (rightLine !== undefined && (leftLine === undefined || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      rows.push({ type: 'added', text: rightLine });
      j += 1;
    } else {
      rows.push({ type: 'removed', text: leftLine ?? '' });
      i += 1;
    }
  }
  return rows;
}

export interface MoodTagDiff {
  added: MoodTag[];
  removed: MoodTag[];
}

/** 对比两版情绪标签：从 from 到 to 新增了哪些、移除了哪些。 */
export function diffMoodTags(from: MoodTag[], to: MoodTag[]): MoodTagDiff {
  return {
    added: to.filter((tag) => !from.includes(tag)),
    removed: from.filter((tag) => !to.includes(tag))
  };
}
