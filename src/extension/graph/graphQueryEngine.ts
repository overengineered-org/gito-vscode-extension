import {
  forEachGraphLayoutRow,
  forEachGraphLayoutRowAsync,
  getGraphSemanticColorIndex,
  IncrementalGraphLayoutBuilder,
  throwIfGraphLayoutCancelled,
  type GraphLayoutAsyncOptions,
  type GraphLayoutCommitRow,
} from "./graphLayout.js";
import {
  classifyGraphReference,
  defaultGraphEngineOptions,
  type ChangedLineMetrics,
  type GraphBranchStatus,
  type GraphCommitRecord,
  type GraphCommitRow,
  type GraphCursor,
  type GraphEngineOptions,
  type GraphFilter,
  type GraphMinimapBucket,
  type GraphMinimapOptions,
  type GraphPage,
  type GraphQueryOptions,
  type GraphReference,
  type GraphRepositorySnapshot,
  type GraphRow,
  type GraphScope,
  type GraphWorktreeRow,
  type GraphWorktree,
  type GraphWipRow,
} from "./graphModels.js";

const defaultPageSize = 200;
/** Row lookup scans at most one bounded checkpoint window after counting. */
const matchingRowCheckpointInterval = 256;
// Retain one sparse result so filter churn cannot multiply that memory
// footprint. Checkpoints, unlike full row-index arrays, stay bounded.
const maximumCachedMatchingQueries = 1;

interface NormalizedEngineOptions {
  readonly maxCommitCount: number;
  readonly maxRowCount: number;
  readonly maxMetricsCacheEntries: number;
  readonly colorCount: number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
}

function normalizeEngineOptions(
  options: GraphEngineOptions,
): NormalizedEngineOptions {
  const normalizedOptions = {
    maxCommitCount:
      options.maxCommitCount ?? defaultGraphEngineOptions.maxCommitCount,
    maxRowCount: options.maxRowCount ?? defaultGraphEngineOptions.maxRowCount,
    maxMetricsCacheEntries:
      options.maxMetricsCacheEntries ??
      defaultGraphEngineOptions.maxMetricsCacheEntries,
    colorCount: options.colorCount ?? defaultGraphEngineOptions.colorCount,
  };
  assertPositiveInteger(normalizedOptions.maxCommitCount, "maxCommitCount");
  assertPositiveInteger(normalizedOptions.maxRowCount, "maxRowCount");
  assertPositiveInteger(
    normalizedOptions.maxMetricsCacheEntries,
    "maxMetricsCacheEntries",
  );
  assertPositiveInteger(normalizedOptions.colorCount, "colorCount");
  return normalizedOptions;
}

function normalizeCommitRecord(commit: GraphCommitRecord): GraphCommitRecord {
  if (commit.sha.trim().length === 0 || commit.sha.includes("\0"))
    throw new Error(`Invalid commit identity: ${commit.sha}`);
  return {
    sha: commit.sha,
    parents: [
      ...new Set(commit.parents.filter((parentSha) => parentSha.length > 0)),
    ],
    ...(commit.subject === undefined ? {} : { subject: commit.subject }),
    ...(commit.authorName === undefined
      ? {}
      : { authorName: commit.authorName }),
    ...(commit.authorEmail === undefined
      ? {}
      : { authorEmail: commit.authorEmail }),
    ...(commit.authorDate === undefined
      ? {}
      : { authorDate: commit.authorDate }),
    ...(commit.commitDate === undefined
      ? {}
      : { commitDate: commit.commitDate }),
  };
}

function normalizeReference(reference: GraphReference): GraphReference {
  if (reference.name.trim().length === 0)
    throw new Error("Graph references require a name.");
  if (
    reference.targetSha.trim().length === 0 ||
    reference.targetSha.includes("\0")
  )
    throw new Error(`Invalid reference target SHA: ${reference.targetSha}`);
  return {
    name: reference.name,
    targetSha: reference.targetSha,
    kind: classifyGraphReference(reference),
    ...(reference.isHead === true ? { isHead: true } : {}),
    ...(reference.upstreamRefName === undefined
      ? {}
      : { upstreamRefName: reference.upstreamRefName }),
  };
}

function normalizeSnapshot(
  snapshot: GraphRepositorySnapshot,
  options: NormalizedEngineOptions,
): GraphRepositorySnapshot {
  const commits = snapshot.commits
    .slice(0, options.maxCommitCount)
    .map(normalizeCommitRecord);
  const references = (snapshot.references ?? []).map(normalizeReference);
  const worktrees = (snapshot.worktrees ?? []).map((worktree) => ({
    ...worktree,
    ...(worktree.branchRefName === undefined
      ? {}
      : { branchRefName: worktree.branchRefName }),
  }));
  return {
    commits,
    ...(snapshot.truncated === true ? { truncated: true } : {}),
    references,
    worktrees,
    ...(snapshot.workingTree === undefined
      ? {}
      : { workingTree: snapshot.workingTree }),
  };
}

function createSnapshotKey(
  snapshot: GraphRepositorySnapshot,
  options: Pick<NormalizedEngineOptions, "colorCount">,
): string {
  let hash = 2_166_136_261;
  const appendFingerprintPart = (part: string): void => {
    for (
      let characterIndex = 0;
      characterIndex < part.length;
      characterIndex += 1
    ) {
      hash ^= part.charCodeAt(characterIndex);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16_777_619);
  };
  appendFingerprintPart(`color:${options.colorCount}`);
  for (const commit of snapshot.commits) {
    appendFingerprintPart(`commit:${commit.sha}`);
    appendFingerprintPart(`parents:${commit.parents.join(",")}`);
    appendFingerprintPart(`subject:${commit.subject ?? ""}`);
    appendFingerprintPart(
      `author:${commit.authorName ?? ""}:${commit.authorEmail ?? ""}`,
    );
    appendFingerprintPart(
      `dates:${commit.authorDate ?? ""}:${commit.commitDate ?? ""}`,
    );
  }
  for (const reference of [...(snapshot.references ?? [])].sort(
    (leftReference, rightReference) =>
      leftReference.name.localeCompare(rightReference.name),
  )) {
    appendFingerprintPart(
      `reference:${reference.name}:${reference.targetSha}:${reference.kind ?? ""}:${reference.isHead === true}:${reference.upstreamRefName ?? ""}`,
    );
  }
  for (const worktree of [...(snapshot.worktrees ?? [])].sort(
    (leftWorktree, rightWorktree) =>
      leftWorktree.path.localeCompare(rightWorktree.path),
  )) {
    appendFingerprintPart(
      `worktree:${worktree.path}:${worktree.headSha}:${worktree.branchRefName ?? ""}:${worktree.isPrimary === true}:${worktree.isLocked === true}:${worktree.isPrunable === true}`,
    );
  }
  const workingTree = snapshot.workingTree;
  appendFingerprintPart(
    `working-tree:${workingTree?.stagedChangeCount ?? 0}:${workingTree?.unstagedChangeCount ?? 0}:${workingTree?.untrackedChangeCount ?? 0}:${workingTree?.label ?? ""}:${snapshot.truncated === true}`,
  );
  return `${snapshot.commits.length}:${hash >>> 0}`;
}

