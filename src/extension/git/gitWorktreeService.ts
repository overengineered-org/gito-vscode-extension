import * as path from "node:path";
import { realpath, stat } from "node:fs/promises";
import * as vscode from "vscode";
import type {
  NativeVscodeCommandExecutor,
  LocalGitInteraction,
} from "./localGitRepositoryService.js";
import {
  GitOperationError,
  VscodeLocalGitInteraction,
  VscodeNativeCommandExecutor,
} from "./localGitRepositoryService.js";
import {
  resolveGitRootBinding,
  isAbortError,
  type GitCommandRunner,
  type GitDirectoryBindingIdentity,
  type GitRootBindingIdentity,
  type GitRootBindingResolutionOptions,
} from "./gitCommandRunner.js";
import type { LocalGitWorktree } from "./localGitModels.js";
import {
  buildWorktreeAddArguments,
  parseWorktreeList,
  type GitWorktreeCreationOptions,
} from "./gitWorktreeParser.js";
import type { RepositoryDiscovery } from "../repositories/repositoryDiscovery.js";
import type { WorkspaceTrustGuard } from "../security/workspaceTrustGuard.js";
import type { VscodeGitRepository } from "./vscodeGitApi.js";
import { isVscodeGitApi } from "./vscodeGitApi.js";
import { getGitBranchNameValidationMessage } from "./gitRefName.js";
import { redactGitErrorMessage } from "./gitErrorFormatting.js";

export type GitWorktreeRootBindingResolver = (
  repositoryRootPath: string,
  expectedIdentity?: GitRootBindingIdentity,
  resolutionOptions?: GitRootBindingResolutionOptions,
) => Promise<GitRootBindingIdentity>;

export type GitWorktreePathBindingResolver = (
  targetPath: string,
  expectedIdentity?: GitDirectoryBindingIdentity,
) => Promise<GitDirectoryBindingIdentity>;

export type GitExecutablePathResolver = () => Promise<string | undefined>;

/** Reads the executable selected by VS Code's bundled Git extension. */
export async function resolveBundledGitExecutablePath(): Promise<string> {
  const configuredGitExecutablePath = readConfiguredGitExecutablePath();
  if (configuredGitExecutablePath !== undefined)
    return configuredGitExecutablePath;

  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (gitExtension === undefined) {
    throw new GitOperationError(
      "worktree",
      "VS Code's bundled Git extension is unavailable; worktree operations are disabled.",
    );
  }
  const extensionExports: unknown = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();
  if (!isVscodeGitApi(extensionExports)) {
    throw new GitOperationError(
      "worktree",
      "VS Code's bundled Git extension did not expose its public API.",
    );
  }
  if (!extensionExports.enabled) {
    throw new GitOperationError(
      "worktree",
      "VS Code's bundled Git extension is disabled; worktree operations are disabled.",
    );
  }
  let gitApi: unknown;
  try {
    gitApi = extensionExports.getAPI(1);
  } catch (error: unknown) {
    throw new GitOperationError(
      "worktree",
      "VS Code's bundled Git extension did not expose its public API.",
      { cause: error },
    );
  }
  const gitExecutablePath = readPublicGitExecutablePath(gitApi);
  if (
    typeof gitExecutablePath !== "string" ||
    gitExecutablePath.trim().length === 0 ||
    !path.isAbsolute(gitExecutablePath)
  ) {
    throw new GitOperationError(
      "worktree",
      "VS Code's bundled Git extension did not provide a usable Git executable path.",
    );
  }
  return gitExecutablePath;
}

export {
  buildWorktreeAddArguments,
  parseWorktreeList,
} from "./gitWorktreeParser.js";

