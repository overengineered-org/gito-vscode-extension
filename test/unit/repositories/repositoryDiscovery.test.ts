// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const { extensionChangeListeners, getExtension } = vi.hoisted(() => ({
  extensionChangeListeners: [] as Array<() => void>,
  getExtension: vi.fn(),
}));

vi.mock("vscode", () => ({
  Disposable: class {
    public constructor(
      private readonly disposeCallback: () => void = () => {},
    ) {}
    public dispose(): void {
      this.disposeCallback();
    }
  },
  extensions: {
    getExtension,
    onDidChange: (listener: () => void) => {
      extensionChangeListeners.push(listener);
      return { dispose: () => undefined };
    },
  },
  window: { activeTextEditor: undefined },
}));

import {
  areExactRepositoryRootUrisEqual,
  isUriWithinRepository,
  RepositoryDiscovery,
} from "../../../src/extension/repositories/repositoryDiscovery.js";
import type { VscodeGitRepository } from "../../../src/extension/git/vscodeGitApi.js";

describe("RepositoryDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extensionChangeListeners.length = 0;
  });

  it("reacquires the bundled Git API after enablement changes", async () => {
    const firstApi = createGitApi();
    const secondApi = createGitApi();
    let currentApi = firstApi;
    let isEnabled = true;
    let extensionEnablementListener: ((enabled: boolean) => void) | undefined;
    getExtension.mockImplementation(() => ({
      isActive: true,
      exports: {
        get enabled(): boolean {
          return isEnabled;
        },
        onDidChangeEnablement: (listener: (enabled: boolean) => void) => {
          extensionEnablementListener = listener;
          return { dispose: () => undefined };
        },
        getAPI: () => currentApi,
      },
    }));

    const discovery = new RepositoryDiscovery();
    await expect(discovery.getBundledGitApi()).resolves.toBe(firstApi);
    currentApi = secondApi;
    isEnabled = false;
    extensionEnablementListener?.(false);
    await expect(discovery.getBundledGitApi()).rejects.toThrow("disabled");

    isEnabled = true;
    extensionEnablementListener?.(true);
    await expect(discovery.getBundledGitApi()).resolves.toBe(secondApi);
    expect(getExtension).toHaveBeenCalledTimes(3);
  });

  it("rejects an explicit repository root that is no longer open", async () => {
    const repository = {
      rootUri: { scheme: "file", fsPath: "/repo/open" },
    } as never;
    const gitApi = createGitApi();
    Object.assign(gitApi, {
      repositories: [repository],
      onDidOpenRepository: () => ({ dispose: () => undefined }),
      onDidCloseRepository: () => ({ dispose: () => undefined }),
    });
    getExtension.mockReturnValue({
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose: () => undefined }),
        getAPI: () => gitApi,
      },
    });

    const discovery = new RepositoryDiscovery();
    await expect(
      discovery.selectRepository({
        selectedRepositoryRoot: {
          scheme: "file",
          fsPath: "/repo/missing",
        } as never,
      }),
    ).rejects.toThrow("selected Git repository is no longer open");
  });

  it("does not let an old same-path repository close a new state subscription", async () => {
    const repositoryRoot = {
      scheme: "file",
      authority: "",
      fsPath: "/repo/reused",
      toString: () => "file:///repo/reused",
    };
    let oldStateListener: (() => void) | undefined;
    let newStateListener: (() => void) | undefined;
    let oldStateActive = true;
    let newStateActive = true;
    const oldStateSubscription = {
      dispose: vi.fn(() => {
        oldStateActive = false;
      }),
    };
    const newStateSubscription = {
      dispose: vi.fn(() => {
        newStateActive = false;
      }),
    };
    const oldRepository = {
      rootUri: repositoryRoot,
      state: {
        onDidChange: (listener: () => void) => {
          oldStateListener = () => {
            if (oldStateActive) listener();
          };
          return oldStateSubscription;
        },
      },
    } as unknown as VscodeGitRepository;
    const newRepository = {
      rootUri: repositoryRoot,
      state: {
        onDidChange: (listener: () => void) => {
          newStateListener = () => {
            if (newStateActive) listener();
          };
          return newStateSubscription;
        },
      },
    } as unknown as VscodeGitRepository;
    let openRepository: ((repository: VscodeGitRepository) => void) | undefined;
    let closeRepository:
      ((repository: VscodeGitRepository) => void) | undefined;
    const gitApi = createGitApi();
    Object.assign(gitApi, {
      repositories: [oldRepository],
      onDidOpenRepository: (
        listener: (repository: VscodeGitRepository) => void,
      ) => {
        openRepository = listener;
        return { dispose: vi.fn() };
      },
      onDidCloseRepository: (
        listener: (repository: VscodeGitRepository) => void,
      ) => {
        closeRepository = listener;
        return { dispose: vi.fn() };
      },
    });
    getExtension.mockReturnValue({
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose: vi.fn() }),
        getAPI: () => gitApi,
      },
    });

    const stateChanges = vi.fn();
    const discovery = new RepositoryDiscovery();
    const watcher = discovery.watchRepositoryStateChanges(stateChanges);
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(openRepository).toBeDefined());
    openRepository?.(newRepository);
    closeRepository?.(oldRepository);

    oldStateListener?.();
    newStateListener?.();
    expect(stateChanges).toHaveBeenCalledTimes(1);
    expect(oldStateSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(newStateSubscription.dispose).not.toHaveBeenCalled();

    watcher.dispose();
    expect(newStateSubscription.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns the selected API repository root without dropping URI metadata", async () => {
    const repositoryRoot = {
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
      fsPath: "/workspace/repository",
      toString: () => "vscode-remote://ssh-remote+host/workspace/repository",
    };
    const repository = { rootUri: repositoryRoot } as never;
    const gitApi = createGitApi();
    Object.assign(gitApi, {
      repositories: [repository],
    });
    getExtension.mockReturnValue({
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose: () => undefined }),
        getAPI: () => gitApi,
      },
    });

    const discovery = new RepositoryDiscovery();
    await expect(
      discovery.selectRepository({
        selectedRepositoryRoot: repositoryRoot as never,
      }),
    ).resolves.toBe(repository);
  });

  it("accepts bundled Git repository wrappers recreated between selections", async () => {
    const repositoryRoot = {
      scheme: "file",
      authority: "",
      fsPath: "/repo/recreated-wrapper",
    };
    const gitApi = createGitApi();
    Object.defineProperty(gitApi, "repositories", {
      get: () => [
        {
          rootUri: repositoryRoot,
          kind: "repository",
        } as never,
      ],
    });
    getExtension.mockReturnValue({
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose: () => undefined }),
        getAPI: () => gitApi,
      },
    });

    const discovery = new RepositoryDiscovery();
    const initiallySelectedRepository = await discovery.selectRepository();
    const refreshedRepository = await discovery.selectRepository({
      selectedRepositoryRoot: repositoryRoot as never,
      expectedRepository: initiallySelectedRepository,
    });

    expect(refreshedRepository).not.toBe(initiallySelectedRepository);
    expect(refreshedRepository.rootUri).toBe(repositoryRoot);
  });

  it("returns a stable identity for the open repository object", async () => {
    const repositoryRoot = {
      scheme: "file",
      authority: "",
      fsPath: "/repo/identity",
    };
    const repository = { rootUri: repositoryRoot } as never;
    const gitApi = createGitApi();
    Object.assign(gitApi, { repositories: [repository] });
    getExtension.mockReturnValue({
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose: () => undefined }),
        getAPI: () => gitApi,
      },
    });

    const discovery = new RepositoryDiscovery();
    const firstIdentity = await discovery.getRepositoryIdentity(
      repositoryRoot as never,
    );
    const secondIdentity = await discovery.getRepositoryIdentity(
      repositoryRoot as never,
    );

    expect(firstIdentity).toBe("repository-1");
    expect(secondIdentity).toBe(firstIdentity);
  });

  it("rejects traversal paths and URI authority changes", () => {
    const repositoryRoot = {
      scheme: "file",
      authority: "workspace",
      fsPath: "/repo",
    } as never;
    expect(
      isUriWithinRepository(repositoryRoot, {
        scheme: "file",
        authority: "workspace",
        fsPath: "/repo/../other/file.txt",
      } as never),
    ).toBe(false);
    expect(
      isUriWithinRepository(repositoryRoot, {
        scheme: "file",
        authority: "other-workspace",
        fsPath: "/repo/file.txt",
      } as never),
    ).toBe(false);
  });

  it("keeps exact root authorization bound to URI identity", () => {
    const canonicalRoot = {
      scheme: "file",
      authority: "workspace",
      fsPath: "/repo",
    } as never;
    expect(
      areExactRepositoryRootUrisEqual(canonicalRoot, {
        scheme: "file",
        authority: "workspace",
        fsPath: "/repo/",
      } as never),
    ).toBe(true);
    expect(
      areExactRepositoryRootUrisEqual(canonicalRoot, {
        scheme: "file",
        authority: "other-workspace",
        fsPath: "/repo",
      } as never),
    ).toBe(false);
    expect(
      areExactRepositoryRootUrisEqual(canonicalRoot, {
        scheme: "file",
        authority: "workspace",
        fsPath: "/repo-symlink",
      } as never),
    ).toBe(false);
  });

  it("rejects a symlink boundary and handles the filesystem root", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "gito-discovery-"));
    const repositoryPath = path.join(temporaryRoot, "repository");
    const outsidePath = path.join(temporaryRoot, "outside");
    const linkedPath = path.join(repositoryPath, "linked");
    mkdirSync(repositoryPath);
    mkdirSync(outsidePath);
    symlinkSync(outsidePath, linkedPath, "dir");
    try {
      expect(
        isUriWithinRepository(
          { scheme: "file", authority: "", fsPath: repositoryPath } as never,
          {
            scheme: "file",
            authority: "",
            fsPath: path.join(linkedPath, "secret.txt"),
          } as never,
        ),
      ).toBe(false);
      expect(
        isUriWithinRepository(
          { scheme: "file", authority: "", fsPath: "/" } as never,
          {
            scheme: "file",
            authority: "",
            fsPath: path.join(outsidePath, "secret.txt"),
          } as never,
        ),
      ).toBe(true);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not reacquire the bundled Git API after disposal", async () => {
    const discovery = new RepositoryDiscovery();
    discovery.dispose();

    await expect(discovery.getBundledGitApi()).rejects.toThrow("disposed");
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("cancels bundled Git activation when disposed before activation completes", async () => {
    let signalActivationStarted: (() => void) | undefined;
    const activationStarted = new Promise<void>((resolve) => {
      signalActivationStarted = resolve;
    });
    let releaseActivation: (() => void) | undefined;
    const activationRelease = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const onDidChangeEnablement = vi.fn(() => ({ dispose: vi.fn() }));
    getExtension.mockReturnValue({
      isActive: false,
      activate: async () => {
        signalActivationStarted?.();
        await activationRelease;
        return {
          enabled: true,
          onDidChangeEnablement,
          getAPI: () => createGitApi(),
        };
      },
    });

    const discovery = new RepositoryDiscovery();
    const apiPromise = discovery.getBundledGitApi();
    await activationStarted;
    discovery.dispose();
    releaseActivation?.();

    await expect(apiPromise).rejects.toThrow("disposed");
    expect(onDidChangeEnablement).not.toHaveBeenCalled();
  });

  it("cancels the Git API initialization wait when disposed", async () => {
    let signalStateListenerRegistered: (() => void) | undefined;
    const stateListenerRegistered = new Promise<void>((resolve) => {
      signalStateListenerRegistered = resolve;
    });
    let stateListener: ((state: "initialized") => void) | undefined;
    const gitApi = {
      ...createGitApi(),
      state: "uninitialized" as const,
      onDidChangeState: (listener: (state: "initialized") => void) => {
        stateListener = listener;
        signalStateListenerRegistered?.();
        return { dispose: vi.fn() };
      },
    };
    getExtension.mockReturnValue({
      isActive: true,
      exports: {
        enabled: true,
        onDidChangeEnablement: () => ({ dispose: vi.fn() }),
        getAPI: () => gitApi,
      },
    });

    const discovery = new RepositoryDiscovery();
    const apiPromise = discovery.getBundledGitApi();
    await stateListenerRegistered;
    discovery.dispose();

    await expect(apiPromise).rejects.toThrow("disposed");
    stateListener?.("initialized");
  });
});

function createGitApi(): {
  state: "initialized";
  onDidChangeState: () => { dispose: () => void };
  onDidChangeEnablement?: (listener: () => void) => { dispose: () => void };
  repositories: readonly [];
  getRepository: () => null;
} {
  return {
    state: "initialized",
    onDidChangeState: () => ({ dispose: () => undefined }),
    repositories: [],
    getRepository: () => null,
  };
}
