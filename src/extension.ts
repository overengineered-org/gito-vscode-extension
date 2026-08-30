import * as vscode from "vscode";

import { WorkingTreeChanges } from "./workingTreeChanges.ts";
import { CommitView } from "./commitView.ts";
import { ConflictGuide } from "./conflictGuide.ts";
import { CurrentLineBlame } from "./currentLineBlame.ts";
import { openGettingStartedOnFirstActivation } from "./gettingStarted.ts";
import { loadBuiltInGitApi } from "./gitApi.ts";
import { GitSidebar, type GitSidebarNode } from "./gitSidebar.ts";
import { GraphView } from "./graphView.ts";
import { WorkspaceRepositories } from "./workspaceRepositories.ts";
import { Worktrees } from "./worktrees.ts";

const gettingStartedOpenedStorageKey = "gito.gettingStarted.v1.opened";

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
  const workingTreeChanges = new WorkingTreeChanges(workspaceRepositories);
  const commitView = new CommitView(
    workspaceRepositories,
    workingTreeChanges,
    conflictGuide,
    diagnostics,
  );
  const graphView = new GraphView(
    builtInGitApi,
    workspaceRepositories,
    worktrees,
    diagnostics,
  );
  const openGettingStartedWalkthrough = () =>
    vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      { category: `${extensionContext.extension.id}#gettingStarted` },
      false,
    );
  extensionContext.subscriptions.push(
    workspaceRepositories,
    worktrees,
    diagnostics,
    gitSidebar,
    commitView,
    currentLineBlame,
    graphView,
    vscode.window.registerTreeDataProvider("gito.git", gitSidebar),
    vscode.window.registerWebviewViewProvider("gito.commit", commitView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("gito.graph", graphView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("gito.showFileHistory", (fileUri?: vscode.Uri) =>
      graphView.showFileHistory(fileUri),
    ),
    vscode.commands.registerCommand("gito.showCurrentLineBlame", () =>
      currentLineBlame.showDetails(),
    ),
    vscode.commands.registerCommand("gito.toggleInlineBlame", () =>
      currentLineBlame.toggleInlineAnnotation(),
    ),
    vscode.commands.registerCommand("gito.openGettingStarted", openGettingStartedWalkthrough),
    vscode.commands.registerCommand("gito.refreshGit", () => gitSidebar.refresh()),
    vscode.commands.registerCommand("gito.createWorktree", (repositoryRootUri?: vscode.Uri) => {
      const repository =
        repositoryRootUri === undefined
          ? workspaceRepositories.selectedRepository
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
  try {
    await openGettingStartedOnFirstActivation(
      extensionContext.globalState.get(gettingStartedOpenedStorageKey, false),
      openGettingStartedWalkthrough,
      () => extensionContext.globalState.update(gettingStartedOpenedStorageKey, true),
    );
  } catch (gettingStartedOpeningFailure) {
    diagnostics.warn(
      "Native Getting Started walkthrough failed to open.",
      gettingStartedOpeningFailure,
    );
  }
}

function resolveWorktreePath(sidebarNodeOrPath: GitSidebarNode | string | undefined): string | undefined {
  if (typeof sidebarNodeOrPath === "string") {
    return sidebarNodeOrPath;
  }
  return sidebarNodeOrPath?.nodeType === "worktree"
    ? sidebarNodeOrPath.worktree.path
    : undefined;
}
