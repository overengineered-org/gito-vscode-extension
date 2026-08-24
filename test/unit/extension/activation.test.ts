// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const activationTestState = vi.hoisted(() => {
  class HoistedTestDisposable {
    private isDisposed = false;

    public constructor(private readonly onDispose: () => void = () => {}) {}

    public dispose(): void {
      if (this.isDisposed) return;
      this.isDisposed = true;
      this.onDispose();
    }
  }

  const commandIdentifiers: string[] = [];
  const commandHandlers = new Map<string, () => unknown>();
  const registerCommand = (
    commandIdentifier: string,
    commandHandler: () => unknown,
  ): HoistedTestDisposable => {
    commandIdentifiers.push(commandIdentifier);
    commandHandlers.set(commandIdentifier, commandHandler);
    return new HoistedTestDisposable();
  };

  return {
    DisposableClass: HoistedTestDisposable,
    commandIdentifiers,
    commandHandlers,
    registerCommand,
    nativeCommandCalls: [] as unknown[][],
    globalStateValues: new Map<string, unknown>(),
    workspaceStateValues: new Map<string, unknown>(),
    configuredRepositories: [] as unknown[],
    bundledGitAvailable: true,
    workspaceTrusted: true,
    workspaceTrustGrantedListeners: [] as Array<() => void>,
    authenticationSessionChangedListeners: [] as Array<
      (event: {
        provider: { id: string };
        added: readonly unknown[];
        removed: readonly unknown[];
        changed: readonly unknown[];
      }) => void
    >,
    windowStateChangedListeners: [] as Array<
      (event: { focused: boolean }) => void
    >,
    repositoryOpened: undefined as (() => void) | undefined,
    repositoryClosed: undefined as (() => void) | undefined,
    repositoryStateChangedListeners: [] as Array<(repository: unknown) => void>,
    extensionChanged: undefined as (() => void) | undefined,
    repositoryWatcherDisposed: 0,
    textEditorSelectionWatcherDisposed: 0,
    panelRevealedAndLoaded: 0,
    dashboardLoaded: 0,
    dashboardProviderIds: [] as string[],
    dashboardRefreshOptions: [] as unknown[],
    dashboardProviderRefreshes: [] as string[],
    panelDisposed: 0,
    dashboardDisposed: 0,
    dashboardHasSelectedRepository: false,
    dashboardProviderConnectionStates: {
      github: "disconnected",
    },
    dashboardProviderCacheStatuses: {
      github: undefined as "fresh" | "stale" | undefined,
    },
    dashboardProviderCacheExpired: { github: false },
    sharedGitRootBindingResolver: {},
    gitDiffRootBindingResolver: undefined as object | undefined,
    compareRootBindingResolver: undefined as object | undefined,
    compareServiceInstance: undefined as object | undefined,
    searchCompareService: undefined as object | undefined,
    navigationDisposed: 0,
    contentProviderSchemes: [] as string[],
    workingContentProvider: undefined as object | undefined,
    workingContentProviderRegistrations: [] as Array<{
      scheme: string;
      provider: unknown;
      options: {
        readonly isCaseSensitive?: boolean;
        readonly isReadonly?: boolean;
      };
      disposed: boolean;
    }>,
  };
});

interface DisposableLike {
  dispose(): void;
}

function registerCommand(
  commandIdentifier: string,
  commandHandler: () => unknown,
): DisposableLike {
  return activationTestState.registerCommand(commandIdentifier, commandHandler);
}

