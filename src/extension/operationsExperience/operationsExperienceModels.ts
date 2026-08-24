import type * as vscode from "vscode";
import type {
  BisectCommitRequest,
  BisectStartRequest,
  BranchRenameRequest,
  BranchUpstreamRequest,
  CleanPreviewRequest,
  FetchRequest,
  GitOperationConfirmation,
  GitOperationPreview,
  GitOperationResult,
  MergeRequest,
  GitOperationRequestBase,
  PatchApplyRequest,
  PatchCreateRequest,
  PullRequest,
  PushRequest,
  RefRequest,
  RebaseStartRequest,
  ReflogListRequest,
  ReflogRecoverRequest,
  RemoteAddRequest,
  RemoteRenameRequest,
  RemoteRequest,
  ResetRequest,
  StashBranchRequest,
  StashCreateRequest,
  StashReferenceRequest,
  TagCreateRequest,
  TagPushRequest,
  TagRequest,
} from "../operations/index.js";

export const operationsExperienceCommandIds = {
  open: "gito.openOperations",
} as const;

export type OperationsExperienceAction =
  | "stash"
  | "tags"
  | "history"
  | "rebase"
  | "branches"
  | "remotes"
  | "network"
  | "patch"
  | "bisect"
  | "reflog"
  | "clean"
  | "continue"
  | "skip"
  | "abort";

export interface OperationsExperienceQuickPickItem
  extends vscode.QuickPickItem {
  readonly action: OperationsExperienceAction;
  readonly category?: string;
  readonly accessibilityInformation?: vscode.AccessibilityInformation;
}

export interface OperationsExperienceUi {
  readonly isWorkspaceTrusted: () => boolean;
  readonly showQuickPick: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ) => Promise<T | readonly T[] | undefined>;
  readonly showInputBox: (
    options: vscode.InputBoxOptions,
  ) => Promise<string | undefined>;
  readonly showWarningMessage: (
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ) => Promise<string | undefined>;
  readonly showInformationMessage: (
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ) => Promise<string | undefined>;
  readonly showErrorMessage: (message: string) => Promise<string | undefined>;
  /** Opens the complete exact preview in a scrollable native editor before confirmation. */
  readonly showPreviewDocument: (options: {
    readonly title: string;
    readonly content: string;
  }) => Promise<void>;
  readonly withProgress: <T>(
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{
        readonly message?: string;
        readonly increment?: number;
      }>,
      cancellationToken: vscode.CancellationToken,
    ) => Promise<T>,
  ) => Promise<T>;
  readonly executeCommand: (
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ) => Promise<unknown>;
}

export interface OperationsExperienceRepositoryProvider {
  /** Returns the exact currently selected repository root. */
  readonly getRepositoryRoot: () => Promise<string | undefined>;
}

export interface OperationsExperienceStateReader {
  readonly read: (
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ) => Promise<OperationsStateBanner>;
}

export type OperationsStateKind =
  "merge" | "cherry-pick" | "revert" | "rebase" | "bisect";

export interface OperationsStateBanner {
  readonly repositoryRoot: string;
  readonly operation?: OperationsStateKind;
  readonly branch?: string;
  readonly summary: string;
}

export interface OperationsExperienceDependencies {
  readonly operations: OperationsServiceApi;
  readonly repositoryProvider: OperationsExperienceRepositoryProvider;
  readonly ui?: OperationsExperienceUi;
  readonly stateReader?: OperationsExperienceStateReader;
  /** Re-checks trust at the final execute boundary, after user confirmation. */
  readonly workspaceTrustGuard: {
    runTrustedMutation<Result>(
      operationName: string,
      mutation: () => Promise<Result> | Result,
    ): Promise<Result>;
  };
}

/** Narrow service surface used by the UI, enabling deterministic controller tests. */
export interface OperationsServiceApi {
  readonly previewStashCreate: (
    request: StashCreateRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewStashList: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewStashInspect: (
    request: StashReferenceRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewStashApply: (
    request: StashReferenceRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewStashPop: (
    request: StashReferenceRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewStashDrop: (
    request: StashReferenceRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewStashBranch: (
    request: StashBranchRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewTagCreate: (
    request: TagCreateRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewTagDelete: (
    request: TagRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewTagPush: (
    request: TagPushRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewMerge: (
    request: MergeRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewMergeContinue: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewMergeAbort: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewCherryPick: (
    request: RefRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewCherryPickContinue: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewCherryPickAbort: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewRevert: (request: RefRequest) => Promise<GitOperationPreview>;
  readonly previewRevertContinue: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewRevertAbort: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewReset: (
    request: ResetRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewRebaseStart: (
    request: RebaseStartRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewRebaseContinue: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewRebaseSkip: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewRebaseAbort: (
    request: GitOperationRequestBase,
  ) => Promise<GitOperationPreview>;
  readonly previewBranchRename: (
    request: BranchRenameRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewBranchUpstream: (
    request: BranchUpstreamRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewRemoteAdd: (
    request: RemoteAddRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewRemoteRename: (
    request: RemoteRenameRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewRemoteRemove: (
    request: RemoteRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewRemotePrune: (
    request: RemoteRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewFetch: (
    request: FetchRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewPull: (request: PullRequest) => Promise<GitOperationPreview>;
  readonly previewPush: (request: PushRequest) => Promise<GitOperationPreview>;
  readonly previewPatchCreate: (
    request: PatchCreateRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewPatchApply: (
    request: PatchApplyRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewBisectStart: (
    request: BisectStartRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewBisectGood: (
    request: BisectCommitRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewBisectBad: (
    request: BisectCommitRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewBisectSkip: (
    request: BisectCommitRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewBisectReset: (
    request: BisectCommitRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewReflogList: (
    request: ReflogListRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewReflogRecover: (
    request: ReflogRecoverRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewClean: (
    request: CleanPreviewRequest,
  ) => Promise<GitOperationPreview>;
  readonly previewCleanExecute: (
    request: CleanPreviewRequest,
  ) => Promise<GitOperationPreview>;
  readonly createConfirmation: (preview: GitOperationPreview) => {
    readonly confirmationToken: string;
    readonly repositoryRoot: string;
    readonly acknowledged: true;
  };
  readonly execute: (
    preview: GitOperationPreview,
    confirmation: GitOperationConfirmation,
    cancellationSignal?: AbortSignal,
  ) => Promise<GitOperationResult>;
}
