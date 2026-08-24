import * as vscode from "vscode";
import type {
  CloudGitProvider,
  CloudProviderId,
  CloudRepositoryIdentity,
  CloudUser,
  ProviderConnection,
  RepositoryDashboardOptions,
} from "../../domain/cloudGitProvider.js";
import type {
  PullRequestDetails,
  PullRequestIdentity,
  PullRequestSummary,
} from "../../domain/pullRequest.js";
import type { RepositoryDashboardSnapshot } from "../../domain/repositoryDashboard.js";
import type { RepositoryHomeSnapshot } from "../../protocol/repositoryHomeProtocol.js";
import { GitHubProviderError } from "../providers/github/githubTypes.js";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";
import { getGitBranchNameValidationMessage } from "../git/gitRefName.js";
import type { LocalGitRepositoryHealthOptions } from "../git/localGitRepositoryService.js";
import {
  DashboardOrchestrationError,
  type DashboardDependencies,
  type DashboardDisposable,
  type DashboardFailureDetails,
  type DashboardLoadOptions,
  type DashboardOrchestratorApi,
  type DashboardRefreshOptions,
  type DashboardSection,
  type DashboardSnapshotListener,
  type DashboardWorkspaceTrustGuard,
} from "./types.js";

const dashboardProviderIds: readonly CloudProviderId[] = ["github"];

const dashboardProviderDisplayNames: Record<CloudProviderId, string> = {
  github: "GitHub",
};

const dashboardSections: readonly DashboardSection[] = [
  "localSummary",
  "commitActivity",
  "github",
];

const defaultActivityDayCount = 371;

interface SelectedRepository {
  readonly repository: Awaited<
    ReturnType<DashboardDependencies["repositoryDiscovery"]["selectRepository"]>
  >;
  readonly repositoryRoot: string;
  readonly repositoryDisplayName: string;
}

interface ProviderState {
  readonly identity: CloudRepositoryIdentity | undefined;
  /** Non-secret session metadata; access tokens stay request-scoped. */
  readonly sessionId?: string;
  readonly connectionState:
    "disconnected" | "connecting" | "connected" | "failed";
  readonly accountDisplayName?: string;
  readonly pullRequests: RepositoryDashboardSnapshot["pullRequests"];
  readonly fetchedAt?: string;
  readonly cacheStatus: RepositoryDashboardSnapshot["cacheStatus"];
  readonly staleReason: RepositoryDashboardSnapshot["staleReason"];
}

interface SectionRequest {
  readonly generation: number;
  readonly repositoryRoot: string | undefined;
  readonly abortController: AbortController;
  cancellationReason:
    "superseded" | "user" | "disconnect" | "dispose" | undefined;
}

/** Current connection state only; credentials and historical setup are excluded. */
export interface DashboardProviderConnectionStateChange {
  readonly providerId: CloudProviderId;
  readonly isConnected: boolean;
}

/**
 * Owns the Repository Home extension-host state. Cloud sessions are acquired
 * only for individual requests; snapshots never carry credentials or raw
 * provider responses.
 */
export class DashboardOrchestrator implements DashboardOrchestratorApi {
  private readonly repositoryDiscovery: DashboardDependencies["repositoryDiscovery"];
  private readonly repositoryService: DashboardDependencies["repositoryService"];
  private readonly historyService: DashboardDependencies["historyService"];
  private readonly providersById: ReadonlyMap<
    CloudProviderId,
    CloudGitProvider
  >;
  private readonly authorEmails: readonly string[];
  private readonly clock: () => Date;
  private readonly workspaceTrustGuard: DashboardWorkspaceTrustGuard;
  private readonly listeners = new Set<DashboardSnapshotListener>();
  private readonly providerConnectionStateListeners = new Set<
    (connectionStateChange: DashboardProviderConnectionStateChange) => void
  >();
  private readonly providerStates = new Map<CloudProviderId, ProviderState>();
  private readonly stableProviderStatesDuringConnect = new Map<
    CloudProviderId,
    ProviderState
  >();
  private readonly sectionRequests = new Map<
    DashboardSection,
    SectionRequest
  >();
  private readonly userCancelledRequests = new Map<
    DashboardSection,
    SectionRequest
  >();
  private readonly detailRequestControllers = new Map<
    AbortController,
    CloudProviderId
  >();
  private readonly lifecycleAbortController = new AbortController();

  private repositories: RepositoryHomeSnapshot["repositories"] = [];
  private repositoryRootUrisByFilesystemPath = new Map<string, vscode.Uri>();
  private selectedRepository: SelectedRepository | undefined;
  private requestGeneration = 0;
  private sectionGeneration = new Map<DashboardSection, number>();
  private providerFilter: RepositoryHomeSnapshot["providerFilter"] = "all";
  private loadingSections = new Set<DashboardSection>();
  private sectionErrors = new Map<DashboardSection, string>();
  private snapshot: RepositoryHomeSnapshot = {
    requestGeneration: 0,
    repositories: [],
    selectedRepository: null,
    providerFilter: "all",
    loadingSections: [],
    sectionErrors: [],
  };
  private disposed = false;

  public constructor(dependencies: DashboardDependencies) {
    this.repositoryDiscovery = dependencies.repositoryDiscovery;
    this.repositoryService = dependencies.repositoryService;
    this.historyService = dependencies.historyService;
    this.authorEmails = [...(dependencies.authorEmails ?? [])];
    this.clock = dependencies.clock ?? (() => new Date());
    this.workspaceTrustGuard = dependencies.workspaceTrustGuard;

    const providerEntries = dependencies.providers.map((provider) => {
      if (!dashboardProviderIds.includes(provider.providerId)) {
        throw new DashboardOrchestrationError(
          `Unsupported dashboard provider: ${provider.providerId}.`,
          {
            code: "providerUnavailable",
            operationName: "create dashboard orchestrator",
            providerId: provider.providerId,
          },
        );
      }
      return [provider.providerId, provider] as const;
    });
    if (
      new Set(providerEntries.map(([providerId]) => providerId)).size !==
      providerEntries.length
    ) {
      throw new DashboardOrchestrationError(
        "Each dashboard provider must be registered once.",
        {
          code: "providerUnavailable",
          operationName: "create dashboard orchestrator",
        },
      );
    }
    this.providersById = new Map(providerEntries);
    for (const providerId of dashboardProviderIds) {
      this.providerStates.set(providerId, {
        identity: undefined,
        connectionState: "disconnected",
        pullRequests: [],
        cacheStatus: undefined,
        staleReason: undefined,
      });
      this.sectionGeneration.set(providerId, 0);
    }
    this.sectionGeneration.set("localSummary", 0);
    this.sectionGeneration.set("commitActivity", 0);
  }

  public getSnapshot(): RepositoryHomeSnapshot {
    return cloneRepositoryHomeSnapshot(this.snapshot);
  }

  public shouldRefreshProviderDashboard(providerId: CloudProviderId): boolean {
    if (this.disposed) return false;
    const provider = this.providersById.get(providerId);
    const providerState = this.providerStates.get(providerId);
    if (
      provider === undefined ||
      providerState === undefined ||
      providerState.identity === undefined ||
      providerState.sessionId === undefined ||
      providerState.connectionState !== "connected"
    ) {
      return false;
    }
    if (providerState.cacheStatus === "stale") return true;
    return (
      provider.isRepositoryDashboardCacheExpired?.(
        providerState.identity,
        providerState.sessionId,
      ) ?? false
    );
  }

