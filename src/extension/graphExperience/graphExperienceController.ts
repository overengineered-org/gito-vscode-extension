import {
  graphChangedLineMetricsSchema,
  graphExtensionToWebviewMessageSchema,
  graphMinimapBucketSchema,
  graphPageSchema,
  graphSummarySchema,
  graphWebviewToExtensionMessageSchema,
  gitoProtocolVersion,
  type GraphAction,
  type GraphExtensionToWebviewMessage,
  type GraphOperationScope,
  type GraphWebviewToExtensionMessage,
} from "../../protocol/graphExperienceProtocol.js";
import type * as vscode from "vscode";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";
import type {
  GraphExperienceActions,
  GraphExperienceCommandRegistry,
  GraphExperienceControllerLike,
  GraphExperienceDependencies,
  GraphMinimapRequest,
  GraphPageRequest,
} from "./graphExperienceModels.js";
import { graphExperienceCommandIds } from "./graphExperienceModels.js";
import { isSafeGraphCheckoutTarget } from "./graphExperienceRuntime.js";

interface ActiveGraphRequest {
  readonly requestId: number;
  readonly generation: number;
  readonly abortController: AbortController;
}

function isCancellation(
  error: unknown,
  cancellationSignal: AbortSignal,
): boolean {
  return (
    cancellationSignal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        /cancelled|canceled/iu.test(error.message)))
  );
}

function toSafeUserMessage(error: unknown): string {
  return formatGitErrorForUser(
    error,
    "The graph operation could not be completed.",
  );
}

function throwIfCancelled(cancellationSignal: AbortSignal): void {
  if (cancellationSignal.aborted) {
    const cancellationError = new Error("Graph operation cancelled.");
    cancellationError.name = "AbortError";
    throw cancellationError;
  }
}

/** Yield before provider work so a user cancellation can be observed. */
function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Transport-safe graph controller. It owns cancellation and schemas; it does
 * not call CommitGraphQueryEngine directly. Host adapters must provide pages
 * from a worker or another incremental reader.
 */
export class GraphExperienceController implements GraphExperienceControllerLike {
  private readonly activeRequests = new Map<number, ActiveGraphRequest>();
  private readonly registeredDisposables: vscode.Disposable[] = [];
  private requestGeneration = 0;
  private disposed = false;

  public constructor(
    private readonly dependencies: GraphExperienceDependencies,
  ) {}

  public registerCommands(
    commandRegistry?: GraphExperienceCommandRegistry,
  ): readonly vscode.Disposable[] {
    if (this.disposed || commandRegistry === undefined) return [];
    if (this.registeredDisposables.length > 0)
      return [...this.registeredDisposables];
    const command = commandRegistry.registerCommand(
      graphExperienceCommandIds.open,
      () => this.dependencies.openPanel?.(),
    );
    this.registeredDisposables.push(command);
    return [...this.registeredDisposables];
  }

  public async handleMessage(
    untrustedMessage: unknown,
  ): Promise<GraphExtensionToWebviewMessage | undefined> {
    if (this.disposed) return undefined;
    const parsedMessage =
      graphWebviewToExtensionMessageSchema.safeParse(untrustedMessage);
    if (!parsedMessage.success) return undefined;
    return this.handleParsedMessage(parsedMessage.data);
  }

