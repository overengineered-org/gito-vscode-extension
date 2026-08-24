import * as vscode from "vscode";
import * as path from "node:path";
import {
  RepositoryDiscovery,
  type RepositorySelectionContext,
} from "../repositories/repositoryDiscovery.js";
import {
  createLocalGitChange,
  createRepositoryRelativePathResolver,
  gitStatus,
  normalizeVscodeGitBranch,
  type LocalGitBranch,
  type LocalGitChange,
  type LocalGitChangesSnapshot,
  type LocalGitRepositoryHealth,
} from "./localGitModels.js";
import { getGitBranchNameValidationMessage } from "./gitRefName.js";
import { redactGitErrorMessage } from "./gitErrorFormatting.js";
import { RefType } from "./vscodeGitApi.js";
import type {
  VscodeGitBranch,
  VscodeGitRef,
  VscodeGitRepository,
  VscodeGitResourceState,
} from "./vscodeGitApi.js";
import {
  buildDiscardConfirmationMessage,
  captureDiscardChangeFileBindings,
  discardChangeFileBindingsMatch,
  resolveDiscardChanges,
} from "./discardChangeSafety.js";
import {
  isAbortError,
  type GitRootBindingIdentity,
} from "./gitCommandRunner.js";
import type { GitRootBindingResolver } from "./gitRootBindingResolver.js";
import type { WorkspaceTrustGuard } from "../security/workspaceTrustGuard.js";

export type RepositoryRootBindingResolver = GitRootBindingResolver["resolve"];

export interface LocalGitChangesSnapshotOptions {
  readonly refreshStatus?: boolean;
}

export interface LocalGitRepositoryHealthOptions {
  readonly refreshStatus?: boolean;
}

export interface NativeVscodeCommandExecutor {
  execute(
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ): Promise<unknown>;
}

export interface LocalGitBranchExpectation {
  readonly branchName: string;
  readonly branchCommit?: string;
}

export interface LocalGitInteraction {
  confirm(
    message: string,
    confirmLabel: string,
    cancelLabel?: string,
  ): Promise<boolean>;
  confirmSmartCommit(): Promise<boolean>;
}

export class VscodeNativeCommandExecutor implements NativeVscodeCommandExecutor {
  public execute(
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ): Promise<unknown> {
    return Promise.resolve(
      vscode.commands.executeCommand(commandIdentifier, ...argumentsPassed),
    );
  }
}

export class VscodeLocalGitInteraction implements LocalGitInteraction {
  public async confirm(
    message: string,
    confirmLabel: string,
    cancelLabel = "Cancel",
  ): Promise<boolean> {
    const selectedLabel = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      confirmLabel,
      cancelLabel,
    );
    return selectedLabel === confirmLabel;
  }

  public async confirmSmartCommit(): Promise<boolean> {
    const selectedLabel = await vscode.window.showInformationMessage(
      "No changes are staged. Stage all changes and commit?",
      "Stage all and commit",
      "Cancel",
    );
    return selectedLabel === "Stage all and commit";
  }
}

export class GitOperationError extends Error {
  public constructor(
    public readonly operationName: string,
    public readonly userMessage: string,
    options?: { readonly cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = "GitOperationError";
  }
}

/** Local Git actions backed by the bundled VS Code Git repository API. */
export class LocalGitRepositoryService {
  private readonly nativeCommandExecutor: NativeVscodeCommandExecutor;
  private readonly localGitInteraction: LocalGitInteraction;
  private readonly lastSuccessfulFetchAtByRepository = new WeakMap<
    VscodeGitRepository,
    string
  >();

  public constructor(
    private readonly repositoryDiscovery: Pick<
      RepositoryDiscovery,
      "selectRepository"
    >,
    private readonly workspaceTrustGuard: Pick<
      WorkspaceTrustGuard,
      "isWorkspaceTrusted" | "assertTrusted"
    >,
    nativeCommandExecutor: NativeVscodeCommandExecutor = new VscodeNativeCommandExecutor(),
    localGitInteraction: LocalGitInteraction = new VscodeLocalGitInteraction(),
    private readonly repositoryRootBindingResolver?: RepositoryRootBindingResolver,
  ) {
    this.nativeCommandExecutor = nativeCommandExecutor;
    this.localGitInteraction = localGitInteraction;
  }

