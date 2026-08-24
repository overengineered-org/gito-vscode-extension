import * as vscode from "vscode";
import type {
  PullRequestDetails,
  PullRequestIdentity,
} from "../../domain/pullRequest.js";
import {
  extensionToWebviewMessageSchema,
  gitoProtocolVersion,
  pullRequestDetailsSchema,
  repositoryHomeSnapshotSchema,
  webviewToExtensionMessageSchema,
  type RepositoryHomeFocusTarget,
  type RepositoryHomeSnapshot,
  type PullRequestDetails as ProtocolPullRequestDetails,
  type PullRequestIdentity as ProtocolPullRequestIdentity,
  type WebviewToExtensionMessage,
} from "../../protocol/repositoryHomeProtocol.js";
import {
  createContentSecurityNonce,
  escapeHtmlAttribute,
} from "../security/webviewSecurity.js";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";

/**
 * The webview host owns transport and lifecycle concerns. Repository data and
 * provider sessions stay behind this boundary in the extension host.
 *
 * Every method is required deliberately. A panel cannot silently turn a
 * user action into a no-op because a callback was omitted at activation.
 */
export interface RepositoryHomeController {
  readonly getSnapshot: () => RepositoryHomeSnapshot;
  readonly subscribe: (
    listener: (snapshot: RepositoryHomeSnapshot) => void,
  ) => vscode.Disposable;
  readonly cancelPendingRequests: () => void;
  readonly load: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly selectRepository: (repositoryRoot: string) => Promise<void>;
  readonly setProviderFilter: (
    providerFilter: RepositoryHomeSnapshot["providerFilter"],
  ) => void;
  readonly connectProvider: (providerId: "github") => Promise<void>;
  readonly disconnectProvider: (providerId: "github") => void;
  readonly getPullRequestDetails: (
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal: AbortSignal,
  ) => Promise<PullRequestDetails>;
  readonly checkoutPullRequest: (
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal: AbortSignal,
  ) => Promise<void>;
  readonly openExternalPullRequest: (
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal: AbortSignal,
  ) => Promise<void>;
}

interface ActiveOperation {
  readonly generation: number;
  readonly abortController: AbortController;
  readonly pullRequestIdentity?: PullRequestIdentity;
  readonly snapshotGeneration: number;
}

const operationAnnouncements = {
  ready: "Repository dashboard loaded.",
  refreshDashboard: "Repository dashboard refreshed.",
  selectRepository: "Repository selected.",
  setProviderFilter: "Provider filter updated.",
  connectProvider: "Provider connected.",
  disconnectProvider: "Provider disconnected.",
  openPullRequestDetails: "Pull request details loaded.",
  checkoutPullRequest: "Pull request branch checked out.",
  openExternalPullRequest: "Pull request page opened.",
} as const;

