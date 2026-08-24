import * as vscode from "vscode";
import { realpath, stat } from "node:fs/promises";
import { GitHubProvider } from "./providers/github/githubProvider.js";
import { DashboardOrchestrator } from "./dashboard/dashboardOrchestrator.js";
import type { CloudProviderId } from "../domain/cloudGitProvider.js";
import { LocalGitExtensionHost } from "./git/gitExtensionHost.js";
import { CompareService, GitSearchService } from "./compare/index.js";
import {
  CompareExperience,
  createCompareOpenPlan,
} from "./compareExperience/index.js";
import { ConflictService } from "./conflicts/index.js";
import {
  ConflictExperienceController,
  registerConflictExperienceCommands,
} from "./conflictExperience/index.js";
import {
  GitOperationsExperienceStateReader,
  OperationsExperienceController,
  registerOperationsExperienceCommands,
} from "./operationsExperience/index.js";
import { GitOperationsService } from "./operations/index.js";
import {
  HistoryExperienceController,
  historyExperienceCommandIds,
} from "./historyExperience/index.js";
import type {
  HistoryExperienceRepositoryContext,
  HistoryRepositoryRoot,
} from "./historyExperience/index.js";
import { PremiumHistoryService } from "./history/index.js";
import {
  createWorkspaceTrustGuard,
  workspaceMutationCommandClassifications,
  workspaceTrustContextKey,
  type WorkspaceTrustGuard,
} from "./security/workspaceTrustGuard.js";
import {
  onboardingCopy,
  openFirstInstallWalkthroughOnce,
  registerOnboardingCommands,
  resetOnboardingRepositoryHomeContext,
  synchronizeOnboardingLocalRepositoryContext,
  synchronizeOnboardingProviderConnectionContext,
  type OnboardingProviderId,
} from "./onboarding/index.js";
import { GitoNavigationProvider } from "./repositories/gitoNavigationProvider.js";
import {
  areExactRepositoryRootUrisEqual,
  isUriWithinRepository,
  RepositoryDiscovery,
} from "./repositories/repositoryDiscovery.js";
import { GitoSurfaceHost } from "./surfaces/gitoSurfaceHost.js";
import { RepositoryHomePanel } from "./webviews/repositoryHomePanel.js";
import { DiffExperience } from "./diffExperience/diffExperience.js";
import { createDiffRepositoryOpenPlan } from "./diffExperience/diffExperiencePlans.js";
import { createDiffSymlinkUriProvider, GitDiffService } from "./diff/index.js";
import {
  createGraphExperienceActions,
  createGraphExperienceRuntimeDataSource,
  GraphExperienceController,
  GraphExperiencePanel,
  type GraphExperienceDataSource,
  type GraphExperienceTypedActions,
  type GraphRepositoryGenerationBinding,
} from "./graphExperience/index.js";
import {
  GitChangedLineMetricsLoader,
  GitCommitGraphLoader,
} from "./graph/index.js";
import type { VscodeGitRepository } from "./git/vscodeGitApi.js";
import type {
  GitCommandRequest,
  GitCommandRunner,
  GitRootBindingIdentity,
} from "./git/gitCommandRunner.js";
import { GitCommandFailure } from "./git/gitCommandRunner.js";
import { GitRootBindingResolver } from "./git/gitRootBindingResolver.js";
import type {
  GraphBranchStatus,
  GraphCommitRecord,
} from "./graph/graphModels.js";
import {
  repositoryHomeFocusTargetSchema,
  type RepositoryHomeFocusTarget,
} from "../protocol/repositoryHomeProtocol.js";
import { DeveloperDiagnostics } from "./diagnostics/developerDiagnostics.js";

/** Objects retained by activation and their activation-owned disposables. */
export interface GitoExtensionComposition {
  readonly localGitExtensionHost: LocalGitExtensionHost;
  readonly dashboardOrchestrator: DashboardOrchestrator;
  readonly repositoryHomePanel: RepositoryHomePanel;
  readonly navigationProvider: GitoNavigationProvider;
  readonly surfaceHost: GitoSurfaceHost;
  readonly diffExperience: DiffExperience;
  readonly compareExperience: CompareExperience;
  readonly historyExperience: HistoryExperienceController;
  readonly graphExperience: GraphExperienceController;
  readonly disposables: readonly vscode.Disposable[];
}

/**
 * Builds the extension-host graph synchronously. Local VS Code Git discovery
 * may begin while watchers are registered; provider/network I/O waits for an
 * explicit connection or a later repository refresh.
 */