  public subscribe(listener: DashboardSnapshotListener): DashboardDisposable {
    if (this.disposed) {
      listener(createEmptyRepositoryHomeSnapshot());
      return new vscode.Disposable(() => undefined);
    }
    this.listeners.add(listener);
    listener(cloneRepositoryHomeSnapshot(this.snapshot));
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  /** Receives transitions of the current provider session state. */
  public onDidChangeProviderConnectionState(
    listener: (
      connectionStateChange: DashboardProviderConnectionStateChange,
    ) => void,
  ): DashboardDisposable {
    this.providerConnectionStateListeners.add(listener);
    return {
      dispose: () => this.providerConnectionStateListeners.delete(listener),
    };
  }

  public async load(options: DashboardLoadOptions = {}): Promise<void> {
    await this.loadDashboard(options, { forceRefresh: false }, {});
  }

  private async loadDashboard(
    options: DashboardLoadOptions,
    requestOptions: RepositoryDashboardOptions,
    localRepositoryOptions: LocalGitRepositoryHealthOptions = {},
  ): Promise<void> {
    this.assertUsable("load dashboard");
    const generation = this.beginLoad();
    if (options.providerFilter !== undefined) {
      this.providerFilter = options.providerFilter;
    }

    let discoveredRepositories: Awaited<
      ReturnType<
        DashboardDependencies["repositoryDiscovery"]["listRepositories"]
      >
    >;
    try {
      discoveredRepositories =
        await this.repositoryDiscovery.listRepositories();
    } catch (error: unknown) {
      if (!this.isCurrentLoad(generation)) return;
      const discoveryError = this.createError(error, {
        code: "repositoryDiscovery",
        operationName: "list repositories",
        section: "localSummary",
      });
      this.applySectionFailure("localSummary", discoveryError);
      this.repositories = [];
      this.selectedRepository = undefined;
      this.loadingSections.clear();
      this.publish();
      throw discoveryError;
    }

    if (!this.isCurrentLoad(generation)) return;
    this.repositories = discoveredRepositories.map((repository) =>
      this.toRepositoryOption(repository.rootUri.fsPath),
    );
    this.repositoryRootUrisByFilesystemPath = new Map(
      discoveredRepositories.map((repository) => [
        repository.rootUri.fsPath,
        repository.rootUri,
      ]),
    );
    if (discoveredRepositories.length === 0) {
      this.selectedRepository = undefined;
      for (const providerId of dashboardProviderIds)
        this.resetProviderDashboardConnection(providerId);
      this.loadingSections.clear();
      this.publish();
      return;
    }

    const preferredRoot =
      options.selectedRepositoryRoot ??
      (this.selectedRepository === undefined
        ? undefined
        : this.selectedRepository.repository.rootUri);
    let repository: SelectedRepository["repository"];
    try {
      repository = await this.repositoryDiscovery.selectRepository({
        ...(options.activeEditorUri === undefined
          ? {}
          : { activeEditorUri: options.activeEditorUri }),
        ...(preferredRoot === undefined
          ? {}
          : { selectedRepositoryRoot: preferredRoot }),
      });
    } catch (error: unknown) {
      if (!this.isCurrentLoad(generation)) return;
      this.selectedRepository = undefined;
      this.loadingSections.clear();
      const dashboardError = this.createError(error, {
        code: "repositorySelection",
        operationName: "select repository",
      });
      this.applySectionFailure("localSummary", dashboardError);
      this.publish();
      throw dashboardError;
    }
    if (!this.isCurrentLoad(generation)) return;
    await this.activateRepository(
      repository,
      generation,
      requestOptions,
      localRepositoryOptions,
    );
  }

  public async refresh(options: DashboardRefreshOptions = {}): Promise<void> {
    this.assertUsable("refresh dashboard");
    const localRepositoryOptions: LocalGitRepositoryHealthOptions = {
      refreshStatus: options.refreshStatus ?? true,
    };
    if (this.selectedRepository === undefined) {
      await this.loadDashboard(
        {},
        { forceRefresh: true },
        localRepositoryOptions,
      );
      return;
    }
    await this.loadDashboard(
      { selectedRepositoryRoot: this.selectedRepository.repository.rootUri },
      { forceRefresh: true },
      localRepositoryOptions,
    );
  }

  /** Refreshes one already-connected provider without acquiring interactively. */
  public async refreshProvider(providerId: CloudProviderId): Promise<void> {
    this.assertUsable("refresh provider dashboard");
    const providerState = this.requireProviderState(providerId);
    if (
      this.selectedRepository === undefined ||
      providerState.identity === undefined ||
      providerState.sessionId === undefined ||
      providerState.connectionState !== "connected"
    ) {
      return;
    }
    await this.loadProviderDashboard(
      providerId,
      this.requestGeneration,
      undefined,
      undefined,
      { forceRefresh: true },
    );
  }

  public async selectRepository(repositoryRoot: string): Promise<void> {
    this.assertUsable("select repository");
    const repositoryOption = this.repositories.find(
      (candidateRepository) =>
        candidateRepository.repositoryRoot === repositoryRoot,
    );
    if (repositoryOption === undefined) {
      throw new DashboardOrchestrationError(
        "The selected repository is no longer open in VS Code.",
        {
          code: "repositoryNotFound",
          operationName: "select repository",
        },
      );
    }
    const selectedRepositoryRootUri =
      this.repositoryRootUrisByFilesystemPath.get(repositoryRoot);
    if (selectedRepositoryRootUri === undefined) {
      throw new DashboardOrchestrationError(
        "The selected repository is no longer open in VS Code.",
        {
          code: "repositoryNotFound",
          operationName: "select repository",
        },
      );
    }
    const generation = this.beginLoad();
    let repository: SelectedRepository["repository"];
    try {
      repository = await this.repositoryDiscovery.selectRepository({
        selectedRepositoryRoot: selectedRepositoryRootUri,
      });
    } catch (error: unknown) {
      if (!this.isCurrentLoad(generation)) return;
      const dashboardError = this.createError(error, {
        code: "repositorySelection",
        operationName: "select repository",
      });
      this.applySectionFailure("localSummary", dashboardError);
      this.publish();
      throw dashboardError;
    }
    if (!this.isCurrentLoad(generation)) return;
    await this.activateRepository(
      repository,
      generation,
      {
        forceRefresh: false,
      },
      {},
    );
  }

  public setProviderFilter(
    providerFilter: RepositoryHomeSnapshot["providerFilter"],
  ): void {
    this.assertUsable("set provider filter");
    this.providerFilter = providerFilter;
    this.publish();
  }

  public async connectProvider(providerId: CloudProviderId): Promise<void> {
    this.assertUsable("connect provider");
    const provider = this.providersById.get(providerId);
    if (provider === undefined) {
      const unavailableError = new DashboardOrchestrationError(
        `${dashboardProviderDisplayNames[providerId]} is unavailable in this extension host.`,
        {
          code: "providerUnavailable",
          operationName: "connect provider",
          providerId,
          section: providerId,
        },
      );
      this.applySectionFailure(providerId, unavailableError);
      this.publish();
      throw unavailableError;
    }
    const currentProviderState = this.requireProviderState(providerId);
    if (
      this.selectedRepository === undefined ||
      currentProviderState.identity === undefined
    ) {
      this.resetProviderDashboardConnection(providerId);
      const prerequisiteError = new DashboardOrchestrationError(
        this.selectedRepository === undefined
          ? `Open a local repository before connecting ${dashboardProviderDisplayNames[providerId]}.`
          : `Open a repository with a matching ${dashboardProviderDisplayNames[providerId]} remote before connecting ${dashboardProviderDisplayNames[providerId]}.`,
        {
          code: "providerConnection",
          operationName: "connect provider",
          providerId,
          section: providerId,
        },
      );
      this.applySectionFailure(providerId, prerequisiteError);
      this.publish();
      throw prerequisiteError;
    }
    const requestGeneration = this.requestGeneration;
    const previousProviderState =
      this.stableProviderStatesDuringConnect.get(providerId) ??
      currentProviderState;
    this.stableProviderStatesDuringConnect.set(
      providerId,
      previousProviderState,
    );
    this.cancelDetailRequests(providerId);
    const request = this.beginSectionRequest(
      providerId,
      this.selectedRepository?.repositoryRoot,
    );
    this.providerStates.set(providerId, {
      ...this.requireProviderState(providerId),
      connectionState: "connecting",
    });
    this.loadingSections.add(providerId);
    this.clearSectionError(providerId);
    this.publish();

    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancelProviderConnection = (): void =>
      cancellationTokenSource.cancel();
    request.abortController.signal.addEventListener(
      "abort",
      cancelProviderConnection,
      { once: true },
    );
    let acquiredConnection: ProviderConnection | undefined;
    const discardAcquiredConnection = (): void => {
      if (acquiredConnection === undefined) return;
      provider.discardConnection?.(acquiredConnection);
      acquiredConnection = undefined;
    };
    try {
      const connection = await provider.connect(cancellationTokenSource.token);
      acquiredConnection = connection;
      if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
        if (request.cancellationReason === "user") {
          throw this.createCancellationError("connect provider", providerId);
        }
        discardAcquiredConnection();
        return;
      }
      const user = await provider.getCurrentUser(
        connection,
        request.abortController.signal,
      );
      if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
        if (request.cancellationReason === "user") {
          throw this.createCancellationError("connect provider", providerId);
        }
        discardAcquiredConnection();
        return;
      }
      await this.loadProviderDashboard(
        providerId,
        requestGeneration,
        connection,
        request,
        { forceRefresh: false },
        user,
        true,
      );
      if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
        if (request.cancellationReason === "user") {
          throw this.createCancellationError("connect provider", providerId);
        }
        discardAcquiredConnection();
        return;
      }
      this.stableProviderStatesDuringConnect.delete(providerId);
    } catch (error: unknown) {
      const failedConnection = acquiredConnection;
      discardAcquiredConnection();
      if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
        const requestWasCancelledWithoutReplacement =
          request.cancellationReason === "user" &&
          this.requestGeneration === requestGeneration &&
          this.userCancelledRequests.get(providerId) === request &&
          this.sectionRequests.get(providerId) === undefined;
        if (!requestWasCancelledWithoutReplacement) return;
        this.restoreProviderStateAfterConnect(
          providerId,
          previousProviderState,
          "cancelled",
        );
        this.stableProviderStatesDuringConnect.delete(providerId);
        this.loadingSections.delete(providerId);
        const cancellationError = this.createCancellationError(
          "connect provider",
          providerId,
        );
        this.publish();
        throw cancellationError;
      }
      const dashboardError = this.createError(
        error,
        {
          code: this.isCancellation(error) ? "cancelled" : "providerConnection",
          operationName: "connect provider",
          providerId,
          section: providerId,
        },
        failedConnection === undefined ? [] : [failedConnection.accessToken],
      );
      this.restoreProviderStateAfterConnect(
        providerId,
        previousProviderState,
        dashboardError.code === "cancelled" ? "cancelled" : "failed",
      );
      this.stableProviderStatesDuringConnect.delete(providerId);
      this.loadingSections.delete(providerId);
      if (dashboardError.code !== "cancelled")
        this.applySectionFailure(providerId, dashboardError);
      this.publish();
      throw dashboardError;
    } finally {
      cancellationTokenSource.dispose();
      request.abortController.signal.removeEventListener(
        "abort",
        cancelProviderConnection,
      );
      this.finishSectionRequest(providerId, request);
    }
  }

  public disconnectProvider(providerId: CloudProviderId): void {
    this.assertUsable("disconnect provider");
    const provider = this.providersById.get(providerId);
    this.cancelSection(providerId, "disconnect");
    this.cancelDetailRequests(providerId);
    this.stableProviderStatesDuringConnect.delete(providerId);
    const providerState = this.requireProviderState(providerId);
    provider?.disconnect();
    this.providerStates.set(providerId, {
      identity: providerState.identity,
      connectionState: "disconnected",
      pullRequests: [],
      cacheStatus: undefined,
      staleReason: undefined,
    });
    this.notifyProviderConnectionStateChanged(providerId);
    this.clearSectionError(providerId);
    this.publish();
  }

  public cancelPendingRequests(): void {
    this.assertUsable("cancel dashboard requests");
    for (const section of dashboardSections)
      this.cancelSection(section, "user");
    this.cancelDetailRequests();
    for (const providerId of dashboardProviderIds) {
      const providerState = this.requireProviderState(providerId);
      if (providerState.connectionState !== "connecting") continue;
      this.providerStates.set(providerId, {
        identity: providerState.identity,
        connectionState:
          providerState.sessionId === undefined ? "disconnected" : "connected",
        pullRequests: providerState.pullRequests,
        ...(providerState.sessionId === undefined
          ? {}
          : { sessionId: providerState.sessionId }),
        ...(providerState.accountDisplayName === undefined
          ? {}
          : { accountDisplayName: providerState.accountDisplayName }),
        ...(providerState.fetchedAt === undefined
          ? {}
          : { fetchedAt: providerState.fetchedAt }),
        cacheStatus: providerState.cacheStatus,
        staleReason: providerState.staleReason,
      });
    }
    this.loadingSections.clear();
    this.publish();
  }

  public async getPullRequestDetails(
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal?: AbortSignal,
  ): Promise<PullRequestDetails> {
    this.assertUsable("load pull request details");
    const provider = this.providersById.get(pullRequestIdentity.providerId);
    if (
      provider === undefined ||
      this.requireProviderState(pullRequestIdentity.providerId).sessionId ===
        undefined
    ) {
      throw new DashboardOrchestrationError(
        `Connect ${dashboardProviderDisplayNames[pullRequestIdentity.providerId]} before opening pull request details.`,
        {
          code: "providerConnection",
          operationName: "load pull request details",
          providerId: pullRequestIdentity.providerId,
          section: pullRequestIdentity.providerId,
        },
      );
    }
    const selectedRepositoryRoot = this.selectedRepository?.repositoryRoot;
    this.assertPullRequestBelongsToSelectedRepository(
      pullRequestIdentity,
      "load pull request details",
    );
    const detailRequestController = new AbortController();
    const abortDetailRequest = (): void => detailRequestController.abort();
    this.detailRequestControllers.set(
      detailRequestController,
      pullRequestIdentity.providerId,
    );
    this.lifecycleAbortController.signal.addEventListener(
      "abort",
      abortDetailRequest,
      { once: true },
    );
    cancellationSignal?.addEventListener("abort", abortDetailRequest, {
      once: true,
    });
    try {
      if (cancellationSignal?.aborted) detailRequestController.abort();
      throwIfDashboardRequestCancelled(detailRequestController.signal);
      const details = await this.withProviderConnection(
        provider,
        detailRequestController.signal,
        (connection) =>
          provider.getPullRequestDetails(
            pullRequestIdentity,
            connection,
            detailRequestController.signal,
          ),
      );
      throwIfDashboardRequestCancelled(detailRequestController.signal);
      this.assertSelectedRepositoryRootUnchanged(
        selectedRepositoryRoot,
        "load pull request details",
      );
      this.assertPullRequestBelongsToSelectedRepository(
        pullRequestIdentity,
        "load pull request details",
      );
      this.assertPullRequestDetailsMatchRequestedIdentity(
        pullRequestIdentity,
        details,
        "load pull request details",
      );
      return details;
    } catch (error: unknown) {
      if (error instanceof DashboardOrchestrationError) throw error;
      if (isProviderSessionLoss(error, pullRequestIdentity.providerId)) {
        this.markProviderSessionLost(pullRequestIdentity.providerId);
      }
      throw this.createError(error, {
        code: this.isCancellation(error) ? "cancelled" : "pullRequestDetails",
        operationName: "load pull request details",
        providerId: pullRequestIdentity.providerId,
        section: pullRequestIdentity.providerId,
      });
    } finally {
      this.detailRequestControllers.delete(detailRequestController);
      this.lifecycleAbortController.signal.removeEventListener(
        "abort",
        abortDetailRequest,
      );
      cancellationSignal?.removeEventListener("abort", abortDetailRequest);
    }
  }

  public async checkoutPullRequest(
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    this.assertUsable("checkout pull request");
    const selectedRepository = this.selectedRepository;
    if (selectedRepository === undefined) {
      throw new DashboardOrchestrationError(
        "Select a repository before checking out a pull request.",
        { code: "repositorySelection", operationName: "checkout pull request" },
      );
    }
    const pullRequestDetails = await this.getPullRequestDetails(
      pullRequestIdentity,
      cancellationSignal,
    );
    this.assertSelectedRepositoryRootUnchanged(
      selectedRepository.repositoryRoot,
      "checkout pull request",
    );
    this.assertPullRequestBelongsToSelectedRepository(
      pullRequestDetails,
      "checkout pull request",
    );
    this.assertPullRequestDetailsMatchRequestedIdentity(
      pullRequestIdentity,
      pullRequestDetails,
      "checkout pull request",
    );
    const branchValidationMessage = getGitBranchNameValidationMessage(
      pullRequestDetails.sourceBranchName,
    );
    if (branchValidationMessage !== undefined) {
      throw new DashboardOrchestrationError(branchValidationMessage, {
        code: "checkoutPullRequest",
        operationName: "checkout pull request",
        providerId: pullRequestIdentity.providerId,
        section: pullRequestIdentity.providerId,
      });
    }
    throwIfDashboardRequestCancelled(cancellationSignal);
    this.assertSelectedRepositoryRootUnchanged(
      selectedRepository.repositoryRoot,
      "checkout pull request",
    );
    await this.assertSelectedRepositoryObjectUnchanged(
      selectedRepository,
      "checkout pull request",
    );
    throwIfDashboardRequestCancelled(cancellationSignal);
    try {
      await this.workspaceTrustGuard.runTrustedMutation(
        "checkout pull request",
        async () => {
          await this.assertSelectedRepositoryObjectUnchanged(
            selectedRepository,
            "checkout pull request",
          );
          throwIfDashboardRequestCancelled(cancellationSignal);
          return this.repositoryService.checkoutBranch(
            pullRequestDetails.sourceBranchName,
            {
              selectedRepositoryRoot: selectedRepository.repository.rootUri,
              expectedRepository: selectedRepository.repository,
            },
            false,
            cancellationSignal,
          );
        },
      );
      throwIfDashboardRequestCancelled(cancellationSignal);
    } catch (error: unknown) {
      throw this.createError(error, {
        code: this.isCancellation(error) ? "cancelled" : "checkoutPullRequest",
        operationName: "checkout pull request",
        providerId: pullRequestIdentity.providerId,
        section: pullRequestIdentity.providerId,
      });
    }
  }

  public async openExternalPullRequest(
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    this.assertUsable("open external pull request");
    const provider = this.providersById.get(pullRequestIdentity.providerId);
    if (provider === undefined) {
      throw new DashboardOrchestrationError(
        `${dashboardProviderDisplayNames[pullRequestIdentity.providerId]} is unavailable in this extension host.`,
        {
          code: "providerUnavailable",
          operationName: "open external pull request",
          providerId: pullRequestIdentity.providerId,
          section: pullRequestIdentity.providerId,
        },
      );
    }
    this.assertPullRequestBelongsToSelectedRepository(
      pullRequestIdentity,
      "open external pull request",
    );
    throwIfDashboardRequestCancelled(cancellationSignal);
    try {
      const canonicalUri = provider.getCanonicalUrl(pullRequestIdentity);
      const opened = await vscode.env.openExternal(canonicalUri);
      if (!opened) {
        throw new Error(
          "VS Code could not open the provider pull request page.",
        );
      }
    } catch (error: unknown) {
      throw this.createError(error, {
        code: "openExternalPullRequest",
        operationName: "open external pull request",
        providerId: pullRequestIdentity.providerId,
        section: pullRequestIdentity.providerId,
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleAbortController.abort();
    for (const detailRequestController of this.detailRequestControllers.keys()) {
      detailRequestController.abort();
    }
    this.detailRequestControllers.clear();
    for (const section of dashboardSections)
      this.cancelSection(section, "dispose");
    for (const [, provider] of this.providersById) {
      try {
        provider.disconnect();
      } catch {
        // Disposal still clears extension-host state when a provider cleanup fails.
      }
    }
    this.repositories = [];
    this.repositoryRootUrisByFilesystemPath.clear();
    this.selectedRepository = undefined;
    this.providerFilter = "all";
    this.loadingSections.clear();
    this.sectionErrors.clear();
    this.sectionRequests.clear();
    this.userCancelledRequests.clear();
    this.stableProviderStatesDuringConnect.clear();
    this.sectionGeneration.clear();
    for (const providerId of dashboardProviderIds) {
      this.providerStates.set(providerId, {
        identity: undefined,
        connectionState: "disconnected",
        pullRequests: [],
        cacheStatus: undefined,
        staleReason: undefined,
      });
    }
    this.snapshot = createEmptyRepositoryHomeSnapshot();
    this.listeners.clear();
  }

  private async activateRepository(
    repository: SelectedRepository["repository"],
    requestGeneration: number,
    requestOptions: RepositoryDashboardOptions,
    localRepositoryOptions: LocalGitRepositoryHealthOptions,
  ): Promise<void> {
    if (!this.isCurrentLoad(requestGeneration)) return;
    this.selectedRepository = {
      repository,
      repositoryRoot: repository.rootUri.fsPath,
      repositoryDisplayName:
        repository.rootUri.fsPath.split(/[\\/]/u).pop() ??
        repository.rootUri.fsPath,
    };
    this.sectionErrors.clear();
    this.loadingSections = new Set(["localSummary", "commitActivity"]);
    for (const providerId of dashboardProviderIds) {
      this.loadingSections.add(providerId);
      const providerState = this.requireProviderState(providerId);
      const retainedConnectionState =
        providerState.sessionId !== undefined
          ? "connected"
          : providerState.connectionState === "connecting"
            ? "connecting"
            : "disconnected";
      this.providerStates.set(providerId, {
        identity: undefined,
        connectionState: retainedConnectionState,
        ...(providerState.sessionId === undefined
          ? {}
          : { sessionId: providerState.sessionId }),
        ...(providerState.accountDisplayName === undefined
          ? {}
          : {
              accountDisplayName: providerState.accountDisplayName,
            }),
        pullRequests: [],
        cacheStatus: undefined,
        staleReason: undefined,
      });
    }
    this.snapshot = { ...this.snapshot, selectedRepository: null };
    this.publish();

    const localSummaryPromise = this.loadLocalSummary(
      requestGeneration,
      localRepositoryOptions,
    );
    const commitActivityPromise = this.loadCommitActivity(requestGeneration);
    const providerDetectionPromise = this.detectProviders(
      requestGeneration,
      requestOptions,
    );
    await Promise.allSettled([
      localSummaryPromise,
      commitActivityPromise,
      providerDetectionPromise,
    ]);
  }

  private async loadLocalSummary(
    requestGeneration: number,
    localRepositoryOptions: LocalGitRepositoryHealthOptions,
  ): Promise<void> {
    const selectedRepository = this.selectedRepository;
    if (selectedRepository === undefined) return;
    const request = this.beginSectionRequest(
      "localSummary",
      selectedRepository.repositoryRoot,
    );
    try {
      const repositoryHealth = await this.repositoryService.getRepositoryHealth(
        {
          selectedRepositoryRoot: selectedRepository.repository.rootUri,
        },
        localRepositoryOptions,
      );
      if (!this.isCurrentRequest("localSummary", request, requestGeneration))
        return;
      this.updateSelectedRepository((currentSnapshot) => ({
        ...currentSnapshot,
        repositoryHealth: {
          branchName: repositoryHealth.branchName,
          uncommittedChangeCount: repositoryHealth.uncommittedChangeCount,
          aheadCount: repositoryHealth.aheadCount,
          behindCount: repositoryHealth.behindCount,
          ...(repositoryHealth.lastSuccessfulFetchAt === undefined
            ? {}
            : {
                lastSuccessfulFetchAt: repositoryHealth.lastSuccessfulFetchAt,
              }),
        },
      }));
      this.loadingSections.delete("localSummary");
      this.clearSectionError("localSummary");
      this.publish();
    } catch (error: unknown) {
      if (!this.isCurrentRequest("localSummary", request, requestGeneration))
        return;
      const dashboardError = this.createError(error, {
        code: "localSummary",
        operationName: "load local repository summary",
        section: "localSummary",
      });
      this.loadingSections.delete("localSummary");
      this.applySectionFailure("localSummary", dashboardError);
      this.publish();
    } finally {
      this.finishSectionRequest("localSummary", request);
    }
  }

  private async loadCommitActivity(requestGeneration: number): Promise<void> {
    const selectedRepository = this.selectedRepository;
    if (selectedRepository === undefined) return;
    const request = this.beginSectionRequest(
      "commitActivity",
      selectedRepository.repositoryRoot,
    );
    const activityWindow = createActivityWindow(
      this.clock(),
      defaultActivityDayCount,
    );
    try {
      const activitySnapshot = await this.historyService.getCommitActivity(
        selectedRepository.repository.rootUri,
        this.authorEmails,
        activityWindow,
        request.abortController.signal,
      );
      if (!this.isCurrentRequest("commitActivity", request, requestGeneration))
        return;
      this.updateSelectedRepository((currentSnapshot) => ({
        ...currentSnapshot,
        commitActivity: {
          days: [...activitySnapshot.days.entries()]
            .map(([date, commitCount]) => ({ date, commitCount }))
            .sort((leftDay, rightDay) =>
              leftDay.date.localeCompare(rightDay.date),
            )
            .slice(-defaultActivityDayCount),
          totalCommitCount: activitySnapshot.matchingCommitCount,
          safetyCapReached: activitySnapshot.reachedSafetyCap,
          ...(activitySnapshot.outputTruncated
            ? { outputTruncated: true }
            : {}),
        },
      }));
      this.loadingSections.delete("commitActivity");
      this.clearSectionError("commitActivity");
      this.publish();
    } catch (error: unknown) {
      if (!this.isCurrentRequest("commitActivity", request, requestGeneration))
        return;
      const dashboardError = this.createError(error, {
        code: this.isCancellation(error) ? "cancelled" : "commitActivity",
        operationName: "load commit activity",
        section: "commitActivity",
      });
      this.loadingSections.delete("commitActivity");
      if (dashboardError.code !== "cancelled")
        this.applySectionFailure("commitActivity", dashboardError);
      this.publish();
    } finally {
      this.finishSectionRequest("commitActivity", request);
    }
  }

  private async detectProviders(
    requestGeneration: number,
    requestOptions: RepositoryDashboardOptions,
  ): Promise<void> {
    const selectedRepository = this.selectedRepository;
    if (selectedRepository === undefined) return;
    let remoteUrls: readonly string[];
    try {
      remoteUrls = this.historyService.getRemoteUrls(
        selectedRepository.repository,
      );
    } catch (error: unknown) {
      if (!this.isCurrentLoad(requestGeneration)) return;
      const dashboardError = this.createError(error, {
        code: "providerDetection",
        operationName: "detect repository providers",
      });
      for (const providerId of dashboardProviderIds) {
        this.loadingSections.delete(providerId);
        if (this.providersById.has(providerId))
          this.applySectionFailure(providerId, dashboardError);
      }
      this.publish();
      return;
    }
    if (!this.isCurrentLoad(requestGeneration)) return;
    for (const providerId of dashboardProviderIds) {
      if (!this.isCurrentLoad(requestGeneration)) return;
      const provider = this.providersById.get(providerId);
      if (provider === undefined) {
        this.loadingSections.delete(providerId);
        continue;
      }
      try {
        if (!this.isCurrentLoad(requestGeneration)) return;
        const identity = provider.detectRepository(remoteUrls);
        if (!this.isCurrentLoad(requestGeneration)) return;
        this.providerStates.set(providerId, {
          ...this.requireProviderState(providerId),
          identity,
        });
        const detectedProviderState = this.requireProviderState(providerId);
        if (
          detectedProviderState.sessionId === undefined &&
          detectedProviderState.connectionState !== "connecting"
        ) {
          this.loadingSections.delete(providerId);
          this.clearSectionError(providerId);
          continue;
        }
        await this.loadProviderDashboard(
          providerId,
          requestGeneration,
          undefined,
          undefined,
          requestOptions,
        );
        if (!this.isCurrentLoad(requestGeneration)) return;
      } catch (error: unknown) {
        if (!this.isCurrentLoad(requestGeneration)) return;
        const dashboardError = this.createError(error, {
          code: "providerDetection",
          operationName: "detect repository providers",
          providerId,
          section: providerId,
        });
        this.loadingSections.delete(providerId);
        this.applySectionFailure(providerId, dashboardError);
      }
      if (!this.isCurrentLoad(requestGeneration)) return;
      this.publish();
    }
  }

  private async loadProviderDashboard(
    providerId: CloudProviderId,
    requestGeneration: number,
    existingConnection?: ProviderConnection,
    existingRequest?: SectionRequest,
    requestOptions: RepositoryDashboardOptions = {},
    existingUser?: CloudUser,
    propagateFailure = false,
  ): Promise<void> {
    if (!this.isCurrentLoad(requestGeneration)) return;
    const provider = this.providersById.get(providerId);
    const selectedRepository = this.selectedRepository;
    const providerState = this.requireProviderState(providerId);
    if (provider === undefined) {
      this.loadingSections.delete(providerId);
      return;
    }
    if (
      selectedRepository === undefined ||
      providerState.identity === undefined
    ) {
      this.resetProviderDashboardConnection(providerId);
      this.clearSectionError(providerId);
      this.publish();
      return;
    }
    const repositoryIdentity = providerState.identity;
    const previousProviderState = providerState;
    const request =
      existingRequest ??
      this.beginSectionRequest(providerId, selectedRepository.repositoryRoot);
    const ownsRequest = existingRequest === undefined;
    const connection: ProviderConnection | undefined = existingConnection;
    let acquiredConnection: ProviderConnection | undefined = connection;
    const discardAcquiredConnection = (): void => {
      if (acquiredConnection === undefined) return;
      provider.discardConnection?.(acquiredConnection);
      acquiredConnection = undefined;
    };
    try {
      const loadDashboard = async (
        providerConnection: ProviderConnection,
      ): Promise<{
        readonly connection: ProviderConnection;
        readonly user: CloudUser;
        readonly dashboard: RepositoryDashboardSnapshot;
      }> => {
        let user = existingUser;
        if (user === undefined) {
          user = await provider.getCurrentUser(
            providerConnection,
            request.abortController.signal,
          );
          if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
            throw this.createCancellationError(
              `load ${dashboardProviderDisplayNames[providerId]} dashboard`,
              providerId,
            );
          }
        }
        if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
          throw this.createCancellationError(
            `load ${dashboardProviderDisplayNames[providerId]} dashboard`,
            providerId,
          );
        }
        const dashboard = await provider.getRepositoryDashboard(
          repositoryIdentity,
          providerConnection,
          request.abortController.signal,
          requestOptions,
        );
        if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
          throw this.createCancellationError(
            `load ${dashboardProviderDisplayNames[providerId]} dashboard`,
            providerId,
          );
        }
        return { connection: providerConnection, user, dashboard };
      };
      const providerData =
        connection === undefined
          ? await this.withProviderConnection(
              provider,
              request.abortController.signal,
              loadDashboard,
            )
          : await loadDashboard(connection);
      acquiredConnection = providerData.connection;
      if (!this.isCurrentRequest(providerId, request, requestGeneration)) {
        discardAcquiredConnection();
        return;
      }
      this.validateProviderDashboard(
        provider,
        repositoryIdentity,
        providerData.dashboard,
      );
      provider.commitConnection?.(providerData.connection);
      acquiredConnection = undefined;
      this.providerStates.set(providerId, {
        ...this.requireProviderState(providerId),
        sessionId: providerData.connection.sessionId,
        connectionState: "connected",
        accountDisplayName: providerData.user.displayName,
        pullRequests: providerData.dashboard.pullRequests,
        fetchedAt: providerData.dashboard.fetchedAt,
        cacheStatus: providerData.dashboard.cacheStatus,
        staleReason: providerData.dashboard.staleReason,
      });
      if (
        providerDashboardDataChanged(
          previousProviderState,
          providerData.connection.sessionId,
          providerData.user.displayName,
          providerData.dashboard.pullRequests,
        )
      ) {
        this.cancelDetailRequests(providerId);
      }
      this.notifyProviderConnectionStateChanged(providerId);
      this.loadingSections.delete(providerId);
      this.clearSectionError(providerId);
      this.publish();
    } catch (error: unknown) {
      discardAcquiredConnection();
      if (!this.isCurrentRequest(providerId, request, requestGeneration))
        return;
      if (isProviderSessionLoss(error, providerId)) {
        this.markProviderSessionLost(providerId);
      }
      const dashboardError = this.createError(
        error,
        {
          code: this.isCancellation(error)
            ? "cancelled"
            : connection === undefined
              ? "providerConnection"
              : "providerData",
          operationName: `load ${dashboardProviderDisplayNames[providerId]} dashboard`,
          providerId,
          section: providerId,
        },
        existingConnection === undefined
          ? []
          : [existingConnection.accessToken],
      );
      if (
        dashboardError.code !== "cancelled" &&
        !isProviderSessionLoss(error, providerId)
      ) {
        this.providerStates.set(
          providerId,
          previousProviderState.sessionId === undefined
            ? {
                ...previousProviderState,
                connectionState: "failed",
              }
            : previousProviderState,
        );
      }
      this.loadingSections.delete(providerId);
      if (dashboardError.code !== "cancelled")
        this.applySectionFailure(providerId, dashboardError);
      this.publish();
      if (propagateFailure) throw dashboardError;
    } finally {
      if (ownsRequest) this.finishSectionRequest(providerId, request);
    }
  }

  private async withProviderConnection<ResponseValue>(
    provider: CloudGitProvider,
    cancellationSignal: AbortSignal | undefined,
    operation: (connection: ProviderConnection) => Promise<ResponseValue>,
  ): Promise<ResponseValue> {
    throwIfDashboardRequestCancelled(cancellationSignal);
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancelConnection = (): void => cancellationTokenSource.cancel();
    cancellationSignal?.addEventListener("abort", cancelConnection, {
      once: true,
    });
    let activeConnection: ProviderConnection | undefined;
    try {
      const connection = await provider.connectSilently(
        cancellationTokenSource.token,
      );
      activeConnection = connection;
      throwIfDashboardRequestCancelled(cancellationSignal);
      return await operation(connection);
    } catch (error: unknown) {
      if (
        activeConnection !== undefined &&
        error instanceof Error &&
        !(error instanceof DashboardOrchestrationError) &&
        !(error instanceof GitHubProviderError)
      ) {
        throw new Error(
          formatGitErrorForUser(
            error,
            "The repository dashboard request failed.",
            [activeConnection.accessToken],
          ),
        );
      }
      throw error;
    } finally {
      cancellationSignal?.removeEventListener("abort", cancelConnection);
      cancellationTokenSource.dispose();
    }
  }

  private beginLoad(): number {
    this.requestGeneration += 1;
    for (const section of dashboardSections)
      this.cancelSection(section, "superseded");
    this.stableProviderStatesDuringConnect.clear();
    this.cancelDetailRequests();
    this.loadingSections.clear();
    this.sectionErrors.clear();
    return this.requestGeneration;
  }

  private beginSectionRequest(
    section: DashboardSection,
    repositoryRoot: string | undefined,
  ): SectionRequest {
    this.userCancelledRequests.delete(section);
    this.cancelSection(section, "superseded");
    const generation = (this.sectionGeneration.get(section) ?? 0) + 1;
    this.sectionGeneration.set(section, generation);
    const request: SectionRequest = {
      generation,
      repositoryRoot,
      abortController: new AbortController(),
      cancellationReason: undefined,
    };
    this.sectionRequests.set(section, request);
    return request;
  }

  private cancelSection(
    section: DashboardSection,
    cancellationReason:
      "superseded" | "user" | "disconnect" | "dispose" = "superseded",
  ): void {
    if (cancellationReason !== "user")
      this.userCancelledRequests.delete(section);
    const request = this.sectionRequests.get(section);
    if (request !== undefined) {
      request.cancellationReason = cancellationReason;
      if (cancellationReason === "user")
        this.userCancelledRequests.set(section, request);
    }
    request?.abortController.abort();
    if (request !== undefined) this.sectionRequests.delete(section);
    this.sectionGeneration.set(
      section,
      (this.sectionGeneration.get(section) ?? 0) + 1,
    );
  }

  private cancelDetailRequests(providerId?: CloudProviderId): void {
    for (const [detailRequestController, detailProviderId] of this
      .detailRequestControllers) {
      if (providerId === undefined || detailProviderId === providerId)
        detailRequestController.abort();
    }
  }

  private finishSectionRequest(
    section: DashboardSection,
    request: SectionRequest,
  ): void {
    if (this.sectionRequests.get(section) === request)
      this.sectionRequests.delete(section);
  }

  private isCurrentRequest(
    section: DashboardSection,
    request: SectionRequest,
    requestGeneration: number,
  ): boolean {
    return (
      !this.disposed &&
      this.requestGeneration === requestGeneration &&
      this.sectionRequests.get(section) === request &&
      this.sectionGeneration.get(section) === request.generation &&
      this.selectedRepository?.repositoryRoot === request.repositoryRoot &&
      !request.abortController.signal.aborted
    );
  }

  private isCurrentLoad(requestGeneration: number): boolean {
    return !this.disposed && this.requestGeneration === requestGeneration;
  }

  private updateSelectedRepository(
    update: (
      selectedRepository: NonNullable<
        RepositoryHomeSnapshot["selectedRepository"]
      >,
    ) => NonNullable<RepositoryHomeSnapshot["selectedRepository"]>,
  ): void {
    if (this.snapshot.selectedRepository === null) return;
    this.snapshot = {
      ...this.snapshot,
      selectedRepository: update(this.snapshot.selectedRepository),
    };
  }

  private toRepositoryOption(
    repositoryRoot: string,
  ): RepositoryHomeSnapshot["repositories"][number] {
    return {
      repositoryRoot,
      repositoryDisplayName:
        repositoryRoot.split(/[\\/]/u).pop() ?? repositoryRoot,
    };
  }

  private requireProviderState(providerId: CloudProviderId): ProviderState {
    const providerState = this.providerStates.get(providerId);
    if (providerState === undefined) {
      throw new DashboardOrchestrationError(
        `${dashboardProviderDisplayNames[providerId]} is unavailable in this extension host.`,
        {
          code: "providerUnavailable",
          operationName: "read provider state",
          providerId,
          section: providerId,
        },
      );
    }
    return providerState;
  }

  private restoreProviderStateAfterConnect(
    providerId: CloudProviderId,
    previousProviderState: ProviderState,
    outcome: "cancelled" | "failed",
  ): void {
    if (
      outcome === "cancelled" ||
      previousProviderState.sessionId !== undefined
    ) {
      this.providerStates.set(providerId, previousProviderState);
      return;
    }
    this.providerStates.set(providerId, {
      identity: previousProviderState.identity,
      connectionState: "failed",
      pullRequests: previousProviderState.pullRequests,
      cacheStatus: previousProviderState.cacheStatus,
      staleReason: previousProviderState.staleReason,
      ...(previousProviderState.accountDisplayName === undefined
        ? {}
        : { accountDisplayName: previousProviderState.accountDisplayName }),
      ...(previousProviderState.fetchedAt === undefined
        ? {}
        : { fetchedAt: previousProviderState.fetchedAt }),
    });
  }

  /** Clears current dashboard state only; VS Code continues owning authentication. */
  private resetProviderDashboardConnection(providerId: CloudProviderId): void {
    this.stableProviderStatesDuringConnect.delete(providerId);
    this.providerStates.set(providerId, {
      identity: undefined,
      connectionState: "disconnected",
      pullRequests: [],
      cacheStatus: undefined,
      staleReason: undefined,
    });
    this.loadingSections.delete(providerId);
    this.notifyProviderConnectionStateChanged(providerId);
  }

  private validateProviderDashboard(
    provider: CloudGitProvider,
    repositoryIdentity: CloudRepositoryIdentity,
    dashboard: RepositoryDashboardSnapshot,
  ): void {
    if (
      !dashboard ||
      dashboard.providerId !== provider.providerId ||
      typeof dashboard.repositoryRoot !== "string" ||
      dashboard.repositoryRoot.trim().length === 0 ||
      !Array.isArray(dashboard.pullRequests) ||
      typeof dashboard.fetchedAt !== "string" ||
      dashboard.fetchedAt.trim().length === 0
    ) {
      throw new DashboardOrchestrationError(
        dashboardProviderDisplayNames[provider.providerId] +
          " returned an invalid repository dashboard.",
        {
          code: "providerData",
          operationName:
            "validate " +
            dashboardProviderDisplayNames[provider.providerId] +
            " dashboard",
          providerId: provider.providerId,
          section: provider.providerId,
        },
      );
    }
    const expectedCanonicalRoot = provider
      .getCanonicalUrl(repositoryIdentity)
      .toString();
    if (dashboard.repositoryRoot !== expectedCanonicalRoot) {
      throw new DashboardOrchestrationError(
        dashboardProviderDisplayNames[provider.providerId] +
          " returned data for a different repository.",
        {
          code: "providerData",
          operationName:
            "validate " +
            dashboardProviderDisplayNames[provider.providerId] +
            " dashboard",
          providerId: provider.providerId,
          section: provider.providerId,
        },
      );
    }
    const validatedPullRequests =
      dashboard.pullRequests as readonly PullRequestSummary[];
    for (const pullRequest of validatedPullRequests) {
      if (
        !pullRequest ||
        pullRequest.providerId !== provider.providerId ||
        pullRequest.repositoryOwner !== repositoryIdentity.owner ||
        pullRequest.repositoryName !== repositoryIdentity.repositoryName ||
        (pullRequest.repositoryProject ?? undefined) !==
          (repositoryIdentity.project ?? undefined) ||
        !Number.isSafeInteger(pullRequest.pullRequestNumber) ||
        pullRequest.pullRequestNumber < 1
      ) {
        throw new DashboardOrchestrationError(
          dashboardProviderDisplayNames[provider.providerId] +
            " returned a pull request for a different repository.",
          {
            code: "providerData",
            operationName:
              "validate " +
              dashboardProviderDisplayNames[provider.providerId] +
              " dashboard",
            providerId: provider.providerId,
            section: provider.providerId,
          },
        );
      }
    }
  }

  private assertPullRequestBelongsToSelectedRepository(
    pullRequestIdentity: PullRequestIdentity,
    operationName: string,
  ): void {
    const detectedIdentity = this.requireProviderState(
      pullRequestIdentity.providerId,
    ).identity;
    const isSameRepository =
      this.selectedRepository !== undefined &&
      detectedIdentity !== undefined &&
      detectedIdentity.providerId === pullRequestIdentity.providerId &&
      detectedIdentity.owner === pullRequestIdentity.repositoryOwner &&
      detectedIdentity.repositoryName === pullRequestIdentity.repositoryName &&
      (detectedIdentity.project ?? undefined) ===
        (pullRequestIdentity.repositoryProject ?? undefined);
    if (isSameRepository) return;
    throw new DashboardOrchestrationError(
      "This pull request does not belong to the selected repository.",
      {
        code: "pullRequestRepositoryMismatch",
        operationName,
        providerId: pullRequestIdentity.providerId,
        section: pullRequestIdentity.providerId,
      },
    );
  }

  private assertSelectedRepositoryRootUnchanged(
    expectedRepositoryRoot: string | undefined,
    operationName: string,
  ): void {
    if (
      expectedRepositoryRoot !== undefined &&
      this.selectedRepository?.repositoryRoot === expectedRepositoryRoot
    ) {
      return;
    }
    throw new DashboardOrchestrationError(
      "The selected repository changed while the pull request was loading.",
      {
        code: "pullRequestRepositoryMismatch",
        operationName,
      },
    );
  }

  private async assertSelectedRepositoryObjectUnchanged(
    expectedSelectedRepository: SelectedRepository,
    operationName: string,
  ): Promise<void> {
    let currentRepository: SelectedRepository["repository"];
    try {
      currentRepository = await this.repositoryDiscovery.selectRepository({
        selectedRepositoryRoot: expectedSelectedRepository.repository.rootUri,
        expectedRepository: expectedSelectedRepository.repository,
      });
    } catch (error: unknown) {
      throw new DashboardOrchestrationError(
        "The selected repository changed while the pull request was loading.",
        {
          code: "pullRequestRepositoryMismatch",
          operationName,
          cause: error,
        },
      );
    }
    if (currentRepository === expectedSelectedRepository.repository) return;
    throw new DashboardOrchestrationError(
      "The selected repository changed while the pull request was loading.",
      { code: "pullRequestRepositoryMismatch", operationName },
    );
  }

  private assertPullRequestDetailsMatchRequestedIdentity(
    requestedIdentity: PullRequestIdentity,
    returnedDetails: PullRequestDetails,
    operationName: string,
  ): void {
    if (
      returnedDetails.providerId === requestedIdentity.providerId &&
      returnedDetails.repositoryOwner === requestedIdentity.repositoryOwner &&
      returnedDetails.repositoryName === requestedIdentity.repositoryName &&
      (returnedDetails.repositoryProject ?? undefined) ===
        (requestedIdentity.repositoryProject ?? undefined) &&
      returnedDetails.pullRequestNumber === requestedIdentity.pullRequestNumber
    ) {
      return;
    }
    throw new DashboardOrchestrationError(
      "The provider returned details for a different pull request.",
      {
        code: "pullRequestRepositoryMismatch",
        operationName,
        providerId: requestedIdentity.providerId,
        section: requestedIdentity.providerId,
      },
    );
  }

  private markProviderSessionLost(providerId: CloudProviderId): void {
    const provider = this.providersById.get(providerId);
    const providerState = this.requireProviderState(providerId);
    this.cancelDetailRequests(providerId);
    provider?.disconnect();
    this.providerStates.set(providerId, {
      identity: providerState.identity,
      connectionState: "disconnected",
      pullRequests: [],
      cacheStatus: undefined,
      staleReason: undefined,
    });
    this.loadingSections.delete(providerId);
    this.notifyProviderConnectionStateChanged(providerId);
  }

  private notifyProviderConnectionStateChanged(
    providerId: CloudProviderId,
  ): void {
    if (providerId !== "github") return;
    const connectionStateChange: DashboardProviderConnectionStateChange = {
      providerId,
      isConnected:
        this.requireProviderState(providerId).connectionState === "connected",
    };
    for (const listener of this.providerConnectionStateListeners)
      listener(connectionStateChange);
  }

  private createCancellationError(
    operationName: string,
    providerId?: CloudProviderId,
  ): DashboardOrchestrationError {
    return new DashboardOrchestrationError(
      "The dashboard request was cancelled.",
      {
        code: "cancelled",
        operationName,
        ...(providerId === undefined
          ? {}
          : { providerId, section: providerId }),
      },
    );
  }

  private applySectionFailure(
    section: DashboardSection,
    error: DashboardOrchestrationError,
  ): void {
    this.sectionErrors.set(
      section,
      formatGitErrorForUser(
        error,
        "The repository dashboard could not load this section.",
      ),
    );
  }

  private clearSectionError(section: DashboardSection): void {
    this.sectionErrors.delete(section);
  }

  private publish(): void {
    this.snapshot = {
      requestGeneration: this.requestGeneration,
      repositories: this.repositories,
      selectedRepository:
        this.selectedRepository === undefined
          ? null
          : {
              repositoryRoot: this.selectedRepository.repositoryRoot,
              repositoryDisplayName:
                this.selectedRepository.repositoryDisplayName,
              repositoryHealth: this.snapshot.selectedRepository
                ?.repositoryHealth ?? {
                branchName: "Not available",
                uncommittedChangeCount: 0,
                aheadCount: 0,
                behindCount: 0,
              },
              commitActivity: this.snapshot.selectedRepository
                ?.commitActivity ?? {
                days: [],
                totalCommitCount: 0,
                safetyCapReached: false,
              },
              cloudDashboards: dashboardProviderIds.map((providerId) => {
                const providerState = this.requireProviderState(providerId);
                return {
                  providerId,
                  providerDisplayName:
                    dashboardProviderDisplayNames[providerId],
                  connectionState: providerState.connectionState,
                  ...(providerState.accountDisplayName === undefined
                    ? {}
                    : { accountDisplayName: providerState.accountDisplayName }),
                  pullRequests: [...providerState.pullRequests],
                  ...(providerState.fetchedAt === undefined
                    ? {}
                    : { fetchedAt: providerState.fetchedAt }),
                  ...(providerState.cacheStatus === undefined
                    ? {}
                    : { cacheStatus: providerState.cacheStatus }),
                  ...(providerState.staleReason === undefined
                    ? {}
                    : { staleReason: providerState.staleReason }),
                };
              }),
            },
      providerFilter: this.providerFilter,
      loadingSections: dashboardSections.filter((section) =>
        this.loadingSections.has(section),
      ),
      sectionErrors: [...this.sectionErrors.entries()].map(
        ([section, userMessage]) => ({
          section,
          userMessage,
        }),
      ),
    };
    for (const listener of this.listeners)
      listener(cloneRepositoryHomeSnapshot(this.snapshot));
  }

  private assertUsable(operationName: string): void {
    if (this.disposed) {
      throw new DashboardOrchestrationError(
        "The repository dashboard has been disposed.",
        { code: "disposed", operationName },
      );
    }
  }

  private createError(
    error: unknown,
    details: Omit<DashboardFailureDetails, "cause">,
    sensitiveValues: readonly string[] = [],
  ): DashboardOrchestrationError {
    if (error instanceof DashboardOrchestrationError) return error;
    if (
      details.providerId !== undefined &&
      isProviderSessionLoss(error, details.providerId)
    ) {
      return new DashboardOrchestrationError(
        `${dashboardProviderDisplayNames[details.providerId]} session expired. Reconnect ${dashboardProviderDisplayNames[details.providerId]}.`,
        {
          ...details,
          cause: new Error(
            `${dashboardProviderDisplayNames[details.providerId]} session expired.`,
          ),
        },
      );
    }
    const userMessage = formatGitErrorForUser(
      error,
      "The repository dashboard could not load this section.",
      sensitiveValues,
    );
    const safeCause = new Error(userMessage);
    return new DashboardOrchestrationError(userMessage, {
      ...details,
      cause: safeCause,
    });
  }

  private isCancellation(error: unknown): boolean {
    return (
      (error instanceof DashboardOrchestrationError &&
        error.code === "cancelled") ||
      (error instanceof Error &&
        (error.name === "AbortError" || /cancel/iu.test(error.message)))
    );
  }
}

