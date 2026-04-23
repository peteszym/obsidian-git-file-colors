export type EditorLineStatus = "new" | "modified";

export interface EditorLineDiff {
  lineStatuses: Map<number, EditorLineStatus>;
  deletedAnchors: number[];
}

interface AnchorPair {
  baseIndex: number;
  currentIndex: number;
}

interface MutableEditorLineDiff {
  lineStatuses: Map<number, EditorLineStatus>;
  deletedAnchors: number[];
}

export function buildEditorLineDiff(baseText: string, currentText: string): EditorLineDiff {
  const baseLines = splitTextIntoLines(baseText);
  const currentLines = splitTextIntoLines(currentText);
  const diff: MutableEditorLineDiff = {
    lineStatuses: new Map<number, EditorLineStatus>(),
    deletedAnchors: []
  };

  collectDiff(baseLines, 0, baseLines.length, currentLines, 0, currentLines.length, currentLines.length, diff);

  return diff;
}

export function markEntireFile(lineCount: number, status: EditorLineStatus): EditorLineDiff {
  const lineStatuses = new Map<number, EditorLineStatus>();

  for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
    lineStatuses.set(lineNumber, status);
  }

  return {
    lineStatuses,
    deletedAnchors: []
  };
}

function collectDiff(
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
  currentLines: string[],
  currentStart: number,
  currentEnd: number,
  totalCurrentLines: number,
  diff: MutableEditorLineDiff
): void {
  while (baseStart < baseEnd && currentStart < currentEnd && baseLines[baseStart] === currentLines[currentStart]) {
    baseStart += 1;
    currentStart += 1;
  }

  while (
    baseStart < baseEnd &&
    currentStart < currentEnd &&
    baseLines[baseEnd - 1] === currentLines[currentEnd - 1]
  ) {
    baseEnd -= 1;
    currentEnd -= 1;
  }

  if (baseStart === baseEnd && currentStart === currentEnd) {
    return;
  }

  if (baseStart === baseEnd) {
    for (let currentIndex = currentStart; currentIndex < currentEnd; currentIndex += 1) {
      diff.lineStatuses.set(currentIndex + 1, "new");
    }
    return;
  }

  if (currentStart === currentEnd) {
    diff.deletedAnchors.push(clampDeletedAnchor(currentStart + 1, totalCurrentLines));
    return;
  }

  const anchors = findAnchors(baseLines, baseStart, baseEnd, currentLines, currentStart, currentEnd);
  if (anchors.length === 0) {
    markReplacementBlock(baseStart, baseEnd, currentStart, currentEnd, totalCurrentLines, diff);
    return;
  }

  let previousBase = baseStart;
  let previousCurrent = currentStart;

  for (const anchor of anchors) {
    collectDiff(
      baseLines,
      previousBase,
      anchor.baseIndex,
      currentLines,
      previousCurrent,
      anchor.currentIndex,
      totalCurrentLines,
      diff
    );

    previousBase = anchor.baseIndex + 1;
    previousCurrent = anchor.currentIndex + 1;
  }

  collectDiff(
    baseLines,
    previousBase,
    baseEnd,
    currentLines,
    previousCurrent,
    currentEnd,
    totalCurrentLines,
    diff
  );
}

function markReplacementBlock(
  baseStart: number,
  baseEnd: number,
  currentStart: number,
  currentEnd: number,
  totalCurrentLines: number,
  diff: MutableEditorLineDiff
): void {
  const baseLength = baseEnd - baseStart;
  const currentLength = currentEnd - currentStart;
  const overlap = Math.min(baseLength, currentLength);

  for (let offset = 0; offset < overlap; offset += 1) {
    diff.lineStatuses.set(currentStart + offset + 1, "modified");
  }

  for (let currentIndex = currentStart + overlap; currentIndex < currentEnd; currentIndex += 1) {
    diff.lineStatuses.set(currentIndex + 1, "new");
  }

  if (baseLength > currentLength) {
    diff.deletedAnchors.push(clampDeletedAnchor(currentStart + overlap + 1, totalCurrentLines));
  }
}

function findAnchors(
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
  currentLines: string[],
  currentStart: number,
  currentEnd: number
): AnchorPair[] {
  const baseCounts = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  const basePositions = new Map<string, number>();
  const currentPositions = new Map<string, number>();

  for (let index = baseStart; index < baseEnd; index += 1) {
    const line = baseLines[index];
    baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
    basePositions.set(line, index);
  }

  for (let index = currentStart; index < currentEnd; index += 1) {
    const line = currentLines[index];
    currentCounts.set(line, (currentCounts.get(line) ?? 0) + 1);
    currentPositions.set(line, index);
  }

  const candidates: AnchorPair[] = [];

  for (const [line, count] of baseCounts.entries()) {
    if (count !== 1 || currentCounts.get(line) !== 1) {
      continue;
    }

    candidates.push({
      baseIndex: basePositions.get(line) ?? baseStart,
      currentIndex: currentPositions.get(line) ?? currentStart
    });
  }

  candidates.sort((left, right) => left.baseIndex - right.baseIndex);
  return longestIncreasingSubsequence(candidates);
}

function longestIncreasingSubsequence(pairs: AnchorPair[]): AnchorPair[] {
  if (pairs.length <= 1) {
    return pairs.slice();
  }

  const tails: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);

  for (let index = 0; index < pairs.length; index += 1) {
    const currentIndex = pairs[index].currentIndex;
    let low = 0;
    let high = tails.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (pairs[tails[mid]].currentIndex < currentIndex) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    if (low > 0) {
      previous[index] = tails[low - 1];
    }

    if (low === tails.length) {
      tails.push(index);
    } else {
      tails[low] = index;
    }
  }

  const result: AnchorPair[] = [];
  let cursor = tails[tails.length - 1];

  while (cursor >= 0) {
    result.push(pairs[cursor]);
    cursor = previous[cursor];
  }

  return result.reverse();
}

function splitTextIntoLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function clampDeletedAnchor(anchorLine: number, lineCount: number): number {
  if (lineCount <= 0) {
    return 1;
  }

  return Math.max(1, Math.min(anchorLine, lineCount + 1));
}
