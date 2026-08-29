import * as vscode from "vscode";

import { ChangesSidebar, type ChangesSidebarNode } from "./changesSidebar.ts";
import { CommitView } from "./commitView.ts";
import { loadBuiltInGitApi } from "./gitApi.ts";
import { GitSidebar } from "./gitSidebar.ts";
import { GraphView } from "./graphView.ts";
import { WorkspaceRepositories } from "./workspaceRepositories.ts";

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  const builtInGitApi = await loadBuiltInGitApi();
  const workspaceRepositories = new WorkspaceRepositories(builtInGitApi);
  const gitSidebar = new GitSidebar(builtInGitApi, workspaceRepositories);
  const commitView = new CommitView(workspaceRepositories);
  const changesSidebar = new ChangesSidebar(workspaceRepositories);
  const graphView = new GraphView(workspaceRepositories);
  extensionContext.subscriptions.push(
    workspaceRepositories,
    gitSidebar,
    commitView,
    changesSidebar,
    graphView,
    vscode.window.registerTreeDataProvider("gito.git", gitSidebar),
    vscode.window.registerWebviewViewProvider("gito.commit", commitView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider("gito.changes", changesSidebar),
    vscode.window.registerWebviewViewProvider("gito.graph", graphView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("gito.stageChange", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runChangeAction("git.stage", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.unstageChange", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runChangeAction("git.unstage", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.discardChange", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runChangeAction("git.clean", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.stageGroup", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runGroupAction(
        sidebarNode?.nodeType === "group" && sidebarNode.groupKind === "conflicts"
          ? "git.stageAllMerge"
          : "git.stageAll",
        sidebarNode,
      ),
    ),
    vscode.commands.registerCommand("gito.unstageGroup", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runGroupAction("git.unstageAll", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.pruneLocalBranches", (repositoryRootUri?: vscode.Uri) =>
      repositoryRootUri === undefined
        ? undefined
        : gitSidebar.pruneLocalBranches(repositoryRootUri),
    ),
    vscode.commands.registerCommand("gito.compareRemoteTags", (repositoryRootUri?: vscode.Uri) =>
      repositoryRootUri === undefined
        ? undefined
        : gitSidebar.compareRemoteTags(repositoryRootUri),
    ),
    vscode.commands.registerCommand(
      "gito.switchReference",
      (repositoryRootUri?: vscode.Uri, referenceType?: "branch" | "tag") =>
        repositoryRootUri === undefined || referenceType === undefined
          ? undefined
          : gitSidebar.switchReference(repositoryRootUri, referenceType),
    ),
  );
}
