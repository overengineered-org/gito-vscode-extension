import { type GitRepository, loadGitCommitsWithTimeout } from "./gitApi.ts";
import type { GitReference } from "./gitModel.ts";
import { buildCommitGraphRows, type CommitGraphRow } from "./graphModel.ts";

export interface CommitGraphPage {
  readonly hasMore: boolean;
  readonly rows: readonly CommitGraphRow[];
}

export async function loadCommitGraphPage(
  repository: GitRepository,
  graphReferences: readonly GitReference[],
  entryLimit: number,
  filePath?: string,
): Promise<CommitGraphPage> {
  const gitCommits = await loadGitCommitsWithTimeout(repository, {
    maxEntries: entryLimit + 1,
    ...(filePath === undefined ? {} : { path: filePath }),
  });
  return {
    hasMore: gitCommits.length > entryLimit,
    rows: buildCommitGraphRows(gitCommits.slice(0, entryLimit), graphReferences),
  };
}
