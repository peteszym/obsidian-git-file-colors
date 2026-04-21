import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPorcelainRecord,
  buildFolderStatuses,
  getVaultPrefix,
  normalizeLogicalPath,
  normalizeRecordStatus,
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

test("getVaultPrefix returns empty string when the vault is the repo root", () => {
  assert.equal(
    getVaultPrefix("/Users/peter/Code/obsidian-git-file-colors/tmp/scratch-vault", "/Users/peter/Code/obsidian-git-file-colors/tmp/scratch-vault"),
    ""
  );
});

test("getVaultPrefix handles nested vaults and rejects paths outside the repo", () => {
  assert.equal(
    getVaultPrefix("/repo", "/repo/vault"),
    "vault"
  );
  assert.equal(
    getVaultPrefix("/repo", "/elsewhere/vault"),
    null
  );
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
