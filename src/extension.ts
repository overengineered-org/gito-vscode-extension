import * as vscode from "vscode";

import { ChangesSidebar, type ChangesSidebarNode } from "./changesSidebar.ts";
import { CommitView } from "./commitView.ts";
import { loadBuiltInGitApi } from "./gitApi.ts";
import { GitSidebar } from "./gitSidebar.ts";
import { GraphView } from "./graphView.ts";
import { WorkspaceRepositories } from "./workspaceRepositories.ts";

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  const builtInGitApi = await loadBuiltInGitApi();
  const diagnostics = vscode.window.createOutputChannel("Git'o", { log: true });
  const workspaceRepositories = new WorkspaceRepositories(builtInGitApi);
  const gitSidebar = new GitSidebar(builtInGitApi, workspaceRepositories, diagnostics);
  const commitView = new CommitView(workspaceRepositories, diagnostics);
  const changesSidebar = new ChangesSidebar(workspaceRepositories);
  const graphView = new GraphView(workspaceRepositories, diagnostics);
  extensionContext.subscriptions.push(
    workspaceRepositories,
    diagnostics,
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
      changesSidebar.runChangeAction("stage", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.unstageChange", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runChangeAction("unstage", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.discardChange", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runChangeAction("discard", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.stageGroup", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runGroupAction("stage", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.unstageGroup", (sidebarNode?: ChangesSidebarNode) =>
      changesSidebar.runGroupAction("unstage", sidebarNode),
    ),
    vscode.commands.registerCommand("gito.toggleCommitDiffLayout", () =>
      vscode.commands.executeCommand("toggle.diff.renderSideBySide"),
    ),
    vscode.commands.registerCommand("gito.pruneLocalBranches", (repositoryRootUri?: vscode.Uri) =>
      repositoryRootUri === undefined
        ? undefined
        : gitSidebar.pruneLocalBranches(repositoryRootUri),
    ),
    vscode.commands.registerCommand("gito.compareRemoteTags", (repositoryRootUri?: vscode.Uri) => {
      const targetRepositoryRootUri =
        repositoryRootUri ?? workspaceRepositories.selectedRepository?.rootUri;
      return targetRepositoryRootUri === undefined
        ? undefined
        : gitSidebar.compareRemoteTags(targetRepositoryRootUri);
    }),
    vscode.commands.registerCommand(
      "gito.switchReference",
      (repositoryRootUri?: vscode.Uri, referenceType?: "branch" | "tag") =>
        repositoryRootUri === undefined || referenceType === undefined
          ? undefined
          : gitSidebar.switchReference(repositoryRootUri, referenceType),
    ),
  );
}
