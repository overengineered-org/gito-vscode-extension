import * as nodePath from "node:path";

import {
  CommitGraphQueryEngine,
  defaultGraphEngineOptions,
  GitCommitGraphLoader,
  type ChangedLineMetricsLoader,
  type GraphEngineOptions,
  type GraphBranchStatus,
  type GraphCommitRecord,
  type GraphFilter,
  type GraphMinimapBucket,
  type GraphPage,
  type GraphRow,
  type GraphRepositorySnapshot,
} from "../graph/index.js";
import type {
  GitGraphLoadOptions,
  GraphRepositoryRoot,
} from "../graph/gitGraphLoader.js";
import type {
  GraphExperienceDataSource,
  GraphMinimapRequest,
  GraphPageRequest,
} from "./graphExperienceModels.js";
import type {
  GraphChangedLineMetricsMessage,
  GraphFilterMessage,
  GraphMinimapBucketMessage,
  GraphPageMessage,
  GraphRowMessage,
  GraphSummaryMessage,
} from "../../protocol/graphExperienceProtocol.js";

export interface GraphRepositoryGenerationBinding {
  /** Immutable repository root captured when the graph surface opens. */
  readonly repositoryRoot: string | GraphRepositoryRoot;
  /** Changes whenever VS Code switches the active repository instance. */
  readonly generation: string;
  /** Returns false once the captured repository is closed or replaced. */
  readonly isCurrent?: () => boolean | Promise<boolean>;
  /** Optional stronger check for hosts that expose a generation token. */
  readonly currentGeneration?: () => string | Promise<string>;
  /** Changes when refs, worktrees, or the working tree mutate in-place. */
  readonly currentStateKey?: () => string | Promise<string>;
}

export interface GraphExperienceRuntimeOptions {
  readonly repository: GraphRepositoryGenerationBinding;
  readonly graphLoader: Pick<GitCommitGraphLoader, "load">;
  readonly metricsLoader?: ChangedLineMetricsLoader;
  readonly graphEngineOptions?: GraphEngineOptions;
  readonly graphLoadOptions?: Omit<GitGraphLoadOptions, "cancellationSignal">;
  /**
   * Optional exact Git status reader. The graph snapshot can be bounded, so
   * callers that need branch status must provide this seam to avoid deriving
   * authoritative values from incomplete topology.
   */
  readonly branchStatusLoader?: (
    localRefName: string,
    cancellationSignal: AbortSignal,
  ) => Promise<GraphBranchStatus | undefined>;
  readonly repositoryDisplayName?: string;
  /** Commits processed per host turn. Defaults to 256. */
  readonly chunkSize?: number;
}

interface ActiveRuntimeOperation {
  readonly cancellationSignal: AbortSignal;
  readonly dispose: () => void;
}

interface PendingGraphEngineLoad {
  readonly cancellationController: AbortController;
  readonly promise: Promise<CommitGraphQueryEngine>;
  consumerCount: number;
  settled: boolean;
}

export interface LoadedGraphCheckoutTarget {
  readonly kind: "branch" | "remote" | "detached";
  readonly target: string;
}

const graphRuntimePageSizeCap = 500;
const graphRuntimeMinimapBucketCap = 240;

/**
 * Extension-host datasource backed by local Git metadata. It never calls the
 * synchronous query API: each page and minimap request uses cooperative async
 * layout, bounded row payloads, and a signal checked after every chunk.
 */
export class GraphExperienceRuntimeDataSource implements GraphExperienceDataSource {
  private lifecycleAbortController = new AbortController();
  private readonly activeOperations = new Set<ActiveRuntimeOperation>();
  private snapshotPromise: Promise<GraphRepositorySnapshot> | undefined;
  private enginePromise: Promise<CommitGraphQueryEngine> | undefined;
  private pendingGraphEngineLoad: PendingGraphEngineLoad | undefined;
  private loadedStateKey: string | undefined;
  private disposed = false;

  public constructor(private readonly options: GraphExperienceRuntimeOptions) {
    const chunkSize = options.chunkSize ?? 256;
    if (!Number.isInteger(chunkSize) || chunkSize < 1)
      throw new Error("chunkSize must be a positive integer.");
  }

  public get repositoryGeneration(): string {
    return this.options.repository.generation;
  }

  public get repositoryRootPath(): string {
    return repositoryRootPath(this.options.repository.repositoryRoot);
  }

