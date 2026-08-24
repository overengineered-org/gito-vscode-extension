import type * as vscode from "vscode";
import type { GitRootBindingIdentity } from "../git/gitCommandRunner.js";

/** The Git side names used in conflict UI and resolution plans. */
export type ConflictSide = "base" | "current" | "incoming";

export const conflictSideLabels: Readonly<Record<ConflictSide, string>> = {
  base: "Base (common ancestor)",
  current: "Current (checked-out branch)",
  incoming: "Incoming (operation source)",
};

export const conflictSideExplanations: Readonly<Record<ConflictSide, string>> =
  {
    base: "The shared version before the operation began.",
    current:
      "The version from the branch currently checked out in this repository.",
    incoming:
      "The version from the branch, commit, or operation source being applied.",
  };

export type ConflictOperationKind =
  "merge" | "rebase" | "am" | "cherry-pick" | "revert";

export interface ConflictOperationState {
  readonly kind: ConflictOperationKind;
  readonly label: string;
  readonly sourceDescription: string;
  readonly sourceCommit: string | undefined;
  /** Exact operation target when Git exposes it in operation metadata. */
  readonly targetRef?: string | undefined;
  readonly targetCommit?: string | undefined;
  /** Exact source ref/commit when Git exposes it in operation metadata. */
  readonly sourceRef?: string | undefined;
  readonly metadataPath: string;
  readonly metadataFingerprint?: string | undefined;
  readonly canAbort: boolean;
}

export type ConflictEntryKind =
  | "content"
  | "add-add"
  | "modify-delete"
  | "delete-delete"
  | "rename"
  | "binary"
  | "submodule"
  | "unknown";

export interface ConflictBlobVersion {
  readonly side: ConflictSide;
  readonly objectId: string | undefined;
  readonly mode: string | undefined;
  readonly exists: boolean;
  readonly kind: "text" | "binary" | "submodule" | "missing";
  readonly content: Uint8Array | undefined;
}

export interface ConflictStageEntries {
  readonly base: ConflictBlobVersion | undefined;
  readonly current: ConflictBlobVersion | undefined;
  readonly incoming: ConflictBlobVersion | undefined;
}

export interface ConflictFileState {
  readonly path: string;
  readonly originalPath: string | undefined;
  readonly renamePair?:
    | {
        readonly originalPath: string;
        readonly destinationPath: string;
      }
    | undefined;
  readonly statusCode: string;
  readonly kind: ConflictEntryKind;
  readonly stages: ConflictStageEntries;
  readonly workingTreeContent: Uint8Array | undefined;
  /** Bytes are read without text conversion; undefined means unavailable. */
  readonly workingTreeKind?:
    "file" | "symlink" | "missing" | "special" | undefined;
  readonly workingTreeMode?: number | undefined;
  readonly workingTreeByteLength?: number | undefined;
  readonly workingTreeDigest?: string | undefined;
  /** Stable no-follow identity of the observed leaf. */
  readonly workingTreeLeafFingerprint?: string | undefined;
  /** Stable no-follow identity of every parent directory used by this path. */
  readonly workingTreeParentFingerprint?: string | undefined;
  /** Working-tree state for the source name of a paired rename conflict. */
  readonly originalPathWorkingTreeContent?: Uint8Array | undefined;
  readonly originalPathWorkingTreeKind?:
    "file" | "symlink" | "missing" | "special" | undefined;
  readonly originalPathWorkingTreeMode?: number | undefined;
  readonly originalPathWorkingTreeByteLength?: number | undefined;
  readonly originalPathWorkingTreeDigest?: string | undefined;
  readonly originalPathWorkingTreeLeafFingerprint?: string | undefined;
  readonly originalPathWorkingTreeParentFingerprint?: string | undefined;
  readonly isResolved: boolean;
}

export interface ConflictRepositorySnapshot {
  readonly repositoryRoot: string;
  /** Canonical absolute Git directory observed during inspection. */
  readonly gitDirectory?: string | undefined;
  /** Device/inode identity of the canonical repository root. */
  readonly repositoryRootIdentity?: string | undefined;
  /** Device/inode identity of the canonical Git directory. */
  readonly gitDirectoryIdentity?: string | undefined;
  /** Complete root, Git directory, and common-directory binding used by mutations. */
  readonly repositoryRootBinding?: GitRootBindingIdentity | undefined;
  readonly fingerprint: string;
  readonly headCommit: string | undefined;
  readonly currentBranchName: string | undefined;
  readonly operation: ConflictOperationState | undefined;
  readonly files: readonly ConflictFileState[];
  readonly hasUnmergedEntries: boolean;
  readonly canContinue: boolean;
  readonly continueReason: string | undefined;
  readonly canAbort: boolean;
  readonly abortReason: string | undefined;
}

export type ConflictResolutionChoice =
  "keep-current" | "keep-incoming" | "combine" | "manual";

export interface ConflictResolutionRequest {
  readonly path: string;
  readonly choice: ConflictResolutionChoice;
  /** Required for combine. Bytes preserve binary/text content exactly. */
  readonly combinedContent?: Uint8Array | undefined;
}

