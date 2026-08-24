import type * as vscode from "vscode";

import type {
  GraphChangedLineMetricsMessage,
  GraphFilterMessage,
  GraphMinimapBucketMessage,
  GraphPageMessage,
  GraphSummaryMessage,
} from "../../protocol/graphExperienceProtocol.js";

export interface GraphPageRequest {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly filter: GraphFilterMessage;
  readonly includeWip: boolean;
  readonly includeWorktrees: boolean;
}

export interface GraphMinimapRequest {
  readonly bucketCount: number;
  readonly filter: GraphFilterMessage;
  readonly includeWip: boolean;
  readonly includeWorktrees: boolean;
}

/**
 * The controller deliberately depends on a paged, cooperative reader. An
 * extension host adapter must keep synchronous graph layout off the UI call
 * path (worker or incremental reader) and honour the signal between chunks.
 */
export interface GraphExperienceDataSource {
  readonly getSummary: (
    cancellationSignal: AbortSignal,
  ) => Promise<GraphSummaryMessage>;
  readonly queryPage: (
    request: GraphPageRequest,
    cancellationSignal: AbortSignal,
  ) => Promise<GraphPageMessage>;
  readonly getMinimap: (
    request: GraphMinimapRequest,
    cancellationSignal: AbortSignal,
  ) => Promise<readonly GraphMinimapBucketMessage[]>;
  readonly getChangedLineMetrics: (
    commitSha: string,
    cancellationSignal: AbortSignal,
  ) => Promise<GraphChangedLineMetricsMessage | undefined>;
}

/** Actions are adapters to existing diff/compare/operation services. */
export interface GraphExperienceActions {
  readonly openCommit: (
    commitSha: string,
    cancellationSignal: AbortSignal,
  ) => Promise<void>;
  readonly openDiff: (
    commitSha: string,
    cancellationSignal: AbortSignal,
  ) => Promise<void>;
  readonly compareWithParent: (
    commitSha: string,
    cancellationSignal: AbortSignal,
    parentSha?: string,
  ) => Promise<void>;
  readonly checkoutReference: (
    referenceName: string,
    cancellationSignal: AbortSignal,
  ) => Promise<void>;
  readonly showBranchStatus: (
    referenceName: string,
    cancellationSignal: AbortSignal,
  ) => Promise<void>;
}

/** Exact repository identity carried into every graph action adapter. */
export interface GraphActionContext {
  readonly repositoryRoot: vscode.Uri;
  readonly repositoryGeneration: string;
  readonly cancellationSignal: AbortSignal;
  /** Revalidates repository identity immediately before/after service work. */
  readonly assertCurrent?: () => void | Promise<void>;
}

export interface GraphActionContextProvider {
  getContext(
    cancellationSignal: AbortSignal,
  ): GraphActionContext | Promise<GraphActionContext>;
}

/** Typed seams for existing diff, compare, and operation services. */
export interface GraphExperienceTypedActions {
  readonly openCommit: (
    context: GraphActionContext,
    commitSha: string,
  ) => Promise<void>;
  readonly openDiff: (
    context: GraphActionContext,
    commitSha: string,
  ) => Promise<void>;
  readonly compareWithParent: (
    context: GraphActionContext,
    commitSha: string,
    parentSha?: string,
  ) => Promise<void>;
  readonly checkoutReference: (
    context: GraphActionContext,
    referenceName: string,
  ) => Promise<void>;
  readonly showBranchStatus: (
    context: GraphActionContext,
    referenceName: string,
  ) => Promise<void>;
}

export interface GraphExperienceDependencies {
  readonly dataSource: GraphExperienceDataSource;
  readonly actions: GraphExperienceActions;
  /** Reveals the panel for the graph command; injected by composition. */
  readonly openPanel?: () => void | Promise<void>;
}

export interface GraphExperienceCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}

export const graphExperienceCommandIds = {
  open: "gito.graph.open",
} as const;

export interface GraphExperienceControllerLike {
  dispose(): void;
  registerCommands(
    commandRegistry?: GraphExperienceCommandRegistry,
  ): readonly vscode.Disposable[];
}