  public async getChangesSnapshot(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
    options: LocalGitChangesSnapshotOptions = {},
  ): Promise<LocalGitChangesSnapshot> {
    const repository = await this.selectRepository(selectionContext);
    if (options.refreshStatus === true)
      await this.refreshRepositoryStatus(repository);
    const relativePathResolver = createRepositoryRelativePathResolver(
      repository.rootUri,
    );
    const createChanges = (
      group: "mergeChanges" | "stagedChanges" | "changes" | "untracked",
      resourceStates: readonly VscodeGitResourceState[],
    ): readonly LocalGitChange[] =>
      resourceStates.map((resourceState) =>
        createLocalGitChange(
          repository.rootUri,
          group,
          resourceState,
          relativePathResolver,
        ),
      );
    const mergeChanges = createChanges(
      "mergeChanges",
      repository.state.mergeChanges,
    );
    const stagedChanges = createChanges(
      "stagedChanges",
      repository.state.indexChanges,
    );
    const changes = createChanges(
      "changes",
      repository.state.workingTreeChanges.filter(
        (resourceState) => resourceState.status !== gitStatus.UNTRACKED,
      ),
    );
    const untrackedResourceStates = [
      ...repository.state.untrackedChanges,
      ...repository.state.workingTreeChanges.filter(
        (resourceState) => resourceState.status === gitStatus.UNTRACKED,
      ),
    ];
    const untrackedByRelativePath = new Map<string, LocalGitChange>();
    for (const currentChange of createChanges(
      "untracked",
      untrackedResourceStates,
    )) {
      const canonicalPath = canonicalRelativePath(currentChange.relativePath);
      const existingChange = untrackedByRelativePath.get(canonicalPath);
      if (
        existingChange === undefined ||
        (existingChange.status === gitStatus.IGNORED &&
          currentChange.status === gitStatus.UNTRACKED)
      ) {
        untrackedByRelativePath.set(canonicalPath, currentChange);
      }
    }
    const untracked = [...untrackedByRelativePath.values()];
    return {
      repositoryRoot: repository.rootUri,
      mergeChanges,
      stagedChanges,
      changes,
      untracked,
      totalChangeCount:
        mergeChanges.length +
        stagedChanges.length +
        changes.length +
        untracked.length,
    };
  }

  public async getRepositoryRoot(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<vscode.Uri> {
    const repository = await this.selectRepository(selectionContext);
    const mainWorktree = repository.state.worktrees.find(
      (worktree) => worktree.main,
    );
    return mainWorktree === undefined
      ? repository.rootUri
      : withRepositoryFilesystemPath(repository.rootUri, mainWorktree.path);
  }

  public async getRepositorySelectionContext(
    selectionContext?: RepositorySelectionContext,
  ): Promise<RepositorySelectionContext> {
    const repository = await this.selectRepository(selectionContext);
    return {
      selectedRepositoryRoot: repository.rootUri,
      expectedRepository: repository,
    };
  }

  public async getCommitInputValue(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<string> {
    return (await this.selectRepository(selectionContext)).inputBox.value;
  }

  public async setCommitInputValue(
    commitMessage: string,
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    (await this.selectRepository(selectionContext)).inputBox.value =
      commitMessage;
  }

  public async getRepositoryHealth(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
    options: LocalGitRepositoryHealthOptions = {},
  ): Promise<LocalGitRepositoryHealth> {
    const repository = await this.selectRepository(selectionContext);
    const changesSnapshot = await this.getChangesSnapshot(
      {
        selectedRepositoryRoot: repository.rootUri,
        expectedRepository: repository,
      },
      { refreshStatus: options.refreshStatus ?? true },
    );
    const headState = repository.state.HEAD;
    const lastSuccessfulFetchAt =
      this.lastSuccessfulFetchAtByRepository.get(repository);
    return {
      branchName: headState?.name ?? "(detached HEAD)",
      ...(headState?.upstream?.name === undefined
        ? {}
        : { upstreamBranchName: headState.upstream.name }),
      aheadCount: headState?.ahead ?? 0,
      behindCount: headState?.behind ?? 0,
      uncommittedChangeCount: changesSnapshot.totalChangeCount,
      ...(headState?.commit === undefined
        ? {}
        : { headCommit: headState.commit }),
      ...(lastSuccessfulFetchAt === undefined ? {} : { lastSuccessfulFetchAt }),
    };
  }

  public async stageChanges(
    changes: readonly LocalGitChange[],
    selectionContext?: RepositorySelectionContext,
  ): Promise<void> {
    if (changes.length === 0) return;
    const firstChange = changes[0];
    if (firstChange === undefined) return;
    const repository = await this.selectRepository(
      selectionContext ?? { activeEditorUri: firstChange.resourceUri },
    );
    await this.refreshRepositoryStatus(repository);
    assertChangesBelongToRepository(repository.rootUri, changes);
    const changesSnapshot = await this.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
      expectedRepository: repository,
    });
    const eligibleChanges = resolveCurrentActionChanges(
      changesSnapshot,
      changes,
      "stage",
    );
    await this.runRepositoryMutation(
      "stage changes",
      repository.rootUri,
      () => repository.add(uniqueAbsoluteResourcePaths(eligibleChanges)),
      repository,
    );
  }

