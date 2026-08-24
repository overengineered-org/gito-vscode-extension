// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

interface MockDisposable {
  dispose(): void;
}

const { TestDisposable } = vi.hoisted(() => {
  class HoistedTestDisposable implements MockDisposable {
    private disposed = false;

    public constructor(
      private readonly disposeCallback: () => void = () => {},
    ) {}

    public dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.disposeCallback();
    }
  }

  return { TestDisposable: HoistedTestDisposable };
});

interface TestWebview {
  html: string;
  readonly cspSource: string;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly asWebviewUri: (uri: { toString(): string }) => {
    toString(): string;
  };
  readonly onDidReceiveMessage: (
    listener: (message: unknown) => void,
  ) => MockDisposable;
  messageListener: ((message: unknown) => void) | undefined;
}

interface TestWebviewPanel {
  readonly webview: TestWebview;
  readonly reveal: ReturnType<typeof vi.fn>;
  readonly onDidDispose: (listener: () => void) => MockDisposable;
  readonly dispose: () => void;
}

let lastWebviewPanel: TestWebviewPanel | undefined;
let panelOptions: Record<string, unknown> | undefined;

vi.mock("vscode", () => {
  class Uri {
    public constructor(private readonly value: string) {}

    public static joinPath(uri: Uri, ...pathSegments: string[]): Uri {
      return new Uri([uri.value, ...pathSegments].join("/"));
    }

    public toString(): string {
      return `file://${this.value}`;
    }
  }

  return {
    Disposable: TestDisposable,
    Uri,
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel: vi.fn(
        (
          _viewType: string,
          _title: string,
          _viewColumn: number,
          options: Record<string, unknown>,
        ) => {
          panelOptions = options;
          const disposeListeners = new Set<() => void>();
          let disposed = false;
          const webview: TestWebview = {
            html: "",
            cspSource: "vscode-resource://test",
            postMessage: vi.fn(() => Promise.resolve(true)),
            asWebviewUri: (uri) => ({
              toString: () => `vscode-webview://${uri.toString()}`,
            }),
            messageListener: undefined,
            onDidReceiveMessage: (listener) => {
              webview.messageListener = listener;
              return new TestDisposable(
                () => (webview.messageListener = undefined),
              );
            },
          };
          const webviewPanel: TestWebviewPanel = {
            webview,
            reveal: vi.fn(),
            onDidDispose: (listener) => {
              disposeListeners.add(listener);
              return new TestDisposable(() =>
                disposeListeners.delete(listener),
              );
            },
            dispose: () => {
              if (disposed) return;
              disposed = true;
              for (const listener of disposeListeners) listener();
            },
          };
          lastWebviewPanel = webviewPanel;
          return webviewPanel;
        },
      ),
    },
  };
});

import {
  RepositoryHomePanel,
  type RepositoryHomeController,
} from "../../../src/extension/webviews/repositoryHomePanel.js";
import { createContentSecurityNonce } from "../../../src/extension/security/webviewSecurity.js";
import type { RepositoryHomeSnapshot } from "../../../src/protocol/repositoryHomeProtocol.js";
import type { PullRequestDetails } from "../../../src/domain/pullRequest.js";

const emptySnapshot: RepositoryHomeSnapshot = {
  requestGeneration: 0,
  repositories: [],
  selectedRepository: null,
  providerFilter: "all",
  loadingSections: [],
  sectionErrors: [],
};

const pullRequestDetails: PullRequestDetails = {
  providerId: "github",
  repositoryOwner: "octocat",
  repositoryName: "Hello-World",
  pullRequestNumber: 7,
  title: "Improve review dashboard",
  authorDisplayName: "Octocat",
  updatedAt: "2030-01-01T00:00:00.000Z",
  commentCount: 2,
  isAuthoredByCurrentUser: false,
  reviewRequestedFromCurrentUser: true,
  isDraft: false,
  state: "ready",
  completedReviewCount: 2,
  requiredReviewCount: 2,
  bodyText: "Review details",
  sourceBranchName: "feature/dashboard",
  targetBranchName: "main",
  canonicalUrl: "https://github.com/octocat/Hello-World/pull/7",
};

