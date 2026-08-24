// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Disposable {
    public constructor(
      private readonly disposeCallback: () => void = () => undefined,
    ) {}
    public dispose(): void {
      this.disposeCallback();
    }
  }
  class CancellationTokenSource {
    private readonly cancellationState = { cancellationRequested: false };
    private cancellationListener: (() => void) | undefined;
    public readonly token: {
      readonly isCancellationRequested: boolean;
      readonly onCancellationRequested: (listener: () => void) => Disposable;
    };
    public constructor() {
      const cancellationState = this.cancellationState;
      this.token = {
        get isCancellationRequested(): boolean {
          return Boolean(cancellationState.cancellationRequested);
        },
        onCancellationRequested: (listener: () => void): Disposable => {
          this.cancellationListener = listener;
          return new Disposable(() => {
            this.cancellationListener = undefined;
          });
        },
      };
    }
    public cancel(): void {
      this.cancellationState.cancellationRequested = true;
      this.cancellationListener?.();
    }
    public dispose(): void {
      this.cancellationListener = undefined;
    }
  }
  class Uri {
    public readonly scheme = "file";
    public constructor(public readonly fsPath: string) {}
    public static file(filePath: string): Uri {
      return new Uri(filePath);
    }
    public toString(): string {
      return `file://${this.fsPath}`;
    }
  }
  return {
    CancellationTokenSource,
    Disposable,
    Uri,
    env: { openExternal: vi.fn(() => Promise.resolve(true)) },
  };
});

import type {
  CloudGitProvider,
  CloudRepositoryIdentity,
  ProviderConnection,
} from "../../../src/domain/cloudGitProvider.js";
import type { PullRequestDetails } from "../../../src/domain/pullRequest.js";
import type { RepositoryDashboardSnapshot } from "../../../src/domain/repositoryDashboard.js";
import { DashboardOrchestrator } from "../../../src/extension/dashboard/dashboardOrchestrator.js";
import { DashboardOrchestrationError } from "../../../src/extension/dashboard/types.js";
import { GitHubProviderError } from "../../../src/extension/providers/github/githubTypes.js";

interface FakeRepository {
  readonly rootUri: { readonly fsPath: string };
}

function createRepository(root: string): FakeRepository {
  return { rootUri: { fsPath: root } };
}

function createDashboardSnapshot(
  repositoryRoot: string,
  fetchedAt = "2026-08-23T00:00:00.000Z",
): RepositoryDashboardSnapshot {
  return {
    repositoryRoot:
      repositoryRoot === "/cloud"
        ? "https://github.com/octocat/Hello-World"
        : repositoryRoot,
    providerId: "github",
    pullRequests: [],
    fetchedAt,
  };
}

function createProvider(
  dashboard: (signal: AbortSignal) => Promise<RepositoryDashboardSnapshot>,
): CloudGitProvider {
  const identity: CloudRepositoryIdentity = {
    providerId: "github",
    owner: "octocat",
    repositoryName: "Hello-World",
  };
  const connect = async () => ({
    providerId: "github" as const,
    sessionId: "session-1",
    accessToken: "opaque-token",
  });
  return {
    providerId: "github",
    detectRepository: (remoteUrls) =>
      remoteUrls.length === 0 ? undefined : identity,
    connect,
    connectSilently: connect,
    disconnect: vi.fn(),
    getCurrentUser: async () => ({
      providerId: "github",
      userId: "octocat",
      displayName: "Octocat",
    }),
    getRepositoryDashboard: (_identity, _connection, signal) =>
      dashboard(signal),
    getPullRequestDetails: async () => {
      throw new Error("not used");
    },
    getCanonicalUrl: () =>
      ({ toString: () => "https://github.com/octocat/Hello-World" }) as never,
  };
}

function createDependencies(
  repository: FakeRepository,
  provider: CloudGitProvider,
  overrides: {
    readonly health?: () => Promise<unknown>;
    readonly activity?: () => Promise<unknown>;
    readonly remotes?: readonly string[];
    readonly workspaceTrustGuard?: {
      runTrustedMutation: <Result>(
        operationName: string,
        mutation: () => Promise<Result> | Result,
      ) => Promise<Result>;
    };
  } = {},
) {
  const repositoryDiscovery = {
    listRepositories: vi.fn(async () => [repository]),
    selectRepository: vi.fn(async () => repository),
  };
  const repositoryService = {
    getRepositoryHealth: vi.fn(
      overrides.health ??
        (async () => ({
          branchName: "main",
          uncommittedChangeCount: 1,
          aheadCount: 0,
          behindCount: 0,
        })),
    ),
    checkoutBranch: vi.fn(async () => undefined),
  };
  const historyService = {
    getRemoteUrls: vi.fn(
      () => overrides.remotes ?? ["https://github.com/octocat/Hello-World.git"],
    ),
    getCommitActivity: vi.fn(
      overrides.activity ??
        (async () => ({
          days: new Map([["2026-08-23", 2]]),
          matchingCommitCount: 2,
          reachedSafetyCap: false,
          outputTruncated: false,
        })),
    ),
  };
  return {
    repositoryDiscovery: repositoryDiscovery as never,
    repositoryService: repositoryService as never,
    historyService: historyService as never,
    providers: [provider],
    workspaceTrustGuard: overrides.workspaceTrustGuard ?? {
      runTrustedMutation: async <Result>(
        _operationName: string,
        mutation: () => Promise<Result> | Result,
      ): Promise<Result> => mutation(),
    },
  };
}