export function composeGitoExtension(
  extensionContext: vscode.ExtensionContext,
): GitoExtensionComposition {
  const developerDiagnostics = new DeveloperDiagnostics();
  const workspaceTrustGuard = createWorkspaceTrustGuard({
    isWorkspaceTrusted: () => vscode.workspace.isTrusted === true,
    requestWorkspaceTrust: async () => {
      await vscode.commands.executeCommand("workbench.action.manageTrust");
    },
    onDidGrantWorkspaceTrust: (listener) =>
      vscode.workspace.onDidGrantWorkspaceTrust(listener),
  });
  const synchronizeWorkspaceTrustContext = (): void => {
    void Promise.resolve(
      vscode.commands.executeCommand(
        "setContext",
        workspaceTrustContextKey,
        vscode.workspace.isTrusted === true,
      ),
    ).catch(() => undefined);
  };
  synchronizeWorkspaceTrustContext();
  const workspaceTrustWatcher = workspaceTrustGuard.onDidGrantWorkspaceTrust(
    synchronizeWorkspaceTrustContext,
  );
  const localGitExtensionHost = new LocalGitExtensionHost(workspaceTrustGuard);
  const trustedCommandRegistry = createTrustedCommandRegistry(
    vscode.commands,
    workspaceTrustGuard,
  );
  const workspaceState = extensionContext.workspaceState;
  const commandExecutor = createVscodeCommandExecutor();
  const diffSymlinkUriProvider = createDiffSymlinkUriProvider({
    onWorkingContentRequested: () =>
      developerDiagnostics.record("diff.content.requested"),
  });
  const gitDiffService = new GitDiffService(
    localGitExtensionHost.gitCommandRunner,
    {
      registrationLimits: diffSymlinkUriProvider.registrationLimits,
      empty: (filePath, side) => diffSymlinkUriProvider.empty(filePath, side),
      file: (filePath) => vscode.Uri.file(filePath),
      symlink: (filePath, repositoryRootPath) =>
        diffSymlinkUriProvider.symlink(filePath, repositoryRootPath),
      workingContent: (
        filePath,
        repositoryRootPath,
        cancellationSignal,
        expectedRepositoryRootIdentity,
      ) =>
        diffSymlinkUriProvider.workingContent(
          filePath,
          repositoryRootPath,
          cancellationSignal,
          expectedRepositoryRootIdentity,
        ),
    },
    localGitExtensionHost.gitRootBindingResolver,
  );
  const diffExperience = new DiffExperience({
    repositoryDiscovery: localGitExtensionHost.repositoryDiscovery,
    gitCommandRunner: localGitExtensionHost.gitCommandRunner,
    gitDiffService,
    symlinkUriProvider: diffSymlinkUriProvider,
    workspaceState,
    developerDiagnostics,
    commandExecutor,
  });
  const githubProvider = new GitHubProvider({
    // Resolve VS Code authentication only when the user explicitly connects.
    authentication: {
      getSession: (providerId, scopes, options) =>
        vscode.authentication.getSession(providerId, scopes, options),
    },
  });
  const dashboardOrchestrator = new DashboardOrchestrator({
    repositoryDiscovery: localGitExtensionHost.repositoryDiscovery,
    repositoryService: localGitExtensionHost.repositoryService,
    historyService: localGitExtensionHost.historyService,
    providers: [githubProvider],
    authorEmails: readConfiguredAuthorEmails(),
    workspaceTrustGuard,
  });
  const authenticationProviderIdsByDashboardProvider = new Map<
    CloudProviderId,
    string
  >([[githubProvider.providerId, githubProvider.providerId]]);
  const repositoryHomePanel = new RepositoryHomePanel(
    extensionContext.extensionUri,
    dashboardOrchestrator,
  );
  const surfaceHost = new GitoSurfaceHost({
    repositoryService: localGitExtensionHost.repositoryService,
    historyService: localGitExtensionHost.historyService,
    worktreeService: localGitExtensionHost.worktreeService,
    repositoryDiscovery: localGitExtensionHost.repositoryDiscovery,
    commandExecutor,
    openHome: (focusTarget) =>
      revealRepositoryHomeAndWaitForLoad(repositoryHomePanel, focusTarget),
  });
  const navigationProvider = new GitoNavigationProvider();

  const compareUriFactory = {
    beginSession: diffSymlinkUriProvider.beginSession,
    empty: diffSymlinkUriProvider.empty,
    symlink: diffSymlinkUriProvider.symlink,
    workingContent: diffSymlinkUriProvider.workingContent,
  };
  const compareService = new CompareService(
    localGitExtensionHost.gitCommandRunner,
    compareUriFactory,
    localGitExtensionHost.gitRootBindingResolver,
  );
  const searchService = new GitSearchService(compareService);
  const compareExperience = new CompareExperience({
    repositoryDiscovery: localGitExtensionHost.repositoryDiscovery,
    compareService,
    searchService,
    gitCommandRunner: localGitExtensionHost.gitCommandRunner,
    workspaceState,
    commandExecutor,
  });

  const repositoryProvider = createRepositoryRootAdapters(
    localGitExtensionHost.repositoryDiscovery,
  );
  const premiumHistoryService = new PremiumHistoryService(
    localGitExtensionHost.gitCommandRunner,
    localGitExtensionHost.gitRootBindingResolver,
  );
  const historyExperience = new HistoryExperienceController({
    historyService: premiumHistoryService,
    repositoryProvider: createHistoryRepositoryProvider(
      localGitExtensionHost.repositoryDiscovery,
    ),
    readSettings: readHistoryExperienceSettings,
  });

  const conflictService = new ConflictService(
    localGitExtensionHost.gitCommandRunner,
    workspaceTrustGuard,
  );
  const conflictExperience = new ConflictExperienceController(conflictService);
  const operationsService = new GitOperationsService({
    commandRunner: localGitExtensionHost.gitCommandRunner,
    gitRootBindingResolver: localGitExtensionHost.gitRootBindingResolver,
    workspaceTrustGuard,
  });
  const operationsExperience = new OperationsExperienceController({
    operations: operationsService,
    repositoryProvider,
    workspaceTrustGuard,
    stateReader: new GitOperationsExperienceStateReader(
      localGitExtensionHost.gitCommandRunner,
    ),
  });

  const graphPanelHolder: { panel?: GraphExperiencePanel } = {};
  const graphSession = createGraphSession(
    localGitExtensionHost.repositoryDiscovery,
    localGitExtensionHost.gitCommandRunner,
    premiumHistoryService,
    compareService,
    gitDiffService,
    localGitExtensionHost.repositoryService,
    workspaceTrustGuard,
    {
      gitRootBindingResolver: localGitExtensionHost.gitRootBindingResolver,
      refreshPanel: () => graphPanelHolder.panel?.refresh(),
    },
  );
  const graphExperience = new GraphExperienceController({
    dataSource: graphSession.dataSource,
    actions: graphSession.actions,
    openPanel: async () => {
      await graphSession.prepare();
      const graphPanel = graphPanelHolder.panel;
      if (graphPanel === undefined)
        throw new Error("Commit Graph panel is unavailable.");
      graphPanel.revealOrCreate();
    },
  });
  const graphPanel = new GraphExperiencePanel(
    extensionContext.extensionUri,
    graphExperience,
    () => graphSession.release(),
  );
  graphPanelHolder.panel = graphPanel;

  const hasOpenLocalRepository = async (): Promise<boolean> => {
    try {
      return (
        (await localGitExtensionHost.repositoryDiscovery.listRepositories())
          .length > 0
      );
    } catch {
      // Bundled Git can be unavailable during startup or in a restricted host.
      return false;
    }
  };
  const syncLocalRepositoryContext = (): void => {
    void synchronizeOnboardingLocalRepositoryContext(
      hasOpenLocalRepository,
    ).catch(() => undefined);
  };
  const repositoryWatcher =
    localGitExtensionHost.repositoryDiscovery.watchRepositoryChanges(
      (repository) => {
        graphSession.handleRepositoryOpened(repository);
        syncLocalRepositoryContext();
        void dashboardOrchestrator.refresh().catch(() => undefined);
      },
      (repository) => {
        graphSession.handleRepositoryClosed(repository);
        void resetOnboardingRepositoryHomeContext().catch(() => undefined);
        syncLocalRepositoryContext();
        void dashboardOrchestrator.refresh().catch(() => undefined);
      },
    );
  const providerConnectionStateWatcher =
    dashboardOrchestrator.onDidChangeProviderConnectionState(
      ({ providerId, isConnected }) => {
        void synchronizeOnboardingProviderConnectionContext(
          providerId,
          isConnected,
        ).catch(() => undefined);
      },
    );
  const repositoryStateWatcher =
    localGitExtensionHost.repositoryDiscovery.watchRepositoryStateChanges(
      (repository) => {
        graphSession.handleRepositoryStateChanged(repository);
        developerDiagnostics.record("repository.state.changed");
        void developerDiagnostics
          .traceOperation("dashboard.refresh.repository-state", () =>
            dashboardOrchestrator.refresh({ refreshStatus: false }),
          )
          .catch(() => undefined);
      },
    );
  const bundledGitEnablementWatcher = watchVscodeExtensionChanges(
    syncLocalRepositoryContext,
  );
  const providerLifecycleRefreshWatcher = watchProviderLifecycleRefreshes(
    dashboardOrchestrator,
    authenticationProviderIdsByDashboardProvider,
  );
  const historyRegistrationDisposables = historyExperience.register(
    trustedCommandRegistry,
  );

  const registeredDisposables: vscode.Disposable[] = [
    ...localGitExtensionHost.registerCommands(trustedCommandRegistry),
    ...diffExperience.registerCommands(trustedCommandRegistry),
    ...compareExperience.registerCommands(trustedCommandRegistry),
    ...surfaceHost.registerCommands(),
    vscode.window.registerTreeDataProvider(
      "gito.navigation",
      navigationProvider,
    ),
    vscode.commands.registerCommand(
      "gito.openHome",
      (focusTargetArgument: unknown) => {
        const parsedFocusTarget = repositoryHomeFocusTargetSchema
          .optional()
          .safeParse(focusTargetArgument);
        if (!parsedFocusTarget.success) return;
        if (parsedFocusTarget.data === undefined) {
          repositoryHomePanel.revealOrCreate();
          return;
        }
        return revealRepositoryHomeAndWaitForLoad(
          repositoryHomePanel,
          parsedFocusTarget.data,
        );
      },
    ),
    vscode.commands.registerCommand("gito.refreshDashboard", () =>
      repositoryHomePanel.refresh(),
    ),
    vscode.window.registerWebviewPanelSerializer(
      "gito.repositoryHome",
      repositoryHomePanel,
    ),
    ...historyRegistrationDisposables,
    ...registerConflictExperienceCommands(
      trustedCommandRegistry,
      conflictExperience,
      repositoryProvider,
    ),
    ...registerOperationsExperienceCommands(
      trustedCommandRegistry,
      operationsExperience,
    ),
    ...graphExperience.registerCommands(trustedCommandRegistry),
    vscode.window.registerWebviewPanelSerializer(
      "gito.commitGraph",
      graphPanel,
    ),
    ...registerOnboardingCommands(vscode.commands, {
      revealRepositoryHome: () =>
        revealRepositoryHomeAndWaitForLoad(repositoryHomePanel),
      connectProvider: async (providerId) => {
        await dashboardOrchestrator.connectProvider(providerId);
        return isDashboardProviderConnected(dashboardOrchestrator, providerId);
      },
      hasOpenLocalRepository,
      confirmSourceControlHidden: confirmSourceControlHidden,
    }),
    repositoryWatcher,
    providerConnectionStateWatcher,
    repositoryStateWatcher,
    bundledGitEnablementWatcher,
    providerLifecycleRefreshWatcher,
    developerDiagnostics,
    createActivationDisposable(() => workspaceTrustWatcher?.dispose()),
    createActivationDisposable(() => localGitExtensionHost.dispose()),
    createActivationDisposable(() => repositoryHomePanel.dispose()),
    createActivationDisposable(() => dashboardOrchestrator.dispose()),
    createActivationDisposable(() => navigationProvider.dispose()),
    createActivationDisposable(() => diffExperience.dispose()),
    createActivationDisposable(() => compareExperience.dispose()),
    createActivationDisposable(() => historyExperience.dispose()),
    createActivationDisposable(() => conflictExperience.dispose()),
    createActivationDisposable(() => operationsService.dispose()),
    createActivationDisposable(() => graphExperience.dispose()),
    createActivationDisposable(() => graphPanel?.dispose()),
    createActivationDisposable(() => graphSession.dispose()),
  ];

  // Initial context sync is intentionally fire-and-forget: activation stays synchronous.
  syncLocalRepositoryContext();
  // First install opens only VS Code's native walkthrough; it never authenticates.
  void openFirstInstallWalkthroughOnce(
    extensionContext.globalState,
    vscode.commands,
  ).catch(() => undefined);

  return {
    localGitExtensionHost,
    dashboardOrchestrator,
    repositoryHomePanel,
    navigationProvider,
    surfaceHost,
    diffExperience,
    compareExperience,
    historyExperience,
    graphExperience,
    disposables: registeredDisposables,
  };
}

