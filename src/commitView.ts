import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import {
  type ChangeAction,
  type ChangeGroupKind,
  changeGroupLabel,
  createWorkingTreeChangePresentation,
  WorkingTreeChanges,
} from "./workingTreeChanges.ts";
import type { ConflictGuide } from "./conflictGuide.ts";
import type { GitRepository } from "./gitApi.ts";
import {
  defaultCommitAction,
  listAvailableNativeGitActions,
  type NativeGitAction,
} from "./gitActionMenu.ts";
import { countRepositoryChanges } from "./gitModel.ts";
import { pathsIdentifySameLocation } from "./pathIdentity.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

interface CommitViewMessage {
  readonly action?: ChangeAction | "open" | "resolve" | "stageGroup" | "unstageGroup";
  readonly filePath?: string;
  readonly groupKind?: ChangeGroupKind;
  readonly message?: string;
  readonly repositoryPath?: string;
  readonly type?: string;
}

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly changedSubscription: vscode.Disposable;
  private gitActionInProgress = false;
  private workingTreeActionInProgress = false;
  private resolvedViewSubscriptions: vscode.Disposable | undefined;
  private webviewReady = false;
  private webviewView: vscode.WebviewView | undefined;

  public constructor(
    private readonly workspaceRepositories: WorkspaceRepositories,
    private readonly workingTreeChanges: WorkingTreeChanges,
    private readonly conflictGuide: ConflictGuide,
    private readonly diagnostics: vscode.LogOutputChannel,
  ) {
    this.changedSubscription = workspaceRepositories.onDidChange(() => this.postCommitViewState());
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = { enableScripts: true };
    this.resolvedViewSubscriptions?.dispose();
    const messageSubscription = webviewView.webview.onDidReceiveMessage(
      (commitViewMessage: CommitViewMessage) => {
        void this.handleMessage(commitViewMessage);
      },
    );
    const disposalSubscription = webviewView.onDidDispose(() => {
      if (this.webviewView !== webviewView) {
        return;
      }
      this.webviewReady = false;
      this.webviewView = undefined;
    });
    this.resolvedViewSubscriptions = vscode.Disposable.from(
      messageSubscription,
      disposalSubscription,
    );
    webviewView.webview.html = createCommitViewHtml();
  }

  public dispose(): void {
    this.changedSubscription.dispose();
    this.resolvedViewSubscriptions?.dispose();
    this.resolvedViewSubscriptions = undefined;
    this.webviewReady = false;
    this.webviewView = undefined;
  }

  private async handleMessage(commitViewMessage: CommitViewMessage): Promise<void> {
    if (commitViewMessage.type === "ready") {
      this.webviewReady = true;
      this.postCommitViewState();
      return;
    }
    if (typeof commitViewMessage.repositoryPath !== "string") {
      return;
    }
    if (commitViewMessage.type === "selectRepository") {
      this.workspaceRepositories.selectRepository(commitViewMessage.repositoryPath);
      return;
    }

    const targetRepository = this.workspaceRepositories.findRepository(
      commitViewMessage.repositoryPath,
    );
    if (targetRepository === undefined) {
      if (commitViewMessage.type === "commit" || commitViewMessage.type === "chooseGitAction") {
        void this.webviewView?.webview.postMessage({
          busy: false,
          message: "The selected repository is no longer open.",
          type: "commitStatus",
        });
      } else if (commitViewMessage.type === "changeAction") {
        void this.webviewView?.webview.postMessage({
          busy: false,
          completed: true,
          message: "The selected repository is no longer open.",
          type: "changeStatus",
        });
      }
      return;
    }
    if (commitViewMessage.type === "setMessage") {
      if (typeof commitViewMessage.message === "string" && commitViewMessage.message.length <= 10_000) {
        targetRepository.inputBox.value = commitViewMessage.message;
      }
      return;
    }
    if (
      commitViewMessage.type === "changeAction" &&
      commitViewMessage.groupKind !== undefined &&
      commitViewMessage.action !== undefined &&
      !this.workingTreeActionInProgress
    ) {
      this.workingTreeActionInProgress = true;
      void this.webviewView?.webview.postMessage({ busy: true, type: "changeStatus" });
      let failureMessage: string | undefined;
      try {
        await this.runChangeAction(targetRepository, commitViewMessage);
      } catch (changeActionFailure) {
        this.diagnostics.error("Working tree action failed.", changeActionFailure);
        failureMessage = `Working tree action failed: ${errorMessage(changeActionFailure)}`;
      } finally {
        this.workingTreeActionInProgress = false;
        this.postCommitViewState();
        void this.webviewView?.webview.postMessage({
          busy: false,
          completed: true,
          ...(failureMessage === undefined ? {} : { message: failureMessage }),
          type: "changeStatus",
        });
      }
      return;
    }
    if (
      (commitViewMessage.type === "commit" || commitViewMessage.type === "chooseGitAction") &&
      !this.gitActionInProgress
    ) {
      await this.runNativeGitAction(
        commitViewMessage.type === "commit"
          ? async () => defaultCommitAction
          : () => chooseNativeGitAction(targetRepository),
        targetRepository,
      );
    }
  }

  private async runChangeAction(
    repository: GitRepository,
    commitViewMessage: CommitViewMessage,
  ): Promise<void> {
    const changeGroup = this.workingTreeChanges
      .getGroups(repository)
      .find(
        (candidateChangeGroup) =>
          candidateChangeGroup.groupKind === commitViewMessage.groupKind &&
          candidateChangeGroup.repository === repository,
      );
    if (changeGroup === undefined) {
      throw new Error(`The ${commitViewMessage.groupKind} change group is no longer available.`);
    }
    if (commitViewMessage.action === "stageGroup" || commitViewMessage.action === "unstageGroup") {
      await this.workingTreeChanges.runGroupAction(
        commitViewMessage.action === "stageGroup" ? "stage" : "unstage",
        changeGroup,
      );
      return;
    }
    if (commitViewMessage.filePath === undefined) {
      throw new Error("No file was selected.");
    }
    const changeNode = this.workingTreeChanges
      .getChanges(changeGroup)
      .find(
        (candidateWorkingTreeChange) =>
          pathsIdentifySameLocation(
            candidateWorkingTreeChange.change.uri.fsPath,
            commitViewMessage.filePath ?? "",
          ),
      );
    if (changeNode === undefined) {
      throw new Error("The selected file is no longer in this change group.");
    }
    if (commitViewMessage.action === "open") {
      await vscode.commands.executeCommand("git.openChange", changeNode.change.uri);
    } else if (commitViewMessage.action === "resolve") {
      await this.conflictGuide.open(
        repository,
        changeNode.change.uri,
        changeNode.changePosition,
        changeNode.changeCount,
      );
    } else if (
      commitViewMessage.action === "discard" ||
      commitViewMessage.action === "stage" ||
      commitViewMessage.action === "unstage"
    ) {
      await this.workingTreeChanges.runChangeAction(commitViewMessage.action, changeNode);
    }
  }

  private async runNativeGitAction(
    selectGitAction: () => Promise<NativeGitAction | undefined>,
    repository: GitRepository,
  ): Promise<void> {
    this.gitActionInProgress = true;
    void this.webviewView?.webview.postMessage({ busy: true, type: "commitStatus" });
    let selectedGitAction: NativeGitAction | undefined;
    let failureMessage: string | undefined;
    try {
      selectedGitAction = await selectGitAction();
      if (selectedGitAction !== undefined) {
        await vscode.commands.executeCommand(selectedGitAction.command, repository.rootUri);
      }
    } catch (gitActionFailure) {
      this.diagnostics.error("Native Git action failed.", gitActionFailure);
      failureMessage =
        selectedGitAction === undefined
          ? "Git action selection failed. Retry from the action menu."
          :
          selectedGitAction.section === "Commit"
            ? `${selectedGitAction.label} failed. Your message was kept.`
            : `${selectedGitAction.label} failed. Check the Git output for details.`;
    } finally {
      this.gitActionInProgress = false;
      this.postCommitViewState();
      void this.webviewView?.webview.postMessage({
        busy: false,
        ...(failureMessage === undefined ? {} : { message: failureMessage }),
        type: "commitStatus",
      });
    }
  }

  private postCommitViewState(): void {
    if (!this.webviewReady) {
      return;
    }
    const selectedRepository = this.workspaceRepositories.selectedRepository;
    void this.webviewView?.webview.postMessage(
      createCommitViewState(
        this.workspaceRepositories.repositories,
        selectedRepository,
        this.gitActionInProgress,
        this.workingTreeChanges,
      ),
    );
  }
}