function providerDashboardDataChanged(
  previousProviderState: ProviderState,
  nextSessionId: string,
  nextAccountDisplayName: string,
  nextPullRequests: readonly PullRequestSummary[],
): boolean {
  return (
    previousProviderState.sessionId !== nextSessionId ||
    previousProviderState.accountDisplayName !== nextAccountDisplayName ||
    pullRequestSummariesChanged(
      previousProviderState.pullRequests,
      nextPullRequests,
    )
  );
}

function pullRequestSummariesChanged(
  previousPullRequests: readonly PullRequestSummary[],
  nextPullRequests: readonly PullRequestSummary[],
): boolean {
  if (previousPullRequests.length !== nextPullRequests.length) return true;
  const previousPullRequestsByIdentity = new Map(
    previousPullRequests.map((pullRequest) => [
      pullRequestIdentityKey(pullRequest),
      pullRequest,
    ]),
  );
  const nextPullRequestsByIdentity = new Map(
    nextPullRequests.map((pullRequest) => [
      pullRequestIdentityKey(pullRequest),
      pullRequest,
    ]),
  );
  if (
    previousPullRequestsByIdentity.size !== previousPullRequests.length ||
    nextPullRequestsByIdentity.size !== nextPullRequests.length ||
    previousPullRequestsByIdentity.size !== nextPullRequestsByIdentity.size
  ) {
    return true;
  }
  for (const [
    pullRequestIdentity,
    previousPullRequest,
  ] of previousPullRequestsByIdentity) {
    const nextPullRequest = nextPullRequestsByIdentity.get(pullRequestIdentity);
    if (
      nextPullRequest === undefined ||
      !arePullRequestSummariesEqual(previousPullRequest, nextPullRequest)
    ) {
      return true;
    }
  }
  return false;
}