function isDashboardProviderConnected(
  dashboardOrchestrator: DashboardOrchestrator,
  providerId: OnboardingProviderId,
): boolean {
  return (
    dashboardOrchestrator
      .getSnapshot()
      .selectedRepository?.cloudDashboards.some(
        (providerDashboard) =>
          providerDashboard.providerId === providerId &&
          providerDashboard.connectionState === "connected",
      ) ?? false
  );
}

function readConfiguredAuthorEmails(): readonly string[] {
  const configuredAuthorEmails = vscode.workspace
    .getConfiguration("gito")
    .get<unknown>("authorEmails", []);
  if (!Array.isArray(configuredAuthorEmails)) return [];
  return configuredAuthorEmails.filter(
    (authorEmail): authorEmail is string => typeof authorEmail === "string",
  );
}

function revealRepositoryHomeAndWaitForLoad(
  repositoryHomePanel: RepositoryHomePanel,
  focusTarget?: RepositoryHomeFocusTarget,
): Promise<void> {
  return repositoryHomePanel.revealAndWaitForLoad(focusTarget);
}

async function confirmSourceControlHidden(): Promise<boolean> {
  const selectedAction = await vscode.window.showInformationMessage(
    onboardingCopy.sourceControlConfirmationPrompt,
    { modal: true },
    "Confirm",
  );
  return selectedAction === "Confirm";
}

function createActivationDisposable(dispose: () => void): vscode.Disposable {
  return new vscode.Disposable(dispose);
}

/**
 * Keeps connected provider state aligned with VS Code authentication changes
 * and refreshes stale provider caches when the window regains focus.
 *
 * The queue is deliberately composition-owned: each event can request one
 * provider, but only one silent provider refresh runs at a time. Events that
 * arrive during that request collapse into one follow-up request per provider.
 */
function watchProviderLifecycleRefreshes(
  dashboardOrchestrator: DashboardOrchestrator,
  authenticationProviderIdsByDashboardProvider: ReadonlyMap<
    CloudProviderId,
    string
  >,
): vscode.Disposable {
  const pendingProviderIds = new Set<CloudProviderId>();
  let refreshQueuePromise: Promise<void> | undefined;
  let isDisposed = false;

  const isConnectedProvider = (providerId: CloudProviderId): boolean =>
    dashboardOrchestrator
      .getSnapshot()
      .selectedRepository?.cloudDashboards.some(
        (providerDashboard) =>
          providerDashboard.providerId === providerId &&
          providerDashboard.connectionState === "connected",
      ) ?? false;

  const drainProviderRefreshQueue = async (): Promise<void> => {
    while (!isDisposed && pendingProviderIds.size > 0) {
      const providerIdsToRefresh = [...pendingProviderIds];
      pendingProviderIds.clear();
      await Promise.all(
        providerIdsToRefresh.map(async (providerId) => {
          try {
            await dashboardOrchestrator.refreshProvider(providerId);
          } catch {
            // Provider refresh errors remain in the dashboard snapshot.
          }
        }),
      );
    }
  };

  const startProviderRefreshDrain = (): void => {
    if (isDisposed || refreshQueuePromise !== undefined) return;
    refreshQueuePromise = Promise.resolve()
      .then(drainProviderRefreshQueue)
      .finally(() => {
        refreshQueuePromise = undefined;
        if (!isDisposed && pendingProviderIds.size > 0)
          startProviderRefreshDrain();
      });
  };

  const queueProviderRefresh = (
    providerId: CloudProviderId,
    refreshTrigger: "authentication" | "windowFocus",
  ): void => {
    if (isDisposed || !isConnectedProvider(providerId)) return;
    if (
      refreshTrigger === "windowFocus" &&
      !dashboardOrchestrator.shouldRefreshProviderDashboard(providerId)
    ) {
      return;
    }
    pendingProviderIds.add(providerId);
    startProviderRefreshDrain();
  };

  const authenticationSessionWatcher =
    vscode.authentication.onDidChangeSessions((event) => {
      const providerId = [...authenticationProviderIdsByDashboardProvider].find(
        ([, authenticationProviderId]) =>
          authenticationProviderId === event.provider.id,
      )?.[0];
      if (providerId !== undefined)
        queueProviderRefresh(providerId, "authentication");
    });
  const windowStateWatcher = vscode.window.onDidChangeWindowState(
    ({ focused }) => {
      if (!focused || isDisposed) return;
      const selectedRepository =
        dashboardOrchestrator.getSnapshot().selectedRepository;
      for (const providerDashboard of selectedRepository?.cloudDashboards ??
        []) {
        if (
          providerDashboard.providerId === "github" &&
          providerDashboard.connectionState === "connected"
        ) {
          queueProviderRefresh(providerDashboard.providerId, "windowFocus");
        }
      }
    },
  );

  return new vscode.Disposable(() => {
    if (isDisposed) return;
    isDisposed = true;
    pendingProviderIds.clear();
    authenticationSessionWatcher.dispose();
    windowStateWatcher.dispose();
    try {
      dashboardOrchestrator.cancelPendingRequests();
    } catch {
      // The orchestrator may already be disposed during host shutdown.
    }
  });
}