function errorMessage(changeActionFailure: unknown): string {
  return changeActionFailure instanceof Error ? changeActionFailure.message : String(changeActionFailure);
}

async function chooseNativeGitAction(
  repository: GitRepository,
): Promise<NativeGitAction | undefined> {
  const availableGitActions = listAvailableNativeGitActions({
    hasCommitMessage: repository.inputBox.value.trim() !== "",
    hasHeadCommit: repository.state.HEAD?.commit !== undefined,
    hasStagedChanges: repository.state.indexChanges.length > 0,
    hasUncommittedChanges: countRepositoryChanges(repository.state) > 0,
  });
  const quickPickItems: Array<
    | (vscode.QuickPickItem & { readonly nativeGitAction: NativeGitAction })
    | vscode.QuickPickItem
  > = [];
  let previousSection: NativeGitAction["section"] | undefined;
  for (const nativeGitAction of availableGitActions) {
    if (nativeGitAction.section !== previousSection) {
      quickPickItems.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: nativeGitAction.section,
      });
      previousSection = nativeGitAction.section;
    }
    quickPickItems.push({
      description: nativeGitAction.description,
      iconPath: new vscode.ThemeIcon(nativeGitAction.iconId),
      label: nativeGitAction.label,
      nativeGitAction,
    });
  }
  const selectedGitAction = await vscode.window.showQuickPick(quickPickItems, {
    matchOnDescription: true,
    placeHolder: "Choose a commit or push action",
    title: "Git'o: Commit & Publish",
  });
  if (selectedGitAction === undefined || !("nativeGitAction" in selectedGitAction)) {
    return undefined;
  }
  return selectedGitAction.nativeGitAction;
}

