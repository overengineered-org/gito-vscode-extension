import type { GitCommit } from "./gitApi.ts";
import type { FileChangeStats } from "./graphSearch.ts";
import { type GitReference, GitReferenceType } from "./gitModel.ts";

interface GraphConnection {
  readonly colorIndex: number;
  readonly fromLane: number;
  readonly startsAtNode: boolean;
  readonly toLane: number;
}

interface GraphReferenceLabel {
  readonly kind: "branch" | "remote" | "tag";
  readonly name: string;
}

export interface CommitGraphRow {
  readonly additions?: number;
  readonly authorName: string;
  readonly committedAt?: number;
  readonly deletions?: number;
  readonly connections: readonly GraphConnection[];
  readonly hash: string;
  readonly hiddenLaneCount: number;
  readonly laneCount: number;
  readonly nodeColorIndex: number;
  readonly nodeLane: number;
  readonly parentCount: number;
  readonly referenceLabels: readonly GraphReferenceLabel[];
  readonly shortHash: string;
  readonly subject: string;
}

export function buildCommitGraphRows(
  gitCommits: readonly GitCommit[],
  gitReferences: readonly GitReference[],
  changeStatsByCommitHash: ReadonlyMap<string, FileChangeStats> = new Map(),
): readonly CommitGraphRow[] {
  const referenceLabelsByCommit = mapReferenceLabelsByCommit(gitReferences);
  let activeCommitHashes: string[] = [];
  const maximumVisibleLaneCount = 6;

  return gitCommits.map((gitCommit): CommitGraphRow => {
    const existingCommitLane = activeCommitHashes.indexOf(gitCommit.hash);
    if (existingCommitLane === -1) {
      activeCommitHashes.unshift(gitCommit.hash);
    }
    const commitLane = Math.max(activeCommitHashes.indexOf(gitCommit.hash), 0);
    const activeCommitHashesBefore = [...activeCommitHashes];
    const activeCommitHashesAfter = activeCommitHashes.filter(
      (activeCommitHash) => activeCommitHash !== gitCommit.hash,
    );
    const uniqueParentHashes = [...new Set(gitCommit.parents)];
    let insertedParentCount = 0;
    for (const parentHash of uniqueParentHashes) {
      if (!activeCommitHashesAfter.includes(parentHash)) {
        activeCommitHashesAfter.splice(commitLane + insertedParentCount, 0, parentHash);
        insertedParentCount += 1;
      }
    }

    const continuationConnections = activeCommitHashesBefore.flatMap(
      (activeCommitHash, fromLane): GraphConnection[] => {
        if (activeCommitHash === gitCommit.hash) {
          return [];
        }
        const toLane = activeCommitHashesAfter.indexOf(activeCommitHash);
        return toLane === -1
          ? []
          : [{ colorIndex: fromLane % 4, fromLane, startsAtNode: false, toLane }];
      },
    );
    const parentConnections = uniqueParentHashes.flatMap((parentHash): GraphConnection[] => {
      const parentLane = activeCommitHashesAfter.indexOf(parentHash);
      return parentLane === -1
        ? []
        : [
            {
              colorIndex: parentLane % 4,
              fromLane: commitLane,
              startsAtNode: true,
              toLane: parentLane,
            },
          ];
    });
    activeCommitHashes = activeCommitHashesAfter;
    const committedAt = gitCommit.commitDate ?? gitCommit.authorDate;
    const fileChangeStats = changeStatsByCommitHash.get(gitCommit.hash);
    const fullLaneCount = Math.max(
      activeCommitHashesBefore.length,
      activeCommitHashesAfter.length,
      1,
    );

    return {
      authorName: gitCommit.authorName ?? "Unknown author",
      ...(fileChangeStats === undefined ? {} : { additions: fileChangeStats.additions }),
      ...(committedAt === undefined ? {} : { committedAt: committedAt.getTime() }),
      connections: [...continuationConnections, ...parentConnections].filter(
        (connection) =>
          connection.fromLane < maximumVisibleLaneCount &&
          connection.toLane < maximumVisibleLaneCount,
      ),
      ...(fileChangeStats === undefined ? {} : { deletions: fileChangeStats.deletions }),
      hash: gitCommit.hash,
      hiddenLaneCount: Math.max(0, fullLaneCount - maximumVisibleLaneCount),
      laneCount: Math.min(fullLaneCount, maximumVisibleLaneCount),
      nodeColorIndex: Math.min(commitLane, maximumVisibleLaneCount - 1) % 4,
      nodeLane: Math.min(commitLane, maximumVisibleLaneCount - 1),
      parentCount: uniqueParentHashes.length,
      referenceLabels: referenceLabelsByCommit.get(gitCommit.hash) ?? [],
      shortHash: gitCommit.hash.slice(0, 8),
      subject: gitCommit.message.split("\n", 1)[0] || "No commit message",
    };
  });
}

function mapReferenceLabelsByCommit(
  gitReferences: readonly GitReference[],
): ReadonlyMap<string, readonly GraphReferenceLabel[]> {
  const referenceLabelsByCommit = new Map<string, GraphReferenceLabel[]>();
  for (const gitReference of gitReferences) {
    if (
      gitReference.commit === undefined ||
      gitReference.name === undefined ||
      (gitReference.type === GitReferenceType.remoteBranch &&
        gitReference.name.endsWith("/HEAD"))
    ) {
      continue;
    }
    const referenceLabels = referenceLabelsByCommit.get(gitReference.commit) ?? [];
    referenceLabels.push({
      kind:
        gitReference.type === GitReferenceType.tag
          ? "tag"
          : gitReference.type === GitReferenceType.remoteBranch
            ? "remote"
            : "branch",
      name: gitReference.name,
    });
    referenceLabelsByCommit.set(gitReference.commit, referenceLabels);
  }
  for (const referenceLabels of referenceLabelsByCommit.values()) {
    referenceLabels.sort(compareReferenceLabels);
  }
  return referenceLabelsByCommit;
}

function compareReferenceLabels(
  firstReferenceLabel: GraphReferenceLabel,
  secondReferenceLabel: GraphReferenceLabel,
): number {
  const referenceKindOrder = { branch: 0, tag: 1, remote: 2 } as const;
  return (
    referenceKindOrder[firstReferenceLabel.kind] -
      referenceKindOrder[secondReferenceLabel.kind] ||
    firstReferenceLabel.name.localeCompare(secondReferenceLabel.name)
  );
}