describe("DashboardOrchestrator lifecycle", () => {
  it("skips Git status for state refresh and keeps manual refresh fresh", async () => {
    const repository = createRepository("/workspace/repository");
    const health = vi.fn(async () => ({
      branchName: "main",
      uncommittedChangeCount: 0,
      aheadCount: 0,
      behindCount: 0,
    }));
    const dependencies = createDependencies(
      repository,
      createProvider(async () => createDashboardSnapshot("/cloud")),
      { health },
    );
    const orchestrator = new DashboardOrchestrator(dependencies);

    await orchestrator.load();
    await orchestrator.refresh({ refreshStatus: false });
    expect(health).toHaveBeenLastCalledWith(
      { selectedRepositoryRoot: repository.rootUri },
      { refreshStatus: false },
    );

    await orchestrator.refresh();
    expect(health).toHaveBeenLastCalledWith(
      { selectedRepositoryRoot: repository.rootUri },
      { refreshStatus: true },
    );
  });

  it("publishes a local-first selected snapshot before section work completes", async () => {
    let resolveHealth: ((health: unknown) => void) | undefined;
    const healthPromise = new Promise((resolve) => {
      resolveHealth = resolve;
    });
    const repository = createRepository("/workspace/repository");
    const orchestrator = new DashboardOrchestrator(
      createDependencies(
        repository,
        createProvider(async () => createDashboardSnapshot("/cloud")),
        {
          health: () => healthPromise,
        },
      ),
    );
    const receivedSnapshots: ReturnType<
      DashboardOrchestrator["getSnapshot"]
    >[] = [];
    orchestrator.subscribe((snapshot) => receivedSnapshots.push(snapshot));
    const loadPromise = orchestrator.load();
    await vi.waitFor(() =>
      expect(receivedSnapshots.at(-1)?.selectedRepository?.repositoryRoot).toBe(
        "/workspace/repository",
      ),
    );
    expect(receivedSnapshots.at(-1)?.loadingSections).toContain("localSummary");
    expect(
      receivedSnapshots.at(-1)?.selectedRepository?.cloudDashboards,
    ).toHaveLength(1);
    resolveHealth?.({
      branchName: "main",
      uncommittedChangeCount: 0,
      aheadCount: 0,
      behindCount: 0,
    });
    await loadPromise;
    expect(
      orchestrator.getSnapshot().selectedRepository?.repositoryHealth
        .branchName,
    ).toBe("main");
  });

  it("keeps provider credentials out of snapshots and loads a detected connection", async () => {
    const repository = createRepository("/workspace/repository");
    const orchestrator = new DashboardOrchestrator(
      createDependencies(
        repository,
        createProvider(async () => createDashboardSnapshot("/cloud")),
      ),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const serializedSnapshot = JSON.stringify(orchestrator.getSnapshot());
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      providerId: "github",
      connectionState: "connected",
      accountDisplayName: "Octocat",
    });
    expect(serializedSnapshot).not.toContain("opaque-token");
  });

  it("refreshes a connected provider through silent authentication only", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud", "2026-08-23T00:00:01.000Z"),
    );
    const interactiveConnect = vi.spyOn(provider, "connect");
    const silentConnect = vi.spyOn(provider, "connectSilently");
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );

    await orchestrator.load();
    await orchestrator.connectProvider("github");
    interactiveConnect.mockClear();
    silentConnect.mockClear();

    await orchestrator.refreshProvider("github");

    expect(interactiveConnect).not.toHaveBeenCalled();
    expect(silentConnect).toHaveBeenCalledOnce();
  });

  it("delegates provider-owned cache expiry only for connected dashboards", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const cacheExpiryPredicate = vi.fn(() => true);
    provider.isRepositoryDashboardCacheExpired = cacheExpiryPredicate;
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );

    expect(orchestrator.shouldRefreshProviderDashboard("github")).toBe(false);
    await orchestrator.load();
    expect(orchestrator.shouldRefreshProviderDashboard("github")).toBe(false);
    await orchestrator.connectProvider("github");

    expect(orchestrator.shouldRefreshProviderDashboard("github")).toBe(true);
    expect(cacheExpiryPredicate).toHaveBeenCalledWith(
      { providerId: "github", owner: "octocat", repositoryName: "Hello-World" },
      "session-1",
    );
  });

  it("cancels pull-request details when provider refresh replaces summaries", async () => {
    const repository = createRepository("/workspace/repository");
    let currentPullRequests: RepositoryDashboardSnapshot["pullRequests"] = [
      createPullRequestDetails(42),
    ];
    const provider = createProvider(async () => ({
      ...createDashboardSnapshot("/cloud"),
      pullRequests: currentPullRequests,
    }));
    let detailsStarted: (() => void) | undefined;
    const detailsStartedPromise = new Promise<void>((resolve) => {
      detailsStarted = resolve;
    });
    provider.getPullRequestDetails = (_identity, _connection, signal) =>
      new Promise((_resolve, reject) => {
        detailsStarted?.();
        signal.addEventListener(
          "abort",
          () => reject(new Error("request cancelled")),
          { once: true },
        );
      });
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    const detailsPromise = orchestrator.getPullRequestDetails({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    });
    await detailsStartedPromise;
    currentPullRequests = [];
    await orchestrator.refreshProvider("github");

    await expect(detailsPromise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects explicit provider connection without a selected repository", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const interactiveConnect = vi.fn(async () => ({
      providerId: "github" as const,
      sessionId: "session-1",
      accessToken: "opaque-token",
    }));
    provider.connect = interactiveConnect;
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await expect(orchestrator.connectProvider("github")).rejects.toMatchObject({
      code: "providerConnection",
      message: "Open a local repository before connecting GitHub.",
    });
    expect(interactiveConnect).not.toHaveBeenCalled();

    await orchestrator.load();
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.connectionState,
    ).toBe("disconnected");
  });

  it("rejects explicit provider connection without a matching remote", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const interactiveConnect = vi.fn(async () => ({
      providerId: "github" as const,
      sessionId: "session-1",
      accessToken: "opaque-token",
    }));
    provider.connect = interactiveConnect;
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider, { remotes: [] }),
    );
    await orchestrator.load();

    await expect(orchestrator.connectProvider("github")).rejects.toMatchObject({
      code: "providerConnection",
      message:
        "Open a repository with a matching GitHub remote before connecting GitHub.",
    });
    expect(interactiveConnect).not.toHaveBeenCalled();
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.connectionState,
    ).toBe("disconnected");
  });

  it("drops an older provider response after a newer refresh", async () => {
    const repository = createRepository("/workspace/repository");
    const dashboardResolutions: Array<
      (snapshot: RepositoryDashboardSnapshot) => void
    > = [];
    const dashboardSignals: AbortSignal[] = [];
    const provider = createProvider(
      (signal) =>
        new Promise((resolve) => {
          dashboardSignals.push(signal);
          dashboardResolutions.push(resolve);
        }),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    const connectPromise = orchestrator.connectProvider("github");
    await vi.waitFor(() => expect(dashboardResolutions).toHaveLength(1));
    const refreshPromise = orchestrator.refresh();
    await vi.waitFor(() => expect(dashboardResolutions).toHaveLength(2));
    expect(dashboardSignals[0]?.aborted).toBe(true);
    dashboardResolutions[1]?.(
      createDashboardSnapshot("/cloud", "2026-08-23T00:00:02.000Z"),
    );
    await refreshPromise;
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.fetchedAt,
    ).toBe("2026-08-23T00:00:02.000Z");
    dashboardResolutions[0]?.(
      createDashboardSnapshot("/cloud", "2026-08-23T00:00:01.000Z"),
    );
    await connectPromise;
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.fetchedAt,
    ).toBe("2026-08-23T00:00:02.000Z");
  });

  it("loads same-repository details with the exact identity and session", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    let interactiveConnectionCount = 0;
    let silentConnectionCount = 0;
    const originalConnect = provider.connect.bind(provider);
    provider.connect = async (cancellationToken) => {
      interactiveConnectionCount += 1;
      return originalConnect(cancellationToken);
    };
    provider.connectSilently = async (cancellationToken) => {
      silentConnectionCount += 1;
      return originalConnect(cancellationToken);
    };
    let observedRequest:
      | {
          readonly identity: Parameters<
            CloudGitProvider["getPullRequestDetails"]
          >[0];
          readonly connection: ProviderConnection;
        }
      | undefined;
    provider.getPullRequestDetails = async (
      pullRequestIdentity,
      connection,
    ): Promise<PullRequestDetails> => {
      observedRequest = { identity: pullRequestIdentity, connection };
      return {
        ...pullRequestIdentity,
        title: "Read-only detail",
        authorDisplayName: "Octocat",
        updatedAt: "2026-08-23T00:00:00.000Z",
        commentCount: 0,
        isAuthoredByCurrentUser: false,
        reviewRequestedFromCurrentUser: false,
        isDraft: false,
        state: "ready",
        completedReviewCount: 1,
        requiredReviewCount: 1,
        bodyText: "Details",
        sourceBranchName: "feature/details",
        targetBranchName: "main",
        canonicalUrl: "https://github.com/octocat/Hello-World/pull/42",
      };
    };
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    const requestedIdentity = {
      providerId: "github" as const,
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    };
    await expect(
      orchestrator.getPullRequestDetails(requestedIdentity),
    ).resolves.toMatchObject({
      ...requestedIdentity,
      canonicalUrl: "https://github.com/octocat/Hello-World/pull/42",
    });
    expect(observedRequest).toEqual({
      identity: requestedIdentity,
      connection: {
        providerId: "github",
        sessionId: "session-1",
        accessToken: "opaque-token",
      },
    });
    expect(interactiveConnectionCount).toBe(1);
    expect(silentConnectionCount).toBe(1);
  });

  it("surfaces provider connection failures as typed section errors", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.connect = async () => {
      throw new Error("Consent was denied.");
    };
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await expect(orchestrator.connectProvider("github")).rejects.toBeInstanceOf(
      DashboardOrchestrationError,
    );
    expect(orchestrator.getSnapshot().sectionErrors).toContainEqual({
      section: "github",
      userMessage: "Consent was denied.",
    });
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.connectionState,
    ).toBe("failed");
  });

  it("reacquires provider credentials per request and never authorizes a cross-repository PR", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    let connectionCount = 0;
    provider.connect = async () => {
      connectionCount += 1;
      return {
        providerId: "github",
        sessionId: `session-${connectionCount}`,
        accessToken: "opaque-token",
      };
    };
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    await expect(
      orchestrator.getPullRequestDetails({
        providerId: "github",
        repositoryOwner: "other-owner",
        repositoryName: "other-repository",
        pullRequestNumber: 1,
      }),
    ).rejects.toMatchObject({ code: "pullRequestRepositoryMismatch" });
    provider.connectSilently = (cancellationToken) =>
      provider.connect(cancellationToken);
    await orchestrator.refresh();
    expect(connectionCount).toBe(2);
  });

  it("disconnects the provider and clears visible account state", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const disconnectMock = (
      provider as unknown as { readonly disconnect: ReturnType<typeof vi.fn> }
    ).disconnect;
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    const providerConnectionTransitions: boolean[] = [];
    orchestrator.onDidChangeProviderConnectionState(({ isConnected }) => {
      providerConnectionTransitions.push(isConnected);
    });
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    orchestrator.disconnectProvider("github");
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.connectionState,
    ).toBe("disconnected");
    expect(providerConnectionTransitions).toEqual([true, false]);
  });

  it("reports a session loss as a disconnected provider", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    const providerConnectionTransitions: boolean[] = [];
    orchestrator.onDidChangeProviderConnectionState(({ isConnected }) => {
      providerConnectionTransitions.push(isConnected);
    });
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    provider.connectSilently = async () => {
      throw new GitHubProviderError("authentication", "Session expired.");
    };

    await orchestrator.refresh();

    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.connectionState,
    ).toBe("disconnected");
    expect(providerConnectionTransitions).toEqual([true, false]);
  });

  it("restores an existing connection when an interactive reconnect is cancelled", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    provider.connect = (cancellationToken) =>
      new Promise((_, reject) => {
        cancellationToken.onCancellationRequested(() =>
          reject(new Error("authentication cancelled")),
        );
      });

    const reconnectPromise = orchestrator.connectProvider("github");
    orchestrator.cancelPendingRequests();
    await expect(reconnectPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Octocat",
    });
  });

  it("restores stable state when overlapping connects are cancelled", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    let connectCallCount = 0;
    provider.connect = (cancellationToken) => {
      connectCallCount += 1;
      return new Promise((_, reject) => {
        cancellationToken.onCancellationRequested(() =>
          reject(new Error(`connect ${connectCallCount} cancelled`)),
        );
      });
    };
    const firstConnectPromise = orchestrator.connectProvider("github");
    await vi.waitFor(() => expect(connectCallCount).toBe(1));
    const secondConnectPromise = orchestrator.connectProvider("github");
    await vi.waitFor(() => expect(connectCallCount).toBe(2));

    orchestrator.cancelPendingRequests();
    await firstConnectPromise;
    await expect(secondConnectPromise).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Octocat",
    });
  });

  it("propagates dashboard initialization failures from explicit connect", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    provider.getRepositoryDashboard = async () => {
      throw new Error("dashboard initialization failed");
    };

    await expect(orchestrator.connectProvider("github")).rejects.toThrow(
      "dashboard initialization failed",
    );
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Octocat",
    });
  });

  it("does not let a late cancelled connect restore over a newer connect", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    const discardedConnections: ProviderConnection[] = [];
    provider.discardConnection = (connection) => {
      discardedConnections.push(connection);
    };
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    let resolveLateConnection:
      ((connection: ProviderConnection) => void) | undefined;
    provider.connect = () =>
      new Promise((resolve) => {
        resolveLateConnection = resolve;
      });
    const lateConnectPromise = orchestrator.connectProvider("github");
    orchestrator.cancelPendingRequests();

    provider.connect = async () => ({
      providerId: "github",
      sessionId: "session-new",
      accessToken: "new-account-token",
    });
    provider.getCurrentUser = async (connection) => ({
      providerId: "github",
      userId: connection.sessionId,
      displayName: "New Account",
    });
    await orchestrator.connectProvider("github");
    resolveLateConnection?.({
      providerId: "github",
      sessionId: "session-late",
      accessToken: "late-account-token",
    });
    await lateConnectPromise;

    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "New Account",
    });
    expect(discardedConnections).toEqual([
      {
        providerId: "github",
        sessionId: "session-late",
        accessToken: "late-account-token",
      },
    ]);
  });

  it("rebases connect restoration after a newer silent dashboard load", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    provider.connect = (cancellationToken) =>
      new Promise((_, reject) => {
        cancellationToken.onCancellationRequested(() =>
          reject(new Error("reconnect superseded")),
        );
      });
    const supersededConnectPromise = orchestrator.connectProvider("github");
    await vi.waitFor(() =>
      expect(
        orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
          ?.connectionState,
      ).toBe("connecting"),
    );

    provider.connectSilently = async () => ({
      providerId: "github",
      sessionId: "session-silent",
      accessToken: "silent-account-token",
    });
    provider.getCurrentUser = async () => ({
      providerId: "github",
      userId: "silent-user",
      displayName: "Silent Account",
    });
    await orchestrator.load();
    await supersededConnectPromise;
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Silent Account",
    });

    provider.connect = (cancellationToken) =>
      new Promise((_, reject) => {
        cancellationToken.onCancellationRequested(() =>
          reject(new Error("reconnect cancelled")),
        );
      });
    const cancelledReconnectPromise = orchestrator.connectProvider("github");
    orchestrator.cancelPendingRequests();
    await expect(cancelledReconnectPromise).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Silent Account",
    });
  });

  it("returns immutable snapshot copies", async () => {
    const repository = createRepository("/workspace/repository");
    const orchestrator = new DashboardOrchestrator(
      createDependencies(
        repository,
        createProvider(async () => createDashboardSnapshot("/cloud")),
      ),
    );
    await orchestrator.load();
    const snapshot = orchestrator.getSnapshot();
    (snapshot.repositories as Array<unknown>).push({ repositoryRoot: "leak" });
    const selectedRepository = snapshot.selectedRepository;
    if (selectedRepository) {
      (
        selectedRepository.cloudDashboards[0]!.pullRequests as Array<unknown>
      ).push({});
    }

    const currentSnapshot = orchestrator.getSnapshot();
    expect(currentSnapshot.repositories).toHaveLength(1);
    expect(
      currentSnapshot.selectedRepository?.cloudDashboards[0]?.pullRequests,
    ).toHaveLength(0);
  });

  it("rejects details when repository selection changes while the request is pending", async () => {
    const firstRepository = createRepository("/workspace/first");
    const secondRepository = createRepository("/workspace/second");
    let resolveDetails: ((details: unknown) => void) | undefined;
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = () =>
      new Promise((resolve) => {
        resolveDetails = resolve as unknown as (details: unknown) => void;
      });
    const dependencies = createDependencies(firstRepository, provider);
    const mutableRepositoryDiscovery =
      dependencies.repositoryDiscovery as unknown as {
        listRepositories: ReturnType<typeof vi.fn>;
        selectRepository: ReturnType<typeof vi.fn>;
      };
    mutableRepositoryDiscovery.listRepositories = vi.fn(async () => [
      firstRepository,
      secondRepository,
    ]);
    mutableRepositoryDiscovery.selectRepository = vi.fn(
      async (selection: {
        readonly selectedRepositoryRoot?: { readonly fsPath: string };
      }) =>
        selection.selectedRepositoryRoot?.fsPath ===
        secondRepository.rootUri.fsPath
          ? secondRepository
          : firstRepository,
    ) as never;
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const detailsPromise = orchestrator.getPullRequestDetails({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    });
    await vi.waitFor(() => expect(resolveDetails).toBeDefined());
    await orchestrator.selectRepository(secondRepository.rootUri.fsPath);
    resolveDetails?.({});

    await expect(detailsPromise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("does not checkout after a deferred detail request crosses repositories", async () => {
    const firstRepository = createRepository("/workspace/first");
    const secondRepository = createRepository("/workspace/second");
    let resolveDetails: ((details: PullRequestDetails) => void) | undefined;
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = () =>
      new Promise((resolve) => {
        resolveDetails = resolve;
      });
    const dependencies = createDependencies(firstRepository, provider);
    const checkoutBranchMock = (
      dependencies.repositoryService as unknown as {
        readonly checkoutBranch: ReturnType<typeof vi.fn>;
      }
    ).checkoutBranch;
    const mutableRepositoryDiscovery =
      dependencies.repositoryDiscovery as unknown as {
        listRepositories: ReturnType<typeof vi.fn>;
        selectRepository: ReturnType<typeof vi.fn>;
      };
    mutableRepositoryDiscovery.listRepositories = vi.fn(async () => [
      firstRepository,
      secondRepository,
    ]);
    mutableRepositoryDiscovery.selectRepository = vi.fn(
      async (selection: {
        readonly selectedRepositoryRoot?: { readonly fsPath: string };
      }) =>
        selection.selectedRepositoryRoot?.fsPath ===
        secondRepository.rootUri.fsPath
          ? secondRepository
          : firstRepository,
    ) as never;
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    const checkoutPromise = orchestrator.checkoutPullRequest({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    });
    await vi.waitFor(() => expect(resolveDetails).toBeDefined());
    await orchestrator.selectRepository(secondRepository.rootUri.fsPath);
    resolveDetails?.({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
      title: "Deferred checkout",
      authorDisplayName: "Octocat",
      updatedAt: "2026-08-23T00:00:00.000Z",
      commentCount: 0,
      isAuthoredByCurrentUser: false,
      reviewRequestedFromCurrentUser: false,
      isDraft: false,
      state: "ready",
      completedReviewCount: 1,
      requiredReviewCount: 1,
      bodyText: "Details",
      sourceBranchName: "feature/deferred",
      targetBranchName: "main",
      canonicalUrl: "https://github.com/octocat/Hello-World/pull/42",
    });

    await expect(checkoutPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(checkoutBranchMock).not.toHaveBeenCalled();
  });

  it("rejects checkout when the provider returns a different pull-request number", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = async () => createPullRequestDetails(99);
    const dependencies = createDependencies(repository, provider, {
      workspaceTrustGuard: {
        runTrustedMutation: async (_operationName, mutation) => mutation(),
      },
    });
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    await expect(
      orchestrator.getPullRequestDetails({
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      }),
    ).rejects.toMatchObject({ code: "pullRequestRepositoryMismatch" });
    await expect(
      orchestrator.checkoutPullRequest({
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      }),
    ).rejects.toMatchObject({ code: "pullRequestRepositoryMismatch" });
    expect(
      (
        dependencies.repositoryService as unknown as {
          checkoutBranch: ReturnType<typeof vi.fn>;
        }
      ).checkoutBranch,
    ).not.toHaveBeenCalled();
  });

  it("rejects checkout when the repository path is reused by another object", async () => {
    const repository = createRepository("/workspace/repository");
    const replacementRepository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = async () => createPullRequestDetails(42);
    let currentRepository = repository;
    const dependencies = createDependencies(repository, provider, {
      workspaceTrustGuard: {
        runTrustedMutation: async (_operationName, mutation) => mutation(),
      },
    });
    const mutableDiscovery = dependencies.repositoryDiscovery as unknown as {
      selectRepository: ReturnType<typeof vi.fn>;
    };
    mutableDiscovery.selectRepository = vi.fn(
      async (): Promise<FakeRepository> => currentRepository,
    );
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    currentRepository = replacementRepository;

    await expect(
      orchestrator.checkoutPullRequest({
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      }),
    ).rejects.toMatchObject({ code: "pullRequestRepositoryMismatch" });
    expect(
      (
        dependencies.repositoryService as unknown as {
          checkoutBranch: ReturnType<typeof vi.fn>;
        }
      ).checkoutBranch,
    ).not.toHaveBeenCalled();
  });

  it("revalidates the repository and cancellation inside trusted checkout", async () => {
    const repository = createRepository("/workspace/repository");
    const replacementRepository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = async () => createPullRequestDetails(42);
    let currentRepository = repository;
    const dependencies = createDependencies(repository, provider, {
      workspaceTrustGuard: {
        runTrustedMutation: async (_operationName, mutation) => {
          currentRepository = replacementRepository;
          return mutation();
        },
      },
    });
    const mutableDiscovery = dependencies.repositoryDiscovery as unknown as {
      selectRepository: ReturnType<typeof vi.fn>;
    };
    mutableDiscovery.selectRepository = vi.fn(async () => currentRepository);
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    await expect(
      orchestrator.checkoutPullRequest({
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      }),
    ).rejects.toMatchObject({ code: "pullRequestRepositoryMismatch" });
    expect(
      (
        dependencies.repositoryService as unknown as {
          checkoutBranch: ReturnType<typeof vi.fn>;
        }
      ).checkoutBranch,
    ).not.toHaveBeenCalled();
  });

  it("cancels trusted checkout before the mutation runs", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = async () => createPullRequestDetails(42);
    let releaseTrust: (() => void) | undefined;
    let trustMutationStarted: (() => void) | undefined;
    const trustReady = new Promise<void>((resolve) => {
      trustMutationStarted = resolve;
    });
    const dependencies = createDependencies(repository, provider, {
      workspaceTrustGuard: {
        runTrustedMutation: async (_operationName, mutation) => {
          trustMutationStarted?.();
          await new Promise<void>((resolve) => {
            releaseTrust = resolve;
          });
          return mutation();
        },
      },
    });
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const cancellationController = new AbortController();
    const checkoutPromise = orchestrator.checkoutPullRequest(
      {
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      },
      cancellationController.signal,
    );
    await trustReady;
    cancellationController.abort();
    releaseTrust?.();

    await expect(checkoutPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(
      (
        dependencies.repositoryService as unknown as {
          checkoutBranch: ReturnType<typeof vi.fn>;
        }
      ).checkoutBranch,
    ).not.toHaveBeenCalled();
  });

  it("cancels detail work when the selected repository changes", async () => {
    const firstRepository = createRepository("/workspace/first");
    const secondRepository = createRepository("/workspace/second");
    let resolveDetails: ((details: unknown) => void) | undefined;
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = () =>
      new Promise((resolve) => {
        resolveDetails = resolve as unknown as (details: unknown) => void;
      });
    const dependencies = createDependencies(firstRepository, provider);
    const mutableDiscovery = dependencies.repositoryDiscovery as unknown as {
      listRepositories: ReturnType<typeof vi.fn>;
      selectRepository: ReturnType<typeof vi.fn>;
    };
    mutableDiscovery.listRepositories = vi.fn(async () => [
      firstRepository,
      secondRepository,
    ]);
    mutableDiscovery.selectRepository = vi.fn(
      async (selection: {
        readonly selectedRepositoryRoot?: { readonly fsPath: string };
      }) =>
        selection.selectedRepositoryRoot?.fsPath ===
        secondRepository.rootUri.fsPath
          ? secondRepository
          : firstRepository,
    ) as never;
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const detailsPromise = orchestrator.getPullRequestDetails({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    });
    await vi.waitFor(() => expect(resolveDetails).toBeDefined());
    await orchestrator.selectRepository(secondRepository.rootUri.fsPath);
    resolveDetails?.(createPullRequestDetails(42));

    await expect(detailsPromise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("trust-gates checkout immediately after async pull request details", async () => {
    let workspaceTrusted = true;
    const checkoutBranchMock = vi.fn(async () => undefined);
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = async () => {
      workspaceTrusted = false;
      return {
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
        title: "Details",
        authorDisplayName: "Octocat",
        updatedAt: "2026-08-23T00:00:00.000Z",
        commentCount: 0,
        isAuthoredByCurrentUser: false,
        reviewRequestedFromCurrentUser: false,
        isDraft: false,
        state: "ready" as const,
        completedReviewCount: 1,
        requiredReviewCount: 1,
        bodyText: "Details",
        sourceBranchName: "feature/checkout",
        targetBranchName: "main",
        canonicalUrl: "https://github.com/octocat/Hello-World/pull/42",
      };
    };
    const dependencies = createDependencies(
      createRepository("/workspace/repository"),
      provider,
      {
        workspaceTrustGuard: {
          runTrustedMutation: async (_operationName, mutation) => {
            if (!workspaceTrusted) throw new Error("untrusted workspace");
            return mutation();
          },
        },
      },
    );
    (
      dependencies.repositoryService as unknown as {
        checkoutBranch: typeof checkoutBranchMock;
      }
    ).checkoutBranch = checkoutBranchMock;
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    await expect(
      orchestrator.checkoutPullRequest({
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      }),
    ).rejects.toThrow("untrusted workspace");
    expect(checkoutBranchMock).not.toHaveBeenCalled();
  });

  it("passes checkout cancellation to the local repository service", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = async () => createPullRequestDetails(42);
    const dependencies = createDependencies(repository, provider);
    const checkoutBranchMock = (
      dependencies.repositoryService as unknown as {
        readonly checkoutBranch: ReturnType<typeof vi.fn>;
      }
    ).checkoutBranch;
    const orchestrator = new DashboardOrchestrator(dependencies);
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const cancellationController = new AbortController();

    await orchestrator.checkoutPullRequest(
      {
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      },
      cancellationController.signal,
    );

    expect(checkoutBranchMock).toHaveBeenCalledWith(
      "feature/checkout",
      {
        selectedRepositoryRoot: repository.rootUri,
        expectedRepository: repository,
      },
      false,
      cancellationController.signal,
    );
  });

  it("cancels detail work when the dashboard is disposed", async () => {
    const repository = createRepository("/workspace/repository");
    let resolveDetails: ((details: unknown) => void) | undefined;
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    provider.getPullRequestDetails = () =>
      new Promise((resolve) => {
        resolveDetails = resolve as unknown as (details: unknown) => void;
      });
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const detailsPromise = orchestrator.getPullRequestDetails({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    });
    await vi.waitFor(() => expect(resolveDetails).toBeDefined());
    orchestrator.dispose();
    resolveDetails?.({});

    await expect(detailsPromise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("returns an empty snapshot after disposal", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    orchestrator.dispose();

    expect(orchestrator.getSnapshot()).toEqual({
      requestGeneration: 0,
      repositories: [],
      selectedRepository: null,
      providerFilter: "all",
      loadingSections: [],
      sectionErrors: [],
    });
  });

  it("keeps the previous account when a silent session switch fails", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("/cloud"),
    );
    configureSilentSessionSwitchFailure(provider);
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    await orchestrator.refresh();

    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Octocat",
    });
    expect(JSON.stringify(orchestrator.getSnapshot())).not.toContain(
      "new-account-token",
    );
  });

  it("rejects a dashboard containing a cross-repository pull request", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () => ({
      ...createDashboardSnapshot("/cloud"),
      pullRequests: [
        {
          providerId: "github",
          repositoryOwner: "other-owner",
          repositoryName: "other-repository",
          pullRequestNumber: 1,
          title: "Unexpected repository",
          authorDisplayName: "Other",
          updatedAt: "2026-08-23T00:00:00.000Z",
          commentCount: 0,
          isAuthoredByCurrentUser: false,
          reviewRequestedFromCurrentUser: false,
          isDraft: false,
          state: "ready",
          completedReviewCount: 0,
          requiredReviewCount: 0,
        },
      ],
    }));
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await expect(orchestrator.connectProvider("github")).rejects.toThrow(
      "GitHub returned a pull request for a different repository.",
    );

    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0]
        ?.pullRequests,
    ).toEqual([]);
    expect(orchestrator.getSnapshot().sectionErrors).toContainEqual({
      section: "github",
      userMessage: "GitHub returned a pull request for a different repository.",
    });
  });

  it("rejects a dashboard rooted at a different repository", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot(
        "https://github.com/other-owner/other-repository",
      ),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await expect(orchestrator.connectProvider("github")).rejects.toThrow(
      "GitHub returned data for a different repository.",
    );

    expect(orchestrator.getSnapshot().sectionErrors).toContainEqual({
      section: "github",
      userMessage: "GitHub returned data for a different repository.",
    });
  });

  it("rejects a dashboard using the selected local root instead of GitHub identity", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot(repository.rootUri.fsPath),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();

    await expect(orchestrator.connectProvider("github")).rejects.toThrow(
      "GitHub returned data for a different repository.",
    );
  });

  it("accepts a dashboard rooted at the exact GitHub repository identity", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () =>
      createDashboardSnapshot("https://github.com/octocat/Hello-World"),
    );
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();

    await expect(
      orchestrator.connectProvider("github"),
    ).resolves.toBeUndefined();
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({ connectionState: "connected" });
  });

  it("preserves stale provider cache metadata in the dashboard snapshot", async () => {
    const repository = createRepository("/workspace/repository");
    const provider = createProvider(async () => ({
      ...createDashboardSnapshot("https://github.com/octocat/Hello-World"),
      cacheStatus: "stale" as const,
      staleReason: "rateLimit" as const,
    }));
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({
      connectionState: "connected",
      cacheStatus: "stale",
      staleReason: "rateLimit",
    });
  });

  it("clears stale provider cache metadata when the next response is unannotated", async () => {
    const repository = createRepository("/workspace/repository");
    let dashboardRequestCount = 0;
    const provider = createProvider(async () => {
      dashboardRequestCount += 1;
      return {
        ...createDashboardSnapshot("https://github.com/octocat/Hello-World"),
        ...(dashboardRequestCount === 1
          ? { cacheStatus: "stale" as const, staleReason: "rateLimit" as const }
          : {}),
      };
    });
    const orchestrator = new DashboardOrchestrator(
      createDependencies(repository, provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    expect(
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0],
    ).toMatchObject({ cacheStatus: "stale", staleReason: "rateLimit" });

    await orchestrator.refresh();
    const dashboard =
      orchestrator.getSnapshot().selectedRepository?.cloudDashboards[0];
    expect(dashboard).not.toHaveProperty("cacheStatus");
    expect(dashboard).not.toHaveProperty("staleReason");
  });
});

