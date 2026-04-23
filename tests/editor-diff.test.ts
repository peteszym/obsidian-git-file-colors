import assert from "node:assert/strict";
import test from "node:test";

import { buildEditorLineDiff, markEntireFile } from "../src/editor-diff";

test("buildEditorLineDiff marks inserted lines as new", () => {
  const diff = buildEditorLineDiff("one\ntwo\nthree", "one\ntwo\ninserted\nthree");

  assert.deepEqual([...diff.lineStatuses.entries()], [[3, "new"]]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("buildEditorLineDiff marks replaced lines as modified", () => {
  const diff = buildEditorLineDiff("one\ntwo\nthree", "one\nupdated\nthree");

  assert.deepEqual([...diff.lineStatuses.entries()], [[2, "modified"]]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("buildEditorLineDiff marks replacement blocks with extra inserted lines as modified then new", () => {
  const diff = buildEditorLineDiff("one\ntwo\nthree", "one\nupdated\nextra\nthree");

  assert.deepEqual([...diff.lineStatuses.entries()], [
    [2, "modified"],
    [3, "new"]
  ]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("buildEditorLineDiff emits deleted anchors for pure deletions", () => {
  const diff = buildEditorLineDiff("one\ntwo\nthree", "one\nthree");

  assert.deepEqual([...diff.lineStatuses.entries()], []);
  assert.deepEqual(diff.deletedAnchors, [2]);
});

test("buildEditorLineDiff emits deleted anchors when a block deletes more lines than it inserts", () => {
  const diff = buildEditorLineDiff("one\ntwo\nthree\nfour", "one\nupdated\nfour");

  assert.deepEqual([...diff.lineStatuses.entries()], [[2, "modified"]]);
  assert.deepEqual(diff.deletedAnchors, [3]);
});

test("buildEditorLineDiff ignores identical text", () => {
  const diff = buildEditorLineDiff("one\ntwo", "one\ntwo");

  assert.deepEqual([...diff.lineStatuses.entries()], []);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("markEntireFile marks every line with the provided status", () => {
  const diff = markEntireFile(3, "new");
  assert.deepEqual([...diff.lineStatuses.entries()], [
    [1, "new"],
    [2, "new"],
    [3, "new"]
  ]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("buildEditorLineDiff keeps modifications local when repeated lines exist", () => {
  const diff = buildEditorLineDiff("- a\n- a\n- a\n", "- a\n- b\n- a\n");

  assert.deepEqual([...diff.lineStatuses.entries()], [[2, "modified"]]);
  assert.deepEqual(diff.deletedAnchors, []);
});

test("buildEditorLineDiff keeps duplicate-line markdown edits on the changed line", () => {
  const diff = buildEditorLineDiff("# Home\n\n- item\n- item\n- item\n", "# Home\n\n- item\n- changed\n- item\n");

  assert.deepEqual([...diff.lineStatuses.entries()], [[4, "modified"]]);
  assert.deepEqual(diff.deletedAnchors, []);
});