function createQuerySnapshotKey(
  snapshotKey: string,
  options: Pick<
    GraphQueryOptions,
    "filter" | "includeWip" | "includeWorktrees"
  > & {
    readonly maxRows: number;
  },
): string {
  const filter = options.filter ?? {};
  return `${snapshotKey}:rows=${options.maxRows}:wip=${options.includeWip === true}:worktrees=${options.includeWorktrees === true}:filter=${JSON.stringify(
    {
      scope: filter.scope,
      text: filter.text,
      authorEmail: filter.authorEmail,
      authorName: filter.authorName,
      commitShas:
        filter.commitShas === undefined
          ? undefined
          : [...filter.commitShas].sort(),
      referenceNames:
        filter.referenceNames === undefined
          ? undefined
          : [...filter.referenceNames].sort(),
      since: filter.since,
      until: filter.until,
    },
  )}`;
}

function parseCursor(
  cursor: GraphCursor | string | undefined,
  snapshotKey: string,
): number {
  if (cursor === undefined) return 0;
  const parsedCursor =
    typeof cursor === "string" ? decodeGraphCursor(cursor) : cursor;
  if (parsedCursor.snapshotKey !== snapshotKey)
    throw new Error("Graph cursor belongs to a different repository snapshot.");
  assertNonNegativeInteger(parsedCursor.rowOffset, "cursor.rowOffset");
  return parsedCursor.rowOffset;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer.`);
}

export function encodeGraphCursor(cursor: GraphCursor): string {
  return `${encodeURIComponent(cursor.snapshotKey)}:${cursor.rowOffset}`;
}

export function decodeGraphCursor(encodedCursor: string): GraphCursor {
  const separatorIndex = encodedCursor.lastIndexOf(":");
  if (separatorIndex < 1) throw new Error("Invalid graph cursor.");
  const snapshotKey = decodeURIComponent(
    encodedCursor.slice(0, separatorIndex),
  );
  const rowOffset = Number(encodedCursor.slice(separatorIndex + 1));
  assertNonNegativeInteger(rowOffset, "cursor.rowOffset");
  return { snapshotKey, rowOffset };
}

function normalizeSearchText(searchText: string | undefined): string {
  return searchText?.trim().toLocaleLowerCase() ?? "";
}

function getReachableCommitShas(
  startingShas: readonly string[],
  commitBySha: ReadonlyMap<string, GraphCommitRecord>,
): ReadonlySet<string> {
  const reachableShas = new Set<string>();
  const pendingShas = [...startingShas];
  while (pendingShas.length > 0) {
    const sha = pendingShas.pop();
    if (sha === undefined || reachableShas.has(sha)) continue;
    reachableShas.add(sha);
    const commit = commitBySha.get(sha);
    if (commit !== undefined) pendingShas.push(...commit.parents);
  }
  return reachableShas;
}

function getScopeStartingShas(
  scope: GraphScope,
  references: readonly GraphReference[],
  worktrees: readonly { readonly headSha: string }[],
): readonly string[] {
  if (scope === "worktrees")
    return worktrees.map((worktree) => worktree.headSha);
  return references
    .filter((reference) => {
      const kind = classifyGraphReference(reference);
      if (scope === "current")
        return reference.isHead === true || kind === "head";
      if (scope === "local") return kind === "head" || kind === "local";
      if (scope === "remote") return kind === "remote";
      if (scope === "tags") return kind === "tag";
      if (scope === "stashes") return kind === "stash";
      return true;
    })
    .map((reference) => reference.targetSha);
}

function commitMatchesFilter(
  commit: GraphCommitRecord,
  references: readonly GraphReference[],
  filter: GraphFilter | undefined,
  scopeReachableShas: ReadonlySet<string> | undefined,
): boolean {
  if (scopeReachableShas !== undefined && !scopeReachableShas.has(commit.sha))
    return false;
  if (filter === undefined) return true;
  const normalizedText = normalizeSearchText(filter.text);
  if (normalizedText.length > 0) {
    const searchableFields = [
      commit.sha,
      commit.subject ?? "",
      commit.authorName ?? "",
      commit.authorEmail ?? "",
      ...references.map((reference) => reference.name),
    ];
    if (
      !searchableFields.some((field) =>
        field.toLocaleLowerCase().includes(normalizedText),
      )
    )
      return false;
  }
  if (
    filter.authorEmail !== undefined &&
    commit.authorEmail?.toLocaleLowerCase() !==
      filter.authorEmail.toLocaleLowerCase()
  )
    return false;
  if (
    filter.authorName !== undefined &&
    commit.authorName?.toLocaleLowerCase() !==
      filter.authorName.toLocaleLowerCase()
  )
    return false;
  if (
    filter.commitShas !== undefined &&
    !filter.commitShas.includes(commit.sha)
  )
    return false;
  if (
    filter.referenceNames !== undefined &&
    !references.some((reference) =>
      filter.referenceNames?.includes(reference.name),
    )
  )
    return false;
  if (
    filter.since !== undefined &&
    commit.commitDate !== undefined &&
    commit.commitDate < filter.since
  )
    return false;
  if (
    filter.until !== undefined &&
    commit.commitDate !== undefined &&
    commit.commitDate > filter.until
  )
    return false;
  return true;
}

function buildGraphCommitRow(
  layoutRow: GraphLayoutCommitRow,
  rowIndex: number,
): GraphCommitRow {
  const commit = layoutRow.commit;
  return {
    kind: "commit",
    rowIndex,
    commitSha: commit.sha,
    parents: commit.parents,
    lanes: layoutRow.lanes,
    nextLanes: layoutRow.nextLanes,
    edges: layoutRow.edges,
    references: layoutRow.references,
    ...(commit.subject === undefined ? {} : { subject: commit.subject }),
    ...(commit.authorName === undefined
      ? {}
      : { authorName: commit.authorName }),
    ...(commit.authorEmail === undefined
      ? {}
      : { authorEmail: commit.authorEmail }),
    ...(commit.authorDate === undefined
      ? {}
      : { authorDate: commit.authorDate }),
    ...(commit.commitDate === undefined
      ? {}
      : { commitDate: commit.commitDate }),
  };
}

function makeWipRow(
  workingTree: NonNullable<GraphRepositorySnapshot["workingTree"]>,
  rowIndex: number,
): GraphWipRow {
  return {
    kind: "wip",
    rowIndex,
    label: workingTree.label ?? "Working tree",
    stagedChangeCount: workingTree.stagedChangeCount ?? 0,
    unstagedChangeCount: workingTree.unstagedChangeCount ?? 0,
    untrackedChangeCount: workingTree.untrackedChangeCount ?? 0,
    lanes: [],
  };
}

function makeWorktreeRow(
  worktree: NonNullable<GraphRepositorySnapshot["worktrees"]>[number],
  rowIndex: number,
  anchorLayoutRow: GraphLayoutCommitRow | undefined,
): GraphWorktreeRow {
  return {
    kind: "worktree",
    rowIndex,
    worktree,
    ...(anchorLayoutRow === undefined
      ? {}
      : { anchorCommitSha: anchorLayoutRow.commit.sha }),
    lanes: anchorLayoutRow?.lanes ?? [],
  };
}

function indexWorktreesByHeadSha(
  worktrees: readonly GraphWorktree[],
  includeWorktrees: boolean,
): ReadonlyMap<string, readonly GraphWorktree[]> {
  if (!includeWorktrees) return new Map();
  const worktreesByHeadSha = new Map<string, GraphWorktree[]>();
  for (const worktree of worktrees) {
    const matchingWorktrees = worktreesByHeadSha.get(worktree.headSha) ?? [];
    matchingWorktrees.push(worktree);
    worktreesByHeadSha.set(worktree.headSha, matchingWorktrees);
  }
  return worktreesByHeadSha;
}

interface MatchingGraphRowCount {
  readonly boundedCount: number;
  readonly exceedsMaximum: boolean;
  /** Sparse visible-row checkpoints used to locate a deep page. */
  readonly matchingRowCheckpoints: readonly MatchingRowCheckpoint[];
}

interface MatchingRowCheckpoint {
  /** Commit index at or before the checkpoint's visible row. */
  readonly commitIndex: number;
  /** Absolute first visible row contributed by this commit. */
  readonly rowStart: number;
}

function countMatchingGraphRows(
  commits: readonly GraphCommitRecord[],
  referencesByCommitSha: ReadonlyMap<string, readonly GraphReference[]>,
  worktreesByHeadSha: ReadonlyMap<string, readonly GraphWorktree[]>,
  filter: GraphFilter | undefined,
  scopeReachableShas: ReadonlySet<string> | undefined,
  workingTree: GraphRepositorySnapshot["workingTree"],
  includeWip: boolean,
  maximumRows: number,
): MatchingGraphRowCount {
  let matchingRowCount = includeWip && workingTree !== undefined ? 1 : 0;
  const matchingRowCheckpoints: MatchingRowCheckpoint[] = [];
  let nextCheckpointRow = matchingRowCount;
  let nextCheckpointCommit = 0;
  for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
    const commit = commits[commitIndex];
    if (commit === undefined) continue;
    if (
      matchingRowCheckpoints.length === 0 ||
      matchingRowCount >= nextCheckpointRow ||
      commitIndex >= nextCheckpointCommit
    ) {
      matchingRowCheckpoints.push({
        commitIndex,
        rowStart: matchingRowCount,
      });
      while (nextCheckpointRow <= matchingRowCount)
        nextCheckpointRow += matchingRowCheckpointInterval;
      while (nextCheckpointCommit <= commitIndex)
        nextCheckpointCommit += matchingRowCheckpointInterval;
    }
    if (
      !commitMatchesFilter(
        commit,
        referencesByCommitSha.get(commit.sha) ?? [],
        filter,
        scopeReachableShas,
      )
    )
      continue;
    const commitRowCount =
      (worktreesByHeadSha.get(commit.sha)?.length ?? 0) + 1;
    matchingRowCount += commitRowCount;
    if (matchingRowCount > maximumRows) {
      return {
        boundedCount: maximumRows,
        exceedsMaximum: true,
        matchingRowCheckpoints,
      };
    }
  }
  return {
    boundedCount: matchingRowCount,
    exceedsMaximum: false,
    matchingRowCheckpoints,
  };
}

async function countMatchingGraphRowsAsync(
  commits: readonly GraphCommitRecord[],
  referencesByCommitSha: ReadonlyMap<string, readonly GraphReference[]>,
  worktreesByHeadSha: ReadonlyMap<string, readonly GraphWorktree[]>,
  filter: GraphFilter | undefined,
  scopeReachableShas: ReadonlySet<string> | undefined,
  workingTree: GraphRepositorySnapshot["workingTree"],
  includeWip: boolean,
  maximumRows: number,
  cancellationSignal: AbortSignal | undefined,
  asyncOptions: GraphLayoutAsyncOptions,
): Promise<MatchingGraphRowCount> {
  const chunkSize = asyncOptions.chunkSize ?? 256;
  if (!Number.isInteger(chunkSize) || chunkSize < 1)
    throw new Error("chunkSize must be a positive integer.");
  const yieldControl = asyncOptions.yieldControl ?? yieldToEventLoop;
  let matchingRowCount = includeWip && workingTree !== undefined ? 1 : 0;
  const matchingRowCheckpoints: MatchingRowCheckpoint[] = [];
  let nextCheckpointRow = matchingRowCount;
  let nextCheckpointCommit = 0;
  for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
    if (commitIndex % chunkSize === 0) {
      throwIfGraphLayoutCancelled(cancellationSignal);
      if (commitIndex > 0) await yieldControl();
    }
    const commit = commits[commitIndex];
    if (commit === undefined) continue;
    if (
      matchingRowCheckpoints.length === 0 ||
      matchingRowCount >= nextCheckpointRow ||
      commitIndex >= nextCheckpointCommit
    ) {
      matchingRowCheckpoints.push({
        commitIndex,
        rowStart: matchingRowCount,
      });
      while (nextCheckpointRow <= matchingRowCount)
        nextCheckpointRow += matchingRowCheckpointInterval;
      while (nextCheckpointCommit <= commitIndex)
        nextCheckpointCommit += matchingRowCheckpointInterval;
    }
    if (
      !commitMatchesFilter(
        commit,
        referencesByCommitSha.get(commit.sha) ?? [],
        filter,
        scopeReachableShas,
      )
    )
      continue;
    const commitRowCount =
      (worktreesByHeadSha.get(commit.sha)?.length ?? 0) + 1;
    matchingRowCount += commitRowCount;
    if (matchingRowCount > maximumRows) {
      return {
        boundedCount: maximumRows,
        exceedsMaximum: true,
        matchingRowCheckpoints,
      };
    }
  }
  throwIfGraphLayoutCancelled(cancellationSignal);
  return {
    boundedCount: matchingRowCount,
    exceedsMaximum: false,
    matchingRowCheckpoints,
  };
}

function findMatchingRowCheckpoint(
  matchingRowCount: MatchingGraphRowCount,
  pageOffset: number,
  commitCount: number,
): MatchingRowCheckpoint {
  const checkpoints = matchingRowCount.matchingRowCheckpoints;
  if (checkpoints.length === 0 || pageOffset >= matchingRowCount.boundedCount)
    return { commitIndex: commitCount, rowStart: pageOffset };
  let lowerBound = 0;
  let upperBound = checkpoints.length;
  while (lowerBound < upperBound) {
    const middleIndex = Math.floor((lowerBound + upperBound) / 2);
    const rowStart = checkpoints[middleIndex]?.rowStart ?? 0;
    if (rowStart <= pageOffset) lowerBound = middleIndex + 1;
    else upperBound = middleIndex;
  }
  let checkpointIndex = Math.max(0, lowerBound - 1);
  const checkpointRowStart = checkpoints[checkpointIndex]?.rowStart;
  while (
    checkpointIndex > 0 &&
    checkpoints[checkpointIndex - 1]?.rowStart === checkpointRowStart
  ) {
    checkpointIndex -= 1;
  }
  return (
    checkpoints[checkpointIndex] ?? {
      commitIndex: commitCount,
      rowStart: pageOffset,
    }
  );
}

function countVisibleGraphRows(
  commits: readonly GraphCommitRecord[],
  referencesByCommitSha: ReadonlyMap<string, readonly GraphReference[]>,
  worktreesByHeadSha: ReadonlyMap<string, readonly GraphWorktree[]>,
  filter: GraphFilter | undefined,
  scopeReachableShas: ReadonlySet<string> | undefined,
  workingTree: GraphRepositorySnapshot["workingTree"],
  includeWip: boolean,
): number {
  let visibleRowCount = includeWip && workingTree !== undefined ? 1 : 0;
  for (const commit of commits) {
    if (
      commitMatchesFilter(
        commit,
        referencesByCommitSha.get(commit.sha) ?? [],
        filter,
        scopeReachableShas,
      )
    ) {
      visibleRowCount += (worktreesByHeadSha.get(commit.sha)?.length ?? 0) + 1;
    }
  }
  return visibleRowCount;
}

async function countVisibleGraphRowsAsync(
  commits: readonly GraphCommitRecord[],
  referencesByCommitSha: ReadonlyMap<string, readonly GraphReference[]>,
  worktreesByHeadSha: ReadonlyMap<string, readonly GraphWorktree[]>,
  filter: GraphFilter | undefined,
  scopeReachableShas: ReadonlySet<string> | undefined,
  workingTree: GraphRepositorySnapshot["workingTree"],
  includeWip: boolean,
  cancellationSignal: AbortSignal | undefined,
  asyncOptions: GraphLayoutAsyncOptions,
): Promise<number> {
  const chunkSize = asyncOptions.chunkSize ?? 256;
  if (!Number.isInteger(chunkSize) || chunkSize < 1)
    throw new Error("chunkSize must be a positive integer.");
  const yieldControl = asyncOptions.yieldControl ?? yieldToEventLoop;
  let visibleRowCount = includeWip && workingTree !== undefined ? 1 : 0;
  for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
    if (commitIndex % chunkSize === 0) {
      throwIfGraphLayoutCancelled(cancellationSignal);
      if (commitIndex > 0) await yieldControl();
    }
    const commit = commits[commitIndex];
    if (
      commit !== undefined &&
      commitMatchesFilter(
        commit,
        referencesByCommitSha.get(commit.sha) ?? [],
        filter,
        scopeReachableShas,
      )
    ) {
      visibleRowCount += (worktreesByHeadSha.get(commit.sha)?.length ?? 0) + 1;
    }
  }
  throwIfGraphLayoutCancelled(cancellationSignal);
  return visibleRowCount;
}

interface MutableGraphMinimapBucket {
  readonly bucketIndex: number;
  readonly startRow: number;
  readonly endRow: number;
  commitCount: number;
  mergeCount: number;
  referenceCount: number;
  readonly colorCounts: number[];
}

function createGraphMinimapBuckets(
  bucketCount: number,
  visibleRowCount: number,
  colorCount: number,
): MutableGraphMinimapBucket[] {
  const boundedBucketCount = Math.min(bucketCount, visibleRowCount);
  const rowsPerBucket = Math.ceil(visibleRowCount / boundedBucketCount);
  return Array.from({ length: boundedBucketCount }, (_, bucketIndex) => {
    const startRow = bucketIndex * rowsPerBucket;
    const endRow = Math.min(startRow + rowsPerBucket, visibleRowCount) - 1;
    return {
      bucketIndex,
      startRow,
      endRow,
      commitCount: 0,
      mergeCount: 0,
      referenceCount: 0,
      colorCounts: Array<number>(colorCount).fill(0),
    };
  });
}

function toGraphMinimapBuckets(
  buckets: readonly MutableGraphMinimapBucket[],
): readonly GraphMinimapBucket[] {
  return buckets.map((bucket) => ({
    bucketIndex: bucket.bucketIndex,
    startRow: bucket.startRow,
    endRow: bucket.endRow,
    commitCount: bucket.commitCount,
    mergeCount: bucket.mergeCount,
    referenceCount: bucket.referenceCount,
    colorCounts: bucket.colorCounts,
  }));
}

interface AncestorDistanceResult {
  readonly distances: ReadonlyMap<string, number>;
  /** False when a parent or starting revision is absent from the snapshot. */
  readonly complete: boolean;
}

function getAncestorDistanceMap(
  startingSha: string,
  commitBySha: ReadonlyMap<string, GraphCommitRecord>,
): AncestorDistanceResult {
  const distances = new Map<string, number>([[startingSha, 0]]);
  const pendingShas = [startingSha];
  let complete = commitBySha.has(startingSha);
  for (
    let pendingIndex = 0;
    pendingIndex < pendingShas.length;
    pendingIndex += 1
  ) {
    const currentSha = pendingShas[pendingIndex];
    if (currentSha === undefined) continue;
    const currentCommit = commitBySha.get(currentSha);
    if (currentCommit === undefined) {
      complete = false;
      continue;
    }
    const currentDistance = distances.get(currentSha) ?? 0;
    for (const parentSha of currentCommit.parents) {
      if (distances.has(parentSha)) continue;
      distances.set(parentSha, currentDistance + 1);
      pendingShas.push(parentSha);
    }
  }
  return { distances, complete };
}

/**
 * Returns Git's best common-ancestor set. A common ancestor is discarded when
 * another common ancestor is its descendant; this matters for criss-cross
 * histories where more than one merge base is valid. The remaining candidates
 * retain deterministic first-side traversal order; callers must not treat the
 * first candidate as Git's only valid answer when the set has multiple items.
 */
function getMergeBaseCandidates(
  firstSha: string,
  secondSha: string,
  commitBySha: ReadonlyMap<string, GraphCommitRecord>,
): readonly string[] | undefined {
  const firstResult = getAncestorDistanceMap(firstSha, commitBySha);
  const secondResult = getAncestorDistanceMap(secondSha, commitBySha);
  return selectMergeBaseCandidates(firstResult, secondResult, commitBySha);
}

function selectMergeBaseCandidates(
  firstResult: AncestorDistanceResult,
  secondResult: AncestorDistanceResult,
  commitBySha: ReadonlyMap<string, GraphCommitRecord>,
): readonly string[] | undefined {
  if (!firstResult.complete || !secondResult.complete) return undefined;
  const commonAncestorShas = [...firstResult.distances.keys()].filter(
    (candidateSha) => secondResult.distances.has(candidateSha),
  );
  const commonAncestorSet = new Set(commonAncestorShas);
  const dominatedAncestorShas = new Set<string>();
  for (const candidateSha of commonAncestorShas) {
    for (const parentSha of commitBySha.get(candidateSha)?.parents ?? []) {
      if (commonAncestorSet.has(parentSha))
        dominatedAncestorShas.add(parentSha);
    }
  }
  return commonAncestorShas.filter(
    (candidateSha) => !dominatedAncestorShas.has(candidateSha),
  );
}

export class CommitGraphQueryEngine {
  private readonly normalizedOptions: NormalizedEngineOptions;
  private readonly normalizedSnapshot: GraphRepositorySnapshot;
  private readonly snapshotCommitTruncated: boolean;
  private readonly snapshotKey: string;
  private readonly commitBySha: ReadonlyMap<string, GraphCommitRecord>;
  private readonly referenceByName: ReadonlyMap<string, GraphReference>;
  private readonly referencesByCommitSha: ReadonlyMap<
    string,
    readonly GraphReference[]
  >;
  private readonly metricsLoader?: GraphEngineOptions["metricsLoader"];
  private readonly changedLineMetricsBySha = new Map<
    string,
    ChangedLineMetrics
  >();
  /** Visible-row descriptors are shared across cursor pages and bounded. */
  private readonly matchingRowCountCache = new Map<
    string,
    MatchingGraphRowCount
  >();
  private readonly layoutLifecycleAbortController: AbortController;
  private readonly incrementalLayoutBuilder: IncrementalGraphLayoutBuilder;

  public constructor(
    snapshot: GraphRepositorySnapshot,
    options: GraphEngineOptions = {},
  ) {
    this.normalizedOptions = normalizeEngineOptions(options);
    this.layoutLifecycleAbortController = new AbortController();
    if (options.lifecycleSignal !== undefined) {
      if (options.lifecycleSignal.aborted)
        this.layoutLifecycleAbortController.abort();
      else
        options.lifecycleSignal.addEventListener(
          "abort",
          () => this.layoutLifecycleAbortController.abort(),
          { once: true },
        );
    }
    this.snapshotCommitTruncated =
      snapshot.truncated === true ||
      snapshot.commits.length > this.normalizedOptions.maxCommitCount;
    this.normalizedSnapshot = normalizeSnapshot(
      snapshot,
      this.normalizedOptions,
    );
    this.snapshotKey = createSnapshotKey(
      this.normalizedSnapshot,
      this.normalizedOptions,
    );
    this.commitBySha = new Map(
      this.normalizedSnapshot.commits.map((commit) => [commit.sha, commit]),
    );
    this.referenceByName = new Map(
      (this.normalizedSnapshot.references ?? []).map((reference) => [
        reference.name,
        reference,
      ]),
    );
    const referencesByCommitSha = new Map<string, GraphReference[]>();
    for (const reference of this.normalizedSnapshot.references ?? []) {
      const commitReferences =
        referencesByCommitSha.get(reference.targetSha) ?? [];
      commitReferences.push(reference);
      referencesByCommitSha.set(reference.targetSha, commitReferences);
    }
    this.referencesByCommitSha = referencesByCommitSha;
    this.metricsLoader = options.metricsLoader;
    this.incrementalLayoutBuilder = new IncrementalGraphLayoutBuilder(
      this.normalizedSnapshot.commits,
      this.normalizedSnapshot.references ?? [],
      this.normalizedOptions,
    );
  }

  public get snapshot(): GraphRepositorySnapshot {
    return this.normalizedSnapshot;
  }

  private getMatchingRowCount(
    querySnapshotKey: string,
    worktreesByHeadSha: ReadonlyMap<string, readonly GraphWorktree[]>,
    filter: GraphFilter | undefined,
    scopeReachableShas: ReadonlySet<string> | undefined,
    includeWip: boolean,
    maximumRows: number,
  ): MatchingGraphRowCount {
    const cachedCount = this.matchingRowCountCache.get(querySnapshotKey);
    if (cachedCount !== undefined) {
      this.matchingRowCountCache.delete(querySnapshotKey);
      this.matchingRowCountCache.set(querySnapshotKey, cachedCount);
      return cachedCount;
    }
    const matchingRowCount = countMatchingGraphRows(
      this.normalizedSnapshot.commits,
      this.referencesByCommitSha,
      worktreesByHeadSha,
      filter,
      scopeReachableShas,
      this.normalizedSnapshot.workingTree,
      includeWip,
      maximumRows,
    );
    this.cacheMatchingRowCount(querySnapshotKey, matchingRowCount);
    return matchingRowCount;
  }

  private async getMatchingRowCountAsync(
    querySnapshotKey: string,
    worktreesByHeadSha: ReadonlyMap<string, readonly GraphWorktree[]>,
    filter: GraphFilter | undefined,
    scopeReachableShas: ReadonlySet<string> | undefined,
    includeWip: boolean,
    maximumRows: number,
    cancellationSignal: AbortSignal | undefined,
    asyncOptions: GraphLayoutAsyncOptions,
  ): Promise<MatchingGraphRowCount> {
    const cachedCount = this.matchingRowCountCache.get(querySnapshotKey);
    if (cachedCount !== undefined) {
      this.matchingRowCountCache.delete(querySnapshotKey);
      this.matchingRowCountCache.set(querySnapshotKey, cachedCount);
      return cachedCount;
    }
    const matchingRowCount = await countMatchingGraphRowsAsync(
      this.normalizedSnapshot.commits,
      this.referencesByCommitSha,
      worktreesByHeadSha,
      filter,
      scopeReachableShas,
      this.normalizedSnapshot.workingTree,
      includeWip,
      maximumRows,
      cancellationSignal,
      asyncOptions,
    );
    this.cacheMatchingRowCount(querySnapshotKey, matchingRowCount);
    return matchingRowCount;
  }

  private cacheMatchingRowCount(
    querySnapshotKey: string,
    matchingRowCount: MatchingGraphRowCount,
  ): void {
    this.matchingRowCountCache.delete(querySnapshotKey);
    this.matchingRowCountCache.set(querySnapshotKey, matchingRowCount);
    while (this.matchingRowCountCache.size > maximumCachedMatchingQueries) {
      const oldestQueryKey = this.matchingRowCountCache.keys().next().value;
      if (oldestQueryKey === undefined) break;
      this.matchingRowCountCache.delete(oldestQueryKey);
    }
  }

  public query(options: GraphQueryOptions = {}): GraphPage {
    const filter = options.filter;
    const scopeReachableShas =
      filter?.scope === undefined || filter.scope === "all"
        ? undefined
        : getReachableCommitShas(
            getScopeStartingShas(
              filter.scope,
              this.normalizedSnapshot.references ?? [],
              this.normalizedSnapshot.worktrees ?? [],
            ),
            this.commitBySha,
          );
    const requestedPageSize = options.pageSize ?? defaultPageSize;
    assertPositiveInteger(requestedPageSize, "pageSize");
    const maximumRows = Math.min(
      options.maxRows ?? this.normalizedOptions.maxRowCount,
      this.normalizedOptions.maxRowCount,
    );
    assertPositiveInteger(maximumRows, "maxRows");
    const includeWorktrees = options.includeWorktrees === true;
    const querySnapshotKey = createQuerySnapshotKey(this.snapshotKey, {
      ...options,
      maxRows: maximumRows,
    });
    const pageOffset = parseCursor(options.cursor, querySnapshotKey);
    const worktreesByHeadSha = indexWorktreesByHeadSha(
      this.normalizedSnapshot.worktrees ?? [],
      includeWorktrees,
    );
    const matchingRowCount = this.getMatchingRowCount(
      querySnapshotKey,
      worktreesByHeadSha,
      filter,
      scopeReachableShas,
      options.includeWip === true,
      maximumRows,
    );
    const pageEnd = Math.min(maximumRows, pageOffset + requestedPageSize);
    const pageRows: GraphRow[] = [];
    let matchingRowIndex = 0;
    if (
      options.includeWip === true &&
      this.normalizedSnapshot.workingTree !== undefined
    ) {
      if (matchingRowIndex >= pageOffset && matchingRowIndex < pageEnd)
        pageRows.push(makeWipRow(this.normalizedSnapshot.workingTree, 0));
      matchingRowIndex += 1;
    }
    const matchingRowCheckpoint = findMatchingRowCheckpoint(
      matchingRowCount,
      pageOffset,
      this.normalizedSnapshot.commits.length,
    );
    matchingRowIndex = matchingRowCheckpoint.rowStart;
    for (
      let layoutIndex = matchingRowCheckpoint.commitIndex;
      layoutIndex < this.normalizedSnapshot.commits.length &&
      matchingRowIndex < pageEnd;
      layoutIndex += 1
    ) {
      const commit = this.normalizedSnapshot.commits[layoutIndex];
      if (
        commit === undefined ||
        !commitMatchesFilter(
          commit,
          this.referencesByCommitSha.get(commit.sha) ?? [],
          filter,
          scopeReachableShas,
        )
      )
        continue;
      const layoutRow = this.incrementalLayoutBuilder.ensureRowAt(
        layoutIndex,
        options.cancellationSignal,
      );
      if (layoutRow === undefined) continue;
      for (const worktree of worktreesByHeadSha.get(layoutRow.commit.sha) ??
        []) {
        const rowIndex = matchingRowIndex;
        matchingRowIndex += 1;
        if (rowIndex >= pageOffset && rowIndex < pageEnd)
          pageRows.push(makeWorktreeRow(worktree, rowIndex, layoutRow));
      }
      const commitRowIndex = matchingRowIndex;
      matchingRowIndex += 1;
      if (commitRowIndex >= pageOffset && commitRowIndex < pageEnd)
        pageRows.push(buildGraphCommitRow(layoutRow, commitRowIndex));
    }
    const boundedRowCount = matchingRowCount.boundedCount;
    const nextRowOffset = pageOffset + pageRows.length;
    const hasMore = nextRowOffset < boundedRowCount;
    const nextCursor = hasMore
      ? { snapshotKey: querySnapshotKey, rowOffset: nextRowOffset }
      : undefined;
    return {
      rows: pageRows,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      hasMore,
      totalRows: boundedRowCount,
      totalCommits: this.normalizedSnapshot.commits.length,
      truncated:
        this.snapshotCommitTruncated ||
        this.incrementalLayoutBuilder.truncated ||
        matchingRowCount.exceedsMaximum,
      snapshotKey: querySnapshotKey,
    };
  }

  /**
   * Paged query for the extension-host runtime. Layout and row filtering yield
   * between bounded chunks, allowing cancellation and other host events to run
   * while a large repository is being prepared.
   */
  public async queryAsync(
    options: GraphQueryOptions = {},
    asyncOptions: GraphLayoutAsyncOptions = {},
  ): Promise<GraphPage> {
    const filter = options.filter;
    const scopeReachableShas =
      filter?.scope === undefined || filter.scope === "all"
        ? undefined
        : await getReachableCommitShasAsync(
            getScopeStartingShas(
              filter.scope,
              this.normalizedSnapshot.references ?? [],
              this.normalizedSnapshot.worktrees ?? [],
            ),
            this.commitBySha,
            options.cancellationSignal,
            asyncOptions,
          );
    const includeWorktrees = options.includeWorktrees === true;
    const requestedPageSize = options.pageSize ?? defaultPageSize;
    assertPositiveInteger(requestedPageSize, "pageSize");
    const maximumRows = Math.min(
      options.maxRows ?? this.normalizedOptions.maxRowCount,
      this.normalizedOptions.maxRowCount,
    );
    assertPositiveInteger(maximumRows, "maxRows");
    const querySnapshotKey = createQuerySnapshotKey(this.snapshotKey, {
      ...options,
      maxRows: maximumRows,
    });
    const pageOffset = parseCursor(options.cursor, querySnapshotKey);
    const worktreesByHeadSha = indexWorktreesByHeadSha(
      this.normalizedSnapshot.worktrees ?? [],
      includeWorktrees,
    );
    const matchingRowCount = await this.getMatchingRowCountAsync(
      querySnapshotKey,
      worktreesByHeadSha,
      filter,
      scopeReachableShas,
      options.includeWip === true,
      maximumRows,
      options.cancellationSignal,
      asyncOptions,
    );
    const pageEnd = Math.min(maximumRows, pageOffset + requestedPageSize);
    const pageRows: GraphRow[] = [];
    let matchingRowIndex = 0;
    if (
      options.includeWip === true &&
      this.normalizedSnapshot.workingTree !== undefined
    ) {
      if (matchingRowIndex >= pageOffset && matchingRowIndex < pageEnd)
        pageRows.push(makeWipRow(this.normalizedSnapshot.workingTree, 0));
      matchingRowIndex += 1;
    }
    const matchingRowCheckpoint = findMatchingRowCheckpoint(
      matchingRowCount,
      pageOffset,
      this.normalizedSnapshot.commits.length,
    );
    matchingRowIndex = matchingRowCheckpoint.rowStart;
    for (
      let layoutIndex = matchingRowCheckpoint.commitIndex;
      layoutIndex < this.normalizedSnapshot.commits.length &&
      matchingRowIndex < pageEnd;
      layoutIndex += 1
    ) {
      const commit = this.normalizedSnapshot.commits[layoutIndex];
      if (
        commit === undefined ||
        !commitMatchesFilter(
          commit,
          this.referencesByCommitSha.get(commit.sha) ?? [],
          filter,
          scopeReachableShas,
        )
      )
        continue;
      const layoutRow = await awaitWithGraphCancellation(
        this.incrementalLayoutBuilder.ensureRowAtAsync(
          layoutIndex,
          this.layoutLifecycleAbortController.signal,
          asyncOptions,
        ),
        options.cancellationSignal,
      );
      if (layoutRow === undefined) continue;
      for (const worktree of worktreesByHeadSha.get(layoutRow.commit.sha) ??
        []) {
        const rowIndex = matchingRowIndex;
        matchingRowIndex += 1;
        if (rowIndex >= pageOffset && rowIndex < pageEnd)
          pageRows.push(makeWorktreeRow(worktree, rowIndex, layoutRow));
      }
      const commitRowIndex = matchingRowIndex;
      matchingRowIndex += 1;
      if (commitRowIndex >= pageOffset && commitRowIndex < pageEnd)
        pageRows.push(buildGraphCommitRow(layoutRow, commitRowIndex));
    }
    throwIfGraphLayoutCancelled(options.cancellationSignal);
    const boundedRowCount = matchingRowCount.boundedCount;
    const nextRowOffset = pageOffset + pageRows.length;
    const hasMore = nextRowOffset < boundedRowCount;
    const nextCursor = hasMore
      ? { snapshotKey: querySnapshotKey, rowOffset: nextRowOffset }
      : undefined;
    return {
      rows: pageRows,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      hasMore,
      totalRows: boundedRowCount,
      totalCommits: this.normalizedSnapshot.commits.length,
      truncated:
        this.snapshotCommitTruncated ||
        this.incrementalLayoutBuilder.truncated ||
        matchingRowCount.exceedsMaximum,
      snapshotKey: querySnapshotKey,
    };
  }

  public getMinimapBuckets(
    options: GraphMinimapOptions = {},
  ): readonly GraphMinimapBucket[] {
    const bucketCount = options.bucketCount ?? 120;
    assertPositiveInteger(bucketCount, "bucketCount");
    const filter = options.filter;
    const scopeReachableShas =
      filter?.scope === undefined || filter.scope === "all"
        ? undefined
        : getReachableCommitShas(
            getScopeStartingShas(
              filter.scope,
              this.normalizedSnapshot.references ?? [],
              this.normalizedSnapshot.worktrees ?? [],
            ),
            this.commitBySha,
          );
    const worktreesByHeadSha = indexWorktreesByHeadSha(
      this.normalizedSnapshot.worktrees ?? [],
      options.includeWorktrees === true,
    );
    const visibleRowCount = countVisibleGraphRows(
      this.normalizedSnapshot.commits,
      this.referencesByCommitSha,
      worktreesByHeadSha,
      filter,
      scopeReachableShas,
      this.normalizedSnapshot.workingTree,
      options.includeWip === true,
    );
    if (visibleRowCount === 0) return [];
    const buckets = createGraphMinimapBuckets(
      bucketCount,
      visibleRowCount,
      this.normalizedOptions.colorCount,
    );
    const rowsPerBucket = Math.ceil(visibleRowCount / buckets.length);
    let nextVisibleRowIndex =
      options.includeWip === true &&
      this.normalizedSnapshot.workingTree !== undefined
        ? 1
        : 0;
    forEachGraphLayoutRow(
      this.normalizedSnapshot.commits,
      this.normalizedSnapshot.references ?? [],
      this.normalizedOptions,
      (layoutRow) => {
        if (
          !commitMatchesFilter(
            layoutRow.commit,
            layoutRow.references,
            filter,
            scopeReachableShas,
          )
        )
          return;
        nextVisibleRowIndex +=
          worktreesByHeadSha.get(layoutRow.commit.sha)?.length ?? 0;
        const bucket =
          buckets[
            Math.min(
              buckets.length - 1,
              Math.floor(nextVisibleRowIndex / rowsPerBucket),
            )
          ];
        if (bucket === undefined) return;
        const colorIndex = getGraphSemanticColorIndex(
          layoutRow.commit.sha,
          this.normalizedOptions.colorCount,
        );
        bucket.colorCounts[colorIndex] =
          (bucket.colorCounts[colorIndex] ?? 0) + 1;
        bucket.commitCount += 1;
        if (layoutRow.commit.parents.length > 1) bucket.mergeCount += 1;
        bucket.referenceCount += layoutRow.references.length;
        nextVisibleRowIndex += 1;
      },
      options.cancellationSignal,
    );
    return toGraphMinimapBuckets(buckets);
  }

  /** Computes minimap aggregates cooperatively and keeps no patch data. */
  public async getMinimapBucketsAsync(
    options: GraphMinimapOptions = {},
    asyncOptions: GraphLayoutAsyncOptions = {},
  ): Promise<readonly GraphMinimapBucket[]> {
    const bucketCount = options.bucketCount ?? 120;
    assertPositiveInteger(bucketCount, "bucketCount");
    const filter = options.filter;
    const scopeReachableShas =
      filter?.scope === undefined || filter.scope === "all"
        ? undefined
        : await getReachableCommitShasAsync(
            getScopeStartingShas(
              filter.scope,
              this.normalizedSnapshot.references ?? [],
              this.normalizedSnapshot.worktrees ?? [],
            ),
            this.commitBySha,
            options.cancellationSignal,
            asyncOptions,
          );
    const worktreesByHeadSha = indexWorktreesByHeadSha(
      this.normalizedSnapshot.worktrees ?? [],
      options.includeWorktrees === true,
    );
    const visibleRowCount = await countVisibleGraphRowsAsync(
      this.normalizedSnapshot.commits,
      this.referencesByCommitSha,
      worktreesByHeadSha,
      filter,
      scopeReachableShas,
      this.normalizedSnapshot.workingTree,
      options.includeWip === true,
      options.cancellationSignal,
      asyncOptions,
    );
    if (visibleRowCount === 0) return [];
    const buckets = createGraphMinimapBuckets(
      bucketCount,
      visibleRowCount,
      this.normalizedOptions.colorCount,
    );
    const rowsPerBucket = Math.ceil(visibleRowCount / buckets.length);
    let nextVisibleRowIndex =
      options.includeWip === true &&
      this.normalizedSnapshot.workingTree !== undefined
        ? 1
        : 0;
    await forEachGraphLayoutRowAsync(
      this.normalizedSnapshot.commits,
      this.normalizedSnapshot.references ?? [],
      this.normalizedOptions,
      (layoutRow) => {
        if (
          !commitMatchesFilter(
            layoutRow.commit,
            layoutRow.references,
            filter,
            scopeReachableShas,
          )
        )
          return;
        nextVisibleRowIndex +=
          worktreesByHeadSha.get(layoutRow.commit.sha)?.length ?? 0;
        const bucket =
          buckets[
            Math.min(
              buckets.length - 1,
              Math.floor(nextVisibleRowIndex / rowsPerBucket),
            )
          ];
        if (bucket === undefined) return;
        const colorIndex = getGraphSemanticColorIndex(
          layoutRow.commit.sha,
          this.normalizedOptions.colorCount,
        );
        bucket.colorCounts[colorIndex] =
          (bucket.colorCounts[colorIndex] ?? 0) + 1;
        bucket.commitCount += 1;
        if (layoutRow.commit.parents.length > 1) bucket.mergeCount += 1;
        bucket.referenceCount += layoutRow.references.length;
        nextVisibleRowIndex += 1;
      },
      options.cancellationSignal,
      asyncOptions,
    );
    return toGraphMinimapBuckets(buckets);
  }

  public getBranchStatus(localRefName: string): GraphBranchStatus | undefined {
    // A bounded graph cannot prove ahead/behind or merge-base values. Callers
    // with a Git command seam can still obtain an exact result from Git.
    if (this.snapshotCommitTruncated) return undefined;
    const localReference = this.resolveLocalReference(localRefName);
    if (localReference === undefined)
      throw new Error(`Unknown local reference: ${localRefName}`);
    const localResult = getAncestorDistanceMap(
      localReference.targetSha,
      this.commitBySha,
    );
    if (!localResult.complete) return undefined;
    const upstreamRefName = localReference.upstreamRefName;
    if (upstreamRefName === undefined)
      return { localRefName, aheadCount: 0, behindCount: 0 };
    const upstreamReference = this.resolveReference(upstreamRefName);
    if (upstreamReference === undefined) return undefined;
    const upstreamResult = getAncestorDistanceMap(
      upstreamReference.targetSha,
      this.commitBySha,
    );
    if (!upstreamResult.complete) return undefined;
    const mergeBaseSha = selectMergeBaseCandidates(
      localResult,
      upstreamResult,
      this.commitBySha,
    )?.[0];
    const localDistances = localResult.distances;
    const upstreamDistances = upstreamResult.distances;
    return {
      localRefName,
      upstreamRefName,
      ...(mergeBaseSha === undefined ? {} : { mergeBaseSha }),
      aheadCount: [...localDistances.keys()].filter(
        (sha) => !upstreamDistances.has(sha),
      ).length,
      behindCount: [...upstreamDistances.keys()].filter(
        (sha) => !localDistances.has(sha),
      ).length,
    };
  }

  public findMergeBase(
    firstSha: string,
    secondSha: string,
  ): string | undefined {
    if (this.snapshotCommitTruncated) return undefined;
    return getMergeBaseCandidates(firstSha, secondSha, this.commitBySha)?.[0];
  }

  public async getChangedLineMetrics(
    commitSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<ChangedLineMetrics | undefined> {
    const cachedMetrics = this.changedLineMetricsBySha.get(commitSha);
    if (cachedMetrics !== undefined) return cachedMetrics;
    if (this.metricsLoader === undefined) return undefined;
    throwIfGraphLayoutCancelled(cancellationSignal);
    const loadedMetrics = await this.metricsLoader(
      commitSha,
      cancellationSignal,
    );
    throwIfGraphLayoutCancelled(cancellationSignal);
    if (
      this.changedLineMetricsBySha.size >=
      this.normalizedOptions.maxMetricsCacheEntries
    ) {
      const oldestSha = this.changedLineMetricsBySha.keys().next().value;
      if (oldestSha !== undefined)
        this.changedLineMetricsBySha.delete(oldestSha);
    }
    this.changedLineMetricsBySha.set(commitSha, loadedMetrics);
    return loadedMetrics;
  }

  private resolveReference(referenceName: string): GraphReference | undefined {
    return (
      this.referenceByName.get(referenceName) ??
      this.referenceByName.get(`refs/heads/${referenceName}`) ??
      this.referenceByName.get(`refs/remotes/${referenceName}`)
    );
  }

  private resolveLocalReference(
    referenceName: string,
  ): GraphReference | undefined {
    const reference =
      this.referenceByName.get(referenceName) ??
      this.referenceByName.get(`refs/heads/${referenceName}`);
    if (
      reference === undefined ||
      reference.name === "HEAD" ||
      (reference.kind !== undefined && reference.kind !== "local")
    )
      return undefined;
    return reference;
  }
}

async function getReachableCommitShasAsync(
  startingShas: readonly string[],
  commitBySha: ReadonlyMap<string, GraphCommitRecord>,
  cancellationSignal: AbortSignal | undefined,
  asyncOptions: GraphLayoutAsyncOptions,
): Promise<ReadonlySet<string>> {
  const reachableShas = new Set<string>();
  const pendingShas = [...startingShas];
  const chunkSize = asyncOptions.chunkSize ?? 256;
  const yieldControl = asyncOptions.yieldControl ?? yieldToEventLoop;
  let examinedCount = 0;
  while (pendingShas.length > 0) {
    const sha = pendingShas.pop();
    if (sha === undefined || reachableShas.has(sha)) continue;
    reachableShas.add(sha);
    const commit = commitBySha.get(sha);
    if (commit !== undefined) pendingShas.push(...commit.parents);
    examinedCount += 1;
    if (examinedCount % chunkSize === 0) {
      throwIfGraphLayoutCancelled(cancellationSignal);
      await yieldControl();
    }
  }
  throwIfGraphLayoutCancelled(cancellationSignal);
  return reachableShas;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function awaitWithGraphCancellation<T>(
  sharedPromise: Promise<T>,
  cancellationSignal?: AbortSignal,
): Promise<T> {
  if (cancellationSignal === undefined) return sharedPromise;
  if (cancellationSignal.aborted) {
    return Promise.reject(createGraphCancellationError());
  }
  return new Promise<T>((resolve, reject) => {
    const abortHandler = (): void => {
      cleanup();
      reject(createGraphCancellationError());
    };
    const cleanup = (): void => {
      cancellationSignal.removeEventListener("abort", abortHandler);
    };
    cancellationSignal.addEventListener("abort", abortHandler, { once: true });
    void sharedPromise.then(
      (result) => {
        cleanup();
        if (cancellationSignal.aborted) reject(createGraphCancellationError());
        else resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function createGraphCancellationError(): Error {
  const cancellationError = new Error("Commit graph query cancelled");
  cancellationError.name = "AbortError";
  return cancellationError;
}