/** Re-check setup context if VS Code enables or disables bundled Git. */
function watchVscodeExtensionChanges(
  onExtensionChange: () => void,
): vscode.Disposable {
  return vscode.extensions.onDidChange(() => onExtensionChange());
}

function createVscodeCommandExecutor(): {
  executeCommand(
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ): Promise<unknown>;
} {
  const executeCommand = (
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ): Promise<unknown> =>
    Promise.resolve(
      vscode.commands.executeCommand(commandIdentifier, ...argumentsPassed),
    );
  return {
    executeCommand,
  };
}

function createTrustedCommandRegistry(
  commandRegistry: {
    registerCommand: (
      commandIdentifier: string,
      handler: (...argumentsPassed: readonly unknown[]) => unknown,
    ) => vscode.Disposable;
  },
  workspaceTrustGuard: WorkspaceTrustGuard,
): {
  registerCommand: (
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ) => vscode.Disposable;
} {
  return {
    registerCommand: (commandIdentifier, handler) => {
      const mutationClass =
        workspaceMutationCommandClassifications[
          commandIdentifier as keyof typeof workspaceMutationCommandClassifications
        ];
      if (mutationClass === undefined)
        return commandRegistry.registerCommand(commandIdentifier, handler);
      return commandRegistry.registerCommand(commandIdentifier, (...args) =>
        workspaceTrustGuard.runTrustedMutation(
          `${mutationClass} command ${commandIdentifier}`,
          () => handler(...args),
        ),
      );
    },
  };
}

function createRepositoryRootAdapters(
  repositoryDiscovery: RepositoryDiscovery,
): {
  getRepositoryRoot: () => Promise<string | undefined>;
} {
  return {
    getRepositoryRoot: async () => {
      let repository: VscodeGitRepository;
      try {
        repository = await repositoryDiscovery.selectRepository();
      } catch {
        return undefined;
      }
      assertOperationsRepositoryRoot(repository.rootUri);
      return repository.rootUri.fsPath;
    },
  };
}

export function createHistoryRepositoryProvider(
  repositoryDiscovery: RepositoryDiscovery,
): {
  resolveRepositoryRoot: (
    context: HistoryExperienceRepositoryContext,
  ) => Promise<HistoryRepositoryRoot | undefined>;
  watchRepositoryChanges: (
    onRepositoryChanged: () => void,
  ) => vscode.Disposable;
  watchRepositoryStateChanges: (
    onRepositoryStateChanged: (repositoryRoot: HistoryRepositoryRoot) => void,
  ) => vscode.Disposable;
  isRepositoryRootAuthorized: (
    repositoryRoot: HistoryRepositoryRoot,
    documentUri?: vscode.Uri,
  ) => Promise<boolean>;
  getRepositoryIdentity: (
    repositoryRoot: HistoryRepositoryRoot,
  ) => Promise<string | undefined>;
} {
  return {
    resolveRepositoryRoot: async ({ documentUri }) => {
      try {
        const repositoryRoot = (
          await repositoryDiscovery.selectRepository({
            activeEditorUri: documentUri,
          })
        ).rootUri;
        return isDesktopFileRepositoryRoot(repositoryRoot)
          ? repositoryRoot
          : undefined;
      } catch {
        return undefined;
      }
    },
    isRepositoryRootAuthorized: async (repositoryRoot, documentUri) => {
      if (vscode.workspace.isTrusted !== true) return false;
      if (documentUri !== undefined && documentUri.scheme !== "file")
        return false;
      const selectedRepositoryRoot = toRepositoryRootUri(repositoryRoot);
      if (
        selectedRepositoryRoot === undefined ||
        !isDesktopFileRepositoryRoot(selectedRepositoryRoot)
      )
        return false;
      try {
        const selectedRepository = await repositoryDiscovery.selectRepository({
          selectedRepositoryRoot,
        });
        if (!isDesktopFileRepositoryRoot(selectedRepository.rootUri))
          return false;
        if (
          !areExactRepositoryRootUrisEqual(
            selectedRepository.rootUri,
            selectedRepositoryRoot,
          )
        )
          return false;
        return (
          documentUri === undefined ||
          isUriWithinRepository(selectedRepository.rootUri, documentUri)
        );
      } catch {
        return false;
      }
    },
    getRepositoryIdentity: async (repositoryRoot) => {
      if (vscode.workspace.isTrusted !== true) return undefined;
      const selectedRepositoryRoot = toRepositoryRootUri(repositoryRoot);
      if (
        selectedRepositoryRoot === undefined ||
        !isDesktopFileRepositoryRoot(selectedRepositoryRoot)
      )
        return undefined;
      try {
        const selectedRepository = await repositoryDiscovery.selectRepository({
          selectedRepositoryRoot,
        });
        if (!isDesktopFileRepositoryRoot(selectedRepository.rootUri))
          return undefined;
        if (
          !areExactRepositoryRootUrisEqual(
            selectedRepository.rootUri,
            selectedRepositoryRoot,
          )
        )
          return undefined;
        return repositoryDiscovery.getRepositoryIdentity(
          selectedRepository.rootUri,
        );
      } catch {
        return undefined;
      }
    },
    watchRepositoryChanges: (onRepositoryChanged) =>
      repositoryDiscovery.watchRepositoryChanges(
        () => onRepositoryChanged(),
        () => onRepositoryChanged(),
      ),
    watchRepositoryStateChanges: (onRepositoryStateChanged) =>
      repositoryDiscovery.watchRepositoryStateChanges((repository) =>
        isDesktopFileRepositoryRoot(repository.rootUri)
          ? onRepositoryStateChanged(repository.rootUri)
          : undefined,
      ),
  };
}

/** History and command cwd adapters are desktop-only; reject remote roots. */
function isDesktopFileRepositoryRoot(repositoryRoot: vscode.Uri): boolean {
  return repositoryRoot.scheme === "file";
}

export function assertOperationsRepositoryRoot(
  repositoryRoot: vscode.Uri,
): void {
  assertDesktopFileRepositoryRoot(
    repositoryRoot,
    "Operations Center requires a local desktop Git repository; remote workspaces are not supported.",
  );
}

export function assertGraphRepositoryRoot(repositoryRoot: vscode.Uri): void {
  assertDesktopFileRepositoryRoot(
    repositoryRoot,
    "Commit Graph requires a local desktop Git repository; remote workspaces are not supported.",
  );
}