vi.mock("vscode", () => ({
  Disposable: activationTestState.DisposableClass,
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  commands: {
    registerCommand: activationTestState.registerCommand,
    executeCommand: (...commandArguments: readonly unknown[]) => {
      activationTestState.nativeCommandCalls.push([...commandArguments]);
      return Promise.resolve(undefined);
    },
  },
  window: {
    createOutputChannel: () => ({
      info: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    registerTreeDataProvider: () => new activationTestState.DisposableClass(),
    registerWebviewPanelSerializer: () =>
      new activationTestState.DisposableClass(),
    showInformationMessage: () => Promise.resolve("Confirm"),
    showWarningMessage: () => Promise.resolve("Cancel"),
    showErrorMessage: () => Promise.resolve("Close"),
    onDidChangeActiveTextEditor: () =>
      new activationTestState.DisposableClass(),
    onDidChangeTextEditorSelection: () =>
      new activationTestState.DisposableClass(() => {
        activationTestState.textEditorSelectionWatcherDisposed += 1;
      }),
    onDidChangeWindowState: (
      listener: (event: { focused: boolean }) => void,
    ) => {
      activationTestState.windowStateChangedListeners.push(listener);
      return new activationTestState.DisposableClass(() => {
        const listenerIndex =
          activationTestState.windowStateChangedListeners.indexOf(listener);
        if (listenerIndex >= 0)
          activationTestState.windowStateChangedListeners.splice(
            listenerIndex,
            1,
          );
      });
    },
    createTextEditorDecorationType: () =>
      new activationTestState.DisposableClass(),
    createStatusBarItem: () => new activationTestState.DisposableClass(),
  },
  extensions: {
    onDidChange: (listener: () => void) => {
      activationTestState.extensionChanged = listener;
      return new activationTestState.DisposableClass();
    },
  },
  authentication: {
    onDidChangeSessions: (
      listener: (event: {
        provider: { id: string };
        added: readonly unknown[];
        removed: readonly unknown[];
        changed: readonly unknown[];
      }) => void,
    ) => {
      activationTestState.authenticationSessionChangedListeners.push(listener);
      return new activationTestState.DisposableClass(() => {
        const listenerIndex =
          activationTestState.authenticationSessionChangedListeners.indexOf(
            listener,
          );
        if (listenerIndex >= 0)
          activationTestState.authenticationSessionChangedListeners.splice(
            listenerIndex,
            1,
          );
      });
    },
  },
  workspace: {
    get isTrusted(): boolean {
      return activationTestState.workspaceTrusted;
    },
    onDidChangeTextDocument: () => new activationTestState.DisposableClass(),
    onDidCloseTextDocument: () => new activationTestState.DisposableClass(),
    onDidChangeConfiguration: () => new activationTestState.DisposableClass(),
    onDidGrantWorkspaceTrust: (listener: () => void) => {
      activationTestState.workspaceTrustGrantedListeners.push(listener);
      return new activationTestState.DisposableClass();
    },
    registerTextDocumentContentProvider: (scheme: string) => {
      activationTestState.contentProviderSchemes.push(scheme);
      return new activationTestState.DisposableClass();
    },
    registerFileSystemProvider: (
      scheme: string,
      provider: unknown,
      options: {
        readonly isCaseSensitive?: boolean;
        readonly isReadonly?: boolean;
      },
    ) => {
      const registration = {
        scheme,
        provider,
        options,
        disposed: false,
      };
      activationTestState.workingContentProviderRegistrations.push(
        registration,
      );
      return new activationTestState.DisposableClass(() => {
        registration.disposed = true;
      });
    },
    getConfiguration: () => ({
      get: <ConfigurationValue>(
        _configurationKey: string,
        defaultValue: ConfigurationValue,
      ): ConfigurationValue => defaultValue,
      update: () => Promise.resolve(),
    }),
  },
  languages: {
    registerHoverProvider: () => new activationTestState.DisposableClass(),
    registerCodeLensProvider: () => new activationTestState.DisposableClass(),
  },
}));

const localGitCommandIdentifiers = [
  "gito.stageChanges",
  "gito.unstageChanges",
  "gito.stageAll",
  "gito.unstageAll",
  "gito.openDiff",
  "gito.discardChanges",
  "gito.commit",
  "gito.fetch",
  "gito.pull",
  "gito.push",
  "gito.sync",
  "gito.copyCommitSha",
  "gito.copyCommitMessage",
  "gito.checkoutBranch",
  "gito.createBranch",
  "gito.publishBranch",
  "gito.deleteBranch",
  "gito.forceDeleteBranch",
  "gito.openCommitFileDiff",
  "gito.createWorktree",
  "gito.removeWorktree",
  "gito.openWorktree",
];

vi.mock("../../../src/extension/git/gitExtensionHost.js", () => ({
  LocalGitExtensionHost: class MockLocalGitExtensionHost {
    public readonly repositoryDiscovery = {
      listRepositories: (): Promise<readonly unknown[]> => {
        if (!activationTestState.bundledGitAvailable) {
          return Promise.reject(new Error("bundled Git unavailable"));
        }
        return Promise.resolve(activationTestState.configuredRepositories);
      },
      watchRepositoryChanges: (
        onRepositoryOpened: () => void,
        onRepositoryClosed: () => void,
      ): DisposableLike => {
        const isPrimaryWatcher =
          activationTestState.repositoryOpened === undefined;
        if (isPrimaryWatcher) {
          activationTestState.repositoryOpened = onRepositoryOpened;
          activationTestState.repositoryClosed = onRepositoryClosed;
        }
        return new activationTestState.DisposableClass(() => {
          if (isPrimaryWatcher)
            activationTestState.repositoryWatcherDisposed += 1;
        });
      },
      watchRepositoryStateChanges: (
        onRepositoryStateChanged: (repository: unknown) => void,
      ): DisposableLike => {
        activationTestState.repositoryStateChangedListeners.push(
          onRepositoryStateChanged,
        );
        return new activationTestState.DisposableClass();
      },
      selectRepository: (): Promise<{
        rootUri: { fsPath: string; toString: () => string };
      }> => {
        const configuredRepository = activationTestState
          .configuredRepositories[0] as
          | {
              root?: string;
              rootUri?: { fsPath: string; toString: () => string };
            }
          | undefined;
        if (configuredRepository === undefined)
          throw new Error("No repository");
        if (configuredRepository.rootUri !== undefined)
          return Promise.resolve(
            configuredRepository as {
              rootUri: { fsPath: string; toString: () => string };
            },
          );
        const rootPath = configuredRepository.root ?? "/existing";
        return Promise.resolve({
          rootUri: { fsPath: rootPath, toString: () => rootPath },
        });
      },
    };

    public readonly gitCommandRunner = {
      run: () =>
        Promise.resolve({ standardOutput: "", standardError: "", exitCode: 0 }),
    };
    public readonly gitRootBindingResolver =
      activationTestState.sharedGitRootBindingResolver;
    public readonly repositoryService = {
      getRepositoryHealth: () =>
        Promise.resolve({
          branchName: "main",
          aheadCount: 0,
          behindCount: 0,
          uncommittedChangeCount: 0,
        }),
    };
    public readonly historyService = {};
    public readonly worktreeService = {};

    public registerCommands(): readonly DisposableLike[] {
      return localGitCommandIdentifiers.map((commandIdentifier) =>
        registerCommand(commandIdentifier, () => undefined),
      );
    }

    public dispose(): void {}
  },
}));

vi.mock("../../../src/extension/providers/github/githubProvider.js", () => ({
  GitHubProvider: class MockGitHubProvider {
    public readonly providerId = "github" as const;
  },
}));

vi.mock("../../../src/extension/diff/gitDiffService.js", () => ({
  createDiffSymlinkUriProvider: () => {
    const workingContentProvider = {
      beginSession: () => undefined,
      empty: () => ({}),
      symlink: () => ({}),
      dispose: () => undefined,
    };
    activationTestState.workingContentProvider = workingContentProvider;
    return workingContentProvider;
  },
  GitDiffService: class MockGitDiffService {
    public constructor(
      _gitCommandRunner: unknown,
      _uriFactory: unknown,
      rootBindingResolver: object,
    ) {
      activationTestState.gitDiffRootBindingResolver = rootBindingResolver;
    }
  },
}));

vi.mock("../../../src/extension/compare/index.js", () => ({
  CompareService: class MockCompareService {
    public constructor(
      _gitCommandRunner: unknown,
      _uriFactory: unknown,
      rootBindingResolver: object,
    ) {
      activationTestState.compareRootBindingResolver = rootBindingResolver;
      activationTestState.compareServiceInstance = this;
    }

    public assertPinnedRepositoryRoot(): Promise<string> {
      return Promise.resolve("/existing");
    }
  },
  GitSearchService: class MockGitSearchService {
    public constructor(compareService: object) {
      activationTestState.searchCompareService = compareService;
    }
  },
  parseSearchQuery: () => ({ clauses: [] }),
}));

vi.mock("../../../src/extension/dashboard/dashboardOrchestrator.js", () => ({
  DashboardOrchestrator: class MockDashboardOrchestrator {
    public constructor(dependencies: unknown) {
      const dashboardDependencies = dependencies as {
        providers?: readonly { providerId?: string }[];
      };
      activationTestState.dashboardProviderIds =
        dashboardDependencies.providers?.flatMap(({ providerId }) =>
          providerId === undefined ? [] : [providerId],
        ) ?? [];
    }

    public getSnapshot(): Record<string, unknown> {
      return {
        requestGeneration: 0,
        selectedRepository: activationTestState.dashboardHasSelectedRepository
          ? {
              cloudDashboards: Object.entries(
                activationTestState.dashboardProviderConnectionStates,
              ).map(([providerId, connectionState]) => ({
                providerId,
                connectionState,
                ...(activationTestState.dashboardProviderCacheStatuses[
                  providerId as "github"
                ] === undefined
                  ? {}
                  : {
                      cacheStatus:
                        activationTestState.dashboardProviderCacheStatuses[
                          providerId as "github"
                        ],
                    }),
              })),
            }
          : null,
      };
    }

    public shouldRefreshProviderDashboard(providerId: string): boolean {
      return (
        activationTestState.dashboardProviderCacheStatuses[
          providerId as "github"
        ] === "stale" ||
        activationTestState.dashboardProviderCacheExpired[
          providerId as "github"
        ] === true
      );
    }

    public subscribe(): DisposableLike {
      return new activationTestState.DisposableClass();
    }

    public load(): Promise<void> {
      activationTestState.dashboardLoaded += 1;
      return Promise.resolve();
    }

    public refresh(options?: unknown): Promise<void> {
      activationTestState.dashboardRefreshOptions.push(options);
      return Promise.resolve();
    }

    public refreshProvider(providerId: string): Promise<void> {
      activationTestState.dashboardProviderRefreshes.push(providerId);
      return Promise.resolve();
    }

    public selectRepository(): Promise<void> {
      return Promise.resolve();
    }

    public setProviderFilter(): void {}

    public connectProvider(): Promise<void> {
      return Promise.resolve();
    }

    public disconnectProvider(): void {}

    public onDidChangeProviderConnectionState(): DisposableLike {
      return new activationTestState.DisposableClass();
    }

    public cancelPendingRequests(): void {}

    public getPullRequestDetails(): Promise<never> {
      return Promise.reject(new Error("not used"));
    }

    public checkoutPullRequest(): Promise<void> {
      return Promise.resolve();
    }

    public openExternalPullRequest(): Promise<void> {
      return Promise.resolve();
    }

    public dispose(): void {
      activationTestState.dashboardDisposed += 1;
    }
  },
}));

vi.mock("../../../src/extension/webviews/repositoryHomePanel.js", () => ({
  RepositoryHomePanel: class MockRepositoryHomePanel {
    public constructor(
      _extensionUri: unknown,
      private readonly controller: { load: () => Promise<void> },
    ) {}

    public revealOrCreate(): void {
      activationTestState.panelRevealedAndLoaded += 1;
    }

    public revealAndWaitForLoad(): Promise<void> {
      activationTestState.panelRevealedAndLoaded += 1;
      return this.controller.load();
    }

    public refresh(): Promise<void> {
      return Promise.resolve();
    }

    public dispose(): void {
      activationTestState.panelDisposed += 1;
    }
  },
}));

vi.mock("../../../src/extension/surfaces/gitoSurfaceHost.js", () => ({
  GitoSurfaceHost: class MockGitoSurfaceHost {
    public constructor(services: unknown) {
      void services;
    }

    public registerCommands(): readonly DisposableLike[] {
      return [
        "gito.openChanges",
        "gito.openPullRequests",
        "gito.openCommits",
        "gito.openBranches",
        "gito.openWorktrees",
      ].map((commandIdentifier) =>
        registerCommand(commandIdentifier, () => undefined),
      );
    }
  },
}));

vi.mock(
  "../../../src/extension/repositories/gitoNavigationProvider.js",
  () => ({
    GitoNavigationProvider: class MockGitoNavigationProvider {
      public dispose(): void {
        activationTestState.navigationDisposed += 1;
      }
    },
  }),
);

import { activateGitoExtension } from "../../../src/extension/activateGitoExtension.js";

const onboardingCommandIdentifiers = [
  "gito.onboarding.openOrChooseRepository",
  "gito.onboarding.openHome",
  "gito.onboarding.showSourceControlSteps",
  "gito.onboarding.confirmSourceControlHidden",
  "gito.onboarding.acknowledgeSourceControlVisible",
  "gito.onboarding.connectGitHub",
  "gito.onboarding.skipGitHub",
  "gito.onboarding.openSetup",
];

const allActivationCommandIdentifiers = [
  ...localGitCommandIdentifiers,
  "gito.openChanges",
  "gito.openPullRequests",
  "gito.openCommits",
  "gito.openBranches",
  "gito.openWorktrees",
  "gito.openHome",
  "gito.refreshDashboard",
  ...onboardingCommandIdentifiers,
  "gito.diff.open",
  "gito.diff.openSingleFile",
  "gito.diff.openRepository",
  "gito.diff.review",
  "gito.diff.whitespace",
  "gito.diff.nextFile",
  "gito.diff.previousFile",
  "gito.diff.nextChange",
  "gito.diff.previousChange",
  "gito.diff.swapSides",
  "gito.diff.reopen",
  "gito.diff.changeOptions",
  "gito.compare.open",
  "gito.compare.search",
  "gito.compare.actions",
  "gito.compare.recent",
  "gito.openConflicts",
  "gito.openOperations",
  "gito.history.toggleBlame",
  "gito.history.openFileHistory",
  "gito.history.openLineHistory",
  "gito.history.openContributors",
  "gito.history.search",
  "gito.history.previousRevision",
  "gito.history.nextRevision",
  "gito.history.openCommit",
  "gito.graph.open",
  "gito.developerDiagnostics.open",
  "gito.developerDiagnostics.toggle",
];

function createExtensionContext(): {
  extensionUri: { fsPath: string };
  subscriptions: DisposableLike[];
  globalState: {
    get<Value>(storageKey: string, defaultValue?: Value): Value | undefined;
    update(storageKey: string, storedValue: unknown): Promise<void>;
  };
  workspaceState: {
    get<Value>(storageKey: string, defaultValue?: Value): Value | undefined;
    update(storageKey: string, storedValue: unknown): Promise<void>;
    keys(): readonly string[];
  };
} {
  return {
    extensionUri: { fsPath: "/test-extension" },
    subscriptions: [],
    globalState: {
      get: <Value>(storageKey: string, defaultValue?: Value) =>
        (activationTestState.globalStateValues.get(storageKey) as
          Value | undefined) ?? defaultValue,
      update: (storageKey, storedValue) => {
        activationTestState.globalStateValues.set(storageKey, storedValue);
        return Promise.resolve();
      },
    },
    workspaceState: {
      get: <Value>(storageKey: string, defaultValue?: Value) =>
        (activationTestState.workspaceStateValues.get(storageKey) as
          Value | undefined) ?? defaultValue,
      update: (storageKey, storedValue) => {
        if (storedValue === undefined)
          activationTestState.workspaceStateValues.delete(storageKey);
        else
          activationTestState.workspaceStateValues.set(storageKey, storedValue);
        return Promise.resolve();
      },
      keys: () => [...activationTestState.workspaceStateValues.keys()],
    },
  };
}

async function settleActivationPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("extension activation composition", () => {
  beforeEach(() => {
    activationTestState.commandIdentifiers.length = 0;
    activationTestState.commandHandlers.clear();
    activationTestState.nativeCommandCalls.length = 0;
    activationTestState.globalStateValues.clear();
    activationTestState.workspaceStateValues.clear();
    activationTestState.configuredRepositories = [];
    activationTestState.bundledGitAvailable = true;
    activationTestState.workspaceTrusted = true;
    activationTestState.workspaceTrustGrantedListeners.length = 0;
    activationTestState.authenticationSessionChangedListeners.length = 0;
    activationTestState.windowStateChangedListeners.length = 0;
    activationTestState.repositoryOpened = undefined;
    activationTestState.repositoryClosed = undefined;
    activationTestState.repositoryStateChangedListeners.length = 0;
    activationTestState.extensionChanged = undefined;
    activationTestState.repositoryWatcherDisposed = 0;
    activationTestState.textEditorSelectionWatcherDisposed = 0;
    activationTestState.panelRevealedAndLoaded = 0;
    activationTestState.dashboardLoaded = 0;
    activationTestState.dashboardProviderIds.length = 0;
    activationTestState.dashboardRefreshOptions.length = 0;
    activationTestState.dashboardProviderRefreshes.length = 0;
    activationTestState.panelDisposed = 0;
    activationTestState.dashboardDisposed = 0;
    activationTestState.dashboardHasSelectedRepository = false;
    activationTestState.dashboardProviderConnectionStates = {
      github: "disconnected",
    };
    activationTestState.dashboardProviderCacheStatuses = {
      github: undefined,
    };
    activationTestState.dashboardProviderCacheExpired = { github: false };
    activationTestState.sharedGitRootBindingResolver = {};
    activationTestState.gitDiffRootBindingResolver = undefined;
    activationTestState.compareRootBindingResolver = undefined;
    activationTestState.compareServiceInstance = undefined;
    activationTestState.searchCompareService = undefined;
    activationTestState.navigationDisposed = 0;
    activationTestState.contentProviderSchemes.length = 0;
    activationTestState.workingContentProvider = undefined;
    activationTestState.workingContentProviderRegistrations.length = 0;
  });

  it("registers each activation command exactly once and disposes the graph", () => {
    const extensionContext = createExtensionContext();

    activateGitoExtension(extensionContext as never);

    expect(activationTestState.commandIdentifiers).toHaveLength(
      allActivationCommandIdentifiers.length,
    );
    expect(new Set(activationTestState.commandIdentifiers).size).toBe(
      allActivationCommandIdentifiers.length,
    );
    expect(activationTestState.commandIdentifiers).toEqual(
      expect.arrayContaining(allActivationCommandIdentifiers),
    );
    expect(activationTestState.gitDiffRootBindingResolver).toBe(
      activationTestState.sharedGitRootBindingResolver,
    );
    expect(activationTestState.compareRootBindingResolver).toBe(
      activationTestState.sharedGitRootBindingResolver,
    );
    expect(activationTestState.searchCompareService).toBe(
      activationTestState.compareServiceInstance,
    );
    expect(activationTestState.dashboardProviderIds).toEqual(["github"]);
    expect(
      activationTestState.workingContentProviderRegistrations.map(
        ({ scheme, options, disposed }) => ({ scheme, options, disposed }),
      ),
    ).toEqual([
      {
        scheme: "gito-empty",
        options: { isCaseSensitive: true, isReadonly: true },
        disposed: false,
      },
      {
        scheme: "gito-symlink",
        options: { isCaseSensitive: true, isReadonly: true },
        disposed: false,
      },
    ]);
    const contributedCommandIdentifiers = (
      JSON.parse(readFileSync("package.json", "utf8")) as {
        contributes: { commands: readonly { command: string }[] };
      }
    ).contributes.commands.map(({ command }) => command);
    expect(contributedCommandIdentifiers).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/azure|devops|microsoft/i),
      ]),
    );
    expect(activationTestState.commandIdentifiers).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/azure|devops|microsoft/i),
      ]),
    );
    for (const commandIdentifier of contributedCommandIdentifiers) {
      expect(
        activationTestState.commandIdentifiers.filter(
          (registeredCommandIdentifier) =>
            registeredCommandIdentifier === commandIdentifier,
        ),
      ).toHaveLength(1);
      expect(activationTestState.commandHandlers.has(commandIdentifier)).toBe(
        true,
      );
    }

    for (const disposable of extensionContext.subscriptions)
      disposable.dispose();
    expect(
      activationTestState.authenticationSessionChangedListeners,
    ).toHaveLength(0);
    expect(activationTestState.windowStateChangedListeners).toHaveLength(0);
    expect(activationTestState.repositoryWatcherDisposed).toBe(1);
    expect(activationTestState.textEditorSelectionWatcherDisposed).toBe(1);
    expect(activationTestState.panelDisposed).toBe(1);
    expect(activationTestState.dashboardDisposed).toBe(1);
    expect(activationTestState.navigationDisposed).toBe(1);
    expect(activationTestState.contentProviderSchemes).toEqual([
      "gito-conflict-preview",
    ]);
    expect(
      activationTestState.workingContentProviderRegistrations.every(
        ({ disposed }) => disposed,
      ),
    ).toBe(true);
  });

  it("publishes trust context and keeps onboarding available in Restricted Mode", () => {
    activationTestState.workspaceTrusted = false;
    activateGitoExtension(createExtensionContext() as never);

    expect(activationTestState.nativeCommandCalls).toContainEqual([
      "setContext",
      "gito.workspaceTrusted",
      false,
    ]);
    expect(
      activationTestState.commandHandlers.has("gito.onboarding.openSetup"),
    ).toBe(true);

    activationTestState.workspaceTrusted = true;
    for (const trustGrantedListener of activationTestState.workspaceTrustGrantedListeners)
      trustGrantedListener();
    expect(activationTestState.nativeCommandCalls).toContainEqual([
      "setContext",
      "gito.workspaceTrusted",
      true,
    ]);
  });

  it("syncs existing, opened, and closed repository context", async () => {
    activationTestState.configuredRepositories = [{ root: "/existing" }];
    activateGitoExtension(createExtensionContext() as never);
    await settleActivationPromises();

    const localContextCalls = () =>
      activationTestState.nativeCommandCalls.filter(
        ([commandIdentifier]) => commandIdentifier === "setContext",
      );
    expect(localContextCalls().at(-1)).toEqual([
      "setContext",
      "gito.onboarding.localRepositoryAvailable",
      true,
    ]);

    activationTestState.repositoryOpened?.();
    await settleActivationPromises();
    expect(localContextCalls().at(-1)?.at(-1)).toBe(true);

    activationTestState.extensionChanged?.();
    await settleActivationPromises();
    expect(localContextCalls().at(-1)?.at(-1)).toBe(true);

    activationTestState.configuredRepositories = [];
    activationTestState.repositoryClosed?.();
    await settleActivationPromises();
    expect(localContextCalls()).toContainEqual([
      "setContext",
      "gito.onboarding.repositoryHomeOpened",
      false,
    ]);
    expect(localContextCalls().at(-1)).toEqual([
      "setContext",
      "gito.onboarding.localRepositoryAvailable",
      false,
    ]);
  });

  it("reuses current Git state when a repository state event refreshes the dashboard", async () => {
    activateGitoExtension(createExtensionContext() as never);

    const changedRepository = {
      rootUri: {
        scheme: "file",
        fsPath: "/workspace/repository",
        toString: () => "file:///workspace/repository",
      },
    };
    for (const repositoryStateChangedListener of activationTestState.repositoryStateChangedListeners)
      repositoryStateChangedListener(changedRepository);
    await settleActivationPromises();

    expect(activationTestState.dashboardRefreshOptions.at(-1)).toEqual({
      refreshStatus: false,
    });
  });

  it("silently refreshes connected providers after authentication session changes", async () => {
    activationTestState.dashboardHasSelectedRepository = true;
    activationTestState.dashboardProviderConnectionStates.github = "connected";
    activateGitoExtension(createExtensionContext() as never);

    for (const authenticationSessionChangedListener of activationTestState.authenticationSessionChangedListeners) {
      authenticationSessionChangedListener({
        provider: { id: "github" },
        added: [],
        removed: [{ id: "removed-session" }],
        changed: [],
      });
      authenticationSessionChangedListener({
        provider: { id: "github" },
        added: [],
        removed: [],
        changed: [{ id: "changed-session" }],
      });
      authenticationSessionChangedListener({
        provider: { id: "unknown" },
        added: [],
        removed: [],
        changed: [],
      });
    }
    await settleActivationPromises();

    expect(activationTestState.dashboardProviderRefreshes).toEqual(["github"]);
  });

  it("refreshes only connected stale providers when the window regains focus", async () => {
    activationTestState.dashboardHasSelectedRepository = true;
    activationTestState.dashboardProviderConnectionStates.github = "connected";
    activationTestState.dashboardProviderCacheStatuses.github = "stale";
    activateGitoExtension(createExtensionContext() as never);

    for (const windowStateChangedListener of activationTestState.windowStateChangedListeners) {
      windowStateChangedListener({ focused: false });
      windowStateChangedListener({ focused: true });
      windowStateChangedListener({ focused: true });
    }
    await settleActivationPromises();

    expect(activationTestState.dashboardProviderRefreshes).toEqual(["github"]);
  });

  it("refreshes connected providers whose provider cache has expired", async () => {
    activationTestState.dashboardHasSelectedRepository = true;
    activationTestState.dashboardProviderConnectionStates.github = "connected";
    activationTestState.dashboardProviderCacheStatuses.github = "fresh";
    activationTestState.dashboardProviderCacheExpired.github = true;
    activateGitoExtension(createExtensionContext() as never);

    for (const windowStateChangedListener of activationTestState.windowStateChangedListeners)
      windowStateChangedListener({ focused: true });
    await settleActivationPromises();

    expect(activationTestState.dashboardProviderRefreshes).toEqual(["github"]);
  });

  it("awaits a successful Home load from onboarding", async () => {
    activationTestState.configuredRepositories = [{ root: "/existing" }];
    activateGitoExtension(createExtensionContext() as never);
    const openHomeHandler = activationTestState.commandHandlers.get(
      "gito.onboarding.openHome",
    );
    expect(openHomeHandler).toBeDefined();

    await openHomeHandler?.();

    expect(activationTestState.panelRevealedAndLoaded).toBe(1);
    expect(activationTestState.dashboardLoaded).toBe(1);
  });

  it("completes provider setup only from a connected dashboard snapshot", async () => {
    activationTestState.dashboardHasSelectedRepository = true;
    activationTestState.dashboardProviderConnectionStates.github = "connected";
    activateGitoExtension(createExtensionContext() as never);
    const connectGitHubHandler = activationTestState.commandHandlers.get(
      "gito.onboarding.connectGitHub",
    );

    await connectGitHubHandler?.();

    expect(activationTestState.nativeCommandCalls).toContainEqual([
      "setContext",
      "gito.onboarding.githubConnected",
      true,
    ]);
  });

  it("does not complete provider setup with no repository or an unmatched remote", async () => {
    activateGitoExtension(createExtensionContext() as never);
    const connectGitHubHandler = activationTestState.commandHandlers.get(
      "gito.onboarding.connectGitHub",
    );

    await connectGitHubHandler?.();
    activationTestState.dashboardHasSelectedRepository = true;
    await connectGitHubHandler?.();

    expect(
      activationTestState.nativeCommandCalls.filter(
        ([commandIdentifier, contextKey]) =>
          commandIdentifier === "setContext" &&
          contextKey === "gito.onboarding.githubConnected",
      ),
    ).toEqual([
      ["setContext", "gito.onboarding.githubConnected", false],
      ["setContext", "gito.onboarding.githubConnected", false],
    ]);
  });

  it("opens the native setup walkthrough once without provider activity", async () => {
    const extensionContext = createExtensionContext();
    activateGitoExtension(extensionContext as never);
    await settleActivationPromises();

    expect(activationTestState.nativeCommandCalls).toContainEqual([
      "workbench.action.openWalkthrough",
      "overengineered-org.gito#setup",
    ]);
    expect(activationTestState.globalStateValues).toEqual(
      new Map([["gito.onboarding.firstInstallWalkthroughOpened", true]]),
    );
  });

  it("fails closed when bundled Git is unavailable", async () => {
    activationTestState.bundledGitAvailable = false;
    activateGitoExtension(createExtensionContext() as never);
    await settleActivationPromises();

    expect(activationTestState.nativeCommandCalls).toContainEqual([
      "setContext",
      "gito.onboarding.localRepositoryAvailable",
      false,
    ]);
  });
});
