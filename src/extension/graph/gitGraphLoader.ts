import type {
  GitCommandOutput,
  GitCommandRunner,
} from "../git/gitCommandRunner.js";
import { GitCommandFailure, isAbortError } from "../git/gitCommandRunner.js";
import type {
  GraphCommitRecord,
  GraphReferenceKind,
  GraphReference,
  GraphRepositorySnapshot,
  GraphWorkingTreeState,
  GraphWorktree,
} from "./graphModels.js";

export interface GraphRepositoryRoot {
  readonly fsPath: string;
}

export interface GitGraphLoadOptions {
  readonly maxCommitCount?: number;
  readonly cancellationSignal?: AbortSignal;
}

const graphRecordSeparator = "\x01";
const graphFieldSeparator = "\x00";
const graphLogOutputByteCap = 64 * 1024 * 1024;
const graphReferenceOutputByteCap = 8 * 1024 * 1024;
const graphHeadOutputByteCap = 8 * 1024;
const graphWorktreeOutputByteCap = 4 * 1024 * 1024;
const graphStatusOutputByteCap = 8 * 1024 * 1024;
const graphFieldCharacterCap = 4_096;
const graphShaCharacterCap = 128;

function boundGraphField(
  field: string,
  characterCap = graphFieldCharacterCap,
): string {
  return field.length <= characterCap ? field : field.slice(0, characterCap);
}

function getRepositoryPath(
  repositoryRoot: string | GraphRepositoryRoot,
): string {
  return typeof repositoryRoot === "string"
    ? repositoryRoot
    : repositoryRoot.fsPath;
}

function parseGitLogCommitRecords(
  logOutput: string,
): readonly GraphCommitRecord[] {
  const commits: GraphCommitRecord[] = [];
  for (const record of logOutput.split(graphRecordSeparator)) {
    if (record.length === 0) continue;
    const fields = record.split(graphFieldSeparator);
    const sha =
      fields[0] === undefined
        ? undefined
        : boundGraphField(fields[0].trim(), graphShaCharacterCap);
    if (sha === undefined || sha.length === 0) continue;
    const parentField = boundGraphField(
      fields[1] ?? "",
      graphShaCharacterCap * 64,
    );
    const subject = boundGraphField(fields[2] ?? "");
    const authorName = boundGraphField(fields[3] ?? "");
    const authorEmail = boundGraphField(fields[4] ?? "");
    const authorDate = boundGraphField(fields[5] ?? "");
    const commitDate = boundGraphField(fields[6] ?? "");
    commits.push({
      sha,
      parents: parentField
        .split(" ")
        .filter((parentSha) => parentSha.length > 0)
        .slice(0, 128)
        .map((parentSha) => boundGraphField(parentSha, graphShaCharacterCap)),
      ...(subject.length === 0 ? {} : { subject }),
      ...(authorName.length === 0 ? {} : { authorName }),
      ...(authorEmail.length === 0 ? {} : { authorEmail }),
      ...(authorDate.length === 0 ? {} : { authorDate }),
      ...(commitDate.length === 0 ? {} : { commitDate }),
    });
  }
  return commits;
}

async function parseGitLogCommitRecordsAsync(
  logOutput: string,
  cancellationSignal: AbortSignal | undefined,
  chunkSize = 256,
): Promise<readonly GraphCommitRecord[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1)
    throw new Error("chunkSize must be a positive integer.");
  const commits: GraphCommitRecord[] = [];
  const records = logOutput.split(graphRecordSeparator);
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    if (recordIndex % chunkSize === 0) {
      throwIfGraphLoaderCancelled(cancellationSignal);
      if (recordIndex > 0) await yieldToGraphHost();
    }
    const record = records[recordIndex];
    if (record === undefined || record.length === 0) continue;
    const fields = record.split(graphFieldSeparator);
    const sha =
      fields[0] === undefined
        ? undefined
        : boundGraphField(fields[0].trim(), graphShaCharacterCap);
    if (sha === undefined || sha.length === 0) continue;
    const parentField = boundGraphField(
      fields[1] ?? "",
      graphShaCharacterCap * 64,
    );
    const subject = boundGraphField(fields[2] ?? "");
    const authorName = boundGraphField(fields[3] ?? "");
    const authorEmail = boundGraphField(fields[4] ?? "");
    const authorDate = boundGraphField(fields[5] ?? "");
    const commitDate = boundGraphField(fields[6] ?? "");
    commits.push({
      sha,
      parents: parentField
        .split(" ")
        .filter((parentSha) => parentSha.length > 0)
        .slice(0, 128)
        .map((parentSha) => boundGraphField(parentSha, graphShaCharacterCap)),
      ...(subject.length === 0 ? {} : { subject }),
      ...(authorName.length === 0 ? {} : { authorName }),
      ...(authorEmail.length === 0 ? {} : { authorEmail }),
      ...(authorDate.length === 0 ? {} : { authorDate }),
      ...(commitDate.length === 0 ? {} : { commitDate }),
    });
  }
  throwIfGraphLoaderCancelled(cancellationSignal);
  return commits;
}

