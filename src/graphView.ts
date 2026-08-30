import { randomBytes } from "node:crypto";
import { relative } from "node:path";

import * as vscode from "vscode";

import { CoalescedAsyncRunner } from "./coalescedAsyncRunner.ts";
import { GraphActions } from "./graphActions.ts";
import { isCommitGraphActionId } from "./graphActionModel.ts";
import {
  loadGraphComparisonPreview,
  loadGraphSyncPreview,
} from "./graphPreview.ts";
import type { GitApi, GitRepository, GitWorktree } from "./gitApi.ts";
import { loadCommitGraphPage } from "./graphHistory.ts";
import { searchCommitHistory } from "./graphSearch.ts";
import { countRepositoryChanges, type GitReference } from "./gitModel.ts";
import { buildCommitGraphRows } from "./graphModel.ts";
import { pathsIdentifySameLocation } from "./pathIdentity.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";
import type { Worktrees } from "./worktrees.ts";
import { formatWorktreeWipSummary } from "./worktreeStatus.ts";

interface GraphViewMessage {
  readonly actionId?: unknown;
  readonly commitHash?: string;
  readonly repositoryPath?: string;
  readonly searchText?: string;
  readonly type?: string;
}

interface GraphWorktreeState {
  readonly branchName: string;
  readonly current: boolean;
  readonly displayName: string;
  readonly summary: string;
  readonly tone: "clean" | "conflict" | "modified" | "unavailable";
}

const graphPageSize = 50;
const maximumGraphEntries = 500;
const graphTourCompletedStorageKey = "gito.graphTour.v1.completed";