function createCommitViewState(
  workspaceRepositories: readonly GitRepository[],
  selectedRepository: GitRepository | undefined,
  gitActionInProgress: boolean,
  workingTreeChanges: WorkingTreeChanges,
): object {
  const stagedChangeCount = selectedRepository?.state.indexChanges.length ?? 0;
  const unstagedChangeCount = selectedRepository
    ? selectedRepository.state.mergeChanges.length +
      selectedRepository.state.untrackedChanges.length +
      selectedRepository.state.workingTreeChanges.length
    : 0;
  return {
    branchName: selectedRepository?.state.HEAD?.name ?? "Detached HEAD",
    commitMessage: selectedRepository?.inputBox.value ?? "",
    changeGroups: createChangeGroupStates(workingTreeChanges, selectedRepository),
    gitActionInProgress,
    repositories: workspaceRepositories.map((repository) => ({
      label:
        repository.rootUri.path.split("/").filter(Boolean).at(-1) ?? repository.rootUri.fsPath,
      path: repository.rootUri.fsPath,
    })),
    selectedRepositoryPath: selectedRepository?.rootUri.fsPath,
    stagedChangeCount,
    type: "state",
    unstagedChangeCount,
  };
}

function createChangeGroupStates(
  workingTreeChanges: WorkingTreeChanges,
  selectedRepository: GitRepository | undefined,
): readonly object[] {
  return workingTreeChanges.getGroups(selectedRepository).map((changeGroup) => ({
    changes: workingTreeChanges.getChanges(changeGroup).map((workingTreeChange) => {
      const changePresentation = createWorkingTreeChangePresentation(workingTreeChange);
      return {
        description: changePresentation.description,
        filePath: workingTreeChange.change.uri.fsPath,
        label: changePresentation.fileName,
      };
    }),
    groupKind: changeGroup.groupKind,
    label: changeGroupLabel(changeGroup.groupKind),
  }));
}

