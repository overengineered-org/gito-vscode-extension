import type { GitCommandRunner } from "../git/gitCommandRunner.js";
import type { GitRootBindingResolver } from "../git/gitRootBindingResolver.js";

export type GitOperationKind =
  | "stash.create"
  | "stash.list"
  | "stash.inspect"
  | "stash.apply"
  | "stash.pop"
  | "stash.drop"
  | "stash.branch"
  | "tag.create"
  | "tag.delete"
  | "tag.push"
  | "merge"
  | "merge.continue"
  | "merge.abort"
  | "cherry-pick"
  | "cherry-pick.continue"
  | "cherry-pick.abort"
  | "revert"
  | "revert.continue"
  | "revert.abort"
  | "reset"
  | "rebase.start"
  | "rebase.continue"
  | "rebase.skip"
  | "rebase.abort"
  | "branch.rename"
  | "branch.upstream"
  | "remote.add"
  | "remote.rename"
  | "remote.remove"
  | "remote.prune"
  | "fetch"
  | "pull"
  | "push"
  | "patch.create"
  | "patch.apply"
  | "bisect.start"
  | "bisect.good"
  | "bisect.bad"
  | "bisect.skip"
  | "bisect.reset"
  | "reflog.list"
  | "reflog.recover"
  | "clean.preview"
  | "clean.execute";

export type GitResetMode = "soft" | "mixed" | "hard" | "merge" | "keep";
export type GitPatchScope = "working-tree" | "staged" | "both";
export type GitPushMode =
  "normal" | "set-upstream" | "force-with-lease" | "force";
export type GitPullMode = "merge" | "rebase" | "ff-only";
export type GitMergeMode = "default" | "ff" | "no-ff" | "ff-only";

export interface GitOperationRequestBase {
  readonly repositoryRoot: string;
  readonly expectedRepositoryRoot?: string;
  readonly cancellationSignal?: AbortSignal;
}

export interface StashCreateRequest extends GitOperationRequestBase {
  readonly message?: string;
  readonly includeUntracked?: boolean;
  readonly keepIndex?: boolean;
  /** Restrict the stash to exact pathspecs. */
  readonly pathspecs?: readonly string[];
  /** Use Git's interactive partial stash workflow when explicitly requested. */
  readonly partial?: boolean;
}

export interface StashReferenceRequest extends GitOperationRequestBase {
  readonly stashReference: string;
}

export interface StashBranchRequest extends StashReferenceRequest {
  readonly branchName: string;
}

export interface TagCreateRequest extends GitOperationRequestBase {
  readonly tagName: string;
  readonly target?: string;
  readonly annotatedMessage?: string;
  readonly force?: boolean;
  /** Signed tag creation is intentionally rejected until a verifier is wired. */
  readonly signed?: boolean;
}

export interface TagRequest extends GitOperationRequestBase {
  readonly tagName: string;
}

export interface TagPushRequest extends TagRequest {
  readonly remoteName: string;
  readonly deleteLocalTagOnPushFailure?: boolean;
}

export interface RefRequest extends GitOperationRequestBase {
  readonly commitish: string;
}

export interface MergeRequest extends RefRequest {
  readonly mode?: GitMergeMode;
}

export interface ResetRequest extends RefRequest {
  readonly mode: GitResetMode;
}

export interface BranchRenameRequest extends GitOperationRequestBase {
  readonly oldBranchName?: string;
  readonly newBranchName: string;
}

export interface BranchUpstreamRequest extends GitOperationRequestBase {
  readonly remoteName: string;
  readonly branchName: string;
  readonly setUpstream: boolean;
}

export interface RebaseStartRequest extends GitOperationRequestBase {
  readonly upstream: string;
  readonly onto?: string;
  readonly branchName?: string;
}

export interface RemoteRequest extends GitOperationRequestBase {
  readonly remoteName: string;
}

export interface RemoteAddRequest extends RemoteRequest {
  readonly remoteUrl: string;
  readonly fetchOnly?: boolean;
}

export interface RemoteRenameRequest extends RemoteRequest {
  readonly newRemoteName: string;
}

export interface FetchRequest extends GitOperationRequestBase {
  readonly remoteName?: string;
  readonly refspec?: string;
  readonly all?: boolean;
  readonly prune?: boolean;
}

export interface PullRequest extends GitOperationRequestBase {
  readonly mode?: GitPullMode;
  readonly remoteName?: string;
  readonly branchName?: string;
}

export interface PushRequest extends GitOperationRequestBase {
  readonly remoteName?: string;
  readonly branchName?: string;
  readonly mode?: GitPushMode;
  readonly refspec?: string;
  readonly deleteRemoteBranch?: boolean;
}

export interface PatchCreateRequest extends GitOperationRequestBase {
  readonly scope?: GitPatchScope;
  readonly pathspecs?: readonly string[];
}