function pullRequestIdentityKey(pullRequest: PullRequestSummary): string {
  return JSON.stringify([
    pullRequest.providerId,
    pullRequest.repositoryOwner,
    pullRequest.repositoryName,
    pullRequest.repositoryProject ?? undefined,
    pullRequest.pullRequestNumber,
  ]);
}

function arePullRequestSummariesEqual(
  leftPullRequest: PullRequestSummary,
  rightPullRequest: PullRequestSummary,
): boolean {
  return (
    leftPullRequest.title === rightPullRequest.title &&
    leftPullRequest.authorDisplayName === rightPullRequest.authorDisplayName &&
    leftPullRequest.updatedAt === rightPullRequest.updatedAt &&
    leftPullRequest.commentCount === rightPullRequest.commentCount &&
    leftPullRequest.isAuthoredByCurrentUser ===
      rightPullRequest.isAuthoredByCurrentUser &&
    leftPullRequest.reviewRequestedFromCurrentUser ===
      rightPullRequest.reviewRequestedFromCurrentUser &&
    leftPullRequest.isDraft === rightPullRequest.isDraft &&
    leftPullRequest.state === rightPullRequest.state &&
    leftPullRequest.completedReviewCount ===
      rightPullRequest.completedReviewCount &&
    leftPullRequest.requiredReviewCount === rightPullRequest.requiredReviewCount
  );
}

