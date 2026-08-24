import * as vscode from "vscode";
import {
  createIndexSource,
  createMergeBaseSource,
  createRevisionSource,
  createWorkingTreeSource,
  type DiffRepositorySource,
} from "../diff/index.js";
import type {
  GitDiffRepositoryBinding,
  GitDiffService,
} from "../diff/index.js";

export interface DiffSourcePickerDependencies {
  readonly gitDiffService: Pick<GitDiffService, "listGitRevisions">;
}

export interface DiffSourcePickContext {
  readonly repositoryRoot: vscode.Uri;
  readonly repositoryBinding?: GitDiffRepositoryBinding;
  readonly prompt: string;
  readonly placeHolder: string;
}

export interface DiffSourceQuickPickItem extends vscode.QuickPickItem {
  readonly sourceKind:
    DiffRepositorySource["kind"] | "revision-choice" | "merge-base-choice";
  readonly revision?: string;
}

/** Stable labels are deliberately plain so users can scan the picker quickly. */
export function createDiffSourceQuickPickItems(
  revisions: readonly string[],
): readonly DiffSourceQuickPickItem[] {
  const builtInItems: DiffSourceQuickPickItem[] = [
    {
      label: "Working Tree",
      description: "Uncommitted files on disk",
      sourceKind: "working-tree",
    },
    {
      label: "Staged",
      description: "Changes currently in the index",
      sourceKind: "index",
    },
    {
      label: "HEAD",
      description: "Current commit",
      sourceKind: "revision-choice",
      revision: "HEAD",
    },
    {
      label: "Branch, tag, or commit…",
      description: "Choose another Git revision",
      sourceKind: "revision-choice",
    },
    {
      label: "Common base…",
      description: "Compare from the merge-base of two revisions",
      sourceKind: "merge-base-choice",
    },
  ];
  const revisionItems = revisions.map((revision): DiffSourceQuickPickItem => ({
    label: revision,
    description: "Git revision",
    sourceKind: "revision-choice",
    revision,
  }));
  return [...builtInItems, ...revisionItems];
}

export async function pickDiffSource(
  dependencies: DiffSourcePickerDependencies,
  context: DiffSourcePickContext,
): Promise<DiffRepositorySource | undefined> {
  const revisions = await loadGitRevisionsWithProgress(
    dependencies.gitDiffService,
    context.repositoryRoot,
    context.repositoryBinding,
  );
  const selectedItem = await vscode.window.showQuickPick(
    createDiffSourceQuickPickItems(revisions),
    {
      title: context.prompt,
      placeHolder: context.placeHolder,
      matchOnDescription: true,
    },
  );
  if (selectedItem === undefined) return undefined;
  if (selectedItem.sourceKind === "working-tree")
    return createWorkingTreeSource(context.repositoryRoot);
  if (selectedItem.sourceKind === "index")
    return createIndexSource(context.repositoryRoot);
  if (selectedItem.sourceKind === "revision-choice") {
    const revision =
      selectedItem.revision ??
      (await vscode.window.showInputBox({
        prompt: "Branch, tag, or commit",
        placeHolder: "main or 0123456",
        validateInput: validateRevisionInput,
      }));
    return revision === undefined
      ? undefined
      : createRevisionSource(context.repositoryRoot, revision);
  }
  const baseLeft = await pickRevision(
    dependencies.gitDiffService,
    context.repositoryRoot,
    context.repositoryBinding,
    "Choose the first revision for the common base",
  );
  if (baseLeft === undefined) return undefined;
  const baseRight = await pickRevision(
    dependencies.gitDiffService,
    context.repositoryRoot,
    context.repositoryBinding,
    "Choose the second revision for the common base",
  );
  return baseRight === undefined
    ? undefined
    : createMergeBaseSource(context.repositoryRoot, baseLeft, baseRight);
}

export async function listGitRevisions(
  gitDiffService: Pick<GitDiffService, "listGitRevisions">,
  repositoryRoot: vscode.Uri,
  repositoryBinding?: GitDiffRepositoryBinding,
  cancellationSignal?: AbortSignal,
): Promise<readonly string[]> {
  return gitDiffService.listGitRevisions(
    repositoryRoot,
    cancellationSignal,
    repositoryBinding,
  );
}

async function loadGitRevisionsWithProgress(
  gitDiffService: Pick<GitDiffService, "listGitRevisions">,
  repositoryRoot: vscode.Uri,
  repositoryBinding?: GitDiffRepositoryBinding,
): Promise<readonly string[]> {
  return vscode.window.withProgress<readonly string[]>(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading Git revisions",
      cancellable: true,
    },
    (_progress, cancellationToken) => {
      const cancellationController = new AbortController();
      if (cancellationToken.isCancellationRequested) {
        cancellationController.abort();
      }
      const cancellationSubscription =
        cancellationToken.onCancellationRequested(() =>
          cancellationController.abort(),
        );
      return listGitRevisions(
        gitDiffService,
        repositoryRoot,
        repositoryBinding,
        cancellationController.signal,
      )
        .then((loadedRevisions) => {
          if (cancellationController.signal.aborted)
            throw new DOMException(
              "Git revision loading cancelled",
              "AbortError",
            );
          return loadedRevisions;
        })
        .finally(() => {
          cancellationSubscription.dispose();
        });
    },
  );
}

async function pickRevision(
  gitDiffService: Pick<GitDiffService, "listGitRevisions">,
  repositoryRoot: vscode.Uri,
  repositoryBinding: GitDiffRepositoryBinding | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  const revisions = await loadGitRevisionsWithProgress(
    gitDiffService,
    repositoryRoot,
    repositoryBinding,
  );
  const selectedRevision = await vscode.window.showQuickPick(revisions, {
    placeHolder,
    matchOnDescription: true,
  });
  return selectedRevision;
}

function validateRevisionInput(candidateRevision: string): string | undefined {
  return candidateRevision.trim().length === 0
    ? "Enter a branch, tag, or commit."
    : undefined;
}
