import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isVscodeGitApi,
  type VscodeGitApi,
  type VscodeGitRepository,
} from "../git/vscodeGitApi.js";

export interface RepositorySelectionContext {
  readonly activeEditorUri?: vscode.Uri;
  readonly selectedRepositoryRoot?: vscode.Uri;
  /**
   * Optional stable object captured before an asynchronous operation. A path
   * alone is insufficient because another repository can reuse it.
   */
  readonly expectedRepository?: VscodeGitRepository;
}

export class BundledGitApiUnavailableError extends Error {
  public constructor(
    message = "VS Code's bundled Git extension is unavailable.",
  ) {
    super(message);
    this.name = "BundledGitApiUnavailableError";
  }
}

/** Discovers repositories owned by VS Code's bundled Git extension. */
export class RepositoryDiscovery {
  private disposed = false;
  private readonly disposalController = new AbortController();
  private bundledGitApi: VscodeGitApi | undefined;
  private bundledGitApiPromise: Promise<VscodeGitApi> | undefined;
  private bundledGitApiGeneration = 0;
  private bundledGitExtensionChangeSubscription: vscode.Disposable | undefined;
  private bundledGitEnablementSubscription: vscode.Disposable | undefined;
  private readonly bundledGitApiInvalidationListeners = new Set<() => void>();
  private repositoryIdentityTokens = new WeakMap<object, string>();
  private repositoryIdentityTokensByRoot = new Map<string, string>();
  private repositoryIdentityTokenSequence = 0;

  public async getBundledGitApi(): Promise<VscodeGitApi> {
    if (this.disposed) {
      throw new BundledGitApiUnavailableError(
        "The bundled VS Code Git discovery service has been disposed.",
      );
    }
    if (this.bundledGitApi !== undefined) return this.bundledGitApi;

    if (this.bundledGitApiPromise !== undefined)
      return this.bundledGitApiPromise;

    const apiPromise = this.loadBundledGitApi();
    this.bundledGitApiPromise = apiPromise;
    const apiGeneration = this.bundledGitApiGeneration;
    try {
      const gitApi = await apiPromise;
      if (apiGeneration !== this.bundledGitApiGeneration)
        return this.getBundledGitApi();
      this.bundledGitApi = gitApi;
      return gitApi;
    } finally {
      if (this.bundledGitApiPromise === apiPromise)
        this.bundledGitApiPromise = undefined;
    }
  }

  private async loadBundledGitApi(): Promise<VscodeGitApi> {
    if (this.disposed) {
      throw new BundledGitApiUnavailableError(
        "The bundled VS Code Git discovery service has been disposed.",
      );
    }
    this.bundledGitApi = undefined;

    this.bundledGitExtensionChangeSubscription ??=
      vscode.extensions.onDidChange(() => {
        this.invalidateBundledGitApi();
        this.bundledGitEnablementSubscription?.dispose();
        this.bundledGitEnablementSubscription = undefined;
      });

    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (gitExtension === undefined) {
      throw new BundledGitApiUnavailableError();
    }
    const extensionExports: unknown = gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate();
    if (this.disposalController.signal.aborted) {
      throw new BundledGitApiUnavailableError(
        "The bundled VS Code Git discovery service has been disposed.",
      );
    }
    if (!isVscodeGitApi(extensionExports)) {
      throw new BundledGitApiUnavailableError(
        "VS Code's bundled Git extension did not expose its public API.",
      );
    }
    if (this.disposalController.signal.aborted) {
      throw new BundledGitApiUnavailableError(
        "The bundled VS Code Git discovery service has been disposed.",
      );
    }
    this.bundledGitEnablementSubscription?.dispose();
    this.bundledGitEnablementSubscription =
      extensionExports.onDidChangeEnablement((isEnabled) => {
        this.invalidateBundledGitApi();
        if (isEnabled)
          void Promise.resolve().then(() =>
            this.getBundledGitApi().catch(() => undefined),
          );
      });
    if (!extensionExports.enabled) {
      throw new BundledGitApiUnavailableError(
        "VS Code's bundled Git extension is disabled.",
      );
    }
    const gitApi = extensionExports.getAPI(1);
    if (gitApi.state === "uninitialized")
      await waitForGitApiInitialization(gitApi, this.disposalController.signal);
    if (this.disposalController.signal.aborted) {
      throw new BundledGitApiUnavailableError(
        "The bundled VS Code Git discovery service has been disposed.",
      );
    }
    return gitApi;
  }

