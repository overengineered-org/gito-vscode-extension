import * as vscode from "vscode";
import * as path from "node:path";
import {
  GitOperationError,
  type LocalGitInteraction,
  type NativeVscodeCommandExecutor,
  LocalGitRepositoryService,
  type LocalGitBranchExpectation,
} from "../git/localGitRepositoryService.js";
import { GitHistoryService } from "../git/gitHistoryService.js";
import { GitWorktreeService } from "../git/gitWorktreeService.js";
import type {
  LocalGitChange,
  LocalGitChangesSnapshot,
} from "../git/localGitModels.js";
import {
  getCommandEligibleChanges,
  type LocalGitChangeAction,
} from "./gitChangeSelection.js";
import { getGitBranchNameValidationMessage } from "../git/gitRefName.js";
import type { RepositorySelectionContext } from "../repositories/repositoryDiscovery.js";
import type { VscodeGitRepository } from "../git/vscodeGitApi.js";

export const localGitCommandIds = {
  stageChanges: "gito.stageChanges",
  unstageChanges: "gito.unstageChanges",
  stageAll: "gito.stageAll",
  unstageAll: "gito.unstageAll",
  openDiff: "gito.openDiff",
  discardChanges: "gito.discardChanges",
  commit: "gito.commit",
  fetch: "gito.fetch",
  pull: "gito.pull",
  push: "gito.push",
  sync: "gito.sync",
  copyCommitSha: "gito.copyCommitSha",
  copyCommitMessage: "gito.copyCommitMessage",
  checkoutBranch: "gito.checkoutBranch",
  createBranch: "gito.createBranch",
  publishBranch: "gito.publishBranch",
  deleteBranch: "gito.deleteBranch",
  forceDeleteBranch: "gito.forceDeleteBranch",
  openCommitFileDiff: "gito.openCommitFileDiff",
  createWorktree: "gito.createWorktree",
  removeWorktree: "gito.removeWorktree",
  openWorktree: "gito.openWorktree",
} as const;

export interface LocalGitCommandServices {
  readonly repositoryService: LocalGitRepositoryService;
  readonly historyService?: GitHistoryService;
  readonly worktreeService?: GitWorktreeService;
  readonly nativeCommandExecutor?: NativeVscodeCommandExecutor;
  readonly localGitInteraction?: LocalGitInteraction;
  readonly smartCommitEnabled: () => boolean;
}

export interface LocalGitCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}

export interface LocalGitRepositoryCommandArguments {
  readonly repositoryRoot: vscode.Uri;
  readonly expectedRepository?: VscodeGitRepository;
}

export interface LocalGitChangeCommandArguments extends LocalGitRepositoryCommandArguments {
  readonly changes: readonly LocalGitChange[];
}

export interface LocalGitBranchCommandArguments extends LocalGitRepositoryCommandArguments {
  readonly branchName: string;
  readonly isRemote?: boolean;
  readonly expectedBranchName?: string;
  readonly expectedBranchCommit?: string;
}

export interface LocalGitWorktreeCommandArguments extends LocalGitRepositoryCommandArguments {
  readonly worktreePath: string;
}