export class GraphView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly changedSubscription: vscode.Disposable;
  private readonly graphActions: GraphActions;
  private readonly refreshRunner: CoalescedAsyncRunner;
  private readonly worktreeSubscription: vscode.Disposable;
  private worktreeRefreshInProgress = false;
  private actionInProgress = false;
  private readonly visibleCommitSubjectsByHash = new Map<string, string>();
  private graphEntryLimit = graphPageSize;
  private fileHistoryPath: string | undefined;
  private fileHistoryRepositoryPath: string | undefined;
  private lastGraphSourceKey: string | undefined;
  private lastRepositoryPath: string | undefined;
  private resolvedViewSubscriptions: vscode.Disposable | undefined;
  private searchText = "";
  private graphRequestVersion = 0;
  private refreshRequired = false;
  private scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
  private webviewReady = false;
  private webviewView: vscode.WebviewView | undefined;

  public constructor(
    private readonly gitApi: GitApi,
    private readonly workspaceRepositories: WorkspaceRepositories,
    private readonly worktrees: Worktrees,
    private readonly globalState: vscode.Memento,
    private readonly diagnostics: vscode.LogOutputChannel,
  ) {
    this.graphActions = new GraphActions(gitApi, diagnostics);
    this.refreshRunner = new CoalescedAsyncRunner((forceRefresh) =>
      this.refresh(forceRefresh),
    );
    this.changedSubscription = workspaceRepositories.onDidChange(() => this.scheduleRefresh());
    this.worktreeSubscription = worktrees.onDidChange(() => this.scheduleRefresh(0, true));
  }

  public async showFileHistory(fileUri?: vscode.Uri): Promise<void> {
    const targetFileUri = fileUri ?? vscode.window.activeTextEditor?.document.uri;
    if (targetFileUri?.scheme !== "file") {
      void vscode.window.showInformationMessage("Git'o: Open a repository file first.");
      return;
    }
    const targetRepository = this.workspaceRepositories.findRepositoryContaining(targetFileUri.fsPath);
    if (targetRepository === undefined) {
      void vscode.window.showInformationMessage("Git'o: This file is not inside an opened Git repository.");
      return;
    }
    this.workspaceRepositories.selectRepository(targetRepository.rootUri.fsPath);
    this.fileHistoryPath = relative(targetRepository.rootUri.fsPath, targetFileUri.fsPath);
    this.fileHistoryRepositoryPath = targetRepository.rootUri.fsPath;
    this.searchText = "";
    this.graphEntryLimit = graphPageSize;
    this.graphRequestVersion += 1;
    this.lastGraphSourceKey = undefined;
    await vscode.commands.executeCommand("gito.graph.focus");
    this.scheduleRefresh(0, true);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = { enableScripts: true };
    this.resolvedViewSubscriptions?.dispose();
    const messageSubscription = webviewView.webview.onDidReceiveMessage(
      (graphViewMessage: GraphViewMessage) => this.handleMessage(graphViewMessage),
    );
    const disposalSubscription = webviewView.onDidDispose(() => {
      if (this.webviewView !== webviewView) {
        return;
      }
      this.webviewReady = false;
      this.webviewView = undefined;
    });
    const visibilitySubscription = webviewView.onDidChangeVisibility(() => {
      if (this.webviewView === webviewView && webviewView.visible) {
        this.scheduleRefresh(0, true);
      }
    });
    this.resolvedViewSubscriptions = vscode.Disposable.from(
      messageSubscription,
      disposalSubscription,
      visibilitySubscription,
    );
    webviewView.webview.html = createGraphViewHtml();
  }

  public dispose(): void {
    this.changedSubscription.dispose();
    this.worktreeSubscription.dispose();
    this.resolvedViewSubscriptions?.dispose();
    this.resolvedViewSubscriptions = undefined;
    if (this.scheduledRefresh !== undefined) {
      clearTimeout(this.scheduledRefresh);
    }
    this.webviewReady = false;
    this.webviewView = undefined;
  }

  private async handleMessage(graphViewMessage: GraphViewMessage): Promise<void> {
    if (graphViewMessage.type === "ready") {
      this.diagnostics.debug("Graph webview ready.");
      this.webviewReady = true;
      this.lastGraphSourceKey = undefined;
      await this.refreshRunner.requestRefresh(true);
      return;
    }
    if (graphViewMessage.type === "completeGraphTour") {
      await this.globalState.update(graphTourCompletedStorageKey, true);
      return;
    }
    if (graphViewMessage.type === "loadMore") {
      this.graphEntryLimit = Math.min(
        this.graphEntryLimit + graphPageSize,
        maximumGraphEntries,
      );
      this.scheduleRefresh(0, true);
      return;
    }
    if (graphViewMessage.type === "refresh") {
      this.scheduleRefresh(0, true);
      return;
    }
    if (graphViewMessage.type === "search" && typeof graphViewMessage.searchText === "string") {
      this.searchText = graphViewMessage.searchText.trim();
      this.graphEntryLimit = graphPageSize;
      this.graphRequestVersion += 1;
      this.scheduleRefresh(0, true);
      return;
    }
    if (graphViewMessage.type === "clearFileHistory") {
      this.fileHistoryPath = undefined;
      this.fileHistoryRepositoryPath = undefined;
      this.graphEntryLimit = graphPageSize;
      this.graphRequestVersion += 1;
      this.scheduleRefresh(0, true);
      return;
    }
    if (graphViewMessage.type === "selectCommit") {
      await this.showCommitActions(graphViewMessage);
      return;
    }
    if (graphViewMessage.type === "commitAction") {
      await this.runCommitAction(graphViewMessage);
      return;
    }
    if (graphViewMessage.type === "previewSync") {
      await this.showSyncPreview(graphViewMessage);
      return;
    }
    if (graphViewMessage.type === "repositoryAction") {
      await this.runRepositoryAction(graphViewMessage);
      return;
    }
    if (
      graphViewMessage.type === "openCommit" &&
      typeof graphViewMessage.commitHash === "string" &&
      typeof graphViewMessage.repositoryPath === "string" &&
      /^[0-9a-f]{7,64}$/i.test(graphViewMessage.commitHash)
    ) {
      const targetRepository = this.workspaceRepositories.findRepository(
        graphViewMessage.repositoryPath,
      );
      if (targetRepository !== undefined) {
        try {
          await vscode.commands.executeCommand(
            "git.viewCommit",
            targetRepository.rootUri,
            graphViewMessage.commitHash,
          );
        } catch (commitViewFailure) {
          this.diagnostics.error("Opening the native commit diff failed.", commitViewFailure);
          void vscode.window.showErrorMessage(
            "Git'o could not open this commit. Check the Git output, then retry.",
          );
        }
      }
    }
  }

  private async showCommitActions(graphViewMessage: GraphViewMessage): Promise<void> {
    const targetRepository = this.resolveMessageRepository(graphViewMessage);
    const commitHash = graphViewMessage.commitHash;
    if (
      targetRepository === undefined ||
      typeof commitHash !== "string" ||
      !isCommitHash(commitHash)
    ) {
      return;
    }
    const commitSubject = this.visibleCommitSubjectsByHash.get(commitHash);
    if (commitSubject === undefined) {
      return;
    }
    void this.webviewView?.webview.postMessage({
      actions: this.graphActions.actionStates(targetRepository, commitHash),
      commitHash,
      commitSubject,
      type: "commitActions",
    });
  }

  private async runCommitAction(graphViewMessage: GraphViewMessage): Promise<void> {
    const targetRepository = this.resolveMessageRepository(graphViewMessage);
    const commitHash = graphViewMessage.commitHash;
    if (
      targetRepository === undefined ||
      typeof commitHash !== "string" ||
      !isCommitHash(commitHash) ||
      !this.visibleCommitSubjectsByHash.has(commitHash) ||
      !isCommitGraphActionId(graphViewMessage.actionId) ||
      this.actionInProgress
    ) {
      return;
    }
    this.actionInProgress = true;
    void this.webviewView?.webview.postMessage({ busy: true, type: "actionStatus" });
    try {
      if (graphViewMessage.actionId === "compareWithHead") {
        const currentCommitHash = targetRepository.state.HEAD?.commit;
        if (currentCommitHash === undefined) {
          throw new Error("The current branch has no commit to compare.");
        }
        const comparisonPreview = await loadGraphComparisonPreview(
          this.gitCommandContext(targetRepository),
          commitHash,
          currentCommitHash,
        );
        void this.webviewView?.webview.postMessage({
          comparisonPreview,
          type: "comparisonPreview",
        });
      } else {
        const completionMessage = await this.graphActions.run(
          graphViewMessage.actionId,
          targetRepository,
          commitHash,
        );
        if (completionMessage !== undefined) {
          void this.webviewView?.webview.postMessage({
            message: completionMessage,
            type: "actionResult",
          });
        }
      }
    } catch (graphActionFailure) {
      this.diagnostics.error("Graph action failed.", graphActionFailure);
      void this.webviewView?.webview.postMessage({
        message: graphActionErrorMessage(graphActionFailure),
        type: "actionError",
      });
    } finally {
      this.actionInProgress = false;
      void this.webviewView?.webview.postMessage({ busy: false, type: "actionStatus" });
      this.scheduleRefresh(0, true);
    }
  }

  private async showSyncPreview(graphViewMessage: GraphViewMessage): Promise<void> {
    const targetRepository = this.resolveMessageRepository(graphViewMessage);
    if (targetRepository === undefined || this.actionInProgress) {
      return;
    }
    const currentBranch = targetRepository.state.HEAD;
    if (currentBranch?.commit === undefined || currentBranch.upstream === undefined) {
      void this.webviewView?.webview.postMessage({
        message: "Current branch has no configured upstream.",
        type: "actionError",
      });
      return;
    }
    this.actionInProgress = true;
    void this.webviewView?.webview.postMessage({ busy: true, type: "actionStatus" });
    try {
      const upstreamName = formatUpstreamName(
        currentBranch.upstream.remote,
        currentBranch.upstream.name,
      );
      const syncPreview = await loadGraphSyncPreview(
        this.gitCommandContext(targetRepository),
        currentBranch.commit,
        upstreamName,
      );
      void this.webviewView?.webview.postMessage({
        syncPreview: {
          ...syncPreview,
          workingTreeClean: countRepositoryChanges(targetRepository.state) === 0,
        },
        type: "syncPreview",
      });
    } catch (syncPreviewFailure) {
      this.diagnostics.error("Sync preview failed.", syncPreviewFailure);
      void this.webviewView?.webview.postMessage({
        message: "Sync preview failed. Fetch remote updates, then retry.",
        type: "actionError",
      });
    } finally {
      this.actionInProgress = false;
      void this.webviewView?.webview.postMessage({ busy: false, type: "actionStatus" });
    }
  }

  private async runRepositoryAction(graphViewMessage: GraphViewMessage): Promise<void> {
    const targetRepository = this.resolveMessageRepository(graphViewMessage);
    if (
      targetRepository === undefined ||
      !isRepositoryGraphActionId(graphViewMessage.actionId) ||
      this.actionInProgress
    ) {
      return;
    }
    this.actionInProgress = true;
    void this.webviewView?.webview.postMessage({ busy: true, type: "actionStatus" });
    try {
      this.workspaceRepositories.selectRepository(targetRepository.rootUri.fsPath);
      await targetRepository.status();
      if (graphViewMessage.actionId !== "fetch") {
        const currentBranch = targetRepository.state.HEAD;
        if (currentBranch?.commit === undefined || currentBranch.upstream === undefined) {
          throw new Error("Current branch has no configured upstream.");
        }
        const currentSyncPreview = await loadGraphSyncPreview(
          this.gitCommandContext(targetRepository),
          currentBranch.commit,
          formatUpstreamName(currentBranch.upstream.remote, currentBranch.upstream.name),
        );
        if (graphViewMessage.actionId === "pull") {
          if (countRepositoryChanges(targetRepository.state) > 0) {
            throw new Error("Commit or stash working changes before pulling.");
          }
          if (currentSyncPreview.incomingCommitCount === 0) {
            throw new Error("There are no incoming commits to pull.");
          }
          if (currentSyncPreview.conflictRisk === "conflicts") {
            throw new Error("Pull is paused because the preview predicts conflicts.");
          }
        }
        if (
          graphViewMessage.actionId === "push" &&
          (currentSyncPreview.outgoingCommitCount === 0 ||
            currentSyncPreview.incomingCommitCount > 0)
        ) {
          throw new Error(
            currentSyncPreview.incomingCommitCount > 0
              ? "Pull incoming commits before pushing."
              : "There are no outgoing commits to push.",
          );
        }
      }
      await {
        fetch: () => targetRepository.fetch(),
        pull: () => targetRepository.pull(),
        push: () => targetRepository.push(),
      }[graphViewMessage.actionId]();
      await targetRepository.status();
      void this.webviewView?.webview.postMessage({
        message: `${capitalize(graphViewMessage.actionId)} completed.`,
        type: "actionResult",
      });
    } catch (repositoryActionFailure) {
      this.diagnostics.error("Repository graph action failed.", repositoryActionFailure);
      void this.webviewView?.webview.postMessage({
        message: graphActionErrorMessage(repositoryActionFailure),
        type: "actionError",
      });
    } finally {
      this.actionInProgress = false;
      void this.webviewView?.webview.postMessage({ busy: false, type: "actionStatus" });
      this.scheduleRefresh(0, true);
    }
  }

  private resolveMessageRepository(
    graphViewMessage: GraphViewMessage,
  ): GitRepository | undefined {
    return typeof graphViewMessage.repositoryPath === "string"
      ? this.workspaceRepositories.findRepository(graphViewMessage.repositoryPath)
      : undefined;
  }

  private gitCommandContext(repository: GitRepository) {
    return {
      environment: this.gitApi.git.env,
      executablePath: this.gitApi.git.path,
      repositoryPath: repository.rootUri.fsPath,
    };
  }

  private scheduleRefresh(delayMilliseconds = 120, forceRefresh = false): void {
    this.refreshRequired ||= forceRefresh;
    if (!this.webviewReady || this.webviewView?.visible !== true) {
      return;
    }
    if (this.scheduledRefresh !== undefined) {
      if (delayMilliseconds > 0) {
        return;
      }
      clearTimeout(this.scheduledRefresh);
    }
    this.scheduledRefresh = setTimeout(() => {
      this.scheduledRefresh = undefined;
      const scheduledRefreshRequired = this.refreshRequired;
      this.refreshRequired = false;
      void this.refreshRunner.requestRefresh(scheduledRefreshRequired);
    }, delayMilliseconds);
  }

  private async refresh(forceRefresh: boolean): Promise<void> {
    const selectedRepository = this.workspaceRepositories.selectedRepository;
    if (selectedRepository === undefined) {
      this.graphEntryLimit = graphPageSize;
      this.lastGraphSourceKey = undefined;
      this.lastRepositoryPath = undefined;
      this.visibleCommitSubjectsByHash.clear();
      void this.webviewView?.webview.postMessage({ rows: [], type: "state" });
      return;
    }
    if (selectedRepository.rootUri.fsPath !== this.lastRepositoryPath) {
      this.lastRepositoryPath = selectedRepository.rootUri.fsPath;
      this.graphEntryLimit = graphPageSize;
      forceRefresh = true;
      if (this.fileHistoryRepositoryPath !== selectedRepository.rootUri.fsPath) {
        this.fileHistoryPath = undefined;
        this.fileHistoryRepositoryPath = undefined;
      }
      this.searchText = "";
      this.graphRequestVersion += 1;
    }
    const refreshRequestVersion = this.graphRequestVersion;
    if (selectedRepository.state.HEAD?.commit === undefined) {
      this.lastGraphSourceKey = undefined;
      this.visibleCommitSubjectsByHash.clear();
      void this.webviewView?.webview.postMessage({
        graphTourCompleted: this.globalState.get(graphTourCompletedStorageKey, false),
        hasMore: false,
        repositoryPath: selectedRepository.rootUri.fsPath,
        rows: [],
        type: "state",
      });
      return;
    }

    try {
      const [branchReferences, tagReferences] = await Promise.all([
        selectedRepository.getRefs({
          pattern: ["refs/heads", "refs/remotes"],
          sort: "committerdate",
        }),
        selectedRepository.getRefs({ pattern: "refs/tags", sort: "creatordate" }),
      ]);
      const graphWorktrees = this.createGraphWorktreeStates(selectedRepository.state.worktrees, selectedRepository);
      const allGraphReferences = [...branchReferences, ...tagReferences];
      const graphSourceKey = createGraphSourceKey(
        selectedRepository,
        this.graphEntryLimit,
        allGraphReferences,
        this.fileHistoryPath,
        this.searchText,
      );
      if (!forceRefresh && graphSourceKey === this.lastGraphSourceKey) {
        return;
      }
      void this.webviewView?.webview.postMessage({ type: "loading" });
      this.diagnostics.debug(
        `Loading Git history from HEAD for ${selectedRepository.rootUri.fsPath}.`,
      );
      const commitGraphPage = this.searchText === "" && this.fileHistoryPath === undefined
        ? await loadCommitGraphPage(
            selectedRepository,
            allGraphReferences,
            this.graphEntryLimit,
            this.fileHistoryPath,
          )
        : await searchCommitHistory(
            {
              environment: this.gitApi.git.env,
              executablePath: this.gitApi.git.path,
              repositoryPath: selectedRepository.rootUri.fsPath,
            },
            allGraphReferences,
            this.searchText,
            this.fileHistoryPath,
            this.graphEntryLimit,
          ).then((searchPage) => ({
            hasMore: searchPage.hasMore,
            rows: buildCommitGraphRows(
              searchPage.commits,
              allGraphReferences,
              searchPage.changeStatsByCommitHash,
            ),
          }));
      if (
        this.workspaceRepositories.selectedRepository?.rootUri.fsPath !==
          selectedRepository.rootUri.fsPath ||
        this.graphRequestVersion !== refreshRequestVersion
      ) {
        return;
      }
      const targetWebviewView = this.webviewView;
      if (targetWebviewView === undefined) {
        return;
      }
      this.visibleCommitSubjectsByHash.clear();
      for (const commitGraphRow of commitGraphPage.rows) {
        this.visibleCommitSubjectsByHash.set(commitGraphRow.hash, commitGraphRow.subject);
      }
      const currentBranch = selectedRepository.state.HEAD;
      const graphStateDelivered = await targetWebviewView.webview.postMessage({
        currentBranchName: currentBranch?.name,
        graphTourCompleted: this.globalState.get(graphTourCompletedStorageKey, false),
        hasMore: commitGraphPage.hasMore && this.graphEntryLimit < maximumGraphEntries,
        headCommitHash: currentBranch?.commit,
        repositoryPath: selectedRepository.rootUri.fsPath,
        fileHistoryPath: this.fileHistoryPath,
        searchText: this.searchText,
        upstreamName:
          currentBranch?.upstream === undefined
            ? undefined
            : formatUpstreamName(currentBranch.upstream.remote, currentBranch.upstream.name),
        worktrees: graphWorktrees,
        rows: commitGraphPage.rows,
        type: "state",
      });
      if (graphStateDelivered && this.webviewView === targetWebviewView) {
        this.lastGraphSourceKey = graphSourceKey;
        void this.refreshGraphWorktreeStates(selectedRepository, refreshRequestVersion);
      }
    } catch (graphFailure) {
      this.diagnostics.error("Graph refresh failed.", graphFailure);
      if (
        this.workspaceRepositories.selectedRepository?.rootUri.fsPath ===
          selectedRepository.rootUri.fsPath &&
        this.graphRequestVersion === refreshRequestVersion
      ) {
        void this.webviewView?.webview.postMessage({
          message:
            graphFailure instanceof Error &&
            graphFailure.message === "File history paths must stay inside the selected repository."
              ? graphFailure.message
              : "Git history could not be loaded.",
          type: "error",
        });
      }
    }
  }

  private createGraphWorktreeStates(
    repositoryWorktrees: readonly GitWorktree[],
    repository: GitRepository,
  ): readonly GraphWorktreeState[] {
    return repositoryWorktrees.map((repositoryWorktree) => {
      const worktreeWipSummary = this.worktrees.getWipSummary(repositoryWorktree.path);
      const worktreeSummary =
        worktreeWipSummary === undefined
          ? "Status unavailable"
          : formatWorktreeWipSummary(worktreeWipSummary);
      return {
        branchName: worktreeWipSummary?.branchName ?? repositoryWorktree.ref,
        current: pathsIdentifySameLocation(repositoryWorktree.path, repository.rootUri.fsPath),
        displayName: this.worktrees.getDisplayName(repositoryWorktree),
        summary: worktreeSummary,
        tone:
          worktreeWipSummary === undefined
            ? "unavailable"
            : worktreeWipSummary.conflictCount > 0
              ? "conflict"
              : worktreeSummary === "Clean"
                ? "clean"
                : "modified",
      };
    });
  }

  private async refreshGraphWorktreeStates(
    repository: GitRepository,
    refreshRequestVersion: number,
  ): Promise<void> {
    if (this.worktreeRefreshInProgress) {
      return;
    }
    this.worktreeRefreshInProgress = true;
    try {
      const refreshedWorktrees = await this.worktrees.refreshRepositoryWorktrees(repository);
      if (
        this.workspaceRepositories.selectedRepository?.rootUri.fsPath !==
          repository.rootUri.fsPath ||
        this.graphRequestVersion !== refreshRequestVersion
      ) {
        return;
      }
      void this.webviewView?.webview.postMessage({
        type: "worktrees",
        worktrees: this.createGraphWorktreeStates(refreshedWorktrees, repository),
      });
    } finally {
      this.worktreeRefreshInProgress = false;
    }
  }
}

