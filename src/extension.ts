import * as vscode from "vscode";

import { ChangesSidebar, type ChangesSidebarNode } from "./changesSidebar.ts";
import { CommitView } from "./commitView.ts";
import { ConflictGuide } from "./conflictGuide.ts";
import { CurrentLineBlame } from "./currentLineBlame.ts";
import { loadBuiltInGitApi } from "./gitApi.ts";
import { GitSidebar, type GitSidebarNode } from "./gitSidebar.ts";
import { GraphView } from "./graphView.ts";
import { WorkspaceRepositories } from "./workspaceRepositories.ts";
import { Worktrees } from "./worktrees.ts";

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  const builtInGitApi = await loadBuiltInGitApi();
  const diagnostics = vscode.window.createOutputChannel("Git'o", { log: true });
  const workspaceRepositories = new WorkspaceRepositories(builtInGitApi);
  const worktrees = new Worktrees(builtInGitApi, extensionContext.globalState, diagnostics);
  const conflictGuide = new ConflictGuide(diagnostics);
  const currentLineBlame = new CurrentLineBlame(
    builtInGitApi,
    workspaceRepositories,
    diagnostics,
  );
  const gitSidebar = new GitSidebar(
    builtInGitApi,
    workspaceRepositories,
    worktrees,
    diagnostics,
  );
  const commitView = new CommitView(workspaceRepositories, diagnostics);
  const changesSidebar = new ChangesSidebar(workspaceRepositories);
  const graphView = new GraphView(builtInGitApi, workspaceRepositories, diagnostics);
  extensionContext.subscriptions.push(
    workspaceRepositories,
    worktrees,
    diagnostics,
    gitSidebar,
    commitView,
    changesSidebar,
    currentLineBlame,
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
    vscode.commands.registerCommand("gito.resolveConflict", (sidebarNode?: ChangesSidebarNode) =>
      sidebarNode?.nodeType === "change" && sidebarNode.groupKind === "conflicts"
        ? conflictGuide.open(
            sidebarNode.repository,
            sidebarNode.change.uri,
            sidebarNode.changePosition,
            sidebarNode.changeCount,
          )
        : undefined,
    ),
    vscode.commands.registerCommand("gito.toggleCommitDiffLayout", () =>
      vscode.commands.executeCommand("toggle.diff.renderSideBySide"),
    ),
    vscode.commands.registerCommand("gito.showFileHistory", (fileUri?: vscode.Uri) =>
      graphView.showFileHistory(fileUri),
    ),
    vscode.commands.registerCommand("gito.showCurrentLineBlame", () =>
      currentLineBlame.showDetails(),
    ),
    vscode.commands.registerCommand("gito.toggleInlineBlame", () =>
      currentLineBlame.toggleInlineAnnotation(),
    ),
    vscode.commands.registerCommand("gito.refreshGit", () => gitSidebar.refresh()),
    vscode.commands.registerCommand("gito.createWorktree", (repositoryRootUri?: vscode.Uri) => {
      const repository =
        repositoryRootUri === undefined
          ? undefined
          : workspaceRepositories.findRepository(repositoryRootUri.fsPath);
      return repository === undefined
        ? undefined
        : worktrees.promptToCreateFeatureWorktree(repository);
    }),
    vscode.commands.registerCommand(
      "gito.openWorktreeInCurrentWindow",
      (worktreeNodeOrPath?: GitSidebarNode | string) => {
        const worktreePath = resolveWorktreePath(worktreeNodeOrPath);
        return worktreePath === undefined ? undefined : worktrees.openWorktree(worktreePath, false);
      },
    ),
    vscode.commands.registerCommand(
      "gito.openWorktreeInNewWindow",
      (worktreeNodeOrPath?: GitSidebarNode | string) => {
        const worktreePath = resolveWorktreePath(worktreeNodeOrPath);
        return worktreePath === undefined ? undefined : worktrees.openWorktree(worktreePath, true);
      },
    ),
    vscode.commands.registerCommand("gito.renameWorktree", (sidebarNode?: GitSidebarNode) =>
      sidebarNode?.nodeType === "worktree"
        ? worktrees.promptToRenameWorktree(sidebarNode.worktree)
        : undefined,
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

function resolveWorktreePath(sidebarNodeOrPath: GitSidebarNode | string | undefined): string | undefined {
  if (typeof sidebarNodeOrPath === "string") {
    return sidebarNodeOrPath;
  }
  return sidebarNodeOrPath?.nodeType === "worktree"
    ? sidebarNodeOrPath.worktree.path
    : undefined;
}
