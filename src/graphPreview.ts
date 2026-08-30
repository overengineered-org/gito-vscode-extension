import {
  runGitCommand,
  type GitCommandContext,
  runGitCommandWithExitCode,
} from "./gitCommand.ts";

export interface ChangedPathPreview {
  readonly path: string;
  readonly status: string;
}

export interface GraphComparisonPreview {
  readonly additions: number;
  readonly changedPaths: readonly ChangedPathPreview[];
  readonly commitsOnlyInCurrentBranch: number;
  readonly commitsOnlyInSelectedCommit: number;
  readonly deletions: number;
  readonly selectedCommitHash: string;
}

export interface GraphSyncPreview {
  readonly conflictRisk: "conflicts" | "none" | "unknown";
  readonly incomingChangedPaths: readonly ChangedPathPreview[];
  readonly incomingCommitCount: number;
  readonly outgoingChangedPaths: readonly ChangedPathPreview[];
  readonly outgoingCommitCount: number;
  readonly upstreamName: string;
}

const commitHashPattern = /^[0-9a-f]{7,64}$/iu;

export async function loadGraphComparisonPreview(
  gitCommandContext: GitCommandContext,
  selectedCommitHash: string,
  currentCommitHash: string,
): Promise<GraphComparisonPreview> {
  assertCommitHash(selectedCommitHash);
  assertCommitHash(currentCommitHash);
  const [commitCounts, changedPaths, shortStat] = await Promise.all([
    runGitCommand(gitCommandContext, [
      "rev-list",
      "--left-right",
      "--count",
      `${selectedCommitHash}...${currentCommitHash}`,
    ]),
    runGitCommand(gitCommandContext, [
      "diff",
      "--name-status",
      "-z",
      `${selectedCommitHash}..${currentCommitHash}`,
    ]),
    runGitCommand(gitCommandContext, [
      "diff",
      "--shortstat",
      `${selectedCommitHash}..${currentCommitHash}`,
    ]),
  ]);
  const [commitsOnlyInSelectedCommit, commitsOnlyInCurrentBranch] =
    parseLeftRightCommitCounts(commitCounts);
  const { additions, deletions } = parseShortDiffStat(shortStat);
  return {
    additions,
    changedPaths: parseNameStatusRecords(changedPaths),
    commitsOnlyInCurrentBranch,
    commitsOnlyInSelectedCommit,
    deletions,
    selectedCommitHash,
  };
}

export async function loadGraphSyncPreview(
  gitCommandContext: GitCommandContext,
  currentCommitHash: string,
  upstreamName: string,
): Promise<GraphSyncPreview> {
  assertCommitHash(currentCommitHash);
  const verifiedUpstreamHash = (
    await runGitCommand(gitCommandContext, ["rev-parse", "--verify", upstreamName])
  ).trim();
  assertCommitHash(verifiedUpstreamHash);
  const mergeBaseHash = (
    await runGitCommand(gitCommandContext, [
      "merge-base",
      currentCommitHash,
      verifiedUpstreamHash,
    ])
  ).trim();
  assertCommitHash(mergeBaseHash);
  const [commitCounts, incomingChangedPaths, outgoingChangedPaths, mergeTreeResult] =
    await Promise.all([
      runGitCommand(gitCommandContext, [
        "rev-list",
        "--left-right",
        "--count",
        `${currentCommitHash}...${verifiedUpstreamHash}`,
      ]),
      runGitCommand(gitCommandContext, [
        "diff",
        "--name-status",
        "-z",
        `${mergeBaseHash}..${verifiedUpstreamHash}`,
      ]),
      runGitCommand(gitCommandContext, [
        "diff",
        "--name-status",
        "-z",
        `${mergeBaseHash}..${currentCommitHash}`,
      ]),
      runGitCommandWithExitCode(gitCommandContext, [
        "merge-tree",
        "--write-tree",
        currentCommitHash,
        verifiedUpstreamHash,
      ]),
    ]);
  const [outgoingCommitCount, incomingCommitCount] = parseLeftRightCommitCounts(commitCounts);
  return {
    conflictRisk:
      incomingCommitCount === 0
        ? "none"
        : mergeTreeResult.exitCode === 0
          ? "none"
          : mergeTreeResult.exitCode === 1
            ? "conflicts"
            : "unknown",
    incomingChangedPaths: parseNameStatusRecords(incomingChangedPaths),
    incomingCommitCount,
    outgoingChangedPaths: parseNameStatusRecords(outgoingChangedPaths),
    outgoingCommitCount,
    upstreamName,
  };
}

export function parseLeftRightCommitCounts(commitCountOutput: string): readonly [number, number] {
  const commitCounts = commitCountOutput.trim().split(/\s+/u).map(Number);
  if (
    commitCounts.length !== 2 ||
    commitCounts.some((commitCount) => !Number.isSafeInteger(commitCount) || commitCount < 0)
  ) {
    throw new Error("Git returned invalid ahead/behind counts.");
  }
  return [commitCounts[0] ?? 0, commitCounts[1] ?? 0];
}

export function parseNameStatusRecords(nameStatusOutput: string): readonly ChangedPathPreview[] {
  const fields = nameStatusOutput.split("\0");
  const changedPaths: ChangedPathPreview[] = [];
  for (let fieldIndex = 0; fieldIndex < fields.length; ) {
    const status = fields[fieldIndex++];
    if (status === undefined || status === "") {
      continue;
    }
    const firstPath = fields[fieldIndex++];
    if (firstPath === undefined || firstPath === "") {
      throw new Error("Git returned an incomplete changed-path record.");
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const destinationPath = fields[fieldIndex++];
      if (destinationPath === undefined || destinationPath === "") {
        throw new Error("Git returned an incomplete renamed-path record.");
      }
      changedPaths.push({ path: `${firstPath} → ${destinationPath}`, status });
    } else {
      changedPaths.push({ path: firstPath, status });
    }
  }
  return changedPaths;
}

export function parseShortDiffStat(shortStatOutput: string): {
  readonly additions: number;
  readonly deletions: number;
} {
  const additions = Number(/(\d+) insertion/u.exec(shortStatOutput)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletion/u.exec(shortStatOutput)?.[1] ?? 0);
  return { additions, deletions };
}

function assertCommitHash(commitHash: string): void {
  if (!commitHashPattern.test(commitHash)) {
    throw new Error("Git'o received an invalid commit hash.");
  }
}
