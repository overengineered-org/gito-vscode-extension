import * as nodePath from "node:path";
import * as vscode from "vscode";
import { isAbortError } from "../git/gitCommandRunner.js";
import { redactGitErrorMessage } from "../git/gitErrorFormatting.js";
import type {
  BlameLine,
  FileHistoryEntry,
  GitRevisionResource,
  HistoryCommit,
  HistoryFileChange,
  HistoryQuery,
  HistoryRepositoryRoot,
  LineHistoryEntry,
  NativeDiffPlan,
} from "../history/index.js";
import {
  defaultHistoryExperienceSettings,
  historyExperienceCommandIds,
  historyExperienceSettingKeys,
  type HistoryCommitCommandArguments,
  type HistoryFileCommandArguments,
  type HistoryExperienceCommandRegistry,
  type HistoryExperienceDependencies,
  type HistoryExperienceSettings,
  type HistoryLineCommandArguments,
  type HistoryQueryChip,
  type HistoryRevisionCommandArguments,
} from "./historyExperienceModels.js";

const codeLensCommitLimit = 3;
const historyQuickPickLimit = 100;
const binaryProbeNul = "\u0000";
const selectionRefreshDebounceMilliseconds = 25;

export interface HistoryExperienceState {
  readonly generation: number;
  readonly repositoryRoot?: string;
  readonly relativePath?: string;
  readonly lineNumber?: number;
  readonly blameCommitSha?: string;
  readonly cacheEntryCount: number;
  readonly blameVisible: boolean;
}

interface HistoryCacheRecord {
  readonly key: string;
  readonly data: unknown;
}

interface HistoryCacheValue<T> {
  readonly value: T;
}

interface HistoryQuickPickItem extends vscode.QuickPickItem {
  readonly commit?: HistoryCommit;
  readonly fileHistoryEntry?: FileHistoryEntry;
  readonly lineHistoryEntry?: LineHistoryEntry;
  readonly action?: HistoryQuickPickAction;
}

type HistoryQuickPickAction =
  | "openRevision"
  | "openContributors"
  | "copySha"
  | "openFileHistory"
  | "openLineHistory"
  | "previousRevision"
  | "nextRevision"
  | "search";

interface HistorySearchQuickPickItem extends vscode.QuickPickItem {
  readonly chip?: HistoryQueryChip;
  readonly queryAction?: "search";
}

interface HistoryBlameContext {
  readonly repositoryRoot: HistoryRepositoryRoot;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly document: vscode.TextDocument;
  readonly editor?: vscode.TextEditor;
}

interface HistoryFileContext {
  readonly repositoryRoot: HistoryRepositoryRoot;
  readonly relativePath: string;
}

interface HistoryLineContext extends HistoryFileContext {
  readonly lineNumber: number;
}

interface HistoryRevisionContext {
  readonly repositoryRoot: HistoryRepositoryRoot;
  readonly relativePath: string;
  readonly revisionSha: string;
  readonly parentSha?: string;
}

/**
 * Native, opt-in history surfaces. The class owns only presentation state;
 * Git semantics remain in PremiumHistoryService.
 */
export class HistoryExperienceController {
  private readonly cache = new Map<string, HistoryCacheRecord>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeOperation: AbortController | undefined;
  private blameDecoration: vscode.TextEditorDecorationType | undefined;
  private blameStatusBar: vscode.StatusBarItem | undefined;
  private activeEditor: vscode.TextEditor | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private activeBlame: BlameLine | undefined;
  private repositoryRootPath: string | undefined;
  private relativePath: string | undefined;
  private lineNumber: number | undefined;
  private selectionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private isRegistered = false;
  private disposed = false;
  private readonly providerOperations = new Set<{
    readonly signal: AbortSignal;
    dispose(): void;
  }>();
  private readonly codeLensChangeListeners = new Set<(event: void) => void>();
  private readonly codeLensChangeEvent = ((listener: (event: void) => void) => {
    this.codeLensChangeListeners.add(listener);
    return new vscode.Disposable(() =>
      this.codeLensChangeListeners.delete(listener),
    );
  }) as vscode.Event<void>;
  private settings: HistoryExperienceSettings =
    defaultHistoryExperienceSettings;

  public constructor(
    private readonly dependencies: HistoryExperienceDependencies,
  ) {}

  /** Registers native providers, state listeners, and commands once. */
  public register(
    commandRegistry: HistoryExperienceCommandRegistry = vscode.commands,
  ): readonly vscode.Disposable[] {
    if (this.isRegistered) return [...this.disposables];
    this.disposed = false;
    this.isRegistered = true;
    this.settings = this.readSettings();
    this.createPresentationControls();
    this.registerStateListeners();
    this.registerProviders();
    this.disposables.push(...this.registerCommands(commandRegistry));
    void this.refreshActiveEditor();
    return [...this.disposables];
  }

  private registerCommands(
    commandRegistry: HistoryExperienceCommandRegistry = vscode.commands,
  ): readonly vscode.Disposable[] {
    const register = (
      commandIdentifier: string,
      handler: (...argumentsPassed: readonly unknown[]) => unknown,
    ): vscode.Disposable =>
      commandRegistry.registerCommand(commandIdentifier, handler);
    return [
      register(historyExperienceCommandIds.toggleBlame, () =>
        this.toggleBlame(),
      ),
      register(historyExperienceCommandIds.openFileHistory, (argument) =>
        this.openFileHistory(argument),
      ),
      register(historyExperienceCommandIds.openLineHistory, (argument) =>
        this.openLineHistory(argument),
      ),
      register(historyExperienceCommandIds.openContributors, (argument) =>
        this.openContributors(argument),
      ),
      register(historyExperienceCommandIds.search, () => this.searchHistory()),
      register(historyExperienceCommandIds.previousRevision, (argument) =>
        this.navigateRevision("previous", argument),
      ),
      register(historyExperienceCommandIds.nextRevision, (argument) =>
        this.navigateRevision("next", argument),
      ),
      register(historyExperienceCommandIds.openCommit, (argument) =>
        this.openCommit(argument),
      ),
    ];
  }

  public getState(): HistoryExperienceState {
    return {
      generation: this.generation,
      ...(this.repositoryRootPath === undefined
        ? {}
        : { repositoryRoot: this.repositoryRootPath }),
      ...(this.relativePath === undefined
        ? {}
        : { relativePath: this.relativePath }),
      ...(this.lineNumber === undefined ? {} : { lineNumber: this.lineNumber }),
      ...(this.activeBlame === undefined
        ? {}
        : { blameCommitSha: this.activeBlame.commitSha }),
      cacheEntryCount: this.cache.size,
      blameVisible:
        this.blameDecoration !== undefined && this.activeBlame !== undefined,
    };
  }

