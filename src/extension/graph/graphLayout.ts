import {
  classifyGraphReference,
  type GraphCommitRecord,
  type GraphLane,
  type GraphLaneEdge,
  type GraphReference,
} from "./graphModels.js";

const defaultSemanticColorCount = 12;

/**
 * Host layout rows are a replayable window, not a second copy of the full
 * repository snapshot. The active lane frontier remains live so every row
 * keeps exact topology; an evicted row is rebuilt from the commit head when a
 * caller requests an older cursor.
 */
export const graphLayoutRetainedRowLimit = 4_096;

export interface GraphLayoutCommitRow {
  readonly commit: GraphCommitRecord;
  readonly lanes: readonly GraphLane[];
  readonly nextLanes: readonly GraphLane[];
  readonly edges: readonly GraphLaneEdge[];
  readonly references: readonly GraphReference[];
}

export interface GraphLayoutRetainedRange {
  /** Inclusive first row index retained by the bounded layout window. */
  readonly startIndex: number;
  /** Exclusive row index after the bounded layout window. */
  readonly endIndex: number;
}

export interface GraphLayoutResult {
  readonly rows: readonly GraphLayoutCommitRow[];
  readonly truncated: boolean;
}

export interface GraphLayoutAsyncOptions {
  /** Number of commits handled before yielding to the extension host. */
  readonly chunkSize?: number;
  /** Injectable scheduler keeps tests deterministic without blocking timers. */
  readonly yieldControl?: () => Promise<void>;
}

export type GraphLayoutRowHandler = (
  layoutRow: GraphLayoutCommitRow,
  commitIndex: number,
) => void;

/**
 * Incremental topology builder. Git history is already topo-ordered, so the
 * lane state can be advanced one commit at a time. Consumers that only need a
 * page do not pay the allocation cost for the rest of a large repository.
 */
export class IncrementalGraphLayoutBuilder {
  /** Ring storage keeps eviction O(1), unlike Array.shift(). */
  private readonly layoutRows: Array<GraphLayoutCommitRow | undefined>;
  private readonly activeLaneShas: string[] = [];
  private readonly commitReferences: ReadonlyMap<
    string,
    readonly GraphReference[]
  >;
  private readonly boundedCommitCount: number;
  private retainedRowStartOffset = 0;
  private retainedLayoutRowCount = 0;
  private nextCommitIndex = 0;
  private pendingAsyncExpansion: Promise<unknown> | undefined;

  public constructor(
    private readonly commits: readonly GraphCommitRecord[],
    references: readonly GraphReference[],
    private readonly options: {
      readonly maxCommitCount: number;
      readonly colorCount: number;
    },
  ) {
    this.layoutRows = Array<GraphLayoutCommitRow | undefined>(
      graphLayoutRetainedRowLimit,
    );
    this.commitReferences = indexReferences(references);
    this.boundedCommitCount = Math.min(commits.length, options.maxCommitCount);
  }

  public get rows(): readonly GraphLayoutCommitRow[] {
    const retainedRows: GraphLayoutCommitRow[] = [];
    for (
      let retainedRowOffset = 0;
      retainedRowOffset < this.retainedLayoutRowCount;
      retainedRowOffset += 1
    ) {
      const retainedRow =
        this.layoutRows[
          (this.retainedRowStartOffset + retainedRowOffset) %
            graphLayoutRetainedRowLimit
        ];
      if (retainedRow !== undefined) retainedRows.push(retainedRow);
    }
    return retainedRows;
  }

  /** Absolute commit index of the first row retained in the ring. */
  public get retainedRowStartIndex(): number {
    return this.retainedRange.startIndex;
  }

  public get retainedRange(): GraphLayoutRetainedRange {
    return {
      startIndex: this.nextCommitIndex - this.retainedLayoutRowCount,
      endIndex: this.nextCommitIndex,
    };
  }

  public get retainedRowCount(): number {
    return this.retainedLayoutRowCount;
  }

  public get processedCommitCount(): number {
    return this.nextCommitIndex;
  }

  public get hasMore(): boolean {
    return this.nextCommitIndex < this.boundedCommitCount;
  }

  public get truncated(): boolean {
    return this.commits.length > this.boundedCommitCount;
  }

