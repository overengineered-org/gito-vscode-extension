import type { LocalGitWorktree } from "./localGitModels.js";

export interface GitWorktreeCreationOptions {
  readonly branchName?: string;
  readonly createBranch?: boolean;
  readonly startPoint?: string;
}

export function buildWorktreeAddArguments(
  worktreePath: string,
  options: GitWorktreeCreationOptions = {},
): readonly string[] {
  if (
    options.createBranch !== true &&
    options.branchName !== undefined &&
    options.startPoint !== undefined
  ) {
    throw new Error(
      "An existing branch cannot be combined with a separate worktree start point.",
    );
  }
  const commandArguments = ["worktree", "add"];
  if (options.createBranch === true) {
    if (options.branchName === undefined) {
      throw new Error(
        "A branch name is required when creating a worktree branch.",
      );
    }
    commandArguments.push("-b", options.branchName, worktreePath);
    if (options.startPoint !== undefined)
      commandArguments.push(options.startPoint);
    return commandArguments;
  }
  commandArguments.push(
    worktreePath,
    options.branchName ?? options.startPoint ?? "HEAD",
  );
  return commandArguments;
}

export function parseWorktreeList(
  porcelainOutput: string,
): readonly LocalGitWorktree[] {
  const worktreeRecords: LocalGitWorktree[] = [];
  let currentRecord: MutableWorktreeRecord = {};
  const finishRecord = (): void => {
    if (
      currentRecord.path === undefined ||
      currentRecord.headSha === undefined
    ) {
      currentRecord = {};
      return;
    }
    worktreeRecords.push({
      path: currentRecord.path,
      headSha: currentRecord.headSha,
      ...(currentRecord.branchName === undefined
        ? {}
        : { branchName: currentRecord.branchName }),
      isLocked: currentRecord.isLocked ?? false,
      ...(currentRecord.lockReason === undefined
        ? {}
        : { lockReason: currentRecord.lockReason }),
      isPrunable: currentRecord.isPrunable ?? false,
      ...(currentRecord.pruneReason === undefined
        ? {}
        : { pruneReason: currentRecord.pruneReason }),
    });
    currentRecord = {};
  };

  for (const line of porcelainOutput.split(/\r?\n/)) {
    if (line.length === 0) {
      finishRecord();
      continue;
    }
    const separatorIndex = line.indexOf(" ");
    const recordKey =
      separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const recordValue =
      separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (recordKey === "worktree") {
      finishRecord();
      currentRecord.path = recordValue;
      continue;
    }
    if (recordKey === "HEAD") {
      currentRecord.headSha = recordValue;
      continue;
    }
    if (recordKey === "branch") {
      currentRecord.branchName = recordValue.replace(/^refs\/heads\//, "");
      continue;
    }
    if (recordKey === "detached") {
      delete currentRecord.branchName;
      continue;
    }
    if (recordKey === "locked") {
      currentRecord.isLocked = true;
      if (recordValue.length > 0) currentRecord.lockReason = recordValue;
      continue;
    }
    if (recordKey === "prunable") {
      currentRecord.isPrunable = true;
      if (recordValue.length > 0) currentRecord.pruneReason = recordValue;
    }
  }
  finishRecord();
  return worktreeRecords;
}

interface MutableWorktreeRecord {
  path?: string;
  headSha?: string;
  branchName?: string;
  isLocked?: boolean;
  lockReason?: string;
  isPrunable?: boolean;
  pruneReason?: string;
}
