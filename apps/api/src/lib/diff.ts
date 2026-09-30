import type { MoodTag } from '@paper-book-traces/shared';

export type DiffOp = 'EQUAL' | 'ADDED' | 'REMOVED';

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

export interface MoodTagDiff {
  added: MoodTag[];
  removed: MoodTag[];
  unchanged: MoodTag[];
}

/**
 * 基于最长公共子序列的通用 token 对比。
 * 文本较长时退化为整段对比，避免 LCS 表格在超大输入上占用过多内存。
 */
export function lcsDiff(leftTokens: string[], rightTokens: string[], maxMatrixCells = 200_000): DiffSegment[] {
  if (leftTokens.length * rightTokens.length > maxMatrixCells) {
    return [
      ...(leftTokens.length ? [{ op: 'REMOVED' as const, text: leftTokens.join('') }] : []),
      ...(rightTokens.length ? [{ op: 'ADDED' as const, text: rightTokens.join('') }] : [])
    ];
  }

  const rows = leftTokens.length;
  const cols = rightTokens.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        leftTokens[i] === rightTokens[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += text;
    else segments.push({ op, text });
  };

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (leftTokens[i] === rightTokens[j]) {
      push('EQUAL', leftTokens[i]);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('REMOVED', leftTokens[i]);
      i += 1;
    } else {
      push('ADDED', rightTokens[j]);
      j += 1;
    }
  }
  while (i < rows) {
    push('REMOVED', leftTokens[i]);
    i += 1;
  }
  while (j < cols) {
    push('ADDED', rightTokens[j]);
    j += 1;
  }
  return segments;
}

/**
 * 感受文字对比：多行时按行 LCS；单行（中文通常没有换行）时按字符 LCS，
 * 让两个版本的细微差异也能被逐字标出。
 */
export function diffText(left: string, right: string): DiffSegment[] {
  const leftHasNewline = left.includes('\n');
  const rightHasNewline = right.includes('\n');
  if (leftHasNewline || rightHasNewline) {
    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    return lcsDiff(
      leftLines.map((line, index) => (index < leftLines.length - 1 ? `${line}\n` : line)),
      rightLines.map((line, index) => (index < rightLines.length - 1 ? `${line}\n` : line))
    );
  }
  return lcsDiff(Array.from(left), Array.from(right));
}

export function diffMoodTags(left: MoodTag[], right: MoodTag[]): MoodTagDiff {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return {
    added: right.filter((tag) => !leftSet.has(tag)),
    removed: left.filter((tag) => !rightSet.has(tag)),
    unchanged: left.filter((tag) => rightSet.has(tag))
  };
}

export function isSameReflectionContent(
  left: { moodTags: MoodTag[]; reflection: string | null },
  right: { moodTags: MoodTag[]; reflection: string | null }
): boolean {
  const leftSet = new Set(left.moodTags);
  const rightSet = new Set(right.moodTags);
  return (
    left.reflection === right.reflection &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((tag) => rightSet.has(tag))
  );
}
