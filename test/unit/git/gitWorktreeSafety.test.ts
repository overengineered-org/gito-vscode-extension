// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeTestState = vi.hoisted(() => ({
  workspaceTrusted: true,
  configuredGitPath: undefined as string | undefined,
  bundledGitExtensionAvailable: false,
  bundledGitEnabled: true,
  bundledGitApiAvailable: true,
  bundledGitPath: undefined as string | undefined,
}));

vi.mock("vscode", () => {
  interface UriChanges {
    readonly scheme?: string;
    readonly authority?: string;
    readonly path?: string;
    readonly query?: string;
    readonly fragment?: string;
  }

  class Uri {
    public readonly fsPath: string;

    public constructor(
      public readonly scheme: string,
      public readonly authority: string,
      public readonly path: string,
      public readonly query: string,
      public readonly fragment: string,
    ) {
      this.fsPath = path;
    }

    public static file(filePath: string): Uri {
      return new Uri("file", "", filePath, "", "");
    }

    public with(changes: UriChanges): Uri {
      return new Uri(
        changes.scheme ?? this.scheme,
        changes.authority ?? this.authority,
        changes.path ?? this.path,
        changes.query ?? this.query,
        changes.fragment ?? this.fragment,
      );
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
      getConfiguration: vi.fn(() => ({
        get: vi.fn(() => vscodeTestState.configuredGitPath),
      })),
    },
    extensions: {
      getExtension: vi.fn(() => {
        if (!vscodeTestState.bundledGitExtensionAvailable) return undefined;
        const extensionExports: Record<string, unknown> = {
          enabled: vscodeTestState.bundledGitEnabled,
          onDidChangeEnablement: vi.fn(() => ({ dispose: vi.fn() })),
        };
        if (vscodeTestState.bundledGitApiAvailable) {
          extensionExports.getAPI = vi.fn(() => ({
            git: { path: vscodeTestState.bundledGitPath },
          }));
        }
        return {
          isActive: true,
          exports: extensionExports,
          activate: vi.fn(async () => extensionExports),
        };
      }),
    },
    window: {
      showWarningMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
    },
  };
});

import * as vscode from "vscode";
import type {
  GitCommandRequest,
  GitCommandRunner,
  GitDirectoryBindingIdentity,
  GitRootBindingIdentity,
} from "../../../src/extension/git/gitCommandRunner.js";
import {
  GitWorktreeService,
  resolveBundledGitExecutablePath,
} from "../../../src/extension/git/gitWorktreeService.js";

