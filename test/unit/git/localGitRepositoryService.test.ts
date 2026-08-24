// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

const vscodeTestState = vi.hoisted(() => ({ workspaceTrusted: true }));

vi.mock("vscode", () => {
  class Uri {
    public readonly scheme = "file";
    public readonly path: string;

    public constructor(public readonly fsPath: string) {
      this.path = fsPath;
    }

    public static file(filePath: string): Uri {
      return new Uri(filePath.startsWith("/") ? filePath : `/${filePath}`);
    }

    public with(changes: { readonly path?: string }): Uri {
      return new Uri(changes.path ?? this.fsPath);
    }

    public toString(): string {
      return `file://${this.fsPath}`;
    }
  }
  return {
    Disposable: class {
      public dispose(): void {}
    },
    Uri,
    commands: { executeCommand: vi.fn(async () => undefined) },
    workspace: {
      get isTrusted(): boolean {
        return vscodeTestState.workspaceTrusted;
      },
    },
    window: {
      activeTextEditor: undefined,
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showQuickPick: vi.fn(async () => undefined),
    },
  };
});

import * as vscode from "vscode";
import { LocalGitRepositoryService } from "../../../src/extension/git/localGitRepositoryService.js";
import type { GitRootBindingIdentity } from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import { createLocalGitChange } from "../../../src/extension/git/localGitModels.js";
import {
  Status,
  type VscodeGitBranchQuery,
} from "../../../src/extension/git/vscodeGitApi.js";