  public ensureRowsThrough(
    targetExclusive: number,
    cancellationSignal?: AbortSignal,
  ): readonly GraphLayoutCommitRow[] {
    const boundedTarget = Math.min(
      Math.max(0, Math.floor(targetExclusive)),
      this.boundedCommitCount,
    );
    if (boundedTarget > 0 && boundedTarget <= this.retainedRowStartIndex)
      this.resetLayoutReplay();
    while (this.nextCommitIndex < boundedTarget) {
      if (this.nextCommitIndex % 512 === 0)
        throwIfGraphLayoutCancelled(cancellationSignal);
      const commit = this.commits[this.nextCommitIndex];
      if (commit === undefined) break;
      this.retainLayoutRow(
        createCommitLayoutRow(
          commit,
          this.activeLaneShas,
          this.commitReferences,
          this.options.colorCount,
        ),
      );
      this.nextCommitIndex += 1;
    }
    throwIfGraphLayoutCancelled(cancellationSignal);
    return this.rows;
  }

  /**
   * Ensures and returns one absolute row. Old cursors replay from the commit
   * head, preserving exact lane topology without retaining old row objects.
   */
  public ensureRowAt(
    commitIndex: number,
    cancellationSignal?: AbortSignal,
  ): GraphLayoutCommitRow | undefined {
    const boundedCommitIndex = Math.floor(commitIndex);
    if (
      !Number.isInteger(boundedCommitIndex) ||
      boundedCommitIndex < 0 ||
      boundedCommitIndex >= this.boundedCommitCount
    )
      return undefined;
    if (boundedCommitIndex < this.retainedRowStartIndex)
      this.resetLayoutReplay();
    this.ensureRowsThrough(boundedCommitIndex + 1, cancellationSignal);
    return this.getRetainedRow(boundedCommitIndex);
  }

  public async ensureRowsThroughAsync(
    targetExclusive: number,
    cancellationSignal: AbortSignal | undefined,
    asyncOptions: GraphLayoutAsyncOptions = {},
  ): Promise<readonly GraphLayoutCommitRow[]> {
    return await this.enqueueAsyncLayoutOperation(async () => {
      const boundedTarget = Math.min(
        Math.max(0, Math.floor(targetExclusive)),
        this.boundedCommitCount,
      );
      if (boundedTarget > 0 && boundedTarget <= this.retainedRowStartIndex)
        this.resetLayoutReplay();
      await this.expandRowsThroughAsync(
        targetExclusive,
        cancellationSignal,
        asyncOptions,
      );
      return this.rows;
    });
  }

  private async enqueueAsyncLayoutOperation<LayoutOperationResult>(
    layoutOperation: () => Promise<LayoutOperationResult>,
  ): Promise<LayoutOperationResult> {
    const previousOperation = this.pendingAsyncExpansion;
    // A cancelled/rejected predecessor must not poison valid work queued
    // behind it. Preserve the predecessor's rejection for its own caller,
    // but recover the shared queue before invoking the next operation.
    const previousCompletion =
      previousOperation?.catch(() => undefined) ?? Promise.resolve();
    const queuedOperation = previousCompletion.then(layoutOperation);
    this.pendingAsyncExpansion = queuedOperation;
    void queuedOperation.then(
      () => {
        if (this.pendingAsyncExpansion === queuedOperation)
          this.pendingAsyncExpansion = undefined;
      },
      () => {
        if (this.pendingAsyncExpansion === queuedOperation)
          this.pendingAsyncExpansion = undefined;
      },
    );
    return await queuedOperation;
  }

  private async expandRowsThroughAsync(
    targetExclusive: number,
    cancellationSignal: AbortSignal | undefined,
    asyncOptions: GraphLayoutAsyncOptions = {},
  ): Promise<void> {
    const chunkSize = asyncOptions.chunkSize ?? 256;
    if (!Number.isInteger(chunkSize) || chunkSize < 1)
      throw new Error("chunkSize must be a positive integer.");
    const yieldControl = asyncOptions.yieldControl ?? yieldToEventLoop;
    const boundedTarget = Math.min(
      Math.max(0, Math.floor(targetExclusive)),
      this.boundedCommitCount,
    );
    while (this.nextCommitIndex < boundedTarget) {
      if (this.nextCommitIndex % chunkSize === 0) {
        throwIfGraphLayoutCancelled(cancellationSignal);
        if (this.nextCommitIndex > 0) await yieldControl();
      }
      const commit = this.commits[this.nextCommitIndex];
      if (commit === undefined) break;
      this.retainLayoutRow(
        createCommitLayoutRow(
          commit,
          this.activeLaneShas,
          this.commitReferences,
          this.options.colorCount,
        ),
      );
      this.nextCommitIndex += 1;
    }
    throwIfGraphLayoutCancelled(cancellationSignal);
  }

