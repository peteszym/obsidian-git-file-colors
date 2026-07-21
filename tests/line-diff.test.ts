import assert from "node:assert/strict";
import test from "node:test";

import { createAllNewLineChanges, parseGitLineChanges } from "../src/line-diff";

test("parseGitLineChanges maps pure additions to new lines", () => {
  const changes = parseGitLineChanges(`diff --git a/Test.md b/Test.md
@@ -2,0 +3,2 @@
+first
+second
`);

  assert.deepEqual(changes, {
    changedLines: [
      { line: 3, status: "new" },
      { line: 4, status: "new" }
    ],
    deletedAfterLines: []
  });
});

test("parseGitLineChanges maps equal-size replacements to modified lines", () => {
  const changes = parseGitLineChanges(`@@ -10,2 +10,2 @@
-old one
-old two
+new one
+new two
`);

  assert.deepEqual(changes, {
    changedLines: [
      { line: 10, status: "modified" },
      { line: 11, status: "modified" }
    ],
    deletedAfterLines: []
  });
});

test("parseGitLineChanges keeps replacement overlap yellow and surplus additions green", () => {
  const changes = parseGitLineChanges("@@ -5 +5,3 @@ heading\n-old\n+changed\n+added\n+added again\n");

  assert.deepEqual(changes, {
    changedLines: [
      { line: 5, status: "modified" },
      { line: 6, status: "new" },
      { line: 7, status: "new" }
    ],
    deletedAfterLines: []
  });
});

test("parseGitLineChanges anchors pure and surplus deletions at the current line boundary", () => {
  const changes = parseGitLineChanges(`@@ -1 +0,0 @@
-first line
@@ -8,3 +7 @@
-old one
-old two
-old three
+replacement
`);

  assert.deepEqual(changes, {
    changedLines: [{ line: 7, status: "modified" }],
    deletedAfterLines: [0, 7]
  });
});

test("parseGitLineChanges accepts omitted hunk counts and multiple hunks", () => {
  const changes = parseGitLineChanges("@@ -2 +2 @@\n-old\n+new\n@@ -9,0 +10 @@\n+added\n");

  assert.deepEqual(changes, {
    changedLines: [
      { line: 2, status: "modified" },
      { line: 10, status: "new" }
    ],
    deletedAfterLines: []
  });
});

test("createAllNewLineChanges marks an untracked document green", () => {
  assert.deepEqual(createAllNewLineChanges(3), {
    changedLines: [
      { line: 1, status: "new" },
      { line: 2, status: "new" },
      { line: 3, status: "new" }
    ],
    deletedAfterLines: []
  });
});