function isProviderSessionLoss(
  error: unknown,
  providerId?: CloudProviderId,
): boolean {
  if (error instanceof GitHubProviderError) {
    return error.kind === "authentication" || error.kind === "unauthorized";
  }
  if (providerId === undefined || !(error instanceof Error)) return false;
  return /(?:authentication session removed|unknown session|session (?:expired|invalid|lost))/iu.test(
    error.message,
  );
}

function throwIfDashboardRequestCancelled(
  cancellationSignal: AbortSignal | undefined,
): void {
  if (cancellationSignal?.aborted) {
    throw new DashboardOrchestrationError(
      "The dashboard request was cancelled.",
      { code: "cancelled", operationName: "dashboard request" },
    );
  }
}

function createActivityWindow(
  now: Date,
  dayCount: number,
): {
  readonly startDate: string;
  readonly endDate: string;
} {
  const endDate = new Date(now.getTime());
  endDate.setUTCHours(0, 0, 0, 0);
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - dayCount + 1);
  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

function cloneRepositoryHomeSnapshot(
  snapshot: RepositoryHomeSnapshot,
): RepositoryHomeSnapshot {
  return {
    requestGeneration: snapshot.requestGeneration,
    repositories: snapshot.repositories.map((repository) => ({
      ...repository,
    })),
    selectedRepository:
      snapshot.selectedRepository === null
        ? null
        : {
            ...snapshot.selectedRepository,
            repositoryHealth: {
              ...snapshot.selectedRepository.repositoryHealth,
            },
            commitActivity: {
              ...snapshot.selectedRepository.commitActivity,
              days: snapshot.selectedRepository.commitActivity.days.map(
                (day) => ({ ...day }),
              ),
            },
            cloudDashboards: snapshot.selectedRepository.cloudDashboards.map(
              (dashboard) => ({
                ...dashboard,
                pullRequests: dashboard.pullRequests.map((pullRequest) => ({
                  ...pullRequest,
                })),
              }),
            ),
          },
    providerFilter: snapshot.providerFilter,
    loadingSections: [...snapshot.loadingSections],
    sectionErrors: snapshot.sectionErrors.map((sectionError) => ({
      ...sectionError,
    })),
  };
}

function createEmptyRepositoryHomeSnapshot(): RepositoryHomeSnapshot {
  return {
    requestGeneration: 0,
    repositories: [],
    selectedRepository: null,
    providerFilter: "all",
    loadingSections: [],
    sectionErrors: [],
  };
}