  private invalidateBundledGitApi(): void {
    if (this.disposed) return;
    ++this.bundledGitApiGeneration;
    this.bundledGitApi = undefined;
    this.bundledGitApiPromise = undefined;
    this.repositoryIdentityTokensByRoot.clear();
    for (const listener of this.bundledGitApiInvalidationListeners) listener();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalController.abort();
    ++this.bundledGitApiGeneration;
    this.bundledGitApi = undefined;
    this.bundledGitApiPromise = undefined;
    this.bundledGitExtensionChangeSubscription?.dispose();
    this.bundledGitExtensionChangeSubscription = undefined;
    this.bundledGitEnablementSubscription?.dispose();
    this.bundledGitEnablementSubscription = undefined;
    this.bundledGitApiInvalidationListeners.clear();
  }

  public async listRepositories(): Promise<readonly VscodeGitRepository[]> {
    const gitApi = await this.getBundledGitApi();
    return sortRepositories(gitApi.repositories);
  }

  /** Returns an opaque identity for the currently open repository instance. */
  public async getRepositoryIdentity(
    repositoryRoot: vscode.Uri,
  ): Promise<string | undefined> {
    const repositories = await this.listRepositories();
    const repository = repositories.find((candidateRepository) =>
      areExactRepositoryRootUrisEqual(
        candidateRepository.rootUri,
        repositoryRoot,
      ),
    );
    if (repository === undefined) return undefined;
    return this.getOrCreateRepositoryIdentityToken(repository);
  }

  public async selectRepository(
    selectionContext: RepositorySelectionContext = {},
  ): Promise<VscodeGitRepository> {
    const repositories = await this.listRepositories();
    if (repositories.length === 0) {
      throw new Error(
        "Open a Git repository before using Git'o local actions.",
      );
    }

    if (selectionContext.selectedRepositoryRoot !== undefined) {
      const explicitlySelectedRepositoryRoot =
        selectionContext.selectedRepositoryRoot;
      const explicitlySelectedRepository = repositories.find((repository) =>
        areUrisEqual(repository.rootUri, explicitlySelectedRepositoryRoot),
      );
      if (explicitlySelectedRepository === undefined) {
        throw new Error(
          "The selected Git repository is no longer open. Refresh and try again.",
        );
      }
      if (
        selectionContext.expectedRepository !== undefined &&
        !this.repositoryIdentitiesMatch(
          explicitlySelectedRepository,
          selectionContext.expectedRepository,
        )
      ) {
        throw new Error(
          "The selected Git repository changed while the operation was pending. Refresh and try again.",
        );
      }
      return this.bindRepositoryIdentity(explicitlySelectedRepository);
    }

    if (selectionContext.expectedRepository !== undefined) {
      const expectedRepository = repositories.find((repository) =>
        this.repositoryIdentitiesMatch(
          repository,
          selectionContext.expectedRepository!,
        ),
      );
      if (expectedRepository === undefined) {
        throw new Error(
          "The selected Git repository changed while the operation was pending. Refresh and try again.",
        );
      }
      return this.bindRepositoryIdentity(expectedRepository);
    }

    const preferredRoot = findRepositoryRootForUri(
      repositories,
      selectionContext.activeEditorUri ??
        vscode.window.activeTextEditor?.document.uri,
    );
    if (preferredRoot !== undefined) {
      const preferredRepository = repositories.find((repository) =>
        areUrisEqual(repository.rootUri, preferredRoot),
      );
      if (preferredRepository !== undefined)
        return this.bindRepositoryIdentity(preferredRepository);
    }

    if (repositories.length === 1) {
      const onlyRepository = repositories[0];
      if (onlyRepository !== undefined)
        return this.bindRepositoryIdentity(onlyRepository);
    }
    const selectedRepository = await vscode.window.showQuickPick(
      repositories.map((repository) => ({
        label:
          repository.rootUri.fsPath.split(/[\\/]/).pop() ??
          repository.rootUri.fsPath,
        description: repository.rootUri.fsPath,
        repository,
      })),
      { placeHolder: "Select a Git repository" },
    );
    if (selectedRepository === undefined) {
      throw new Error("Repository selection was cancelled.");
    }
    return this.bindRepositoryIdentity(selectedRepository.repository);
  }

