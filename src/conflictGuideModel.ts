import type { GitCommit } from "./gitApi.ts";

export type ConflictOperationKind = "cherryPick" | "merge" | "rebase" | "unknown";

export interface ConflictGuideContext {
  readonly baseReferenceName?: string | undefined;
  readonly currentBranchName?: string | undefined;
  readonly operationCommit?: GitCommit;
  readonly operationKind: ConflictOperationKind;
  readonly sourceReferenceName?: string | undefined;
}

export interface ConflictGuidePresentation {
  readonly abortActionLabel?: string;
  readonly firstInputLabel: string;
  readonly operationTitle: string;
  readonly resultLabel: string;
  readonly secondInputLabel: string;
}

export function createConflictGuidePresentation(
  conflictContext: ConflictGuideContext,
): ConflictGuidePresentation {
  const currentBranchName = conflictContext.currentBranchName ?? "your checked-out branch";
  const operationCommitLabel = formatOperationCommit(conflictContext.operationCommit);

  switch (conflictContext.operationKind) {
    case "rebase": {
      const sourceReferenceName = conflictContext.sourceReferenceName ?? "your feature branch";
      const baseReferenceName = conflictContext.baseReferenceName ?? "the new base";
      return {
        abortActionLabel: "Abort Rebase",
        firstInputLabel: `Left · New base: ${baseReferenceName}`,
        operationTitle: `Rebasing ${sourceReferenceName} onto ${baseReferenceName}`,
        resultLabel: "Result · Resolved file",
        secondInputLabel: `Right · Your commit: ${operationCommitLabel}`,
      };
    }
    case "merge": {
      const sourceReferenceName =
        conflictContext.sourceReferenceName ?? `commit ${operationCommitLabel}`;
      return {
        abortActionLabel: "Abort Merge",
        firstInputLabel: `Left · Changes from: ${sourceReferenceName}`,
        operationTitle: `Merging ${sourceReferenceName} into ${currentBranchName}`,
        resultLabel: "Result · Resolved file",
        secondInputLabel: `Right · Target branch: ${currentBranchName}`,
      };
    }
    case "cherryPick":
      return {
        firstInputLabel: `Left · Chosen commit: ${operationCommitLabel}`,
        operationTitle: `Applying ${operationCommitLabel} to ${currentBranchName}`,
        resultLabel: "Result · Resolved file",
        secondInputLabel: `Right · Target branch: ${currentBranchName}`,
      };
    case "unknown":
      return {
        firstInputLabel: "Left · Other changes",
        operationTitle: "Resolving repository conflict",
        resultLabel: "Result · Resolved file",
        secondInputLabel: "Right · Your working copy",
      };
  }
}

export function containsUnresolvedConflictMarkers(fileContents: string): boolean {
  return (
    /^<{7}(?: .*)?$/mu.test(fileContents) &&
    /^={7}$/mu.test(fileContents) &&
    /^>{7}(?: .*)?$/mu.test(fileContents)
  );
}

function formatOperationCommit(operationCommit: GitCommit | undefined): string {
  if (operationCommit === undefined) {
    return "unknown commit";
  }
  const commitSubject = operationCommit.message.split(/\r?\n/u, 1)[0]?.trim();
  const shortHash = operationCommit.hash.slice(0, 7);
  return commitSubject === undefined || commitSubject === ""
    ? shortHash
    : `${shortHash} · ${commitSubject}`;
}