  public async ensureRowAtAsync(
    commitIndex: number,
    cancellationSignal: AbortSignal | undefined,
    asyncOptions: GraphLayoutAsyncOptions = {},
  ): Promise<GraphLayoutCommitRow | undefined> {
    const boundedCommitIndex = Math.floor(commitIndex);
    if (
      !Number.isInteger(boundedCommitIndex) ||
      boundedCommitIndex < 0 ||
      boundedCommitIndex >= this.boundedCommitCount
    )
      return undefined;
    return await this.enqueueAsyncLayoutOperation(async () => {
      if (boundedCommitIndex < this.retainedRowStartIndex)
        this.resetLayoutReplay();
      await this.expandRowsThroughAsync(
        boundedCommitIndex + 1,
        cancellationSignal,
        asyncOptions,
      );
      return this.getRetainedRow(boundedCommitIndex);
    });
  }

  public ensureAll(
    cancellationSignal?: AbortSignal,
  ): readonly GraphLayoutCommitRow[] {
    return this.ensureRowsThrough(this.boundedCommitCount, cancellationSignal);
  }

  public async ensureAllAsync(
    cancellationSignal: AbortSignal | undefined,
    asyncOptions: GraphLayoutAsyncOptions = {},
  ): Promise<readonly GraphLayoutCommitRow[]> {
    return await this.ensureRowsThroughAsync(
      this.boundedCommitCount,
      cancellationSignal,
      asyncOptions,
    );
  }

  private getRetainedRow(
    commitIndex: number,
  ): GraphLayoutCommitRow | undefined {
    if (
      commitIndex < this.retainedRowStartIndex ||
      commitIndex >= this.nextCommitIndex
    )
      return undefined;
    const retainedRowOffset = commitIndex - this.retainedRowStartIndex;
    return this.layoutRows[
      (this.retainedRowStartOffset + retainedRowOffset) %
        graphLayoutRetainedRowLimit
    ];
  }

  private retainLayoutRow(layoutRow: GraphLayoutCommitRow): void {
    const writeOffset =
      (this.retainedRowStartOffset + this.retainedLayoutRowCount) %
      graphLayoutRetainedRowLimit;
    this.layoutRows[writeOffset] = layoutRow;
    if (this.retainedLayoutRowCount < graphLayoutRetainedRowLimit) {
      this.retainedLayoutRowCount += 1;
      return;
    }
    this.retainedRowStartOffset =
      (this.retainedRowStartOffset + 1) % graphLayoutRetainedRowLimit;
  }

  private resetLayoutReplay(): void {
    this.layoutRows.fill(undefined);
    this.activeLaneShas.length = 0;
    this.retainedRowStartOffset = 0;
    this.retainedLayoutRowCount = 0;
    this.nextCommitIndex = 0;
  }
}

/** Streams topology rows without retaining a second 500k-row layout array. */
export function forEachGraphLayoutRow(
  commits: readonly GraphCommitRecord[],
  references: readonly GraphReference[],
  options: { readonly maxCommitCount: number; readonly colorCount: number },
  onRow: GraphLayoutRowHandler,
  cancellationSignal?: AbortSignal,
): number {
  const commitReferences = indexReferences(references);
  const activeLaneShas: string[] = [];
  const boundedCommitCount = Math.min(commits.length, options.maxCommitCount);
  for (
    let commitIndex = 0;
    commitIndex < boundedCommitCount;
    commitIndex += 1
  ) {
    if (commitIndex % 512 === 0)
      throwIfGraphLayoutCancelled(cancellationSignal);
    const commit = commits[commitIndex];
    if (commit === undefined) break;
    onRow(
      createCommitLayoutRow(
        commit,
        activeLaneShas,
        commitReferences,
        options.colorCount,
      ),
      commitIndex,
    );
  }
  throwIfGraphLayoutCancelled(cancellationSignal);
  return boundedCommitCount;
}

