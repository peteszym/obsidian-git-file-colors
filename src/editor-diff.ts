export type EditorLineStatus = "new" | "modified";

export interface EditorLineDiff {
  lineStatuses: Map<number, EditorLineStatus>;
  deletedAnchors: number[];
}

interface UnifiedDiffHunk {
  newStart: number;
  lines: string[];
}

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function buildEditorLineDiffFromDiffText(diffText: string, lineCount: number): EditorLineDiff {
  const lineStatuses = new Map<number, EditorLineStatus>();
  const deletedAnchors: number[] = [];

  for (const hunk of parseUnifiedDiffHunks(diffText)) {
    let newLine = hunk.newStart;
    let addedCount = 0;
    let deletedCount = 0;
    const addedLines: number[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        addedLines.push(newLine);
        addedCount += 1;
        newLine += 1;
        continue;
      }

      if (line.startsWith("-")) {
        deletedCount += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        newLine += 1;
      }
    }

    if (addedCount > 0 && deletedCount === 0) {
      for (const lineNumber of addedLines) {
        lineStatuses.set(lineNumber, "new");
      }
      continue;
    }

    if (addedCount > 0 && deletedCount > 0) {
      for (const lineNumber of addedLines) {
        lineStatuses.set(lineNumber, "modified");
      }

      if (deletedCount > addedCount) {
        deletedAnchors.push(clampDeletedAnchor(hunk.newStart + addedCount, lineCount));
      }
      continue;
    }

    if (deletedCount > 0) {
      deletedAnchors.push(clampDeletedAnchor(hunk.newStart, lineCount));
    }
  }

  return {
    lineStatuses,
    deletedAnchors
  };
}

export function createEmptyEditorLineDiff(): EditorLineDiff {
  return {
    lineStatuses: new Map<number, EditorLineStatus>(),
    deletedAnchors: []
  };
}

function parseUnifiedDiffHunks(diffText: string): UnifiedDiffHunk[] {
  const lines = diffText.split(/\r?\n/);
  const hunks: UnifiedDiffHunk[] = [];
  let currentHunk: UnifiedDiffHunk | null = null;

  for (const line of lines) {
    const headerMatch = line.match(HUNK_HEADER_PATTERN);
    if (headerMatch) {
      currentHunk = {
        newStart: Number.parseInt(headerMatch[1], 10),
        lines: []
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }

    if (/^[ +\-]/.test(line)) {
      currentHunk.lines.push(line);
    }
  }

  return hunks;
}

function clampDeletedAnchor(anchorLine: number, lineCount: number): number {
  if (lineCount <= 0) {
    return 1;
  }

  return Math.max(1, Math.min(anchorLine, lineCount + 1));
}
