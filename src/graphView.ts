import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { CoalescedAsyncRunner } from "./coalescedAsyncRunner.ts";
import type { GitRepository } from "./gitApi.ts";
import type { GitReference } from "./gitModel.ts";
import { buildCommitGraphRows } from "./graphModel.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

interface GraphViewMessage {
  readonly commitHash?: string;
  readonly repositoryPath?: string;
  readonly type?: string;
}

const graphPageSize = 50;
const maximumGraphEntries = 500;

export class GraphView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly changedSubscription: vscode.Disposable;
  private readonly refreshRunner: CoalescedAsyncRunner;
  private graphEntryLimit = graphPageSize;
  private lastGraphSourceKey: string | undefined;
  private lastRepositoryPath: string | undefined;
  private resolvedViewSubscriptions: vscode.Disposable | undefined;
  private refreshRequired = false;
  private scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
  private webviewReady = false;
  private webviewView: vscode.WebviewView | undefined;

  public constructor(private readonly workspaceRepositories: WorkspaceRepositories) {
    this.refreshRunner = new CoalescedAsyncRunner((forceRefresh) =>
      this.refresh(forceRefresh),
    );
    this.changedSubscription = workspaceRepositories.onDidChange(() => this.scheduleRefresh());
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
      this.webviewReady = true;
      this.lastGraphSourceKey = undefined;
      this.scheduleRefresh(0, true);
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
    if (
      graphViewMessage.type === "openCommit" &&
      typeof graphViewMessage.commitHash === "string" &&
      typeof graphViewMessage.repositoryPath === "string" &&
      /^[0-9a-f]{7,64}$/i.test(graphViewMessage.commitHash)
    ) {
      const selectedRepository = this.workspaceRepositories.selectedRepository;
      if (selectedRepository?.rootUri.fsPath === graphViewMessage.repositoryPath) {
        await vscode.commands.executeCommand(
          "git.viewCommit",
          selectedRepository.rootUri,
          graphViewMessage.commitHash,
        );
      }
    }
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
      void this.webviewView?.webview.postMessage({ rows: [], type: "state" });
      return;
    }
    if (selectedRepository.rootUri.fsPath !== this.lastRepositoryPath) {
      this.lastRepositoryPath = selectedRepository.rootUri.fsPath;
      this.graphEntryLimit = graphPageSize;
      forceRefresh = true;
    }

    try {
      const [branchReferences, tagReferences] = await Promise.all([
        selectedRepository.getRefs({
          pattern: ["refs/heads", "refs/remotes"],
          sort: "committerdate",
        }),
        selectedRepository.getRefs({ pattern: "refs/tags", sort: "creatordate" }),
      ]);
      const allGraphReferences = [...branchReferences, ...tagReferences];
      const graphSourceKey = createGraphSourceKey(
        selectedRepository,
        this.graphEntryLimit,
        allGraphReferences,
      );
      if (!forceRefresh && graphSourceKey === this.lastGraphSourceKey) {
        return;
      }
      void this.webviewView?.webview.postMessage({ type: "loading" });
      const graphReferenceNames = [...new Set([...branchReferences, ...tagReferences].flatMap(
        (gitReference) =>
          gitReference.name === undefined || gitReference.name.endsWith("/HEAD")
            ? []
            : [gitReference.name],
      ))];
      const gitCommits = await selectedRepository.log({
        maxEntries: this.graphEntryLimit,
        ...(graphReferenceNames.length === 0 ? {} : { refNames: graphReferenceNames }),
      });
      if (
        this.workspaceRepositories.selectedRepository?.rootUri.fsPath !==
        selectedRepository.rootUri.fsPath
      ) {
        return;
      }
      const targetWebviewView = this.webviewView;
      if (targetWebviewView === undefined) {
        return;
      }
      const graphStateDelivered = await targetWebviewView.webview.postMessage({
        hasMore:
          gitCommits.length === this.graphEntryLimit &&
          this.graphEntryLimit < maximumGraphEntries,
        repositoryName:
          selectedRepository.rootUri.path.split("/").filter(Boolean).at(-1) ??
          selectedRepository.rootUri.fsPath,
        repositoryPath: selectedRepository.rootUri.fsPath,
        rows: buildCommitGraphRows(gitCommits, allGraphReferences),
        type: "state",
      });
      if (graphStateDelivered && this.webviewView === targetWebviewView) {
        this.lastGraphSourceKey = graphSourceKey;
      }
    } catch {
      if (
        this.workspaceRepositories.selectedRepository?.rootUri.fsPath ===
        selectedRepository.rootUri.fsPath
      ) {
        void this.webviewView?.webview.postMessage({
          message: "Git history could not be loaded.",
          type: "error",
        });
      }
    }
  }
}