  /**
   * Validates a commit action against the currently loaded snapshot. When a
   * parent is supplied it must be a direct parent of that commit, preventing
   * stale webview rows from selecting an unrelated revision after a refresh.
   */
  public async getLoadedCommitActionTarget(
    commitSha: string,
    parentSha: string | undefined,
    cancellationSignal: AbortSignal,
  ): Promise<GraphCommitRecord | undefined> {
    if (
      !isSafeGraphObjectId(commitSha) ||
      (parentSha !== undefined && !isSafeGraphObjectId(parentSha))
    )
      return undefined;
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      await this.assertCurrent(operation.cancellationSignal);
      const commit = engine.snapshot.commits.find(
        (candidate) => candidate.sha === commitSha,
      );
      if (
        commit === undefined ||
        (parentSha !== undefined &&
          (!commit.parents.includes(parentSha) ||
            !engine.snapshot.commits.some(
              (candidate) => candidate.sha === parentSha,
            )))
      )
        return undefined;
      await this.assertCurrent(operation.cancellationSignal);
      return commit;
    } finally {
      operation.dispose();
    }
  }

  /** Resolve only a reference or object ID present in the loaded snapshot. */
  public async getLoadedCheckoutTarget(
    requestedTarget: string,
    cancellationSignal: AbortSignal,
  ): Promise<LoadedGraphCheckoutTarget | undefined> {
    if (!isSafeGraphCheckoutTarget(requestedTarget)) return undefined;
    // HEAD is a moving symbolic name. Sending it to `switch --detach` would
    // silently detach a branch checkout, so it is never a checkout target.
    if (requestedTarget === "HEAD") return undefined;
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      await this.assertCurrent(operation.cancellationSignal);
      const reference = engine.snapshot.references?.find(
        (candidate) => candidate.name === requestedTarget,
      );
      if (reference !== undefined) {
        if (reference.name === "HEAD") return undefined;
        if (reference.name.startsWith("refs/heads/"))
          return {
            kind: "branch",
            target: reference.name.slice("refs/heads/".length),
          };
        if (reference.name.startsWith("refs/remotes/"))
          return {
            kind: "remote",
            target: reference.name.slice("refs/remotes/".length),
          };
        if (!isSafeGraphObjectId(reference.targetSha)) return undefined;
        return { kind: "detached", target: reference.targetSha };
      }
      if (
        isSafeGraphObjectId(requestedTarget) &&
        engine.snapshot.commits.some((commit) => commit.sha === requestedTarget)
      )
        return { kind: "detached", target: requestedTarget };
      return undefined;
    } finally {
      operation.dispose();
    }
  }

  /**
   * Returns status for the selected local branch, never the current worktree
   * as a substitute. Remote/tag/HEAD references are intentionally unsupported
   * until a truthful selected-ref status can be calculated for them.
   */
  public async getLoadedBranchStatus(
    requestedReferenceName: string,
    cancellationSignal: AbortSignal,
  ): Promise<GraphBranchStatus | undefined> {
    if (!isSafeGraphCheckoutTarget(requestedReferenceName)) return undefined;
    if (
      requestedReferenceName === "HEAD" ||
      requestedReferenceName.startsWith("refs/remotes/") ||
      requestedReferenceName.startsWith("refs/tags/") ||
      requestedReferenceName === "refs/stash" ||
      isSafeGraphObjectId(requestedReferenceName)
    )
      return undefined;
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      await this.assertCurrent(operation.cancellationSignal);
      const localReference = (engine.snapshot.references ?? []).find(
        (reference) =>
          (reference.name === requestedReferenceName ||
            reference.name === `refs/heads/${requestedReferenceName}`) &&
          reference.name !== "HEAD" &&
          (reference.kind === undefined || reference.kind === "local"),
      );
      if (localReference === undefined) return undefined;
      const exactBranchStatusLoader = this.options.branchStatusLoader;
      if (exactBranchStatusLoader !== undefined) {
        const status = await exactBranchStatusLoader(
          localReference.name,
          operation.cancellationSignal,
        );
        await this.assertCurrent(operation.cancellationSignal);
        return status;
      }
      try {
        const status = engine.getBranchStatus(requestedReferenceName);
        await this.assertCurrent(operation.cancellationSignal);
        return status;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.startsWith("Unknown local reference:")
        )
          return undefined;
        throw error;
      }
    } finally {
      operation.dispose();
    }
  }

  public async getSummary(
    cancellationSignal: AbortSignal,
  ): Promise<GraphSummaryMessage> {
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      await this.assertCurrent(operation.cancellationSignal);
      const snapshot = engine.snapshot;
      const headReference = (snapshot.references ?? []).find(
        (reference) => reference.isHead === true || reference.name === "HEAD",
      );
      const primaryWorktreeBranchReference = snapshot.worktrees?.find(
        (worktree) => worktree.isPrimary === true,
      )?.branchRefName;
      const currentBranchName = branchNameFromReference(
        primaryWorktreeBranchReference ??
          (headReference?.name === "HEAD" ? undefined : headReference?.name),
      );
      return {
        repositoryRoot: this.repositoryRootPath,
        repositoryDisplayName:
          this.options.repositoryDisplayName ??
          nodePath.basename(this.repositoryRootPath),
        ...(currentBranchName === undefined ? {} : { currentBranchName }),
        totalCommits: snapshot.commits.length,
        totalReferences: snapshot.references?.length ?? 0,
        totalWorktrees: snapshot.worktrees?.length ?? 0,
        truncated:
          snapshot.truncated === true ||
          snapshot.commits.length >
            (this.options.graphEngineOptions?.maxCommitCount ??
              defaultGraphEngineOptions.maxCommitCount),
      };
    } finally {
      operation.dispose();
    }
  }

  public async queryPage(
    request: GraphPageRequest,
    cancellationSignal: AbortSignal,
  ): Promise<GraphPageMessage> {
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      const asyncLayoutOptions =
        this.options.chunkSize === undefined
          ? {
              yieldControl: () =>
                this.yieldForRuntime(operation.cancellationSignal),
            }
          : {
              chunkSize: this.options.chunkSize,
              yieldControl: () =>
                this.yieldForRuntime(operation.cancellationSignal),
            };
      const page = await engine.queryAsync(
        {
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          pageSize: Math.min(request.pageSize, graphRuntimePageSizeCap),
          filter: toGraphFilter(request.filter),
          includeWip: request.includeWip,
          includeWorktrees: request.includeWorktrees,
          cancellationSignal: operation.cancellationSignal,
        },
        asyncLayoutOptions,
      );
      await this.assertCurrent(operation.cancellationSignal);
      return toGraphPageMessage(page);
    } finally {
      operation.dispose();
    }
  }

  public async getMinimap(
    request: GraphMinimapRequest,
    cancellationSignal: AbortSignal,
  ): Promise<readonly GraphMinimapBucketMessage[]> {
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      const asyncLayoutOptions =
        this.options.chunkSize === undefined
          ? {
              yieldControl: () =>
                this.yieldForRuntime(operation.cancellationSignal),
            }
          : {
              chunkSize: this.options.chunkSize,
              yieldControl: () =>
                this.yieldForRuntime(operation.cancellationSignal),
            };
      const buckets = await engine.getMinimapBucketsAsync(
        {
          bucketCount: Math.min(
            request.bucketCount,
            graphRuntimeMinimapBucketCap,
          ),
          filter: toGraphFilter(request.filter),
          includeWip: request.includeWip,
          includeWorktrees: request.includeWorktrees,
          cancellationSignal: operation.cancellationSignal,
        },
        asyncLayoutOptions,
      );
      await this.assertCurrent(operation.cancellationSignal);
      return buckets.map(toGraphMinimapBucketMessage);
    } finally {
      operation.dispose();
    }
  }

  public async getChangedLineMetrics(
    commitSha: string,
    cancellationSignal: AbortSignal,
  ): Promise<GraphChangedLineMetricsMessage | undefined> {
    const operation = this.beginOperation(cancellationSignal);
    try {
      const engine = await this.getEngine(operation);
      if (!engine.snapshot.commits.some((commit) => commit.sha === commitSha))
        return undefined;
      const metrics = await engine.getChangedLineMetrics(
        commitSha,
        operation.cancellationSignal,
      );
      await this.assertCurrent(operation.cancellationSignal);
      return metrics;
    } finally {
      operation.dispose();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleAbortController.abort();
    for (const operation of this.activeOperations) operation.dispose();
    this.activeOperations.clear();
    this.abortPendingGraphEngineLoad();
    this.snapshotPromise = undefined;
    this.enginePromise = undefined;
    this.loadedStateKey = undefined;
  }

  /** Drops all cached Git state after an in-place repository mutation. */
  public invalidate(): void {
    if (this.disposed) return;
    this.lifecycleAbortController.abort();
    for (const operation of this.activeOperations) operation.dispose();
    this.activeOperations.clear();
    this.abortPendingGraphEngineLoad();
    this.lifecycleAbortController = new AbortController();
    this.snapshotPromise = undefined;
    this.enginePromise = undefined;
    this.loadedStateKey = undefined;
  }

  private async getEngine(
    operation: ActiveRuntimeOperation,
  ): Promise<CommitGraphQueryEngine> {
    await this.assertCurrent(operation.cancellationSignal);
    let pendingGraphEngineLoad = this.pendingGraphEngineLoad;
    if (this.enginePromise === undefined) {
      const cancellationController = new AbortController();
      const pendingEngine = this.loadEngine(cancellationController.signal);
      pendingGraphEngineLoad = {
        cancellationController,
        promise: pendingEngine,
        consumerCount: 0,
        settled: false,
      };
      this.pendingGraphEngineLoad = pendingGraphEngineLoad;
      this.enginePromise = pendingEngine;
      void pendingEngine.then(
        () => {
          if (this.pendingGraphEngineLoad === pendingGraphEngineLoad) {
            pendingGraphEngineLoad!.settled = true;
            this.pendingGraphEngineLoad = undefined;
          }
        },
        () => {
          pendingGraphEngineLoad!.settled = true;
          if (this.pendingGraphEngineLoad === pendingGraphEngineLoad)
            this.pendingGraphEngineLoad = undefined;
          if (this.enginePromise === pendingEngine)
            this.enginePromise = undefined;
        },
      );
    }
    const enginePromise = this.enginePromise;
    if (enginePromise === undefined)
      throw new Error("The graph engine load was unexpectedly cleared.");
    if (
      pendingGraphEngineLoad !== undefined &&
      pendingGraphEngineLoad.promise === enginePromise &&
      !pendingGraphEngineLoad.settled
    ) {
      pendingGraphEngineLoad.consumerCount += 1;
      try {
        return await awaitWithRuntimeCancellation(
          enginePromise,
          operation.cancellationSignal,
        );
      } finally {
        this.releaseGraphEngineConsumer(pendingGraphEngineLoad);
      }
    }
    return await awaitWithRuntimeCancellation(
      enginePromise,
      operation.cancellationSignal,
    );
  }

  private releaseGraphEngineConsumer(
    pendingGraphEngineLoad: PendingGraphEngineLoad,
  ): void {
    pendingGraphEngineLoad.consumerCount = Math.max(
      0,
      pendingGraphEngineLoad.consumerCount - 1,
    );
    if (
      pendingGraphEngineLoad.consumerCount !== 0 ||
      pendingGraphEngineLoad.settled ||
      this.pendingGraphEngineLoad !== pendingGraphEngineLoad
    )
      return;
    this.abortPendingGraphEngineLoad();
  }

  private abortPendingGraphEngineLoad(): void {
    const pendingGraphEngineLoad = this.pendingGraphEngineLoad;
    if (pendingGraphEngineLoad === undefined) return;
    this.pendingGraphEngineLoad = undefined;
    if (this.enginePromise === pendingGraphEngineLoad.promise)
      this.enginePromise = undefined;
    this.snapshotPromise = undefined;
    pendingGraphEngineLoad.cancellationController.abort();
  }

  private async loadEngine(
    cancellationSignal: AbortSignal,
  ): Promise<CommitGraphQueryEngine> {
    if (this.snapshotPromise === undefined) {
      const pendingSnapshot = this.options.graphLoader.load(
        this.options.repository.repositoryRoot,
        {
          ...this.options.graphLoadOptions,
          cancellationSignal,
        },
      );
      this.snapshotPromise = pendingSnapshot;
      try {
        const snapshot = await pendingSnapshot;
        await this.assertCurrent(cancellationSignal);
        this.loadedStateKey = await this.readCurrentStateKey();
        const metricsLoader = this.options.metricsLoader;
        return new CommitGraphQueryEngine(snapshot, {
          ...this.options.graphEngineOptions,
          ...(metricsLoader === undefined ? {} : { metricsLoader }),
          lifecycleSignal: this.lifecycleAbortController.signal,
        });
      } catch (error: unknown) {
        if (this.snapshotPromise === pendingSnapshot)
          this.snapshotPromise = undefined;
        throw error;
      }
    }
    const snapshot = await this.snapshotPromise;
    await this.assertCurrent(cancellationSignal);
    const metricsLoader = this.options.metricsLoader;
    return new CommitGraphQueryEngine(snapshot, {
      ...this.options.graphEngineOptions,
      ...(metricsLoader === undefined ? {} : { metricsLoader }),
      lifecycleSignal: this.lifecycleAbortController.signal,
    });
  }

  private beginOperation(externalSignal: AbortSignal): ActiveRuntimeOperation {
    this.assertNotDisposed();
    const operationAbortController = new AbortController();
    const abortOperation = (): void => operationAbortController.abort();
    if (externalSignal.aborted || this.lifecycleAbortController.signal.aborted)
      operationAbortController.abort();
    else {
      externalSignal.addEventListener("abort", abortOperation, { once: true });
      this.lifecycleAbortController.signal.addEventListener(
        "abort",
        abortOperation,
        {
          once: true,
        },
      );
    }
    const operation: ActiveRuntimeOperation = {
      cancellationSignal: operationAbortController.signal,
      dispose: () => {
        externalSignal.removeEventListener("abort", abortOperation);
        this.lifecycleAbortController.signal.removeEventListener(
          "abort",
          abortOperation,
        );
        this.activeOperations.delete(operation);
      },
    };
    this.activeOperations.add(operation);
    return operation;
  }

  private async yieldForRuntime(
    cancellationSignal: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.assertCurrent(cancellationSignal);
  }

  private async assertCurrent(cancellationSignal: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    throwIfRuntimeCancelled(cancellationSignal);
    const isCurrent = this.options.repository.isCurrent;
    if (isCurrent !== undefined && !(await isCurrent()))
      throw new Error(
        "The selected Git repository changed; refresh the graph.",
      );
    const currentGeneration = this.options.repository.currentGeneration;
    if (
      currentGeneration !== undefined &&
      (await currentGeneration()) !== this.options.repository.generation
    )
      throw new Error(
        "The selected Git repository changed; refresh the graph.",
      );
    const currentStateKey = await this.readCurrentStateKey();
    if (
      this.loadedStateKey !== undefined &&
      currentStateKey !== undefined &&
      currentStateKey !== this.loadedStateKey
    ) {
      this.invalidate();
      throw new Error(
        "The selected Git repository changed; refresh the graph.",
      );
    }
  }

  private async readCurrentStateKey(): Promise<string | undefined> {
    return this.options.repository.currentStateKey === undefined
      ? undefined
      : await this.options.repository.currentStateKey();
  }

  private assertNotDisposed(): void {
    if (this.disposed)
      throw new Error("The commit graph runtime has been disposed.");
  }
}