  public watchRepositoryChanges(
    onRepositoryOpened: (repository: VscodeGitRepository) => void,
    onRepositoryClosed: (repository: VscodeGitRepository) => void,
  ): vscode.Disposable {
    return this.watchBundledGitApi((gitApi) => {
      const repositoryEventSubscriptions = [
        gitApi.onDidOpenRepository(onRepositoryOpened),
        gitApi.onDidCloseRepository((repository) => {
          this.repositoryIdentityTokens.delete(repository);
          this.repositoryIdentityTokensByRoot.delete(
            repositoryRootIdentityKey(repository.rootUri),
          );
          onRepositoryClosed(repository);
        }),
      ];
      return new vscode.Disposable(() => {
        for (const subscription of repositoryEventSubscriptions)
          subscription.dispose();
      });
    });
  }

  public watchRepositoryStateChanges(
    onRepositoryStateChanged: (repository: VscodeGitRepository) => void,
  ): vscode.Disposable {
    return this.watchBundledGitApi((gitApi) => {
      const stateSubscriptions = new Map<
        string,
        {
          readonly repository: VscodeGitRepository;
          readonly subscription: vscode.Disposable;
        }
      >();
      const subscribeToRepository = (repository: VscodeGitRepository): void => {
        const repositoryKey = repository.rootUri.toString();
        stateSubscriptions.get(repositoryKey)?.subscription.dispose();
        stateSubscriptions.set(repositoryKey, {
          repository,
          subscription: repository.state.onDidChange(() =>
            onRepositoryStateChanged(repository),
          ),
        });
      };
      const unsubscribeFromRepository = (
        repository: VscodeGitRepository,
      ): void => {
        const repositoryKey = repository.rootUri.toString();
        const stateSubscription = stateSubscriptions.get(repositoryKey);
        if (stateSubscription?.repository !== repository) return;
        stateSubscription.subscription.dispose();
        stateSubscriptions.delete(repositoryKey);
      };
      for (const repository of gitApi.repositories)
        subscribeToRepository(repository);
      const repositoryEventSubscriptions = [
        gitApi.onDidOpenRepository(subscribeToRepository),
        gitApi.onDidCloseRepository(unsubscribeFromRepository),
      ];
      return new vscode.Disposable(() => {
        for (const subscription of repositoryEventSubscriptions)
          subscription.dispose();
        for (const stateSubscription of stateSubscriptions.values())
          stateSubscription.subscription.dispose();
        stateSubscriptions.clear();
      });
    });
  }

  private bindRepositoryIdentity(
    repository: VscodeGitRepository,
  ): VscodeGitRepository {
    this.getOrCreateRepositoryIdentityToken(repository);
    return repository;
  }

  private repositoryIdentitiesMatch(
    leftRepository: VscodeGitRepository,
    rightRepository: VscodeGitRepository,
  ): boolean {
    return (
      this.getOrCreateRepositoryIdentityToken(leftRepository) ===
      this.getOrCreateRepositoryIdentityToken(rightRepository)
    );
  }

