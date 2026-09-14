import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPorcelainRecord,
  buildFolderStatuses,
  normalizeLogicalPath,
  normalizeRecordStatus,
  parseGitPrefix,
  parsePorcelainRecords,
  toVaultRelativePath
} from "../src/status-model";

test("parsePorcelainRecords handles untracked and rename entries", () => {
  const output = Buffer.from("?? Test/Hello note.md\u0000R  New.md\u0000Old.md\u0000", "utf8");
  const records = parsePorcelainRecords(output);

  assert.deepEqual(records, [
    {
      code: "??",
      path: "Test/Hello note.md"
    },
    {
      code: "R ",
      path: "New.md",
      originalPath: "Old.md"
    }
  ]);
});

test("normalizeRecordStatus maps git porcelain codes to v1 UI statuses", () => {
  assert.equal(normalizeRecordStatus("??"), "new");
  assert.equal(normalizeRecordStatus(" M"), "modified");
  assert.equal(normalizeRecordStatus("D "), "deleted");
  assert.equal(normalizeRecordStatus("!!"), null);
});

test("buildFolderStatuses rolls up descendant state using deleted > modified > new", () => {
  const fileStatuses = new Map([
    ["Projects/One.md", "deleted" as const],
    ["Projects/Subfolder/Untitled.md", "new" as const],
    ["Test/Hello note.md", "new" as const]
  ]);

  const folders = buildFolderStatuses(fileStatuses);

  assert.equal(folders.get("Projects"), "deleted");
  assert.equal(folders.get("Projects/Subfolder"), "new");
  assert.equal(folders.get("Test"), "new");
});

test("parseGitPrefix handles repo-root and nested vault output", () => {
  assert.equal(parseGitPrefix("\n"), "");
  assert.equal(parseGitPrefix(Buffer.from("Documentation/\n", "utf8")), "Documentation");
});

test("git reports the correct vault prefix when the vault is opened through a symlink", {
  skip: process.platform === "win32" ? "Directory symlink creation may require elevated privileges." : false
}, () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ogfc-symlink-test-"));
  const repoRoot = path.join(fixtureRoot, "repo");
  const vaultDirectory = path.join(repoRoot, "Documentation");
  const symlinkParent = path.join(fixtureRoot, "Notes");
  const symlinkedVault = path.join(symlinkParent, "MyVault");

  try {
    mkdirSync(vaultDirectory, { recursive: true });
    mkdirSync(symlinkParent, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    symlinkSync(vaultDirectory, symlinkedVault, "dir");
    writeFileSync(path.join(vaultDirectory, "note.md"), "hello\n", "utf8");

    const resolvedRepoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: symlinkedVault
    }).toString("utf8").trim();
    const prefixOutput = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: symlinkedVault
    });
    const statusOutput = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: resolvedRepoRoot }
    );
    const statuses = new Map<string, "new" | "modified" | "deleted">();
    const vaultPrefix = parseGitPrefix(prefixOutput);

    for (const record of parsePorcelainRecords(statusOutput)) {
      applyPorcelainRecord(statuses, record, vaultPrefix);
    }

    assert.equal(realpathSync(resolvedRepoRoot), realpathSync(repoRoot));
    assert.match(path.relative(resolvedRepoRoot, symlinkedVault), /^\.\.[/\\]/);
    assert.equal(vaultPrefix, "Documentation");
    assert.equal(statuses.get("note.md"), "new");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("toVaultRelativePath maps repo paths into vault-relative paths", () => {
  assert.equal(toVaultRelativePath("vault/Test/Hello note.md", "vault"), "Test/Hello note.md");
  assert.equal(toVaultRelativePath("Test/Hello note.md", ""), "Test/Hello note.md");
  assert.equal(toVaultRelativePath("other/Test.md", "vault"), null);
});

test("applyPorcelainRecord keeps rename source as modified and target as new", () => {
  const statuses = new Map<string, "new" | "modified" | "deleted">();

  applyPorcelainRecord(
    statuses,
    {
      code: "R ",
      path: "Renamed.md",
      originalPath: "Original.md"
    },
    ""
  );

  assert.equal(statuses.get("Renamed.md"), "modified");
  assert.equal(statuses.get("Original.md"), "modified");
});

test("normalizeLogicalPath normalizes slashes without dropping nested folders", () => {
  assert.equal(normalizeLogicalPath("Test\\Hello note.md"), "Test/Hello note.md");
  assert.equal(normalizeLogicalPath("./Projects/Subfolder/"), "Projects/Subfolder");
});