/** Short factory name for composition roots and focused tests. */
export function createGraphExperienceRuntimeDataSource(
  options: GraphExperienceRuntimeOptions,
): GraphExperienceRuntimeDataSource {
  return new GraphExperienceRuntimeDataSource(options);
}

export {
  GraphExperienceRuntimeDataSource as GraphRuntimeDataSource,
  GraphExperienceRuntimeDataSource as GraphExperienceRuntime,
};

function toGraphFilter(filterMessage: GraphFilterMessage): GraphFilter {
  const filter: MutableGraphFilter = {};
  if (filterMessage.scope !== undefined) filter.scope = filterMessage.scope;
  if (filterMessage.text !== undefined) filter.text = filterMessage.text;
  if (filterMessage.authorEmail !== undefined)
    filter.authorEmail = filterMessage.authorEmail;
  if (filterMessage.authorName !== undefined)
    filter.authorName = filterMessage.authorName;
  if (filterMessage.commitShas !== undefined)
    filter.commitShas = [...filterMessage.commitShas];
  if (filterMessage.referenceNames !== undefined)
    filter.referenceNames = [...filterMessage.referenceNames];
  if (filterMessage.since !== undefined) filter.since = filterMessage.since;
  if (filterMessage.until !== undefined) filter.until = filterMessage.until;
  return filter;
}