function assertDesktopFileRepositoryRoot(
  repositoryRoot: vscode.Uri,
  errorMessage: string,
): void {
  if (!isDesktopFileRepositoryRoot(repositoryRoot))
    throw new Error(errorMessage);
}

function toRepositoryRootUri(
  repositoryRoot: HistoryRepositoryRoot,
): vscode.Uri | undefined {
  if (typeof repositoryRoot === "string") {
    try {
      return vscode.Uri.file(repositoryRoot);
    } catch {
      return undefined;
    }
  }
  if (
    repositoryRoot === undefined ||
    typeof repositoryRoot.fsPath !== "string" ||
    typeof repositoryRoot.scheme !== "string"
  )
    return undefined;
  return repositoryRoot;
}

function readHistoryExperienceSettings(): Record<string, unknown> {
  const configuration = vscode.workspace.getConfiguration("gito");
  return {
    enabled: configuration.get("history.enabled", false),
    blameEnabled: configuration.get("history.blame.enabled", false),
    codeLensEnabled: configuration.get("history.codeLens.enabled", false),
    maxFileSizeBytes: configuration.get("history.maxFileSizeBytes", 1_000_000),
    cacheEntryLimit: configuration.get("history.cacheEntryLimit", 64),
  };
}

interface GraphSessionRecord {
  readonly repository: VscodeGitRepository;
  readonly repositoryRootUri: vscode.Uri;
  readonly rootUri: vscode.Uri;
  readonly pinnedRoot: PinnedGraphRepositoryRoot;
  readonly commandRunner: GitCommandRunner;
  readonly repositoryGeneration: string;
  readonly runtime: {
    getLoadedCommitActionTarget: (
      commitSha: string,
      parentSha: string | undefined,
      cancellationSignal: AbortSignal,
    ) => Promise<GraphCommitRecord | undefined>;
    getSummary: GraphExperienceDataSource["getSummary"];
    queryPage: GraphExperienceDataSource["queryPage"];
    getMinimap: GraphExperienceDataSource["getMinimap"];
    getChangedLineMetrics: GraphExperienceDataSource["getChangedLineMetrics"];
    getLoadedCheckoutTarget: (
      requestedTarget: string,
      cancellationSignal: AbortSignal,
    ) => Promise<
      | {
          readonly kind: "branch" | "remote" | "detached";
          readonly target: string;
        }
      | undefined
    >;
    getLoadedBranchStatus: (
      requestedReferenceName: string,
      cancellationSignal: AbortSignal,
    ) => Promise<
      | {
          readonly localRefName: string;
          readonly upstreamRefName?: string;
          readonly mergeBaseSha?: string;
          readonly aheadCount: number;
          readonly behindCount: number;
        }
      | undefined
    >;
    invalidate: () => void;
    dispose: () => void;
  };
}

export interface PinnedGraphRepositoryRoot {
  readonly requestedRootPath: string;
  readonly canonicalRootPath: string;
  readonly deviceAndInodeKey: string;
  readonly rootBindingIdentity: GitRootBindingIdentity;
  readonly uri: vscode.Uri;
}

export interface GraphSession {
  readonly dataSource: GraphExperienceDataSource;
  readonly actions: ReturnType<typeof createGraphExperienceActions>;
  prepare(): Promise<GraphSessionRecord>;
  handleRepositoryOpened(repository: VscodeGitRepository): void;
  handleRepositoryClosed(repository: VscodeGitRepository): void;
  handleRepositoryStateChanged(repository: VscodeGitRepository): void;
  release(): void;
  dispose(): void;
}

export interface GraphSessionConstructionOptions {
  readonly gitRootBindingResolver?: GitRootBindingResolver;
  /** Refreshes an already-open graph panel after repository identity changes. */
  readonly refreshPanel?: () => void;
  readonly pinGraphRepositoryRoot?: (
    repositoryRootUri: vscode.Uri,
  ) => Promise<PinnedGraphRepositoryRoot>;
}