function createPullRequestDetails(
  pullRequestNumber: number,
): PullRequestDetails {
  return {
    providerId: "github",
    repositoryOwner: "octocat",
    repositoryName: "Hello-World",
    pullRequestNumber,
    title: "Details",
    authorDisplayName: "Octocat",
    updatedAt: "2026-08-23T00:00:00.000Z",
    commentCount: 0,
    isAuthoredByCurrentUser: false,
    reviewRequestedFromCurrentUser: false,
    isDraft: false,
    state: "ready",
    completedReviewCount: 1,
    requiredReviewCount: 1,
    bodyText: "Details",
    sourceBranchName: "feature/checkout",
    targetBranchName: "main",
    canonicalUrl: `https://github.com/octocat/Hello-World/pull/${pullRequestNumber}`,
  };
}

function configureSilentSessionSwitchFailure(provider: CloudGitProvider): void {
  provider.connectSilently = async () => ({
    providerId: "github",
    sessionId: "session-new",
    accessToken: "new-account-token",
  });
  provider.getCurrentUser = async (connection) =>
    connection.sessionId === "session-new"
      ? {
          providerId: "github",
          userId: "new-user",
          displayName: "New Account",
        }
      : {
          providerId: "github",
          userId: "octocat",
          displayName: "Octocat",
        };
  provider.getRepositoryDashboard = async (_identity, connection) => {
    if (connection.sessionId === "session-new") {
      throw new Error("dashboard failed for new-account-token");
    }
    return createDashboardSnapshot("/cloud");
  };
}