  /** Invalidates all presentation data after a repository/index/ref update. */
  public invalidateCache(repositoryRoot?: HistoryRepositoryRoot): void {
    if (repositoryRoot === undefined) {
      this.cache.clear();
    } else {
      const repositoryIdentity = historyRepositoryIdentity(repositoryRoot);
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${repositoryIdentity}|`)) this.cache.delete(key);
      }
    }
    this.cancelActiveOperation();
    this.cancelScheduledSelectionRefresh();
    for (const operation of this.providerOperations) operation.dispose();
    this.providerOperations.clear();
    this.generation += 1;
    this.activeBlame = undefined;
    this.clearPresentation(this.activeEditor);
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelActiveOperation();
    this.cancelScheduledSelectionRefresh();
    for (const operation of this.providerOperations) operation.dispose();
    this.providerOperations.clear();
    this.generation += 1;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.blameDecoration?.dispose();
    this.blameDecoration = undefined;
    this.blameStatusBar?.dispose();
    this.blameStatusBar = undefined;
    this.activeEditor = undefined;
    this.decoratedEditor = undefined;
    this.activeBlame = undefined;
    this.cache.clear();
    this.isRegistered = false;
  }

  private readSettings(): HistoryExperienceSettings {
    const configuredSettings =
      this.dependencies.readSettings?.() ?? readDefaultSettingsFromWorkspace();
    return normalizeSettings(configuredSettings);
  }

  private createPresentationControls(): void {
    try {
      this.blameDecoration = vscode.window.createTextEditorDecorationType({
        after: {
          color: new vscode.ThemeColor("descriptionForeground"),
          margin: "0 0 0 1.2em",
        },
      });
      this.blameStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
      );
      this.blameStatusBar.name = "Git'o current-line history";
      this.blameStatusBar.command = historyExperienceCommandIds.openCommit;
    } catch {
      // Minimal extension hosts may not expose editor presentation APIs.
      this.blameDecoration = undefined;
      this.blameStatusBar = undefined;
    }
  }

  private registerStateListeners(): void {
    this.tryAddDisposable(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const previousEditor = this.activeEditor;
        this.cancelActiveOperation();
        this.cancelScheduledSelectionRefresh();
        this.clearPresentation(previousEditor);
        this.generation += 1;
        this.activeEditor = editor;
        this.activeBlame = undefined;
        this.clearPresentation(editor);
        this.fireCodeLensChange();
        void this.refreshActiveEditor();
      }),
    );
    this.tryAddDisposable(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (
          this.disposed ||
          event.textEditor !== vscode.window.activeTextEditor
        )
          return;
        this.activeEditor = event.textEditor;
        this.cancelActiveOperation();
        this.cancelScheduledSelectionRefresh();
        this.generation += 1;
        this.clearPresentation(event.textEditor);
        this.fireCodeLensChange();
        this.scheduleSelectionRefresh(event.textEditor);
      }),
    );
    this.tryAddDisposable(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          this.activeEditor?.document.uri.toString() !==
          event.document.uri.toString()
        )
          return;
        this.invalidateCacheForDocument();
        this.fireCodeLensChange();
        void this.refreshActiveEditor();
      }),
    );
    this.tryAddDisposable(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("gito")) return;
        this.settings = this.readSettings();
        this.invalidateCache();
        this.fireCodeLensChange();
        this.clearPresentation(this.activeEditor);
        void this.refreshActiveEditor();
      }),
    );
    this.tryAddDisposable(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.invalidateCache();
        this.fireCodeLensChange();
        void this.refreshActiveEditor();
      }),
    );
    const repositoryWatcher =
      this.dependencies.repositoryProvider.watchRepositoryChanges?.(() => {
        this.cancelActiveOperation();
        this.invalidateCache();
        this.fireCodeLensChange();
        this.clearPresentation(this.activeEditor);
        void this.refreshActiveEditor();
      });
    if (repositoryWatcher !== undefined)
      this.tryAddDisposable(repositoryWatcher);
    const repositoryStateWatcher =
      this.dependencies.repositoryProvider.watchRepositoryStateChanges?.(() => {
        this.cancelActiveOperation();
        this.invalidateCache();
        this.fireCodeLensChange();
        this.clearPresentation(this.activeEditor);
        void this.refreshActiveEditor();
      });
    if (repositoryStateWatcher !== undefined)
      this.tryAddDisposable(repositoryStateWatcher);
  }

  private registerProviders(): void {
    this.disposables.push(
      vscode.languages.registerHoverProvider(
        { scheme: "file" },
        {
          provideHover: (document, position, token) =>
            this.provideHover(document, position, token),
        },
      ),
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        {
          onDidChangeCodeLenses: this.codeLensChangeEvent,
          provideCodeLenses: (document, token) =>
            this.provideCodeLenses(document, token),
        },
      ),
    );
  }

  private tryAddDisposable(disposable: vscode.Disposable | undefined): void {
    if (disposable !== undefined) this.disposables.push(disposable);
  }

  private fireCodeLensChange(): void {
    for (const listener of this.codeLensChangeListeners) listener(undefined);
  }

  private async refreshActiveEditor(): Promise<void> {
    const editor = this.activeEditor ?? vscode.window.activeTextEditor;
    const refreshGeneration = this.generation;
    this.activeEditor = editor;
    if (editor === undefined) {
      this.clearPresentation(editor);
      return;
    }
    if (
      !this.settings.enabled ||
      !this.settings.blameEnabled ||
      !workspaceIsTrusted()
    ) {
      this.clearPresentation(editor);
      return;
    }
    if (!this.canReadHistory(editor.document)) {
      this.clearPresentation(editor);
      return;
    }
    const context = await this.resolveBlameContext(editor.document, editor);
    if (
      context === undefined ||
      !this.isHistoryOperationGenerationCurrent(refreshGeneration) ||
      this.activeEditor !== editor
    ) {
      this.clearPresentation(editor);
      return;
    }
    const operationGeneration = refreshGeneration;
    const operation = this.beginOperation();
    try {
      const blameLine = await this.loadBlameLine(context, operation.signal);
      if (
        !this.isHistoryOperationLocallyCurrent(
          operation,
          operationGeneration,
        ) ||
        this.activeEditor !== editor ||
        this.disposed
      )
        return;
      this.repositoryRootPath = historyRepositoryPath(context.repositoryRoot);
      this.relativePath = context.relativePath;
      this.lineNumber = context.lineNumber;
      this.activeBlame = blameLine;
      this.renderBlame(editor, context, blameLine);
    } catch (error: unknown) {
      if (!isAbortError(error)) this.clearPresentation(editor);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async loadBlameLine(
    context: HistoryBlameContext,
    cancellationSignal: AbortSignal,
  ): Promise<BlameLine | undefined> {
    const cacheKey = makeHistoryCacheKey(
      context.repositoryRoot,
      "blame",
      context.relativePath,
      String(context.lineNumber),
    );
    const cachedBlame = this.getCached<BlameLine>(cacheKey);
    if (cachedBlame !== undefined) return cachedBlame;
    const blameLines = await this.dependencies.historyService.getBlame(
      context.repositoryRoot,
      context.relativePath,
      {
        range: { startLine: context.lineNumber, endLine: context.lineNumber },
        cancellationSignal,
      },
    );
    if (cancellationSignal.aborted)
      throw new DOMException("History operation cancelled", "AbortError");
    const blameLine = blameLines[0];
    if (blameLine !== undefined) this.setCached(cacheKey, blameLine);
    return blameLine;
  }

  private renderBlame(
    editor: vscode.TextEditor,
    context: HistoryBlameContext,
    blameLine: BlameLine | undefined,
  ): void {
    if (blameLine === undefined) {
      this.clearPresentation(editor);
      return;
    }
    const lineIndex = context.lineNumber - 1;
    const lineRange = editor.document.lineAt(lineIndex).range;
    const blameLabel = formatBlameLabel(blameLine);
    const hoverMessage = createBlameMarkdown(blameLine, {
      repositoryRoot: context.repositoryRoot,
      filePath: context.relativePath,
      lineNumber: context.lineNumber,
    });
    if (this.blameDecoration !== undefined) {
      editor.setDecorations(this.blameDecoration, [
        { range: lineRange, hoverMessage },
      ]);
      this.decoratedEditor = editor;
    }
    if (this.blameStatusBar !== undefined) {
      this.blameStatusBar.text = `$(git-commit) ${blameLabel}`;
      this.blameStatusBar.tooltip = `Line ${context.lineNumber} · ${blameLine.pathAtRevision} · ${blameLine.commitSha}`;
      this.blameStatusBar.command = {
        command: historyExperienceCommandIds.openCommit,
        title: "Open blamed commit",
        arguments: [
          createBlameCommitArguments(
            {
              repositoryRoot: context.repositoryRoot,
              filePath: context.relativePath,
            },
            blameLine,
          ),
        ],
      };
      this.blameStatusBar.show();
    }
  }

  private clearPresentation(editor: vscode.TextEditor | undefined): void {
    const decoratedEditor = this.decoratedEditor ?? editor;
    if (decoratedEditor !== undefined && this.blameDecoration !== undefined) {
      decoratedEditor.setDecorations(this.blameDecoration, []);
    }
    this.decoratedEditor = undefined;
    if (this.blameStatusBar !== undefined) {
      this.blameStatusBar.hide();
      this.blameStatusBar.command = undefined;
    }
    this.activeBlame = undefined;
    this.repositoryRootPath = undefined;
    this.relativePath = undefined;
    this.lineNumber = undefined;
  }

  private async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const requestGeneration = this.generation;
    if (
      !this.settings.enabled ||
      !this.settings.blameEnabled ||
      !workspaceIsTrusted()
    )
      return undefined;
    if (!this.canReadHistory(document)) return undefined;
    const context = await this.resolveBlameContext(
      document,
      undefined,
      position.line + 1,
    );
    if (
      context === undefined ||
      token.isCancellationRequested ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return undefined;
    const operation = this.beginProviderOperation(token);
    const operationGeneration = requestGeneration;
    try {
      const blameLine = await this.loadBlameLine(context, operation.signal);
      if (
        blameLine === undefined ||
        token.isCancellationRequested ||
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return undefined;
      return new vscode.Hover(
        createBlameMarkdown(blameLine, {
          repositoryRoot: context.repositoryRoot,
          filePath: context.relativePath,
          lineNumber: context.lineNumber,
        }),
        new vscode.Range(
          position.line,
          0,
          position.line,
          document.lineAt(position.line).text.length,
        ),
      );
    } catch (error: unknown) {
      if (!isAbortError(error)) return undefined;
      return undefined;
    } finally {
      operation.dispose();
    }
  }

  private async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const requestGeneration = this.generation;
    if (
      !this.settings.enabled ||
      !this.settings.codeLensEnabled ||
      !workspaceIsTrusted()
    )
      return [];
    if (!this.canReadHistory(document) || token.isCancellationRequested)
      return [];
    const context = await this.resolveBlameContext(document);
    if (
      context === undefined ||
      token.isCancellationRequested ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return [];
    const operation = this.beginProviderOperation(token);
    const operationGeneration = requestGeneration;
    try {
      const entries = await this.loadFileHistory(
        context.repositoryRoot,
        context.relativePath,
        operation.signal,
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return [];
      const uniqueAuthors = new Set<string>();
      const recentEntries = entries.filter((entry) => {
        const identityKey = entry.authorEmail.toLowerCase();
        if (uniqueAuthors.has(identityKey)) return false;
        uniqueAuthors.add(identityKey);
        return true;
      });
      return recentEntries.slice(0, codeLensCommitLimit).map((entry) => {
        const commandArguments: HistoryCommitCommandArguments = {
          repositoryRoot: context.repositoryRoot,
          commit: entry,
          filePath: entry.path,
        };
        return new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: `Recent change · ${entry.authorName} · ${entry.subject}`,
          command: historyExperienceCommandIds.openCommit,
          arguments: [commandArguments],
        });
      });
    } catch (error: unknown) {
      if (!isAbortError(error) && !this.disposed) return [];
      return [];
    } finally {
      operation.dispose();
    }
  }

  private async openFileHistory(argument?: unknown): Promise<void> {
    const requestGeneration = this.generation;
    const context = await this.resolveFileHistoryContext(argument);
    if (
      context === undefined ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return;
    const operation = this.beginOperation();
    const operationGeneration = requestGeneration;
    try {
      const entries = await this.loadFileHistory(
        context.repositoryRoot,
        context.relativePath,
        operation.signal,
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      const selectedItem = await vscode.window.showQuickPick(
        [
          createContributorsHistoryItem(),
          ...entries.map((entry) =>
            createFileHistoryItem(entry, context.relativePath),
          ),
        ],
        {
          title: `File history · ${context.relativePath}`,
          placeHolder: "Select a revision or rename path",
          matchOnDescription: true,
        },
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      if (selectedItem?.action === "openContributors") {
        await this.openContributors({
          repositoryRoot: context.repositoryRoot,
        });
        return;
      }
      if (selectedItem?.commit !== undefined)
        await this.openCommit({
          repositoryRoot: context.repositoryRoot,
          commit: selectedItem.commit,
          filePath: selectedItem.fileHistoryEntry?.path ?? context.relativePath,
        });
    } catch (error: unknown) {
      if (!isAbortError(error)) await showHistoryError(error);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async openLineHistory(argument?: unknown): Promise<void> {
    const requestGeneration = this.generation;
    const context = isHistoryLineCommandArguments(argument)
      ? await this.resolveLineHistoryContext(argument)
      : await this.resolveCurrentDocumentContext();
    if (
      context === undefined ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return;
    const operation = this.beginOperation();
    const operationGeneration = requestGeneration;
    try {
      const entries = await this.dependencies.historyService.listLineHistory(
        context.repositoryRoot,
        context.relativePath,
        context.lineNumber,
        {
          maxEntries: historyQuickPickLimit,
          ...(isHistoryLineCommandArguments(argument) &&
          argument.revision !== undefined
            ? { revision: argument.revision }
            : {}),
          cancellationSignal: operation.signal,
        },
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      const selectedItem = await vscode.window.showQuickPick(
        entries.map((entry) => createLineHistoryItem(entry)),
        {
          title: `Line ${context.lineNumber} history · ${context.relativePath}`,
          placeHolder: "Select a line revision",
          matchOnDescription: true,
        },
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      if (selectedItem?.commit !== undefined)
        await this.openCommit({
          repositoryRoot: context.repositoryRoot,
          commit: selectedItem.commit,
          filePath: selectedItem.lineHistoryEntry?.path ?? context.relativePath,
        });
    } catch (error: unknown) {
      if (!isAbortError(error)) await showHistoryError(error);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async openContributors(argument?: unknown): Promise<void> {
    const requestGeneration = this.generation;
    const explicitRoot = extractHistoryRepositoryRoot(argument);
    const repositoryRoot =
      explicitRoot ?? (await this.resolveRepositoryRootForActiveEditor());
    if (repositoryRoot === undefined) return;
    if (
      explicitRoot !== undefined &&
      !(await this.isRepositoryRootAuthorized(explicitRoot, undefined))
    )
      return;
    if (!this.isHistoryOperationGenerationCurrent(requestGeneration)) return;
    const operation = this.beginOperation();
    const operationGeneration = requestGeneration;
    try {
      const snapshot =
        await this.dependencies.historyService.aggregateContributors(
          repositoryRoot,
          {
            maxEntries: historyQuickPickLimit,
            cancellationSignal: operation.signal,
          },
        );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      await vscode.window.showQuickPick(
        snapshot.contributors.map((contributor) => ({
          label: contributor.authorName,
          description: `${contributor.commitCount} commits · ${contributor.authorEmail}`,
          detail: `${contributor.firstAuthorDate} → ${contributor.lastAuthorDate}`,
        })),
        {
          title: "Repository contributors",
          placeHolder: snapshot.reachedSafetyCap
            ? "Showing the bounded contributor sample"
            : "Select a contributor",
          matchOnDescription: true,
        },
      );
    } catch (error: unknown) {
      if (!isAbortError(error)) await showHistoryError(error);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async searchHistory(): Promise<void> {
    const requestGeneration = this.generation;
    const context = await this.resolveCurrentDocumentContext();
    if (
      context === undefined ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return;
    const querySource = await promptForHistoryQuery();
    if (
      querySource === undefined ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return;
    const terms = parseHistoryQueryTerms(querySource);
    if (terms.length === 0) {
      await vscode.window.showInformationMessage(
        "Enter at least one history query chip.",
      );
      return;
    }
    const query: HistoryQuery = {
      terms,
      matchAll: true,
      matchCase: false,
      regex: false,
      limit: historyQuickPickLimit,
    };
    const operation = this.beginOperation();
    const operationGeneration = requestGeneration;
    try {
      const searchResult = await this.dependencies.historyService.search(
        context.repositoryRoot,
        query,
        operation.signal,
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      await this.showSearchResults(
        context.repositoryRoot,
        searchResult.matches,
        querySource,
        operation,
        operationGeneration,
      );
    } catch (error: unknown) {
      if (!isAbortError(error)) await showHistoryError(error);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async showSearchResults(
    repositoryRoot: HistoryRepositoryRoot,
    commits: readonly HistoryCommit[],
    querySource: string,
    operation?: AbortController,
    operationGeneration?: number,
  ): Promise<void> {
    if (
      operation !== undefined &&
      operationGeneration !== undefined &&
      !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
    )
      return;
    if (commits.length === 0) {
      await vscode.window.showInformationMessage(
        `No history matches for “${querySource}”.`,
      );
      return;
    }
    const selectedItem = await vscode.window.showQuickPick(
      commits.map((commit) => createCommitItem(commit)),
      {
        title: `History search · ${querySource}`,
        placeHolder: "Select a matching commit",
        matchOnDescription: true,
      },
    );
    if (
      operation !== undefined &&
      operationGeneration !== undefined &&
      !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
    )
      return;
    if (selectedItem?.commit !== undefined)
      await this.openCommit({ repositoryRoot, commit: selectedItem.commit });
  }

  private async openCommit(argument: unknown): Promise<void> {
    if (!isHistoryCommitCommandArguments(argument)) return;
    const operationGeneration = this.generation;
    const { commit, repositoryRoot } = argument;
    if (
      repositoryRoot !== undefined &&
      !(await this.isRepositoryRootAuthorized(repositoryRoot, undefined))
    )
      return;
    if (!this.isHistoryOperationGenerationCurrent(operationGeneration)) return;
    const selectedAction =
      await vscode.window.showQuickPick<HistoryQuickPickItem>(
        [
          {
            label: "Open revision",
            description: `${commit.shortSha} · ${commit.subject}`,
            action: "openRevision",
          },
          {
            label: "Copy commit SHA",
            description: commit.sha,
            action: "copySha",
          },
          {
            label: "Open file history",
            description: argument.filePath ?? "active file",
            action: "openFileHistory",
          },
          {
            label: "Open line history",
            description: argument.filePath ?? "active file",
            action: "openLineHistory",
          },
          {
            label: "Open previous revision",
            action: "previousRevision",
          },
          {
            label: "Open next revision",
            action: "nextRevision",
          },
        ],
        {
          title: `${commit.shortSha} · ${commit.subject}`,
          placeHolder: `${commit.authorName} · ${commit.authorDate}`,
        },
      );
    if (selectedAction === undefined) return;
    if (!this.isHistoryOperationGenerationCurrent(operationGeneration)) return;
    const filePath = argument.filePath ?? firstChangedPath(commit);
    if (selectedAction.action === "copySha") {
      await vscode.env.clipboard.writeText(commit.sha);
      return;
    }
    if (selectedAction.action === "openRevision" && filePath !== undefined) {
      await this.openRevision({
        repositoryRoot,
        revisionSha: commit.sha,
        filePath: argument.revisionFilePath ?? filePath,
      });
      return;
    }
    if (selectedAction.action === "openFileHistory") {
      await this.openFileHistory({
        repositoryRoot,
        ...(filePath === undefined ? {} : { filePath }),
      });
      return;
    }
    if (selectedAction.action === "openLineHistory") {
      if (filePath === undefined) {
        await this.openLineHistory();
      } else {
        await this.openLineHistory({
          repositoryRoot,
          filePath,
          lineNumber: this.activeEditor?.selection.active.line
            ? this.activeEditor.selection.active.line + 1
            : 1,
        });
      }
      return;
    }
    if (
      (selectedAction.action === "previousRevision" ||
        selectedAction.action === "nextRevision") &&
      filePath !== undefined
    ) {
      await this.navigateRevision(
        selectedAction.action === "previousRevision" ? "previous" : "next",
        {
          repositoryRoot,
          revisionSha: commit.sha,
          filePath: argument.revisionFilePath ?? filePath,
        },
      );
    }
  }

  private async openRevision(argument: unknown): Promise<void> {
    if (!isHistoryRevisionCommandArguments(argument)) return;
    const operation = this.beginOperation();
    const operationGeneration = this.generation;
    try {
      const repositoryRoot =
        extractHistoryRepositoryRoot(argument) ??
        (await this.resolveRepositoryRootForActiveEditor());
      if (repositoryRoot === undefined || !workspaceIsTrusted()) return;
      const explicitRoot = extractHistoryRepositoryRoot(argument);
      if (
        explicitRoot !== undefined &&
        !(await this.isRepositoryRootAuthorized(explicitRoot, undefined))
      )
        return;
      const repositoryProvider = this.dependencies.repositoryProvider;
      const initialRepositoryIdentity =
        repositoryProvider.getRepositoryIdentity === undefined
          ? undefined
          : await repositoryProvider.getRepositoryIdentity(repositoryRoot);
      if (
        repositoryProvider.getRepositoryIdentity !== undefined &&
        initialRepositoryIdentity === undefined
      )
        return;
      let pinnedRevisionResource: GitRevisionResource | undefined;
      if (this.dependencies.historyService.getRevisionResource !== undefined) {
        pinnedRevisionResource =
          await this.dependencies.historyService.getRevisionResource(
            repositoryRoot,
            argument.revisionSha,
            argument.filePath,
            operation.signal,
          );
        if (pinnedRevisionResource === undefined) return;
      } else {
        if (this.dependencies.historyService.hasRevision === undefined) return;
        if (
          !(await this.dependencies.historyService.hasRevision(
            repositoryRoot,
            argument.revisionSha,
            operation.signal,
          ))
        )
          return;
      }
      if (
        !(await this.isHistoryOperationCurrent(
          operation,
          operationGeneration,
          repositoryRoot,
          initialRepositoryIdentity,
        ))
      )
        return;
      let normalizedPath: string;
      try {
        normalizedPath = normalizeRelativePath(argument.filePath);
        historyRepositoryPath(repositoryRoot);
      } catch {
        return;
      }
      if (
        !(await this.isHistoryOperationCurrent(
          operation,
          operationGeneration,
          repositoryRoot,
          initialRepositoryIdentity,
        ))
      )
        return;
      const revisionUri = createRevisionUri({
        ...(pinnedRevisionResource ?? {
          repositoryRoot: historyRepositoryPath(repositoryRoot),
          repositoryRootIdentity: historyRepositoryIdentity(repositoryRoot),
          revisionSha: argument.revisionSha,
          relativePath: normalizedPath,
        }),
      });
      await vscode.commands.executeCommand("vscode.open", revisionUri);
    } catch (error: unknown) {
      if (!isAbortError(error)) await showHistoryError(error);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async isHistoryOperationCurrent(
    operation: AbortController,
    operationGeneration: number,
    repositoryRoot: HistoryRepositoryRoot,
    initialRepositoryIdentity: string | undefined,
  ): Promise<boolean> {
    if (
      this.disposed ||
      operation.signal.aborted ||
      operationGeneration !== this.generation
    )
      return false;
    const repositoryProvider = this.dependencies.repositoryProvider;
    if (repositoryProvider.getRepositoryIdentity === undefined) return true;
    const currentRepositoryIdentity =
      await repositoryProvider.getRepositoryIdentity(repositoryRoot);
    if (
      this.disposed ||
      operation.signal.aborted ||
      operationGeneration !== this.generation
    )
      return false;
    return (
      currentRepositoryIdentity !== undefined &&
      currentRepositoryIdentity === initialRepositoryIdentity
    );
  }

  private async navigateRevision(
    direction: "previous" | "next",
    argument?: unknown,
  ): Promise<void> {
    const requestGeneration = this.generation;
    const context = await this.resolveRevisionContext(argument);
    if (
      context === undefined ||
      !this.isHistoryOperationGenerationCurrent(requestGeneration)
    )
      return;
    const operation = this.beginOperation();
    const operationGeneration = requestGeneration;
    try {
      const plan = await this.dependencies.historyService.getRevisionNavigation(
        context.repositoryRoot,
        context.revisionSha,
        context.relativePath,
        context.parentSha,
        operation.signal,
      );
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      const diffPlan =
        direction === "previous" ? plan.previousDiff : plan.nextDiff;
      if (diffPlan === undefined) {
        await vscode.window.showInformationMessage(
          `No ${direction} revision for ${context.relativePath}.`,
        );
        return;
      }
      if (
        !this.isHistoryOperationLocallyCurrent(operation, operationGeneration)
      )
        return;
      await this.openDiffPlan(diffPlan);
    } catch (error: unknown) {
      if (!isAbortError(error)) await showHistoryError(error);
    } finally {
      this.finishOperation(operation);
    }
  }

  private async openDiffPlan(diffPlan: NativeDiffPlan): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.diff",
      createRevisionUri(diffPlan.left),
      createRevisionUri(diffPlan.right),
      diffPlan.title,
    );
  }

  private async resolveCurrentDocumentContext(
    requestedLineNumber?: number,
  ): Promise<HistoryBlameContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || !this.canReadHistory(editor.document)) {
      await vscode.window.showInformationMessage(
        "Open a trusted, text file in a Git repository first.",
      );
      return undefined;
    }
    return this.resolveBlameContext(
      editor.document,
      editor,
      requestedLineNumber ?? editor.selection.active.line + 1,
    );
  }

  private async resolveFileHistoryContext(
    argument?: unknown,
  ): Promise<HistoryFileContext | undefined> {
    if (!workspaceIsTrusted()) return undefined;
    const explicitFilePath = extractHistoryFilePath(argument);
    if (explicitFilePath !== undefined) {
      const explicitRoot = extractHistoryRepositoryRoot(argument);
      const repositoryRoot =
        explicitRoot ?? (await this.resolveRepositoryRootForActiveEditor());
      if (repositoryRoot === undefined) return undefined;
      if (
        explicitRoot !== undefined &&
        !(await this.isRepositoryRootAuthorized(explicitRoot, undefined))
      )
        return undefined;
      try {
        return {
          repositoryRoot,
          relativePath: normalizeRelativePath(explicitFilePath),
        };
      } catch {
        return undefined;
      }
    }
    const activeContext = await this.resolveCurrentDocumentContext();
    return activeContext === undefined
      ? undefined
      : {
          repositoryRoot: activeContext.repositoryRoot,
          relativePath: activeContext.relativePath,
        };
  }

  private async resolveLineHistoryContext(
    argument: HistoryLineCommandArguments,
  ): Promise<HistoryLineContext | undefined> {
    if (!workspaceIsTrusted()) return undefined;
    const repositoryRoot =
      extractHistoryRepositoryRoot(argument) ??
      (await this.resolveRepositoryRootForActiveEditor());
    if (repositoryRoot === undefined) return undefined;
    if (
      extractHistoryRepositoryRoot(argument) !== undefined &&
      !(await this.isRepositoryRootAuthorized(repositoryRoot, undefined))
    )
      return undefined;
    try {
      const lineNumber = argument.lineNumber;
      assertPositiveLineNumber(lineNumber);
      return {
        repositoryRoot,
        relativePath: normalizeRelativePath(argument.filePath),
        lineNumber,
      };
    } catch {
      return undefined;
    }
  }

  private async resolveRevisionContext(
    argument: unknown,
  ): Promise<HistoryRevisionContext | undefined> {
    if (!workspaceIsTrusted()) return undefined;
    if (isHistoryRevisionCommandArguments(argument)) {
      const explicitRoot = extractHistoryRepositoryRoot(argument);
      const repositoryRoot =
        explicitRoot ?? (await this.resolveRepositoryRootForActiveEditor());
      if (repositoryRoot === undefined) return undefined;
      if (
        explicitRoot !== undefined &&
        !(await this.isRepositoryRootAuthorized(explicitRoot, undefined))
      )
        return undefined;
      try {
        historyRepositoryPath(repositoryRoot);
      } catch {
        return undefined;
      }
      let relativePath: string;
      try {
        relativePath = normalizeRelativePath(argument.filePath);
      } catch {
        return undefined;
      }
      return {
        repositoryRoot,
        relativePath,
        revisionSha: argument.revisionSha,
        ...(argument.parentSha === undefined
          ? {}
          : { parentSha: argument.parentSha }),
      };
    }
    const activeContext = await this.resolveCurrentDocumentContext();
    const blameLine = this.activeBlame;
    if (activeContext === undefined || blameLine === undefined) {
      await vscode.window.showInformationMessage(
        "Place the cursor on a blamed line first.",
      );
      return undefined;
    }
    return {
      repositoryRoot: activeContext.repositoryRoot,
      relativePath: activeContext.relativePath,
      revisionSha: blameLine.commitSha,
    };
  }

  private async resolveBlameContext(
    document: vscode.TextDocument,
    editor?: vscode.TextEditor,
    requestedLineNumber?: number,
  ): Promise<HistoryBlameContext | undefined> {
    if (!workspaceIsTrusted() || document.uri.scheme !== "file")
      return undefined;
    const repositoryRoot = await this.resolveRepositoryRoot(document.uri);
    if (repositoryRoot === undefined) return undefined;
    let relativePath: string | undefined;
    try {
      relativePath = relativeDocumentPath(repositoryRoot, document.uri);
    } catch {
      return undefined;
    }
    if (relativePath === undefined) return undefined;
    const lineNumber =
      requestedLineNumber ?? (editor?.selection.active.line ?? 0) + 1;
    if (
      !Number.isInteger(lineNumber) ||
      lineNumber < 1 ||
      lineNumber > document.lineCount
    )
      return undefined;
    return {
      repositoryRoot,
      relativePath,
      lineNumber,
      document,
      ...(editor === undefined ? {} : { editor }),
    };
  }

  private async resolveRepositoryRootForActiveEditor(): Promise<
    HistoryRepositoryRoot | undefined
  > {
    const documentUri = vscode.window.activeTextEditor?.document.uri;
    return documentUri === undefined
      ? undefined
      : this.resolveRepositoryRoot(documentUri);
  }

  private async isRepositoryRootAuthorized(
    repositoryRoot: HistoryRepositoryRoot,
    documentUri: vscode.Uri | undefined,
  ): Promise<boolean> {
    if (!workspaceIsTrusted()) return false;
    if (documentUri !== undefined && documentUri.scheme !== "file")
      return false;
    try {
      if (
        this.dependencies.repositoryProvider.isRepositoryRootAuthorized !==
        undefined
      ) {
        return await this.dependencies.repositoryProvider.isRepositoryRootAuthorized(
          repositoryRoot,
          documentUri,
        );
      }
      if (documentUri === undefined) return false;
      const discoveredRoot = await this.resolveRepositoryRoot(documentUri);
      return (
        discoveredRoot !== undefined &&
        historyRepositoryPath(discoveredRoot) ===
          historyRepositoryPath(repositoryRoot)
      );
    } catch {
      return false;
    }
  }

  private async resolveRepositoryRoot(
    documentUri: vscode.Uri,
  ): Promise<HistoryRepositoryRoot | undefined> {
    try {
      return await this.dependencies.repositoryProvider.resolveRepositoryRoot({
        documentUri,
        ...(vscode.window.activeTextEditor?.document.uri.toString() ===
        documentUri.toString()
          ? { activeEditorUri: documentUri }
          : {}),
      });
    } catch (error: unknown) {
      if (!isAbortError(error)) return undefined;
      return undefined;
    }
  }

  private canReadHistory(document: vscode.TextDocument): boolean {
    if (!workspaceIsTrusted() || document.uri.scheme !== "file") return false;
    try {
      if (document.lineCount > 100_000) return false;
      const text = document.getText();
      return (
        text.length * 2 <= this.settings.maxFileSizeBytes &&
        !text.includes(binaryProbeNul)
      );
    } catch {
      return false;
    }
  }

  private async loadFileHistory(
    repositoryRoot: HistoryRepositoryRoot,
    relativePath: string,
    cancellationSignal: AbortSignal,
  ): Promise<readonly FileHistoryEntry[]> {
    const cacheKey = makeHistoryCacheKey(repositoryRoot, "file", relativePath);
    const cachedHistory = this.getCached<readonly FileHistoryEntry[]>(cacheKey);
    if (cachedHistory !== undefined) return cachedHistory;
    const historyPage = await this.dependencies.historyService.listFileHistory(
      repositoryRoot,
      relativePath,
      { maxEntries: historyQuickPickLimit, cancellationSignal },
    );
    if (cancellationSignal.aborted)
      throw new DOMException("History operation cancelled", "AbortError");
    this.setCached(cacheKey, historyPage.entries);
    return historyPage.entries;
  }

  private beginOperation(): AbortController {
    this.cancelActiveOperation();
    const operation = new AbortController();
    this.activeOperation = operation;
    return operation;
  }

  private beginProviderOperation(token: vscode.CancellationToken): {
    readonly signal: AbortSignal;
    dispose(): void;
  } {
    const operation = createAbortController(token);
    this.providerOperations.add(operation);
    return {
      signal: operation.signal,
      dispose: () => {
        operation.dispose();
        this.providerOperations.delete(operation);
      },
    };
  }

  private finishOperation(operation: AbortController): void {
    if (this.activeOperation === operation) this.activeOperation = undefined;
  }

  private isHistoryOperationLocallyCurrent(
    operation: { readonly signal: AbortSignal },
    operationGeneration: number,
  ): boolean {
    return (
      !this.disposed &&
      !operation.signal.aborted &&
      this.generation === operationGeneration
    );
  }

  private isHistoryOperationGenerationCurrent(
    operationGeneration: number,
  ): boolean {
    return !this.disposed && this.generation === operationGeneration;
  }

  private cancelActiveOperation(): void {
    this.activeOperation?.abort();
    this.activeOperation = undefined;
  }

  private scheduleSelectionRefresh(editor: vscode.TextEditor): void {
    this.selectionRefreshTimer = setTimeout(() => {
      this.selectionRefreshTimer = undefined;
      if (this.disposed || this.activeEditor !== editor) return;
      void this.refreshActiveEditor();
    }, selectionRefreshDebounceMilliseconds);
  }

  private cancelScheduledSelectionRefresh(): void {
    if (this.selectionRefreshTimer === undefined) return;
    clearTimeout(this.selectionRefreshTimer);
    this.selectionRefreshTimer = undefined;
  }

  private invalidateCacheForDocument(): void {
    this.cache.clear();
    this.cancelActiveOperation();
    this.cancelScheduledSelectionRefresh();
    this.generation += 1;
    this.activeBlame = undefined;
    this.clearPresentation(this.activeEditor);
  }

  private getCached<T>(key: string): T | undefined {
    const record = this.cache.get(key);
    if (record === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, record);
    return (record.data as HistoryCacheValue<T>).value;
  }

  private setCached<T>(key: string, value: T): void {
    this.cache.delete(key);
    this.cache.set(key, {
      key,
      data: { value } satisfies HistoryCacheValue<T>,
    });
    while (this.cache.size > this.settings.cacheEntryLimit) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  private toggleBlame(): void {
    const nextBlameEnabled = !this.settings.blameEnabled;
    this.settings = {
      ...this.settings,
      enabled: true,
      blameEnabled: nextBlameEnabled,
    };
    this.clearPresentation(this.activeEditor ?? vscode.window.activeTextEditor);
    if (nextBlameEnabled) void this.refreshActiveEditor();
  }
}

export function createHistoryCommandUri(
  commandIdentifier: string,
  commandArguments: readonly unknown[] = [],
): vscode.Uri {
  return vscode.Uri.parse(
    `command:${commandIdentifier}?${encodeURIComponent(JSON.stringify(commandArguments))}`,
  );
}

export function createHistoryQueryChips(
  querySource: string,
): readonly HistoryQueryChip[] {
  return parseHistoryQueryTerms(querySource).map((term) => ({
    ...term,
    label: `${term.field}:${term.value}`,
  }));
}

export function parseHistoryQueryTerms(
  querySource: string,
): HistoryQuery["terms"] {
  const terms: Array<HistoryQuery["terms"][number]> = [];
  for (const token of tokenizeQuery(querySource)) {
    const separatorIndex = token.indexOf(":");
    const rawField =
      separatorIndex < 0 ? "message" : token.slice(0, separatorIndex);
    const rawValue =
      separatorIndex < 0 ? token : token.slice(separatorIndex + 1);
    const field = normalizeQueryField(rawField);
    const normalizedValue = rawValue.replace(/^"(.*)"$/s, "$1");
    if (field === undefined || normalizedValue.length === 0) continue;
    terms.push({ field, value: normalizedValue });
  }
  return terms;
}

function readDefaultSettingsFromWorkspace(): Partial<HistoryExperienceSettings> {
  try {
    const configuration = vscode.workspace.getConfiguration("gito");
    return {
      enabled: configuration.get<boolean>(
        historyExperienceSettingKeys.enabled,
        false,
      ),
      blameEnabled: configuration.get<boolean>(
        historyExperienceSettingKeys.blameEnabled,
        false,
      ),
      codeLensEnabled: configuration.get<boolean>(
        historyExperienceSettingKeys.codeLensEnabled,
        false,
      ),
      maxFileSizeBytes: configuration.get<number>(
        historyExperienceSettingKeys.maxFileSizeBytes,
        defaultHistoryExperienceSettings.maxFileSizeBytes,
      ),
      cacheEntryLimit: configuration.get<number>(
        historyExperienceSettingKeys.cacheEntryLimit,
        defaultHistoryExperienceSettings.cacheEntryLimit,
      ),
    };
  } catch {
    return {};
  }
}

function normalizeSettings(
  configuredSettings: Partial<HistoryExperienceSettings>,
): HistoryExperienceSettings {
  const maxFileSizeBytes =
    configuredSettings.maxFileSizeBytes ??
    defaultHistoryExperienceSettings.maxFileSizeBytes;
  const cacheEntryLimit =
    configuredSettings.cacheEntryLimit ??
    defaultHistoryExperienceSettings.cacheEntryLimit;
  return {
    enabled:
      configuredSettings.enabled ?? defaultHistoryExperienceSettings.enabled,
    blameEnabled:
      configuredSettings.blameEnabled ??
      defaultHistoryExperienceSettings.blameEnabled,
    codeLensEnabled:
      configuredSettings.codeLensEnabled ??
      defaultHistoryExperienceSettings.codeLensEnabled,
    maxFileSizeBytes:
      Number.isFinite(maxFileSizeBytes) && maxFileSizeBytes > 0
        ? Math.floor(maxFileSizeBytes)
        : defaultHistoryExperienceSettings.maxFileSizeBytes,
    cacheEntryLimit:
      Number.isFinite(cacheEntryLimit) && cacheEntryLimit > 0
        ? Math.floor(cacheEntryLimit)
        : defaultHistoryExperienceSettings.cacheEntryLimit,
  };
}

function workspaceIsTrusted(): boolean {
  return vscode.workspace.isTrusted === true;
}

function historyRepositoryPath(repositoryRoot: HistoryRepositoryRoot): string {
  const normalizedRepositoryRoot =
    normalizeHistoryRepositoryRoot(repositoryRoot);
  const repositoryPath =
    typeof normalizedRepositoryRoot === "string"
      ? normalizedRepositoryRoot
      : normalizedRepositoryRoot?.fsPath;
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    repositoryPath.includes("\0") ||
    (!nodePath.isAbsolute(repositoryPath) &&
      !nodePath.win32.isAbsolute(repositoryPath))
  ) {
    throw new Error("History repository root must be an absolute path.");
  }
  return nodePath.normalize(repositoryPath);
}

function relativeDocumentPath(
  repositoryRoot: HistoryRepositoryRoot,
  documentUri: vscode.Uri,
): string | undefined {
  if (documentUri.scheme !== "file") return undefined;
  const repositoryPath = historyRepositoryPath(repositoryRoot);
  const relativePath = nodePath.relative(repositoryPath, documentUri.fsPath);
  return relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    nodePath.isAbsolute(relativePath)
    ? undefined
    : normalizeRelativePath(relativePath);
}

function normalizeRelativePath(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (
    normalizedPath.length === 0 ||
    normalizedPath.includes("\0") ||
    normalizedPath.startsWith("/") ||
    nodePath.win32.isAbsolute(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    nodePath.posix.normalize(normalizedPath).startsWith("../")
  ) {
    throw new Error("History file path must stay inside the repository.");
  }
  const canonicalPath = nodePath.posix.normalize(normalizedPath);
  if (canonicalPath === ".") {
    throw new Error("History file path cannot be the repository root.");
  }
  return canonicalPath;
}

function makeHistoryCacheKey(
  repositoryRoot: HistoryRepositoryRoot,
  kind: string,
  ...parts: readonly string[]
): string {
  return `${historyRepositoryIdentity(repositoryRoot)}|${kind}|${parts.join("|")}`;
}

function historyRepositoryIdentity(
  repositoryRoot: HistoryRepositoryRoot,
): string {
  const normalizedRepositoryRoot =
    normalizeHistoryRepositoryRoot(repositoryRoot);
  if (typeof normalizedRepositoryRoot === "string")
    return `file:${historyRepositoryPath(normalizedRepositoryRoot)}`;
  if (normalizedRepositoryRoot === undefined)
    throw new Error("History repository root must be a valid URI.");
  const serializedUri = normalizedRepositoryRoot.toString();
  if (serializedUri.length > 0 && serializedUri !== "[object Object]")
    return serializedUri;
  return `${normalizedRepositoryRoot.scheme}://${normalizedRepositoryRoot.authority ?? ""}${normalizedRepositoryRoot.path}`;
}

function normalizeHistoryRepositoryRoot(
  repositoryRoot: unknown,
): HistoryRepositoryRoot | undefined {
  if (typeof repositoryRoot === "string") return repositoryRoot;
  if (typeof repositoryRoot !== "object" || repositoryRoot === null)
    return undefined;
  const candidate = repositoryRoot as {
    readonly authority?: unknown;
    readonly fragment?: unknown;
    readonly fsPath?: unknown;
    readonly path?: unknown;
    readonly query?: unknown;
    readonly scheme?: unknown;
    readonly toString?: unknown;
  };
  if (
    typeof candidate.fsPath === "string" &&
    typeof candidate.scheme === "string" &&
    typeof candidate.toString === "function" &&
    candidate.toString !== Object.prototype.toString
  )
    return repositoryRoot as vscode.Uri;
  if (
    typeof candidate.fsPath !== "string" &&
    typeof candidate.path !== "string"
  )
    return undefined;
  const scheme =
    typeof candidate.scheme === "string" ? candidate.scheme : "file";
  const path =
    typeof candidate.path === "string"
      ? candidate.path
      : typeof candidate.fsPath === "string"
        ? candidate.fsPath
        : undefined;
  if (path === undefined) return undefined;
  const authority =
    typeof candidate.authority === "string" ? candidate.authority : "";
  const query = typeof candidate.query === "string" ? candidate.query : "";
  const fragment =
    typeof candidate.fragment === "string" ? candidate.fragment : "";
  return vscode.Uri.from({ scheme, authority, path, query, fragment });
}

function formatBlameLabel(blameLine: BlameLine): string {
  return `${blameLine.authorName} · ${blameLine.authorDate} · ${blameLine.summary}`;
}

function createBlameMarkdown(
  blameLine: BlameLine,
  context: {
    readonly repositoryRoot: HistoryRepositoryRoot;
    readonly filePath: string;
    readonly lineNumber: number;
  },
): vscode.MarkdownString {
  const commitArguments = createBlameCommitArguments(context, blameLine);
  const lineArguments: HistoryLineCommandArguments = {
    repositoryRoot: context.repositoryRoot,
    filePath: context.filePath,
    lineNumber: context.lineNumber,
  };
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: [
      historyExperienceCommandIds.openCommit,
      historyExperienceCommandIds.openLineHistory,
      historyExperienceCommandIds.previousRevision,
      historyExperienceCommandIds.nextRevision,
    ],
  };
  markdown.appendMarkdown(`**${escapeMarkdown(blameLine.summary)}**\n\n`);
  markdown.appendMarkdown(
    `${escapeMarkdown(blameLine.authorName)} · ${escapeMarkdown(blameLine.authorDate)}\n\n`,
  );
  markdown.appendMarkdown(
    `Commit \`${blameLine.commitSha}\` · ${escapeMarkdown(blameLine.pathAtRevision)}:${blameLine.originalLineNumber}\n\n`,
  );
  markdown.appendMarkdown(
    `[Open commit](${createHistoryCommandUri(historyExperienceCommandIds.openCommit, [commitArguments]).toString()}) · `,
  );
  markdown.appendMarkdown(
    `[Line history](${createHistoryCommandUri(historyExperienceCommandIds.openLineHistory, [lineArguments]).toString()}) · `,
  );
  markdown.appendMarkdown(
    `[Previous revision](${createHistoryCommandUri(historyExperienceCommandIds.previousRevision, [commitArgumentsForRevision(context, blameLine.commitSha, blameLine.pathAtRevision)]).toString()}) · `,
  );
  markdown.appendMarkdown(
    `[Next revision](${createHistoryCommandUri(historyExperienceCommandIds.nextRevision, [commitArgumentsForRevision(context, blameLine.commitSha, blameLine.pathAtRevision)]).toString()})`,
  );
  return markdown;
}

function createBlameCommitArguments(
  context: {
    readonly repositoryRoot: HistoryRepositoryRoot;
    readonly filePath: string;
  },
  blameLine: BlameLine,
): HistoryCommitCommandArguments {
  return {
    repositoryRoot: context.repositoryRoot,
    commit: {
      sha: blameLine.commitSha,
      shortSha: blameLine.commitSha.slice(0, 7),
      subject: blameLine.summary,
      authorName: blameLine.authorName,
      authorEmail: blameLine.authorEmail,
      authorDate: blameLine.authorDate,
      committerDate: blameLine.authorDate,
      parentShas: [],
      changedFiles: [],
    },
    filePath: context.filePath,
    revisionFilePath: blameLine.pathAtRevision,
  };
}

function commitArgumentsForRevision(
  context: {
    readonly repositoryRoot: HistoryRepositoryRoot;
    readonly filePath: string;
  },
  revisionSha: string,
  revisionFilePath: string,
): HistoryRevisionCommandArguments {
  return {
    repositoryRoot: context.repositoryRoot,
    revisionSha,
    filePath: revisionFilePath,
  };
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_{}()#+\-!|<>~]/gu, "\\$&")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function createFileHistoryItem(
  entry: FileHistoryEntry,
  filePath: string,
): HistoryQuickPickItem {
  const pathLabel =
    entry.previousPath === undefined
      ? entry.path
      : `${entry.previousPath} → ${entry.path}`;
  return {
    label: `${entry.shortSha} · ${entry.subject}`,
    description: `${entry.authorName} · ${entry.authorDate}`,
    detail: pathLabel,
    commit: entry,
    fileHistoryEntry: entry,
    iconPath: new vscode.ThemeIcon("git-commit"),
    buttons: [
      {
        iconPath: new vscode.ThemeIcon("go-to-file"),
        tooltip: `Open ${filePath}`,
      },
    ],
  };
}

function createContributorsHistoryItem(): HistoryQuickPickItem {
  return {
    label: "Show repository contributors",
    description: "Browse authors across this repository",
    action: "openContributors",
    iconPath: new vscode.ThemeIcon("organization"),
  };
}

function createLineHistoryItem(entry: LineHistoryEntry): HistoryQuickPickItem {
  return {
    label: `${entry.shortSha} · ${entry.subject}`,
    description: `${entry.authorName} · ${entry.authorDate}`,
    detail: `Line ${entry.lineNumber}`,
    commit: entry,
    lineHistoryEntry: entry,
    iconPath: new vscode.ThemeIcon("git-commit"),
  };
}

function createCommitItem(commit: HistoryCommit): HistoryQuickPickItem {
  return {
    label: `${commit.shortSha} · ${commit.subject}`,
    description: `${commit.authorName} · ${commit.authorDate}`,
    detail: commit.changedFiles.map(formatChangedFile).join(" · "),
    commit,
    iconPath: new vscode.ThemeIcon("git-commit"),
  };
}

function formatChangedFile(change: HistoryFileChange): string {
  return change.previousPath === undefined
    ? change.path
    : `${change.previousPath} → ${change.path}`;
}

function firstChangedPath(commit: HistoryCommit): string | undefined {
  return commit.changedFiles[0]?.path;
}

function createRevisionUri(resource: {
  readonly repositoryRoot: string;
  readonly repositoryRootIdentity: string;
  readonly revisionSha: string;
  readonly relativePath: string;
}): vscode.Uri {
  const repositoryUri = vscode.Uri.parse(resource.repositoryRootIdentity);
  const absolutePath = nodePath.join(
    resource.repositoryRoot,
    resource.relativePath,
  );
  const query = JSON.stringify({
    path: absolutePath,
    ref: resource.revisionSha,
    repositoryRoot: resource.repositoryRootIdentity,
  });
  return repositoryUri.with({
    scheme: "git",
    path: absolutePath,
    query,
  });
}

function isHistoryCommitCommandArguments(
  argument: unknown,
): argument is HistoryCommitCommandArguments {
  if (typeof argument !== "object" || argument === null) return false;
  const candidate = argument as Partial<HistoryCommitCommandArguments>;
  return (
    typeof candidate.commit === "object" &&
    candidate.commit !== null &&
    typeof candidate.commit.sha === "string"
  );
}

function extractHistoryRepositoryRoot(
  argument: unknown,
): HistoryRepositoryRoot | undefined {
  if (typeof argument !== "object" || argument === null) return undefined;
  const candidate = argument as { readonly repositoryRoot?: unknown };
  return normalizeHistoryRepositoryRoot(candidate.repositoryRoot);
}

function extractHistoryFilePath(argument: unknown): string | undefined {
  if (typeof argument !== "object" || argument === null) return undefined;
  const candidate = argument as Partial<HistoryFileCommandArguments>;
  return typeof candidate.filePath === "string"
    ? candidate.filePath
    : undefined;
}

function isHistoryRevisionCommandArguments(
  argument: unknown,
): argument is HistoryRevisionCommandArguments {
  if (typeof argument !== "object" || argument === null) return false;
  const candidate = argument as Partial<HistoryRevisionCommandArguments>;
  return (
    typeof candidate.revisionSha === "string" &&
    typeof candidate.filePath === "string"
  );
}

function isHistoryLineCommandArguments(
  argument: unknown,
): argument is HistoryLineCommandArguments {
  if (typeof argument !== "object" || argument === null) return false;
  const candidate = argument as Partial<HistoryLineCommandArguments>;
  return (
    typeof candidate.filePath === "string" &&
    typeof candidate.lineNumber === "number"
  );
}

function assertPositiveLineNumber(lineNumber: number): void {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new RangeError("Line number must be a positive integer.");
  }
}

