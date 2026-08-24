// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import * as nodePath from "node:path";

const vscodeTestState = vi.hoisted(() => ({
  workspaceTrusted: true,
}));

vi.mock("vscode", () => {
  class Uri {
    public readonly scheme: string;
    public readonly authority: string;
    public readonly fsPath: string;

    public constructor(fsPath: string, scheme = "file", authority = "") {
      this.fsPath = fsPath;
      this.scheme = scheme;
      this.authority = authority;
    }

    public static file(fsPath: string): Uri {
      return new Uri(fsPath);
    }

    public toString(): string {
      return `${this.scheme}://${this.authority}${this.fsPath}`;
    }
  }

  class Disposable {
    public dispose(): void {}
  }

  class TreeItem {
    public constructor(
      public readonly label: string,
      public readonly collapsibleState: number,
    ) {}
  }

  return {
    Disposable,
    Uri,
    TreeItem,
    TreeItemCollapsibleState: { None: 0 },
    commands: {
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
      registerCommand: vi.fn(() => new Disposable()),
    },
    extensions: {
      onDidChange: vi.fn(() => new Disposable()),
      getExtension: vi.fn(),
    },
    window: { activeTextEditor: undefined },
    workspace: {
      get isTrusted(): boolean {
        return vscodeTestState.workspaceTrusted;
      },
    },
  };
});

import * as vscode from "vscode";
import {
  assertGraphRepositoryRoot,
  assertOperationsRepositoryRoot,
  createGraphSession,
  createHistoryRepositoryProvider,
  isPinnedGraphRepositoryRootCurrent,
  pinGraphRepositoryRoot,
} from "../../../src/extension/extensionComposition.js";
import type { PinnedGraphRepositoryRoot } from "../../../src/extension/extensionComposition.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import type { GitRootBindingIdentity } from "../../../src/extension/git/gitCommandRunner.js";
import type { RepositoryDiscovery } from "../../../src/extension/repositories/repositoryDiscovery.js";

const currentRepositoryRoot = createTestUri(
  "/workspace/current",
  "file",
  "workspace",
);
const currentRepository = { rootUri: currentRepositoryRoot } as never;

function createTestUri(
  fsPath: string,
  scheme: string,
  authority: string,
): vscode.Uri {
  return {
    fsPath,
    scheme,
    authority,
    toString: () => `${scheme}://${authority}${fsPath}`,
  } as vscode.Uri;
}

function createTestGraphRootBindingResolver(
  configuredGitExecutablePath = "/opt/vscode/git",
  observedExecutablePaths: string[] = [],
): GitRootBindingResolver {
  return new GitRootBindingResolver(
    () => Promise.resolve(configuredGitExecutablePath),
    {
      resolveRootBinding: async (
        repositoryRoot,
        _expectedIdentity,
        options,
      ) => {
        observedExecutablePaths.push(options?.gitExecutablePath ?? "");
        const canonicalPath = await realpath(repositoryRoot);
        const rootStatistics = await stat(canonicalPath, { bigint: true });
        const rootIdentity = {
          canonicalPath,
          device: String(rootStatistics.dev),
          inode: String(rootStatistics.ino),
        };
        return {
          ...rootIdentity,
          gitDirectory: rootIdentity,
          commonDirectory: rootIdentity,
        } satisfies GitRootBindingIdentity;
      },
    },
  );
}

