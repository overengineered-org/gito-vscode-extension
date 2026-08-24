/** Domain-only data required to render and query a commit graph. */

export type GraphReferenceKind = "head" | "local" | "remote" | "tag" | "stash";

export type GraphScope =
  "all" | "current" | "local" | "remote" | "tags" | "stashes" | "worktrees";

/**
 * A deliberately small commit record.  It contains no commit body, patch,
 * file list, or tree data, so a 100k commit graph remains bounded by metadata.
 */
export interface GraphCommitRecord {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly authorDate?: string;
  readonly commitDate?: string;
}

export interface GraphReference {
  readonly name: string;
  readonly targetSha: string;
  readonly kind?: GraphReferenceKind;
  readonly isHead?: boolean;
  readonly upstreamRefName?: string;
}

export interface GraphWorktree {
  readonly path: string;
  readonly headSha: string;
  readonly branchRefName?: string;
  readonly isPrimary?: boolean;
  readonly isLocked?: boolean;
  readonly isPrunable?: boolean;
}

export interface GraphWorkingTreeState {
  readonly stagedChangeCount?: number;
  readonly unstagedChangeCount?: number;
  readonly untrackedChangeCount?: number;
  readonly label?: string;
}

export interface GraphRepositorySnapshot {
  readonly commits: readonly GraphCommitRecord[];
  /** Set when the loader or engine applied a commit safety cap. */
  readonly truncated?: boolean;
  readonly references?: readonly GraphReference[];
  readonly worktrees?: readonly GraphWorktree[];
  readonly workingTree?: GraphWorkingTreeState;
}

export interface GraphFilter {
  readonly scope?: GraphScope;
  readonly text?: string;
  readonly authorEmail?: string;
  readonly authorName?: string;
  readonly commitShas?: readonly string[];
  readonly referenceNames?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

export interface GraphQueryOptions {
  readonly cursor?: GraphCursor | string;
  readonly pageSize?: number;
  readonly maxRows?: number;
  readonly filter?: GraphFilter;
  readonly includeWip?: boolean;
  readonly includeWorktrees?: boolean;
  readonly cancellationSignal?: AbortSignal;
}

export interface GraphMinimapOptions {
  readonly bucketCount?: number;
  readonly filter?: GraphFilter;
  readonly includeWip?: boolean;
  readonly includeWorktrees?: boolean;
  readonly cancellationSignal?: AbortSignal;
}

export interface GraphMinimapBucket {
  readonly bucketIndex: number;
  readonly startRow: number;
  readonly endRow: number;
  readonly commitCount: number;
  readonly mergeCount: number;
  readonly referenceCount: number;
  /** Count per semantic color index; UI maps indices to palette tokens. */
  readonly colorCounts: readonly number[];
}

export interface GraphCursor {
  readonly snapshotKey: string;
  readonly rowOffset: number;
}

export interface GraphLane {
  readonly column: number;
  readonly expectedCommitSha: string;
  /** Stable semantic index. UI palettes can map this to a token later. */
  readonly colorIndex: number;
}

export type GraphLaneEdgeKind =
  "first-parent" | "merge-parent" | "continuation";

export interface GraphLaneEdge {
  readonly parentSha: string;
  readonly fromColumn: number;
  readonly toColumn: number;
  readonly colorIndex: number;
  readonly kind: GraphLaneEdgeKind;
}

export interface GraphCommitRow {
  readonly kind: "commit";
  readonly rowIndex: number;
  readonly commitSha: string;
  readonly parents: readonly string[];
  /** Lanes immediately before this commit is consumed. */
  readonly lanes: readonly GraphLane[];
  /** Lanes immediately after this commit is consumed. */
  readonly nextLanes: readonly GraphLane[];
  readonly edges: readonly GraphLaneEdge[];
  readonly references: readonly GraphReference[];
  readonly subject?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly authorDate?: string;
  readonly commitDate?: string;
}

export interface GraphWipRow {
  readonly kind: "wip";
  readonly rowIndex: number;
  readonly label: string;
  readonly stagedChangeCount: number;
  readonly unstagedChangeCount: number;
  readonly untrackedChangeCount: number;
  readonly lanes: readonly GraphLane[];
}

export interface GraphWorktreeRow {
  readonly kind: "worktree";
  readonly rowIndex: number;
  readonly worktree: GraphWorktree;
  readonly anchorCommitSha?: string;
  readonly lanes: readonly GraphLane[];
}

export type GraphRow = GraphCommitRow | GraphWipRow | GraphWorktreeRow;

export interface GraphPage {
  readonly rows: readonly GraphRow[];
  readonly nextCursor?: GraphCursor;
  readonly hasMore: boolean;
  readonly totalRows: number;
  readonly totalCommits: number;
  readonly truncated: boolean;
  readonly snapshotKey: string;
}

export interface GraphBranchStatus {
  readonly localRefName: string;
  readonly upstreamRefName?: string;
  readonly mergeBaseSha?: string;
  readonly aheadCount: number;
  readonly behindCount: number;
}

export interface ChangedLineMetrics {
  readonly commitSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFileCount: number;
  readonly binaryFileCount: number;
  readonly truncated?: boolean;
}

export type ChangedLineMetricsLoader = (
  commitSha: string,
  cancellationSignal?: AbortSignal,
) => Promise<ChangedLineMetrics>;

export interface GraphEngineOptions {
  readonly maxCommitCount?: number;
  readonly maxRowCount?: number;
  readonly maxMetricsCacheEntries?: number;
  readonly colorCount?: number;
  readonly metricsLoader?: ChangedLineMetricsLoader;
  /** Shared layout work is cancelled only when this lifecycle ends. */
  readonly lifecycleSignal?: AbortSignal;
}

export const defaultGraphEngineOptions = {
  maxCommitCount: 250_000,
  maxRowCount: 500_000,
  maxMetricsCacheEntries: 2_048,
  colorCount: 12,
} as const;

export function isGraphCommitRow(row: GraphRow): row is GraphCommitRow {
  return row.kind === "commit";
}

export function classifyGraphReference(
  reference: Pick<GraphReference, "name" | "isHead" | "kind">,
): GraphReferenceKind {
  if (reference.kind !== undefined) return reference.kind;
  if (reference.isHead || reference.name === "HEAD") return "head";
  if (reference.name === "refs/stash" || reference.name.startsWith("stash@{"))
    return "stash";
  if (reference.name.startsWith("refs/remotes/")) return "remote";
  if (reference.name.startsWith("refs/tags/")) return "tag";
  return "local";
}

export function displayGraphReferenceName(referenceName: string): string {
  if (referenceName === "HEAD") return referenceName;
  return referenceName.replace(/^refs\/(heads|remotes|tags)\//, "");
}