  private getOrCreateRepositoryIdentityToken(
    repository: VscodeGitRepository,
  ): string {
    const existingObjectToken = this.repositoryIdentityTokens.get(repository);
    if (existingObjectToken !== undefined) return existingObjectToken;
    const repositoryRootKey = repositoryRootIdentityKey(repository.rootUri);
    const existingRootToken =
      this.repositoryIdentityTokensByRoot.get(repositoryRootKey);
    if (existingRootToken !== undefined) {
      this.repositoryIdentityTokens.set(repository, existingRootToken);
      return existingRootToken;
    }
    const identityToken = `repository-${++this.repositoryIdentityTokenSequence}`;
    this.repositoryIdentityTokens.set(repository, identityToken);
    this.repositoryIdentityTokensByRoot.set(repositoryRootKey, identityToken);
    return identityToken;
  }

  private watchBundledGitApi(
    bindApi: (gitApi: VscodeGitApi) => vscode.Disposable,
  ): vscode.Disposable {
    let disposed = false;
    let bindingGeneration = 0;
    let apiBinding: vscode.Disposable | undefined;
    const bindCurrentApi = async (): Promise<void> => {
      const generation = ++bindingGeneration;
      apiBinding?.dispose();
      apiBinding = undefined;
      try {
        const gitApi = await this.getBundledGitApi();
        if (disposed || generation !== bindingGeneration) return;
        apiBinding = bindApi(gitApi);
      } catch {
        // A disabled or restarting bundled Git extension has no API to bind.
      }
    };
    const onApiInvalidated = (): void => {
      apiBinding?.dispose();
      apiBinding = undefined;
      void bindCurrentApi();
    };
    this.bundledGitApiInvalidationListeners.add(onApiInvalidated);
    void bindCurrentApi();
    return new vscode.Disposable(() => {
      disposed = true;
      ++bindingGeneration;
      this.bundledGitApiInvalidationListeners.delete(onApiInvalidated);
      apiBinding?.dispose();
      apiBinding = undefined;
    });
  }
}

function repositoryRootIdentityKey(repositoryRoot: vscode.Uri): string {
  return [
    repositoryRoot.scheme,
    repositoryRoot.authority ?? "",
    normalizeFilePath(repositoryRoot.fsPath),
  ].join("\u0000");
}

async function waitForGitApiInitialization(
  gitApi: VscodeGitApi,
  disposalSignal: AbortSignal,
): Promise<void> {
  if (gitApi.state === "initialized") return;
  if (disposalSignal.aborted) {
    throw new BundledGitApiUnavailableError(
      "The bundled VS Code Git discovery service has been disposed.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const subscription = gitApi.onDidChangeState((state) => {
      if (state !== "initialized") return;
      settled = true;
      subscription.dispose();
      disposalSignal.removeEventListener("abort", onDisposed);
      resolve();
    });
    const onDisposed = (): void => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      reject(
        new BundledGitApiUnavailableError(
          "The bundled VS Code Git discovery service has been disposed.",
        ),
      );
    };
    disposalSignal.addEventListener("abort", onDisposed, { once: true });
    if (gitApi.state === "initialized") {
      settled = true;
      subscription.dispose();
      disposalSignal.removeEventListener("abort", onDisposed);
      resolve();
    }
  });
}

export function sortRepositories(
  repositories: readonly VscodeGitRepository[],
): readonly VscodeGitRepository[] {
  return [...repositories].sort((leftRepository, rightRepository) =>
    leftRepository.rootUri.fsPath.localeCompare(
      rightRepository.rootUri.fsPath,
      undefined,
      { sensitivity: "base" },
    ),
  );
}