export interface PatchApplyRequest extends GitOperationRequestBase {
  readonly patchText: string;
  readonly checkOnly?: boolean;
  readonly threeWay?: boolean;
  /** Maximum patch payload accepted by the operation boundary. */
  readonly maxPatchBytes?: number;
}

export interface BisectStartRequest extends GitOperationRequestBase {
  readonly badCommit?: string;
  readonly goodCommits: readonly string[];
  readonly terms?: readonly [string, string];
}

export interface BisectCommitRequest extends GitOperationRequestBase {
  readonly commitish?: string;
}

export interface ReflogListRequest extends GitOperationRequestBase {
  readonly refName?: string;
  readonly limit?: number;
}

export interface ReflogRecoverRequest extends GitOperationRequestBase {
  readonly target: string;
  readonly mode?: "soft" | "mixed" | "hard";
}

export interface CleanPreviewRequest extends GitOperationRequestBase {
  readonly includeDirectories?: boolean;
  readonly includeIgnored?: boolean;
  readonly pathspecs?: readonly string[];
  /** Exact candidates copied from a prior read-only preview. */
  readonly candidatePaths?: readonly string[];
}

export interface GitStateFingerprint {
  readonly repositoryRoot: string;
  readonly headCommit?: string;
  readonly headRef?: string;
  readonly isClean: boolean;
  readonly hasConflicts: boolean;
  readonly inProgressOperation?:
    "merge" | "cherry-pick" | "revert" | "rebase" | "bisect";
  readonly statusPorcelain: string;
  /** Includes ignored and nested untracked entries for race detection. */
  readonly ignoredStatusPorcelain?: string;
}

export interface GitOperationPrecondition {
  readonly id: string;
  readonly description: string;
  readonly satisfied: boolean;
  readonly blocking: boolean;
}

export interface GitOperationConfirmationPlan {
  readonly confirmationToken: string;
  readonly operation: GitOperationKind;
  readonly repositoryRoot: string;
  readonly summary: string;
  readonly consequences: readonly string[];
  readonly cancellationSupported: true;
}

export interface GitOperationPreview {
  readonly operation: GitOperationKind;
  readonly repositoryRoot: string;
  readonly displayArguments: readonly string[];
  readonly commandSequence?: readonly (readonly string[])[];
  readonly destructive: boolean;
  readonly state: GitStateFingerprint;
  readonly preconditions: readonly GitOperationPrecondition[];
  readonly confirmationPlan: GitOperationConfirmationPlan;
  readonly expectedPostcondition: string;
  readonly generatedAt: string;
  readonly contentSummary?: GitOperationContentSummary;
  readonly cleanCandidates?: readonly string[];
  /** No-follow identity captured for every exact clean candidate. */
  readonly cleanCandidateBindings?: readonly GitCleanCandidateBinding[];
}

export interface GitCleanCandidateBinding {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly device: string;
  readonly inode: string;
  readonly parentFingerprint: string;
}

export interface GitOperationContentSummary {
  readonly bytes: number;
  readonly sha256: string;
  readonly description: string;
}

export interface GitOperationConfirmation {
  readonly confirmationToken: string;
  readonly repositoryRoot: string;
  readonly acknowledged: true;
}

export interface GitOperationPostcondition {
  readonly verified: boolean;
  readonly description: string;
  readonly state: GitStateFingerprint;
}

export interface GitOperationResult {
  readonly operation: GitOperationKind;
  readonly repositoryRoot: string;
  readonly standardOutput: string;
  readonly standardError: string;
  readonly postcondition: GitOperationPostcondition;
  readonly rolledBack: boolean;
  /** Present on service results; optional to keep deterministic UI test doubles small. */
  readonly rollback?: GitOperationRollbackReport;
}

export type GitOperationRollbackStatus =
  "not-attempted" | "succeeded" | "failed";

export interface GitOperationRollbackReport {
  readonly status: GitOperationRollbackStatus;
  readonly finalState?: GitStateFingerprint;
  readonly error?: string;
}

export interface GitOperationDependencies {
  readonly commandRunner: GitCommandRunner;
  readonly gitRootBindingResolver: GitRootBindingResolver;
  /** Test seam for injecting a pathname replacement before bound rename. */
  readonly beforeBoundFilesystemRename?: (
    destinationPath: string,
  ) => Promise<void>;
  /** Test seam for injecting a directory replacement before bound sync. */
  readonly beforeBoundFilesystemSyncDirectory?: (
    directoryPath: string,
  ) => Promise<void>;
  readonly now?: () => Date;
  readonly randomToken?: () => string;
  /** Required final trust gate; checked after preview confirmation and state checks. */
  readonly workspaceTrustGuard: {
    isWorkspaceTrusted(): boolean;
    assertTrusted(operationName: string): void;
  };
}
