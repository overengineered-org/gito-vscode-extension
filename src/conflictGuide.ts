import { basename } from "node:path";

import * as vscode from "vscode";

import {
  containsUnresolvedConflictMarkers,
  type ConflictGuideContext,
  type ConflictOperationKind,
  createConflictGuidePresentation,
} from "./conflictGuideModel.ts";
import type { GitCommit, GitRepository } from "./gitApi.ts";
import { type GitReference, GitReferenceType } from "./gitModel.ts";

type ConflictGuideAction = "abort" | "markResolved" | "openMergeEditor";

interface ConflictGuideQuickPickItem extends vscode.QuickPickItem {
  readonly conflictAction: ConflictGuideAction;
}

export class ConflictGuide {
  public constructor(private readonly diagnostics: vscode.LogOutputChannel) {}

  public async open(
    repository: GitRepository,
    conflictUri: vscode.Uri,
    conflictPosition: number,
    conflictCount: number,
  ): Promise<void> {
    let conflictContext: ConflictGuideContext;
    try {
      conflictContext = await inspectConflictContext(repository);
    } catch (conflictInspectionFailure) {
      this.diagnostics.warn("Conflict context inspection failed.", conflictInspectionFailure);
      conflictContext = {
        currentBranchName: repository.state.HEAD?.name,
        operationKind: "unknown",
      };
    }
    const conflictPresentation = createConflictGuidePresentation(conflictContext);
    const conflictAction = await vscode.window.showQuickPick(
      createConflictActions(conflictPresentation),
      {
        ignoreFocusOut: true,
        placeHolder: `${conflictPresentation.firstInputLabel}  •  ${conflictPresentation.secondInputLabel}  •  ${conflictPresentation.resultLabel}`,
        title: `${conflictPresentation.operationTitle} · Conflict ${conflictPosition} of ${conflictCount} · ${basename(conflictUri.fsPath)}`,
      },
    );
    if (conflictAction === undefined) {
      return;
    }
    switch (conflictAction.conflictAction) {
      case "openMergeEditor":
        await vscode.commands.executeCommand("git.openMergeEditor", conflictUri);
        return;
      case "markResolved":
        await this.markResolved(repository, conflictUri);
        return;
      case "abort":
        await this.abort(repository, conflictContext.operationKind, conflictPresentation.operationTitle);
    }
  }

  private async markResolved(repository: GitRepository, conflictUri: vscode.Uri): Promise<void> {
    try {
      const conflictContents = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(conflictUri),
      );
      if (containsUnresolvedConflictMarkers(conflictContents)) {
        const openMergeEditorAction = "Open Merge Editor";
        const selectedAction = await vscode.window.showWarningMessage(
          `Git'o found unresolved conflict markers in '${basename(conflictUri.fsPath)}'.`,
          openMergeEditorAction,
        );
        if (selectedAction === openMergeEditorAction) {
          await vscode.commands.executeCommand("git.openMergeEditor", conflictUri);
        }
        return;
      }
    } catch (conflictFileReadFailure) {
      if (
        !(conflictFileReadFailure instanceof vscode.FileSystemError) ||
        conflictFileReadFailure.code !== "FileNotFound"
      ) {
        this.diagnostics.error("Conflict file could not be checked.", conflictFileReadFailure);
        void vscode.window.showErrorMessage(
          `Git'o could not check '${basename(conflictUri.fsPath)}' for unresolved markers.`,
        );
        return;
      }
    }
    const markResolvedAction = "Mark Resolved";
    const selectedAction = await vscode.window.showWarningMessage(
      `Stage '${basename(conflictUri.fsPath)}' as resolved?`,
      { modal: true },
      markResolvedAction,
    );
    if (selectedAction === markResolvedAction) {
      await repository.add([conflictUri.fsPath]);
    }
  }

  private async abort(
    repository: GitRepository,
    operationKind: ConflictOperationKind,
    operationTitle: string,
  ): Promise<void> {
    if (operationKind !== "merge" && operationKind !== "rebase") {
      return;
    }
    const abortAction = operationKind === "rebase" ? "Abort Rebase" : "Abort Merge";
    const selectedAction = await vscode.window.showWarningMessage(
      `${operationTitle}. Return to the state before this operation?`,
      { modal: true },
      abortAction,
    );
    if (selectedAction !== abortAction) {
      return;
    }
    if (operationKind === "merge") {
      await repository.mergeAbort();
      return;
    }
    await vscode.commands.executeCommand("git.rebaseAbort", repository.rootUri);
  }
}

