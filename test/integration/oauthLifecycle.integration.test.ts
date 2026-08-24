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
    private readonly cancellationState = { cancelled: false };
    private readonly cancellationListeners = new Set<() => void>();
    public readonly token: {
      readonly isCancellationRequested: boolean;
      readonly onCancellationRequested: (listener: () => void) => Disposable;
    };

    public constructor() {
      const cancellationState = this.cancellationState;
      this.token = {
        get isCancellationRequested(): boolean {
          return cancellationState.cancelled;
        },
        onCancellationRequested: (listener: () => void): Disposable => {
          this.cancellationListeners.add(listener);
          return new Disposable(() =>
            this.cancellationListeners.delete(listener),
          );
        },
      };
    }

    public cancel(): void {
      this.cancellationState.cancelled = true;
      for (const listener of this.cancellationListeners) listener();
    }

    public dispose(): void {
      this.cancellationListeners.clear();
    }
  }

  class Uri {
    public constructor(public readonly value: string) {}
    public static file(filePath: string): Uri {
      return new Uri(`file://${filePath}`);
    }
    public static parse(uri: string): Uri {
      return new Uri(uri);
    }
    public toString(): string {
      return this.value;
    }
  }

  return {
    CancellationTokenSource,
    Disposable,
    Uri,
    env: { openExternal: vi.fn(() => Promise.resolve(true)) },
  };
});

import * as vscode from "vscode";
import type {
  CloudGitProvider,
  CloudRepositoryIdentity,
  CloudResourceIdentity,
  ProviderConnection,
} from "../../src/domain/cloudGitProvider.js";
import type {
  PullRequestDetails,
  PullRequestIdentity,
} from "../../src/domain/pullRequest.js";
import type { RepositoryDashboardSnapshot } from "../../src/domain/repositoryDashboard.js";
import { DashboardOrchestrator } from "../../src/extension/dashboard/dashboardOrchestrator.js";
import {
  GitHubProvider,
  githubAuthenticationScopes,
} from "../../src/extension/providers/github/index.js";
import { StatefulVscodeAuthentication } from "../helpers/statefulVscodeAuthentication.js";

const githubIdentity: CloudRepositoryIdentity = {
  providerId: "github",
  owner: "octocat",
  repositoryName: "Hello-World",
};

function createGitHubCanonicalUrl(
  resourceIdentity: CloudResourceIdentity,
): string {
  const repositoryUrl = `https://github.com/${encodeURIComponent(
    "owner" in resourceIdentity
      ? resourceIdentity.owner
      : resourceIdentity.repositoryOwner,
  )}/${encodeURIComponent(resourceIdentity.repositoryName)}`;
  return "pullRequestNumber" in resourceIdentity
    ? `${repositoryUrl}/pull/${resourceIdentity.pullRequestNumber}`
    : repositoryUrl;
}

function createSession(
  sessionId: string,
  accountId: string,
  accountLabel: string,
  accessToken: string,
  scopes: readonly string[],
): vscode.AuthenticationSession {
  return {
    id: sessionId,
    accessToken,
    account: { id: accountId, label: accountLabel },
    scopes: [...scopes],
  };
}

function createGitHubSessions(authentication: StatefulVscodeAuthentication): {
  readonly ada: vscode.AuthenticationSession;
  readonly grace: vscode.AuthenticationSession;
} {
  const ada = createSession(
    "github-session-ada",
    "github-account-ada",
    "Ada Lovelace",
    "github-token-ada-do-not-log",
    githubAuthenticationScopes,
  );
  const grace = createSession(
    "github-session-grace",
    "github-account-grace",
    "Grace Hopper",
    "github-token-grace-do-not-log",
    githubAuthenticationScopes,
  );
  authentication.addSession("github", ada);
  authentication.addSession("github", grace, { makePreferred: false });
  return { ada, grace };
}

function createCancellationToken(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token;
}

function createDashboardDependencies(
  provider: CloudGitProvider,
): ConstructorParameters<typeof DashboardOrchestrator>[0] {
  const repository = {
    rootUri: { fsPath: "/workspace/repository" },
  };
  return {
    repositoryDiscovery: {
      listRepositories: vi.fn(async () => [repository]),
      selectRepository: vi.fn(async () => repository),
    } as never,
    repositoryService: {
      getRepositoryHealth: vi.fn(async () => ({
        branchName: "main",
        uncommittedChangeCount: 0,
        aheadCount: 0,
        behindCount: 0,
      })),
      checkoutBranch: vi.fn(async () => undefined),
    } as never,
    historyService: {
      getRemoteUrls: vi.fn(async () => [
        "https://github.com/octocat/Hello-World.git",
      ]),
      getCommitActivity: vi.fn(async () => ({
        days: new Map<string, number>([["2026-08-23", 1]]),
        matchingCommitCount: 1,
        reachedSafetyCap: false,
        outputTruncated: false,
      })),
    } as never,
    providers: [provider],
    workspaceTrustGuard: {
      runTrustedMutation: async <Result>(
        _operationName: string,
        mutation: () => Promise<Result> | Result,
      ): Promise<Result> => mutation(),
    },
  };
}