export type ConflictResolutionAction =
  | {
      readonly type: "checkout-side";
      readonly side: "current" | "incoming";
      readonly path: string;
      readonly explanation: string;
    }
  | {
      readonly type: "write-content";
      readonly path: string;
      readonly content: Uint8Array;
      readonly explanation: string;
    }
  | {
      readonly type: "open-merge-editor";
      readonly path: string;
      readonly commandIdentifier: "git.openMergeEditor";
      readonly explanation: string;
    };

export interface ConflictResolutionPlan {
  readonly repositoryRoot: string;
  readonly expectedSnapshotFingerprint: string;
  readonly expectedGitDirectory?: string | undefined;
  readonly expectedRepositoryRootIdentity?: string | undefined;
  readonly expectedGitDirectoryIdentity?: string | undefined;
  /** Complete binding captured during preview; required for every mutation. */
  readonly expectedRepositoryRootBinding?: GitRootBindingIdentity | undefined;
  readonly expectedApplyContextFingerprint?: string | undefined;
  readonly operation: ConflictOperationKind;
  readonly requests: readonly ConflictResolutionRequest[];
  readonly actions: readonly ConflictResolutionAction[];
  readonly stagedPaths: readonly string[];
  readonly preview: string;
  readonly requiresManualEditing: boolean;
  readonly rollback: ConflictRollbackPlan;
}

export interface ConflictRollbackFileSnapshot {
  readonly path: string;
  readonly workingTreeContent: Uint8Array | undefined;
  readonly workingTreeKind?: "file" | "symlink" | "missing" | undefined;
  readonly workingTreeMode?: number | undefined;
  readonly workingTreeParentFingerprint?: string | undefined;
  readonly workingTreeLeafFingerprint?: string | undefined;
  readonly stageEntries: readonly {
    readonly stage: 1 | 2 | 3;
    readonly mode: string;
    readonly objectId: string;
  }[];
}

export interface ConflictRollbackPlan {
  readonly repositoryRoot: string;
  readonly sourceSnapshotFingerprint: string;
  readonly sourceGitDirectory?: string | undefined;
  readonly sourceRepositoryRootIdentity?: string | undefined;
  readonly sourceGitDirectoryIdentity?: string | undefined;
  /** Complete binding captured before the apply began. */
  readonly sourceRepositoryRootBinding?: GitRootBindingIdentity | undefined;
  /** Context outside the selected paths, used to stop rollback on drift. */
  readonly sourceApplyContextFingerprint?: string | undefined;
  readonly files: readonly ConflictRollbackFileSnapshot[];
  readonly commandPlan: readonly string[];
  readonly warning: string;
}

export interface ConflictConfirmation {
  readonly confirm: (preview: string) => Promise<boolean>;
}

export interface ConflictApplyResult {
  readonly appliedPaths: readonly string[];
  readonly rollback: ConflictRollbackPlan;
  readonly snapshotAfterApply: ConflictRepositorySnapshot;
}

export interface ConflictOperationResult {
  readonly changed: boolean;
  readonly operation: ConflictOperationKind;
  readonly command: string;
  readonly snapshot: ConflictRepositorySnapshot;
}

export interface MergeEditorCommand {
  readonly commandIdentifier: "git.openMergeEditor";
  /** Native merge editor receives a vscode.Uri in a real extension host. */
  readonly arguments: readonly [vscode.Uri | string];
}

export interface ConflictOperationSideLabels {
  readonly current: string;
  readonly incoming: string;
  readonly currentExplanation: string;
  readonly incomingExplanation: string;
}

/** Git's stage 2/3 names are operation-specific. */
export function conflictOperationSideLabels(
  operation: ConflictOperationKind,
): ConflictOperationSideLabels {
  switch (operation) {
    case "rebase":
      return {
        current: "Ours (rebase target)",
        incoming: "Theirs (replayed commit)",
        currentExplanation:
          "Git stage 2: the upstream/onto target that the commit is replayed onto.",
        incomingExplanation:
          "Git stage 3: the commit currently being replayed during rebase.",
      };
    case "am":
      return {
        current: "Ours (patch target)",
        incoming: "Theirs (mail patch)",
        currentExplanation:
          "Git stage 2: the checked-out target receiving the patch.",
        incomingExplanation:
          "Git stage 3: the patch currently being applied by git am.",
      };
    case "cherry-pick":
      return {
        current: "Ours (target branch)",
        incoming: "Theirs (picked commit)",
        currentExplanation:
          "Git stage 2: the checked-out branch receiving the commit.",
        incomingExplanation:
          "Git stage 3: the commit currently being cherry-picked.",
      };
    case "revert":
      return {
        current: "Ours (target branch)",
        incoming: "Theirs (revert source)",
        currentExplanation:
          "Git stage 2: the checked-out branch receiving the revert.",
        incomingExplanation:
          "Git stage 3: the change Git is applying to reverse the source commit.",
      };
    case "merge":
      return {
        current: "Ours (target branch)",
        incoming: "Theirs (merged source)",
        currentExplanation:
          "Git stage 2: the checked-out branch receiving the merge.",
        incomingExplanation:
          "Git stage 3: the branch or commit being merged into the target.",
      };
  }
}