export function createGraphSession(
  repositoryDiscovery: RepositoryDiscovery,
  gitCommandRunner: LocalGitExtensionHost["gitCommandRunner"],
  premiumHistoryService: PremiumHistoryService,
  compareService: CompareService,
  gitDiffService: GitDiffService,
  localGitRepositoryService: LocalGitExtensionHost["repositoryService"],
  workspaceTrustGuard: WorkspaceTrustGuard,
  constructionOptions: GraphSessionConstructionOptions = {},
): GraphSession {
  let activeRecord: GraphSessionRecord | undefined;
  let pendingPreparation: Promise<GraphSessionRecord> | undefined;
  let sessionDisposed = false;
  let preparationGeneration = 0;
  let repositoryGenerationCounter = 0;
  const graphRootBindingResolver =
    constructionOptions.gitRootBindingResolver ?? new GitRootBindingResolver();
  const pinRepositoryRoot =
    constructionOptions.pinGraphRepositoryRoot ??
    ((repositoryRootUri: vscode.Uri) =>
      pinGraphRepositoryRoot(repositoryRootUri, graphRootBindingResolver));

  const assertPreparationCurrent = (expectedGeneration: number): void => {
    if (sessionDisposed)
      throw new Error("The commit graph session has been disposed.");
    if (preparationGeneration !== expectedGeneration)
      throw new Error(
        "The selected Git repository changed; refresh the graph.",
      );
  };

  const prepareRepository = async (): Promise<GraphSessionRecord> => {
    const expectedPreparationGeneration = ++preparationGeneration;
    const repository = await repositoryDiscovery.selectRepository();
    assertPreparationCurrent(expectedPreparationGeneration);
    assertGraphRepositoryRoot(repository.rootUri);
    if (
      activeRecord?.repository === repository &&
      areExactRepositoryRootUrisEqual(
        activeRecord.repositoryRootUri,
        repository.rootUri,
      )
    ) {
      const isPinnedRootCurrent = await isPinnedGraphRepositoryRootCurrent(
        activeRecord.pinnedRoot,
      );
      assertPreparationCurrent(expectedPreparationGeneration);
      if (!isPinnedRootCurrent) {
        activeRecord.runtime.dispose();
        activeRecord = undefined;
        constructionOptions.refreshPanel?.();
        throw new Error(
          "The selected Git repository path changed; refresh the graph.",
        );
      }
      return activeRecord;
    }
    const staleRecord = activeRecord;
    if (staleRecord !== undefined) {
      staleRecord.runtime.dispose();
      activeRecord = undefined;
      constructionOptions.refreshPanel?.();
    }
    const repositoryRootUri = repository.rootUri;
    const pinnedRoot = await pinRepositoryRoot(repositoryRootUri);
    assertPreparationCurrent(expectedPreparationGeneration);
    const repositoryGeneration = `${++repositoryGenerationCounter}:${pinnedRoot.uri.toString()}:${pinnedRoot.deviceAndInodeKey}`;
    const graphCommandRunner = createPinnedGraphCommandRunner(
      gitCommandRunner,
      pinnedRoot,
      () =>
        isCurrentRepository(
          repositoryDiscovery,
          repository,
          repositoryRootUri,
          pinnedRoot,
          repositoryGeneration,
          () => activeRecord,
          graphRootBindingResolver,
        ),
    );
    const binding: GraphRepositoryGenerationBinding = {
      repositoryRoot: pinnedRoot.canonicalRootPath,
      generation: repositoryGeneration,
      isCurrent: () =>
        isCurrentRepository(
          repositoryDiscovery,
          repository,
          repositoryRootUri,
          pinnedRoot,
          repositoryGeneration,
          () => activeRecord,
          graphRootBindingResolver,
        ),
      currentStateKey: () => createGraphRepositoryStateKey(repository),
    };
    const changedLineMetricsLoader = new GitChangedLineMetricsLoader(
      graphCommandRunner,
      { fsPath: pinnedRoot.canonicalRootPath },
    );
    const runtime = createGraphExperienceRuntimeDataSource({
      repository: binding,
      graphLoader: new GitCommitGraphLoader(graphCommandRunner),
      branchStatusLoader: (localRefName, cancellationSignal) =>
        loadExactGraphBranchStatus(
          graphCommandRunner,
          pinnedRoot.canonicalRootPath,
          localRefName,
          cancellationSignal,
        ),
      metricsLoader: (commitSha, cancellationSignal) =>
        changedLineMetricsLoader.loadChangedLineMetrics(
          commitSha,
          cancellationSignal,
        ),
      repositoryDisplayName:
        pinnedRoot.canonicalRootPath.split(/[\\/]/u).at(-1) ??
        pinnedRoot.canonicalRootPath,
    });
    try {
      assertPreparationCurrent(expectedPreparationGeneration);
      activeRecord = {
        repository,
        repositoryRootUri,
        rootUri: pinnedRoot.uri,
        pinnedRoot,
        commandRunner: graphCommandRunner,
        repositoryGeneration,
        runtime,
      };
      return activeRecord;
    } catch (error: unknown) {
      runtime.dispose();
      throw error;
    }
  };
  const prepare = (): Promise<GraphSessionRecord> => {
    if (sessionDisposed)
      return Promise.reject(
        new Error("The commit graph session has been disposed."),
      );
    if (pendingPreparation !== undefined) return pendingPreparation;
    const nextPreparation = prepareRepository();
    pendingPreparation = nextPreparation;
    void nextPreparation.then(
      () => {
        if (pendingPreparation === nextPreparation)
          pendingPreparation = undefined;
      },
      () => {
        if (pendingPreparation === nextPreparation)
          pendingPreparation = undefined;
      },
    );
    return nextPreparation;
  };

  const dataSource: GraphExperienceDataSource = {
    getSummary: async (cancellationSignal) =>
      (await prepare()).runtime.getSummary(cancellationSignal),
    queryPage: async (request, cancellationSignal) =>
      (await prepare()).runtime.queryPage(request, cancellationSignal),
    getMinimap: async (request, cancellationSignal) =>
      (await prepare()).runtime.getMinimap(request, cancellationSignal),
    getChangedLineMetrics: async (commitSha, cancellationSignal) =>
      (await prepare()).runtime.getChangedLineMetrics(
        commitSha,
        cancellationSignal,
      ),
  };

  const assertCurrent = async (context: {
    readonly repositoryGeneration: string;
  }): Promise<GraphSessionRecord> => {
    const record = activeRecord;
    if (
      record === undefined ||
      record.repositoryGeneration !== context.repositoryGeneration
    )
      throw new Error(
        "The selected Git repository changed; refresh the graph.",
      );
    if (
      !(await isCurrentRepository(
        repositoryDiscovery,
        record.repository,
        record.repositoryRootUri,
        record.pinnedRoot,
        record.repositoryGeneration,
        () => activeRecord,
        graphRootBindingResolver,
      ))
    )
      throw new Error(
        "The selected Git repository changed; refresh the graph.",
      );
    return record;
  };

  const actions = createGraphExperienceActions({
    contextProvider: {
      getContext: async (cancellationSignal) => {
        const record = await prepare();
        return {
          repositoryRoot: record.repositoryRootUri,
          repositoryGeneration: record.repositoryGeneration,
          cancellationSignal,
          assertCurrent: async () => {
            await assertCurrent(record);
          },
        };
      },
    },
    typedActions: {
      openCommit: async (context, commitSha) => {
        const record = await assertCurrent(context);
        const loadedCommit = await record.runtime.getLoadedCommitActionTarget(
          commitSha,
          undefined,
          context.cancellationSignal,
        );
        if (loadedCommit === undefined)
          throw new Error(
            "The selected graph commit is no longer loaded; refresh the graph.",
          );
        const historyResult = await premiumHistoryService.search(
          record.repositoryRootUri,
          { terms: [{ field: "sha", value: commitSha }], limit: 1 },
          context.cancellationSignal,
        );
        const commit = historyResult.matches[0];
        if (commit === undefined)
          throw new Error("Git returned no metadata for that commit.");
        await assertCurrent(context);
        await vscode.commands.executeCommand(
          historyExperienceCommandIds.openCommit,
          { repositoryRoot: record.repositoryRootUri, commit },
        );
      },
      openDiff: async (context, commitSha) => {
        const record = await assertCurrent(context);
        const loadedCommit = await record.runtime.getLoadedCommitActionTarget(
          commitSha,
          undefined,
          context.cancellationSignal,
        );
        if (loadedCommit === undefined)
          throw new Error(
            "The selected graph commit is no longer loaded; refresh the graph.",
          );
        const diffPlan = await gitDiffService.createCommitVsParentPlan({
          repositoryRoot: record.repositoryRootUri,
          commitRevision: commitSha,
          cancellationSignal: context.cancellationSignal,
        });
        if (diffPlan.kind !== "repository")
          throw new Error("Git returned an incomplete commit diff.");
        const openPlan = createDiffRepositoryOpenPlan(
          diffPlan,
          `Commit ${commitSha.slice(0, 8)}`,
        );
        await assertCurrent(context);
        await vscode.commands.executeCommand(
          openPlan.command,
          ...openPlan.arguments,
        );
      },
      compareWithParent: async (context, commitSha, parentSha) => {
        if (parentSha === undefined || parentSha.trim().length === 0)
          throw new Error("The selected commit has no parent to compare.");
        const record = await assertCurrent(context);
        const loadedCommit = await record.runtime.getLoadedCommitActionTarget(
          commitSha,
          parentSha,
          context.cancellationSignal,
        );
        if (loadedCommit === undefined)
          throw new Error(
            "The selected graph commit or parent is no longer loaded; refresh the graph.",
          );
        const compareResult = await compareService.compare({
          repositoryRoot: record.repositoryRootUri,
          left: { kind: "ref", ref: parentSha },
          right: { kind: "ref", ref: commitSha },
          mode: "direct",
          cancellationSignal: context.cancellationSignal,
        });
        const openPlan = createCompareOpenPlan(compareResult);
        await assertCurrent(context);
        await vscode.commands.executeCommand(
          openPlan.command,
          ...openPlan.arguments,
        );
      },
      checkoutReference: async (context, referenceName) => {
        await workspaceTrustGuard.runTrustedMutation(
          "checkout a graph reference",
          async (assertTrustedImmediatelyBeforeMutation) => {
            const record = await assertCurrent(context);
            const checkoutTarget = await record.runtime.getLoadedCheckoutTarget(
              referenceName,
              context.cancellationSignal,
            );
            if (checkoutTarget === undefined)
              throw new Error(
                "The selected graph reference is no longer loaded; refresh the graph.",
              );
            const selectionContext = {
              selectedRepositoryRoot: record.repositoryRootUri,
              expectedRepository: record.repository,
            };
            if (checkoutTarget.kind === "branch") {
              await assertCurrent(context);
              await assertPinnedGraphRepositoryBindingCurrent(
                record.pinnedRoot,
                graphRootBindingResolver,
              );
              assertTrustedImmediatelyBeforeMutation();
              await localGitRepositoryService.checkoutBranch(
                checkoutTarget.target,
                selectionContext,
                false,
                context.cancellationSignal,
              );
              await assertPinnedGraphRepositoryBindingCurrent(
                record.pinnedRoot,
                graphRootBindingResolver,
              );
              return;
            }
            if (checkoutTarget.kind === "remote") {
              await assertCurrent(context);
              await assertPinnedGraphRepositoryBindingCurrent(
                record.pinnedRoot,
                graphRootBindingResolver,
              );
              assertTrustedImmediatelyBeforeMutation();
              await localGitRepositoryService.checkoutBranch(
                checkoutTarget.target,
                selectionContext,
                true,
                context.cancellationSignal,
              );
              await assertPinnedGraphRepositoryBindingCurrent(
                record.pinnedRoot,
                graphRootBindingResolver,
              );
              return;
            }
            await assertCurrent(context);
            await assertPinnedGraphRepositoryBindingCurrent(
              record.pinnedRoot,
              graphRootBindingResolver,
            );
            assertTrustedImmediatelyBeforeMutation();
            await record.commandRunner.run({
              repositoryRoot: record.pinnedRoot.canonicalRootPath,
              arguments: ["switch", "--detach", "--", checkoutTarget.target],
              cancellationSignal: context.cancellationSignal,
            });
            await assertPinnedGraphRepositoryBindingCurrent(
              record.pinnedRoot,
              graphRootBindingResolver,
            );
          },
        );
      },
      showBranchStatus: async (context, referenceName) => {
        const record = await assertCurrent(context);
        const branchStatus = await record.runtime.getLoadedBranchStatus(
          referenceName,
          context.cancellationSignal,
        );
        if (branchStatus === undefined)
          throw new Error(
            "Branch status is supported only for a loaded local branch.",
          );
        const upstreamLabel =
          branchStatus.upstreamRefName === undefined
            ? "no upstream"
            : `${branchStatus.aheadCount} ahead · ${branchStatus.behindCount} behind`;
        const mergeBaseLabel =
          branchStatus.mergeBaseSha === undefined
            ? "no common ancestor"
            : `merge base ${branchStatus.mergeBaseSha.slice(0, 8)}`;
        const status = `${upstreamLabel} · ${mergeBaseLabel}`;
        await assertCurrent(context);
        await vscode.window.showInformationMessage(
          `${referenceName}: ${status}`,
        );
      },
    } satisfies GraphExperienceTypedActions,
  });

  return {
    dataSource,
    actions,
    prepare,
    handleRepositoryOpened: (repository) => {
      if (sessionDisposed) return;
      preparationGeneration += 1;
      const record = activeRecord;
      if (record === undefined) return;
      if (record.repository === repository) {
        record.runtime.invalidate();
        constructionOptions.refreshPanel?.();
        return;
      }
      if (
        areExactRepositoryRootUrisEqual(
          record.repositoryRootUri,
          repository.rootUri,
        )
      ) {
        record.runtime.dispose();
        activeRecord = undefined;
        constructionOptions.refreshPanel?.();
      }
    },
    handleRepositoryClosed: (repository) => {
      if (sessionDisposed) return;
      preparationGeneration += 1;
      const record = activeRecord;
      if (record === undefined || record.repository !== repository) return;
      record.runtime.dispose();
      activeRecord = undefined;
      constructionOptions.refreshPanel?.();
    },
    handleRepositoryStateChanged: (repository) => {
      if (sessionDisposed) return;
      const record = activeRecord;
      if (record?.repository !== repository) return;
      record.runtime.invalidate();
      constructionOptions.refreshPanel?.();
    },
    release: () => {
      if (sessionDisposed) return;
      preparationGeneration += 1;
      activeRecord?.runtime.dispose();
      activeRecord = undefined;
    },
    dispose: () => {
      if (sessionDisposed) return;
      sessionDisposed = true;
      preparationGeneration += 1;
      activeRecord?.runtime.dispose();
      activeRecord = undefined;
    },
  };
}

