export type GitLineStatus = "new" | "modified";

export interface GitChangedLine {
  line: number;
  status: GitLineStatus;
}

export interface GitLineChanges {
  changedLines: GitChangedLine[];
  deletedAfterLines: number[];
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseGitLineChanges(diff: Buffer | string): GitLineChanges {
  const text = typeof diff === "string" ? diff : diff.toString("utf8");
  const changedLineStatuses = new Map<number, GitLineStatus>();
  const deletedAfterLines = new Set<number>();

  for (const line of text.split(/\r?\n/)) {
    const match = HUNK_HEADER_PATTERN.exec(line);
    if (!match) {
      continue;
    }

    const oldCount = parseHunkCount(match[2]);
    const newStart = Number.parseInt(match[3], 10);
    const newCount = parseHunkCount(match[4]);

    if (oldCount === 0) {
      addChangedLines(changedLineStatuses, newStart, newCount, "new");
      continue;
    }

    if (newCount === 0) {
      deletedAfterLines.add(newStart);
      continue;
    }

    const replacementCount = Math.min(oldCount, newCount);
    addChangedLines(changedLineStatuses, newStart, replacementCount, "modified");

    if (newCount > oldCount) {
      addChangedLines(
        changedLineStatuses,
        newStart + replacementCount,
        newCount - replacementCount,
        "new"
      );
    } else if (oldCount > newCount) {
      deletedAfterLines.add(newStart + newCount - 1);
    }
  }

  return {
    changedLines: [...changedLineStatuses.entries()]
      .sort(([left], [right]) => left - right)
      .map(([line, status]) => ({ line, status })),
    deletedAfterLines: [...deletedAfterLines].sort((left, right) => left - right)
  };
}

export function createAllNewLineChanges(lineCount: number): GitLineChanges {
  const safeLineCount = Math.max(0, Math.floor(lineCount));
  return {
    changedLines: Array.from({ length: safeLineCount }, (_, index) => ({
      line: index + 1,
      status: "new" as const
    })),
    deletedAfterLines: []
  };
}

function parseHunkCount(rawCount: string | undefined): number {
  return rawCount === undefined ? 1 : Number.parseInt(rawCount, 10);
}

function addChangedLines(
  statuses: Map<number, GitLineStatus>,
  start: number,
  count: number,
  status: GitLineStatus
): void {
  for (let offset = 0; offset < count; offset += 1) {
    const line = start + offset;
    const existing = statuses.get(line);
    if (!existing || status === "modified") {
      statuses.set(line, status);
    }
  }
}