export class RepositoryHomePanel implements vscode.WebviewPanelSerializer {
  private repositoryHomePanel: vscode.WebviewPanel | undefined;
  private panelDisposeSubscription: vscode.Disposable | undefined;
  private messageSubscription: vscode.Disposable | undefined;
  private controllerSubscription: vscode.Disposable | undefined;
  private activeOperation: ActiveOperation | undefined;
  private operationGeneration = 0;
  private latestSnapshotGeneration = -1;
  private pendingFocusTarget: RepositoryHomeFocusTarget | undefined;
  private disposed = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: RepositoryHomeController,
  ) {}

  public revealOrCreate(focusTarget?: RepositoryHomeFocusTarget): void {
    if (this.disposed) return;
    if (focusTarget !== undefined) this.pendingFocusTarget = focusTarget;
    if (this.repositoryHomePanel !== undefined) {
      this.repositoryHomePanel.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    const repositoryHomePanel = vscode.window.createWebviewPanel(
      "gito.repositoryHome",
      "Repository Home",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableCommandUris: ["gito.onboarding.openOrChooseRepository"],
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );
    this.configurePanel(repositoryHomePanel);
  }

  /** Open Home and resolve only after its selected local repository has loaded. */
  public async revealAndWaitForLoad(
    focusTarget?: RepositoryHomeFocusTarget,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error(
        "Repository Home is unavailable because Git'o was disposed.",
      );
    }
    this.revealOrCreate(focusTarget);
    try {
      await this.controller.load();
    } catch (error: unknown) {
      this.pendingFocusTarget = undefined;
      throw error;
    }
    const loadedSnapshot = this.controller.getSnapshot();
    if (loadedSnapshot.selectedRepository === null) {
      this.pendingFocusTarget = undefined;
      throw new Error("Open a local Git repository before opening Git'o Home.");
    }
    const requestedFocusTarget = this.pendingFocusTarget;
    this.postSnapshot(loadedSnapshot, requestedFocusTarget);
    this.pendingFocusTarget = undefined;
  }

  public deserializeWebviewPanel(
    repositoryHomePanel: vscode.WebviewPanel,
  ): Promise<void> {
    if (this.disposed) {
      repositoryHomePanel.dispose();
      return Promise.resolve();
    }
    this.configurePanel(repositoryHomePanel);
    return Promise.resolve();
  }

  public async refresh(): Promise<void> {
    if (this.disposed) return;
    this.revealOrCreate();
    await this.dispatchControllerOperation("refreshDashboard", () =>
      this.controller.refresh(),
    );
  }

  /** Dispose this panel host. The controller lifecycle remains activation-owned. */
  public dispose(): void {
    if (this.disposed) return;
    this.cancelActiveOperation();
    this.disposed = true;
    this.disposePanelSubscriptions();
    const repositoryHomePanel = this.repositoryHomePanel;
    this.repositoryHomePanel = undefined;
    repositoryHomePanel?.dispose();
  }

  private configurePanel(repositoryHomePanel: vscode.WebviewPanel): void {
    this.disposePanelSubscriptions();
    this.repositoryHomePanel = repositoryHomePanel;
    repositoryHomePanel.webview.html = this.createWebviewHtml(
      repositoryHomePanel.webview,
    );
    this.controllerSubscription = this.controller.subscribe((snapshot) => {
      this.postSnapshot(snapshot);
    });
    this.panelDisposeSubscription = repositoryHomePanel.onDidDispose(() => {
      if (this.repositoryHomePanel !== repositoryHomePanel) return;
      this.cancelActiveOperation();
      this.pendingFocusTarget = undefined;
      this.disposePanelSubscriptions();
      this.repositoryHomePanel = undefined;
    });
    this.messageSubscription = repositoryHomePanel.webview.onDidReceiveMessage(
      (untrustedMessage: unknown) => {
        void this.handleWebviewMessage(untrustedMessage);
      },
    );
  }

  private async handleWebviewMessage(untrustedMessage: unknown): Promise<void> {
    if (this.disposed || this.repositoryHomePanel === undefined) return;
    const parsedMessage =
      webviewToExtensionMessageSchema.safeParse(untrustedMessage);
    if (!parsedMessage.success) return;
    const message = parsedMessage.data;
    switch (message.messageType) {
      case "ready":
        await this.dispatchControllerOperation("ready", () =>
          this.controller.load(),
        );
        return;
      case "refreshDashboard":
        await this.dispatchControllerOperation("refreshDashboard", () =>
          this.controller.refresh(),
        );
        return;
      case "selectRepository":
        await this.dispatchControllerOperation("selectRepository", () =>
          this.controller.selectRepository(message.repositoryRoot),
        );
        return;
      case "setProviderFilter":
        await this.dispatchControllerOperation("setProviderFilter", () => {
          this.controller.setProviderFilter(message.providerFilter);
        });
        return;
      case "connectProvider":
        await this.dispatchControllerOperation("connectProvider", () =>
          this.controller.connectProvider(message.providerId),
        );
        return;
      case "disconnectProvider":
        await this.dispatchControllerOperation("disconnectProvider", () => {
          this.controller.disconnectProvider(message.providerId);
        });
        return;
      case "openPullRequestDetails":
        await this.dispatchPullRequestDetails(
          toDomainPullRequestIdentity(message.pullRequestIdentity),
        );
        return;
      case "checkoutPullRequest":
        await this.dispatchControllerOperation(
          "checkoutPullRequest",
          (signal) =>
            this.controller.checkoutPullRequest(
              toDomainPullRequestIdentity(message.pullRequestIdentity),
              signal,
            ),
        );
        return;
      case "openExternalPullRequest":
        await this.dispatchControllerOperation(
          "openExternalPullRequest",
          (signal) =>
            this.controller.openExternalPullRequest(
              toDomainPullRequestIdentity(message.pullRequestIdentity),
              signal,
            ),
        );
        return;
    }
  }

  private async dispatchPullRequestDetails(
    pullRequestIdentity: PullRequestIdentity,
  ): Promise<void> {
    if (this.disposed || this.repositoryHomePanel === undefined) return;
    const activeOperation = this.beginOperation(pullRequestIdentity);
    try {
      const pullRequestDetails = await this.controller.getPullRequestDetails(
        pullRequestIdentity,
        activeOperation.abortController.signal,
      );
      if (!this.isCurrentOperation(activeOperation)) return;
      const parsedDetails =
        pullRequestDetailsSchema.safeParse(pullRequestDetails);
      if (
        !parsedDetails.success ||
        !pullRequestIdentityMatchesDetails(
          pullRequestIdentity,
          toDomainPullRequestDetails(parsedDetails.data),
        )
      ) {
        this.postOperationFailed(
          "openPullRequestDetails",
          "The pull request details were invalid.",
        );
        return;
      }
      const normalizedPullRequestDetails = toDomainPullRequestDetails(
        parsedDetails.data,
      );
      this.postPullRequestDetailsLoaded(
        pullRequestIdentity,
        normalizedPullRequestDetails,
        activeOperation.generation,
      );
      this.postSnapshot(this.controller.getSnapshot());
      this.postOperationCompleted(
        "openPullRequestDetails",
        operationAnnouncements.openPullRequestDetails,
      );
    } catch (error: unknown) {
      if (!this.isCurrentOperation(activeOperation)) return;
      if (isCancellation(error, activeOperation.abortController.signal)) return;
      this.postOperationFailed(
        "openPullRequestDetails",
        toSafeUserMessage(error),
      );
    } finally {
      if (this.isCurrentOperation(activeOperation))
        this.activeOperation = undefined;
    }
  }

  private async dispatchControllerOperation(
    operationName: WebviewToExtensionMessage["messageType"],
    operation: (cancellationSignal: AbortSignal) => void | Promise<void>,
  ): Promise<void> {
    if (this.disposed || this.repositoryHomePanel === undefined) return;
    const activeOperation = this.beginOperation();
    try {
      await operation(activeOperation.abortController.signal);
      if (!this.isCurrentOperation(activeOperation)) return;
      const requestedFocusTarget =
        operationName === "ready" ? this.pendingFocusTarget : undefined;
      this.postSnapshot(this.controller.getSnapshot(), requestedFocusTarget);
      if (requestedFocusTarget !== undefined)
        this.pendingFocusTarget = undefined;
      this.postOperationCompleted(
        operationName,
        requestedFocusTarget === "pullRequests"
          ? "Pull requests section focused."
          : (operationAnnouncements[operationName] ?? "Operation completed."),
      );
    } catch (error: unknown) {
      if (!this.isCurrentOperation(activeOperation)) return;
      if (isCancellation(error, activeOperation.abortController.signal)) return;
      this.postOperationFailed(operationName, toSafeUserMessage(error));
    } finally {
      if (this.isCurrentOperation(activeOperation))
        this.activeOperation = undefined;
    }
  }

  private beginOperation(
    pullRequestIdentity?: PullRequestIdentity,
  ): ActiveOperation {
    this.cancelActiveOperation();
    const activeOperation: ActiveOperation = {
      generation: ++this.operationGeneration,
      abortController: new AbortController(),
      ...(pullRequestIdentity === undefined ? {} : { pullRequestIdentity }),
      snapshotGeneration: this.latestSnapshotGeneration,
    };
    this.activeOperation = activeOperation;
    return activeOperation;
  }

  private cancelActiveOperation(): void {
    this.activeOperation?.abortController.abort();
    this.activeOperation = undefined;
    this.operationGeneration += 1;
    if (!this.disposed) {
      try {
        this.controller.cancelPendingRequests();
      } catch {
        // A controller may already be activation-disposed while the panel closes.
      }
    }
  }

  private isCurrentOperation(activeOperation: ActiveOperation): boolean {
    return (
      !this.disposed &&
      this.activeOperation === activeOperation &&
      this.operationGeneration === activeOperation.generation &&
      !activeOperation.abortController.signal.aborted &&
      this.repositoryHomePanel !== undefined
    );
  }

  private disposePanelSubscriptions(): void {
    this.controllerSubscription?.dispose();
    this.controllerSubscription = undefined;
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.panelDisposeSubscription?.dispose();
    this.panelDisposeSubscription = undefined;
  }

  private postSnapshot(
    snapshot: RepositoryHomeSnapshot,
    focusTarget?: RepositoryHomeFocusTarget,
  ): void {
    const parsedSnapshot = repositoryHomeSnapshotSchema.safeParse(snapshot);
    if (!parsedSnapshot.success) {
      this.postOperationFailed(
        "repositoryHomeChanged",
        "The repository dashboard returned an invalid snapshot.",
      );
      return;
    }
    const activePullRequestDetails = this.activeOperation?.pullRequestIdentity;
    if (
      activePullRequestDetails !== undefined &&
      parsedSnapshot.data.requestGeneration > this.latestSnapshotGeneration &&
      (!snapshotContainsPullRequest(
        parsedSnapshot.data,
        activePullRequestDetails,
      ) ||
        this.activeOperation?.snapshotGeneration !==
          parsedSnapshot.data.requestGeneration)
    )
      this.cancelActiveOperation();
    if (parsedSnapshot.data.requestGeneration < this.latestSnapshotGeneration)
      return;
    this.latestSnapshotGeneration = parsedSnapshot.data.requestGeneration;
    this.postWebviewMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "repositoryHomeChanged",
      repositoryHomeSnapshot: parsedSnapshot.data,
      ...(focusTarget === undefined ? {} : { focusTarget }),
    });
  }

  private postOperationCompleted(
    operationName: string,
    announcement: string,
  ): void {
    this.postWebviewMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "operationCompleted",
      operationName,
      announcement,
    });
  }

  private postOperationFailed(
    operationName: string,
    userMessage: string,
  ): void {
    this.postWebviewMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "operationFailed",
      operationName,
      userMessage,
    });
  }

  private postPullRequestDetailsLoaded(
    pullRequestIdentity: PullRequestIdentity,
    pullRequestDetails: PullRequestDetails,
    requestGeneration: number,
  ): void {
    const parsedMessage = extensionToWebviewMessageSchema.safeParse({
      protocolVersion: gitoProtocolVersion,
      messageType: "pullRequestDetailsLoaded",
      requestGeneration,
      pullRequestIdentity,
      pullRequestDetails,
    });
    if (!parsedMessage.success) {
      this.postOperationFailed(
        "openPullRequestDetails",
        "The pull request details were invalid.",
      );
      return;
    }
    this.postWebviewMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "pullRequestDetailsLoaded",
      requestGeneration,
      pullRequestIdentity,
      pullRequestDetails,
    });
  }

  private postWebviewMessage(
    message:
      | {
          readonly protocolVersion: typeof gitoProtocolVersion;
          readonly messageType: "repositoryHomeChanged";
          readonly repositoryHomeSnapshot: RepositoryHomeSnapshot;
          readonly focusTarget?: RepositoryHomeFocusTarget;
        }
      | {
          readonly protocolVersion: typeof gitoProtocolVersion;
          readonly messageType: "operationCompleted";
          readonly operationName: string;
          readonly announcement: string;
        }
      | {
          readonly protocolVersion: typeof gitoProtocolVersion;
          readonly messageType: "operationFailed";
          readonly operationName: string;
          readonly userMessage: string;
        }
      | {
          readonly protocolVersion: typeof gitoProtocolVersion;
          readonly messageType: "pullRequestDetailsLoaded";
          readonly requestGeneration: number;
          readonly pullRequestIdentity: PullRequestIdentity;
          readonly pullRequestDetails: PullRequestDetails;
        },
  ): void {
    const webview = this.repositoryHomePanel?.webview;
    if (webview === undefined) return;
    void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
  }

  private createWebviewHtml(webview: vscode.Webview): string {
    const contentSecurityNonce = createContentSecurityNonce();
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const webviewStylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"),
    );
    const escapedCspSource = escapeHtmlAttribute(webview.cspSource);
    const escapedScriptUri = escapeHtmlAttribute(webviewScriptUri.toString());
    const escapedStylesheetUri = escapeHtmlAttribute(
      webviewStylesheetUri.toString(),
    );
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; connect-src 'none'; style-src ${escapedCspSource}; font-src ${escapedCspSource}; script-src 'nonce-${contentSecurityNonce}';"><link rel="stylesheet" href="${escapedStylesheetUri}"><title>Repository Home</title></head><body><div id="gito-root"></div><script nonce="${contentSecurityNonce}" src="${escapedScriptUri}"></script></body></html>`;
  }
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
  return formatGitErrorForUser(error, "The operation could not be completed.");
}