describe("history production composition", () => {
  beforeEach(() => {
    vscodeTestState.workspaceTrusted = true;
  });

  it("authorizes the selected root without an active editor", async () => {
    const selectRepository = vi.fn(() => Promise.resolve(currentRepository));
    const provider = createHistoryRepositoryProvider({
      selectRepository,
    } as unknown as RepositoryDiscovery);

    await expect(
      provider.isRepositoryRootAuthorized(currentRepositoryRoot),
    ).resolves.toBe(true);
    expect(selectRepository).toHaveBeenCalledWith({
      selectedRepositoryRoot: currentRepositoryRoot,
    });
  });

  it("rejects wrong roots, URI identity changes, and a mismatched document", async () => {
    const selectRepository = vi.fn(() => Promise.resolve(currentRepository));
    const provider = createHistoryRepositoryProvider({
      selectRepository,
    } as unknown as RepositoryDiscovery);

    await expect(
      provider.isRepositoryRootAuthorized(
        createTestUri("/workspace/other", "file", "workspace"),
      ),
    ).resolves.toBe(false);
    await expect(
      provider.isRepositoryRootAuthorized(
        createTestUri("/workspace/current", "file", "other-workspace"),
      ),
    ).resolves.toBe(false);
    await expect(
      provider.isRepositoryRootAuthorized(
        createTestUri("/workspace/current-link", "file", "workspace"),
      ),
    ).resolves.toBe(false);
    await expect(
      provider.isRepositoryRootAuthorized("/arbitrary/root"),
    ).resolves.toBe(false);
    await expect(
      provider.isRepositoryRootAuthorized(
        currentRepositoryRoot,
        createTestUri("/workspace/other/file.txt", "file", "workspace"),
      ),
    ).resolves.toBe(false);
  });

  it("fails closed for untrusted workspaces and non-file documents", async () => {
    const selectRepository = vi.fn(() => Promise.resolve(currentRepository));
    const provider = createHistoryRepositoryProvider({
      selectRepository,
    } as unknown as RepositoryDiscovery);

    vscodeTestState.workspaceTrusted = false;
    await expect(
      provider.isRepositoryRootAuthorized(currentRepositoryRoot),
    ).resolves.toBe(false);
    expect(selectRepository).not.toHaveBeenCalled();

    vscodeTestState.workspaceTrusted = true;
    await expect(
      provider.isRepositoryRootAuthorized(
        currentRepositoryRoot,
        createTestUri("/workspace/current/file.txt", "untitled", "workspace"),
      ),
    ).resolves.toBe(false);
  });

  it("fails closed for remote repository roots used by local Git history", async () => {
    const remoteRepositoryRoot = createTestUri(
      "/workspace/current",
      "vscode-remote",
      "ssh-remote+host",
    );
    const selectRepository = vi.fn(() =>
      Promise.resolve({ rootUri: remoteRepositoryRoot } as never),
    );
    const provider = createHistoryRepositoryProvider({
      selectRepository,
    } as unknown as RepositoryDiscovery);

    await expect(
      provider.resolveRepositoryRoot({ documentUri: remoteRepositoryRoot }),
    ).resolves.toBeUndefined();
    await expect(
      provider.isRepositoryRootAuthorized(remoteRepositoryRoot),
    ).resolves.toBe(false);
    await expect(
      provider.getRepositoryIdentity(remoteRepositoryRoot),
    ).resolves.toBeUndefined();
  });

  it("rejects remote roots for Operations Center and Commit Graph", () => {
    const remoteRepositoryRoot = createTestUri(
      "/workspace/current",
      "vscode-remote",
      "ssh-remote+host",
    );

    expect(() => assertOperationsRepositoryRoot(remoteRepositoryRoot)).toThrow(
      "remote workspaces are not supported",
    );
    expect(() => assertGraphRepositoryRoot(remoteRepositoryRoot)).toThrow(
      "remote workspaces are not supported",
    );
  });
});

