import { basename, dirname, relative } from "node:path";

import * as vscode from "vscode";

import type { GitChange, GitRepository } from "./gitApi.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

type ChangeGroupKind = "conflicts" | "staged" | "unstaged";

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
  | { readonly nodeType: "clean" };

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
    return changeGroups.length === 0 ? [{ nodeType: "clean" }] : changeGroups;
  }

  public getTreeItem(sidebarNode: ChangesSidebarNode): vscode.TreeItem {
    switch (sidebarNode.nodeType) {
      case "group":
        return createChangeGroupTreeItem(sidebarNode);
      case "change":
        return createChangeTreeItem(sidebarNode);
      case "clean":
        return createCleanTreeItem();
    }
  }

  public async runChangeAction(
    nativeGitCommand: "git.clean" | "git.stage" | "git.unstage",
    sidebarNode: ChangesSidebarNode | undefined,
  ): Promise<void> {
    if (sidebarNode?.nodeType === "change") {
      await vscode.commands.executeCommand(nativeGitCommand, sidebarNode.change.uri);
    }
  }

  public async runGroupAction(
    nativeGitCommand: "git.stageAll" | "git.stageAllMerge" | "git.unstageAll",
    sidebarNode: ChangesSidebarNode | undefined,
  ): Promise<void> {
    if (sidebarNode?.nodeType === "group") {
      await vscode.commands.executeCommand(nativeGitCommand, sidebarNode.repository.rootUri);
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

function createCleanTreeItem(): vscode.TreeItem {
  const cleanTreeItem = new vscode.TreeItem("Working Tree Clean");
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