export function findRepositoryRootForUri(
  repositories: readonly VscodeGitRepository[],
  candidateUri: vscode.Uri | undefined,
): vscode.Uri | undefined {
  if (candidateUri === undefined) return undefined;
  const matchingRepositories = repositories.filter((repository) =>
    isUriWithinRepository(repository.rootUri, candidateUri),
  );
  return matchingRepositories.sort(
    (leftRepository, rightRepository) =>
      rightRepository.rootUri.fsPath.length -
      leftRepository.rootUri.fsPath.length,
  )[0]?.rootUri;
}

export function isUriWithinRepository(
  repositoryRoot: vscode.Uri,
  candidateUri: vscode.Uri,
): boolean {
  if (
    repositoryRoot.scheme !== candidateUri.scheme ||
    (repositoryRoot.authority ?? "") !== (candidateUri.authority ?? "")
  )
    return false;
  const canonicalRepositoryRoot = canonicalizePath(repositoryRoot.fsPath);
  const canonicalCandidatePath = canonicalizePath(candidateUri.fsPath);
  if (
    canonicalRepositoryRoot === undefined ||
    canonicalCandidatePath === undefined
  )
    return false;
  const relativePath = path.relative(
    canonicalRepositoryRoot,
    canonicalCandidatePath,
  );
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function areUrisEqual(leftUri: vscode.Uri, rightUri: vscode.Uri): boolean {
  const canonicalLeftPath = canonicalizePath(leftUri.fsPath);
  const canonicalRightPath = canonicalizePath(rightUri.fsPath);
  return (
    leftUri.scheme === rightUri.scheme &&
    (leftUri.authority ?? "") === (rightUri.authority ?? "") &&
    canonicalLeftPath !== undefined &&
    canonicalRightPath !== undefined &&
    canonicalLeftPath === canonicalRightPath
  );
}

/**
 * Compares repository roots by their exact URI identity after lexical path
 * normalization. Unlike `areUrisEqual`, this deliberately does not resolve
 * symlinks: a stale root reached through a different symlink must not be
 * authorized for the currently open repository.
 */
export function areExactRepositoryRootUrisEqual(
  leftUri: vscode.Uri,
  rightUri: vscode.Uri,
): boolean {
  return (
    leftUri.scheme === rightUri.scheme &&
    (leftUri.authority ?? "") === (rightUri.authority ?? "") &&
    normalizeFilePath(leftUri.fsPath) === normalizeFilePath(rightUri.fsPath)
  );
}

function normalizeFilePath(filePath: string): string {
  const slashNormalizedPath = filePath.replaceAll("\\", "/");
  const parsedRoot =
    process.platform === "win32"
      ? path.win32.parse(slashNormalizedPath).root.replaceAll("\\", "/")
      : path.posix.parse(slashNormalizedPath).root;
  const normalizedPath = slashNormalizedPath.replace(/\/+$/, "");
  const pathWithoutTrailingSeparators =
    normalizedPath.length === 0 ? parsedRoot : normalizedPath;
  return process.platform === "win32"
    ? pathWithoutTrailingSeparators.toLowerCase()
    : pathWithoutTrailingSeparators;
}

/** Resolve existing symlink ancestors while preserving the missing suffix. */
function canonicalizePath(filePath: string): string | undefined {
  const absolutePath = path.resolve(normalizeFilePath(filePath));
  let unresolvedPath = absolutePath;
  const missingPathSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = fs.realpathSync.native(unresolvedPath);
      return path.resolve(canonicalAncestor, ...missingPathSegments.reverse());
    } catch (error: unknown) {
      const filesystemError = error as NodeJS.ErrnoException;
      if (
        filesystemError.code !== "ENOENT" &&
        filesystemError.code !== "ENOTDIR"
      )
        return undefined;
      try {
        if (fs.lstatSync(unresolvedPath).isSymbolicLink()) return undefined;
      } catch {
        // Missing paths are handled by resolving their existing ancestors.
      }
      const parentPath = path.dirname(unresolvedPath);
      if (parentPath === unresolvedPath) return absolutePath;
      missingPathSegments.push(path.basename(unresolvedPath));
      unresolvedPath = parentPath;
    }
  }
}