function classifyReferenceName(referenceName: string): GraphReferenceKind {
  if (referenceName === "refs/stash") return "stash";
  if (referenceName.startsWith("refs/remotes/")) return "remote";
  if (referenceName.startsWith("refs/tags/")) return "tag";
  return "local";
}

interface ParsedReferenceRecord {
  readonly name: string;
  readonly targetSha: string;
  readonly peeledTargetSha?: string;
  readonly upstreamRefName?: string;
  readonly trackDescription?: string;
}

function parseReferenceRecords(
  referenceOutput: string,
): readonly ParsedReferenceRecord[] {
  const references: ParsedReferenceRecord[] = [];
  for (const record of referenceOutput.split(graphRecordSeparator)) {
    if (record.length === 0) continue;
    const [
      rawName,
      rawTargetSha,
      rawPeeledTargetSha,
      rawUpstreamRefName,
      rawTrackDescription,
    ] = record.split(graphFieldSeparator);
    const name =
      rawName === undefined ? undefined : boundGraphField(rawName.trim());
    const targetSha =
      rawTargetSha === undefined
        ? undefined
        : boundGraphField(rawTargetSha.trim(), graphShaCharacterCap);
    const peeledTargetSha =
      rawPeeledTargetSha === undefined
        ? undefined
        : boundGraphField(rawPeeledTargetSha.trim(), graphShaCharacterCap);
    const upstreamRefName =
      rawUpstreamRefName === undefined
        ? undefined
        : boundGraphField(rawUpstreamRefName.trim());
    const trackDescription =
      rawTrackDescription === undefined
        ? undefined
        : boundGraphField(rawTrackDescription.trim());
    if (
      name === undefined ||
      targetSha === undefined ||
      name.length === 0 ||
      targetSha.length === 0
    )
      continue;
    references.push({
      name,
      targetSha,
      ...(peeledTargetSha === undefined || peeledTargetSha.length === 0
        ? {}
        : { peeledTargetSha }),
      ...(upstreamRefName === undefined || upstreamRefName.length === 0
        ? {}
        : { upstreamRefName }),
      ...(trackDescription === undefined || trackDescription.length === 0
        ? {}
        : { trackDescription }),
    });
  }
  return references;
}

function parseWorktreeRecords(
  worktreeOutput: string,
): readonly GraphWorktree[] {
  const worktrees: GraphWorktree[] = [];
  let currentPath: string | undefined;
  let currentHeadSha: string | undefined;
  let currentBranchRefName: string | undefined;
  let currentIsLocked = false;
  let currentIsPrunable = false;
  const flushWorktree = (): void => {
    if (currentPath === undefined || currentHeadSha === undefined) return;
    worktrees.push({
      path: currentPath,
      headSha: currentHeadSha,
      ...(currentBranchRefName === undefined
        ? {}
        : { branchRefName: currentBranchRefName }),
      ...(currentIsLocked ? { isLocked: true } : {}),
      ...(currentIsPrunable ? { isPrunable: true } : {}),
      ...(worktrees.length === 0 ? { isPrimary: true } : {}),
    });
    currentPath = undefined;
    currentHeadSha = undefined;
    currentBranchRefName = undefined;
    currentIsLocked = false;
    currentIsPrunable = false;
  };
  for (const line of worktreeOutput.split(/\r?\n/)) {
    if (line.length === 0) {
      flushWorktree();
      continue;
    }
    const separatorIndex = line.indexOf(" ");
    const key = separatorIndex < 0 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex < 0 ? "" : line.slice(separatorIndex + 1);
    if (key === "worktree") currentPath = boundGraphField(value);
    else if (key === "HEAD")
      currentHeadSha = boundGraphField(value, graphShaCharacterCap);
    else if (key === "branch") currentBranchRefName = boundGraphField(value);
    else if (key === "locked") currentIsLocked = true;
    else if (key === "prunable") currentIsPrunable = true;
  }
  flushWorktree();
  return worktrees;
}