function createGraphSourceKey(
  repository: GitRepository,
  graphEntryLimit: number,
  graphReferences: readonly GitReference[],
  fileHistoryPath: string | undefined,
  searchText: string,
): string {
  const referenceFingerprint = graphReferences
    .map((gitReference) => `${gitReference.type}:${gitReference.name ?? ""}:${gitReference.commit ?? ""}`)
    .sort()
    .join("|");
  return `${repository.rootUri.fsPath}:${repository.state.HEAD?.commit ?? ""}:${graphEntryLimit}:${fileHistoryPath ?? ""}:${searchText}:${referenceFingerprint}`;
}

function isCommitHash(candidateCommitHash: string): boolean {
  return /^[0-9a-f]{7,64}$/iu.test(candidateCommitHash);
}

function isRepositoryGraphActionId(
  candidateActionId: unknown,
): candidateActionId is "fetch" | "pull" | "push" {
  return candidateActionId === "fetch" || candidateActionId === "pull" || candidateActionId === "push";
}

function formatUpstreamName(remoteName: string, branchName: string): string {
  return branchName.startsWith(`${remoteName}/`) ? branchName : `${remoteName}/${branchName}`;
}

function capitalize(actionName: string): string {
  return `${actionName[0]?.toUpperCase() ?? ""}${actionName.slice(1)}`;
}