function snapshotContainsPullRequest(
  snapshot: RepositoryHomeSnapshot,
  pullRequestIdentity: PullRequestIdentity,
): boolean {
  const selectedRepository = snapshot.selectedRepository;
  if (selectedRepository === null) return false;
  if (
    snapshot.providerFilter !== "all" &&
    snapshot.providerFilter !== pullRequestIdentity.providerId
  )
    return false;
  return selectedRepository.cloudDashboards.some(
    (cloudDashboard) =>
      cloudDashboard.providerId === pullRequestIdentity.providerId &&
      cloudDashboard.pullRequests.some(
        (pullRequest) =>
          pullRequest.repositoryOwner === pullRequestIdentity.repositoryOwner &&
          pullRequest.repositoryName === pullRequestIdentity.repositoryName &&
          (pullRequest.repositoryProject ?? undefined) ===
            (pullRequestIdentity.repositoryProject ?? undefined) &&
          pullRequest.pullRequestNumber ===
            pullRequestIdentity.pullRequestNumber,
      ),
  );
}

function pullRequestIdentityMatchesDetails(
  pullRequestIdentity: PullRequestIdentity,
  pullRequestDetails: PullRequestDetails,
): boolean {
  return (
    pullRequestIdentity.providerId === pullRequestDetails.providerId &&
    pullRequestIdentity.repositoryOwner ===
      pullRequestDetails.repositoryOwner &&
    pullRequestIdentity.repositoryName === pullRequestDetails.repositoryName &&
    (pullRequestIdentity.repositoryProject ?? undefined) ===
      (pullRequestDetails.repositoryProject ?? undefined) &&
    pullRequestIdentity.pullRequestNumber ===
      pullRequestDetails.pullRequestNumber
  );
}

function toDomainPullRequestIdentity(
  protocolPullRequestIdentity: ProtocolPullRequestIdentity,
): PullRequestIdentity {
  const { repositoryProject, ...identityWithoutProject } =
    protocolPullRequestIdentity;
  return {
    ...identityWithoutProject,
    ...(repositoryProject === undefined ? {} : { repositoryProject }),
  };
}

function toDomainPullRequestDetails(
  protocolPullRequestDetails: ProtocolPullRequestDetails,
): PullRequestDetails {
  const { repositoryProject, ...detailsWithoutProject } =
    protocolPullRequestDetails;
  return {
    ...detailsWithoutProject,
    ...(repositoryProject === undefined ? {} : { repositoryProject }),
  };
}
