import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { GitRepository } from "./gitApi.ts";
import {
  defaultCommitAction,
  listAvailableNativeGitActions,
  type NativeGitAction,
} from "./gitActionMenu.ts";
import { countRepositoryChanges } from "./gitModel.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

interface CommitViewMessage {
  readonly message?: string;
  readonly repositoryPath?: string;
  readonly type?: string;
}

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly changedSubscription: vscode.Disposable;
  private gitActionInProgress = false;
  private resolvedViewSubscriptions: vscode.Disposable | undefined;
  private webviewReady = false;
  private webviewView: vscode.WebviewView | undefined;

  public constructor(
    private readonly workspaceRepositories: WorkspaceRepositories,
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
      ),
    );
  }
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
    .branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .message-count { margin-left: auto; font-variant-numeric: tabular-nums; }
    .message-count[data-over-limit="true"] { color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); font-weight: 600; }
    .error { padding: 7px 9px; border-radius: 5px; color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); background: var(--vscode-inputValidation-errorBackground, transparent); font-size: 11px; box-shadow: inset 0 0 0 1px var(--vscode-inputValidation-errorBorder, transparent); }
    .screen-reader-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; } }
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
      <span id="branch" class="branch"></span>
      <output id="message-count" class="message-count" role="status" aria-live="polite" aria-atomic="true">0/50</output>
    </div>
    <div id="error" class="error" role="alert" hidden></div>
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
    const branchName = document.getElementById('branch');
    const commitError = document.getElementById('error');
    const idealCommitSubjectLength = 50;
    const graphemeSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
    let commitViewState;
    let gitActionRequestPending = false;

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
      branchName.textContent = commitViewState.branchName;
      commitMessageInput.placeholder = 'Message (' + (navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+') + 'Enter to commit on "' + commitViewState.branchName + '")';
      updateCommitMessagePresentation();
      updateCommitAvailability();
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