describe("GitWorktreeService removal safety", () => {
  beforeEach(() => {
    vscodeTestState.workspaceTrusted = true;
    vscodeTestState.configuredGitPath = undefined;
    vscodeTestState.bundledGitExtensionAvailable = false;
    vscodeTestState.bundledGitEnabled = true;
    vscodeTestState.bundledGitApiAvailable = true;
    vscodeTestState.bundledGitPath = undefined;
  });

  it("uses an absolute configured Git path without PATH lookup", async () => {
    vscodeTestState.configuredGitPath = "/opt/vscode/git";

    await expect(resolveBundledGitExecutablePath()).resolves.toBe(
      "/opt/vscode/git",
    );
    expect(vscode.extensions.getExtension).not.toHaveBeenCalled();
  });

  it("fails closed when the bundled Git extension is unavailable", async () => {
    await expect(resolveBundledGitExecutablePath()).rejects.toThrow(
      "bundled Git extension is unavailable",
    );
  });

  it("reads the Git executable from the bundled public API", async () => {
    vscodeTestState.bundledGitExtensionAvailable = true;
    vscodeTestState.bundledGitPath = "/opt/vscode/git";

    await expect(resolveBundledGitExecutablePath()).resolves.toBe(
      "/opt/vscode/git",
    );
  });

  it("fails closed when the bundled Git extension is disabled", async () => {
    vscodeTestState.bundledGitExtensionAvailable = true;
    vscodeTestState.bundledGitEnabled = false;
    vscodeTestState.bundledGitPath = "/opt/vscode/git";

    await expect(resolveBundledGitExecutablePath()).rejects.toThrow(
      "bundled Git extension is disabled",
    );
  });

  it("fails closed when the bundled public API is unavailable", async () => {
    vscodeTestState.bundledGitExtensionAvailable = true;
    vscodeTestState.bundledGitApiAvailable = false;
    vscodeTestState.bundledGitPath = "/opt/vscode/git";

    await expect(resolveBundledGitExecutablePath()).rejects.toThrow(
      "did not expose its public API",
    );
  });

  it("fails closed when the bundled public API has no Git path", async () => {
    vscodeTestState.bundledGitExtensionAvailable = true;

    await expect(resolveBundledGitExecutablePath()).rejects.toThrow(
      "did not provide a usable Git executable path",
    );
  });

  it("opens only a worktree listed for the selected repository", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      worktreeListOutput(),
    ]);
    const nativeCommandExecutor = { execute: vi.fn(async () => undefined) };
    const service = new GitWorktreeService(
      commandRunner,
      createWorkspaceTrustGuard(),
      nativeCommandExecutor,
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      {
        getBundledGitApi: vi.fn(async () => ({
          getRepository: vi.fn(() => ({})),
        })),
      } as never,
      createTestRootBindingResolver(),
      createTestPathBindingResolver(),
      async () => "/opt/vscode/git",
    );

    await expect(
      service.openWorktree(vscode.Uri.file("/repo"), "/other"),
    ).rejects.toThrow("not registered");
    expect(nativeCommandExecutor.execute).not.toHaveBeenCalled();
    await service.openWorktree(vscode.Uri.file("/repo"), "/repo/feature");
    expect(nativeCommandExecutor.execute).toHaveBeenCalledWith(
      "vscode.openFolder",
      vscode.Uri.file("/repo/feature"),
      { forceNewWindow: true },
    );
  });

  it("uses the configured bundled Git executable for worktree reads", async () => {
    const commandRunner = createCommandRunner([worktreeListOutput()]);
    const service = createService(
      commandRunner,
      vi.fn(async () => true),
      vi.fn(async () => undefined),
      async () => "/opt/vscode/git",
    );

    await service.openWorktree(vscode.Uri.file("/repo"), "/repo/feature");

    expect(commandRunner.requests[0]?.gitExecutablePath).toBe(
      "/opt/vscode/git",
    );
  });

  it("uses the configured executable for worktree root discovery", async () => {
    const commandRunner = createCommandRunner([worktreeListOutput()]);
    const rootBindingResolver = vi.fn(createTestRootBindingResolver());
    const service = new GitWorktreeService(
      commandRunner,
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      undefined,
      rootBindingResolver,
      createTestPathBindingResolver(),
      async () => "/opt/vscode/git",
    );

    await service.listWorktrees(vscode.Uri.file("/repo"));

    expect(rootBindingResolver).toHaveBeenCalledWith("/repo", undefined, {
      gitExecutablePath: "/opt/vscode/git",
    });
  });

  it("preserves remote repository URI routing when opening a worktree", async () => {
    const commandRunner = createCommandRunner([worktreeListOutput()]);
    const nativeCommandExecutor = { execute: vi.fn(async () => undefined) };
    const remoteRepositoryRoot = createRemoteUri(
      "vscode-remote",
      "ssh-remote+host",
      "/repo",
      "window=one",
      "overview",
    );
    const service = new GitWorktreeService(
      commandRunner,
      createWorkspaceTrustGuard(),
      nativeCommandExecutor,
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      {
        getBundledGitApi: vi.fn(async () => ({
          getRepository: vi.fn(() => ({})),
        })),
      } as never,
      createTestRootBindingResolver(),
      createTestPathBindingResolver(),
      async () => "/opt/vscode/git",
    );

    await service.openWorktree(remoteRepositoryRoot, "/repo/feature");

    const executeCalls = nativeCommandExecutor.execute.mock
      .calls as readonly (readonly unknown[])[];
    const openedWorktreeUri = executeCalls[0]?.[1] as vscode.Uri | undefined;
    expect(openedWorktreeUri).toBeDefined();
    expect({
      scheme: openedWorktreeUri?.scheme,
      authority: openedWorktreeUri?.authority,
      path: openedWorktreeUri?.path,
      fsPath: openedWorktreeUri?.fsPath,
      query: openedWorktreeUri?.query,
      fragment: openedWorktreeUri?.fragment,
    }).toEqual({
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
      path: "/repo/feature",
      fsPath: "/repo/feature",
      query: "window=one",
      fragment: "overview",
    });
    expect(nativeCommandExecutor.execute).toHaveBeenCalledWith(
      "vscode.openFolder",
      openedWorktreeUri,
      { forceNewWindow: true },
    );
  });

  it("treats ignored files as dirty and includes ignored status output", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      "!! ignored.local\n",
    ]);
    const confirm = vi.fn(async () => true);
    const deleteWorktree = vi.fn(async () => undefined);
    const service = createService(commandRunner, confirm, deleteWorktree);

    await expect(
      service.removeWorktree(vscode.Uri.file("/repo"), "/repo/feature"),
    ).rejects.toThrow("Only clean worktrees");
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteWorktree).not.toHaveBeenCalled();
    expect(commandRunner.requests[1]?.arguments).toEqual([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored",
    ]);
  });

  it("rechecks the worktree after confirmation before deleting", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      "",
      worktreeListOutput(),
      " M changed-after-confirmation.txt\n",
    ]);
    const confirm = vi.fn(async () => true);
    const deleteWorktree = vi.fn(async () => undefined);
    const service = createService(commandRunner, confirm, deleteWorktree);

    await expect(
      service.removeWorktree(vscode.Uri.file("/repo"), "/repo/feature"),
    ).rejects.toThrow("changed while confirmation was open");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteWorktree).not.toHaveBeenCalled();
    expect(commandRunner.requests).toHaveLength(4);
  });

  it("removes through native Git with the full repository binding", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      "",
      worktreeListOutput(),
      "",
    ]);
    const confirm = vi.fn(async () => true);
    const deleteWorktree = vi.fn(async () => undefined);
    const service = createService(commandRunner, confirm, deleteWorktree);

    await service.removeWorktree(vscode.Uri.file("/repo"), "/repo/feature");

    const mutationRequest = commandRunner.requests[4];
    expect(mutationRequest?.arguments).toEqual([
      "worktree",
      "remove",
      "/repo/feature",
    ]);
    expect(mutationRequest?.rootBindingRequired).toBe(true);
    expect(mutationRequest?.literalPathspecs).toBe(true);
    expect(mutationRequest?.rootBinding?.commonDirectory).toEqual(
      expect.objectContaining({ canonicalPath: "/repo/.git" }),
    );
    expect(deleteWorktree).not.toHaveBeenCalled();
  });

  it("revalidates worktree HEAD, branch, lock, and prune state before deletion", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      "",
      worktreeListOutput({ headSha: "changed-head", branchName: "changed" }),
    ]);
    const confirm = vi.fn(async () => true);
    const deleteWorktree = vi.fn(async () => undefined);
    const service = createService(commandRunner, confirm, deleteWorktree);

    await expect(
      service.removeWorktree(vscode.Uri.file("/repo"), "/repo/feature"),
    ).rejects.toThrow("changed while confirmation was open");
    expect(deleteWorktree).not.toHaveBeenCalled();
    expect(commandRunner.requests).toHaveLength(3);
  });

  it("rechecks workspace trust after worktree removal confirmation", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      "",
      worktreeListOutput(),
      "",
    ]);
    const confirm = vi.fn(async () => {
      vscodeTestState.workspaceTrusted = false;
      return true;
    });
    const deleteWorktree = vi.fn(async () => undefined);
    const service = createService(commandRunner, confirm, deleteWorktree);

    await expect(
      service.removeWorktree(vscode.Uri.file("/repo"), "/repo/feature"),
    ).rejects.toThrow("untrusted workspace");
    expect(deleteWorktree).not.toHaveBeenCalled();
  });

  it("fails closed when workspace trust is unavailable", async () => {
    const commandRunner = createCommandRunner([
      worktreeListOutput(),
      "",
      worktreeListOutput(),
      "",
    ]);
    const deleteWorktree = vi.fn(async () => undefined);
    vscodeTestState.workspaceTrusted = false;
    const service = createService(
      commandRunner,
      vi.fn(async () => true),
      deleteWorktree,
    );

    await expect(
      service.removeWorktree(vscode.Uri.file("/repo"), "/repo/feature"),
    ).rejects.toThrow("untrusted workspace");
    expect(deleteWorktree).not.toHaveBeenCalled();
  });

  it("rejects a target-parent retarget before native creation", async () => {
    const commandRunner = createCommandRunner([]);
    const createWorktree = vi.fn(async () => "/repo/feature");
    let parentBindingChecks = 0;
    const pathBindingResolver = async (
      targetPath: string,
      expectedIdentity?: GitDirectoryBindingIdentity,
    ): Promise<GitDirectoryBindingIdentity> => {
      const stableBinding = {
        canonicalPath: targetPath,
        device: "test-device",
        inode: "test-inode",
      } satisfies GitDirectoryBindingIdentity;
      if (expectedIdentity !== undefined && targetPath === "/repo") {
        parentBindingChecks += 1;
        if (parentBindingChecks === 1) throw new Error("target parent changed");
      }
      return stableBinding;
    };
    const service = new GitWorktreeService(
      commandRunner,
      createWorkspaceTrustGuard(),
      { execute: vi.fn(async () => undefined) },
      {
        confirm: vi.fn(async () => true),
        confirmSmartCommit: vi.fn(async () => true),
      },
      {
        getBundledGitApi: vi.fn(async () => ({
          getRepository: vi.fn(() => ({ createWorktree })),
        })),
      } as never,
      createTestRootBindingResolver(),
      pathBindingResolver,
      async () => "/opt/vscode/git",
    );

    await expect(
      service.createWorktree(vscode.Uri.file("/repo"), "/repo/feature"),
    ).rejects.toThrow("target parent changed");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("rejects incompatible existing-branch options before binding", async () => {
    const commandRunner = createCommandRunner([]);
    const service = createService(
      commandRunner,
      vi.fn(async () => true),
      vi.fn(async () => undefined),
    );

    await expect(
      service.createWorktree(vscode.Uri.file("/repo"), "/repo/feature", {
        branchName: "feature/existing",
        startPoint: "main",
      }),
    ).rejects.toThrow("cannot be combined");
    expect(commandRunner.requests).toHaveLength(0);
  });
});

