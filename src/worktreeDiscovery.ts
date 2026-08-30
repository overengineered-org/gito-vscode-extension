import { basename } from "node:path";

import type { GitWorktree } from "./gitApi.ts";
import { runGitCommand, type GitCommandContext } from "./gitCommand.ts";
import { canonicalizePath } from "./pathIdentity.ts";

export async function listRepositoryWorktrees(
  gitCommandContext: GitCommandContext,
): Promise<readonly GitWorktree[]> {
  const worktreeListOutput = await runGitCommand(
    gitCommandContext,
    ["worktree", "list", "--porcelain", "-z"],
    10_000,
  );
  return parseWorktreeList(worktreeListOutput);
}

export function parseWorktreeList(worktreeListOutput: string): readonly GitWorktree[] {
  return worktreeListOutput
    .split("\0\0")
    .flatMap((worktreeRecord, worktreeIndex): GitWorktree[] => {
      const worktreeFields = worktreeRecord.split("\0");
      const reportedWorktreePath = readWorktreeField(worktreeFields, "worktree");
      if (reportedWorktreePath === undefined) return [];
      const worktreePath = canonicalizePath(reportedWorktreePath);
      const branchReference = readWorktreeField(worktreeFields, "branch") ?? "";
      const detached = worktreeFields.includes("detached");
      return [{
        detached,
        main: worktreeIndex === 0,
        name: branchReference.replace(/^refs\/heads\//u, "") || basename(worktreePath),
        path: worktreePath,
        ref: branchReference,
      }];
    });
}

function readWorktreeField(
  worktreeFields: readonly string[],
  fieldName: string,
): string | undefined {
  const fieldPrefix = `${fieldName} `;
  return worktreeFields
    .find((worktreeField) => worktreeField.startsWith(fieldPrefix))
    ?.slice(fieldPrefix.length);
}