/** Async streaming counterpart for minimap/summary work in the host. */
export async function forEachGraphLayoutRowAsync(
  commits: readonly GraphCommitRecord[],
  references: readonly GraphReference[],
  options: { readonly maxCommitCount: number; readonly colorCount: number },
  onRow: GraphLayoutRowHandler,
  cancellationSignal: AbortSignal | undefined,
  asyncOptions: GraphLayoutAsyncOptions = {},
): Promise<number> {
  const chunkSize = asyncOptions.chunkSize ?? 256;
  if (!Number.isInteger(chunkSize) || chunkSize < 1)
    throw new Error("chunkSize must be a positive integer.");
  const yieldControl = asyncOptions.yieldControl ?? yieldToEventLoop;
  const commitReferences = indexReferences(references);
  const activeLaneShas: string[] = [];
  const boundedCommitCount = Math.min(commits.length, options.maxCommitCount);
  for (
    let commitIndex = 0;
    commitIndex < boundedCommitCount;
    commitIndex += 1
  ) {
    if (commitIndex % chunkSize === 0) {
      throwIfGraphLayoutCancelled(cancellationSignal);
      if (commitIndex > 0) await yieldControl();
    }
    const commit = commits[commitIndex];
    if (commit === undefined) break;
    onRow(
      createCommitLayoutRow(
        commit,
        activeLaneShas,
        commitReferences,
        options.colorCount,
      ),
      commitIndex,
    );
  }
  throwIfGraphLayoutCancelled(cancellationSignal);
  return boundedCommitCount;
}