function createRemoteUri(
  scheme: string,
  authority: string,
  uriPath: string,
  query: string,
  fragment: string,
): vscode.Uri {
  return {
    scheme,
    authority,
    path: uriPath,
    fsPath: uriPath,
    query,
    fragment,
    with(changes: {
      readonly scheme?: string;
      readonly authority?: string;
      readonly path?: string;
      readonly query?: string;
      readonly fragment?: string;
    }): vscode.Uri {
      return createRemoteUri(
        changes.scheme ?? scheme,
        changes.authority ?? authority,
        changes.path ?? uriPath,
        changes.query ?? query,
        changes.fragment ?? fragment,
      );
    },
  } as unknown as vscode.Uri;
}

function createService(
  commandRunner: ReturnType<typeof createCommandRunner>,
  confirm: (message: string, confirmLabel: string) => Promise<boolean>,
  deleteWorktree: () => Promise<void>,
  gitExecutablePathResolver: () => Promise<string | undefined> = async () =>
    "/opt/vscode/git",
): GitWorktreeService {
  return new GitWorktreeService(
    commandRunner,
    createWorkspaceTrustGuard(),
    { execute: vi.fn(async () => undefined) },
    { confirm, confirmSmartCommit: vi.fn(async () => true) },
    {
      getBundledGitApi: vi.fn(async () => ({
        getRepository: vi.fn(() => ({
          deleteWorktree,
        })),
      })),
    } as never,
    createTestRootBindingResolver(),
    createTestPathBindingResolver(),
    gitExecutablePathResolver,
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
    return expectedIdentity === undefined
      ? binding
      : {
          ...binding,
          canonicalPath: expectedIdentity.canonicalPath,
          device: expectedIdentity.device,
          inode: expectedIdentity.inode,
          gitDirectory: expectedIdentity.gitDirectory,
          commonDirectory: expectedIdentity.commonDirectory,
        };
  };
}

