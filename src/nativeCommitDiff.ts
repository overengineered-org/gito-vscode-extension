import * as vscode from "vscode";

import type { GitRepository } from "./gitApi.ts";
import { gitViewCommitRequiresHistoryItem } from "./vscodeCompatibility.ts";

export async function openNativeCommitDiff(
  repository: GitRepository,
  commitHash: string,
): Promise<void> {
  const commitCommandArgument = gitViewCommitRequiresHistoryItem(vscode.version)
    ? await createCommitHistoryItem(repository, commitHash)
    : commitHash;
  await vscode.commands.executeCommand(
    "git.viewCommit",
    repository.rootUri,
    commitCommandArgument,
  );
}

async function createCommitHistoryItem(repository: GitRepository, commitHash: string) {
  const commit = await repository.getCommit(commitHash);
  return {
    id: commitHash,
    parentIds: commit.parents,
  };
}