export function registerLocalGitCommands(
  commandRegistry: LocalGitCommandRegistry,
  commandServices: LocalGitCommandServices,
): readonly vscode.Disposable[] {
  const nativeCommandExecutor = commandServices.nativeCommandExecutor;
  const registeredCommands = [
    commandRegistry.registerCommand(
      localGitCommandIds.stageChanges,
      async (...argumentsPassed) => {
        const selectedChangeSelection = await resolveSelectedChanges(
          commandServices.repositoryService,
          argumentsPassed,
          "stage",
        );
        await commandServices.repositoryService.stageChanges(
          selectedChangeSelection.changes,
          selectedChangeSelection.selectionContext,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.unstageChanges,
      async (...argumentsPassed) => {
        const selectedChangeSelection = await resolveSelectedChanges(
          commandServices.repositoryService,
          argumentsPassed,
          "unstage",
        );
        await commandServices.repositoryService.unstageChanges(
          selectedChangeSelection.changes,
          selectedChangeSelection.selectionContext,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.stageAll,
      (...argumentsPassed) =>
        commandServices.repositoryService.stageAll(
          readRepositorySelectionContext(argumentsPassed[0]),
        ),
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.unstageAll,
      (...argumentsPassed) =>
        commandServices.repositoryService.unstageAll(
          readRepositorySelectionContext(argumentsPassed[0]),
        ),
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.openDiff,
      async (...argumentsPassed) => {
        const resourceUri = readResourceUri(argumentsPassed[0]);
        if (resourceUri === undefined) {
          throw new GitOperationError(
            "open diff",
            "Select a changed file first.",
          );
        }
        await commandServices.repositoryService.openNativeDiff(
          resourceUri,
          readRepositorySelectionContext(argumentsPassed[0]),
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.discardChanges,
      async (...argumentsPassed) => {
        const selectedChangeSelection = await resolveSelectedChanges(
          commandServices.repositoryService,
          argumentsPassed,
          "discard",
        );
        await commandServices.repositoryService.discardChanges(
          selectedChangeSelection.changes,
          selectedChangeSelection.selectionContext,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.commit,
      async (...argumentsPassed) => {
        const commitMessage =
          readStringArgument(argumentsPassed[0]) ??
          (await commandServices.repositoryService.getCommitInputValue(
            readRepositorySelectionContext(argumentsPassed[0]),
          ));
        await commandServices.repositoryService.commitStagedChanges(
          commitMessage,
          commandServices.smartCommitEnabled(),
          readRepositorySelectionContext(argumentsPassed[0]),
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.fetch,
      (...argumentsPassed) =>
        commandServices.repositoryService.fetch(
          readRepositorySelectionContext(argumentsPassed[0]),
        ),
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.pull,
      (...argumentsPassed) =>
        commandServices.repositoryService.pull(
          readRepositorySelectionContext(argumentsPassed[0]),
        ),
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.push,
      (...argumentsPassed) =>
        commandServices.repositoryService.push(
          readRepositorySelectionContext(argumentsPassed[0]),
        ),
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.sync,
      (...argumentsPassed) =>
        commandServices.repositoryService.sync(
          readRepositorySelectionContext(argumentsPassed[0]),
        ),
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.copyCommitSha,
      async (...argumentsPassed) => {
        const commitSha = readCommitShaArgument(argumentsPassed[0]);
        if (commitSha === undefined) {
          throw new GitOperationError(
            "copy commit SHA",
            "Select a commit first.",
          );
        }
        await vscode.env.clipboard.writeText(commitSha);
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.copyCommitMessage,
      async (...argumentsPassed) => {
        const commitMessage = readCommitMessageArgument(argumentsPassed[0]);
        if (commitMessage === undefined) {
          throw new GitOperationError(
            "copy commit message",
            "Select a commit first.",
          );
        }
        await vscode.env.clipboard.writeText(commitMessage);
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.checkoutBranch,
      async (...argumentsPassed) => {
        const branchSelection = await resolveBranchSelection(
          commandServices.repositoryService,
          argumentsPassed[0],
          "Checkout branch",
        );
        await commandServices.repositoryService.checkoutBranch(
          branchSelection.branchName,
          branchSelection.selectionContext,
          branchSelection.isRemote,
          readCancellationSignal(argumentsPassed[0]),
          ...(branchSelection.expectedBranch === undefined
            ? []
            : [branchSelection.expectedBranch]),
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.createBranch,
      async (...argumentsPassed) => {
        const branchName =
          readStringArgument(argumentsPassed[0]) ??
          (await vscode.window.showInputBox({
            prompt: "Branch name",
            placeHolder: "feature/my-change",
            validateInput: validateGitBranchName,
          }));
        if (branchName === undefined) return;
        await commandServices.repositoryService.createBranch(
          branchName,
          readRepositorySelectionContext(argumentsPassed[0]),
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.publishBranch,
      (...argumentsPassed) => {
        const branchArguments = readBranchCommandArguments(argumentsPassed[0]);
        return commandServices.repositoryService.publishCurrentBranch(
          readRepositorySelectionContext(argumentsPassed[0]),
          branchArguments === undefined
            ? undefined
            : toExpectedBranch(branchArguments),
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.deleteBranch,
      async (...argumentsPassed) => {
        const branchSelection = await resolveBranchSelection(
          commandServices.repositoryService,
          argumentsPassed[0],
          "Delete branch",
        );
        await commandServices.repositoryService.deleteBranch(
          branchSelection.branchName,
          branchSelection.selectionContext,
          branchSelection.expectedBranch,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.forceDeleteBranch,
      async (...argumentsPassed) => {
        const branchSelection = await resolveBranchSelection(
          commandServices.repositoryService,
          argumentsPassed[0],
          "Force-delete branch",
        );
        await commandServices.repositoryService.forceDeleteBranch(
          branchSelection.branchName,
          branchSelection.selectionContext,
          branchSelection.expectedBranch,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.openCommitFileDiff,
      async (...argumentsPassed) => {
        if (
          commandServices.historyService === undefined ||
          nativeCommandExecutor === undefined
        ) {
          throw new GitOperationError(
            "open commit diff",
            "Commit diff support is not available in this extension host.",
          );
        }
        const commitDiffArguments = readCommitDiffArguments(argumentsPassed[0]);
        if (commitDiffArguments === undefined) {
          throw new GitOperationError(
            "open commit diff",
            "Select a changed file from a commit first.",
          );
        }
        if (commitDiffArguments.repositoryRoot.scheme !== "file") {
          throw new GitOperationError(
            "open commit diff",
            "Commit diff is supported only for local desktop repositories.",
          );
        }
        assertRelativeRepositoryPath(
          commitDiffArguments.filePath,
          "open commit diff",
        );
        const selectedRepositoryRoot =
          await commandServices.repositoryService.getRepositoryRoot({
            selectedRepositoryRoot: commitDiffArguments.repositoryRoot,
          });
        const commitDetails =
          await commandServices.historyService.getCommitDetails(
            selectedRepositoryRoot,
            commitDiffArguments.commitSha,
          );
        const selectedFileChange = commitDetails.files.find(
          (fileChange) => fileChange.path === commitDiffArguments.filePath,
        );
        if (selectedFileChange === undefined) {
          throw new GitOperationError(
            "open commit diff",
            "The selected file is not part of that commit.",
          );
        }
        assertRelativeRepositoryPath(
          selectedFileChange.path,
          "open commit diff",
        );
        if (selectedFileChange.previousPath !== undefined) {
          assertRelativeRepositoryPath(
            selectedFileChange.previousPath,
            "open commit diff",
          );
        }
        const previousFileUri = vscode.Uri.file(
          path.join(
            selectedRepositoryRoot.fsPath,
            selectedFileChange.previousPath ?? selectedFileChange.path,
          ),
        );
        const currentFileUri = vscode.Uri.file(
          path.join(selectedRepositoryRoot.fsPath, selectedFileChange.path),
        );
        const previousCommitSha =
          commitDetails.parentShas[0] ?? gitEmptyTreeSha;
        const createGitRevisionUri = (
          fileUri: vscode.Uri,
          revisionSha: string,
        ): vscode.Uri =>
          fileUri.with({
            scheme: "git",
            query: JSON.stringify({ path: fileUri.fsPath, ref: revisionSha }),
          });
        await nativeCommandExecutor.execute(
          "vscode.diff",
          createGitRevisionUri(previousFileUri, previousCommitSha),
          createGitRevisionUri(currentFileUri, commitDiffArguments.commitSha),
          `${selectedFileChange.path} (${commitDiffArguments.commitSha.slice(0, 7)})`,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.createWorktree,
      async (...argumentsPassed) => {
        if (commandServices.worktreeService === undefined) {
          throw new GitOperationError(
            "create worktree",
            "Worktree support is unavailable.",
          );
        }
        const createWorktreeArguments = readCreateWorktreeArguments(
          argumentsPassed[0],
        );
        const worktreePath =
          createWorktreeArguments?.worktreePath ??
          (await vscode.window.showInputBox({
            prompt: "Absolute worktree path",
            validateInput: (candidatePath) =>
              candidatePath.trim().length === 0 ||
              !path.isAbsolute(candidatePath)
                ? "Enter an absolute worktree path."
                : undefined,
          }));
        if (worktreePath === undefined) return;
        const repositorySelectionContext = readRepositorySelectionContext(
          argumentsPassed[0],
        );
        const cancellationSignal = readCancellationSignal(argumentsPassed[0]);
        await commandServices.worktreeService.createWorktree(
          repositorySelectionContext?.selectedRepositoryRoot ??
            (await commandServices.repositoryService.getRepositoryRoot()),
          worktreePath,
          createWorktreeArguments === undefined
            ? {}
            : {
                ...(createWorktreeArguments.branchName === undefined
                  ? {}
                  : { branchName: createWorktreeArguments.branchName }),
                ...(createWorktreeArguments.createBranch === undefined
                  ? {}
                  : { createBranch: createWorktreeArguments.createBranch }),
                ...(createWorktreeArguments.startPoint === undefined
                  ? {}
                  : { startPoint: createWorktreeArguments.startPoint }),
              },
          cancellationSignal,
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.removeWorktree,
      async (...argumentsPassed) => {
        if (commandServices.worktreeService === undefined) {
          throw new GitOperationError(
            "remove worktree",
            "Worktree support is unavailable.",
          );
        }
        const worktreeArguments = readWorktreeCommandArguments(
          argumentsPassed[0],
        );
        const worktreePath =
          worktreeArguments?.worktreePath ??
          readStringArgument(argumentsPassed[0]);
        if (worktreePath === undefined) {
          throw new GitOperationError(
            "remove worktree",
            "Select a worktree first.",
          );
        }
        await commandServices.worktreeService.removeWorktree(
          worktreeArguments?.repositoryRoot ??
            (await commandServices.repositoryService.getRepositoryRoot()),
          worktreePath,
          readCancellationSignal(argumentsPassed[0]),
        );
      },
    ),
    commandRegistry.registerCommand(
      localGitCommandIds.openWorktree,
      async (...argumentsPassed) => {
        if (commandServices.worktreeService === undefined) {
          throw new GitOperationError(
            "open worktree",
            "Worktree support is unavailable.",
          );
        }
        const worktreeArguments = readWorktreeCommandArguments(
          argumentsPassed[0],
        );
        const worktreePath =
          worktreeArguments?.worktreePath ??
          readStringArgument(argumentsPassed[0]);
        if (worktreePath === undefined) {
          throw new GitOperationError(
            "open worktree",
            "Select a worktree first.",
          );
        }
        await commandServices.worktreeService.openWorktree(
          worktreeArguments?.repositoryRoot ??
            (await commandServices.repositoryService.getRepositoryRoot()),
          worktreePath,
        );
      },
    ),
  ];
  return registeredCommands;
}

const gitEmptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function resolveSelectedChanges(
  repositoryService: LocalGitRepositoryService,
  commandArguments: readonly unknown[],
  changeAction: LocalGitChangeAction,
): Promise<{
  readonly changes: readonly LocalGitChange[];
  readonly selectionContext?: RepositorySelectionContext;
}> {
  const commandArgument = commandArguments[0];
  const selectionContext = readRepositorySelectionContext(commandArgument);
  const explicitChanges = readChangesArgument(commandArgument);
  if (explicitChanges !== undefined)
    return {
      changes: explicitChanges,
      ...(selectionContext === undefined ? {} : { selectionContext }),
    };
  const changesSnapshot =
    await repositoryService.getChangesSnapshot(selectionContext);
  return {
    changes: await promptForChangeSelection(changesSnapshot, changeAction),
    ...(selectionContext === undefined ? {} : { selectionContext }),
  };
}

async function promptForChangeSelection(
  changesSnapshot: LocalGitChangesSnapshot,
  changeAction: LocalGitChangeAction,
): Promise<readonly LocalGitChange[]> {
  const eligibleChanges = getCommandEligibleChanges(
    changesSnapshot,
    changeAction,
  );
  if (eligibleChanges.length === 0) return [];
  const selectedChangeItems = await vscode.window.showQuickPick(
    eligibleChanges.map((change) => ({
      label: change.relativePath,
      description: `${change.statusLabel} · ${change.group}`,
      change,
    })),
    {
      canPickMany: true,
      placeHolder: getChangeSelectionPrompt(changeAction),
    },
  );
  return (
    selectedChangeItems?.map(
      (selectedChangeItem) => selectedChangeItem.change,
    ) ?? []
  );
}

function getChangeSelectionPrompt(changeAction: LocalGitChangeAction): string {
  if (changeAction === "stage") return "Select changes to stage";
  if (changeAction === "unstage") return "Select staged changes to unstage";
  return "Select changes to discard";
}

function readChangesArgument(
  argumentValue: unknown,
): readonly LocalGitChange[] | undefined {
  const candidateChanges = Array.isArray(argumentValue)
    ? argumentValue
    : isRecord(argumentValue)
      ? argumentValue.changes
      : undefined;
  if (!Array.isArray(candidateChanges)) return undefined;
  return candidateChanges.every(isLocalGitChange)
    ? candidateChanges
    : undefined;
}

function isLocalGitChange(
  argumentValue: unknown,
): argumentValue is LocalGitChange {
  if (typeof argumentValue !== "object" || argumentValue === null) return false;
  const localGitChange = argumentValue as Partial<LocalGitChange>;
  return (
    typeof localGitChange.group === "string" &&
    typeof localGitChange.relativePath === "string" &&
    typeof localGitChange.statusLabel === "string" &&
    localGitChange.resourceUri instanceof vscode.Uri
  );
}

function readResourceUri(argumentValue: unknown): vscode.Uri | undefined {
  if (argumentValue instanceof vscode.Uri) return argumentValue;
  if (isLocalGitChange(argumentValue)) return argumentValue.resourceUri;
  if (isRecord(argumentValue) && isLocalGitChange(argumentValue.change)) {
    return argumentValue.change.resourceUri;
  }
  return undefined;
}

function readRepositorySelectionContext(
  argumentValue: unknown,
): RepositorySelectionContext | undefined {
  if (argumentValue instanceof vscode.Uri) {
    return { selectedRepositoryRoot: argumentValue };
  }
  if (!isRecord(argumentValue)) return undefined;
  if (!(argumentValue.repositoryRoot instanceof vscode.Uri)) return undefined;
  return {
    selectedRepositoryRoot: argumentValue.repositoryRoot,
    ...(argumentValue.expectedRepository === undefined
      ? {}
      : {
          expectedRepository:
            argumentValue.expectedRepository as VscodeGitRepository,
        }),
  };
}

function readCancellationSignal(
  argumentValue: unknown,
): AbortSignal | undefined {
  if (!isRecord(argumentValue)) return undefined;
  return argumentValue.cancellationSignal instanceof AbortSignal
    ? argumentValue.cancellationSignal
    : undefined;
}

function readBranchCommandArguments(
  argumentValue: unknown,
): LocalGitBranchCommandArguments | undefined {
  if (!isRecord(argumentValue)) return undefined;
  if (
    typeof argumentValue.branchName !== "string" ||
    !(argumentValue.repositoryRoot instanceof vscode.Uri) ||
    (argumentValue.isRemote !== undefined &&
      typeof argumentValue.isRemote !== "boolean") ||
    (argumentValue.expectedBranchName !== undefined &&
      typeof argumentValue.expectedBranchName !== "string") ||
    (argumentValue.expectedBranchCommit !== undefined &&
      typeof argumentValue.expectedBranchCommit !== "string")
  ) {
    return undefined;
  }
  return argumentValue as unknown as LocalGitBranchCommandArguments;
}

interface ParsedWorktreeCommandArguments {
  readonly repositoryRoot: vscode.Uri;
  readonly worktreePath: string;
}

function readWorktreeCommandArguments(
  argumentValue: unknown,
): ParsedWorktreeCommandArguments | undefined {
  if (!isRecord(argumentValue)) return undefined;
  return argumentValue.repositoryRoot instanceof vscode.Uri &&
    typeof argumentValue.worktreePath === "string"
    ? {
        repositoryRoot: argumentValue.repositoryRoot,
        worktreePath: argumentValue.worktreePath,
      }
    : undefined;
}

function isRecord(
  argumentValue: unknown,
): argumentValue is Record<string, unknown> {
  return typeof argumentValue === "object" && argumentValue !== null;
}

async function resolveBranchSelection(
  repositoryService: LocalGitRepositoryService,
  argumentValue: unknown,
  prompt: string,
): Promise<{
  readonly branchName: string;
  readonly isRemote: boolean;
  readonly expectedBranch?: LocalGitBranchExpectation;
  readonly selectionContext?: RepositorySelectionContext;
}> {
  const selectionContext = readRepositorySelectionContext(argumentValue);
  const explicitBranchSelection = readBranchCommandArguments(argumentValue);
  if (explicitBranchSelection !== undefined) {
    return {
      branchName: explicitBranchSelection.branchName,
      isRemote: explicitBranchSelection.isRemote ?? false,
      ...(explicitBranchSelection.expectedBranchName === undefined &&
      explicitBranchSelection.expectedBranchCommit === undefined
        ? {}
        : { expectedBranch: toExpectedBranch(explicitBranchSelection) }),
      ...(selectionContext === undefined ? {} : { selectionContext }),
    };
  }
  const explicitBranchName = readStringArgument(argumentValue);
  if (explicitBranchName !== undefined) {
    return {
      branchName: explicitBranchName,
      isRemote: false,
      ...(selectionContext === undefined ? {} : { selectionContext }),
    };
  }
  const branchOptions = (
    await repositoryService.listBranches(selectionContext)
  ).map((branch) => ({
    label: branch.name,
    ...(branch.isRemote
      ? { description: "Remote tracking branch" }
      : branch.isCurrent
        ? { description: "Current branch" }
        : branch.upstreamBranchName === undefined
          ? {}
          : { description: branch.upstreamBranchName }),
    branch,
  }));
  const selectedBranch = await vscode.window.showQuickPick(branchOptions, {
    placeHolder: prompt,
  });
  if (selectedBranch === undefined) {
    throw new GitOperationError("branch", "Branch selection was cancelled.");
  }
  return {
    branchName: selectedBranch.label,
    isRemote: selectedBranch.branch.isRemote,
    expectedBranch: toExpectedBranch({
      branchName: selectedBranch.branch.name,
      expectedBranchName: selectedBranch.branch.name,
      ...(selectedBranch.branch.lastCommit === undefined
        ? {}
        : { expectedBranchCommit: selectedBranch.branch.lastCommit }),
    }),
    ...(selectionContext === undefined ? {} : { selectionContext }),
  };
}

function toExpectedBranch(
  branchArguments: Pick<
    LocalGitBranchCommandArguments,
    "branchName" | "expectedBranchName" | "expectedBranchCommit"
  >,
): LocalGitBranchExpectation {
  return {
    branchName:
      branchArguments.expectedBranchName ?? branchArguments.branchName,
    ...(branchArguments.expectedBranchCommit === undefined
      ? {}
      : { branchCommit: branchArguments.expectedBranchCommit }),
  };
}

function readStringArgument(argumentValue: unknown): string | undefined {
  return typeof argumentValue === "string" && argumentValue.trim().length > 0
    ? argumentValue
    : undefined;
}

function validateGitBranchName(
  candidateBranchName: string,
): string | undefined {
  return getGitBranchNameValidationMessage(candidateBranchName);
}

interface CommitDiffArguments {
  readonly repositoryRoot: vscode.Uri;
  readonly commitSha: string;
  readonly filePath: string;
}

function readCommitShaArgument(argumentValue: unknown): string | undefined {
  if (typeof argumentValue === "string") return argumentValue;
  if (typeof argumentValue !== "object" || argumentValue === null)
    return undefined;
  const commitArgument = argumentValue as {
    readonly commitSha?: unknown;
    readonly hash?: unknown;
  };
  const commitSha = commitArgument.commitSha ?? commitArgument.hash;
  return typeof commitSha === "string" && commitSha.length > 0
    ? commitSha
    : undefined;
}

function readCommitMessageArgument(argumentValue: unknown): string | undefined {
  if (typeof argumentValue === "string") return argumentValue;
  if (typeof argumentValue !== "object" || argumentValue === null)
    return undefined;
  const commitArgument = argumentValue as {
    readonly commitMessage?: unknown;
    readonly message?: unknown;
  };
  const commitMessage = commitArgument.commitMessage ?? commitArgument.message;
  return typeof commitMessage === "string" ? commitMessage : undefined;
}

function readCommitDiffArguments(
  argumentValue: unknown,
): CommitDiffArguments | undefined {
  if (typeof argumentValue !== "object" || argumentValue === null)
    return undefined;
  const commitDiffArguments = argumentValue as Partial<CommitDiffArguments>;
  if (
    !isRepositoryRootUri(commitDiffArguments.repositoryRoot) ||
    typeof commitDiffArguments.commitSha !== "string" ||
    typeof commitDiffArguments.filePath !== "string"
  ) {
    return undefined;
  }
  return commitDiffArguments as CommitDiffArguments;
}

function isRepositoryRootUri(value: unknown): value is vscode.Uri {
  if (typeof value !== "object" || value === null) return false;
  const uriValue = value as Partial<vscode.Uri>;
  return (
    typeof uriValue.scheme === "string" &&
    typeof uriValue.authority === "string" &&
    typeof uriValue.path === "string" &&
    typeof uriValue.fsPath === "string"
  );
}

function assertRelativeRepositoryPath(
  repositoryRelativePath: string,
  operationName: string,
): void {
  const normalizedPath = path.normalize(repositoryRelativePath);
  if (
    repositoryRelativePath.length === 0 ||
    path.isAbsolute(repositoryRelativePath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith(`..${path.sep}`)
  ) {
    throw new GitOperationError(
      operationName,
      "The selected file path is outside the repository.",
    );
  }
}

interface CreateWorktreeArguments {
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly createBranch?: boolean;
  readonly startPoint?: string;
}

function readCreateWorktreeArguments(
  argumentValue: unknown,
): CreateWorktreeArguments | undefined {
  if (typeof argumentValue !== "object" || argumentValue === null)
    return undefined;
  const createWorktreeArguments =
    argumentValue as Partial<CreateWorktreeArguments>;
  if (
    createWorktreeArguments.worktreePath !== undefined &&
    typeof createWorktreeArguments.worktreePath !== "string"
  ) {
    return undefined;
  }
  if (
    createWorktreeArguments.branchName !== undefined &&
    typeof createWorktreeArguments.branchName !== "string"
  ) {
    return undefined;
  }
  if (
    createWorktreeArguments.createBranch !== undefined &&
    typeof createWorktreeArguments.createBranch !== "boolean"
  ) {
    return undefined;
  }
  if (
    createWorktreeArguments.startPoint !== undefined &&
    typeof createWorktreeArguments.startPoint !== "string"
  ) {
    return undefined;
  }
  return createWorktreeArguments;
}
