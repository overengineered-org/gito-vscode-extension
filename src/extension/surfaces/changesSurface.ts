import * as vscode from "vscode";
import {
  getCommandEligibleChanges,
  type LocalGitChangeAction,
} from "../commands/gitChangeSelection.js";
import { localGitCommandIds } from "../commands/localGitCommands.js";
import type {
  GitChangeGroup,
  LocalGitChange,
  LocalGitChangesSnapshot,
} from "../git/localGitModels.js";
import {
  executeSurfaceCommand,
  formatCount,
  withSurfaceProgress,
} from "./surfaceUtilities.js";
import type { GitoSurfaceServices } from "./surfaceTypes.js";

type ChangesAction =
  "stageAll" | "unstageAll" | "commit" | "openDiff" | LocalGitChangeAction;

interface ChangesQuickPickItem extends vscode.QuickPickItem {
  readonly action?: ChangesAction;
  readonly change?: LocalGitChange;
}

const changeGroupLabels: Readonly<Record<GitChangeGroup, string>> = {
  mergeChanges: "Merge changes",
  stagedChanges: "Staged changes",
  changes: "Changes",
  untracked: "Untracked",
};

const changeGroupOrder: readonly GitChangeGroup[] = [
  "mergeChanges",
  "stagedChanges",
  "changes",
  "untracked",
];

const actionLabels: Readonly<Record<ChangesAction, string>> = {
  stageAll: "Stage all changes",
  unstageAll: "Unstage all changes",
  commit: "Commit staged changes",
  stage: "Stage selected",
  unstage: "Unstage selected",
  discard: "Discard selected",
  openDiff: "Open diff",
};

/** Native, action-oriented view over VS Code's four local change groups. */
export class ChangesSurface {
  public constructor(private readonly services: GitoSurfaceServices) {}

  public async open(): Promise<void> {
    const changesSnapshot = await withSurfaceProgress(
      "Git'o: Loading changes",
      () =>
        this.services.repositoryService.getChangesSnapshot(undefined, {
          refreshStatus: true,
        }),
    );
    if (changesSnapshot.totalChangeCount === 0) {
      await vscode.window.showInformationMessage("Working tree is clean.");
      return;
    }

    const selectedItems = await vscode.window.showQuickPick(
      this.createChangeItems(changesSnapshot),
      {
        canPickMany: true,
        title: `Changes · ${formatCount(changesSnapshot.totalChangeCount, "file")}`,
        placeHolder: "Select files to act on",
        matchOnDescription: true,
      },
    );
    if (selectedItems === undefined) return;

    const selectedChanges = selectedItems.flatMap((selectedItem) =>
      selectedItem.change === undefined ? [] : [selectedItem.change],
    );
    const action = await this.promptForAction(selectedChanges.length > 0);
    if (action === undefined) return;
    await this.runAction(action, selectedChanges, changesSnapshot);
  }

  private createChangeItems(
    changesSnapshot: LocalGitChangesSnapshot,
  ): readonly ChangesQuickPickItem[] {
    const items: ChangesQuickPickItem[] = [];
    for (const group of changeGroupOrder) {
      const changes = changesSnapshot[group];
      items.push({
        label: `${changeGroupLabels[group]} · ${changes.length}`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const change of changes) {
        items.push({
          label: change.relativePath,
          description: change.statusLabel,
          ...(group === "mergeChanges"
            ? { detail: "Resolve this conflict" }
            : {}),
          resourceUri: change.resourceUri,
          change,
        });
      }
    }
    return items;
  }

  private getAvailableActions(): readonly ChangesAction[] {
    return [
      "stage",
      "unstage",
      "discard",
      "openDiff",
      "stageAll",
      "unstageAll",
      "commit",
    ];
  }

  private async promptForAction(
    hasSelectedChanges: boolean,
  ): Promise<ChangesAction | undefined> {
    const actions = this.getAvailableActions();
    const selectedAction = await vscode.window.showQuickPick(
      actions.map((action) => ({ label: actionLabels[action], action })),
      {
        title: "Changes · Choose action",
        placeHolder: hasSelectedChanges
          ? "Choose an action for the selected files"
          : "Choose a repository action",
      },
    );
    return selectedAction?.action;
  }

  private async runAction(
    action: ChangesAction,
    selectedChanges: readonly LocalGitChange[],
    changesSnapshot: LocalGitChangesSnapshot,
  ): Promise<void> {
    if (action === "openDiff") {
      if (selectedChanges.length !== 1) {
        await vscode.window.showInformationMessage(
          "Select exactly one file to open a diff.",
        );
        return;
      }
      await executeSurfaceCommand(this.services, localGitCommandIds.openDiff, {
        repositoryRoot: changesSnapshot.repositoryRoot,
        change: selectedChanges[0],
      });
      return;
    }
    if (action === "stage" || action === "unstage" || action === "discard") {
      const eligibleChanges = getCommandEligibleChanges(
        changesSnapshot,
        action,
      ).filter((eligibleChange) =>
        selectedChanges.some(
          (selectedChange) =>
            getChangeIdentity(selectedChange) ===
            getChangeIdentity(eligibleChange),
        ),
      );
      if (eligibleChanges.length === 0) {
        await vscode.window.showInformationMessage(
          `No selected files can be ${action === "discard" ? "discarded" : `${action}d`}.`,
        );
        return;
      }
      const commandIdentifier =
        action === "stage"
          ? localGitCommandIds.stageChanges
          : action === "unstage"
            ? localGitCommandIds.unstageChanges
            : localGitCommandIds.discardChanges;
      await withSurfaceProgress(`Git'o: ${actionLabels[action]}`, () =>
        executeSurfaceCommand(this.services, commandIdentifier, {
          repositoryRoot: changesSnapshot.repositoryRoot,
          changes: eligibleChanges,
        }).then(() => undefined),
      );
      return;
    }

    const commandByAction: Readonly<
      Partial<Record<Exclude<ChangesAction, LocalGitChangeAction>, string>>
    > = {
      stageAll: localGitCommandIds.stageAll,
      unstageAll: localGitCommandIds.unstageAll,
      commit: localGitCommandIds.commit,
    };
    const commandIdentifier = commandByAction[action];
    if (commandIdentifier === undefined) return;
    await withSurfaceProgress(`Git'o: ${actionLabels[action]}`, () =>
      executeSurfaceCommand(this.services, commandIdentifier, {
        repositoryRoot: changesSnapshot.repositoryRoot,
      }).then(() => undefined),
    );
  }
}

function getChangeIdentity(change: LocalGitChange): string {
  return (
    change.changeId ??
    `${change.group}\u0000${String(change.status)}\u0000${change.resourceUri.toString()}`
  );
}
