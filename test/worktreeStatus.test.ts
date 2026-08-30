import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorktreeWipSummary,
  parseWorktreeWipSummary,
} from "../src/worktreeStatus.ts";

test("summarises staged, unstaged, untracked, renamed, and conflicted worktree files", () => {
  const worktreeStatus = parseWorktreeWipSummary([
    "# branch.head feat/payments",
    "1 M. N... 100644 100644 100644 a b staged.ts",
    "1 .M N... 100644 100644 100644 a b unstaged.ts",
    "2 RM N... 100644 100644 100644 a b R100 renamed.ts",
    "old-name.ts",
    "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
    "? new.ts",
    "",
  ].join("\0"));

  assert.deepEqual(worktreeStatus, {
    branchName: "feat/payments",
    conflictCount: 1,
    stagedCount: 2,
    unstagedCount: 2,
    untrackedCount: 1,
  });
  assert.equal(
    formatWorktreeWipSummary(worktreeStatus),
    "1 conflict · 2 staged · 2 unstaged · 1 untracked",
  );
});

test("reports clean detached worktrees without inventing a branch", () => {
  const worktreeStatus = parseWorktreeWipSummary("# branch.head (detached)\0");
  assert.equal(worktreeStatus.branchName, "Detached HEAD");
  assert.equal(formatWorktreeWipSummary(worktreeStatus), "Clean");
});
