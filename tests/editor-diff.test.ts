import assert from "node:assert/strict";
import test from "node:test";

import { buildEditorLineDiffFromDiffText, createEmptyEditorLineDiff } from "../src/editor-diff";

test("pure addition hunks mark added lines as new", () => {
  const diff = buildEditorLineDiffFromDiffText(
    ["diff --git a/Test.md b/Test.md", "@@ -4,0 +4,2 @@", "+first", "+second"].join("\n"),
    10
  );

  assert.deepEqual([...diff.lineStatuses.entries()], [
    [4, "new"],
    [5, "new"]
  ]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("mixed hunks mark added lines as modified", () => {
  const diff = buildEditorLineDiffFromDiffText(
    ["diff --git a/Test.md b/Test.md", "@@ -8,1 +8,1 @@", "-old", "+updated"].join("\n"),
    12
  );

  assert.deepEqual([...diff.lineStatuses.entries()], [[8, "modified"]]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("mixed hunks with net additions still mark all added lines as modified", () => {
  const diff = buildEditorLineDiffFromDiffText(
    ["diff --git a/Test.md b/Test.md", "@@ -2,1 +2,2 @@", "-old", "+updated", "+extra"].join("\n"),
    6
  );

  assert.deepEqual([...diff.lineStatuses.entries()], [
    [2, "modified"],
    [3, "modified"]
  ]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("pure deletion hunks emit deleted anchors", () => {
  const diff = buildEditorLineDiffFromDiffText(
    ["diff --git a/Test.md b/Test.md", "@@ -6,2 +6,0 @@", "-removed one", "-removed two"].join("\n"),
    10
  );

  assert.deepEqual([...diff.lineStatuses.entries()], []);
  assert.deepEqual(diff.deletedAnchors, [6]);
});

test("mixed hunks with net deletions emit a trailing deleted anchor", () => {
  const diff = buildEditorLineDiffFromDiffText(
    [
      "diff --git a/Test.md b/Test.md",
      "@@ -2,3 +2,1 @@",
      "-removed one",
      "-removed two",
      "-removed three",
      "+replacement"
    ].join("\n"),
    4
  );

  assert.deepEqual([...diff.lineStatuses.entries()], [[2, "modified"]]);
  assert.deepEqual(diff.deletedAnchors, [3]);
});

test("git-style mixed hunk colors all added lines in Smoke Test as modified", () => {
  const diff = buildEditorLineDiffFromDiffText(
    [
      "diff --git a/Smoke Test.md b/Smoke Test.md",
      "@@ -2 +1,0 @@",
      "-",
      "@@ -9 +8,3 @@ Use this vault to verify:",
      "-- manual refresh recovers from external Git changes",
      "+- manual refresh recovers from external Git changes",
      "+",
      "+sd"
    ].join("\n"),
    10
  );

  assert.deepEqual([...diff.lineStatuses.entries()], [
    [8, "modified"],
    [9, "modified"],
    [10, "modified"]
  ]);
  assert.deepEqual(diff.deletedAnchors, [1]);
});

test("createEmptyEditorLineDiff returns a blank diff state", () => {
  const diff = createEmptyEditorLineDiff();

  assert.deepEqual([...diff.lineStatuses.entries()], []);
  assert.deepEqual(diff.deletedAnchors, []);
});