export function parseWorkingTreeState(
  statusOutput: string,
): GraphWorkingTreeState | undefined {
  const statusLines = statusOutput
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (statusLines.length === 0) return undefined;
  let stagedChangeCount = 0;
  let unstagedChangeCount = 0;
  let untrackedChangeCount = 0;
  for (const statusLine of statusLines) {
    const indexStatus = statusLine[0] ?? " ";
    const workingTreeStatus = statusLine[1] ?? " ";
    if (indexStatus === "?" && workingTreeStatus === "?") {
      untrackedChangeCount += 1;
      continue;
    }
    if (indexStatus !== " ") stagedChangeCount += 1;
    if (workingTreeStatus !== " ") unstagedChangeCount += 1;
  }
  return {
    stagedChangeCount,
    unstagedChangeCount,
    untrackedChangeCount,
    label: "Working tree",
  };
}

function parseTrackDescription(trackDescription: string | undefined): {
  aheadCount: number;
  behindCount: number;
} {
  if (trackDescription === undefined) return { aheadCount: 0, behindCount: 0 };
  const aheadCount = Number(trackDescription.match(/ahead (\d+)/)?.[1] ?? 0);
  const behindCount = Number(trackDescription.match(/behind (\d+)/)?.[1] ?? 0);
  return {
    aheadCount: Number.isSafeInteger(aheadCount) ? aheadCount : 0,
    behindCount: Number.isSafeInteger(behindCount) ? behindCount : 0,
  };
}

function createReferenceRecords(
  parsedReferences: readonly ParsedReferenceRecord[],
  headRefName: string | undefined,
  detachedHeadSha: string | undefined,
): readonly GraphReference[] {
  const references: GraphReference[] = parsedReferences.map((reference) => ({
    name: reference.name,
    targetSha: reference.peeledTargetSha ?? reference.targetSha,
    kind: classifyReferenceName(reference.name),
    ...(reference.upstreamRefName === undefined
      ? {}
      : { upstreamRefName: reference.upstreamRefName }),
  }));
  if (headRefName !== undefined) {
    const headReference = references.find(
      (reference) =>
        reference.name === headRefName ||
        reference.name === `refs/heads/${headRefName}`,
    );
    if (headReference !== undefined) {
      references.push({
        ...headReference,
        name: "HEAD",
        kind: "head",
        isHead: true,
      });
    }
  } else if (detachedHeadSha !== undefined) {
    references.push({
      name: "HEAD",
      targetSha: detachedHeadSha,
      kind: "head",
      isHead: true,
    });
  }
  return references;
}

function readHeadRefName(referenceOutput: string): string | undefined {
  const headRefName = referenceOutput.trim();
  return headRefName.length === 0 ? undefined : headRefName;
}

function readHeadCommitSha(commitOutput: string): string | undefined {
  const headCommitSha = commitOutput.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(headCommitSha) &&
    !/^0+$/u.test(headCommitSha)
    ? headCommitSha
    : undefined;
}