export async function inspectConflictContext(
  repository: GitRepository,
): Promise<ConflictGuideContext> {
  const branchReferences = await repository
    .getRefs({ pattern: ["refs/heads", "refs/remotes"] })
    .catch(() => []);
  const currentBranchName = repository.state.HEAD?.name;
  if (repository.state.rebaseCommit !== undefined) {
    const currentWorktree = repository.state.worktrees.find(
      (worktree) => vscode.Uri.file(worktree.path).fsPath === repository.rootUri.fsPath,
    );
    const sourceReferenceName =
      currentWorktree?.ref.replace(/^refs\/heads\//u, "") || currentBranchName;
    const baseReference =
      sourceReferenceName === undefined
        ? undefined
        : await repository.getBranchBase(sourceReferenceName).catch(() => undefined);
    return {
      baseReferenceName:
        baseReference?.name ?? findReferenceName(repository.state.HEAD?.commit, branchReferences),
      currentBranchName,
      operationCommit: repository.state.rebaseCommit,
      operationKind: "rebase",
      sourceReferenceName,
    };
  }
  const mergeCommit = await getCommitIfAvailable(repository, "MERGE_HEAD");
  if (mergeCommit !== undefined) {
    return {
      currentBranchName,
      operationCommit: mergeCommit,
      operationKind: "merge",
      sourceReferenceName: findReferenceName(mergeCommit.hash, branchReferences),
    };
  }
  const cherryPickCommit = await getCommitIfAvailable(repository, "CHERRY_PICK_HEAD");
  return cherryPickCommit === undefined
    ? { currentBranchName, operationKind: "unknown" }
    : {
        currentBranchName,
        operationCommit: cherryPickCommit,
        operationKind: "cherryPick",
      };
}

function createConflictActions(
  conflictPresentation: ReturnType<typeof createConflictGuidePresentation>,
): readonly ConflictGuideQuickPickItem[] {
  return [
    {
      conflictAction: "openMergeEditor",
      description: "Recommended",
      detail: `${conflictPresentation.firstInputLabel}  •  ${conflictPresentation.secondInputLabel}`,
      label: "$(layout) Open Merge Editor",
    },
    {
      conflictAction: "markResolved",
      detail: "Stages the finished file only after conflict markers are removed",
      label: "$(pass-filled) Mark File Resolved",
    },
    ...(conflictPresentation.abortActionLabel === undefined
      ? []
      : [
          {
            conflictAction: "abort" as const,
            detail: "Restores the repository to before this operation",
            label: `$(debug-restart) ${conflictPresentation.abortActionLabel}`,
          },
        ]),
  ];
}

async function getCommitIfAvailable(
  repository: GitRepository,
  gitReference: string,
): Promise<GitCommit | undefined> {
  try {
    return await repository.getCommit(gitReference);
  } catch {
    return undefined;
  }
}

function findReferenceName(
  commitHash: string | undefined,
  branchReferences: readonly GitReference[],
): string | undefined {
  if (commitHash === undefined) {
    return undefined;
  }
  return branchReferences
    .filter(
      (branchReference) =>
        branchReference.commit === commitHash && branchReference.name !== undefined,
    )
    .toSorted(
      (firstReference, secondReference) =>
        referencePriority(firstReference) - referencePriority(secondReference),
    )[0]?.name;
}

function referencePriority(gitReference: GitReference): number {
  return gitReference.type === GitReferenceType.localBranch ? 0 : 1;
}