async function isCurrentRepository(
  repositoryDiscovery: RepositoryDiscovery,
  repository: VscodeGitRepository,
  repositoryRootUri: vscode.Uri,
  pinnedRoot: PinnedGraphRepositoryRoot,
  generation: string,
  activeRecordProvider: () => GraphSessionRecord | undefined,
  graphRootBindingResolver: GitRootBindingResolver,
): Promise<boolean> {
  const activeRecord = activeRecordProvider();
  if (
    activeRecord === undefined ||
    activeRecord.repository !== repository ||
    activeRecord.repositoryGeneration !== generation ||
    !areExactRepositoryRootUrisEqual(
      activeRecord.repositoryRootUri,
      repositoryRootUri,
    )
  )
    return false;
  try {
    if (!(await isPinnedGraphRepositoryRootCurrent(pinnedRoot))) return false;
    if (
      !(await isPinnedGraphRepositoryBindingCurrent(
        pinnedRoot,
        graphRootBindingResolver,
      ))
    )
      return false;
    if (activeRecordProvider() !== activeRecord) return false;
    const repositories = await repositoryDiscovery.listRepositories();
    if (activeRecordProvider() !== activeRecord) return false;
    return repositories.some(
      (candidateRepository) =>
        candidateRepository === repository &&
        areExactRepositoryRootUrisEqual(
          candidateRepository.rootUri,
          repositoryRootUri,
        ),
    );
  } catch {
    return false;
  }
}

export async function pinGraphRepositoryRoot(
  repositoryRootUri: vscode.Uri,
  graphRootBindingResolver: GitRootBindingResolver = new GitRootBindingResolver(),
): Promise<PinnedGraphRepositoryRoot> {
  const requestedRootPath = repositoryRootUri.fsPath;
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await realpath(requestedRootPath);
  } catch {
    throw new Error("The selected Git repository path is unavailable.");
  }
  let rootStatistics: Awaited<ReturnType<typeof stat>>;
  try {
    rootStatistics = await stat(canonicalRootPath, { bigint: true });
  } catch {
    throw new Error("The selected Git repository path is unavailable.");
  }
  if (!rootStatistics.isDirectory())
    throw new Error("The selected Git repository root is not a directory.");
  let rootBindingIdentity: GitRootBindingIdentity;
  try {
    rootBindingIdentity =
      await graphRootBindingResolver.resolve(requestedRootPath);
  } catch {
    throw new Error("The selected Git repository root is unavailable.");
  }
  if (
    rootBindingIdentity.canonicalPath !== canonicalRootPath ||
    `${rootBindingIdentity.device}:${rootBindingIdentity.inode}` !==
      `${String(rootStatistics.dev)}:${String(rootStatistics.ino)}`
  )
    throw new Error("The selected Git repository path changed during pinning.");
  return {
    requestedRootPath,
    canonicalRootPath,
    deviceAndInodeKey: `${rootBindingIdentity.device}:${rootBindingIdentity.inode}`,
    rootBindingIdentity,
    uri: vscode.Uri.file(canonicalRootPath),
  };
}

