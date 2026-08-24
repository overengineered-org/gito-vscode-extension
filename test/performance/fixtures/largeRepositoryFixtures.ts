import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import type {
  VscodeGitRepository,
  VscodeGitResourceState,
  VscodeGitRepositoryState,
} from "../../../src/extension/git/vscodeGitApi.js";

const executeFile = promisify(execFile);

export const largeRepositoryFileCount = 10_000;
export const largeRepositoryCommitCount = 100_000;
export const performanceAuthorEmail = "performance@example.test";
export const localSummaryP95BudgetMilliseconds = 300;
export const localSummaryHeapBudgetBytes = 128 * 1024 * 1024;
export const streamedChunkSizeBudgetBytes = 256 * 1024;
export const rootBoundGraphCommandBatchP95BudgetMilliseconds = 1_000;
export const graphLoaderFastImportCommitCount = 5_000;
export const graphLoaderEndToEndP95BudgetMilliseconds = 2_000;

export interface SyntheticFileUri {
  readonly fsPath: string;
  readonly path: string;
  readonly scheme: "file";
  toString(): string;
}

export interface TemporaryGitRepository {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
  readonly fileCount: number;
}

export interface TemporaryGitGraphRepository {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
  readonly commitCount: number;
}

export function createSyntheticFileUri(filePath: string): SyntheticFileUri {
  return {
    fsPath: filePath,
    path: filePath,
    scheme: "file",
    toString: () => `file://${filePath}`,
  };
}

