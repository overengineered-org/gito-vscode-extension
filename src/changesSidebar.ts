import { basename, dirname, relative } from "node:path";

import * as vscode from "vscode";

import type { GitChange, GitRepository } from "./gitApi.ts";
import { createGitSidebarTreeItemId } from "./gitSidebarIdentity.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

type ChangeGroupKind = "conflicts" | "staged" | "unstaged";
type ChangeAction = "discard" | "stage" | "unstage";

export type ChangesSidebarNode =
  | {
      readonly changes: readonly GitChange[];
      readonly groupKind: ChangeGroupKind;
      readonly nodeType: "group";
      readonly repository: GitRepository;
    }
  | {
      readonly change: GitChange;
      readonly groupKind: ChangeGroupKind;
      readonly nodeType: "change";
      readonly repository: GitRepository;
    }
  | { readonly nodeType: "clean"; readonly repository: GitRepository };

export class ChangesSidebar
  implements vscode.TreeDataProvider<ChangesSidebarNode>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<ChangesSidebarNode | undefined>();
  private readonly workspaceRepositorySubscription: vscode.Disposable;

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly workspaceRepositories: WorkspaceRepositories) {
    this.workspaceRepositorySubscription = workspaceRepositories.onDidChange(() =>
      this.changedEmitter.fire(undefined),
    );
  }

  public dispose(): void {
    this.workspaceRepositorySubscription.dispose();
    this.changedEmitter.dispose();
  }

  public getChildren(parentNode?: ChangesSidebarNode): ChangesSidebarNode[] {
    if (parentNode?.nodeType === "group") {
      return parentNode.changes.map((change) => ({
        change,
        groupKind: parentNode.groupKind,
        nodeType: "change",
        repository: parentNode.repository,
      }));
    }
    if (parentNode !== undefined) {
      return [];
    }

    const selectedRepository = this.workspaceRepositories.selectedRepository;
    if (selectedRepository === undefined) {
      return [];
    }
    const changeGroups = createChangeGroups(selectedRepository);
    return changeGroups.length === 0
      ? [{ nodeType: "clean", repository: selectedRepository }]
      : changeGroups;
  }

  public getTreeItem(sidebarNode: ChangesSidebarNode): vscode.TreeItem {
    switch (sidebarNode.nodeType) {
      case "group":
        return createChangeGroupTreeItem(sidebarNode);
      case "change":
        return createChangeTreeItem(sidebarNode);
      case "clean":
        return createCleanTreeItem(sidebarNode.repository);
    }
  }

  public async runChangeAction(
    changeAction: ChangeAction,
    sidebarNode: ChangesSidebarNode | undefined,
  ): Promise<void> {
    if (sidebarNode?.nodeType !== "change") {
      return;
    }
    if (changeAction === "stage") {
      await sidebarNode.repository.add([sidebarNode.change.uri]);
      return;
    }
    if (changeAction === "unstage") {
      await sidebarNode.repository.revert([sidebarNode.change.uri]);
      return;
    }
    const discardConfirmation = await vscode.window.showWarningMessage(
      `Discard changes in '${basename(sidebarNode.change.uri.fsPath)}'?`,
      { modal: true },
      "Discard Changes",
    );
    if (discardConfirmation === "Discard Changes") {
      await sidebarNode.repository.clean([sidebarNode.change.uri]);
    }
  }

  public async runGroupAction(
    changeAction: "stage" | "unstage",
    sidebarNode: ChangesSidebarNode | undefined,
  ): Promise<void> {
    if (sidebarNode?.nodeType === "group") {
      const changeUris = sidebarNode.changes.map((change) => change.uri);
      await (changeAction === "stage"
        ? sidebarNode.repository.add(changeUris)
        : sidebarNode.repository.revert(changeUris));
    }
  }
}

function createChangeGroups(repository: GitRepository): ChangesSidebarNode[] {
  const groups: readonly [ChangeGroupKind, readonly GitChange[]][] = [
    ["conflicts", repository.state.mergeChanges],
    ["staged", repository.state.indexChanges],
    [
      "unstaged",
      [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges].toSorted(
        compareChangePaths,
      ),
    ],
  ];
  return groups.flatMap(([groupKind, changes]) =>
    changes.length === 0
      ? []
      : [{ changes, groupKind, nodeType: "group" as const, repository }],
  );
}