export class GitWorktreeService {
  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly workspaceTrustGuard: Pick<
      WorkspaceTrustGuard,
      "isWorkspaceTrusted" | "assertTrusted"
    >,
    private readonly nativeCommandExecutor: NativeVscodeCommandExecutor = new VscodeNativeCommandExecutor(),
    private readonly localGitInteraction: LocalGitInteraction = new VscodeLocalGitInteraction(),
    private readonly repositoryDiscovery?: RepositoryDiscovery,
    private readonly rootBindingResolver: GitWorktreeRootBindingResolver = resolveGitRootBinding,
    private readonly pathBindingResolver: GitWorktreePathBindingResolver = resolveFilesystemPathBinding,
    private readonly gitExecutablePathResolver: GitExecutablePathResolver = () =>
      Promise.resolve(undefined),
  ) {}

  public async listWorktrees(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
  ): Promise<readonly LocalGitWorktree[]> {
    try {
      const gitExecutablePath = await this.resolveGitExecutablePath();
      const rootBinding = await this.captureRepositoryRootBinding(
        repositoryRoot,
        gitExecutablePath,
      );
      const commandOutput = await this.gitCommandRunner.run({
        repositoryRoot: repositoryRoot.fsPath,
        arguments: ["worktree", "list", "--porcelain"],
        cancellationSignal,
        rootBinding,
        rootBindingRequired: true,
        gitExecutablePath,
      });
      return parseWorktreeList(commandOutput.standardOutput);
    } catch (error: unknown) {
      if (error instanceof GitOperationError) throw error;
      if (isAbortError(error)) throw asError(error);
      throw new GitOperationError(
        "list worktrees",
        redactGitErrorMessage(getGitErrorMessage(error)),
        { cause: error },
      );
    }
  }

  public async createWorktree(
    repositoryRoot: vscode.Uri,
    worktreePath: string,
    options: GitWorktreeCreationOptions = {},
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    assertWorktreePath(worktreePath);
    if (cancellationSignal?.aborted) {
      throw new DOMException("Git worktree creation cancelled", "AbortError");
    }
    if (options.branchName !== undefined) {
      const branchValidationMessage = getGitBranchNameValidationMessage(
        options.branchName,
      );
      if (branchValidationMessage !== undefined) {
        throw new GitOperationError("create worktree", branchValidationMessage);
      }
    }
    if (options.createBranch && options.branchName === undefined) {
      throw new GitOperationError(
        "create worktree",
        "A branch name is required when creating a branch for a worktree.",
      );
    }
    let worktreeAddArguments: readonly string[];
    try {
      worktreeAddArguments = buildWorktreeAddArguments(worktreePath, options);
    } catch (error: unknown) {
      throw new GitOperationError(
        "create worktree",
        error instanceof Error
          ? error.message
          : "Worktree branch options are invalid.",
        { cause: error },
      );
    }
    const gitExecutablePath = await this.resolveGitExecutablePath();
    const repositoryBinding = await this.captureRepositoryRootBinding(
      repositoryRoot,
      gitExecutablePath,
    );
    const targetBinding = await this.captureWorktreeTargetBinding(worktreePath);
    await this.runBoundWorktreeMutation(
      "create worktree",
      repositoryRoot,
      repositoryBinding,
      targetBinding,
      worktreeAddArguments,
      gitExecutablePath,
      cancellationSignal,
    );
  }

  public async removeWorktree(
    repositoryRoot: vscode.Uri,
    worktreePath: string,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    assertWorktreePath(worktreePath);
    const gitExecutablePath = await this.resolveGitExecutablePath();
    const repositoryBinding = await this.captureRepositoryRootBinding(
      repositoryRoot,
      gitExecutablePath,
    );
    const listedWorktrees = await this.listWorktrees(
      repositoryRoot,
      cancellationSignal,
    );
    const selectedWorktree = listedWorktrees.find(
      (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath),
    );
    if (selectedWorktree === undefined) {
      throw new GitOperationError(
        "remove worktree",
        "The selected worktree is no longer registered.",
      );
    }
    if (
      path.resolve(selectedWorktree.path) ===
      path.resolve(repositoryRoot.fsPath)
    ) {
      throw new GitOperationError(
        "remove worktree",
        "The main repository worktree cannot be removed.",
      );
    }
    if (selectedWorktree.isLocked) {
      throw new GitOperationError(
        "remove worktree",
        "Locked worktrees cannot be removed in Git'o.",
      );
    }
    if (selectedWorktree.isPrunable) {
      throw new GitOperationError(
        "remove worktree",
        "Prunable worktrees require manual Git maintenance and cannot be removed here.",
      );
    }
    const hasWorktreeChanges = await this.hasWorktreeChanges(
      selectedWorktree.path,
      cancellationSignal,
    );
    if (hasWorktreeChanges) {
      throw new GitOperationError(
        "remove worktree",
        "Only clean worktrees can be removed. Commit or discard its changes first.",
      );
    }
    const targetBinding = await this.captureWorktreeTargetBinding(
      selectedWorktree.path,
    );
    const confirmed = await this.localGitInteraction.confirm(
      `Remove clean worktree ${selectedWorktree.path}?`,
      "Remove Worktree",
    );
    if (!confirmed) return;
    const currentWorktrees = await this.listWorktrees(
      repositoryRoot,
      cancellationSignal,
    );
    const revalidatedWorktree = currentWorktrees.find(
      (worktree) => worktree.path === selectedWorktree.path,
    );
    if (
      revalidatedWorktree === undefined ||
      revalidatedWorktree.headSha !== selectedWorktree.headSha ||
      revalidatedWorktree.branchName !== selectedWorktree.branchName ||
      revalidatedWorktree.isLocked !== selectedWorktree.isLocked ||
      revalidatedWorktree.isPrunable !== selectedWorktree.isPrunable
    ) {
      throw new GitOperationError(
        "remove worktree",
        "The selected worktree changed while confirmation was open. Refresh and try again.",
      );
    }
    if (revalidatedWorktree.isLocked) {
      throw new GitOperationError(
        "remove worktree",
        "The worktree became locked while confirmation was open. Refresh and try again.",
      );
    }
    if (revalidatedWorktree.isPrunable) {
      throw new GitOperationError(
        "remove worktree",
        "The worktree became prunable while confirmation was open. Refresh and try again.",
      );
    }
    if (
      await this.hasWorktreeChanges(
        revalidatedWorktree.path,
        cancellationSignal,
      )
    ) {
      throw new GitOperationError(
        "remove worktree",
        "The worktree changed while confirmation was open. Refresh and try again.",
      );
    }
    await this.runBoundWorktreeMutation(
      "remove worktree",
      repositoryRoot,
      repositoryBinding,
      targetBinding,
      ["worktree", "remove", revalidatedWorktree.path],
      gitExecutablePath,
      cancellationSignal,
    );
  }

  private async hasWorktreeChanges(
    worktreePath: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const gitExecutablePath = await this.resolveGitExecutablePath();
      const statusOutput = await this.gitCommandRunner.run({
        repositoryRoot: worktreePath,
        arguments: [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--ignored",
        ],
        cancellationSignal,
        rootBinding: await this.rootBindingResolver(worktreePath, undefined, {
          gitExecutablePath,
        }),
        rootBindingRequired: true,
        gitExecutablePath,
      });
      return statusOutput.standardOutput.trim().length > 0;
    } catch (error: unknown) {
      if (isAbortError(error)) throw asError(error);
      throw new GitOperationError(
        "inspect worktree",
        redactGitErrorMessage(getGitErrorMessage(error)),
        { cause: error },
      );
    }
  }

  public async openWorktree(
    repositoryRoot: vscode.Uri,
    worktreePath: string,
  ): Promise<void> {
    assertWorktreePath(worktreePath);
    if (
      this.repositoryDiscovery !== undefined &&
      (await this.findRepositoryApi(repositoryRoot)) === undefined
    ) {
      throw new GitOperationError(
        "open worktree",
        "The selected repository is no longer open. Refresh and try again.",
      );
    }
    const listedWorktrees = await this.listWorktrees(repositoryRoot);
    const selectedWorktree = listedWorktrees.find(
      (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath),
    );
    if (selectedWorktree === undefined) {
      throw new GitOperationError(
        "open worktree",
        "The selected worktree is not registered for the selected repository.",
      );
    }
    await this.nativeCommandExecutor.execute(
      "vscode.openFolder",
      worktreeUriForRepository(repositoryRoot, selectedWorktree.path),
      { forceNewWindow: true },
    );
  }

  private async findRepositoryApi(
    repositoryRoot: vscode.Uri,
  ): Promise<VscodeGitRepository | undefined> {
    if (this.repositoryDiscovery === undefined) return undefined;
    const gitApi = await this.repositoryDiscovery.getBundledGitApi();
    return gitApi.getRepository(repositoryRoot) ?? undefined;
  }

  private async captureRepositoryRootBinding(
    repositoryRoot: vscode.Uri,
    gitExecutablePath: string,
  ): Promise<GitRootBindingIdentity> {
    try {
      return await this.rootBindingResolver(repositoryRoot.fsPath, undefined, {
        gitExecutablePath,
      });
    } catch (error: unknown) {
      throw new GitOperationError(
        "worktree",
        "The repository could not be securely bound for worktree operation. Refresh and try again.",
        { cause: error },
      );
    }
  }

  private async assertRepositoryBinding(
    repositoryRoot: vscode.Uri,
    expectedIdentity: GitRootBindingIdentity,
    gitExecutablePath?: string,
  ): Promise<void> {
    try {
      await this.rootBindingResolver(
        repositoryRoot.fsPath,
        expectedIdentity,
        gitExecutablePath === undefined ? undefined : { gitExecutablePath },
      );
    } catch (error: unknown) {
      throw new GitOperationError(
        "worktree",
        "The repository identity changed during the worktree operation. Refresh and try again.",
        { cause: error },
      );
    }
  }

  private async captureWorktreeTargetBinding(
    worktreePath: string,
  ): Promise<WorktreeTargetBinding> {
    const parentPath = path.dirname(worktreePath);
    try {
      const parentIdentity = await this.pathBindingResolver(parentPath);
      let targetIdentity: GitDirectoryBindingIdentity | undefined;
      try {
        targetIdentity = await this.pathBindingResolver(worktreePath);
      } catch (error: unknown) {
        if (!isMissingPathError(error)) throw error;
      }
      return {
        targetPath: worktreePath,
        parentPath,
        parentIdentity,
        targetIdentity,
      };
    } catch (error: unknown) {
      throw new GitOperationError(
        "worktree",
        "The worktree target could not be securely bound. Refresh and try again.",
        { cause: error },
      );
    }
  }

  private async assertWorktreeTargetBinding(
    targetBinding: WorktreeTargetBinding,
  ): Promise<void> {
    await this.assertWorktreeTargetParentBinding(targetBinding);
    if (targetBinding.targetIdentity === undefined) return;
    try {
      await this.pathBindingResolver(
        targetBinding.targetPath,
        targetBinding.targetIdentity,
      );
    } catch (error: unknown) {
      throw new GitOperationError(
        "worktree",
        "The worktree target changed while the operation was pending. Refresh and try again.",
        { cause: error },
      );
    }
  }

  private async assertWorktreeTargetParentBinding(
    targetBinding: WorktreeTargetBinding,
  ): Promise<void> {
    try {
      await this.pathBindingResolver(
        targetBinding.parentPath,
        targetBinding.parentIdentity,
      );
    } catch (error: unknown) {
      throw new GitOperationError(
        "worktree",
        "The worktree target parent changed during the operation. Refresh and try again.",
        { cause: error },
      );
    }
  }

  private assertWorkspaceTrusted(operationName: string): void {
    if (this.workspaceTrustGuard.isWorkspaceTrusted() !== true) {
      throw new GitOperationError(
        operationName,
        `Cannot ${operationName} in an untrusted workspace. Trust the workspace and try again.`,
      );
    }
    this.workspaceTrustGuard.assertTrusted(operationName);
  }

  private async runBoundWorktreeMutation(
    operationName: string,
    repositoryRoot: vscode.Uri,
    repositoryBinding: GitRootBindingIdentity,
    targetBinding: WorktreeTargetBinding,
    argumentsPassed: readonly string[],
    gitExecutablePath: string,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    let mutationError: unknown;
    try {
      if (
        repositoryRoot.scheme !== "file" ||
        (repositoryRoot.authority ?? "") !== ""
      ) {
        throw new GitOperationError(
          operationName,
          "Native Git worktree mutations require a desktop file repository.",
        );
      }
      this.assertWorkspaceTrusted(operationName);
      await this.assertRepositoryBinding(
        repositoryRoot,
        repositoryBinding,
        gitExecutablePath,
      );
      await this.assertWorktreeTargetBinding(targetBinding);
      // Root and target checks are asynchronous; trust must be checked again
      // immediately before the native Git mutation.
      this.assertWorkspaceTrusted(operationName);
      await this.gitCommandRunner.run({
        repositoryRoot: repositoryRoot.fsPath,
        arguments: [...argumentsPassed],
        cancellationSignal,
        rootBinding: repositoryBinding,
        rootBindingRequired: true,
        literalPathspecs: true,
        gitExecutablePath,
      });
    } catch (error: unknown) {
      mutationError = error;
    }

    let verificationError: unknown;
    try {
      await this.assertRepositoryBinding(
        repositoryRoot,
        repositoryBinding,
        gitExecutablePath,
      );
      await this.assertWorktreeTargetParentBinding(targetBinding);
      if (
        mutationError === undefined &&
        operationName === "create worktree" &&
        targetBinding.targetIdentity === undefined
      ) {
        await this.pathBindingResolver(targetBinding.targetPath);
      }
    } catch (error: unknown) {
      verificationError = error;
    }
    if (mutationError !== undefined && isAbortError(mutationError)) {
      throw asError(mutationError);
    }
    if (verificationError !== undefined) {
      if (isAbortError(verificationError)) throw asError(verificationError);
      const verificationMessage =
        verificationError instanceof GitOperationError
          ? verificationError.userMessage
          : "The repository or worktree target changed during the operation. Refresh and try again.";
      throw new GitOperationError(operationName, verificationMessage, {
        cause: verificationError,
      });
    }
    if (mutationError !== undefined) {
      throw new GitOperationError(
        operationName,
        redactGitErrorMessage(getGitErrorMessage(mutationError)),
        { cause: mutationError },
      );
    }
  }

  private async resolveGitExecutablePath(): Promise<string> {
    const gitExecutablePath = await this.gitExecutablePathResolver();
    if (
      gitExecutablePath === undefined ||
      gitExecutablePath.trim().length === 0
    ) {
      throw new GitOperationError(
        "worktree",
        "The bundled Git extension did not provide a usable Git executable path.",
      );
    }
    return gitExecutablePath;
  }
}