/** Creates actual untracked files; callers own cleanup of rootDirectory. */
export async function createTemporaryGitRepository(
  fileCount = largeRepositoryFileCount,
): Promise<TemporaryGitRepository> {
  const rootDirectory = await mkdtemp(nodePath.join("/tmp", "gito-perf-"));
  const repositoryPath = nodePath.join(rootDirectory, "repository");
  const filesDirectory = nodePath.join(repositoryPath, "files");
  try {
    await runGit(rootDirectory, ["init", "-b", "main", repositoryPath]);
    await mkdir(filesDirectory, { recursive: true });
    for (let batchStart = 0; batchStart < fileCount; batchStart += 250) {
      const batchEnd = Math.min(batchStart + 250, fileCount);
      await Promise.all(
        Array.from({ length: batchEnd - batchStart }, (_, batchOffset) => {
          const fileIndex = batchStart + batchOffset;
          return writeFile(
            nodePath.join(
              filesDirectory,
              `file-${String(fileIndex).padStart(5, "0")}.txt`,
            ),
            `performance fixture ${fileIndex}\n`,
          );
        }),
      );
    }
    return { rootDirectory, repositoryPath, fileCount };
  } catch (error: unknown) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function runGit(
  repositoryPath: string,
  gitArguments: readonly string[],
): Promise<string> {
  const commandResult = await executeFile("git", [...gitArguments], {
    cwd: repositoryPath,
    shell: false,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return commandResult.stdout;
}

export async function runGitWithStandardInput(
  repositoryPath: string,
  gitArguments: readonly string[],
  standardInput: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const gitProcess = spawn("git", [...gitArguments], {
      cwd: repositoryPath,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const standardErrorChunks: Buffer[] = [];
    gitProcess.stderr?.on("data", (chunk: Buffer | string) => {
      standardErrorChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
    gitProcess.once("error", reject);
    gitProcess.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `git ${gitArguments.join(" ")} failed (${exitCode ?? "signal"}): ${Buffer.concat(standardErrorChunks).toString("utf8")}`,
        ),
      );
    });
    gitProcess.stdin?.end(standardInput);
  });
}

export async function createTemporaryGitGraphRepository(
  commitCount = graphLoaderFastImportCommitCount,
): Promise<TemporaryGitGraphRepository> {
  if (!Number.isInteger(commitCount) || commitCount < 1)
    throw new Error("commitCount must be a positive integer.");
  const rootDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-graph-perf-"),
  );
  const repositoryPath = nodePath.join(rootDirectory, "repository");
  try {
    await runGit(rootDirectory, ["init", "-b", "main", repositoryPath]);
    await runGitWithStandardInput(
      repositoryPath,
      ["fast-import", "--quiet"],
      createFastImportHistory(commitCount),
    );
    return { rootDirectory, repositoryPath, commitCount };
  } catch (error: unknown) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

function createFastImportHistory(commitCount: number): string {
  const fastImportCommands: string[] = [];
  let previousCommitMark: number | undefined;
  for (let commitIndex = 0; commitIndex < commitCount; commitIndex += 1) {
    const commitMark = commitIndex + 1;
    const commitMessage = `graph fixture commit ${commitIndex}\n`;
    const fileContents = `graph fixture file ${commitIndex}\n`;
    fastImportCommands.push(
      `commit refs/heads/main\nmark :${commitMark}\nauthor Git'o Performance <performance@example.invalid> ${1_700_000_000 + commitIndex} +0000\ncommitter Git'o Performance <performance@example.invalid> ${1_700_000_000 + commitIndex} +0000\ndata ${Buffer.byteLength(commitMessage)}\n${commitMessage}${previousCommitMark === undefined ? "" : `from :${previousCommitMark}\n`}M 100644 inline graph.txt\ndata ${Buffer.byteLength(fileContents)}\n${fileContents}`,
    );
    previousCommitMark = commitMark;
  }
  fastImportCommands.push("done\n");
  return fastImportCommands.join("");
}

export function createRepositoryFromUntrackedPaths(
  repositoryPath: string,
  untrackedRelativePaths: readonly string[],
): VscodeGitRepository {
  const repositoryRoot = createSyntheticFileUri(repositoryPath);
  const untrackedChanges: readonly VscodeGitResourceState[] =
    untrackedRelativePaths.map((relativePath) => {
      const resourceUri = createSyntheticFileUri(
        nodePath.join(repositoryPath, relativePath),
      );
      return {
        uri: resourceUri as never,
        originalUri: resourceUri as never,
        renameUri: undefined,
        status: 0,
      };
    });
  const emptyResourceStates: readonly VscodeGitResourceState[] = [];
  const repositoryState: VscodeGitRepositoryState = {
    HEAD: { type: 0, name: "main" },
    refs: [],
    remotes: [],
    submodules: [],
    worktrees: [],
    rebaseCommit: undefined,
    mergeChanges: emptyResourceStates,
    indexChanges: emptyResourceStates,
    workingTreeChanges: emptyResourceStates,
    untrackedChanges,
    onDidChange: (() => ({ dispose: () => undefined })) as never,
  };
  return {
    rootUri: repositoryRoot as never,
    inputBox: { value: "" },
    state: repositoryState,
    kind: "repository",
    status: () => Promise.resolve(),
    add: () => Promise.resolve(),
    clean: () => Promise.resolve(),
    revert: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    pull: () => Promise.resolve(),
    push: () => Promise.resolve(),
    checkout: () => Promise.resolve(),
    createBranch: () => Promise.resolve(),
    deleteBranch: () => Promise.resolve(),
    getBranches: () => Promise.resolve([]),
    getCommit: () =>
      Promise.reject(new Error("Fixture does not expose commits.")),
    createWorktree: () => Promise.resolve(""),
    deleteWorktree: () => Promise.resolve(),
  };
}

export function parseUntrackedStatusOutput(
  statusOutput: string,
): readonly string[] {
  return statusOutput
    .split("\0")
    .filter((statusRecord) => statusRecord.startsWith("?? "))
    .map((statusRecord) => statusRecord.slice(3));
}

export function* createCommitActivityChunks(
  commitCount = largeRepositoryCommitCount,
  recordsPerChunk = 1_024,
): Generator<string> {
  let chunkRecords: string[] = [];
  for (let commitIndex = 0; commitIndex < commitCount; commitIndex += 1) {
    const day = String((commitIndex % 31) + 1).padStart(2, "0");
    chunkRecords.push(
      `2026-08-${day}T10:00:00+10:00\0${performanceAuthorEmail}\x01`,
    );
    if (chunkRecords.length < recordsPerChunk) continue;
    yield chunkRecords.join("");
    chunkRecords = [];
  }
  if (chunkRecords.length > 0) yield chunkRecords.join("");
}

export function calculateP95Milliseconds(
  elapsedMilliseconds: readonly number[],
): number {
  if (elapsedMilliseconds.length === 0) throw new Error("No samples.");
  const sortedSamples = [...elapsedMilliseconds].sort(
    (leftSample, rightSample) => leftSample - rightSample,
  );
  const percentileIndex = Math.min(
    sortedSamples.length - 1,
    Math.ceil(sortedSamples.length * 0.95) - 1,
  );
  return sortedSamples[percentileIndex] ?? 0;
}