function createChangeGroupTreeItem(
  changeGroupNode: Extract<ChangesSidebarNode, { readonly nodeType: "group" }>,
): vscode.TreeItem {
  const groupPresentation = {
    conflicts: { icon: "warning", label: "Conflicts" },
    staged: { icon: "pass-filled", label: "Staged Changes" },
    unstaged: { icon: "diff", label: "Changes" },
  }[changeGroupNode.groupKind];
  const changeGroupTreeItem = new vscode.TreeItem(
    groupPresentation.label,
    vscode.TreeItemCollapsibleState.Expanded,
  );
  changeGroupTreeItem.description = String(changeGroupNode.changes.length);
  changeGroupTreeItem.id = createGitSidebarTreeItemId(
    changeGroupNode.repository.rootUri.fsPath,
    "change-group",
    changeGroupNode.groupKind,
  );
  changeGroupTreeItem.iconPath = new vscode.ThemeIcon(groupPresentation.icon);
  changeGroupTreeItem.contextValue = `gito.group.${changeGroupNode.groupKind}`;
  return changeGroupTreeItem;
}

function createChangeTreeItem(
  changeNode: Extract<ChangesSidebarNode, { readonly nodeType: "change" }>,
): vscode.TreeItem {
  const relativeChangePath = relative(changeNode.repository.rootUri.fsPath, changeNode.change.uri.fsPath);
  const parentDirectory = dirname(relativeChangePath);
  const changeTreeItem = new vscode.TreeItem(basename(relativeChangePath));
  changeTreeItem.id = createGitSidebarTreeItemId(
    changeNode.repository.rootUri.fsPath,
    "change",
    `${changeNode.groupKind}:${changeNode.change.uri.toString()}`,
  );
  changeTreeItem.description = `${parentDirectory === "." ? "" : parentDirectory} ${statusLabel(changeNode.change.status)}`.trim();
  changeTreeItem.resourceUri = changeNode.change.uri;
  changeTreeItem.contextValue = `gito.change.${changeNode.groupKind}`;
  changeTreeItem.command = {
    arguments: [changeNode.change.uri],
    command: "git.openChange",
    title: `Open ${relativeChangePath}`,
  };
  changeTreeItem.tooltip = new vscode.MarkdownString(
    `**${relativeChangePath}**\n\n${statusName(changeNode.change.status)}`,
  );
  return changeTreeItem;
}

function createCleanTreeItem(repository: GitRepository): vscode.TreeItem {
  const cleanTreeItem = new vscode.TreeItem("Working Tree Clean");
  cleanTreeItem.id = createGitSidebarTreeItemId(repository.rootUri.fsPath, "working-tree-clean");
  cleanTreeItem.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
  return cleanTreeItem;
}

function compareChangePaths(firstChange: GitChange, secondChange: GitChange): number {
  return firstChange.uri.fsPath.localeCompare(secondChange.uri.fsPath);
}

function statusLabel(status: number): string {
  return statusLabels[status] ?? "?";
}

function statusName(status: number): string {
  return statusNames[status] ?? "Changed";
}

const statusLabels = [
  "M",
  "A",
  "D",
  "R",
  "C",
  "M",
  "D",
  "U",
  "I",
  "A",
  "R",
  "T",
  "AU",
  "UA",
  "DU",
  "UD",
  "AA",
  "DD",
  "UU",
] as const;

const statusNames = [
  "Staged modification",
  "Staged addition",
  "Staged deletion",
  "Staged rename",
  "Staged copy",
  "Modified",
  "Deleted",
  "Untracked",
  "Ignored",
  "Intent to add",
  "Intent to rename",
  "Type changed",
  "Added by us",
  "Added by them",
  "Deleted by us",
  "Deleted by them",
  "Added by both",
  "Deleted by both",
  "Modified by both",
] as const;