  public async stageAll(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.refreshRepositoryStatus(repository);
    const relativePathResolver = createRepositoryRelativePathResolver(
      repository.rootUri,
    );
    const stageAllChanges = [
      ...repository.state.mergeChanges.filter(
        (resourceState) => resourceState.status !== gitStatus.IGNORED,
      ),
      ...repository.state.workingTreeChanges.filter(
        (resourceState) => resourceState.status !== gitStatus.IGNORED,
      ),
      ...repository.state.untrackedChanges.filter(
        (resourceState) => resourceState.status !== gitStatus.IGNORED,
      ),
    ].map((resourceState) =>
      createLocalGitChange(
        repository.rootUri,
        "changes",
        resourceState,
        relativePathResolver,
      ),
    );
    if (stageAllChanges.length === 0) return;
    await this.runRepositoryMutation(
      "stage all changes",
      repository.rootUri,
      () => repository.add(uniqueAbsoluteResourcePaths(stageAllChanges)),
      repository,
    );
  }

  public async unstageChanges(
    changes: readonly LocalGitChange[],
    selectionContext?: RepositorySelectionContext,
  ): Promise<void> {
    if (changes.length === 0) return;
    const firstChange = changes[0];
    if (firstChange === undefined) return;
    const repository = await this.selectRepository(
      selectionContext ?? { activeEditorUri: firstChange.resourceUri },
    );
    await this.refreshRepositoryStatus(repository);
    assertChangesBelongToRepository(repository.rootUri, changes);
    const changesSnapshot = await this.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
      expectedRepository: repository,
    });
    const eligibleChanges = resolveCurrentActionChanges(
      changesSnapshot,
      changes,
      "unstage",
    );
    await this.runRepositoryMutation(
      "unstage changes",
      repository.rootUri,
      () =>
        repository.restore(uniqueAbsoluteResourcePaths(eligibleChanges), {
          staged: true,
        }),
      repository,
    );
  }

  public async unstageAll(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.refreshRepositoryStatus(repository);
    const relativePathResolver = createRepositoryRelativePathResolver(
      repository.rootUri,
    );
    const stagedChanges = repository.state.indexChanges.map((resourceState) =>
      createLocalGitChange(
        repository.rootUri,
        "stagedChanges",
        resourceState,
        relativePathResolver,
      ),
    );
    if (stagedChanges.length === 0) return;
    await this.runRepositoryMutation(
      "unstage all changes",
      repository.rootUri,
      () =>
        repository.restore(uniqueAbsoluteResourcePaths(stagedChanges), {
          staged: true,
        }),
      repository,
    );
  }

  public async discardChanges(
    changes: readonly LocalGitChange[],
    selectionContext?: RepositorySelectionContext,
  ): Promise<void> {
    if (changes.length === 0) return;
    const firstChange = changes[0];
    if (firstChange === undefined) return;
    const repository = await this.selectRepository(
      selectionContext ?? { activeEditorUri: firstChange.resourceUri },
    );
    await this.refreshRepositoryStatus(repository);
    assertChangesBelongToRepository(repository.rootUri, changes);
    const currentChangesSnapshot = await this.getChangesSnapshot({
      selectedRepositoryRoot: repository.rootUri,
      expectedRepository: repository,
    });
    const discardResolution = resolveDiscardChanges(
      currentChangesSnapshot,
      changes,
    );
    if (discardResolution.rejectedChanges.length > 0) {
      throw new GitOperationError(
        "discard changes",
        "The selected changes are stale, staged, or outside the selected repository. Refresh changes and try again.",
      );
    }
    if (discardResolution.eligibleChanges.length === 0) return;
    const repositoryRootBinding = await this.captureRepositoryRootBinding(
      "discard changes",
      repository.rootUri,
    );
    const initialFileBindings = await captureDiscardChangeFileBindings(
      discardResolution.eligibleChanges,
    );
    const confirmed = await this.localGitInteraction.confirm(
      buildDiscardConfirmationMessage(discardResolution.eligibleChanges),
      "Discard Changes",
    );
    if (!confirmed) return;
    const latestChangesSnapshot = await this.getChangesSnapshot(
      {
        selectedRepositoryRoot: repository.rootUri,
        expectedRepository: repository,
      },
      { refreshStatus: true },
    );
    const latestDiscardResolution = resolveDiscardChanges(
      latestChangesSnapshot,
      changes,
    );
    if (latestDiscardResolution.rejectedChanges.length > 0) {
      throw new GitOperationError(
        "discard changes",
        "The selected changes changed while confirmation was open. Refresh changes and try again.",
      );
    }
    if (latestDiscardResolution.eligibleChanges.length === 0) return;
    const latestFileBindings = await captureDiscardChangeFileBindings(
      latestDiscardResolution.eligibleChanges,
    );
    if (
      !discardChangeFileBindingsMatch(initialFileBindings, latestFileBindings)
    ) {
      throw new GitOperationError(
        "discard changes",
        "The selected files changed while confirmation was open. Refresh and try again.",
      );
    }
    const trackedChanges = latestDiscardResolution.eligibleChanges.filter(
      (change) => change.group === "changes",
    );
    const untrackedChanges = latestDiscardResolution.eligibleChanges.filter(
      (change) => change.group === "untracked",
    );
    await this.runRepositoryMutation(
      "discard changes",
      repository.rootUri,
      async () => {
        if (trackedChanges.length > 0) {
          await repository.restore(uniqueAbsoluteResourcePaths(trackedChanges));
        }
        if (untrackedChanges.length > 0) {
          await repository.clean(uniqueAbsoluteResourcePaths(untrackedChanges));
        }
      },
      repository,
      undefined,
      repositoryRootBinding,
    );
  }

  public async commitStagedChanges(
    commitMessage: string,
    smartCommitEnabled: boolean,
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.refreshRepositoryStatus(repository);
    const normalizedCommitMessage = commitMessage.trim();
    if (normalizedCommitMessage.length === 0) {
      throw new GitOperationError("commit", "Enter a commit message first.");
    }
    const hasStagedChanges = repository.state.indexChanges.length > 0;
    if (!hasStagedChanges) {
      if (
        !smartCommitEnabled ||
        !(await this.localGitInteraction.confirmSmartCommit())
      ) {
        throw new GitOperationError(
          "commit",
          "Stage at least one change before committing.",
        );
      }
      const relativePathResolver = createRepositoryRelativePathResolver(
        repository.rootUri,
      );
      const smartCommitChanges = [
        ...repository.state.workingTreeChanges
          .filter((resourceState) => resourceState.status !== gitStatus.IGNORED)
          .map((resourceState) =>
            createLocalGitChange(
              repository.rootUri,
              "changes",
              resourceState,
              relativePathResolver,
            ),
          ),
        ...repository.state.untrackedChanges
          .filter((resourceState) => resourceState.status !== gitStatus.IGNORED)
          .map((resourceState) =>
            createLocalGitChange(
              repository.rootUri,
              "untracked",
              resourceState,
              relativePathResolver,
            ),
          ),
      ];
      await this.runRepositoryMutation(
        "stage all changes",
        repository.rootUri,
        () => repository.add(uniqueAbsoluteResourcePaths(smartCommitChanges)),
        repository,
      );
    }
    await this.runRepositoryMutation(
      "commit",
      repository.rootUri,
      async () => {
        repository.inputBox.value = commitMessage;
        await repository.commit(normalizedCommitMessage);
      },
      repository,
    );
  }

  public async fetch(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.runRepositoryMutation(
      "fetch",
      repository.rootUri,
      () => repository.fetch(),
      repository,
    );
    this.recordSuccessfulFetch(repository);
  }

  public async pull(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.runRepositoryMutation(
      "pull",
      repository.rootUri,
      () => repository.pull(),
      repository,
    );
    this.recordSuccessfulFetch(repository);
  }

  public async push(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.runRepositoryMutation(
      "push",
      repository.rootUri,
      () => repository.push(),
      repository,
    );
  }

  public async sync(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    await this.runRepositoryMutation(
      "sync fetch",
      repository.rootUri,
      () => repository.fetch(),
      repository,
    );
    await this.runRepositoryMutation(
      "sync pull",
      repository.rootUri,
      () => repository.pull(),
      repository,
    );
    await this.runRepositoryMutation(
      "sync push",
      repository.rootUri,
      () => repository.push(),
      repository,
    );
    this.recordSuccessfulFetch(repository);
  }

  public async openNativeDiff(
    resourceUri: vscode.Uri,
    selectionContext?: RepositorySelectionContext,
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    try {
      createRepositoryRelativePathResolver(repository.rootUri).resolve(
        resourceUri,
      );
    } catch {
      throw new GitOperationError(
        "open diff",
        "The selected file belongs to another repository. Refresh and try again.",
      );
    }
    await this.nativeCommandExecutor.execute("git.openChange", resourceUri);
  }

  public async listBranches(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<readonly LocalGitBranch[]> {
    const repository = await this.selectRepository(selectionContext);
    const branches = await this.runRepositoryOperation(
      "list branches",
      async () => {
        const [localBranches, remoteBranches] = await Promise.all([
          repository.getBranches({ remote: false }),
          repository.getBranches({ remote: true }),
        ]);
        const branchesByIdentity = new Map<string, VscodeGitRef>();
        for (const branch of [...localBranches, ...remoteBranches]) {
          if (branch.name !== undefined) {
            branchesByIdentity.set(
              `${branch.type}\u0000${branch.name}`,
              branch,
            );
          }
        }
        return [...branchesByIdentity.values()];
      },
    );
    const currentBranchName = repository.state.HEAD?.name;
    return branches
      .filter(
        (
          branch,
        ): branch is VscodeGitRef &
          VscodeGitBranch & { readonly name: string } =>
          branch.name !== undefined,
      )
      .map((branch) => normalizeVscodeGitBranch(branch, currentBranchName));
  }

  public async checkoutBranch(
    branchName: string,
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
    isRemoteBranch = false,
    cancellationSignal?: AbortSignal,
    expectedBranch?: LocalGitBranchExpectation,
  ): Promise<void> {
    assertGitRefName(branchName);
    throwIfGitOperationCancelled(cancellationSignal);
    const repository = await this.selectRepository(selectionContext);
    throwIfGitOperationCancelled(cancellationSignal);
    await this.assertBranchSelectionTarget(
      repository,
      branchName,
      isRemoteBranch,
      expectedBranch,
      "checkout branch",
    );
    if (isRemoteBranch) {
      const remoteSeparatorIndex = branchName.indexOf("/");
      const localBranchName =
        remoteSeparatorIndex < 0
          ? branchName
          : branchName.slice(remoteSeparatorIndex + 1);
      assertGitRefName(localBranchName);
      await this.runRepositoryMutation(
        `checkout ${branchName} as ${localBranchName}`,
        repository.rootUri,
        () => repository.createBranch(localBranchName, true, branchName),
        repository,
        cancellationSignal,
      );
      return;
    }
    await this.runRepositoryMutation(
      `checkout ${branchName}`,
      repository.rootUri,
      () => repository.checkout(branchName),
      repository,
      cancellationSignal,
    );
  }

  public async createBranch(
    branchName: string,
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<void> {
    assertGitRefName(branchName);
    const repository = await this.selectRepository(selectionContext);
    await this.runRepositoryMutation(
      `create branch ${branchName}`,
      repository.rootUri,
      () => repository.createBranch(branchName, true),
      repository,
    );
  }

  public async publishCurrentBranch(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
    expectedBranch?: LocalGitBranchExpectation,
  ): Promise<void> {
    const repository = await this.selectRepository(selectionContext);
    const branchName = repository.state.HEAD?.name;
    if (branchName === undefined) {
      throw new GitOperationError(
        "publish branch",
        "A detached HEAD cannot be published as a branch.",
      );
    }
    await this.assertCurrentBranchTarget(
      repository,
      branchName,
      expectedBranch,
    );
    await this.runRepositoryMutation(
      `publish branch ${branchName}`,
      repository.rootUri,
      () => repository.push(undefined, branchName, true),
      repository,
    );
  }

  public async deleteBranch(
    branchName: string,
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
    expectedBranch?: LocalGitBranchExpectation,
  ): Promise<void> {
    assertGitRefName(branchName);
    const repository = await this.selectRepository(selectionContext);
    const deletionTarget = await this.captureBranchDeletionTarget(
      repository,
      branchName,
      "delete branch",
      expectedBranch,
    );
    if (deletionTarget.currentBranchName === branchName) {
      throw new GitOperationError(
        "delete branch",
        "Checkout another branch before deleting the current branch.",
      );
    }
    const repositoryRootBinding = await this.captureRepositoryRootBinding(
      "delete branch",
      repository.rootUri,
    );
    const confirmed = await this.localGitInteraction.confirm(
      `Delete local branch ${branchName}?`,
      "Delete Branch",
    );
    if (!confirmed) return;
    await this.assertBranchDeletionTarget(
      repository,
      branchName,
      deletionTarget,
      "delete branch",
    );
    await this.runRepositoryMutation(
      `delete branch ${branchName}`,
      repository.rootUri,
      () => repository.deleteBranch(branchName, false),
      repository,
      undefined,
      repositoryRootBinding,
    );
  }

  public async forceDeleteBranch(
    branchName: string,
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
    expectedBranch?: LocalGitBranchExpectation,
  ): Promise<void> {
    assertGitRefName(branchName);
    const repository = await this.selectRepository(selectionContext);
    const deletionTarget = await this.captureBranchDeletionTarget(
      repository,
      branchName,
      "force delete branch",
      expectedBranch,
    );
    if (deletionTarget.currentBranchName === branchName) {
      throw new GitOperationError(
        "force delete branch",
        "Checkout another branch before deleting the current branch.",
      );
    }
    const repositoryRootBinding = await this.captureRepositoryRootBinding(
      "force delete branch",
      repository.rootUri,
    );
    const confirmed = await this.localGitInteraction.confirm(
      `Force-delete local branch ${branchName}? Unmerged commits may be lost.`,
      "Force Delete Branch",
    );
    if (!confirmed) return;
    await this.assertBranchDeletionTarget(
      repository,
      branchName,
      deletionTarget,
      "force delete branch",
    );
    await this.runRepositoryMutation(
      `force delete branch ${branchName}`,
      repository.rootUri,
      () => repository.deleteBranch(branchName, true),
      repository,
      undefined,
      repositoryRootBinding,
    );
  }

  private async selectRepository(
    selectionContext?: Parameters<RepositoryDiscovery["selectRepository"]>[0],
  ): Promise<VscodeGitRepository> {
    return this.repositoryDiscovery.selectRepository(selectionContext);
  }

  private async refreshRepositoryStatus(
    repository: VscodeGitRepository,
  ): Promise<void> {
    await this.runRepositoryOperation("refresh Git status", () =>
      repository.status(),
    );
  }

  private async runRepositoryOperation<OperationValue>(
    operationName: string,
    operation: () => Promise<OperationValue>,
  ): Promise<OperationValue> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof GitOperationError) throw error;
      if (isAbortError(error)) throw asError(error);
      const userMessage = formatGitErrorForUser(error);
      throw new GitOperationError(operationName, userMessage, { cause: error });
    }
  }

  private async runRepositoryMutation<MutationValue>(
    operationName: string,
    repositoryRoot: vscode.Uri,
    mutation: () => Promise<MutationValue>,
    expectedRepository: VscodeGitRepository,
    cancellationSignal?: AbortSignal,
    expectedRootBinding?: GitRootBindingIdentity,
  ): Promise<MutationValue> {
    throwIfGitOperationCancelled(cancellationSignal);
    this.assertWorkspaceTrusted(operationName);
    const rootBinding =
      expectedRootBinding ??
      (await this.captureRepositoryRootBinding(operationName, repositoryRoot));
    throwIfGitOperationCancelled(cancellationSignal);
    let mutationResult: MutationValue | undefined;
    let mutationError: unknown;
    try {
      throwIfGitOperationCancelled(cancellationSignal);
      await this.assertExpectedRepository(repositoryRoot, expectedRepository);
      if (rootBinding !== undefined) {
        await this.resolveRepositoryRootBinding(
          repositoryRoot.fsPath,
          rootBinding,
        );
      }
      throwIfGitOperationCancelled(cancellationSignal);
      // The repository API call is the mutation boundary. Re-check trust
      // after the asynchronous selection and binding checks immediately
      // before invoking the bundled Git implementation.
      this.assertWorkspaceTrusted(operationName);
      throwIfGitOperationCancelled(cancellationSignal);
      mutationResult = await mutation();
      throwIfGitOperationCancelled(cancellationSignal);
    } catch (error: unknown) {
      mutationError = error;
    }

    let verificationError: unknown;
    try {
      await this.assertExpectedRepository(repositoryRoot, expectedRepository);
      if (rootBinding !== undefined) {
        await this.resolveRepositoryRootBinding(
          repositoryRoot.fsPath,
          rootBinding,
        );
      }
    } catch (error: unknown) {
      verificationError = error;
    }
    if (mutationError !== undefined && isAbortError(mutationError)) {
      throw asError(mutationError);
    }
    if (verificationError !== undefined) {
      if (isAbortError(verificationError)) throw asError(verificationError);
      throw new GitOperationError(
        operationName,
        verificationError instanceof GitOperationError
          ? verificationError.userMessage
          : "The repository identity changed during the Git operation. Refresh and try again.",
        { cause: verificationError },
      );
    }
    if (mutationError !== undefined) {
      return this.runRepositoryOperation(operationName, () =>
        Promise.reject(asError(mutationError)),
      );
    }
    return mutationResult as MutationValue;
  }

  private async captureRepositoryRootBinding(
    operationName: string,
    repositoryRoot: vscode.Uri,
  ): Promise<GitRootBindingIdentity | undefined> {
    if (
      repositoryRoot.scheme !== "file" ||
      (repositoryRoot.authority ?? "") !== ""
    ) {
      return undefined;
    }
    try {
      return await this.resolveRepositoryRootBinding(repositoryRoot.fsPath);
    } catch (error: unknown) {
      throw new GitOperationError(
        operationName,
        "The repository could not be securely bound for mutation. Refresh and try again.",
        { cause: error },
      );
    }
  }

  private async resolveRepositoryRootBinding(
    repositoryRootPath: string,
    expectedIdentity?: GitRootBindingIdentity,
  ): Promise<GitRootBindingIdentity> {
    if (this.repositoryRootBindingResolver === undefined) {
      throw new Error(
        "Configured Git root binding resolver is unavailable; local Git mutation failed closed.",
      );
    }
    return this.repositoryRootBindingResolver(
      repositoryRootPath,
      expectedIdentity,
    );
  }

  private async assertExpectedRepository(
    repositoryRoot: vscode.Uri,
    expectedRepository: VscodeGitRepository,
  ): Promise<void> {
    // RepositoryDiscovery owns stable identity validation. VS Code's bundled
    // Git API creates a fresh wrapper for each repository lookup.
    await this.repositoryDiscovery.selectRepository({
      selectedRepositoryRoot: repositoryRoot,
      expectedRepository,
    });
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

  private recordSuccessfulFetch(repository: VscodeGitRepository): void {
    this.lastSuccessfulFetchAtByRepository.set(
      repository,
      new Date().toISOString(),
    );
  }

  private async captureBranchDeletionTarget(
    repository: VscodeGitRepository,
    branchName: string,
    operationName: string,
    expectedBranch?: LocalGitBranchExpectation,
  ): Promise<BranchDeletionTarget> {
    const [remoteBranches, localBranches] = await Promise.all([
      repository.getBranches({ remote: true }),
      repository.getBranches({ remote: false }),
    ]);
    const remoteBranch = remoteBranches.find(
      (branch) =>
        branch.type === RefType.RemoteHead && branch.name === branchName,
    );
    const localBranch = localBranches.find(
      (branch) => branch.type === RefType.Head && branch.name === branchName,
    );
    if (remoteBranch !== undefined && localBranch === undefined) {
      throw new GitOperationError(
        operationName,
        "Remote branches cannot be deleted from Git'o.",
      );
    }
    if (localBranch === undefined) {
      throw new GitOperationError(
        operationName,
        "The selected local branch no longer exists. Refresh and try again.",
      );
    }
    if (localBranch.commit === undefined || localBranch.commit.trim() === "") {
      throw new GitOperationError(
        operationName,
        "Git did not provide the selected branch commit. Refresh and try again before deleting it.",
      );
    }
    if (
      expectedBranch !== undefined &&
      (expectedBranch.branchName !== branchName ||
        (expectedBranch.branchCommit !== undefined &&
          localBranch.commit !== expectedBranch.branchCommit))
    ) {
      throw new GitOperationError(
        operationName,
        "The selected branch changed before confirmation. Refresh and try again.",
      );
    }
    return {
      commit: localBranch.commit,
      currentBranchName: repository.state.HEAD?.name,
    };
  }

  private async assertBranchSelectionTarget(
    repository: VscodeGitRepository,
    branchName: string,
    isRemoteBranch: boolean,
    expectedBranch: LocalGitBranchExpectation | undefined,
    operationName: string,
  ): Promise<void> {
    if (expectedBranch === undefined) return;
    if (expectedBranch.branchName !== branchName) {
      throw new GitOperationError(
        operationName,
        "The selected branch name changed. Refresh and try again.",
      );
    }
    const branchRefs = await repository.getBranches({ remote: isRemoteBranch });
    const currentBranch = branchRefs.find(
      (branch) =>
        (isRemoteBranch
          ? branch.type === RefType.RemoteHead
          : branch.type === RefType.Head) && branch.name === branchName,
    );
    if (
      currentBranch === undefined ||
      (expectedBranch.branchCommit !== undefined &&
        currentBranch.commit !== expectedBranch.branchCommit)
    ) {
      throw new GitOperationError(
        operationName,
        "The selected branch changed. Refresh and try again.",
      );
    }
  }

  private async assertCurrentBranchTarget(
    repository: VscodeGitRepository,
    branchName: string,
    expectedBranch: LocalGitBranchExpectation | undefined,
  ): Promise<void> {
    if (expectedBranch === undefined) return;
    if (expectedBranch.branchName !== branchName) {
      throw new GitOperationError(
        "publish branch",
        "The selected branch name changed. Refresh and try again.",
      );
    }
    const localBranches = await repository.getBranches({ remote: false });
    const currentBranch = localBranches.find(
      (branch) =>
        branch.type === RefType.Head &&
        branch.name === expectedBranch.branchName,
    );
    if (
      currentBranch === undefined ||
      (expectedBranch.branchCommit !== undefined &&
        currentBranch.commit !== expectedBranch.branchCommit)
    ) {
      throw new GitOperationError(
        "publish branch",
        "The selected branch changed. Refresh and try again.",
      );
    }
  }

  private async assertBranchDeletionTarget(
    repository: VscodeGitRepository,
    branchName: string,
    deletionTarget: BranchDeletionTarget,
    operationName: string,
  ): Promise<void> {
    if (repository.state.HEAD?.name !== deletionTarget.currentBranchName) {
      throw new GitOperationError(
        operationName,
        "The repository branch changed while confirmation was open. Refresh and try again.",
      );
    }
    const localBranches = await repository.getBranches({ remote: false });
    const currentBranch = localBranches.find(
      (branch) => branch.type === RefType.Head && branch.name === branchName,
    );
    if (
      currentBranch === undefined ||
      currentBranch.commit === undefined ||
      currentBranch.commit.trim() === "" ||
      currentBranch.commit !== deletionTarget.commit
    ) {
      throw new GitOperationError(
        operationName,
        "The selected branch changed while confirmation was open. Refresh and try again.",
      );
    }
  }
}