/** Stable across processes, machines, and insertion of unrelated commits. */
export function getGraphSemanticColorIndex(
  commitSha: string,
  colorCount = defaultSemanticColorCount,
): number {
  if (!Number.isInteger(colorCount) || colorCount < 1)
    throw new Error("colorCount must be a positive integer.");
  let hash = 2_166_136_261;
  for (
    let characterIndex = 0;
    characterIndex < commitSha.length;
    characterIndex += 1
  ) {
    hash ^= commitSha.charCodeAt(characterIndex);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % colorCount;
}

function makeLane(
  expectedCommitSha: string,
  column: number,
  colorCount: number,
): GraphLane {
  return {
    column,
    expectedCommitSha,
    colorIndex: getGraphSemanticColorIndex(expectedCommitSha, colorCount),
  };
}

function normalizeParentShas(parentShas: readonly string[]): readonly string[] {
  return [...new Set(parentShas.filter((parentSha) => parentSha.length > 0))];
}

function compareReferences(
  leftReference: GraphReference,
  rightReference: GraphReference,
): number {
  const leftKind = classifyGraphReference(leftReference);
  const rightKind = classifyGraphReference(rightReference);
  const kindOrder: Record<string, number> = {
    head: 0,
    local: 1,
    remote: 2,
    tag: 3,
    stash: 4,
  };
  return (
    (kindOrder[leftKind] ?? 99) - (kindOrder[rightKind] ?? 99) ||
    leftReference.name.localeCompare(rightReference.name)
  );
}

function createCommitLayoutRow(
  commit: GraphCommitRecord,
  activeLaneShas: string[],
  commitReferences: ReadonlyMap<string, readonly GraphReference[]>,
  colorCount: number,
): GraphLayoutCommitRow {
  const laneShasBeforeCommit = activeLaneShas.slice();
  let commitColumn = activeLaneShas.indexOf(commit.sha);
  if (commitColumn < 0) {
    commitColumn = activeLaneShas.length;
    activeLaneShas.push(commit.sha);
  }
  const lanes = activeLaneShas.map((sha, column) =>
    makeLane(sha, column, colorCount),
  );
  const normalizedParents = normalizeParentShas(commit.parents);
  const laneShasAfterCommit = activeLaneShas.slice();
  laneShasAfterCommit.splice(commitColumn, 1);
  // Existing lanes retain their relative order and columns after compaction.
  // New parents are appended through one cursor, so they cannot push an
  // unrelated active lane sideways without topology requiring it.
  let parentInsertionCursor = laneShasAfterCommit.length;
  for (
    let parentOffset = 0;
    parentOffset < normalizedParents.length;
    parentOffset += 1
  ) {
    const parentSha = normalizedParents[parentOffset];
    if (parentSha === undefined || laneShasAfterCommit.includes(parentSha))
      continue;
    laneShasAfterCommit.splice(parentInsertionCursor, 0, parentSha);
    parentInsertionCursor += 1;
  }
  const nextLanes = laneShasAfterCommit.map((sha, column) =>
    makeLane(sha, column, colorCount),
  );
  const parentEdges: GraphLaneEdge[] = normalizedParents.map(
    (parentSha, parentOffset) => {
      const targetColumn = laneShasAfterCommit.indexOf(parentSha);
      return {
        parentSha,
        fromColumn: commitColumn,
        toColumn: targetColumn < 0 ? commitColumn + parentOffset : targetColumn,
        colorIndex: getGraphSemanticColorIndex(parentSha, colorCount),
        kind: parentOffset === 0 ? "first-parent" : "merge-parent",
      };
    },
  );
  const continuationEdges: GraphLaneEdge[] = [];
  for (
    let previousColumn = 0;
    previousColumn < laneShasBeforeCommit.length;
    previousColumn += 1
  ) {
    const laneSha = laneShasBeforeCommit[previousColumn];
    if (laneSha === undefined || laneSha === commit.sha) continue;
    const nextColumn = laneShasAfterCommit.indexOf(laneSha);
    if (nextColumn < 0 || nextColumn === previousColumn) continue;
    continuationEdges.push({
      parentSha: laneSha,
      fromColumn: previousColumn,
      toColumn: nextColumn,
      colorIndex: getGraphSemanticColorIndex(laneSha, colorCount),
      kind: "continuation",
    });
  }
  activeLaneShas.splice(0, activeLaneShas.length, ...laneShasAfterCommit);
  return {
    commit,
    lanes,
    nextLanes,
    edges: [...parentEdges, ...continuationEdges],
    references: commitReferences.get(commit.sha) ?? [],
  };
}

function indexReferences(
  references: readonly GraphReference[],
): ReadonlyMap<string, readonly GraphReference[]> {
  const commitReferences = new Map<string, GraphReference[]>();
  for (const reference of references) {
    const targetReferences = commitReferences.get(reference.targetSha) ?? [];
    targetReferences.push(reference);
    commitReferences.set(reference.targetSha, targetReferences);
  }
  for (const targetReferences of commitReferences.values())
    targetReferences.sort(compareReferences);
  return commitReferences;
}

/**
 * Computes lanes in one pass over Git's topo-ordered commit list. The input
 * order is intentionally preserved: the Git loader requests topo/date order,
 * while callers using synthetic data can provide a deterministic order.
 */
export function buildGraphLayout(
  commits: readonly GraphCommitRecord[],
  references: readonly GraphReference[],
  options: { readonly maxCommitCount: number; readonly colorCount: number },
  cancellationSignal?: AbortSignal,
): GraphLayoutResult {
  const rows: GraphLayoutCommitRow[] = [];
  const processedCommitCount = forEachGraphLayoutRow(
    commits,
    references,
    options,
    (layoutRow) => rows.push(layoutRow),
    cancellationSignal,
  );
  return {
    rows,
    truncated: commits.length > processedCommitCount,
  };
}

/**
 * Async counterpart used by the webview runtime. Every chunk yields before
 * continuing, so layout of a large repository cannot monopolise the host.
 */
export async function buildGraphLayoutAsync(
  commits: readonly GraphCommitRecord[],
  references: readonly GraphReference[],
  options: { readonly maxCommitCount: number; readonly colorCount: number },
  cancellationSignal?: AbortSignal,
  asyncOptions: GraphLayoutAsyncOptions = {},
): Promise<GraphLayoutResult> {
  const rows: GraphLayoutCommitRow[] = [];
  const processedCommitCount = await forEachGraphLayoutRowAsync(
    commits,
    references,
    options,
    (layoutRow) => rows.push(layoutRow),
    cancellationSignal,
    asyncOptions,
  );
  return {
    rows,
    truncated: commits.length > processedCommitCount,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function throwIfGraphLayoutCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Commit graph query cancelled", "AbortError");
}
