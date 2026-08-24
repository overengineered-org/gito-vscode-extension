import * as vscode from "vscode";
import { localGitCommandIds } from "../commands/localGitCommands.js";
import type { LocalGitWorktree } from "../git/localGitModels.js";
import {
  comparePaths,
  executeSurfaceCommand,
  formatCount,
  withSurfaceProgress,
} from "./surfaceUtilities.js";
import type { GitoSurfaceServices } from "./surfaceTypes.js";

type WorktreeAction = "create" | "refresh" | "open" | "remove";

interface WorktreeQuickPickItem extends vscode.QuickPickItem {
  readonly worktree?: LocalGitWorktree;
  readonly action?: WorktreeAction;
}

/** Worktree inventory with explicit locked/prunable/clean-removal state. */
export class WorktreesSurface {
  public constructor(private readonly services: GitoSurfaceServices) {}

  public async open(): Promise<void> {
    const repositoryRoot =
      await this.services.repositoryService.getRepositoryRoot();
    const worktrees = await withSurfaceProgress(
      "Git'o: Loading worktrees",
      (cancellationSignal) =>
        this.services.worktreeService.listWorktrees(
          repositoryRoot,
          cancellationSignal,
        ),
    );
    if (worktrees.length === 0) {
      await vscode.window.showInformationMessage(
        "No worktrees are registered.",
      );
      return;
    }
    const selectedItem = await vscode.window.showQuickPick(
      this.createWorktreeItems(worktrees, repositoryRoot.fsPath),
      {
        title: `Worktrees · ${formatCount(worktrees.length, "worktree")}`,
        placeHolder: "Select a worktree or worktree action",
        matchOnDescription: true,
      },
    );
    if (selectedItem === undefined) return;
    if (selectedItem.action === "create") {
      await withSurfaceProgress(
        "Git'o: Creating worktree",
        (cancellationSignal) =>
          executeSurfaceCommand(
            this.services,
            localGitCommandIds.createWorktree,
            { repositoryRoot, cancellationSignal },
          ).then(() => undefined),
      );
      return;
    }
    if (selectedItem.action === "refresh") {
      await this.open();
      return;
    }
    if (selectedItem.worktree !== undefined) {
      await this.showWorktreeActions(
        selectedItem.worktree,
        repositoryRoot.fsPath,
        repositoryRoot,
      );
    }
  }

  private createWorktreeItems(
    worktrees: readonly LocalGitWorktree[],
    repositoryRootPath: string,
  ): readonly WorktreeQuickPickItem[] {
    const items: WorktreeQuickPickItem[] = [
      { label: "Create worktree…", action: "create" },
      { label: "Refresh worktrees", action: "refresh" },
      {
        label: "Registered worktrees",
        kind: vscode.QuickPickItemKind.Separator,
      },
    ];
    for (const worktree of worktrees) {
      const isMainWorktree = comparePaths(worktree.path, repositoryRootPath);
      const stateLabels = [
        isMainWorktree ? "main" : undefined,
        worktree.isLocked
          ? `locked${worktree.lockReason === undefined ? "" : `: ${worktree.lockReason}`}`
          : undefined,
        worktree.isPrunable
          ? `prunable${worktree.pruneReason === undefined ? "" : `: ${worktree.pruneReason}`}`
          : undefined,
      ].filter((stateLabel): stateLabel is string => stateLabel !== undefined);
      items.push({
        label: `${worktree.branchName ?? "(detached HEAD)"}`,
        description: `${worktree.path} · ${stateLabels.join(" · ") || "ready"}`,
        detail: `HEAD ${worktree.headSha.slice(0, 7)}`,
        worktree,
      });
    }
    return items;
  }

  private async showWorktreeActions(
    worktree: LocalGitWorktree,
    repositoryRootPath: string,
    repositoryRoot: vscode.Uri,
  ): Promise<void> {
    const isMainWorktree = comparePaths(worktree.path, repositoryRootPath);
    const actions: readonly WorktreeQuickPickItem[] = [
      { label: "Open worktree in new window", action: "open" },
      ...(isMainWorktree || worktree.isLocked || worktree.isPrunable
        ? []
        : [{ label: "Remove clean worktree", action: "remove" as const }]),
    ];
    const selectedAction = await vscode.window.showQuickPick(actions, {
      title: `${worktree.branchName ?? "Detached worktree"} · Worktree actions`,
      placeHolder:
        isMainWorktree || worktree.isLocked || worktree.isPrunable
          ? "Main, locked, or prunable worktrees can only be opened"
          : "Choose a worktree action",
    });
    if (selectedAction?.action === undefined) return;
    const commandIdentifier =
      selectedAction.action === "open"
        ? localGitCommandIds.openWorktree
        : localGitCommandIds.removeWorktree;
    await withSurfaceProgress(
      `Git'o: ${selectedAction.label}`,
      (cancellationSignal) =>
        executeSurfaceCommand(this.services, commandIdentifier, {
          repositoryRoot,
          worktreePath: worktree.path,
          cancellationSignal,
        }).then(() => undefined),
    );
  }
}