interface BranchDeletionTarget {
  readonly commit: string;
  readonly currentBranchName: string | undefined;
}

function withRepositoryFilesystemPath(
  repositoryRoot: vscode.Uri,
  filesystemPath: string,
): vscode.Uri {
  return repositoryRoot.with({ path: filesystemPath });
}

/**
 * The bundled Git public adapter converts each mutation string with
 * `Uri.file`. Relative strings therefore become root-level paths such as
 * `/change.txt`; only pass absolute filesystem paths at this boundary.
 * Callers resolve current API resource states first, so this preserves
 * aliases and tracked symlink leaves without following them.
 */
function uniqueAbsoluteResourcePaths(
  changes: readonly LocalGitChange[],
): string[] {
  return [
    ...new Set(
      changes.map((change) => {
        if (!path.isAbsolute(change.resourceUri.fsPath)) {
          throw new GitOperationError(
            "local changes",
            "The selected Git resource did not provide an absolute filesystem path. Refresh changes and try again.",
          );
        }
        return change.resourceUri.fsPath;
      }),
    ),
  ];
}

function canonicalRelativePath(relativePath: string): string {
  if (process.platform !== "win32") return path.posix.normalize(relativePath);
  return path.posix
    .normalize(relativePath.replaceAll("\\", "/"))
    .toLocaleLowerCase("en-US");
}

