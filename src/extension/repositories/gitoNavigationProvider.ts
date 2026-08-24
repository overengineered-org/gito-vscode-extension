import * as vscode from "vscode";

export const navigationDestinations = [
  "Home",
  "Changes",
  "Pull Requests",
  "Commits",
  "Branches",
  "Worktrees",
] as const;

export type GitoNavigationLabel = (typeof navigationDestinations)[number];

const navigationCommandByLabel: Readonly<Record<GitoNavigationLabel, string>> =
  {
    Home: "gito.openHome",
    Changes: "gito.openChanges",
    "Pull Requests": "gito.openPullRequests",
    Commits: "gito.openCommits",
    Branches: "gito.openBranches",
    Worktrees: "gito.openWorktrees",
  };

const navigationIconByLabel: Readonly<Record<GitoNavigationLabel, string>> = {
  Home: "home",
  Changes: "source-control",
  "Pull Requests": "git-pull-request",
  Commits: "history",
  Branches: "git-branch",
  Worktrees: "repo-clone",
};

export class GitoNavigationProvider implements vscode.TreeDataProvider<GitoNavigationDestination> {
  private readonly changeEmitter = new vscode.EventEmitter<
    GitoNavigationDestination | undefined | null | void
  >();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public getTreeItem(
    navigationDestination: GitoNavigationDestination,
  ): vscode.TreeItem {
    return navigationDestination;
  }

  public getChildren(
    navigationDestination?: GitoNavigationDestination,
  ): GitoNavigationDestination[] {
    if (navigationDestination !== undefined) return [];
    return navigationDestinations.map(
      (navigationLabel) => new GitoNavigationDestination(navigationLabel),
    );
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

export class GitoNavigationDestination extends vscode.TreeItem {
  public constructor(public readonly navigationLabel: GitoNavigationLabel) {
    super(navigationLabel, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: navigationCommandByLabel[navigationLabel],
      title: `Open ${navigationLabel}`,
    };
    this.iconPath = new vscode.ThemeIcon(
      navigationIconByLabel[navigationLabel],
    );
    this.contextValue = `gito.navigation.${navigationLabel.replaceAll(" ", "").toLowerCase()}`;
  }
}
