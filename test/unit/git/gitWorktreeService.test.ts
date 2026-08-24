import { describe, expect, it } from "vitest";
import {
  buildWorktreeAddArguments,
  parseWorktreeList,
} from "../../../src/extension/git/gitWorktreeParser.js";

describe("Git worktree porcelain parsing", () => {
  it("parses branches, detached heads, locks, and prune markers", () => {
    expect(
      parseWorktreeList(
        [
          "worktree /Users/example/project",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /Users/example/feature copy",
          "HEAD def456",
          "detached",
          "locked active review",
          "",
          "worktree /Users/example/stale",
          "HEAD 987654",
          "branch refs/heads/stale",
          "prunable missing directory",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "/Users/example/project",
        headSha: "abc123",
        branchName: "main",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/Users/example/feature copy",
        headSha: "def456",
        isLocked: true,
        lockReason: "active review",
        isPrunable: false,
      },
      {
        path: "/Users/example/stale",
        headSha: "987654",
        branchName: "stale",
        isLocked: false,
        isPrunable: true,
        pruneReason: "missing directory",
      },
    ]);
  });

  it("does not manufacture incomplete records", () => {
    expect(
      parseWorktreeList(
        "worktree /Users/example/incomplete\nbranch refs/heads/main\n",
      ),
    ).toEqual([]);
  });

  it("builds one exact command shape for existing and new branches", () => {
    expect(
      buildWorktreeAddArguments("/tmp/existing", {
        branchName: "feature/existing",
      }),
    ).toEqual(["worktree", "add", "/tmp/existing", "feature/existing"]);
    expect(
      buildWorktreeAddArguments("/tmp/new", {
        branchName: "feature/new",
        createBranch: true,
        startPoint: "main",
      }),
    ).toEqual(["worktree", "add", "-b", "feature/new", "/tmp/new", "main"]);
    expect(() =>
      buildWorktreeAddArguments("/tmp/invalid", {
        branchName: "feature/existing",
        startPoint: "main",
      }),
    ).toThrow("cannot be combined");
  });
});