async function runOptional(
  gitCommandRunner: GitCommandRunner,
  request: Parameters<GitCommandRunner["run"]>[0],
): Promise<GitCommandOutput | undefined> {
  try {
    return await gitCommandRunner.run(request);
  } catch (error: unknown) {
    if (
      isAbortError(error) ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    return undefined;
  }
}

function isMissingHeadRevisionFailure(error: unknown): boolean {
  return (
    error instanceof GitCommandFailure &&
    error.exitCode === 128 &&
    /(?:ambiguous argument|unknown revision|bad revision).*HEAD/iu.test(
      error.standardError,
    )
  );
}

/** Loads bounded metadata only; no Git patch/body command is executed. */
export class GitCommitGraphLoader {
  public constructor(private readonly gitCommandRunner: GitCommandRunner) {}

  public async load(
    repositoryRoot: string | GraphRepositoryRoot,
    options: GitGraphLoadOptions = {},
  ): Promise<GraphRepositorySnapshot> {
    const repositoryPath = getRepositoryPath(repositoryRoot);
    const maxCommitCount = options.maxCommitCount ?? 250_000;
    if (!Number.isInteger(maxCommitCount) || maxCommitCount < 1)
      throw new Error("maxCommitCount must be a positive integer.");
    const logArguments = [
      "log",
      "--all",
      // Include HEAD explicitly so a detached worktree remains fully visible.
      "HEAD",
      "--topo-order",
      "--date-order",
      `--max-count=${maxCommitCount + 1}`,
      "--date=iso-strict",
      "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%cI%x01",
    ];
    let logOutput: GitCommandOutput;
    try {
      logOutput = await this.gitCommandRunner.run({
        repositoryRoot: repositoryPath,
        arguments: logArguments,
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphLogOutputByteCap,
      });
    } catch (error: unknown) {
      if (isAbortError(error) || !isMissingHeadRevisionFailure(error))
        throw error;
      // An unborn repository has no HEAD revision. Keep empty repositories
      // loadable while retaining explicit HEAD traversal everywhere else.
      logOutput = await this.gitCommandRunner.run({
        repositoryRoot: repositoryPath,
        arguments: logArguments.filter((argument) => argument !== "HEAD"),
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphLogOutputByteCap,
      });
    }
    const [
      referenceOutput,
      headOutput,
      headCommitOutput,
      worktreeOutput,
      statusOutput,
    ] = await Promise.all([
      this.gitCommandRunner.run({
        repositoryRoot: repositoryPath,
        arguments: [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track)%01",
          "refs/heads/*",
          "refs/remotes/*/*",
          "refs/tags/*",
          "refs/stash",
        ],
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphReferenceOutputByteCap,
      }),
      runOptional(this.gitCommandRunner, {
        repositoryRoot: repositoryPath,
        arguments: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphHeadOutputByteCap,
      }),
      runOptional(this.gitCommandRunner, {
        repositoryRoot: repositoryPath,
        arguments: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphHeadOutputByteCap,
      }),
      runOptional(this.gitCommandRunner, {
        repositoryRoot: repositoryPath,
        arguments: ["worktree", "list", "--porcelain"],
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphWorktreeOutputByteCap,
      }),
      runOptional(this.gitCommandRunner, {
        repositoryRoot: repositoryPath,
        arguments: ["status", "--porcelain=v1", "--untracked-files=normal"],
        cancellationSignal: options.cancellationSignal,
        maxStandardOutputBytes: graphStatusOutputByteCap,
      }),
    ]);
    const parsedReferences = parseReferenceRecords(
      referenceOutput.standardOutput,
    );
    const headRefName = readHeadRefName(headOutput?.standardOutput ?? "");
    const worktrees = parseWorktreeRecords(
      worktreeOutput?.standardOutput ?? "",
    );
    const primaryWorktreeHeadSha = worktrees.find(
      (worktree) => worktree.isPrimary === true,
    )?.headSha;
    const detachedHeadSha =
      readHeadCommitSha(headCommitOutput?.standardOutput ?? "") ??
      (headRefName === undefined
        ? readHeadCommitSha(primaryWorktreeHeadSha ?? "")
        : undefined);
    const references = createReferenceRecords(
      parsedReferences,
      headRefName,
      detachedHeadSha,
    );
    const parsedCommits = await parseGitLogCommitRecordsAsync(
      logOutput.standardOutput,
      options.cancellationSignal,
    );
    const commits = parsedCommits.slice(0, maxCommitCount);
    const workingTree = parseWorkingTreeState(
      statusOutput?.standardOutput ?? "",
    );
    return {
      commits,
      ...(parsedCommits.length > maxCommitCount ||
      logOutput.standardOutputTruncated === true ||
      referenceOutput.standardOutputTruncated === true ||
      headOutput?.standardOutputTruncated === true ||
      headCommitOutput?.standardOutputTruncated === true ||
      worktreeOutput?.standardOutputTruncated === true ||
      statusOutput?.standardOutputTruncated === true
        ? { truncated: true }
        : {}),
      references,
      worktrees,
      ...(workingTree === undefined ? {} : { workingTree }),
    };
  }
}

export {
  parseGitLogCommitRecords,
  parseGitLogCommitRecordsAsync,
  parseReferenceRecords,
  parseWorktreeRecords,
  parseTrackDescription,
};

function throwIfGraphLoaderCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Commit graph load cancelled", "AbortError");
}

function yieldToGraphHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