interface AuthenticationBackedProviderOptions {
  readonly dashboardFailureMessage?: string;
  readonly detailsFailureMessage?: string;
  readonly currentUserFailureSessionId?: string;
}

interface AuthenticationBackedProvider extends CloudGitProvider {
  readonly connectSilently: (
    cancellationToken: vscode.CancellationToken,
  ) => Promise<ProviderConnection>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly setDashboardFailure: (message: string | undefined) => void;
  readonly setDetailsFailure: (message: string | undefined) => void;
  readonly setCurrentUserFailureSession: (
    sessionId: string | undefined,
  ) => void;
}

function createAuthenticationBackedProvider(
  authentication: StatefulVscodeAuthentication,
  sessions: readonly vscode.AuthenticationSession[],
  options: AuthenticationBackedProviderOptions = {},
): AuthenticationBackedProvider {
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  let dashboardFailureMessage = options.dashboardFailureMessage;
  let detailsFailureMessage = options.detailsFailureMessage;
  let currentUserFailureSessionId = options.currentUserFailureSessionId;
  const acquireConnection = async (
    cancellationToken: vscode.CancellationToken,
    interactive: boolean,
  ): Promise<ProviderConnection> => {
    if (cancellationToken.isCancellationRequested) {
      throw new Error("connection cancelled");
    }
    const sessionPromise = authentication.getSession(
      "github",
      githubAuthenticationScopes,
      interactive
        ? {
            clearSessionPreference: true,
            createIfNone: {
              detail: "Connect GitHub for read-only pull requests.",
            },
          }
        : { silent: true, clearSessionPreference: false },
    );
    let cancellationDisposable: vscode.Disposable | undefined;
    const cancellationPromise = new Promise<never>((_resolve, reject) => {
      cancellationDisposable = cancellationToken.onCancellationRequested(() =>
        reject(new Error("connection cancelled")),
      );
    });
    try {
      const session = await Promise.race([sessionPromise, cancellationPromise]);
      if (session === undefined)
        throw new Error("authentication session removed");
      return {
        providerId: "github",
        sessionId: session.id,
        accessToken: session.accessToken,
      };
    } finally {
      cancellationDisposable?.dispose();
    }
  };
  const provider = {
    providerId: "github" as const,
    detectRepository: () => githubIdentity,
    connect: (cancellationToken: vscode.CancellationToken) =>
      acquireConnection(cancellationToken, true),
    connectSilently: (cancellationToken: vscode.CancellationToken) =>
      acquireConnection(cancellationToken, false),
    getCurrentUser: async (connection: ProviderConnection) => {
      if (connection.sessionId === currentUserFailureSessionId) {
        throw new Error(
          options.detailsFailureMessage ?? "account lookup failed",
        );
      }
      const session = sessionsById.get(connection.sessionId);
      if (session === undefined) throw new Error("unknown session");
      return {
        providerId: "github" as const,
        userId: session.account.id,
        displayName: session.account.label,
      };
    },
    getRepositoryDashboard: async (
      repositoryIdentity: CloudRepositoryIdentity,
      connection: ProviderConnection,
    ): Promise<RepositoryDashboardSnapshot> => {
      void connection;
      if (dashboardFailureMessage !== undefined) {
        throw new Error(dashboardFailureMessage);
      }
      return {
        repositoryRoot: createGitHubCanonicalUrl(repositoryIdentity),
        providerId: repositoryIdentity.providerId,
        pullRequests: [createPullRequestSummary(repositoryIdentity)],
        fetchedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    getPullRequestDetails: async (
      pullRequestIdentity: PullRequestIdentity,
    ): Promise<PullRequestDetails> => {
      if (detailsFailureMessage !== undefined) {
        throw new Error(detailsFailureMessage);
      }
      return {
        ...createPullRequestSummary(githubIdentity),
        ...pullRequestIdentity,
        bodyText: "Review details",
        sourceBranchName: "feature/read-only",
        targetBranchName: "main",
        canonicalUrl: "https://github.com/octocat/Hello-World/pull/42",
      };
    },
    getCanonicalUrl: (resourceIdentity) =>
      ({
        toString: () => createGitHubCanonicalUrl(resourceIdentity),
      }) as never,
    disconnect: vi.fn(),
    setDashboardFailure(message: string | undefined): void {
      dashboardFailureMessage = message;
    },
    setDetailsFailure(message: string | undefined): void {
      detailsFailureMessage = message;
    },
    setCurrentUserFailureSession(sessionId: string | undefined): void {
      currentUserFailureSessionId = sessionId;
    },
  } as AuthenticationBackedProvider;
  return provider;
}

function createPullRequestSummary(
  repositoryIdentity: CloudRepositoryIdentity,
): RepositoryDashboardSnapshot["pullRequests"][number] {
  return {
    providerId: repositoryIdentity.providerId,
    repositoryOwner: repositoryIdentity.owner,
    repositoryName: repositoryIdentity.repositoryName,
    pullRequestNumber: 42,
    title: "Read-only dashboard",
    authorDisplayName: "Ada Lovelace",
    updatedAt: "2026-08-23T00:00:00.000Z",
    commentCount: 0,
    isAuthoredByCurrentUser: false,
    reviewRequestedFromCurrentUser: false,
    isDraft: false,
    state: "ready",
    completedReviewCount: 1,
    requiredReviewCount: 1,
  };
}

function expectInteractiveAuthenticationOptions(
  options: vscode.AuthenticationGetSessionOptions,
  expectedDetail: string,
): void {
  expect(options).toEqual({
    clearSessionPreference: true,
    createIfNone: { detail: expectedDetail },
  });
}

describe("OAuth provider boundary lifecycle", () => {
  it("real providers use interactive and silent authentication options", async () => {
    const githubAuthentication = new StatefulVscodeAuthentication();
    const githubSession = createSession(
      "github-session",
      "github-account",
      "GitHub account",
      "github-token-explicit-options",
      githubAuthenticationScopes,
    );
    githubAuthentication.addSession("github", githubSession);
    const githubProvider = new GitHubProvider({
      authentication: githubAuthentication.getAuthenticationApi(),
    });
    const githubCancellationToken = createCancellationToken();
    await githubProvider.connect(githubCancellationToken);
    await githubProvider.connectSilently(githubCancellationToken);
    expect(githubAuthentication.calls).toHaveLength(2);
    expectInteractiveAuthenticationOptions(
      githubAuthentication.calls[0]!.options,
      "VS Code will grant Git'o repo and read:user scopes. GitHub's repo scope can grant access broader than Git'o's read-only GitHub API operations; Git'o uses these scopes only for read-only operations.",
    );
    expect(githubAuthentication.calls[0]?.scopes).toEqual(
      githubAuthenticationScopes,
    );
    expect(githubAuthentication.calls[1]?.options).toEqual({
      silent: true,
      clearSessionPreference: false,
    });
    expect(githubAuthentication.calls[1]?.scopes).toEqual(
      githubAuthenticationScopes,
    );
    expect(githubAuthentication.interactivePromptCount).toBe(1);
  });

  it("does not prompt again for refresh or pull-request details", async () => {
    const authentication = new StatefulVscodeAuthentication();
    const sessions = createGitHubSessions(authentication);
    const provider = createAuthenticationBackedProvider(authentication, [
      sessions.ada,
      sessions.grace,
    ]);
    const orchestrator = new DashboardOrchestrator(
      createDashboardDependencies(provider),
    );

    await orchestrator.load();
    await orchestrator.connectProvider("github");
    expect(authentication.interactivePromptCount).toBe(1);

    await orchestrator.refresh();
    await orchestrator.getPullRequestDetails({
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 42,
    });

    expect(authentication.interactivePromptCount).toBe(1);
    expect(
      authentication.calls.filter(
        (call) => call.options.clearSessionPreference === true,
      ),
    ).toHaveLength(1);
    expect(
      authentication.calls.filter((call) => call.options.silent === true),
    ).toHaveLength(2);
  });

  it("keeps the prior account when interactive reconnect is cancelled", async () => {
    const authentication = new StatefulVscodeAuthentication();
    const sessions = createGitHubSessions(authentication);
    const provider = createAuthenticationBackedProvider(authentication, [
      sessions.ada,
      sessions.grace,
    ]);
    const orchestrator = new DashboardOrchestrator(
      createDashboardDependencies(provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    authentication.deferNextInteractiveAuthentication();
    const reconnectPromise = orchestrator.connectProvider("github");
    await vi.waitFor(() =>
      expect(authentication.pendingInteractiveAuthenticationCount).toBe(1),
    );
    orchestrator.cancelPendingRequests();
    await expect(reconnectPromise).rejects.toMatchObject({ code: "cancelled" });

    expect(
      orchestrator
        .getSnapshot()
        .selectedRepository?.cloudDashboards.find(
          (dashboard) => dashboard.providerId === "github",
        ),
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Ada Lovelace",
    });
  });

  it("swaps accounts atomically when the new account cannot initialize", async () => {
    const authentication = new StatefulVscodeAuthentication();
    const sessions = createGitHubSessions(authentication);
    const provider = createAuthenticationBackedProvider(authentication, [
      sessions.ada,
      sessions.grace,
    ]);
    const orchestrator = new DashboardOrchestrator(
      createDashboardDependencies(provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");

    authentication.setNextInteractiveAccount("github-account-grace");
    provider.setCurrentUserFailureSession(sessions.grace.id);
    await expect(orchestrator.connectProvider("github")).rejects.toBeDefined();

    expect(
      orchestrator
        .getSnapshot()
        .selectedRepository?.cloudDashboards.find(
          (dashboard) => dashboard.providerId === "github",
        ),
    ).toMatchObject({
      connectionState: "connected",
      accountDisplayName: "Ada Lovelace",
    });
  });

  it("disconnects the provider and clears visible account state", async () => {
    const authentication = new StatefulVscodeAuthentication();
    const sessions = createGitHubSessions(authentication);
    const provider = createAuthenticationBackedProvider(authentication, [
      sessions.ada,
      sessions.grace,
    ]);
    const orchestrator = new DashboardOrchestrator(
      createDashboardDependencies(provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    orchestrator.disconnectProvider("github");

    expect(provider.disconnect).toHaveBeenCalled();
    expect(
      orchestrator
        .getSnapshot()
        .selectedRepository?.cloudDashboards.find(
          (dashboard) => dashboard.providerId === "github",
        ),
    ).toMatchObject({
      connectionState: "disconnected",
      pullRequests: [],
    });
  });

  it("keeps tokens out of snapshots, provider errors, and serialized failures", async () => {
    const authentication = new StatefulVscodeAuthentication();
    const sessions = createGitHubSessions(authentication);
    const leakedToken = sessions.ada.accessToken;
    const provider = createAuthenticationBackedProvider(
      authentication,
      [sessions.ada, sessions.grace],
      { dashboardFailureMessage: `request failed: ${leakedToken}` },
    );
    const orchestrator = new DashboardOrchestrator(
      createDashboardDependencies(provider),
    );
    await orchestrator.load();
    await expect(orchestrator.connectProvider("github")).rejects.toThrow(
      "request failed: [redacted]",
    );

    const serializedSnapshot = JSON.stringify(orchestrator.getSnapshot());
    expect(serializedSnapshot).not.toContain(leakedToken);
    const serializedProvider = JSON.stringify(provider);
    expect(serializedProvider).not.toContain(leakedToken);
    const serializedFailures = JSON.stringify(
      orchestrator.getSnapshot().sectionErrors,
    );
    expect(serializedFailures).not.toContain(leakedToken);
  });

  it("treats removed authentication sessions as disconnected and requiring reconnect", async () => {
    const authentication = new StatefulVscodeAuthentication();
    const sessions = createGitHubSessions(authentication);
    const removedSessionEvents: string[] = [];
    authentication.onDidChangeSessions((event) => {
      for (const session of event.removed ?? [])
        removedSessionEvents.push(session.id);
    });
    const provider = createAuthenticationBackedProvider(authentication, [
      sessions.ada,
      sessions.grace,
    ]);
    const orchestrator = new DashboardOrchestrator(
      createDashboardDependencies(provider),
    );
    await orchestrator.load();
    await orchestrator.connectProvider("github");
    const promptCountAfterConnect = authentication.interactivePromptCount;

    authentication.removeSession("github", sessions.ada.id);
    await orchestrator.refresh();

    expect(removedSessionEvents).toEqual([sessions.ada.id]);
    expect(authentication.interactivePromptCount).toBe(promptCountAfterConnect);
    expect(
      orchestrator
        .getSnapshot()
        .selectedRepository?.cloudDashboards.find(
          (dashboard) => dashboard.providerId === "github",
        ),
    ).toMatchObject({ connectionState: "disconnected" });
  });
});