interface BundledGitPublicApi {
  readonly git?: {
    readonly path?: unknown;
  };
}

function readPublicGitExecutablePath(gitApi: unknown): string | undefined {
  if (typeof gitApi !== "object" || gitApi === null) return undefined;
  const publicApi = gitApi as BundledGitPublicApi;
  if (typeof publicApi.git !== "object" || publicApi.git === null)
    return undefined;
  return typeof publicApi.git.path === "string"
    ? publicApi.git.path
    : undefined;
}

function readConfiguredGitExecutablePath(): string | undefined {
  const workspace = vscode.workspace as typeof vscode.workspace & {
    getConfiguration?: typeof vscode.workspace.getConfiguration;
  };
  if (typeof workspace.getConfiguration !== "function") return undefined;
  const configuredGitPath = workspace
    .getConfiguration("git")
    .get<unknown>("path");
  if (
    typeof configuredGitPath !== "string" ||
    configuredGitPath.trim().length === 0 ||
    !path.isAbsolute(configuredGitPath)
  )
    return undefined;
  return configuredGitPath;
}

function worktreeUriForRepository(
  repositoryRoot: vscode.Uri,
  worktreePath: string,
): vscode.Uri {
  return repositoryRoot.with({ path: worktreePath });
}

function getGitErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Git worktree operation failed. Check the repository and try again.";
}