export function isSafeGraphCheckoutTarget(target: string): boolean {
  if (target.length === 0 || target.length > 512) return false;
  if (/^[^/]+$/u.test(target) && target.startsWith("-")) return false;
  if (target.includes(String.fromCharCode(0))) return false;
  if (
    [...target].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f || character === "\\";
    })
  )
    return false;
  if (target.includes("..") || target.includes("@{")) return false;
  if (target.includes("//") || target.endsWith("/") || target.endsWith("."))
    return false;
  if (
    (target.startsWith("refs/heads/") ||
      target.startsWith("refs/remotes/") ||
      target.startsWith("refs/tags/")) &&
    target.slice(target.indexOf("/", "refs/".length) + 1).startsWith("-")
  )
    return false;
  return (
    target === "HEAD" ||
    target.startsWith("refs/heads/") ||
    target.startsWith("refs/remotes/") ||
    target.startsWith("refs/tags/") ||
    target === "refs/stash" ||
    isSafeGraphObjectId(target)
  );
}

function isSafeGraphObjectId(target: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(target);
}

interface MutableGraphFilter {
  scope?: NonNullable<GraphFilter["scope"]>;
  text?: NonNullable<GraphFilter["text"]>;
  authorEmail?: NonNullable<GraphFilter["authorEmail"]>;
  authorName?: NonNullable<GraphFilter["authorName"]>;
  commitShas?: NonNullable<GraphFilter["commitShas"]>;
  referenceNames?: NonNullable<GraphFilter["referenceNames"]>;
  since?: NonNullable<GraphFilter["since"]>;
  until?: NonNullable<GraphFilter["until"]>;
}