function createCommitViewHtml(): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px 12px 12px; color: var(--vscode-foreground); background: transparent; font: var(--vscode-font-size) var(--vscode-font-family); }
    .surface { display: grid; gap: 10px; }
    select, textarea, button { width: 100%; font: inherit; }
    select, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 0; outline: none; }
    select { height: 32px; padding: 0 9px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--vscode-input-border, transparent); }
    select:focus-visible { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder), 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); }
    .message-editor { position: relative; min-height: 42px; max-height: 112px; overflow: hidden; border-radius: 6px; background: var(--vscode-input-background); box-shadow: inset 0 0 0 1px var(--vscode-input-border, transparent), inset 0 1px color-mix(in srgb, white 5%, transparent); transition: box-shadow 140ms cubic-bezier(.2, .8, .2, 1); }
    .message-editor:focus-within { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder), 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent); }
    .message-highlight { position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: var(--vscode-input-foreground); white-space: pre-wrap; overflow-wrap: anywhere; }
    .message-highlight, textarea { min-height: 42px; max-height: 110px; padding: 10px 11px; font: inherit; line-height: 1.4; }
    .message-overflow { color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); }
    .message-editor textarea { position: relative; z-index: 1; min-width: 100%; resize: vertical; border: 0; border-radius: 0; color: transparent; background: transparent; caret-color: var(--vscode-input-foreground); }
    .message-editor textarea::selection { color: var(--vscode-editor-selectionForeground, var(--vscode-input-foreground)); background: var(--vscode-editor-selectionBackground); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    button { min-height: 30px; border: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; transition: background-color 140ms cubic-bezier(.2, .8, .2, 1), opacity 140ms cubic-bezier(.2, .8, .2, 1), transform 140ms cubic-bezier(.2, .8, .2, 1); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .45; }
    .actions { display: grid; grid-template-columns: minmax(0, 1fr) 36px; gap: 1px; border-radius: 5px; overflow: hidden; box-shadow: 0 1px 2px color-mix(in srgb, var(--vscode-widget-shadow) 22%, transparent); }
    .primary-action { display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; }
    .action-icon { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
    .options-action { display: grid; place-items: center; border-left: 1px solid color-mix(in srgb, var(--vscode-button-foreground) 18%, transparent); }
    .options-action .action-icon { width: 14px; height: 14px; transition: transform 160ms cubic-bezier(.2, .8, .2, 1); }
    .options-action:hover .action-icon { transform: translateY(1px); }
    .summary { display: flex; align-items: center; gap: 12px; min-height: 18px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .summary strong { color: var(--vscode-foreground); font-weight: 600; }
    .branch { display: inline-flex; min-width: 0; align-items: center; gap: 4px; overflow: hidden; padding: 1px 6px; border-radius: 999px; color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-charts-green) 24%, transparent); }
    .branch svg { width: 11px; height: 11px; flex: none; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
    .branch-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .message-count { margin-left: auto; font-variant-numeric: tabular-nums; }
    .message-count[data-over-limit="true"] { color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); font-weight: 600; }
    .error { padding: 7px 9px; border-radius: 5px; color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); background: var(--vscode-inputValidation-errorBackground, transparent); font-size: 11px; box-shadow: inset 0 0 0 1px var(--vscode-inputValidation-errorBorder, transparent); }
    .changes { display: grid; gap: 4px; margin-top: 2px; padding-top: 8px; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
    .changes[data-busy="true"] { opacity: .55; pointer-events: none; }
    .clean-state { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 4px 7px; border-radius: 5px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground)) 7%, transparent); animation: clean-state-enter 220ms cubic-bezier(.2, .8, .2, 1) both; }
    .clean-state svg { width: 15px; height: 15px; color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground)); fill: currentColor; }
    .change-group { display: grid; gap: 1px; }
    .change-group-header { display: flex; align-items: center; gap: 7px; min-height: 30px; font-weight: 600; }
    .change-group-count { min-width: 20px; padding: 1px 6px; border-radius: 10px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; font-variant-numeric: tabular-nums; text-align: center; }
    .change-group-action, .change-action, .change-main { width: auto; min-height: 26px; color: var(--vscode-foreground); background: transparent; }
    .change-group-action { margin-left: auto; padding: 0 7px; border-radius: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .change-group-action:hover, .change-action:hover, .change-main:hover { color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
    .change-row { display: grid; grid-template-columns: minmax(0, 1fr) 28px 28px; align-items: center; min-height: 30px; border-radius: 4px; transition: background-color 120ms cubic-bezier(.2, .8, .2, 1), box-shadow 120ms cubic-bezier(.2, .8, .2, 1); }
    .change-row:hover { background: var(--vscode-list-hoverBackground); }
    .change-row:focus-within { background: var(--vscode-list-focusBackground); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    .change-row.single-action { grid-template-columns: minmax(0, 1fr) 28px; }
    .change-main { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 7px; padding: 4px 7px; text-align: left; }
    .change-name { overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .change-description { overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .change-action { display: grid; place-items: center; padding: 0; border-radius: 4px; color: var(--vscode-descriptionForeground); font-size: 16px; }
    .change-action[hidden] { display: none; }
    .screen-reader-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @keyframes clean-state-enter { from { opacity: 0; transform: translateY(3px); } }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-delay: 0ms !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <main class="surface">
    <select id="repository" aria-label="Repository" hidden></select>
    <div class="message-editor">
      <div id="message-highlight" class="message-highlight" aria-hidden="true"><span id="message-within-limit"></span><span id="message-overflow" class="message-overflow"></span><span id="message-body"></span></div>
      <textarea id="message" rows="1" maxlength="10000" aria-label="Commit message" aria-describedby="message-guidance message-count" placeholder="Message (⌘Enter to commit)"></textarea>
    </div>
    <span id="message-guidance" class="screen-reader-only">The recommended commit subject limit is 50 characters. Longer subjects are allowed and highlighted.</span>
    <div class="actions">
      <button id="commit" class="primary-action" type="button"><svg class="action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.25 8.25 3 3 6.5-7"/></svg><span>Commit</span></button>
      <button id="commit-options" class="options-action" type="button" title="Commit and push actions" aria-label="Open commit and push actions"><svg class="action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg></button>
    </div>
    <div class="summary" aria-live="polite">
      <span><strong id="staged">0</strong> staged</span>
      <span><strong id="unstaged">0</strong> unstaged</span>
      <span class="branch"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="5.5" r="1.75"/><path d="M4 5.25v5.5M5.75 11.5h1.5A4.75 4.75 0 0 0 12 6.75"/></svg><span id="branch-name" class="branch-name"></span></span>
      <output id="message-count" class="message-count" role="status" aria-live="polite" aria-atomic="true">0/50</output>
    </div>
    <div id="error" class="error" role="alert" hidden></div>
    <section id="changes" class="changes" aria-label="Working tree changes"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const repositorySelector = document.getElementById('repository');
    const commitMessageInput = document.getElementById('message');
    const commitMessageHighlight = document.getElementById('message-highlight');
    const messageWithinLimit = document.getElementById('message-within-limit');
    const messageOverflow = document.getElementById('message-overflow');
    const messageBody = document.getElementById('message-body');
    const messageCount = document.getElementById('message-count');
    const commitButton = document.getElementById('commit');
    const commitOptionsButton = document.getElementById('commit-options');
    const stagedChangeCount = document.getElementById('staged');
    const unstagedChangeCount = document.getElementById('unstaged');
    const branchNameLabel = document.getElementById('branch-name');
    const commitError = document.getElementById('error');
    const changesContainer = document.getElementById('changes');
    const idealCommitSubjectLength = 50;
    const graphemeSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
    let commitViewState;
    let gitActionRequestPending = false;
    let workingTreeActionPending = false;

    repositorySelector.addEventListener('change', () => vscode.postMessage({ type: 'selectRepository', repositoryPath: repositorySelector.value }));
    commitMessageInput.addEventListener('input', () => {
      vscode.postMessage({ type: 'setMessage', repositoryPath: repositorySelector.value, message: commitMessageInput.value });
      updateCommitMessagePresentation();
      updateCommitAvailability();
    });
    commitMessageInput.addEventListener('scroll', synchronizeMessageHighlight);
    commitMessageInput.addEventListener('keydown', keyboardEvent => {
      if (keyboardEvent.key === 'Enter' && (keyboardEvent.metaKey || keyboardEvent.ctrlKey) && !commitButton.disabled) {
        keyboardEvent.preventDefault();
        requestGitAction('commit');
      }
    });
    commitButton.addEventListener('click', () => requestGitAction('commit'));
    commitOptionsButton.addEventListener('click', () => requestGitAction('chooseGitAction'));

    window.addEventListener('message', messageEvent => {
      const commitViewMessage = messageEvent.data;
      if (commitViewMessage.type === 'commitStatus') {
        gitActionRequestPending = commitViewMessage.busy;
        if (commitViewState) commitViewState.gitActionInProgress = commitViewMessage.busy;
        commitError.hidden = !commitViewMessage.message;
        commitError.textContent = commitViewMessage.message || '';
        updateCommitAvailability();
        return;
      }
      if (commitViewMessage.type === 'changeStatus') {
        workingTreeActionPending = commitViewMessage.busy === true;
        changesContainer.dataset.busy = String(workingTreeActionPending);
        commitError.hidden = !commitViewMessage.message;
        commitError.textContent = commitViewMessage.message || '';
        return;
      }
      if (commitViewMessage.type !== 'state') return;
      commitViewState = commitViewMessage;
      repositorySelector.hidden = commitViewState.repositories.length < 2;
      repositorySelector.replaceChildren(...commitViewState.repositories.map(repositoryState => {
        const option = document.createElement('option');
        option.value = repositoryState.path;
        option.textContent = repositoryState.label;
        option.selected = repositoryState.path === commitViewState.selectedRepositoryPath;
        return option;
      }));
      if (document.activeElement !== commitMessageInput || gitActionRequestPending) {
        commitMessageInput.value = commitViewState.commitMessage;
      }
      commitMessageInput.disabled = !commitViewState.selectedRepositoryPath;
      stagedChangeCount.textContent = commitViewState.stagedChangeCount;
      unstagedChangeCount.textContent = commitViewState.unstagedChangeCount;
      branchNameLabel.textContent = commitViewState.branchName;
      commitMessageInput.placeholder = 'Message (' + (navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+') + 'Enter to commit on "' + commitViewState.branchName + '")';
      updateCommitMessagePresentation();
      updateCommitAvailability();
      renderChangeGroups();
    });
    vscode.postMessage({ type: 'ready' });

    new ResizeObserver(synchronizeMessageHighlight).observe(commitMessageInput);
    updateCommitMessagePresentation();

    function requestGitAction(gitActionType) {
      gitActionRequestPending = true;
      commitButton.disabled = true;
      commitOptionsButton.disabled = true;
      commitError.hidden = true;
      vscode.postMessage({ type: gitActionType, repositoryPath: repositorySelector.value });
    }

    function requestChangeAction(action, groupKind, filePath) {
      if (workingTreeActionPending) return;
      workingTreeActionPending = true;
      changesContainer.dataset.busy = 'true';
      commitError.hidden = true;
      vscode.postMessage({
        action,
        groupKind,
        ...(filePath ? { filePath } : {}),
        repositoryPath: repositorySelector.value,
        type: 'changeAction',
      });
    }

    function renderChangeGroups() {
      const changeGroups = commitViewState?.changeGroups ?? [];
      if (changeGroups.length === 0) {
        const cleanState = document.createElement('div');
        cleanState.className = 'clean-state';
        cleanState.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.25A6.75 6.75 0 1 0 8 14.75 6.75 6.75 0 0 0 8 1.25Zm3.28 4.95-3.8 4a.75.75 0 0 1-1.08.01L4.7 8.51a.75.75 0 0 1 1.06-1.06l1.16 1.16 3.27-3.44a.75.75 0 1 1 1.09 1.03Z"/></svg><span>Working Tree Clean</span>';
        changesContainer.replaceChildren(cleanState);
        return;
      }
      changesContainer.replaceChildren(...changeGroups.map(createChangeGroup));
    }

    function createChangeGroup(changeGroup) {
      const groupSection = document.createElement('section');
      groupSection.className = 'change-group';
      const groupHeader = document.createElement('div');
      groupHeader.className = 'change-group-header';
      const groupLabel = document.createElement('span');
      groupLabel.textContent = changeGroup.label;
      const groupCount = document.createElement('span');
      groupCount.className = 'change-group-count';
      groupCount.textContent = changeGroup.changes.length;
      groupHeader.append(groupLabel, groupCount);
      if (changeGroup.groupKind !== 'conflicts') {
        const groupAction = document.createElement('button');
        groupAction.className = 'change-group-action';
        groupAction.type = 'button';
        groupAction.textContent = changeGroup.groupKind === 'staged' ? 'Unstage All' : 'Stage All';
        groupAction.addEventListener('click', () => requestChangeAction(
          changeGroup.groupKind === 'staged' ? 'unstageGroup' : 'stageGroup',
          changeGroup.groupKind,
        ));
        groupHeader.append(groupAction);
      }
      groupSection.append(groupHeader, ...changeGroup.changes.map(change => createChangeRow(changeGroup.groupKind, change)));
      return groupSection;
    }

    function createChangeRow(groupKind, change) {
      const changeRow = document.createElement('div');
      changeRow.className = 'change-row' + (groupKind === 'unstaged' ? '' : ' single-action');
      const openAction = document.createElement('button');
      openAction.className = 'change-main';
      openAction.type = 'button';
      const changeName = document.createElement('span');
      changeName.className = 'change-name';
      changeName.textContent = change.label;
      const changeDescription = document.createElement('span');
      changeDescription.className = 'change-description';
      changeDescription.textContent = change.description;
      openAction.append(changeName, changeDescription);
      openAction.title = groupKind === 'conflicts' ? 'Open conflict guide' : 'Open changes';
      openAction.addEventListener('click', () => requestChangeAction(
        groupKind === 'conflicts' ? 'resolve' : 'open',
        groupKind,
        change.filePath,
      ));

      const primaryAction = document.createElement('button');
      primaryAction.className = 'change-action';
      primaryAction.type = 'button';
      primaryAction.textContent = groupKind === 'staged' ? '−' : groupKind === 'conflicts' ? '↔' : '+';
      primaryAction.title = groupKind === 'staged' ? 'Unstage' : groupKind === 'conflicts' ? 'Resolve conflict' : 'Stage';
      primaryAction.setAttribute('aria-label', primaryAction.title + ' ' + change.label);
      primaryAction.addEventListener('click', () => requestChangeAction(
        groupKind === 'staged' ? 'unstage' : groupKind === 'conflicts' ? 'resolve' : 'stage',
        groupKind,
        change.filePath,
      ));

      const discardAction = document.createElement('button');
      discardAction.className = 'change-action';
      discardAction.type = 'button';
      discardAction.textContent = '↶';
      discardAction.title = 'Discard changes';
      discardAction.setAttribute('aria-label', 'Discard changes in ' + change.label);
      discardAction.addEventListener('click', () => requestChangeAction('discard', groupKind, change.filePath));
      changeRow.append(openAction, primaryAction);
      if (groupKind === 'unstaged') changeRow.append(discardAction);
      return changeRow;
    }

    function updateCommitAvailability() {
      const gitActionUnavailable = !commitViewState || !commitViewState.selectedRepositoryPath || commitViewState.gitActionInProgress || gitActionRequestPending;
      const commitUnavailable = gitActionUnavailable || commitViewState.stagedChangeCount + commitViewState.unstagedChangeCount === 0 || commitMessageInput.value.trim() === '';
      commitButton.disabled = commitUnavailable;
      commitOptionsButton.disabled = gitActionUnavailable;
    }

    function updateCommitMessagePresentation() {
      const firstLineBreak = commitMessageInput.value.indexOf('\\n');
      const commitSubject = firstLineBreak === -1 ? commitMessageInput.value : commitMessageInput.value.slice(0, firstLineBreak);
      const commitBody = firstLineBreak === -1 ? '' : commitMessageInput.value.slice(firstLineBreak);
      const subjectGraphemes = graphemeSegmenter
        ? Array.from(graphemeSegmenter.segment(commitSubject), segment => segment.segment)
        : Array.from(commitSubject);
      const overflowCount = Math.max(0, subjectGraphemes.length - idealCommitSubjectLength);
      messageWithinLimit.textContent = subjectGraphemes.slice(0, idealCommitSubjectLength).join('');
      messageOverflow.textContent = subjectGraphemes.slice(idealCommitSubjectLength).join('');
      messageBody.textContent = commitBody + (commitBody.endsWith('\\n') ? '\u200b' : '');
      messageCount.textContent = overflowCount === 0
        ? subjectGraphemes.length + '/' + idealCommitSubjectLength
        : subjectGraphemes.length + '/' + idealCommitSubjectLength + ' · ' + overflowCount + ' over';
      messageCount.dataset.overLimit = String(overflowCount > 0);
      synchronizeMessageHighlight();
    }

    function synchronizeMessageHighlight() {
      commitMessageHighlight.style.width = commitMessageInput.clientWidth + 'px';
      commitMessageHighlight.style.height = commitMessageInput.clientHeight + 'px';
      commitMessageHighlight.scrollTop = commitMessageInput.scrollTop;
      commitMessageHighlight.scrollLeft = commitMessageInput.scrollLeft;
    }
  </script>
</body>
</html>`;
}