describe("LocalGitRepositoryService", () => {
  beforeEach(() => {
    vscodeTestState.workspaceTrusted = true;
  });

  it("refreshes bundled Git status before reading change groups", async () => {
    const repository = createRepository();
    const service = createService(repository);

    await service.getChangesSnapshot(
      {
        selectedRepositoryRoot: repository.rootUri,
      },
      { refreshStatus: true },
    );

    expect(repository.status).toHaveBeenCalledTimes(1);
  });

  it("fails closed when bundled Git status refresh fails", async () => {
    const repository = createRepository();
    repository.status.mockRejectedValueOnce(new Error("status unavailable"));
    const service = createService(repository);

    await expect(
      service.getChangesSnapshot(
        { selectedRepositoryRoot: repository.rootUri },
        { refreshStatus: true },
      ),
    ).rejects.toThrow("status unavailable");
  });

  it("reuses the current Git state when health refresh is disabled", async () => {
    const repository = createRepository();
    const service = createService(repository);

    await service.getRepositoryHealth(
      { selectedRepositoryRoot: repository.rootUri },
      { refreshStatus: false },
    );

    expect(repository.status).not.toHaveBeenCalled();
  });

  it("refreshes Git status for health by default", async () => {
    const repository = createRepository();
    const service = createService(repository);

    await service.getRepositoryHealth({
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(repository.status).toHaveBeenCalledTimes(1);
  });

  it("checks out a remote branch as a local tracking branch", async () => {
    const repository = createRepository();
    const service = createService(repository);

    await service.checkoutBranch(
      "origin/feature/new-ui",
      { selectedRepositoryRoot: repository.rootUri },
      true,
    );

    expect(repository.createBranch).toHaveBeenCalledWith(
      "feature/new-ui",
      true,
      "origin/feature/new-ui",
    );
    expect(repository.checkout).not.toHaveBeenCalled();
  });

  it("cancels checkout before repository selection", async () => {
    const repository = createRepository();
    const cancellationController = new AbortController();
    cancellationController.abort();
    const selectRepository = vi.fn(async () => repository);
    const service = new LocalGitRepositoryService(
      { selectRepository },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      createTestRootBindingResolver(),
    );

    await expect(
      service.checkoutBranch(
        "feature",
        undefined,
        false,
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(selectRepository).not.toHaveBeenCalled();
    expect(repository.checkout).not.toHaveBeenCalled();
  });

  it("cancels checkout after root binding and before the API mutation", async () => {
    const repository = createRepository();
    const cancellationController = new AbortController();
    const stableBindingResolver = createTestRootBindingResolver();
    const bindingResolver = vi.fn(
      async (...argumentsPassed: Parameters<typeof stableBindingResolver>) => {
        const binding = await stableBindingResolver(...argumentsPassed);
        if (argumentsPassed[1] === undefined) cancellationController.abort();
        return binding;
      },
    );
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      bindingResolver,
    );

    await expect(
      service.checkoutBranch(
        "feature",
        undefined,
        false,
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(repository.checkout).not.toHaveBeenCalled();
  });

  it("checks cancellation after checkout API mutation", async () => {
    const repository = createRepository();
    const cancellationController = new AbortController();
    repository.checkout.mockImplementation(async () => {
      cancellationController.abort();
    });
    const service = createService(repository);

    await expect(
      service.checkoutBranch(
        "feature",
        undefined,
        false,
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(repository.checkout).toHaveBeenCalledWith("feature");
  });

  it("rejects checkout when the expected repository object was replaced", async () => {
    const originalRepository = createRepository();
    const replacementRepository = createRepository();
    const repositoryDiscovery = {
      selectRepository: vi.fn(
        async (selectionContext?: {
          readonly expectedRepository?: typeof originalRepository;
        }) => {
          if (
            selectionContext?.expectedRepository === undefined ||
            selectionContext.expectedRepository === originalRepository
          ) {
            throw new Error("selected Git repository changed");
          }
          return replacementRepository;
        },
      ),
    };
    const service = new LocalGitRepositoryService(
      repositoryDiscovery,
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      createTestRootBindingResolver(),
    );

    await expect(
      service.checkoutBranch("feature/new-ui", {
        selectedRepositoryRoot: originalRepository.rootUri,
        expectedRepository: originalRepository,
      }),
    ).rejects.toThrow("selected Git repository changed");
    expect(replacementRepository.checkout).not.toHaveBeenCalled();
  });

  it("uses the configured Git executable for file-root binding checks", async () => {
    const repository = createRepository();
    const observedExecutablePaths: string[] = [];
    const configuredRootResolver = new GitRootBindingResolver(
      async () => "/opt/vscode/git",
      {
        resolveRootBinding: async (
          repositoryRootPath,
          expectedIdentity,
          resolutionOptions,
        ) => {
          observedExecutablePaths.push(
            resolutionOptions?.gitExecutablePath ?? "",
          );
          return createTestRootBindingResolver()(
            repositoryRootPath,
            expectedIdentity,
          );
        },
      },
    );
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      configuredRootResolver.resolve.bind(configuredRootResolver),
    );

    await service.checkoutBranch("feature", {
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(observedExecutablePaths).toEqual([
      "/opt/vscode/git",
      "/opt/vscode/git",
      "/opt/vscode/git",
    ]);
  });

  it("rejects remote branch deletion and lists remote-only refs", async () => {
    const repository = createRepository();
    const service = createService(repository);

    await expect(
      service.deleteBranch("origin/main", {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("Remote branches cannot be deleted");
    const branches = await service.listBranches({
      selectedRepositoryRoot: repository.rootUri,
    });
    expect(branches.map((branch) => branch.name)).toEqual([
      "main",
      "origin/main",
    ]);
    expect(repository.getBranches).toHaveBeenCalledWith({ remote: true });
  });

  it("rejects outside-root and traversal change paths before mutation", async () => {
    const repository = createRepository();
    const service = createService(repository);
    const outsideChange = {
      group: "changes",
      status: 6,
      resourceUri: vscode.Uri.file("/repo/../other/.env"),
      relativePath: "../other/.env",
      statusLabel: "Modified",
    } as never;

    await expect(
      service.stageChanges([outsideChange], {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("another repository");
    expect(repository.add).not.toHaveBeenCalled();
  });

  it("models the public Git adapter rejecting a relative mutation path", async () => {
    const repository = createRepository();

    await expect(repository.add(["change.txt"])).rejects.toThrow(
      "outside repository: /change.txt",
    );
  });

  it("accepts tracked symlink leaves for local mutations", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-symlink-leaf-"),
    );
    const outsideRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-symlink-target-"),
    );
    try {
      const symlinkPath = nodePath.join(repositoryRoot, "tracked-link.txt");
      const targetPath = nodePath.join(outsideRoot, "target.txt");
      await writeFile(targetPath, "outside\n");
      await symlink(targetPath, symlinkPath);
      const repository = createRepository(repositoryRoot);
      (
        repository.state as {
          workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        }
      ).workingTreeChanges = [
        createResourceState(symlinkPath, Status.MODIFIED),
      ];
      const service = createService(repository);

      await service.stageChanges(
        [
          createLocalChangeForTest(
            repository.rootUri,
            symlinkPath,
            Status.MODIFIED,
          ),
        ],
        { selectedRepositoryRoot: repository.rootUri },
      );

      expect(repository.add).toHaveBeenCalledWith([symlinkPath]);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("stages real untracked files without staging ignored files", async () => {
    const repository = createRepository();
    (
      repository.state as {
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/new.txt", 7),
      createResourceState("/repo/ignored.local", 8),
    ];
    const service = createService(repository);

    await service.stageAll({ selectedRepositoryRoot: repository.rootUri });

    expect(repository.add).toHaveBeenCalledWith(["/repo/new.txt"]);
  });

  it("preserves an aliased repository resource path at the mutation boundary", async () => {
    const fixtureRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-aliased-repository-"),
    );
    try {
      const canonicalRepositoryRoot = nodePath.join(fixtureRoot, "private");
      const aliasedRepositoryRoot = nodePath.join(fixtureRoot, "var");
      await mkdir(canonicalRepositoryRoot);
      await symlink(canonicalRepositoryRoot, aliasedRepositoryRoot, "dir");
      const aliasedResourcePath = nodePath.join(
        aliasedRepositoryRoot,
        "change.txt",
      );
      await writeFile(aliasedResourcePath, "change\n");
      const repository = createRepository(aliasedRepositoryRoot);
      (
        repository.state as {
          untrackedChanges: readonly ReturnType<typeof createResourceState>[];
        }
      ).untrackedChanges = [
        createResourceState(aliasedResourcePath, Status.UNTRACKED),
      ];
      const service = createService(repository);

      await service.stageAll({ selectedRepositoryRoot: repository.rootUri });

      expect(repository.add).toHaveBeenCalledWith([aliasedResourcePath]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("stages changes when bundled Git recreates the repository wrapper", async () => {
    const repository = createRepository();
    const refreshedRepository = createRepository();
    (
      repository.state as {
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/new.txt", Status.UNTRACKED),
    ];
    (
      refreshedRepository.state as {
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/new.txt", Status.UNTRACKED),
    ];
    const selectRepository = vi.fn(
      async (selectionContext?: {
        readonly expectedRepository?: typeof repository;
      }) =>
        selectionContext?.expectedRepository === undefined
          ? repository
          : refreshedRepository,
    );
    const service = new LocalGitRepositoryService(
      { selectRepository },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      createTestRootBindingResolver(),
    );

    await service.stageAll({ selectedRepositoryRoot: repository.rootUri });

    expect(repository.add).toHaveBeenCalledWith(["/repo/new.txt"]);
    expect(refreshedRepository.add).not.toHaveBeenCalled();
  });

  it("unstages selected and all changes with absolute filesystem paths", async () => {
    const repository = createRepository();
    (
      repository.state as {
        indexChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).indexChanges = [
      createResourceState("/repo/selected.txt", Status.INDEX_MODIFIED),
      createResourceState("/repo/all.txt", Status.INDEX_ADDED),
    ];
    const service = createService(repository);
    const snapshot = await service.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
    });

    await service.unstageChanges([snapshot.stagedChanges[0]!], {
      selectedRepositoryRoot: repository.rootUri,
    });
    expect(repository.restore).toHaveBeenNthCalledWith(
      1,
      ["/repo/selected.txt"],
      { staged: true },
    );

    await service.unstageAll({ selectedRepositoryRoot: repository.rootUri });
    expect(repository.restore).toHaveBeenNthCalledWith(
      2,
      ["/repo/selected.txt", "/repo/all.txt"],
      { staged: true },
    );
  });

  it("smart-commits by staging absolute filesystem paths first", async () => {
    const repository = createRepository();
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      createResourceState("/repo/modified.txt", Status.MODIFIED),
    ];
    (
      repository.state as {
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/new.txt", Status.UNTRACKED),
    ];
    const service = createService(repository);

    await service.commitStagedChanges("  smart commit  ", true, {
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(repository.add).toHaveBeenCalledWith([
      "/repo/modified.txt",
      "/repo/new.txt",
    ]);
    expect(repository.commit).toHaveBeenCalledWith("smart commit");
  });

  it("preserves official tracked/deleted and untracked/ignored status groups", async () => {
    const repository = createRepository();
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      createResourceState("/repo/modified.txt", Status.MODIFIED),
      createResourceState("/repo/deleted.txt", Status.DELETED),
    ];
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/new.txt", Status.UNTRACKED),
      createResourceState("/repo/ignored.local", Status.IGNORED),
    ];
    const service = createService(repository);

    const snapshot = await service.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(snapshot.changes.map((change) => change.status)).toEqual([
      Status.MODIFIED,
      Status.DELETED,
    ]);
    expect(snapshot.untracked.map((change) => change.status)).toEqual([
      Status.UNTRACKED,
      Status.IGNORED,
    ]);
  });

  it("normalizes mixed-mode untracked resources into the untracked group", async () => {
    const repository = createRepository();
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      createResourceState("/repo/mixed-untracked.txt", Status.UNTRACKED),
      createResourceState("/repo/modified.txt", Status.MODIFIED),
    ];
    const service = createService(repository);

    const snapshot = await service.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(snapshot.changes.map((change) => change.relativePath)).toEqual([
      "modified.txt",
    ]);
    expect(snapshot.untracked.map((change) => change.relativePath)).toEqual([
      "mixed-untracked.txt",
    ]);
  });

  it("deduplicates untracked resources reported by both Git status groups", async () => {
    const repository = createRepository();
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/first.txt", Status.UNTRACKED),
      createResourceState("/repo/ignored.local", Status.IGNORED),
    ];
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      createResourceState("/repo/first.txt", Status.UNTRACKED),
      createResourceState("/repo/second.txt", Status.UNTRACKED),
      createResourceState("/repo/modified.txt", Status.MODIFIED),
    ];
    const service = createService(repository);

    const snapshot = await service.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(
      snapshot.untracked.map((change) => [change.relativePath, change.status]),
    ).toEqual([
      ["first.txt", Status.UNTRACKED],
      ["ignored.local", Status.IGNORED],
      ["second.txt", Status.UNTRACKED],
    ]);
    expect(snapshot.changes.map((change) => change.relativePath)).toEqual([
      "modified.txt",
    ]);
    expect(snapshot.totalChangeCount).toBe(4);
  });

  it.runIf(process.platform !== "win32")(
    "keeps POSIX backslashes distinct from directory separators",
    async () => {
      const repository = createRepository();
      (
        repository.state as {
          untrackedChanges: readonly ReturnType<typeof createResourceState>[];
        }
      ).untrackedChanges = [
        createResourceState("/repo/folder\\file.txt", Status.UNTRACKED),
        createResourceState("/repo/folder/file.txt", Status.UNTRACKED),
      ];
      const service = createService(repository);

      const snapshot = await service.getChangesSnapshot({
        selectedRepositoryRoot: repository.rootUri,
      });

      expect(snapshot.untracked.map((change) => change.relativePath)).toEqual([
        "folder\\file.txt",
        "folder/file.txt",
      ]);
    },
  );

  it("prefers actionable untracked status over ignored duplicates", async () => {
    const repository = createRepository();
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        untrackedChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).untrackedChanges = [
      createResourceState("/repo/generated.txt", Status.IGNORED),
    ];
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      createResourceState("/repo/generated.txt", Status.UNTRACKED),
    ];
    const service = createService(repository);

    const snapshot = await service.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
    });

    expect(snapshot.untracked).toHaveLength(1);
    expect(snapshot.untracked[0]?.status).toBe(Status.UNTRACKED);
  });

  it("rejects discard when selected file content changes during confirmation", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-discard-safety-"),
    );
    try {
      const changedFilePath = nodePath.join(repositoryRoot, "changed.txt");
      await writeFile(changedFilePath, "before\n");
      const repository = createRepository(repositoryRoot);
      (
        repository.state as {
          workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
        }
      ).workingTreeChanges = [
        createResourceState(changedFilePath, Status.MODIFIED),
      ];
      const service = new LocalGitRepositoryService(
        { selectRepository: vi.fn(async () => repository) },
        createWorkspaceTrustGuard(),
        { execute: vi.fn(async () => undefined) },
        {
          confirm: vi.fn(async () => {
            await writeFile(changedFilePath, "after\n");
            return true;
          }),
          confirmSmartCommit: vi.fn(async () => true),
        },
        createTestRootBindingResolver(),
      );

      await expect(
        service.discardChanges(
          [
            {
              ...createLocalChangeForTest(
                repository.rootUri,
                changedFilePath,
                Status.MODIFIED,
              ),
            },
          ],
          { selectedRepositoryRoot: repository.rootUri },
        ),
      ).rejects.toThrow("files changed while confirmation was open");
      expect(repository.restore).not.toHaveBeenCalled();
      expect(repository.clean).not.toHaveBeenCalled();
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("discards tracked and untracked changes with absolute filesystem paths", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-discard-paths-"),
    );
    try {
      const trackedFilePath = nodePath.join(repositoryRoot, "tracked.txt");
      const untrackedFilePath = nodePath.join(repositoryRoot, "untracked.txt");
      await writeFile(trackedFilePath, "tracked\n");
      await writeFile(untrackedFilePath, "untracked\n");
      const repository = createRepository(repositoryRoot);
      (
        repository.state as {
          workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
          untrackedChanges: readonly ReturnType<typeof createResourceState>[];
        }
      ).workingTreeChanges = [
        createResourceState(trackedFilePath, Status.MODIFIED),
      ];
      (
        repository.state as {
          untrackedChanges: readonly ReturnType<typeof createResourceState>[];
        }
      ).untrackedChanges = [
        createResourceState(untrackedFilePath, Status.UNTRACKED),
      ];
      const service = createService(repository);
      const snapshot = await service.getChangesSnapshot({
        selectedRepositoryRoot: repository.rootUri,
      });

      await service.discardChanges(
        [...snapshot.changes, ...snapshot.untracked],
        { selectedRepositoryRoot: repository.rootUri },
      );

      expect(repository.restore).toHaveBeenCalledWith([trackedFilePath]);
      expect(repository.clean).toHaveBeenCalledWith([untrackedFilePath]);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("keeps health HEAD and changes on the same repository generation", async () => {
    const originalRepository = createRepository();
    const replacementRepository = createRepository();
    replacementRepository.state.HEAD = { type: 0, name: "replacement" };
    (
      replacementRepository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      createResourceState("/repo/replacement.txt", Status.MODIFIED),
    ];
    let selectionCount = 0;
    const repositoryDiscovery = {
      selectRepository: vi.fn(
        async (selectionContext?: {
          readonly expectedRepository?: typeof originalRepository;
        }) => {
          selectionCount += 1;
          if (selectionCount === 1) return originalRepository;
          return selectionContext?.expectedRepository === originalRepository
            ? originalRepository
            : replacementRepository;
        },
      ),
    };
    const service = new LocalGitRepositoryService(
      repositoryDiscovery,
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      createTestRootBindingResolver(),
    );

    await expect(service.getRepositoryHealth()).resolves.toMatchObject({
      branchName: "main",
      uncommittedChangeCount: 0,
    });
    expect(repositoryDiscovery.selectRepository).toHaveBeenNthCalledWith(2, {
      selectedRepositoryRoot: originalRepository.rootUri,
      expectedRepository: originalRepository,
    });
  });

  it("validates the selected resource against the selected repository root", async () => {
    const repository = createRepository();
    const nativeCommandExecutor = { execute: vi.fn(async () => undefined) };
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      nativeCommandExecutor,
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      createTestRootBindingResolver(),
    );

    await expect(
      service.openNativeDiff(vscode.Uri.file("/other-repo/file.txt"), {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("another repository");
    expect(nativeCommandExecutor.execute).not.toHaveBeenCalled();
  });

  it("accepts tracked symlink leaves for native diffs", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-native-diff-leaf-"),
    );
    const outsideRoot = await mkdtemp(
      nodePath.join(tmpdir(), "gito-native-diff-target-"),
    );
    try {
      const symlinkPath = nodePath.join(repositoryRoot, "tracked-link.txt");
      const targetPath = nodePath.join(outsideRoot, "target.txt");
      await writeFile(targetPath, "outside\n");
      await symlink(targetPath, symlinkPath);
      const repository = createRepository(repositoryRoot);
      const nativeCommandExecutor = {
        execute: vi.fn(async () => undefined),
      };
      const service = new LocalGitRepositoryService(
        { selectRepository: vi.fn(async () => repository) },
        createWorkspaceTrustGuard(),
        nativeCommandExecutor,
        {
          confirm: vi.fn(async () => true),
          confirmSmartCommit: vi.fn(async () => true),
        },
        createTestRootBindingResolver(),
      );

      await service.openNativeDiff(vscode.Uri.file(symlinkPath), {
        selectedRepositoryRoot: repository.rootUri,
      });

      expect(nativeCommandExecutor.execute).toHaveBeenCalledWith(
        "git.openChange",
        expect.objectContaining({ fsPath: symlinkPath }),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("returns the official main worktree root from a linked worktree", async () => {
    const repository = createRepository("/repo/linked");
    (
      repository.state as {
        worktrees: readonly {
          name: string;
          path: string;
          ref: string;
          main: boolean;
          detached: boolean;
        }[];
      }
    ).worktrees = [
      {
        name: "main",
        path: "/repo",
        ref: "refs/heads/main",
        main: true,
        detached: false,
      },
      {
        name: "linked",
        path: "/repo/linked",
        ref: "refs/heads/feature",
        main: false,
        detached: false,
      },
    ];
    const service = createService(repository);

    await expect(
      service.getRepositoryRoot({ selectedRepositoryRoot: repository.rootUri }),
    ).resolves.toEqual(vscode.Uri.file("/repo"));
  });

  it("preserves the selected API URI metadata while resolving a linked main worktree", async () => {
    const repository = createRepository("/repo/linked");
    interface RemoteApiRoot {
      readonly scheme: string;
      readonly authority: string;
      readonly fsPath: string;
      readonly path: string;
      with(change: { readonly path?: string }): RemoteApiRoot;
      toString(): string;
    }
    const remoteRoot: RemoteApiRoot = {
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
      fsPath: "/repo/linked",
      path: "/repo/linked",
      with(change: { readonly path?: string }): RemoteApiRoot {
        return {
          ...this,
          fsPath: change.path ?? this.fsPath,
          path: change.path ?? this.path,
        };
      },
      toString: () => "vscode-remote://ssh-remote+host/repo/linked",
    };
    (repository as { rootUri: vscode.Uri }).rootUri =
      remoteRoot as unknown as vscode.Uri;
    (
      repository.state as {
        worktrees: readonly {
          name: string;
          path: string;
          ref: string;
          main: boolean;
          detached: boolean;
        }[];
      }
    ).worktrees = [
      {
        name: "main",
        path: "/repo",
        ref: "refs/heads/main",
        main: true,
        detached: false,
      },
    ];

    const service = createService(repository);
    const resolvedRoot = await service.getRepositoryRoot({
      selectedRepositoryRoot: remoteRoot as unknown as vscode.Uri,
    });

    expect(resolvedRoot.scheme).toBe("vscode-remote");
    expect(resolvedRoot.authority).toBe("ssh-remote+host");
    expect(resolvedRoot.fsPath).toBe("/repo");
  });

  it("uses bundled Git API mutations for remote extension-host URIs", async () => {
    const repository = createRepository("/repo/linked");
    const remoteRoot = {
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
      fsPath: "/repo/linked",
      path: "/repo/linked",
      with(change: { readonly path?: string }) {
        const nextPath = change.path ?? "/repo/linked";
        return { ...this, fsPath: nextPath, path: nextPath };
      },
      toString: () => "vscode-remote://ssh-remote+host/repo/linked",
    } as unknown as vscode.Uri;
    (repository as { rootUri: vscode.Uri }).rootUri = remoteRoot;
    (
      repository.state as {
        workingTreeChanges: readonly ReturnType<typeof createResourceState>[];
      }
    ).workingTreeChanges = [
      {
        uri: remoteRoot.with({ path: "/repo/linked/remote.txt" }),
        originalUri: remoteRoot.with({ path: "/repo/linked/remote.txt" }),
        renameUri: undefined,
        status: Status.MODIFIED,
      },
    ];
    const rootBindingResolver = vi.fn(createTestRootBindingResolver());
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      rootBindingResolver,
    );

    await service.stageAll({ selectedRepositoryRoot: remoteRoot });

    expect(repository.add).toHaveBeenCalledWith(["/repo/linked/remote.txt"]);
    expect(rootBindingResolver).not.toHaveBeenCalled();
  });

  it("fails closed when a branch OID is unavailable", async () => {
    const repository = createRepository();
    const missingOidBranchRefs = [
      { name: "feature", type: 0, commit: undefined },
    ] as never;
    repository.getBranches.mockImplementation(async (query) =>
      query.remote
        ? [{ name: "origin/feature", type: 1, commit: "remote-sha" }]
        : missingOidBranchRefs,
    );
    const confirm = vi.fn(async () => true);
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      { confirm, confirmSmartCommit: vi.fn(async () => true) },
      createTestRootBindingResolver(),
    );

    await expect(
      service.deleteBranch("feature", {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("did not provide the selected branch commit");
    expect(confirm).not.toHaveBeenCalled();
    expect(repository.deleteBranch).not.toHaveBeenCalled();
  });

  it("rejects a branch whose OID changed before confirmation", async () => {
    const repository = createRepository();
    repository.getBranches.mockImplementation(async (query) =>
      query.remote
        ? [{ name: "origin/feature", type: 1, commit: "remote-sha" }]
        : [{ name: "feature", type: 0, commit: "current-sha" }],
    );
    const confirm = vi.fn(async () => true);
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      { confirm, confirmSmartCommit: vi.fn(async () => true) },
      createTestRootBindingResolver(),
    );

    await expect(
      service.deleteBranch(
        "feature",
        { selectedRepositoryRoot: repository.rootUri },
        { branchName: "feature", branchCommit: "stale-sha" },
      ),
    ).rejects.toThrow("changed before confirmation");
    expect(confirm).not.toHaveBeenCalled();
    expect(repository.deleteBranch).not.toHaveBeenCalled();
  });

  it("rechecks workspace trust after branch deletion confirmation", async () => {
    const repository = createRepository();
    repository.getBranches.mockImplementation(async (query) =>
      query.remote
        ? [{ name: "origin/feature", type: 1, commit: "remote-sha" }]
        : [{ name: "feature", type: 0, commit: "local-sha" }],
    );
    const confirm = vi.fn(async () => {
      vscodeTestState.workspaceTrusted = false;
      return true;
    });
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      { confirm, confirmSmartCommit: vi.fn(async () => true) },
      createTestRootBindingResolver(),
    );

    await expect(
      service.deleteBranch("feature", {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("untrusted workspace");
    expect(repository.deleteBranch).not.toHaveBeenCalled();
  });

  it("fails closed when workspace trust is unavailable", async () => {
    const repository = createRepository();
    repository.getBranches.mockImplementation(async (query) =>
      query.remote
        ? [{ name: "origin/feature", type: 1, commit: "remote-sha" }]
        : [{ name: "feature", type: 0, commit: "local-sha" }],
    );
    vscodeTestState.workspaceTrusted = false;
    const service = createService(repository);

    await expect(
      service.deleteBranch("feature", {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("untrusted workspace");
    expect(repository.deleteBranch).not.toHaveBeenCalled();
  });

  it("rejects a repository retarget detected after bundled Git mutation", async () => {
    const repository = createRepository();
    const stableBinding = createTestRootBindingResolver();
    const bindingResolver = vi.fn(stableBinding);
    let expectedBindingResolutionCount = 0;
    bindingResolver.mockImplementation(
      async (repositoryRootPath, expectedIdentity) => {
        const binding = await stableBinding(
          repositoryRootPath,
          expectedIdentity,
        );
        return expectedIdentity === undefined
          ? binding
          : ++expectedBindingResolutionCount === 2
            ? (() => {
                throw new Error("retargeted-inode");
              })()
            : binding;
      },
    );
    const service = new LocalGitRepositoryService(
      { selectRepository: vi.fn(async () => repository) },
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      bindingResolver,
    );

    await expect(
      service.checkoutBranch("feature", {
        selectedRepositoryRoot: repository.rootUri,
      }),
    ).rejects.toThrow("repository identity changed");
    expect(repository.checkout).toHaveBeenCalledWith("feature");
    expect(bindingResolver).toHaveBeenCalledTimes(3);
  });
});

function createService(repository: ReturnType<typeof createRepository>) {
  return new LocalGitRepositoryService(
    {
      selectRepository: vi.fn(async () => repository),
    },
    createWorkspaceTrustGuard(),
    { execute: vi.fn(async () => undefined) },
    {
      confirm: vi.fn(async () => true),
      confirmSmartCommit: vi.fn(async () => true),
    },
    createTestRootBindingResolver(),
  );
}

function createTestRootBindingResolver() {
  return async (
    repositoryRootPath: string,
    expectedIdentity?: GitRootBindingIdentity,
  ): Promise<GitRootBindingIdentity> => {
    const binding = {
      canonicalPath: repositoryRootPath,
      device: "test-device",
      inode: "test-inode",
      gitDirectory: {
        canonicalPath: `${repositoryRootPath}/.git`,
        device: "test-git-device",
        inode: "test-git-inode",
      },
      commonDirectory: {
        canonicalPath: `${repositoryRootPath}/.git`,
        device: "test-common-device",
        inode: "test-common-inode",
      },
    } satisfies GitRootBindingIdentity;
    if (expectedIdentity !== undefined) {
      return {
        ...binding,
        canonicalPath: expectedIdentity.canonicalPath,
        device: expectedIdentity.device,
        inode: expectedIdentity.inode,
        gitDirectory: expectedIdentity.gitDirectory,
        commonDirectory: expectedIdentity.commonDirectory,
      };
    }
    return binding;
  };
}

function createWorkspaceTrustGuard() {
  return {
    isWorkspaceTrusted: () => vscodeTestState.workspaceTrusted,
    assertTrusted(operationName: string): void {
      if (!vscodeTestState.workspaceTrusted) {
        throw new Error(`Cannot ${operationName} in an untrusted workspace.`);
      }
    },
  };
}

function createRepository(repositoryRoot = "/repo") {
  const rootUri = vscode.Uri.file(repositoryRoot);
  const createPublicGitMutation = () =>
    vi.fn(async (filesystemPaths: string[]) => {
      for (const filesystemPath of filesystemPaths) {
        const adaptedFilesystemPath = vscode.Uri.file(filesystemPath).fsPath;
        const relativePath = nodePath.relative(
          repositoryRoot,
          adaptedFilesystemPath,
        );
        if (
          relativePath === ".." ||
          relativePath.startsWith(`..${nodePath.sep}`) ||
          nodePath.isAbsolute(relativePath)
        ) {
          throw new Error(
            `Git adapter received a path outside repository: ${adaptedFilesystemPath}`,
          );
        }
      }
    });
  return {
    rootUri,
    kind: "repository" as const,
    inputBox: { value: "" },
    state: {
      HEAD: { type: 0, name: "main" },
      refs: [],
      remotes: [],
      submodules: [],
      worktrees: [],
      rebaseCommit: undefined,
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange: vi.fn(),
    },
    status: vi.fn(async () => undefined),
    add: createPublicGitMutation(),
    clean: createPublicGitMutation(),
    revert: createPublicGitMutation(),
    restore: createPublicGitMutation(),
    commit: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    checkout: vi.fn(async () => undefined),
    createBranch: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
    getBranches: vi.fn(async (query: VscodeGitBranchQuery) =>
      query.remote
        ? [{ name: "origin/main", type: 1, commit: "remote-sha" }]
        : [{ name: "main", type: 0, commit: "local-sha" }],
    ),
    getCommit: vi.fn(async () => ({
      hash: "abc1234",
      message: "",
      parents: [],
    })),
    createWorktree: vi.fn(async () => "/repo/worktree"),
    deleteWorktree: vi.fn(async () => undefined),
  };
}

function createResourceState(resourcePath: string, status: number) {
  const resourceUri = vscode.Uri.file(resourcePath);
  return {
    uri: resourceUri,
    originalUri: resourceUri,
    renameUri: undefined,
    status,
  };
}

function createLocalChangeForTest(
  repositoryRoot: vscode.Uri,
  resourcePath: string,
  status: number,
) {
  return createLocalGitChange(
    repositoryRoot,
    "changes",
    createResourceState(resourcePath, status),
  );
}