function toGraphPageMessage(page: GraphPage): GraphPageMessage {
  return {
    rows: page.rows.map(toGraphRowMessage),
    ...(page.nextCursor === undefined
      ? {}
      : { nextCursor: { ...page.nextCursor } }),
    hasMore: page.hasMore,
    totalRows: page.totalRows,
    totalCommits: page.totalCommits,
    truncated: page.truncated,
    snapshotKey: page.snapshotKey,
  };
}

function toGraphRowMessage(row: GraphRow): GraphRowMessage {
  if (row.kind === "commit")
    return {
      ...row,
      parents: [...row.parents],
      lanes: row.lanes.map((lane) => ({ ...lane })),
      nextLanes: row.nextLanes.map((lane) => ({ ...lane })),
      edges: row.edges.map((edge) => ({ ...edge })),
      references: row.references.map((reference) => ({ ...reference })),
    };
  if (row.kind === "wip")
    return {
      ...row,
      lanes: row.lanes.map((lane) => ({ ...lane })),
    };
  return {
    ...row,
    worktree: { ...row.worktree },
    lanes: row.lanes.map((lane) => ({ ...lane })),
  };
}

function toGraphMinimapBucketMessage(
  bucket: GraphMinimapBucket,
): GraphMinimapBucketMessage {
  return {
    ...bucket,
    colorCounts: [...bucket.colorCounts],
  };
}