function createGraphSourceKey(
  repository: GitRepository,
  graphEntryLimit: number,
  graphReferences: readonly GitReference[],
): string {
  const referenceFingerprint = graphReferences
    .map((gitReference) => `${gitReference.type}:${gitReference.name ?? ""}:${gitReference.commit ?? ""}`)
    .sort()
    .join("|");
  return `${repository.rootUri.fsPath}:${repository.state.HEAD?.commit ?? ""}:${graphEntryLimit}:${referenceFingerprint}`;
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
    .toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 5px 9px 5px 12px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); box-shadow: inset 0 -1px var(--vscode-sideBarSectionHeader-border, transparent); }
    .toolbar strong { min-width: 0; overflow: hidden; color: var(--vscode-foreground); text-overflow: ellipsis; white-space: nowrap; }
    .icon-button { display: grid; width: 26px; height: 26px; margin-left: auto; padding: 0; place-items: center; border: 0; border-radius: 5px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; transition: background-color 140ms cubic-bezier(.2, .8, .2, 1), transform 140ms cubic-bezier(.2, .8, .2, 1); }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-button:active { transform: rotate(18deg); }
    .icon-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
    .row { display: grid; grid-template-columns: auto minmax(0, 1fr); min-height: 42px; margin: 1px 4px; padding: 0 8px 0 3px; border-radius: 5px; cursor: pointer; outline: none; transition: background-color 120ms cubic-bezier(.2, .8, .2, 1); }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row:focus-visible { background: var(--vscode-list-focusBackground); color: var(--vscode-list-focusForeground); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    .graph { align-self: stretch; }
    .content { align-self: center; min-width: 0; padding: 4px 0; }
    .headline, .metadata { display: flex; min-width: 0; align-items: center; gap: 6px; }
    .subject { overflow: hidden; font-weight: 600; letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
    .metadata { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .hash { font-family: var(--vscode-editor-font-family); }
    .references { display: inline-flex; min-width: 0; gap: 3px; }
    .reference { max-width: 140px; overflow: hidden; padding: 1px 6px; border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent); }
    .reference.tag { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 18%, transparent); }
    .reference.remote { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 18%, transparent); }
    .state, .more { padding: 14px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    .more { width: calc(100% - 24px); min-height: 34px; margin: 9px 12px 14px; padding: 0 12px; border: 0; border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font: inherit; font-weight: 600; transition: background-color 140ms cubic-bezier(.2, .8, .2, 1), transform 140ms cubic-bezier(.2, .8, .2, 1); }
    .more:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .more:active { transform: translateY(1px); }
    .more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <header class="toolbar"><strong id="repository">History</strong><span id="count"></span><button id="refresh" class="icon-button" type="button" title="Refresh history" aria-label="Refresh history"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5.5V2.75l-1.15 1.16A5.25 5.25 0 1 0 13.1 9"/><path d="M13 2.75h-2.75"/></svg></button></header>
  <main id="rows"><div class="state">Loading history…</div></main>
  <button id="more" class="more" type="button" hidden>Load 50 more</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const laneColors = ['var(--vscode-charts-blue)', 'var(--vscode-charts-green)', 'var(--vscode-charts-purple)', 'var(--vscode-charts-orange)'];
    const graphRowsContainer = document.getElementById('rows');
    const repositoryNameLabel = document.getElementById('repository');
    const commitCountLabel = document.getElementById('count');
    const loadMoreButton = document.getElementById('more');
    let currentRepositoryPath;
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    loadMoreButton.addEventListener('click', () => vscode.postMessage({ type: 'loadMore' }));

    window.addEventListener('message', messageEvent => {
      const graphViewMessage = messageEvent.data;
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
      currentRepositoryPath = graphViewMessage.repositoryPath;
      repositoryNameLabel.textContent = graphViewMessage.repositoryName || 'History';
      commitCountLabel.textContent = graphViewMessage.rows.length ? graphViewMessage.rows.length + ' commits' : '';
      graphRowsContainer.replaceChildren(...(graphViewMessage.rows.length ? graphViewMessage.rows.map(createCommitRow) : [createStatusMessage('No commits yet')]));
      loadMoreButton.hidden = !graphViewMessage.hasMore;
    });
    vscode.postMessage({ type: 'ready' });

    function createStatusMessage(messageText) {
      const statusMessage = document.createElement('div');
      statusMessage.className = 'state';
      statusMessage.textContent = messageText;
      return statusMessage;
    }

    function createCommitRow(commitRow) {
      const commitRowElement = document.createElement('div');
      commitRowElement.className = 'row';
      commitRowElement.tabIndex = 0;
      commitRowElement.setAttribute('role', 'button');
      commitRowElement.setAttribute('aria-label', commitRow.subject + ', ' + commitRow.authorName + ', ' + exactDate(commitRow.committedAt));
      commitRowElement.title = commitRow.hash + '\n' + commitRow.authorName + '\n' + exactDate(commitRow.committedAt);
      commitRowElement.append(createGraph(commitRow), createCommitDetails(commitRow));
      commitRowElement.addEventListener('click', () => openCommit(commitRow.hash));
      commitRowElement.addEventListener('keydown', keyboardEvent => {
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
          keyboardEvent.preventDefault();
          openCommit(commitRow.hash);
        }
      });
      return commitRowElement;
    }

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
      node.setAttribute('r', commitRow.parentCount > 1 ? '5' : '4');
      node.setAttribute('fill', 'var(--vscode-sideBar-background)');
      node.setAttribute('stroke', laneColors[commitRow.nodeColorIndex]);
      node.setAttribute('stroke-width', '2.5');
      svg.append(node);
      return svg;
    }

    function createPath(pathDefinition, colorIndex) {
      const graphPath = document.createElementNS(svgNamespace, 'path');
      graphPath.setAttribute('d', pathDefinition);
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
