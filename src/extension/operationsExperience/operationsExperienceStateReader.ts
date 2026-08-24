import { access } from "node:fs/promises";
import * as nodePath from "node:path";
import type { GitCommandRunner } from "../git/gitCommandRunner.js";
import type {
  OperationsExperienceStateReader,
  OperationsStateBanner,
  OperationsStateKind,
} from "./operationsExperienceModels.js";

/** Reads only Git metadata needed for the Operations Center state banner. */
export class GitOperationsExperienceStateReader implements OperationsExperienceStateReader {
  public constructor(private readonly commandRunner: GitCommandRunner) {}

  public async read(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<OperationsStateBanner> {
    const [statusOutput, gitDirectoryOutput] = await Promise.all([
      this.commandRunner.run({
        repositoryRoot,
        arguments: ["status", "--porcelain=v1", "--branch"],
        cancellationSignal,
      }),
      this.commandRunner.run({
        repositoryRoot,
        arguments: ["rev-parse", "--git-dir"],
        cancellationSignal,
      }),
    ]);
    const statusLines = statusOutput.standardOutput.split(/\r?\n/);
    const branch = statusLines
      .find((statusLine) => statusLine.startsWith("## "))
      ?.slice(3)
      .split("...")[0]
      ?.trim();
    const gitDirectory = resolveGitDirectory(
      repositoryRoot,
      gitDirectoryOutput.standardOutput.trim(),
    );
    const operation = await detectOperation(gitDirectory);
    const changeCount = statusLines.filter(
      (statusLine) => statusLine.length > 0 && !statusLine.startsWith("## "),
    ).length;
    const operationText =
      operation === undefined
        ? "No active Git operation"
        : `${capitalizeOperation(operation)} in progress`;
    const changeText =
      changeCount === 0
        ? "clean worktree"
        : `${changeCount} worktree change${changeCount === 1 ? "" : "s"}`;
    return {
      repositoryRoot,
      ...(operation === undefined ? {} : { operation }),
      ...(branch === undefined ? {} : { branch }),
      summary: `${operationText} · ${branch ?? "detached HEAD"} · ${changeText}`,
    };
  }
}

function resolveGitDirectory(
  repositoryRoot: string,
  gitDirectory: string,
): string {
  return nodePath.isAbsolute(gitDirectory)
    ? gitDirectory
    : nodePath.resolve(repositoryRoot, gitDirectory);
}

async function detectOperation(
  gitDirectory: string,
): Promise<OperationsStateKind | undefined> {
  const operationMarkers: readonly [OperationsStateKind, readonly string[]][] =
    [
      ["rebase", ["rebase-merge", "rebase-apply"]],
      ["bisect", ["BISECT_LOG"]],
      ["cherry-pick", ["CHERRY_PICK_HEAD"]],
      ["revert", ["REVERT_HEAD"]],
      ["merge", ["MERGE_HEAD"]],
    ];
  for (const [operation, markerNames] of operationMarkers) {
    for (const markerName of markerNames) {
      if (await pathExists(nodePath.join(gitDirectory, markerName)))
        return operation;
    }
  }
  return undefined;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function capitalizeOperation(operation: OperationsStateKind): string {
  return operation === "cherry-pick"
    ? "Cherry-pick"
    : operation.charAt(0).toUpperCase() + operation.slice(1);
}