function resolveCurrentActionChanges(
  currentChangesSnapshot: LocalGitChangesSnapshot,
  requestedChanges: readonly LocalGitChange[],
  changeAction: "stage" | "unstage",
): readonly LocalGitChange[] {
  const eligibleChanges =
    changeAction === "stage"
      ? [
          ...currentChangesSnapshot.mergeChanges.filter(
            (change) => change.status !== gitStatus.IGNORED,
          ),
          ...currentChangesSnapshot.changes.filter(
            (change) => change.status !== gitStatus.IGNORED,
          ),
          ...currentChangesSnapshot.untracked.filter(
            (change) => change.status !== gitStatus.IGNORED,
          ),
        ]
      : [...currentChangesSnapshot.stagedChanges];
  const eligibleByIdentity = new Map(
    eligibleChanges.map((change) => [
      getLocalGitChangeIdentity(change),
      change,
    ]),
  );
  const resolvedChanges: LocalGitChange[] = [];
  const seenIdentities = new Set<string>();
  for (const requestedChange of requestedChanges) {
    const changeIdentity = getLocalGitChangeIdentity(requestedChange);
    const currentChange = eligibleByIdentity.get(changeIdentity);
    if (currentChange === undefined) {
      throw new GitOperationError(
        `${changeAction} changes`,
        "The selected changes are stale or outside the selected repository. Refresh changes and try again.",
      );
    }
    if (!seenIdentities.has(changeIdentity)) {
      seenIdentities.add(changeIdentity);
      resolvedChanges.push(currentChange);
    }
  }
  return resolvedChanges;
}

