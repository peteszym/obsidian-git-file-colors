import path from "path";

export type GitUiStatus = "new" | "modified" | "deleted";

export interface PorcelainRecord {
  code: string;
  path: string;
  originalPath?: string;
}

const STATUS_PRIORITY: Record<GitUiStatus, number> = {
  new: 1,
  modified: 2,
  deleted: 3
};

export function parsePorcelainRecords(output: Buffer | string): PorcelainRecord[] {
  const text = typeof output === "string" ? output : output.toString("utf8");
  const chunks = text.split("\u0000").filter(Boolean);
  const records: PorcelainRecord[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const entry = chunks[index];
    if (entry.length < 4) {
      continue;
    }

    const code = entry.slice(0, 2);
    const record: PorcelainRecord = {
      code,
      path: normalizeLogicalPath(entry.slice(3))
    };

    if (code.includes("R") || code.includes("C")) {
      record.originalPath = normalizeLogicalPath(chunks[index + 1] ?? "");
      index += 1;
    }

    records.push(record);
  }

  return records;
}

export function normalizeRecordStatus(code: string): GitUiStatus | null {
  if (code === "!!") {
    return null;
  }

  if (code === "??") {
    return "new";
  }

  const indexStatus = code[0] ?? " ";
  const workingTreeStatus = code[1] ?? " ";

  if (indexStatus === "D" || workingTreeStatus === "D") {
    return "deleted";
  }

  if (indexStatus === "A" || workingTreeStatus === "A" || indexStatus === "C") {
    return "new";
  }

  if (indexStatus === " " && workingTreeStatus === " ") {
    return null;
  }

  return "modified";
}

export function applyPorcelainRecord(
  statuses: Map<string, GitUiStatus>,
  record: PorcelainRecord,
  vaultPrefix: string
): void {
  const normalizedStatus = normalizeRecordStatus(record.code);
  if (!normalizedStatus) {
    return;
  }

  const currentPath = toVaultRelativePath(record.path, vaultPrefix);
  if (currentPath) {
    mergeStatus(statuses, currentPath, normalizedStatus);
  }

  if (record.originalPath && record.code.includes("R")) {
    const originalPath = toVaultRelativePath(record.originalPath, vaultPrefix);
    if (originalPath) {
      mergeStatus(statuses, originalPath, "modified");
    }
  }
}

export function buildFolderStatuses(fileStatuses: Map<string, GitUiStatus>): Map<string, GitUiStatus> {
  const folderStatuses = new Map<string, GitUiStatus>();

  for (const [filePath, status] of fileStatuses.entries()) {
    let parentPath = path.posix.dirname(filePath);

    while (parentPath && parentPath !== ".") {
      mergeStatus(folderStatuses, parentPath, status);
      const nextParent = path.posix.dirname(parentPath);
      if (nextParent === parentPath) {
        break;
      }

      parentPath = nextParent;
    }
  }

  return folderStatuses;
}

export function getVaultPrefix(repoRoot: string, vaultBasePath: string): string | null {
  const rawRelativePath = path.relative(repoRoot, vaultBasePath);

  if (!rawRelativePath) {
    return "";
  }

  const relativePath = normalizeRelativePath(rawRelativePath);

  if (!relativePath || relativePath === ".") {
    return "";
  }

  if (relativePath.startsWith("../")) {
    return null;
  }

  return relativePath;
}

export function toVaultRelativePath(repoRelativePath: string, vaultPrefix: string): string | null {
  const normalizedPath = normalizeLogicalPath(repoRelativePath);

  if (!normalizedPath) {
    return null;
  }

  if (!vaultPrefix || vaultPrefix === "/") {
    return normalizedPath;
  }

  if (normalizedPath === vaultPrefix) {
    return null;
  }

  if (!normalizedPath.startsWith(`${vaultPrefix}/`)) {
    return null;
  }

  return normalizedPath.slice(vaultPrefix.length + 1);
}

export function normalizeLogicalPath(value: string): string {
  return normalizeRelativePath(value).replace(/^\/+/, "");
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");

  if (!normalized || normalized === ".") {
    return "";
  }

  return normalized.replace(/^\.\//, "").replace(/\/+$/, "");
}

function mergeStatus(statuses: Map<string, GitUiStatus>, filePath: string, nextStatus: GitUiStatus): void {
  const existingStatus = statuses.get(filePath);
  if (!existingStatus || STATUS_PRIORITY[nextStatus] > STATUS_PRIORITY[existingStatus]) {
    statuses.set(filePath, nextStatus);
  }
}
