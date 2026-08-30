import assert from "node:assert/strict";
import test from "node:test";

import { parseWorktreeList } from "../src/worktreeDiscovery.ts";

test("discovers primary, linked, and detached worktrees from NUL-safe porcelain", () => {
  assert.deepEqual(
    parseWorktreeList([
      "worktree /repos/project",
      `HEAD ${"a".repeat(40)}`,
      "branch refs/heads/main",
      "",
      "worktree /worktrees/feature with spaces",
      `HEAD ${"b".repeat(40)}`,
      "branch refs/heads/feat/payments",
      "",
      "worktree /worktrees/review",
      `HEAD ${"c".repeat(40)}`,
      "detached",
      "",
    ].join("\0")),
    [
      {
        detached: false,
        main: true,
        name: "main",
        path: "/repos/project",
        ref: "refs/heads/main",
      },
      {
        detached: false,
        main: false,
        name: "feat/payments",
        path: "/worktrees/feature with spaces",
        ref: "refs/heads/feat/payments",
      },
      {
        detached: true,
        main: false,
        name: "review",
        path: "/worktrees/review",
        ref: "",
      },
    ],
  );
});