function createAbortController(token: vscode.CancellationToken): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      subscription.dispose();
      controller.abort();
    },
  };
}

function showHistoryError(error: unknown): Promise<string | undefined> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message =
    error instanceof Error && error.name === "GitCommandFailure"
      ? "Git history command failed."
      : redactGitErrorMessage(rawMessage);
  return Promise.resolve(
    vscode.window.showErrorMessage(`Git'o history: ${message}`),
  );
}

function tokenizeQuery(querySource: string): readonly string[] {
  const tokens: string[] = [];
  const tokenPattern = /(?:[^\s"]|"[^"]*")+/g;
  for (const match of querySource.matchAll(tokenPattern)) {
    const token = match[0];
    if (token !== undefined) tokens.push(token.replace(/^"|"$/g, ""));
  }
  return tokens;
}

function normalizeQueryField(
  field: string,
): HistoryQuery["terms"][number]["field"] | undefined {
  switch (field.toLowerCase()) {
    case "message":
    case "msg":
    case "subject":
      return "message";
    case "author":
    case "by":
      return "author";
    case "sha":
    case "commit":
      return "sha";
    case "file":
    case "path":
      return "file";
    case "patch":
    case "diff":
      return "patch";
    default:
      return undefined;
  }
}

async function promptForHistoryQuery(): Promise<string | undefined> {
  const quickPick = vscode.window.createQuickPick<HistorySearchQuickPickItem>();
  quickPick.title = "Search history";
  quickPick.placeholder = "message:fix author:Ada file:src/app.ts";
  quickPick.matchOnDescription = true;
  const updateItems = (querySource: string): void => {
    const chips = createHistoryQueryChips(querySource);
    quickPick.items =
      chips.length === 0
        ? [
            {
              label: "Type a field:value chip",
              detail: "message · author · sha · file · patch",
              queryAction: "search",
            },
          ]
        : chips.map((chip) => ({
            label: `$(symbol-key) ${chip.label}`,
            description: "Query chip",
            chip,
          }));
  };
  updateItems("");
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      changeSubscription.dispose();
      acceptSubscription.dispose();
      hideSubscription.dispose();
      quickPick.dispose();
      resolve(value);
    };
    const changeSubscription = quickPick.onDidChangeValue(updateItems);
    const acceptSubscription = quickPick.onDidAccept(() =>
      finish(quickPick.value),
    );
    const hideSubscription = quickPick.onDidHide(() => finish(undefined));
    quickPick.show();
  });
}