function getLocalGitChangeIdentity(change: LocalGitChange): string {
  return (
    change.changeId ??
    `${change.group}\u0000${String(change.status)}\u0000${change.resourceUri.toString()}`
  );
}

function assertChangesBelongToRepository(
  repositoryRoot: vscode.Uri,
  changes: readonly LocalGitChange[],
): void {
  const relativePathResolver =
    createRepositoryRelativePathResolver(repositoryRoot);
  if (
    changes.some((change) => {
      const normalizedRelativePath = path.normalize(change.relativePath);
      if (
        normalizedRelativePath === ".." ||
        normalizedRelativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(normalizedRelativePath)
      ) {
        return true;
      }
      try {
        relativePathResolver.resolve(change.resourceUri);
      } catch {
        return true;
      }
      return false;
    })
  ) {
    throw new GitOperationError(
      "local changes",
      "The selected changes belong to another repository. Refresh changes and try again.",
    );
  }
}

function assertGitRefName(branchName: string): void {
  const validationMessage = getGitBranchNameValidationMessage(branchName);
  if (validationMessage !== undefined) {
    throw new GitOperationError("branch", validationMessage);
  }
}

function formatGitErrorForUser(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return redactGitErrorMessage(error.message);
  }
  return "Git operation failed. Check the repository and Git output, then try again.";
}

function throwIfGitOperationCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Git checkout cancelled", "AbortError");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