function graphActionErrorMessage(graphActionFailure: unknown): string {
  const firstFailureLine =
    graphActionFailure instanceof Error
      ? graphActionFailure.message.split("\n", 1)[0]?.trim()
      : undefined;
  return firstFailureLine === undefined || firstFailureLine === ""
    ? "Action failed. Check Git Output for details."
    : firstFailureLine;
}

function createGraphViewHtml(): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: transparent; font: var(--vscode-font-size) var(--vscode-font-family); }
    .header { position: sticky; top: 0; z-index: 2; padding: 5px 9px 7px 12px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); box-shadow: inset 0 -1px var(--vscode-sideBarSectionHeader-border, transparent); }
    .toolbar { display: flex; align-items: center; gap: 6px; min-height: 28px; }
    .commit-count { color: var(--vscode-descriptionForeground); }
    .icon-button { display: grid; width: 26px; height: 26px; margin-left: auto; padding: 0; place-items: center; border: 0; border-radius: 5px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; transition: background-color 140ms cubic-bezier(.2, .8, .2, 1), transform 140ms cubic-bezier(.2, .8, .2, 1); }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-button:active { transform: rotate(18deg); }
    .icon-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .tour-trigger { margin-left: auto; }
    .sync-button { min-height: 24px; margin-left: auto; padding: 2px 8px; border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 72%, transparent); border-radius: 5px; color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, var(--vscode-sideBar-background)); font: inherit; cursor: pointer; transition: background-color 140ms cubic-bezier(.2, .8, .2, 1), border-color 140ms cubic-bezier(.2, .8, .2, 1); }
    .sync-button:hover { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, var(--vscode-sideBar-background)); }
    .sync-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .sync-button + .tour-trigger, .tour-trigger + .icon-button { margin-left: 0; }
    .icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
    .search { width: 100%; height: 28px; margin-top: 3px; padding: 0 9px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
    .search:focus { border-color: var(--vscode-focusBorder); outline: none; box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); }
    .search::placeholder { color: var(--vscode-input-placeholderForeground); }
    .scope { display: flex; align-items: center; gap: 6px; min-height: 24px; margin-top: 5px; padding: 2px 5px 2px 8px; border-radius: 5px; color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent); }
    .scope span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scope button { flex: 0 0 auto; width: 20px; height: 20px; margin-left: auto; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }
    .scope button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .worktrees { display: flex; gap: 5px; margin-top: 6px; overflow-x: auto; scrollbar-width: thin; }
    .worktree { flex: 0 0 auto; max-width: 220px; padding: 4px 7px; border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--vscode-sideBar-background) 80%, var(--vscode-editor-background)); }
    .worktree.current { border-color: var(--vscode-focusBorder); }
    .worktree-name, .worktree-state { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .worktree-name { font-size: 11px; font-weight: 600; }
    .worktree-state { margin-top: 1px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .worktree.conflict .worktree-state { color: var(--vscode-errorForeground); }
    .worktree.modified .worktree-state { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow)); }
    .worktree.clean .worktree-state { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)); }
    .tour { margin: 7px 8px; padding: 10px; border: 1px solid var(--vscode-focusBorder); border-radius: 7px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); box-shadow: 0 5px 18px color-mix(in srgb, #000 22%, transparent); }
    .tour-progress { color: var(--vscode-textLink-foreground); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .tour-title { margin-top: 3px; font-weight: 700; }
    .tour-description { margin-top: 3px; color: var(--vscode-descriptionForeground); line-height: 1.35; }
    .tour-actions { display: flex; gap: 5px; justify-content: flex-end; margin-top: 9px; }
    .tour-actions button { min-height: 26px; padding: 2px 8px; border: 0; border-radius: 5px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; cursor: pointer; }
    .tour-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .tour-actions .tour-next { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .tour-actions .tour-next:hover { background: var(--vscode-button-hoverBackground); }
    .tour-anchor { position: relative; z-index: 3; outline: 2px solid var(--vscode-focusBorder) !important; outline-offset: 2px; }
    .panel { margin: 7px 8px; padding: 9px; border: 1px solid var(--vscode-widget-border, var(--vscode-sideBarSectionHeader-border)); border-radius: 7px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); box-shadow: 0 4px 14px color-mix(in srgb, #000 18%, transparent); }
    .panel-header { display: flex; align-items: flex-start; gap: 8px; }
    .panel-title { min-width: 0; font-weight: 700; }
    .panel-subtitle { margin-top: 2px; color: var(--vscode-descriptionForeground); font: 11px var(--vscode-editor-font-family); }
    .close-button { flex: 0 0 auto; width: 22px; height: 22px; margin-left: auto; border: 0; border-radius: 4px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
    .close-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .action-section { margin-top: 9px; }
    .action-heading { margin-bottom: 4px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    details.action-section > summary { cursor: pointer; user-select: none; }
    .action-grid { display: grid; gap: 4px; }
    .action { padding: 6px 7px; border: 0; border-radius: 5px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); text-align: left; font: inherit; cursor: pointer; }
    .action:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .action:disabled { cursor: not-allowed; opacity: .55; }
    .action-label { display: block; font-weight: 600; }
    .action-description { display: block; margin-top: 1px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .preview-summary { display: flex; flex-wrap: wrap; gap: 5px; margin: 9px 0 7px; }
    .metric { padding: 2px 6px; border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; }
    .risk { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
    .path-list { max-height: 180px; margin: 0; padding: 0; overflow: auto; list-style: none; }
    .path-row { display: flex; gap: 7px; padding: 3px 2px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent); font-size: 11px; }
    .path-status { flex: 0 0 20px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
    .path-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .repository-actions { display: flex; gap: 5px; margin-top: 8px; }
    .repository-actions .action { flex: 1; text-align: center; }
    .notice { margin: 7px 8px; padding: 6px 8px; border-radius: 5px; color: var(--vscode-notificationsInfoIcon-foreground, var(--vscode-foreground)); background: color-mix(in srgb, var(--vscode-notificationsInfoIcon-foreground, var(--vscode-foreground)) 10%, transparent); }
    .notice.error { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-height: 42px; margin: 1px 4px; padding: 0 4px 0 3px; border-radius: 5px; outline: none; transition: background-color 120ms cubic-bezier(.2, .8, .2, 1), box-shadow 120ms cubic-bezier(.2, .8, .2, 1); }
    .row.entering { animation: row-enter 320ms cubic-bezier(.2, .8, .2, 1) both; animation-delay: calc(var(--row-index) * 22ms); }
    .row.entering .graph path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: graph-path-enter 440ms cubic-bezier(.2, .8, .2, 1) forwards; animation-delay: calc(70ms + var(--row-index) * 22ms); }
    .row.entering .graph circle { transform-box: fill-box; transform-origin: center; animation: graph-node-enter 260ms cubic-bezier(.2, .8, .2, 1) both; animation-delay: calc(120ms + var(--row-index) * 22ms); }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row:focus-within { background: var(--vscode-list-focusBackground); color: var(--vscode-list-focusForeground); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    .row-main { display: grid; grid-template-columns: auto minmax(0, 1fr); min-width: 0; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer; outline: none; }
    .graph { align-self: stretch; }
    .content { align-self: center; min-width: 0; padding: 4px 0; }
    .row-actions { align-self: center; width: 26px; height: 26px; border: 0; border-radius: 5px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; opacity: 0; }
    .row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
    .row-actions.tour-anchor { opacity: 1; }
    .row-actions:hover { background: var(--vscode-toolbar-hoverBackground); }
    .headline, .metadata { display: flex; min-width: 0; align-items: center; gap: 6px; }
    .subject { overflow: hidden; font-weight: 600; letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
    .metadata { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .hash { font-family: var(--vscode-editor-font-family); }
    .additions { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)); }
    .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red)); }
    .references { display: inline-flex; min-width: 0; gap: 3px; }
    .reference { max-width: 140px; overflow: hidden; padding: 1px 6px; border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent); }
    .reference.branch { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); }
    .reference.tag { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent); }
    .reference.remote { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent); }
    .state, .more { padding: 14px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    .more { width: calc(100% - 24px); min-height: 34px; margin: 9px 12px 14px; padding: 0 12px; border: 0; border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font: inherit; font-weight: 600; transition: background-color 140ms cubic-bezier(.2, .8, .2, 1), transform 140ms cubic-bezier(.2, .8, .2, 1); }
    .more:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .more:active { transform: translateY(1px); }
    .more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    @keyframes row-enter { from { opacity: 0; transform: translateY(4px); } }
    @keyframes graph-path-enter { to { stroke-dashoffset: 0; } }
    @keyframes graph-node-enter { from { opacity: 0; transform: scale(.55); } }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-delay: 0ms !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <header id="graph-header" class="header"><div class="toolbar"><span id="count" class="commit-count"></span><button id="sync" class="sync-button" type="button" hidden>Preview Sync</button><button id="tour-trigger" class="icon-button tour-trigger" type="button" title="Show Graph tour" aria-label="Show Graph tour" aria-expanded="false"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M6.75 6.2A1.45 1.45 0 0 1 8.2 4.9c.9 0 1.55.55 1.55 1.35 0 1.5-1.75 1.45-1.75 2.9"/><path d="M8 11.4h.01"/></svg></button><button id="refresh" class="icon-button" type="button" title="Refresh history" aria-label="Refresh history"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5.5V2.75l-1.15 1.16A5.25 5.25 0 1 0 13.1 9"/><path d="M13 2.75h-2.75"/></svg></button></div><input id="search" class="search" type="search" placeholder="Search commits — author: ref: file:" aria-label="Search commit history" title="Search all commits. Filters: author:, message:, ref:, and file:"><div id="scope" class="scope" hidden><span id="scope-path"></span><button id="clear-scope" type="button" title="Show repository history" aria-label="Clear file history">×</button></div><div id="worktrees" class="worktrees" hidden></div></header>
  <section id="tour" class="tour" role="dialog" aria-live="polite" aria-labelledby="tour-title" aria-describedby="tour-description" hidden><div id="tour-progress" class="tour-progress"></div><div id="tour-title" class="tour-title"></div><div id="tour-description" class="tour-description"></div><div class="tour-actions"><button id="tour-skip" type="button">Skip tour</button><button id="tour-back" type="button">Back</button><button id="tour-next" class="tour-next" type="button">Next</button></div></section>
  <section id="panel" class="panel" aria-live="polite" hidden></section>
  <div id="notice" class="notice" role="status" hidden></div>
  <main id="rows"><div class="state">Loading history…</div></main>
  <button id="more" class="more" type="button" hidden>Load 50 more</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const laneColors = ['var(--vscode-charts-green)', 'var(--vscode-charts-purple)', 'var(--vscode-charts-blue)', 'var(--vscode-charts-orange)'];
    const graphRowsContainer = document.getElementById('rows');
    const commitCountLabel = document.getElementById('count');
    const loadMoreButton = document.getElementById('more');
    const searchInput = document.getElementById('search');
    const fileScope = document.getElementById('scope');
    const fileScopePath = document.getElementById('scope-path');
    const actionPanel = document.getElementById('panel');
    const notice = document.getElementById('notice');
    const syncButton = document.getElementById('sync');
    const worktreeStrip = document.getElementById('worktrees');
    const graphHeader = document.getElementById('graph-header');
    const graphTour = document.getElementById('tour');
    const graphTourTrigger = document.getElementById('tour-trigger');
    const graphTourProgress = document.getElementById('tour-progress');
    const graphTourTitle = document.getElementById('tour-title');
    const graphTourDescription = document.getElementById('tour-description');
    const graphTourBack = document.getElementById('tour-back');
    const graphTourNext = document.getElementById('tour-next');
    let searchTimer;
    let currentRepositoryPath;
    let actionBusy = false;
    let graphTourStepIndex = 0;
    let graphTourAnchor;
    let graphTourCompleted = false;
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    syncButton.addEventListener('click', () => vscode.postMessage({ type: 'previewSync', repositoryPath: currentRepositoryPath }));
    graphTourTrigger.addEventListener('click', () => startGraphTour(true));
    document.getElementById('tour-skip').addEventListener('click', completeGraphTour);
    graphTourBack.addEventListener('click', () => showGraphTourStep(graphTourStepIndex - 1));
    graphTourNext.addEventListener('click', () => {
      const tourSteps = availableGraphTourSteps();
      if (graphTourStepIndex >= tourSteps.length - 1) completeGraphTour();
      else showGraphTourStep(graphTourStepIndex + 1);
    });
    loadMoreButton.addEventListener('click', () => vscode.postMessage({ type: 'loadMore' }));
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', searchText: searchInput.value }), 180);
    });
    document.getElementById('clear-scope').addEventListener('click', () => vscode.postMessage({ type: 'clearFileHistory' }));

    window.addEventListener('message', messageEvent => {
      const graphViewMessage = messageEvent.data;
      if (graphViewMessage.type === 'commitActions') {
        renderCommitActions(graphViewMessage);
        return;
      }
      if (graphViewMessage.type === 'comparisonPreview') {
        renderComparisonPreview(graphViewMessage.comparisonPreview);
        return;
      }
      if (graphViewMessage.type === 'syncPreview') {
        renderSyncPreview(graphViewMessage.syncPreview);
        return;
      }
      if (graphViewMessage.type === 'actionStatus') {
        actionBusy = Boolean(graphViewMessage.busy);
        actionPanel.querySelectorAll('button[data-action]').forEach(button => { button.disabled = actionBusy || button.dataset.disabled === 'true'; });
        return;
      }
      if (graphViewMessage.type === 'actionResult' || graphViewMessage.type === 'actionError') {
        notice.textContent = graphViewMessage.message;
        notice.className = graphViewMessage.type === 'actionError' ? 'notice error' : 'notice';
        notice.hidden = false;
        window.clearTimeout(notice.dismissTimer);
        notice.dismissTimer = window.setTimeout(() => { notice.hidden = true; }, 6000);
        return;
      }
      if (graphViewMessage.type === 'worktrees') {
        renderWorktrees(graphViewMessage.worktrees || []);
        return;
      }
      if (graphViewMessage.type === 'loading' && graphRowsContainer.children.length === 0) {
        graphRowsContainer.replaceChildren(createStatusMessage('Loading history…'));
        return;
      }
      if (graphViewMessage.type === 'error') {
        graphRowsContainer.replaceChildren(createStatusMessage(graphViewMessage.message));
        loadMoreButton.hidden = true;
        return;
      }
      if (graphViewMessage.type !== 'state') return;
      const shouldAnimateGraph = currentRepositoryPath !== graphViewMessage.repositoryPath;
      currentRepositoryPath = graphViewMessage.repositoryPath;
      graphTourCompleted = Boolean(graphViewMessage.graphTourCompleted) || graphTourCompleted;
      if (searchInput.value !== (graphViewMessage.searchText || '')) searchInput.value = graphViewMessage.searchText || '';
      fileScope.hidden = !graphViewMessage.fileHistoryPath;
      fileScopePath.textContent = graphViewMessage.fileHistoryPath ? 'File · ' + graphViewMessage.fileHistoryPath : '';
      commitCountLabel.textContent = graphViewMessage.rows.length ? graphViewMessage.rows.length + ' commits' : '';
      syncButton.hidden = !graphViewMessage.upstreamName;
      syncButton.textContent = graphViewMessage.upstreamName ? 'Sync · ' + graphViewMessage.upstreamName : 'Preview Sync';
      syncButton.title = graphViewMessage.upstreamName ? 'Preview incoming and outgoing commits before Pull or Push' : 'Preview repository sync';
      renderWorktrees(graphViewMessage.worktrees || []);
      graphRowsContainer.replaceChildren(...(graphViewMessage.rows.length
        ? graphViewMessage.rows.map((commitRow, commitRowIndex) => createCommitRow(
            commitRow,
            shouldAnimateGraph && commitRowIndex < 12,
            commitRowIndex,
          ))
        : [createStatusMessage('No commits yet')]));
      loadMoreButton.hidden = !graphViewMessage.hasMore;
      if (!graphTour.hidden) showGraphTourStep(graphTourStepIndex);
      else if (!graphTourCompleted && graphViewMessage.rows.length) startGraphTour(false);
    });
    vscode.postMessage({ type: 'ready' });

    function createStatusMessage(messageText) {
      const statusMessage = document.createElement('div');
      statusMessage.className = 'state';
      statusMessage.textContent = messageText;
      return statusMessage;
    }

    function createCommitRow(commitRow, shouldAnimateGraphEntrance, commitRowIndex) {
      const commitRowElement = document.createElement('div');
      commitRowElement.className = shouldAnimateGraphEntrance ? 'row entering' : 'row';
      commitRowElement.style.setProperty('--row-index', String(Math.min(commitRowIndex, 8)));
      commitRowElement.title = commitRow.hash + '\\n' + commitRow.authorName + '\\n' + exactDate(commitRow.committedAt);
      const commitOpenButton = document.createElement('button');
      commitOpenButton.className = 'row-main';
      commitOpenButton.type = 'button';
      commitOpenButton.setAttribute('aria-label', commitRow.subject + ', ' + commitRow.authorName + ', ' + exactDate(commitRow.committedAt));
      commitOpenButton.title = 'Open changed files from this commit';
      commitOpenButton.append(createGraph(commitRow), createCommitDetails(commitRow));
      commitOpenButton.addEventListener('click', () => openCommit(commitRow.hash));
      const commitActionsButton = document.createElement('button');
      commitActionsButton.className = 'row-actions';
      commitActionsButton.type = 'button';
      commitActionsButton.textContent = '•••';
      commitActionsButton.title = 'Compare, create, apply, revert, or safely rewrite from this commit';
      commitActionsButton.setAttribute('aria-label', 'Actions for ' + commitRow.subject);
      commitActionsButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'selectCommit', commitHash: commitRow.hash, repositoryPath: currentRepositoryPath });
      });
      commitRowElement.append(commitOpenButton, commitActionsButton);
      commitOpenButton.addEventListener('keydown', keyboardEvent => {
        if (keyboardEvent.key === 'ArrowDown' || keyboardEvent.key === 'ArrowUp') {
          keyboardEvent.preventDefault();
          const commitOpenButtons = [...graphRowsContainer.querySelectorAll('.row-main')];
          const currentRowIndex = commitOpenButtons.indexOf(commitOpenButton);
          const nextRowIndex = keyboardEvent.key === 'ArrowDown'
            ? Math.min(commitOpenButtons.length - 1, currentRowIndex + 1)
            : Math.max(0, currentRowIndex - 1);
          commitOpenButtons[nextRowIndex]?.focus();
        }
      });
      return commitRowElement;
    }

    function availableGraphTourSteps() {
      const firstCommitOpenButton = graphRowsContainer.querySelector('.row-main');
      const firstCommitActionsButton = graphRowsContainer.querySelector('.row-actions');
      const syncTourStep = syncButton.hidden
        ? { anchor: graphHeader, title: 'Connect an upstream to preview sync', description: 'Set an upstream branch first. The Graph will then preview incoming commits, outgoing commits, changed paths, and predicted conflicts.' }
        : { anchor: syncButton, title: 'Preview before sync', description: 'See incoming and outgoing commits, changed paths, and predicted conflicts before Pull or Push.' };
      const worktreeTourStep = worktreeStrip.hidden
        ? { anchor: graphHeader, title: 'Follow files and worktrees', description: 'Right-click a file for visual history. Create a linked worktree to see its branch and WIP state above the graph.' }
        : { anchor: worktreeStrip, title: 'Follow files and worktrees', description: 'Right-click a file for visual history. Linked worktrees appear here with branch and WIP state.' };
      return [
        { anchor: firstCommitOpenButton || graphRowsContainer, title: 'Open commit changes', description: 'Click a commit to inspect its changed files and diff in one reusable tab.' },
        { anchor: firstCommitActionsButton || graphRowsContainer, title: 'Act on any commit', description: 'Hover a commit, then choose ••• to compare, branch, tag, apply, revert, or safely rewrite.' },
        { anchor: searchInput, title: 'Search complete history', description: 'Search text or narrow results with author:, message:, ref:, and file: filters.' },
        syncTourStep,
        worktreeTourStep
      ];
    }

    function startGraphTour(restartCompletedTour) {
      if ((!restartCompletedTour && graphTourCompleted) || !graphRowsContainer.querySelector('.row-main')) return;
      graphTour.hidden = false;
      graphTourTrigger.setAttribute('aria-expanded', 'true');
      showGraphTourStep(0);
      graphTourNext.focus();
    }

    function showGraphTourStep(requestedStepIndex) {
      const tourSteps = availableGraphTourSteps();
      graphTourStepIndex = Math.min(tourSteps.length - 1, Math.max(0, requestedStepIndex));
      graphTourAnchor?.classList.remove('tour-anchor');
      const tourStep = tourSteps[graphTourStepIndex];
      graphTourAnchor = tourStep.anchor;
      graphTourAnchor.classList.add('tour-anchor');
      graphTourAnchor.scrollIntoView?.({ block: 'nearest' });
      graphTourProgress.textContent = 'Graph tour · ' + (graphTourStepIndex + 1) + '/' + tourSteps.length;
      graphTourTitle.textContent = tourStep.title;
      graphTourDescription.textContent = tourStep.description;
      graphTourBack.disabled = graphTourStepIndex === 0;
      graphTourNext.textContent = graphTourStepIndex === tourSteps.length - 1 ? 'Done' : 'Next';
    }

    function completeGraphTour() {
      graphTourAnchor?.classList.remove('tour-anchor');
      graphTourAnchor = undefined;
      graphTour.hidden = true;
      graphTourCompleted = true;
      graphTourTrigger.setAttribute('aria-expanded', 'false');
      vscode.postMessage({ type: 'completeGraphTour' });
      graphTourTrigger.focus();
    }

    function renderWorktrees(worktrees) {
      worktreeStrip.replaceChildren(...worktrees.map(worktree => {
        const worktreeCard = document.createElement('div');
        worktreeCard.className = 'worktree ' + worktree.tone + (worktree.current ? ' current' : '');
        worktreeCard.title = worktree.branchName + ' · ' + worktree.summary;
        const worktreeName = document.createElement('div');
        worktreeName.className = 'worktree-name';
        worktreeName.textContent = (worktree.current ? '● ' : '') + worktree.displayName;
        const worktreeState = document.createElement('div');
        worktreeState.className = 'worktree-state';
        worktreeState.textContent = worktree.branchName + ' · ' + worktree.summary;
        worktreeCard.append(worktreeName, worktreeState);
        return worktreeCard;
      }));
      worktreeStrip.hidden = worktrees.length < 2;
    }

    function renderCommitActions(actionMessage) {
      const panelHeader = createPanelHeader(actionMessage.commitSubject, actionMessage.commitHash.slice(0, 8));
      const actionsBySection = new Map();
      actionMessage.actions.forEach(action => {
        const sectionActions = actionsBySection.get(action.section) || [];
        sectionActions.push(action);
        actionsBySection.set(action.section, sectionActions);
      });
      const sections = ['Inspect', 'Create', 'Rewrite'].map(sectionName => {
        const actionSection = document.createElement('details');
        actionSection.className = 'action-section';
        actionSection.open = sectionName === 'Inspect';
        const heading = document.createElement('summary');
        heading.className = 'action-heading';
        heading.textContent = sectionName;
        const actionGrid = document.createElement('div');
        actionGrid.className = 'action-grid';
        (actionsBySection.get(sectionName) || []).forEach(action => {
          const actionButton = createActionButton(action.label, action.description, action.disabledReason);
          actionButton.dataset.action = action.id;
          actionButton.dataset.disabled = String(Boolean(action.disabledReason));
          actionButton.disabled = actionBusy || Boolean(action.disabledReason);
          actionButton.addEventListener('click', () => vscode.postMessage({
            type: 'commitAction', actionId: action.id, commitHash: actionMessage.commitHash, repositoryPath: currentRepositoryPath
          }));
          actionGrid.append(actionButton);
        });
        actionSection.append(heading, actionGrid);
        return actionSection;
      });
      actionPanel.replaceChildren(panelHeader, ...sections);
      actionPanel.hidden = false;
      actionPanel.querySelector('button:not(:disabled)')?.focus();
    }

    function renderComparisonPreview(preview) {
      const header = createPanelHeader('Comparison preview', preview.selectedCommitHash.slice(0, 8) + ' ↔ current branch');
      const summary = createMetrics([
        preview.commitsOnlyInSelectedCommit + ' only there',
        preview.commitsOnlyInCurrentBranch + ' only here',
        preview.changedPaths.length + ' files',
        '+' + preview.additions,
        '−' + preview.deletions
      ]);
      actionPanel.replaceChildren(header, summary, createPathList(preview.changedPaths));
      actionPanel.hidden = false;
    }

    function renderSyncPreview(preview) {
      const header = createPanelHeader('Sync preview', preview.upstreamName);
      const riskText = preview.conflictRisk === 'conflicts' ? 'Potential conflicts' : preview.conflictRisk === 'none' ? 'No predicted conflicts' : 'Conflict check unavailable';
      const summary = createMetrics([
        preview.incomingCommitCount + ' incoming commits',
        preview.outgoingCommitCount + ' outgoing commits',
        riskText
      ], preview.conflictRisk === 'conflicts' ? 2 : -1);
      const repositoryActions = document.createElement('div');
      repositoryActions.className = 'repository-actions';
      ['fetch', 'pull', 'push'].forEach(repositoryAction => {
        const unavailableReason = repositoryAction === 'pull'
          ? !preview.workingTreeClean
            ? 'Commit or stash working changes first'
            : preview.conflictRisk === 'conflicts'
              ? 'Paused because conflicts are predicted'
              : preview.incomingCommitCount === 0
                ? 'No incoming commits'
                : undefined
          : repositoryAction === 'push'
            ? preview.incomingCommitCount > 0
              ? 'Pull incoming commits first'
              : preview.outgoingCommitCount === 0
                ? 'No outgoing commits'
                : undefined
            : undefined;
        const actionButton = createActionButton(
          repositoryAction[0].toUpperCase() + repositoryAction.slice(1),
          unavailableReason || '',
          undefined
        );
        actionButton.dataset.action = repositoryAction;
        const actionUnavailable = Boolean(unavailableReason);
        actionButton.dataset.disabled = String(actionUnavailable);
        actionButton.disabled = actionUnavailable;
        if (unavailableReason) actionButton.title = unavailableReason;
        actionButton.addEventListener('click', () => vscode.postMessage({ type: 'repositoryAction', actionId: repositoryAction, repositoryPath: currentRepositoryPath }));
        repositoryActions.append(actionButton);
      });
      actionPanel.replaceChildren(
        header,
        summary,
        createPathSection('Incoming files', preview.incomingChangedPaths),
        createPathSection('Outgoing files', preview.outgoingChangedPaths),
        repositoryActions
      );
      actionPanel.hidden = false;
    }

    function createPanelHeader(titleText, subtitleText) {
      const header = document.createElement('div');
      header.className = 'panel-header';
      const titleGroup = document.createElement('div');
      titleGroup.className = 'panel-title';
      titleGroup.textContent = titleText;
      const subtitle = document.createElement('div');
      subtitle.className = 'panel-subtitle';
      subtitle.textContent = subtitleText;
      titleGroup.append(subtitle);
      const closeButton = document.createElement('button');
      closeButton.className = 'close-button';
      closeButton.type = 'button';
      closeButton.textContent = '×';
      closeButton.title = 'Close';
      closeButton.setAttribute('aria-label', 'Close graph actions');
      closeButton.addEventListener('click', closeActionPanel);
      header.append(titleGroup, closeButton);
      return header;
    }

    function createActionButton(labelText, descriptionText, disabledReason) {
      const actionButton = document.createElement('button');
      actionButton.className = 'action';
      actionButton.type = 'button';
      actionButton.title = disabledReason || descriptionText;
      const label = document.createElement('span');
      label.className = 'action-label';
      label.textContent = labelText;
      actionButton.append(label);
      if (descriptionText || disabledReason) {
        const description = document.createElement('span');
        description.className = 'action-description';
        description.textContent = disabledReason || descriptionText;
        actionButton.append(description);
      }
      return actionButton;
    }

    function createMetrics(metricTexts, riskIndex = -1) {
      const summary = document.createElement('div');
      summary.className = 'preview-summary';
      metricTexts.forEach((metricText, metricIndex) => {
        const metric = document.createElement('span');
        metric.className = 'metric' + (metricIndex === riskIndex ? ' risk' : '');
        metric.textContent = metricText;
        summary.append(metric);
      });
      return summary;
    }

    function createPathList(changedPaths) {
      const pathList = document.createElement('ul');
      pathList.className = 'path-list';
      changedPaths.slice(0, 40).forEach(changedPath => {
        const pathRow = document.createElement('li');
        pathRow.className = 'path-row';
        const pathStatus = document.createElement('span');
        pathStatus.className = 'path-status';
        pathStatus.textContent = changedPath.status;
        const pathName = document.createElement('span');
        pathName.className = 'path-name';
        pathName.textContent = changedPath.path;
        pathName.title = changedPath.path;
        pathRow.append(pathStatus, pathName);
        pathList.append(pathRow);
      });
      if (changedPaths.length > 40) {
        const remaining = document.createElement('li');
        remaining.className = 'path-row';
        remaining.textContent = '+' + (changedPaths.length - 40) + ' more paths';
        pathList.append(remaining);
      }
      return pathList;
    }

    function createPathSection(sectionTitle, changedPaths) {
      const pathSection = document.createElement('section');
      pathSection.className = 'action-section';
      const heading = document.createElement('div');
      heading.className = 'action-heading';
      heading.textContent = sectionTitle;
      pathSection.append(heading);
      pathSection.append(changedPaths.length ? createPathList(changedPaths) : createStatusMessage('None'));
      return pathSection;
    }

    function closeActionPanel() {
      actionPanel.hidden = true;
      actionPanel.replaceChildren();
    }

    document.addEventListener('keydown', keyboardEvent => {
      if (keyboardEvent.key !== 'Escape') return;
      if (!graphTour.hidden) completeGraphTour();
      else if (!actionPanel.hidden) closeActionPanel();
    });

    function openCommit(commitHash) { vscode.postMessage({ type: 'openCommit', commitHash, repositoryPath: currentRepositoryPath }); }

    function createGraph(commitRow) {
      const graphWidth = Math.max(24, commitRow.laneCount * 14 + 8);
      const svg = document.createElementNS(svgNamespace, 'svg');
      svg.classList.add('graph');
      svg.setAttribute('width', graphWidth);
      svg.setAttribute('height', '42');
      svg.setAttribute('viewBox', '0 0 ' + graphWidth + ' 42');
      svg.setAttribute('aria-hidden', 'true');
      const nodeX = laneX(commitRow.nodeLane);
      svg.append(createPath('M ' + nodeX + ' 0 L ' + nodeX + ' 21', commitRow.nodeColorIndex));
      commitRow.connections.forEach(connection => {
        const fromX = laneX(connection.fromLane);
        const toX = laneX(connection.toLane);
        const fromY = connection.startsAtNode ? 21 : 0;
        svg.append(createPath('M ' + fromX + ' ' + fromY + ' C ' + fromX + ' 31, ' + toX + ' 31, ' + toX + ' 42', connection.colorIndex));
      });
      const node = document.createElementNS(svgNamespace, 'circle');
      node.setAttribute('cx', nodeX);
      node.setAttribute('cy', '21');
      const changedLineCount = (commitRow.additions || 0) + (commitRow.deletions || 0);
      node.setAttribute('r', String(Math.min(6, Math.max(commitRow.parentCount > 1 ? 5 : 4, 4 + Math.log10(changedLineCount + 1)))));
      node.setAttribute('fill', 'var(--vscode-sideBar-background)');
      node.setAttribute('stroke', laneColors[commitRow.nodeColorIndex]);
      node.setAttribute('stroke-width', '2.5');
      svg.append(node);
      return svg;
    }

    function createPath(pathDefinition, colorIndex) {
      const graphPath = document.createElementNS(svgNamespace, 'path');
      graphPath.setAttribute('d', pathDefinition);
      graphPath.setAttribute('pathLength', '1');
      graphPath.setAttribute('fill', 'none');
      graphPath.setAttribute('stroke', laneColors[colorIndex]);
      graphPath.setAttribute('stroke-width', '2');
      return graphPath;
    }

    function createCommitDetails(commitRow) {
      const commitDetails = document.createElement('div');
      commitDetails.className = 'content';
      const headline = document.createElement('div');
      headline.className = 'headline';
      const subject = document.createElement('span');
      subject.className = 'subject';
      subject.textContent = commitRow.subject;
      headline.append(subject);
      const references = document.createElement('span');
      references.className = 'references';
      commitRow.referenceLabels.slice(0, 3).forEach(referenceState => {
        const reference = document.createElement('span');
        reference.className = 'reference ' + referenceState.kind;
        reference.textContent = referenceState.name;
        references.append(reference);
      });
      headline.append(references);
      const metadata = document.createElement('div');
      metadata.className = 'metadata';
      const hash = document.createElement('span');
      hash.className = 'hash';
      hash.textContent = commitRow.shortHash;
      const author = document.createElement('span');
      author.textContent = commitRow.authorName;
      const time = document.createElement('span');
      time.textContent = relativeTime(commitRow.committedAt);
      metadata.append(hash, author, time);
      if (commitRow.additions !== undefined) {
        const additions = document.createElement('span');
        additions.className = 'additions';
        additions.textContent = '+' + commitRow.additions;
        const deletions = document.createElement('span');
        deletions.className = 'deletions';
        deletions.textContent = '−' + commitRow.deletions;
        metadata.append(additions, deletions);
      }
      if (commitRow.parentCount > 1) {
        const merge = document.createElement('span');
        merge.textContent = 'merge';
        metadata.append(merge);
      }
      if (commitRow.hiddenLaneCount > 0) {
        const hiddenLanes = document.createElement('span');
        hiddenLanes.textContent = '+' + commitRow.hiddenLaneCount + ' lanes';
        metadata.append(hiddenLanes);
      }
      commitDetails.append(headline, metadata);
      return commitDetails;
    }

    function laneX(lane) { return 8 + lane * 14; }
    function exactDate(timestamp) { return timestamp ? new Date(timestamp).toLocaleString() : 'Date unavailable'; }
    function relativeTime(timestamp) {
      if (!timestamp) return '';
      const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      const days = Math.floor(hours / 24);
      if (days < 30) return days + 'd ago';
      const months = Math.floor(days / 30);
      return months < 12 ? months + 'mo ago' : Math.floor(months / 12) + 'y ago';
    }
  </script>
</body>
</html>`;
}
