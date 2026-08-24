// @vitest-environment node
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Disposable {
    public dispose(): void {}
  }
  class ThemeIcon {
    public constructor(public readonly id: string) {}
  }
  class Uri {
    public readonly scheme = "file";
    public constructor(public readonly fsPath: string) {}
    public static file(filePath: string): Uri {
      return new Uri(filePath);
    }
    public static parse(uri: string): Uri {
      return new Uri(uri.replace(/^file:\/\//, ""));
    }
    public toString(): string {
      return `file://${this.fsPath}`;
    }
  }
  class EventEmitter {
    public readonly event = vi.fn();
    public fire(): void {}
    public dispose(): void {}
  }
  class TreeItem {
    public command: unknown;
    public contextValue: string | undefined;
    public iconPath: unknown;
    public constructor(public readonly label: string) {}
  }
  return {
    Disposable,
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0 },
    Uri,
    commands: { executeCommand: vi.fn(async () => undefined) },
    env: { openExternal: vi.fn(async () => true) },
    window: {
      showErrorMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
      showInputBox: vi.fn(async () => undefined),
      showQuickPick: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, operation) => operation()),
    },
  };
});

import {
  localGitCommandIds,
  registerLocalGitCommands,
} from "../../../src/extension/commands/localGitCommands.js";
import { BranchesSurface } from "../../../src/extension/surfaces/branchesSurface.js";
import { ChangesSurface } from "../../../src/extension/surfaces/changesSurface.js";
import { CommitsSurface } from "../../../src/extension/surfaces/commitsSurface.js";
import { PullRequestsSurface } from "../../../src/extension/surfaces/pullRequestsSurface.js";
import { WorktreesSurface } from "../../../src/extension/surfaces/worktreesSurface.js";
import { reportSurfaceError } from "../../../src/extension/surfaces/surfaceUtilities.js";
import { GitoNavigationProvider } from "../../../src/extension/repositories/gitoNavigationProvider.js";
import type { GitoSurfaceServices } from "../../../src/extension/surfaces/surfaceTypes.js";
import type { LocalGitCommitSummary } from "../../../src/extension/git/localGitModels.js";
import * as vscode from "vscode";

function createServices(
  overrides: Partial<GitoSurfaceServices> = {},
): GitoSurfaceServices {
  return {
    repositoryService: {
      getRepositoryRoot: vi.fn(async () => vscode.Uri.file("/repo")),
      getChangesSnapshot: vi.fn(),
      listBranches: vi.fn(),
    } as never,
    historyService: {
      listCommitHistory: vi.fn(),
      searchHistory: vi.fn(),
      getCommitDetails: vi.fn(),
    } as never,
    worktreeService: { listWorktrees: vi.fn() } as never,
    commandExecutor: { executeCommand: vi.fn(async () => undefined) },
    ...overrides,
  };
}