function createTestPathBindingResolver() {
  return async (
    targetPath: string,
    expectedIdentity?: GitDirectoryBindingIdentity,
  ): Promise<GitDirectoryBindingIdentity> => {
    const binding = {
      canonicalPath: targetPath,
      device: "test-device",
      inode: "test-inode",
    } satisfies GitDirectoryBindingIdentity;
    return expectedIdentity ?? binding;
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

function createCommandRunner(outputs: readonly string[]) {
  const requests: GitCommandRequest[] = [];
  let outputIndex = 0;
  const commandRunner = {
    requests,
    run: vi.fn(async (request: GitCommandRequest) => {
      requests.push(request);
      return {
        standardOutput: outputs[outputIndex++] ?? "",
        standardError: "",
        exitCode: 0,
      };
    }),
    runStreaming: vi.fn(async () => ({
      standardOutput: "",
      standardError: "",
      exitCode: 0,
    })),
  };
  return commandRunner as unknown as GitCommandRunner & {
    readonly requests: typeof requests;
  };
}

function worktreeListOutput(
  changes: { readonly headSha?: string; readonly branchName?: string } = {},
): string {
  return [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/feature",
    `HEAD ${changes.headSha ?? "def456"}`,
    `branch refs/heads/${changes.branchName ?? "feature"}`,
    "",
  ].join("\n");
}