  public cancel(requestId: number): void {
    this.activeRequests.get(requestId)?.abortController.abort();
    this.activeRequests.delete(requestId);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const activeRequest of this.activeRequests.values())
      activeRequest.abortController.abort();
    this.activeRequests.clear();
    for (const disposable of this.registeredDisposables.splice(0))
      disposable.dispose();
  }

  private async handleParsedMessage(
    message: GraphWebviewToExtensionMessage,
  ): Promise<GraphExtensionToWebviewMessage | undefined> {
    switch (message.messageType) {
      case "graphReady":
        return this.loadSummary();
      case "graphQuery":
        return this.loadPage(message);
      case "graphMinimap":
        return this.loadMinimap(message);
      case "graphMetrics":
        return this.loadMetrics(message);
      case "graphCancel":
        this.cancel(message.requestId);
        return undefined;
      case "graphAction":
        return this.runAction(message);
    }
  }

  private async loadSummary(): Promise<
    GraphExtensionToWebviewMessage | undefined
  > {
    const activeRequest = this.beginRequest(0);
    try {
      await yieldToExtensionHost();
      throwIfCancelled(activeRequest.abortController.signal);
      const summary = await this.dependencies.dataSource.getSummary(
        activeRequest.abortController.signal,
      );
      throwIfCancelled(activeRequest.abortController.signal);
      const parsedSummary = graphSummarySchema.safeParse(summary);
      if (!parsedSummary.success)
        return this.failure(
          undefined,
          "The graph summary was invalid.",
          "summary",
        );
      return {
        protocolVersion: gitoProtocolVersion,
        messageType: "graphReady",
        summary: parsedSummary.data,
      };
    } catch (error: unknown) {
      if (isCancellation(error, activeRequest.abortController.signal))
        return undefined;
      return this.failure(undefined, toSafeUserMessage(error), "summary");
    } finally {
      this.finishRequest(activeRequest);
    }
  }

  private async loadPage(
    message: Extract<
      GraphWebviewToExtensionMessage,
      { messageType: "graphQuery" }
    >,
  ): Promise<GraphExtensionToWebviewMessage | undefined> {
    const activeRequest = this.beginRequest(message.requestId);
    const pageRequest: GraphPageRequest = {
      ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
      pageSize: message.pageSize,
      filter: message.filter,
      includeWip: message.includeWip,
      includeWorktrees: message.includeWorktrees,
    };
    try {
      await yieldToExtensionHost();
      throwIfCancelled(activeRequest.abortController.signal);
      const page = await this.dependencies.dataSource.queryPage(
        pageRequest,
        activeRequest.abortController.signal,
      );
      throwIfCancelled(activeRequest.abortController.signal);
      const parsedPage = graphPageSchema.safeParse(page);
      if (!parsedPage.success)
        return this.failure(
          message.requestId,
          "The graph page was invalid.",
          "query",
        );
      return {
        protocolVersion: gitoProtocolVersion,
        messageType: "graphPageLoaded",
        requestId: message.requestId,
        append: message.append,
        page: parsedPage.data,
      };
    } catch (error: unknown) {
      if (isCancellation(error, activeRequest.abortController.signal))
        return undefined;
      return this.failure(message.requestId, toSafeUserMessage(error), "query");
    } finally {
      this.finishRequest(activeRequest);
    }
  }

  private async loadMinimap(
    message: Extract<
      GraphWebviewToExtensionMessage,
      { messageType: "graphMinimap" }
    >,
  ): Promise<GraphExtensionToWebviewMessage | undefined> {
    const activeRequest = this.beginRequest(message.requestId);
    const minimapRequest: GraphMinimapRequest = {
      bucketCount: message.bucketCount,
      filter: message.filter,
      includeWip: message.includeWip,
      includeWorktrees: message.includeWorktrees,
    };
    try {
      await yieldToExtensionHost();
      throwIfCancelled(activeRequest.abortController.signal);
      const buckets = await this.dependencies.dataSource.getMinimap(
        minimapRequest,
        activeRequest.abortController.signal,
      );
      throwIfCancelled(activeRequest.abortController.signal);
      const parsedBuckets = graphMinimapBucketSchema
        .array()
        .max(240)
        .safeParse(buckets);
      if (!parsedBuckets.success)
        return this.failure(
          message.requestId,
          "The graph minimap was invalid.",
          "minimap",
        );
      return {
        protocolVersion: gitoProtocolVersion,
        messageType: "graphMinimapLoaded",
        requestId: message.requestId,
        buckets: parsedBuckets.data,
      };
    } catch (error: unknown) {
      if (isCancellation(error, activeRequest.abortController.signal))
        return undefined;
      return this.failure(
        message.requestId,
        toSafeUserMessage(error),
        "minimap",
      );
    } finally {
      this.finishRequest(activeRequest);
    }
  }

  private async loadMetrics(
    message: Extract<
      GraphWebviewToExtensionMessage,
      { messageType: "graphMetrics" }
    >,
  ): Promise<GraphExtensionToWebviewMessage | undefined> {
    const activeRequest = this.beginRequest(message.requestId);
    try {
      await yieldToExtensionHost();
      throwIfCancelled(activeRequest.abortController.signal);
      const metrics = await this.dependencies.dataSource.getChangedLineMetrics(
        message.commitSha,
        activeRequest.abortController.signal,
      );
      throwIfCancelled(activeRequest.abortController.signal);
      const parsedMetrics = graphChangedLineMetricsSchema
        .nullable()
        .safeParse(metrics ?? null);
      if (!parsedMetrics.success)
        return this.failure(
          message.requestId,
          "Commit metrics were invalid.",
          "metrics",
        );
      return {
        protocolVersion: gitoProtocolVersion,
        messageType: "graphMetricsLoaded",
        requestId: message.requestId,
        metrics: parsedMetrics.data,
      };
    } catch (error: unknown) {
      if (isCancellation(error, activeRequest.abortController.signal))
        return undefined;
      return this.failure(
        message.requestId,
        toSafeUserMessage(error),
        "metrics",
      );
    } finally {
      this.finishRequest(activeRequest);
    }
  }

  private async runAction(
    message: Extract<
      GraphWebviewToExtensionMessage,
      { messageType: "graphAction" }
    >,
  ): Promise<GraphExtensionToWebviewMessage | undefined> {
    const activeRequest = this.beginRequest(message.requestId);
    const actionTarget = this.readActionTarget(message.action, message);
    if (actionTarget === undefined) {
      this.finishRequest(activeRequest);
      return this.failure(
        message.requestId,
        "Select a commit or reference before running this action.",
        "action",
      );
    }
    try {
      await yieldToExtensionHost();
      throwIfCancelled(activeRequest.abortController.signal);
      await this.invokeAction(
        message.action,
        actionTarget,
        activeRequest.abortController.signal,
      );
      throwIfCancelled(activeRequest.abortController.signal);
      return {
        protocolVersion: gitoProtocolVersion,
        messageType: "graphActionCompleted",
        requestId: message.requestId,
        action: message.action,
        announcement: `${this.actionLabel(message.action)} completed.`,
      };
    } catch (error: unknown) {
      if (isCancellation(error, activeRequest.abortController.signal))
        return undefined;
      return this.failure(
        message.requestId,
        toSafeUserMessage(error),
        "action",
      );
    } finally {
      this.finishRequest(activeRequest);
    }
  }

  private readActionTarget(
    action: GraphAction,
    message: Extract<
      GraphWebviewToExtensionMessage,
      { messageType: "graphAction" }
    >,
  ):
    | {
        readonly kind: "commit" | "reference";
        readonly value: string;
        readonly parentSha?: string;
      }
    | undefined {
    if (
      (action === "openCommit" ||
        action === "openDiff" ||
        action === "compareWithParent") &&
      message.commitSha !== undefined
    )
      return {
        kind: "commit",
        value: message.commitSha,
        ...(message.parentSha === undefined
          ? {}
          : { parentSha: message.parentSha }),
      };
    if (
      (action === "checkoutReference" || action === "showBranchStatus") &&
      message.referenceName !== undefined &&
      isSafeGraphCheckoutTarget(message.referenceName)
    )
      return { kind: "reference", value: message.referenceName };
    return undefined;
  }

  private invokeAction(
    action: GraphAction,
    target: {
      readonly kind: "commit" | "reference";
      readonly value: string;
      readonly parentSha?: string;
    },
    cancellationSignal: AbortSignal,
  ): Promise<void> {
    const actions: GraphExperienceActions = this.dependencies.actions;
    if (action === "openCommit")
      return actions.openCommit(target.value, cancellationSignal);
    if (action === "openDiff")
      return actions.openDiff(target.value, cancellationSignal);
    if (action === "compareWithParent")
      return actions.compareWithParent(
        target.value,
        cancellationSignal,
        target.parentSha,
      );
    if (action === "checkoutReference")
      return actions.checkoutReference(target.value, cancellationSignal);
    return actions.showBranchStatus(target.value, cancellationSignal);
  }

  private actionLabel(action: GraphAction): string {
    return {
      openCommit: "Open commit",
      openDiff: "Open diff",
      compareWithParent: "Compare with parent",
      checkoutReference: "Checkout reference",
      showBranchStatus: "Show branch status",
    }[action];
  }

  private beginRequest(requestId: number): ActiveGraphRequest {
    this.cancel(requestId);
    const activeRequest: ActiveGraphRequest = {
      requestId,
      generation: ++this.requestGeneration,
      abortController: new AbortController(),
    };
    this.activeRequests.set(requestId, activeRequest);
    return activeRequest;
  }

  private finishRequest(activeRequest: ActiveGraphRequest): void {
    if (this.activeRequests.get(activeRequest.requestId) === activeRequest)
      this.activeRequests.delete(activeRequest.requestId);
  }

  private failure(
    requestId: number | undefined,
    userMessage: string,
    operation: GraphOperationScope,
  ): GraphExtensionToWebviewMessage {
    const parsedFailure = graphExtensionToWebviewMessageSchema.safeParse({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphOperationFailed",
      ...(requestId === undefined ? {} : { requestId }),
      operation,
      userMessage,
    });
    if (!parsedFailure.success)
      return {
        protocolVersion: gitoProtocolVersion,
        messageType: "graphOperationFailed",
        operation,
        userMessage: "The graph operation could not be completed.",
      };
    return parsedFailure.data;
  }
}
