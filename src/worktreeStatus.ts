import { runGitCommand, type GitCommandContext } from "./gitCommand.ts";

export interface WorktreeWipSummary {
  readonly branchName: string;
  readonly conflictCount: number;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
}

export async function loadWorktreeWipSummary(
  gitCommandContext: GitCommandContext,
): Promise<WorktreeWipSummary> {
  const porcelainStatus = await runGitCommand(
    gitCommandContext,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    10_000,
  );
  return parseWorktreeWipSummary(porcelainStatus);
}

export function parseWorktreeWipSummary(porcelainStatus: string): WorktreeWipSummary {
  let branchName = "Detached HEAD";
  let conflictCount = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  const records = porcelainStatus.split("\0");
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const statusRecord = records[recordIndex] ?? "";
    if (statusRecord.startsWith("# branch.head ")) {
      const parsedBranchName = statusRecord.slice("# branch.head ".length);
      branchName = parsedBranchName === "(detached)" ? "Detached HEAD" : parsedBranchName;
      continue;
    }
    if (statusRecord.startsWith("? ")) {
      untrackedCount += 1;
      continue;
    }
    if (statusRecord.startsWith("u ")) {
      conflictCount += 1;
      continue;
    }
    if (!statusRecord.startsWith("1 ") && !statusRecord.startsWith("2 ")) {
      continue;
    }
    const statusCode = statusRecord.split(" ", 2)[1] ?? "..";
    if (statusCode[0] !== ".") {
      stagedCount += 1;
    }
    if (statusCode[1] !== ".") {
      unstagedCount += 1;
    }
    if (statusRecord.startsWith("2 ")) {
      recordIndex += 1;
    }
  }
  return { branchName, conflictCount, stagedCount, unstagedCount, untrackedCount };
}

export function formatWorktreeWipSummary(worktreeWipSummary: WorktreeWipSummary): string {
  const changedFileCount =
    worktreeWipSummary.stagedCount +
    worktreeWipSummary.unstagedCount +
    worktreeWipSummary.untrackedCount +
    worktreeWipSummary.conflictCount;
  if (changedFileCount === 0) {
    return "Clean";
  }
  const summaryParts = [
    worktreeWipSummary.conflictCount > 0
      ? `${worktreeWipSummary.conflictCount} conflict${worktreeWipSummary.conflictCount === 1 ? "" : "s"}`
      : undefined,
    worktreeWipSummary.stagedCount > 0
      ? `${worktreeWipSummary.stagedCount} staged`
      : undefined,
    worktreeWipSummary.unstagedCount > 0
      ? `${worktreeWipSummary.unstagedCount} unstaged`
      : undefined,
    worktreeWipSummary.untrackedCount > 0
      ? `${worktreeWipSummary.untrackedCount} untracked`
      : undefined,
  ];
  return summaryParts.filter((summaryPart): summaryPart is string => summaryPart !== undefined).join(" · ");
}