describe("graph canonical repository binding", () => {
  it("uses the configured Git executable for graph root pinning", async () => {
    const repositoryPath = await mkdtemp(
      nodePath.join("/tmp", "gito-graph-configured-git-"),
    );
    const observedExecutablePaths: string[] = [];
    try {
      const pinnedRoot = await pinGraphRepositoryRoot(
        createTestUri(repositoryPath, "file", ""),
        createTestGraphRootBindingResolver(
          "/opt/vscode/configured-git",
          observedExecutablePaths,
        ),
      );

      expect(pinnedRoot.canonicalRootPath).toBe(await realpath(repositoryPath));
      expect(observedExecutablePaths).toEqual(["/opt/vscode/configured-git"]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it.each([
    ["branch", "refs/heads/main", false],
    ["remote", "refs/remotes/origin/main", true],
  ] as const)(
    "passes cancellation to %s checkout before mutation",
    async (_targetKind, referenceName, isRemoteBranch) => {
      const repositoryPath = await mkdtemp(
        nodePath.join("/tmp", "gito-graph-checkout-cancellation-"),
      );
      try {
        const repositoryRoot = createTestUri(repositoryPath, "file", "");
        const repository = {
          rootUri: repositoryRoot,
          state: {
            HEAD: { name: "main", commit: "" },
            refs: [],
            worktrees: [],
            mergeChanges: [],
            indexChanges: [],
            workingTreeChanges: [],
            untrackedChanges: [],
          },
        } as never;
        const repositoryDiscovery = {
          selectRepository: vi.fn(() => Promise.resolve(repository)),
          listRepositories: vi.fn(() => Promise.resolve([repository])),
        } as unknown as RepositoryDiscovery;
        const commitSha = "a".repeat(40);
        const graphCommandRunner = {
          run: vi.fn((request: { readonly arguments: readonly string[] }) => {
            const commandName = request.arguments[0];
            const standardOutput =
              commandName === "log"
                ? `${commitSha}\0\0main commit\0Graph Test\0graph@example.test\0date\0date\x01`
                : commandName === "for-each-ref"
                  ? `refs/heads/main\0${commitSha}\0\0\0\0\x01refs/remotes/origin/main\0${commitSha}\0\0\0\0\x01`
                  : commandName === "symbolic-ref"
                    ? "main\n"
                    : commandName === "worktree"
                      ? `worktree ${repositoryPath}\nHEAD ${commitSha}\nbranch refs/heads/main\n\n`
                      : "";
            return Promise.resolve({
              standardOutput,
              standardError: "",
              exitCode: 0,
            });
          }),
          runStreaming: vi.fn(() =>
            Promise.resolve({
              standardOutput: "",
              standardError: "",
              exitCode: 0,
            }),
          ),
        };
        const cancellationControllers: AbortController[] = [];
        const checkoutMutation = vi.fn();
        const checkoutBranch = vi.fn(
          (
            _branchName: string,
            _selectionContext: unknown,
            _isRemoteBranch: boolean,
            cancellationSignal?: AbortSignal,
          ) => {
            if (cancellationSignal?.aborted) {
              throw new DOMException("checkout cancelled", "AbortError");
            }
            checkoutMutation();
            return Promise.resolve();
          },
        );
        const workspaceTrustGuard = {
          runTrustedMutation: (
            _operationName: string,
            mutation: (checkpoint: () => void) => Promise<void>,
          ) =>
            mutation(() => {
              cancellationControllers.at(-1)?.abort();
            }),
        } as never;
        const session = createGraphSession(
          repositoryDiscovery,
          graphCommandRunner as never,
          {} as never,
          {} as never,
          {} as never,
          { checkoutBranch } as never,
          workspaceTrustGuard,
          {
            gitRootBindingResolver: createTestGraphRootBindingResolver(),
          },
        );
        const cancellationController = new AbortController();
        cancellationControllers.push(cancellationController);
        await expect(
          session.actions.checkoutReference(
            referenceName,
            cancellationController.signal,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(checkoutBranch).toHaveBeenCalledWith(
          isRemoteBranch ? "origin/main" : "main",
          expect.objectContaining({
            selectedRepositoryRoot: repositoryRoot,
            expectedRepository: repository,
          }),
          isRemoteBranch,
          cancellationController.signal,
        );
        expect(checkoutMutation).not.toHaveBeenCalled();
        session.dispose();
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );

  it("refreshes the panel and rejects stale commit actions after a repo switch", async () => {
    const parentDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-graph-stale-row-"),
    );
    const firstRepositoryPath = nodePath.join(parentDirectory, "first");
    const secondRepositoryPath = nodePath.join(parentDirectory, "second");
    await mkdir(firstRepositoryPath);
    await mkdir(secondRepositoryPath);
    const firstRepositoryRoot = createTestUri(firstRepositoryPath, "file", "");
    const secondRepositoryRoot = createTestUri(
      secondRepositoryPath,
      "file",
      "",
    );
    const firstCommitSha = "a".repeat(40);
    const firstParentSha = "b".repeat(40);
    const secondCommitSha = "c".repeat(40);
    const secondParentSha = "d".repeat(40);
    const repositoryState = {
      HEAD: { name: "main" },
      refs: [],
      worktrees: [],
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
    };
    const firstRepository = {
      rootUri: firstRepositoryRoot,
      state: repositoryState,
    } as never;
    const secondRepository = {
      rootUri: secondRepositoryRoot,
      state: repositoryState,
    } as never;
    let selectedRepository = firstRepository;
    const repositoryDiscovery = {
      selectRepository: vi.fn(() => Promise.resolve(selectedRepository)),
      listRepositories: vi.fn(() => Promise.resolve([selectedRepository])),
    } as unknown as RepositoryDiscovery;
    const graphCommandRunner = {
      run: vi.fn(
        (request: {
          readonly repositoryRoot: string;
          readonly arguments: readonly string[];
        }) => {
          const firstRepositorySelected =
            request.repositoryRoot === firstRepositoryPath;
          const commitSha = firstRepositorySelected
            ? firstCommitSha
            : secondCommitSha;
          const parentSha = firstRepositorySelected
            ? firstParentSha
            : secondParentSha;
          const commandName = request.arguments[0];
          const standardOutput =
            commandName === "log"
              ? `${commitSha}\0${parentSha}\0selected commit\0Graph Test\0graph@example.test\0date\0date\x01${parentSha}\0\0parent commit\0Graph Test\0graph@example.test\0date\0date\x01`
              : commandName === "for-each-ref"
                ? `refs/heads/main\0${commitSha}\0\0\0\0\x01`
                : commandName === "symbolic-ref"
                  ? "main\n"
                  : "";
          return Promise.resolve({
            standardOutput,
            standardError: "",
            exitCode: 0,
          });
        },
      ),
      runStreaming: vi.fn(() =>
        Promise.resolve({
          standardOutput: "",
          standardError: "",
          exitCode: 0,
        }),
      ),
    };
    const historySearch = vi.fn(() =>
      Promise.resolve({ matches: [{ sha: firstCommitSha }] }),
    );
    const createCommitVsParentPlan = vi.fn();
    const compare = vi.fn(() => Promise.resolve({ kind: "repository" }));
    const refreshPanel = vi.fn();
    const session = createGraphSession(
      repositoryDiscovery,
      graphCommandRunner as never,
      { search: historySearch } as never,
      { compare } as never,
      { createCommitVsParentPlan } as never,
      {} as never,
      {} as never,
      {
        gitRootBindingResolver: createTestGraphRootBindingResolver(),
        refreshPanel,
      },
    );

    try {
      await session.prepare();
      session.handleRepositoryStateChanged(firstRepository);
      expect(refreshPanel).toHaveBeenCalledTimes(1);
      selectedRepository = secondRepository;
      await session.prepare();
      expect(refreshPanel).toHaveBeenCalledTimes(2);

      await expect(
        session.actions.openCommit(
          firstCommitSha,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/no longer loaded/iu);
      await expect(
        session.actions.openDiff(firstCommitSha, new AbortController().signal),
      ).rejects.toThrow(/no longer loaded/iu);
      await expect(
        session.actions.compareWithParent(
          firstCommitSha,
          new AbortController().signal,
          firstParentSha,
        ),
      ).rejects.toThrow(/no longer loaded/iu);
      expect(historySearch).not.toHaveBeenCalled();
      expect(createCommitVsParentPlan).not.toHaveBeenCalled();
      expect(compare).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  it("invalidates graph data from a modern state event when refs is empty", async () => {
    const repositoryPath = await mkdtemp(
      nodePath.join("/tmp", "gito-graph-modern-state-"),
    );
    const repositoryRoot = createTestUri(repositoryPath, "file", "");
    const firstCommitSha = "a".repeat(40);
    const secondCommitSha = "b".repeat(40);
    let loadedCommitSha = firstCommitSha;
    const repository = {
      rootUri: repositoryRoot,
      state: {
        HEAD: { name: "main", commit: firstCommitSha },
        refs: [],
        remotes: [],
        worktrees: [],
        rebaseCommit: undefined,
        mergeChanges: [],
        indexChanges: [],
        workingTreeChanges: [],
        untrackedChanges: [],
        onDidChange: vi.fn(),
      },
    } as never;
    const repositoryDiscovery = {
      selectRepository: vi.fn(() => Promise.resolve(repository)),
      listRepositories: vi.fn(() => Promise.resolve([repository])),
    } as unknown as RepositoryDiscovery;
    const graphCommandRunner = {
      run: vi.fn((request: { readonly arguments: readonly string[] }) => {
        const commandName = request.arguments[0];
        const standardOutput =
          commandName === "log"
            ? `${loadedCommitSha}\0\0modern state\0Graph Test\0graph@example.test\0date\0date\x01`
            : commandName === "for-each-ref"
              ? `refs/heads/main\0${loadedCommitSha}\0\0\0\0\x01`
              : commandName === "symbolic-ref"
                ? "main\n"
                : "";
        return Promise.resolve({
          standardOutput,
          standardError: "",
          exitCode: 0,
        });
      }),
      runStreaming: vi.fn(() =>
        Promise.resolve({
          standardOutput: "",
          standardError: "",
          exitCode: 0,
        }),
      ),
    };
    const session = createGraphSession(
      repositoryDiscovery,
      graphCommandRunner as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { gitRootBindingResolver: createTestGraphRootBindingResolver() },
    );
    const pageRequest = {
      pageSize: 10,
      filter: { scope: "all" as const },
      includeWip: false,
      includeWorktrees: false,
    };

    try {
      const firstPage = await session.dataSource.queryPage(
        pageRequest,
        new AbortController().signal,
      );
      expect(firstPage.rows[0]).toMatchObject({
        kind: "commit",
        commitSha: firstCommitSha,
      });
      loadedCommitSha = secondCommitSha;
      session.handleRepositoryStateChanged(repository);
      const secondPage = await session.dataSource.queryPage(
        pageRequest,
        new AbortController().signal,
      );
      expect(secondPage.rows[0]).toMatchObject({
        kind: "commit",
        commitSha: secondCommitSha,
      });
      expect(
        graphCommandRunner.run.mock.calls.filter(
          ([request]) => request.arguments[0] === "log",
        ),
      ).toHaveLength(2);
    } finally {
      session.dispose();
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a root pin that completes after graph disposal", async () => {
    let resolvePinStarted: () => void = () => undefined;
    const pinStarted = new Promise<void>((resolve) => {
      resolvePinStarted = resolve;
    });
    let resolvePinCompleted: (
      pinnedRoot: PinnedGraphRepositoryRoot,
    ) => void = () => undefined;
    const pinCompleted = new Promise<PinnedGraphRepositoryRoot>((resolve) => {
      resolvePinCompleted = resolve;
    });
    const repository = {
      rootUri: currentRepositoryRoot,
      state: { HEAD: { name: "main" } },
    } as never;
    const repositoryDiscovery = {
      listRepositories: vi.fn(() => Promise.resolve([repository])),
      selectRepository: vi.fn(() => Promise.resolve(repository)),
    } as unknown as RepositoryDiscovery;
    const session = createGraphSession(
      repositoryDiscovery,
      { run: vi.fn(), runStreaming: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        pinGraphRepositoryRoot: () => {
          resolvePinStarted();
          return pinCompleted;
        },
      },
    );

    const preparation = session.prepare();
    await pinStarted;
    session.dispose();
    resolvePinCompleted({
      requestedRootPath: currentRepositoryRoot.fsPath,
      canonicalRootPath: currentRepositoryRoot.fsPath,
      deviceAndInodeKey: "1:1",
      rootBindingIdentity: {
        canonicalPath: currentRepositoryRoot.fsPath,
        device: "1",
        inode: "1",
        gitDirectory: {
          canonicalPath: currentRepositoryRoot.fsPath,
          device: "1",
          inode: "1",
        },
        commonDirectory: {
          canonicalPath: currentRepositoryRoot.fsPath,
          device: "1",
          inode: "1",
        },
      },
      uri: currentRepositoryRoot,
    });

    await expect(preparation).rejects.toThrow(
      "The commit graph session has been disposed.",
    );
  });

  it("rejects a symlink retarget after the graph root is pinned", async () => {
    const parentDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-graph-root-retarget-"),
    );
    const firstRepositoryPath = nodePath.join(parentDirectory, "first");
    const secondRepositoryPath = nodePath.join(parentDirectory, "second");
    const linkedRepositoryPath = nodePath.join(parentDirectory, "current");
    await mkdir(firstRepositoryPath);
    await mkdir(secondRepositoryPath);
    await symlink(firstRepositoryPath, linkedRepositoryPath);
    try {
      const pinnedRoot = await pinGraphRepositoryRoot(
        createTestUri(linkedRepositoryPath, "file", ""),
        createTestGraphRootBindingResolver(),
      );
      expect(pinnedRoot.canonicalRootPath).toBe(
        await realpath(firstRepositoryPath),
      );

      await rm(linkedRepositoryPath);
      await symlink(secondRepositoryPath, linkedRepositoryPath);

      await expect(
        isPinnedGraphRepositoryRootCurrent(pinnedRoot),
      ).resolves.toBe(false);
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  it("rejects same-path directory replacement after the graph root is pinned", async () => {
    const parentDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-graph-root-replacement-"),
    );
    const repositoryPath = nodePath.join(parentDirectory, "repository");
    await mkdir(repositoryPath);
    try {
      const pinnedRoot = await pinGraphRepositoryRoot(
        createTestUri(repositoryPath, "file", ""),
        createTestGraphRootBindingResolver(),
      );
      await rm(repositoryPath, { recursive: true });
      await mkdir(repositoryPath);

      await expect(
        isPinnedGraphRepositoryRootCurrent(pinnedRoot),
      ).resolves.toBe(false);
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });
});