function createController(
  overrides: Partial<RepositoryHomeController> = {},
): RepositoryHomeController & {
  readonly calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    cancelPendingRequests: vi.fn(),
    load: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    selectRepository: vi.fn(() => Promise.resolve()),
    setProviderFilter: vi.fn(),
    connectProvider: vi.fn(() => Promise.resolve()),
    disconnectProvider: vi.fn(),
    getPullRequestDetails: vi.fn(() => Promise.resolve(pullRequestDetails)),
    checkoutPullRequest: vi.fn(() => Promise.resolve()),
    openExternalPullRequest: vi.fn(() => Promise.resolve()),
  };
  const controller: RepositoryHomeController = {
    getSnapshot: () => emptySnapshot,
    subscribe: (listener) => {
      listener(emptySnapshot);
      return new TestDisposable();
    },
    ...calls,
    ...overrides,
  };
  return { ...controller, calls };
}

function sendWebviewMessage(message: unknown): Promise<void> {
  lastWebviewPanel?.webview.messageListener?.(message);
  return Promise.resolve();
}

function postedMessages(): readonly Record<string, unknown>[] {
  return (lastWebviewPanel?.webview.postMessage.mock.calls ?? []).map(
    ([message]) => message as Record<string, unknown>,
  );
}

describe("RepositoryHomePanel", () => {
  it("reveals an existing Home panel without preserving editor focus", () => {
    const controller = createController();
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    panel.revealOrCreate();

    expect(lastWebviewPanel?.reveal).toHaveBeenCalledWith(1, false);
  });

  it("opens Home before refreshing when the panel is closed", async () => {
    const controller = createController();
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );

    await panel.refresh();

    expect(lastWebviewPanel).toBeDefined();
    expect(controller.calls.refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores hostile and schema-invalid webview messages", async () => {
    const controller = createController();
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();

    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "refreshDashboard",
      accessToken: "opaque-token",
    });
    await sendWebviewMessage({
      protocolVersion: 999,
      messageType: "ready",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "connectProvider",
      providerId: "github",
      __proto__: { accessToken: "opaque-token" },
    });

    expect(controller.calls.refresh).not.toHaveBeenCalled();
    expect(controller.calls.load).not.toHaveBeenCalled();
    expect(controller.calls.connectProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(postedMessages())).not.toContain("opaque-token");
  });

  it("dispatches every protocol action and reports completion", async () => {
    const controller = createController();
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    const pullRequestIdentity = {
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 7,
    } as const;

    await sendWebviewMessage({ protocolVersion: 1, messageType: "ready" });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "refreshDashboard",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "selectRepository",
      repositoryRoot: "/workspace/repository",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "setProviderFilter",
      providerFilter: "github",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "connectProvider",
      providerId: "github",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "disconnectProvider",
      providerId: "github",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "openPullRequestDetails",
      pullRequestIdentity,
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "checkoutPullRequest",
      pullRequestIdentity,
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "openExternalPullRequest",
      pullRequestIdentity,
    });

    expect(controller.calls.load).toHaveBeenCalledTimes(1);
    expect(controller.calls.refresh).toHaveBeenCalledTimes(1);
    expect(controller.calls.selectRepository).toHaveBeenCalledWith(
      "/workspace/repository",
    );
    expect(controller.calls.setProviderFilter).toHaveBeenCalledWith("github");
    expect(controller.calls.connectProvider).toHaveBeenCalledWith("github");
    expect(controller.calls.disconnectProvider).toHaveBeenCalledWith("github");
    expect(controller.calls.getPullRequestDetails).toHaveBeenCalledWith(
      pullRequestIdentity,
      expect.any(AbortSignal),
    );
    expect(controller.calls.checkoutPullRequest).toHaveBeenCalledWith(
      pullRequestIdentity,
      expect.any(AbortSignal),
    );
    expect(controller.calls.openExternalPullRequest).toHaveBeenCalledWith(
      pullRequestIdentity,
      expect.any(AbortSignal),
    );
    expect(
      postedMessages().filter(
        (message) => message.messageType === "operationCompleted",
      ),
    ).toHaveLength(9);
    const loadedDetailsMessage = postedMessages().find(
      (message) => message.messageType === "pullRequestDetailsLoaded",
    );
    expect(loadedDetailsMessage).toMatchObject({
      protocolVersion: 1,
      messageType: "pullRequestDetailsLoaded",
      pullRequestIdentity,
      pullRequestDetails,
    });
    expect(typeof loadedDetailsMessage?.requestGeneration).toBe("number");
  });

  it("carries the typed focus target through the initial Home snapshot", async () => {
    const loadedSnapshot: RepositoryHomeSnapshot = {
      ...emptySnapshot,
      repositories: [
        {
          repositoryRoot: "/workspace/repository",
          repositoryDisplayName: "repo",
        },
      ],
      selectedRepository: {
        repositoryRoot: "/workspace/repository",
        repositoryDisplayName: "repo",
        repositoryHealth: {
          branchName: "main",
          uncommittedChangeCount: 0,
          aheadCount: 0,
          behindCount: 0,
        },
        commitActivity: {
          days: [],
          totalCommitCount: 0,
          safetyCapReached: false,
        },
        cloudDashboards: [],
      },
    };
    const controller = createController({
      getSnapshot: () => loadedSnapshot,
    });
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );

    await panel.revealAndWaitForLoad("pullRequests");

    expect(
      postedMessages()
        .filter((message) => message.messageType === "repositoryHomeChanged")
        .at(-1),
    ).toMatchObject({ focusTarget: "pullRequests" });
  });

  it("does not leak a pending focus target into a later Home panel", async () => {
    let resolveLoad: (() => void) | undefined;
    const loadedSnapshot: RepositoryHomeSnapshot = {
      ...emptySnapshot,
      repositories: [
        {
          repositoryRoot: "/workspace/repository",
          repositoryDisplayName: "repo",
        },
      ],
      selectedRepository: {
        repositoryRoot: "/workspace/repository",
        repositoryDisplayName: "repo",
        repositoryHealth: {
          branchName: "main",
          uncommittedChangeCount: 0,
          aheadCount: 0,
          behindCount: 0,
        },
        commitActivity: {
          days: [],
          totalCommitCount: 0,
          safetyCapReached: false,
        },
        cloudDashboards: [],
      },
    };
    const controller = createController({
      getSnapshot: () => loadedSnapshot,
      load: () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    });
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );

    const openingPromise = panel.revealAndWaitForLoad("pullRequests");
    lastWebviewPanel?.dispose();
    panel.revealOrCreate();
    resolveLoad?.();
    await openingPromise;

    expect(
      postedMessages().filter(
        (message) =>
          message.messageType === "repositoryHomeChanged" &&
          message.focusTarget !== undefined,
      ),
    ).toHaveLength(0);
  });

  it("uses a random nonce, least-privilege CSP, and only dist resources", () => {
    const firstNonce = createContentSecurityNonce();
    const secondNonce = createContentSecurityNonce();
    expect(firstNonce).toHaveLength(43);
    expect(secondNonce).toHaveLength(43);
    expect(secondNonce).not.toBe(firstNonce);

    const controller = createController();
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    const webviewHtml = lastWebviewPanel?.webview.html ?? "";

    expect(panelOptions?.localResourceRoots).toHaveLength(1);
    expect(panelOptions?.enableCommandUris).toEqual([
      "gito.onboarding.openOrChooseRepository",
    ]);
    expect(webviewHtml).toContain("connect-src 'none'");
    expect(webviewHtml).toContain("object-src 'none'");
    expect(webviewHtml).toContain("script-src 'nonce-");
    expect(webviewHtml).toContain("font-src vscode-resource://test");
    expect(webviewHtml).not.toContain("node_modules");
    expect(webviewHtml).not.toContain("codicon.css");
  });

  it("emits a safe failure when a controller operation rejects", async () => {
    const controller = createController({
      refresh: () => Promise.reject(new Error("access token opaque-token")),
    });
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "refreshDashboard",
    });
    await Promise.resolve();

    const failureMessage = postedMessages().find(
      (message) => message.messageType === "operationFailed",
    );
    expect(failureMessage).toMatchObject({
      operationName: "refreshDashboard",
      userMessage: "The operation could not be completed.",
    });
    expect(JSON.stringify(failureMessage)).not.toContain("opaque-token");
  });

  it("redacts URL userinfo and opaque query credentials in webview failures", async () => {
    const controller = createController({
      refresh: () =>
        Promise.reject(
          new Error(
            "fetch https://opaque-secret@example.test/repo?token=query-secret failed",
          ),
        ),
    });
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "refreshDashboard",
    });
    await Promise.resolve();

    const failureMessage = postedMessages().find(
      (message) => message.messageType === "operationFailed",
    );
    expect(failureMessage?.userMessage).toBe(
      "fetch https://[redacted]@example.test/repo?token=[redacted] failed",
    );
    expect(JSON.stringify(failureMessage)).not.toContain("opaque-secret");
    expect(JSON.stringify(failureMessage)).not.toContain("query-secret");
  });

  it("cancels and suppresses stale work, then disposes cleanly", async () => {
    let resolveFirstLoad: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      resolveFirstLoad = resolve;
    });
    const controller = createController({
      load: () => firstLoad,
    });
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    const readyPromise = sendWebviewMessage({
      protocolVersion: 1,
      messageType: "ready",
    });
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "refreshDashboard",
    });
    resolveFirstLoad?.();
    await readyPromise;
    await Promise.resolve();
    expect(
      postedMessages().filter(
        (message) =>
          message.messageType === "operationCompleted" &&
          message.operationName === "ready",
      ),
    ).toHaveLength(0);

    panel.dispose();
    expect(controller.calls.cancelPendingRequests).toHaveBeenCalled();
    const postedMessageCount = postedMessages().length;
    await sendWebviewMessage({
      protocolVersion: 1,
      messageType: "refreshDashboard",
    });
    expect(postedMessages()).toHaveLength(postedMessageCount);
  });

  it("cancels pull-request details when a newer snapshot invalidates identity", async () => {
    let resolveDetails: ((details: PullRequestDetails) => void) | undefined;
    let snapshotListener:
      ((snapshot: RepositoryHomeSnapshot) => void) | undefined;
    const selectedSnapshot: RepositoryHomeSnapshot = {
      ...emptySnapshot,
      requestGeneration: 1,
      repositories: [
        {
          repositoryRoot: "/workspace/repository",
          repositoryDisplayName: "repo",
        },
      ],
      selectedRepository: {
        repositoryRoot: "/workspace/repository",
        repositoryDisplayName: "repo",
        repositoryHealth: {
          branchName: "main",
          uncommittedChangeCount: 0,
          aheadCount: 0,
          behindCount: 0,
        },
        commitActivity: {
          days: [],
          totalCommitCount: 0,
          safetyCapReached: false,
        },
        cloudDashboards: [
          {
            providerId: "github",
            providerDisplayName: "GitHub",
            connectionState: "connected",
            pullRequests: [pullRequestDetails],
          },
        ],
      },
    };
    const detailsPromise = new Promise<PullRequestDetails>((resolve) => {
      resolveDetails = resolve;
    });
    const controller = createController({
      getSnapshot: () => selectedSnapshot,
      subscribe: (listener) => {
        snapshotListener = listener;
        listener(selectedSnapshot);
        return new TestDisposable();
      },
      getPullRequestDetails: () => detailsPromise,
    });
    const panel = new RepositoryHomePanel(
      { toString: () => "/extension" } as never,
      controller,
    );
    panel.revealOrCreate();
    const pullRequestIdentity = {
      providerId: "github",
      repositoryOwner: "octocat",
      repositoryName: "Hello-World",
      pullRequestNumber: 7,
    } as const;
    const detailsRequest = sendWebviewMessage({
      protocolVersion: 1,
      messageType: "openPullRequestDetails",
      pullRequestIdentity,
    });
    await Promise.resolve();
    snapshotListener?.({
      ...selectedSnapshot,
      requestGeneration: 2,
      selectedRepository: null,
    });
    resolveDetails?.(pullRequestDetails);
    await detailsRequest;
    await Promise.resolve();

    expect(controller.calls.cancelPendingRequests).toHaveBeenCalled();
    expect(
      postedMessages().some(
        (message) => message.messageType === "pullRequestDetailsLoaded",
      ),
    ).toBe(false);
    expect(
      postedMessages().some(
        (message) =>
          message.messageType === "operationFailed" &&
          message.operationName === "openPullRequestDetails",
      ),
    ).toBe(false);
  });
});