describe("native Git'o surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all four change groups and sends multi-select stage to the existing command", async () => {
    const change = {
      group: "changes",
      relativePath: "src/app.ts",
      statusLabel: "Modified",
      resourceUri: vscode.Uri.file("/repo/src/app.ts"),
    } as never;
    const snapshot = {
      repositoryRoot: vscode.Uri.file("/repo"),
      mergeChanges: [],
      stagedChanges: [],
      changes: [change],
      untracked: [],
      totalChangeCount: 1,
    } as never;
    const commandExecutor = { executeCommand: vi.fn(async () => undefined) };
    const getChangesSnapshot = vi.fn(async () => snapshot);
    const services = createServices({
      commandExecutor,
      repositoryService: {
        getChangesSnapshot,
      } as never,
    });
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick.mockImplementationOnce(async (items) => {
      const typedItems = items as readonly {
        action?: string;
        change?: unknown;
      }[];
      return [typedItems.find((item) => item.change !== undefined)].filter(
        (item): item is { action?: string; change?: unknown } =>
          item !== undefined,
      ) as never;
    });
    showQuickPick.mockImplementationOnce(
      async (items) =>
        (items as readonly { action?: string }[]).find(
          (item) => item.action === "stage",
        ) as never,
    );

    await new ChangesSurface(services).open();

    expect(getChangesSnapshot).toHaveBeenCalledWith(undefined, {
      refreshStatus: true,
    });

    const renderedItems = showQuickPick.mock.calls[0]?.[0] as readonly {
      label: string;
    }[];
    expect(renderedItems.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Merge changes · 0",
        "Staged changes · 0",
        "Changes · 1",
        "Untracked · 0",
      ]),
    );
    const stageCall = commandExecutor.executeCommand.mock
      .calls[0] as unknown as
      | [
          string,
          { readonly repositoryRoot: vscode.Uri; readonly changes: unknown },
        ]
      | undefined;
    expect(stageCall?.[0]).toBe(localGitCommandIds.stageChanges);
    expect(stageCall?.[1].repositoryRoot.fsPath).toBe("/repo");
    expect(stageCall?.[1].changes).toEqual([change]);
  });

  it("keeps duplicate paths from distinct change groups independently selectable", async () => {
    const sharedUri = vscode.Uri.file("/repo/conflict.ts");
    const mergeChange = {
      changeId: "merge\u000013\u0000conflict.ts",
      group: "mergeChanges",
      status: 13,
      relativePath: "conflict.ts",
      statusLabel: "Conflict",
      resourceUri: sharedUri,
    } as never;
    const workingTreeChange = {
      changeId: "working\u00006\u0000conflict.ts",
      group: "changes",
      status: 6,
      relativePath: "conflict.ts",
      statusLabel: "Modified",
      resourceUri: sharedUri,
    } as never;
    const snapshot = {
      repositoryRoot: vscode.Uri.file("/repo"),
      mergeChanges: [mergeChange],
      stagedChanges: [],
      changes: [workingTreeChange],
      untracked: [],
      totalChangeCount: 2,
    } as never;
    const commandExecutor = { executeCommand: vi.fn(async () => undefined) };
    const services = createServices({
      commandExecutor,
      repositoryService: {
        getChangesSnapshot: vi.fn(async () => snapshot),
      } as never,
    });
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { change?: unknown }[]).filter(
            (item) => item.change !== undefined,
          ) as never,
      )
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { action?: string }[]).find(
            (item) => item.action === "stage",
          ) as never,
      );

    await new ChangesSurface(services).open();

    const stageCall = commandExecutor.executeCommand.mock
      .calls[0] as unknown as
      [string, { readonly changes: readonly unknown[] }] | undefined;
    expect(stageCall?.[1].changes).toHaveLength(2);
  });

  it("loads commits in page-sized batches and supports native search input", async () => {
    const firstCommit: LocalGitCommitSummary = {
      commitSha: "abcdef1234567",
      shortSha: "abcdef1",
      subject: "Fix parser",
      authorName: "A. Author",
      authorEmail: "a@example.com",
      authorDate: "2026-08-23T10:00:00+10:00",
      commitDate: "2026-08-23T10:00:00+10:00",
      refs: [],
    };
    const historyService = {
      listCommitHistory: vi.fn().mockResolvedValue({
        commits: [firstCommit],
        pageIndex: 0,
        hasMore: false,
      }),
      searchHistory: vi.fn(async () => [firstCommit]),
      getCommitDetails: vi.fn(async () => ({
        ...firstCommit,
        body: "Fix parser",
        parentShas: [],
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      })),
    };
    const services = createServices({
      historyService: historyService as never,
    });
    const showInputBox = vi.mocked(vscode.window.showInputBox);
    showInputBox.mockResolvedValueOnce("parser");
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { browserAction?: string }[]).find(
            (item) => item.browserAction === "search",
          ) as never,
      )
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { commit?: unknown }[]).find(
            (item) => item.commit !== undefined,
          ) as never,
      )
      .mockResolvedValueOnce(undefined);

    await new CommitsSurface(services).open();

    expect(historyService.listCommitHistory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/repo" }),
      0,
      expect.any(AbortSignal),
    );
    expect(historyService.searchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/repo" }),
      "parser",
      expect.any(AbortSignal),
    );
  });

  it("opens a selected commit file through the existing native diff command", async () => {
    const commit: LocalGitCommitSummary = {
      commitSha: "abcdef1234567",
      shortSha: "abcdef1",
      subject: "Fix parser",
      authorName: "A. Author",
      authorEmail: "a@example.com",
      authorDate: "2026-08-23T10:00:00+10:00",
      commitDate: "2026-08-23T10:00:00+10:00",
      refs: [],
    };
    const fileChange = {
      path: "src/parser.ts",
      additions: 3,
      deletions: 1,
      changeType: "modified",
    } as const;
    const historyService = {
      listCommitHistory: vi.fn(async () => ({
        commits: [commit],
        pageIndex: 0,
        hasMore: false,
      })),
      searchHistory: vi.fn(),
      getCommitDetails: vi.fn(async () => ({
        ...commit,
        body: "Fix parser",
        parentShas: [],
        files: [fileChange],
        totalAdditions: 3,
        totalDeletions: 1,
      })),
    };
    const commandExecutor = { executeCommand: vi.fn(async () => undefined) };
    const services = createServices({
      historyService: historyService as never,
      commandExecutor,
    });
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { commit?: unknown }[]).find(
            (item) => item.commit !== undefined,
          ) as never,
      )
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { fileChange?: unknown }[]).find(
            (item) => item.fileChange !== undefined,
          ) as never,
      );

    await new CommitsSurface(services).open();

    expect(commandExecutor.executeCommand).toHaveBeenCalledWith(
      localGitCommandIds.openCommitFileDiff,
      {
        repositoryRoot: vscode.Uri.file("/repo"),
        commitSha: commit.commitSha,
        filePath: fileChange.path,
      },
    );
  });

  it("rejects remote commit-diff URIs at the local command boundary", async () => {
    const registeredHandlers = new Map<
      string,
      (...argumentsPassed: readonly unknown[]) => unknown
    >();
    registerLocalGitCommands(
      {
        registerCommand: (commandIdentifier, handler) => {
          registeredHandlers.set(commandIdentifier, handler);
          return new vscode.Disposable(() => undefined);
        },
      },
      {
        repositoryService: {} as never,
        historyService: {} as never,
        nativeCommandExecutor: {} as never,
        smartCommitEnabled: () => false,
      },
    );
    const openCommitFileDiff = registeredHandlers.get(
      localGitCommandIds.openCommitFileDiff,
    );
    expect(openCommitFileDiff).toBeDefined();

    await expect(
      openCommitFileDiff?.({
        repositoryRoot: {
          scheme: "ssh",
          authority: "remote.example",
          path: "/workspace/repository",
          fsPath: "/workspace/repository",
        },
        commitSha: "abc1234",
        filePath: "src/app.ts",
      }),
    ).rejects.toThrow("local desktop repositories");
  });

  it("groups branches with upstream and ahead/behind state", async () => {
    const branches = [
      {
        name: "main",
        isRemote: false,
        isCurrent: true,
        aheadCount: 2,
        behindCount: 1,
      },
      {
        name: "feature",
        isRemote: false,
        isCurrent: false,
        upstreamBranchName: "origin/feature",
        aheadCount: 0,
        behindCount: 0,
      },
      {
        name: "origin/main",
        isRemote: true,
        isCurrent: false,
        aheadCount: 0,
        behindCount: 0,
      },
    ] as never;
    const services = createServices({
      repositoryService: {
        getRepositoryRoot: vi.fn(async () => vscode.Uri.file("/repo")),
        listBranches: vi.fn(async () => branches),
      } as never,
    });
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick.mockResolvedValueOnce(undefined);

    await new BranchesSurface(services).open();

    const labels = (
      showQuickPick.mock.calls[0]?.[0] as readonly { label: string }[]
    ).map((item) => item.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Current · 1", "Local · 1", "Remote · 1"]),
    );
    expect(
      (
        showQuickPick.mock.calls[0]?.[0] as readonly { description?: string }[]
      ).some((item) => item.description?.includes("↑2 ↓1")),
    ).toBe(true);
  });

  it("offers remote tracking checkout with the immutable repository root", async () => {
    const remoteBranch = {
      name: "origin/feature/new-ui",
      isRemote: true,
      isCurrent: false,
      aheadCount: 0,
      behindCount: 0,
    } as never;
    const commandExecutor = { executeCommand: vi.fn(async () => undefined) };
    const services = createServices({
      commandExecutor,
      repositoryService: {
        getRepositoryRoot: vi.fn(async () => vscode.Uri.file("/repo-a")),
        listBranches: vi.fn(async () => [remoteBranch]),
      } as never,
    });
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { branch?: unknown }[]).find(
            (item) => item.branch !== undefined,
          ) as never,
      )
      .mockImplementationOnce(
        async (items) =>
          (items as readonly { action?: string }[]).find(
            (item) => item.action === "checkout",
          ) as never,
      );

    await new BranchesSurface(services).open();

    const checkoutCall = commandExecutor.executeCommand.mock
      .calls[0] as unknown as
      | [
          string,
          {
            readonly repositoryRoot: vscode.Uri;
            readonly branchName: string;
            readonly isRemote: boolean;
          },
        ]
      | undefined;
    expect(checkoutCall?.[0]).toBe(localGitCommandIds.checkoutBranch);
    expect(checkoutCall?.[1].repositoryRoot.fsPath).toBe("/repo-a");
    expect(checkoutCall?.[1].branchName).toBe("origin/feature/new-ui");
    expect(checkoutCall?.[1].isRemote).toBe(true);
  });

  it("passes checkout cancellation to the local command boundary", async () => {
    const registeredHandlers = new Map<
      string,
      (...argumentsPassed: readonly unknown[]) => unknown
    >();
    let mutationStarted = false;
    const checkoutBranch = vi.fn(
      async (...argumentsPassed: readonly unknown[]) => {
        const cancellationSignal = argumentsPassed[3] as
          AbortSignal | undefined;
        if (cancellationSignal?.aborted) return;
        mutationStarted = true;
      },
    );
    const cancellationController = new AbortController();
    cancellationController.abort();
    const repositoryRoot = vscode.Uri.file("/repo");
    registerLocalGitCommands(
      {
        registerCommand: (commandIdentifier, handler) => {
          registeredHandlers.set(commandIdentifier, handler);
          return new vscode.Disposable(() => undefined);
        },
      },
      {
        repositoryService: {
          checkoutBranch,
          listBranches: vi.fn(),
        } as never,
        smartCommitEnabled: () => false,
      },
    );

    await registeredHandlers.get(localGitCommandIds.checkoutBranch)?.({
      repositoryRoot,
      branchName: "feature/cancelled",
      cancellationSignal: cancellationController.signal,
    });

    expect(checkoutBranch).toHaveBeenCalledWith(
      "feature/cancelled",
      { selectedRepositoryRoot: repositoryRoot },
      false,
      cancellationController.signal,
    );
    expect(mutationStarted).toBe(false);
  });

  it("shows worktree lock and prune state and only offers open for unsafe removal", async () => {
    const worktrees = [
      {
        path: "/repo",
        headSha: "abcdef123",
        branchName: "main",
        isLocked: false,
        isPrunable: false,
      },
      {
        path: "/repo/stale",
        headSha: "def456789",
        branchName: "stale",
        isLocked: true,
        lockReason: "review",
        isPrunable: false,
      },
    ] as never;
    const services = createServices({
      repositoryService: {
        getRepositoryRoot: vi.fn(async () => vscode.Uri.file("/repo")),
      } as never,
      worktreeService: { listWorktrees: vi.fn(async () => worktrees) } as never,
    });
    const showQuickPick = vi.mocked(vscode.window.showQuickPick);
    showQuickPick.mockResolvedValueOnce(undefined);

    await new WorktreesSurface(services).open();

    const descriptions = (
      showQuickPick.mock.calls[0]?.[0] as readonly { description?: string }[]
    )
      .map((item) => item.description)
      .filter(
        (description): description is string => description !== undefined,
      );
    expect(
      descriptions.some((description) =>
        description.includes("locked: review"),
      ),
    ).toBe(true);
    expect(
      descriptions.some((description) => description.includes("main")),
    ).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const listWorktreesMock = services.worktreeService
      .listWorktrees as unknown as ReturnType<typeof vi.fn>;
    expect(listWorktreesMock).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/repo" }),
      expect.any(AbortSignal),
    );
  });

  it("maps every sidebar destination to a native command", () => {
    const provider = new GitoNavigationProvider();
    const children = provider.getChildren();
    expect(children.map((child) => child.command)).toEqual([
      { command: "gito.openHome", title: "Open Home" },
      { command: "gito.openChanges", title: "Open Changes" },
      { command: "gito.openPullRequests", title: "Open Pull Requests" },
      { command: "gito.openCommits", title: "Open Commits" },
      { command: "gito.openBranches", title: "Open Branches" },
      { command: "gito.openWorktrees", title: "Open Worktrees" },
    ]);
  });

  it("opens Home with the pull-request focus target", async () => {
    const openHome = vi.fn(async () => undefined);
    const services = createServices({ openHome });

    await new PullRequestsSurface(services).open();

    expect(openHome).toHaveBeenCalledWith("pullRequests");
  });

  it("preserves the pull-request focus target through the command fallback", async () => {
    const executeCommand = vi.fn(async () => undefined);
    const services = createServices({ commandExecutor: { executeCommand } });

    await new PullRequestsSurface(services).open();

    expect(executeCommand).toHaveBeenCalledWith(
      "gito.openHome",
      "pullRequests",
    );
  });

  it("redacts credentials from generic surface failures", async () => {
    await reportSurfaceError(
      new Error("fetch https://user:secret@example.com/?token=opaque failed"),
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "fetch https://[redacted]@example.com/?token=[redacted] failed",
    );
  });
});