function assertWorktreePath(worktreePath: string): void {
  if (!path.isAbsolute(worktreePath) || worktreePath.trim() !== worktreePath) {
    throw new GitOperationError(
      "worktree",
      "Worktree path must be an absolute path without surrounding whitespace.",
    );
  }
}

interface WorktreeTargetBinding {
  readonly targetPath: string;
  readonly parentPath: string;
  readonly parentIdentity: GitDirectoryBindingIdentity;
  readonly targetIdentity: GitDirectoryBindingIdentity | undefined;
}

async function resolveFilesystemPathBinding(
  targetPath: string,
  expectedIdentity?: GitDirectoryBindingIdentity,
): Promise<GitDirectoryBindingIdentity> {
  const canonicalPath = await realpath(targetPath);
  const directoryStats = await stat(canonicalPath, { bigint: true });
  if (!directoryStats.isDirectory())
    throw new Error("Worktree target binding is not a directory.");
  const identity = {
    canonicalPath,
    device: String(directoryStats.dev),
    inode: String(directoryStats.ino),
  } satisfies GitDirectoryBindingIdentity;
  if (
    expectedIdentity !== undefined &&
    (identity.canonicalPath !== expectedIdentity.canonicalPath ||
      identity.device !== expectedIdentity.device ||
      identity.inode !== expectedIdentity.inode)
  ) {
    throw new Error("Worktree target identity changed.");
  }
  return identity;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