export async function isPinnedGraphRepositoryRootCurrent(
  pinnedRoot: PinnedGraphRepositoryRoot,
): Promise<boolean> {
  try {
    const currentCanonicalRootPath = await realpath(
      pinnedRoot.requestedRootPath,
    );
    const rootStatistics = await stat(pinnedRoot.canonicalRootPath, {
      bigint: true,
    });
    return (
      currentCanonicalRootPath === pinnedRoot.canonicalRootPath &&
      rootStatistics.isDirectory() &&
      `${String(rootStatistics.dev)}:${String(rootStatistics.ino)}` ===
        pinnedRoot.deviceAndInodeKey
    );
  } catch {
    return false;
  }
}

async function isPinnedGraphRepositoryBindingCurrent(
  pinnedRoot: PinnedGraphRepositoryRoot,
  graphRootBindingResolver: GitRootBindingResolver,
): Promise<boolean> {
  try {
    const currentIdentity = await graphRootBindingResolver.assert(
      pinnedRoot.requestedRootPath,
      pinnedRoot.rootBindingIdentity,
    );
    return (
      currentIdentity.canonicalPath === pinnedRoot.canonicalRootPath &&
      `${currentIdentity.device}:${currentIdentity.inode}` ===
        pinnedRoot.deviceAndInodeKey
    );
  } catch {
    return false;
  }
}

async function assertPinnedGraphRepositoryBindingCurrent(
  pinnedRoot: PinnedGraphRepositoryRoot,
  graphRootBindingResolver: GitRootBindingResolver,
): Promise<void> {
  if (
    await isPinnedGraphRepositoryBindingCurrent(
      pinnedRoot,
      graphRootBindingResolver,
    )
  )
    return;
  throw new Error(
    "The selected Git repository metadata changed; refresh the graph.",
  );
}

function createPinnedGraphCommandRunner(
  underlyingGitCommandRunner: GitCommandRunner,
  pinnedRoot: PinnedGraphRepositoryRoot,
  assertRepositoryCurrent: () => Promise<boolean>,
): GitCommandRunner {
  const assertPinnedRootBeforeCommand = async (): Promise<void> => {
    if (await assertRepositoryCurrent()) return;
    throw new Error(
      "The selected Git repository path changed; refresh the graph.",
    );
  };
  const pinCommandRequest = (
    commandRequest: GitCommandRequest,
  ): GitCommandRequest => ({
    ...commandRequest,
    repositoryRoot: pinnedRoot.canonicalRootPath,
    rootBinding: pinnedRoot.rootBindingIdentity,
  });
  return {
    run: async (commandRequest) => {
      await assertPinnedRootBeforeCommand();
      return underlyingGitCommandRunner.run(pinCommandRequest(commandRequest));
    },
    runStreaming: async (commandRequest, onStandardOutputChunk) => {
      await assertPinnedRootBeforeCommand();
      return underlyingGitCommandRunner.runStreaming(
        pinCommandRequest(commandRequest),
        onStandardOutputChunk,
      );
    },
  };
}

function createGraphRepositoryStateKey(
  repository: VscodeGitRepository,
): string {
  const repositoryState = repository.state;
  return JSON.stringify({
    head: repositoryState.HEAD?.name ?? "",
    headCommit: repositoryState.HEAD?.commit ?? "",
    worktrees: repositoryState.worktrees
      .map((worktree) => [
        worktree.name,
        worktree.path,
        worktree.ref,
        worktree.main,
        worktree.detached,
      ])
      .sort(compareSerializedStateEntries),
    rebaseCommit: repositoryState.rebaseCommit?.hash ?? "",
    mergeChanges: serializeGraphResourceStates(repositoryState.mergeChanges),
    indexChanges: serializeGraphResourceStates(repositoryState.indexChanges),
    workingTreeChanges: serializeGraphResourceStates(
      repositoryState.workingTreeChanges,
    ),
    untrackedChanges: serializeGraphResourceStates(
      repositoryState.untrackedChanges,
    ),
  });
}

async function loadExactGraphBranchStatus(
  graphCommandRunner: GitCommandRunner,
  repositoryRootPath: string,
  localRefName: string,
  cancellationSignal: AbortSignal,
): Promise<GraphBranchStatus | undefined> {
  const upstreamOutput = await graphCommandRunner.run({
    repositoryRoot: repositoryRootPath,
    arguments: ["for-each-ref", "--format=%(upstream)", localRefName],
    cancellationSignal,
    maxStandardOutputBytes: 8 * 1024,
  });
  if (upstreamOutput.standardOutputTruncated === true)
    throw new Error("Git returned truncated branch tracking metadata.");
  const upstreamRefName = upstreamOutput.standardOutput.trim();
  if (upstreamRefName.length === 0)
    return { localRefName, aheadCount: 0, behindCount: 0 };

  const countsOutput = await graphCommandRunner.run({
    repositoryRoot: repositoryRootPath,
    arguments: [
      "rev-list",
      "--left-right",
      "--count",
      `${localRefName}...${upstreamRefName}`,
    ],
    cancellationSignal,
    maxStandardOutputBytes: 8 * 1024,
  });
  if (countsOutput.standardOutputTruncated === true)
    throw new Error("Git returned truncated branch divergence counts.");
  const countsMatch = /^(\d+)\s+(\d+)$/u.exec(
    countsOutput.standardOutput.trim(),
  );
  if (countsMatch === null)
    throw new Error("Git returned incomplete branch divergence counts.");
  const aheadCount = Number(countsMatch[1]);
  const behindCount = Number(countsMatch[2]);
  if (!Number.isSafeInteger(aheadCount) || !Number.isSafeInteger(behindCount))
    throw new Error("Git returned invalid branch divergence counts.");

  let mergeBaseSha: string | undefined;
  try {
    const mergeBaseOutput = await graphCommandRunner.run({
      repositoryRoot: repositoryRootPath,
      arguments: ["merge-base", localRefName, upstreamRefName],
      cancellationSignal,
      maxStandardOutputBytes: 8 * 1024,
    });
    if (mergeBaseOutput.standardOutputTruncated === true)
      throw new Error("Git returned a truncated merge base.");
    const candidateMergeBaseSha = mergeBaseOutput.standardOutput.trim();
    if (candidateMergeBaseSha.length > 0) mergeBaseSha = candidateMergeBaseSha;
  } catch (error: unknown) {
    // Git uses exit 1 for two valid revisions with no common ancestor.
    if (!(error instanceof GitCommandFailure) || error.exitCode !== 1)
      throw error;
  }
  return {
    localRefName,
    upstreamRefName,
    ...(mergeBaseSha === undefined ? {} : { mergeBaseSha }),
    aheadCount,
    behindCount,
  };
}

function serializeGraphResourceStates(
  resourceStates: readonly {
    readonly uri: vscode.Uri;
    readonly originalUri: vscode.Uri;
    readonly renameUri: vscode.Uri | undefined;
    readonly status: number;
  }[],
): readonly (readonly [string, string, string, number])[] {
  return resourceStates
    .map((resourceState): readonly [string, string, string, number] => [
      resourceState.uri.toString(),
      resourceState.originalUri.toString(),
      resourceState.renameUri?.toString() ?? "",
      resourceState.status,
    ])
    .sort(compareSerializedStateEntries);
}

function compareSerializedStateEntries(
  leftEntry: readonly unknown[],
  rightEntry: readonly unknown[],
): number {
  return JSON.stringify(leftEntry).localeCompare(JSON.stringify(rightEntry));
}