function repositoryRootPath(
  repositoryRoot: string | GraphRepositoryRoot,
): string {
  return typeof repositoryRoot === "string"
    ? repositoryRoot
    : repositoryRoot.fsPath;
}

function branchNameFromReference(
  referenceName: string | undefined,
): string | undefined {
  if (referenceName === undefined || referenceName === "HEAD") return undefined;
  return referenceName.replace(/^refs\/heads\//u, "");
}

function throwIfRuntimeCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("Commit graph request cancelled", "AbortError");
}

function awaitWithRuntimeCancellation<T>(
  sharedPromise: Promise<T>,
  cancellationSignal: AbortSignal,
): Promise<T> {
  if (cancellationSignal.aborted)
    return Promise.reject(createRuntimeCancellationError());
  return new Promise<T>((resolve, reject) => {
    const abortHandler = (): void => {
      cleanup();
      reject(createRuntimeCancellationError());
    };
    const cleanup = (): void =>
      cancellationSignal.removeEventListener("abort", abortHandler);
    cancellationSignal.addEventListener("abort", abortHandler, { once: true });
    void sharedPromise.then(
      (result) => {
        cleanup();
        if (cancellationSignal.aborted)
          reject(createRuntimeCancellationError());
        else resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function createRuntimeCancellationError(): Error {
  const cancellationError = new Error("Commit graph request cancelled");
  cancellationError.name = "AbortError";
  return cancellationError;
}
