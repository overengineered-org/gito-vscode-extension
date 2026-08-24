import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  createRevisionSource,
  type DiffSymlinkUriProvider,
  type GitDiffRepositoryBinding,
  GitDiffService,
  type DiffFileOnlyPlan,
  type DiffPlan,
  type DiffRepositoryPlan,
  type DiffRepositorySource,
} from "../diff/index.js";
import {
  isAbortError,
  type GitCommandRunner,
} from "../git/gitCommandRunner.js";
import {
  isUriWithinRepository,
  type RepositoryDiscovery,
} from "../repositories/repositoryDiscovery.js";
import {
  createDiffFileOpenPlan,
  createDiffNavigationOpenPlan,
  createDiffRepositoryOpenPlan,
  createRecentDiffComparison,
  defaultDiffExperienceOptions,
  describeSelection,
  findNavigationTargetEntry,
  optionsForDiffPreset,
} from "./diffExperiencePlans.js";
import {
  diffExperienceCommandIds,
  diffExperiencePresetLabels,
  diffExperienceStorageKey,
  type DiffExperienceOptions,
  type DiffExperiencePreset,
  type DiffExperienceSelection,
  type DiffExperienceSession,
  type DiffExperienceView,
  type DiffNavigationDirection,
  type DiffNavigationUnit,
  type RecentDiffComparison,
} from "./diffExperienceModels.js";
import { pickDiffSource } from "./diffSourcePicker.js";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";
import type {
  DeveloperDiagnosticEventName,
  DeveloperDiagnostics,
} from "../diagnostics/developerDiagnostics.js";

export interface DiffExperienceCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}

export interface DiffExperienceServices {
  readonly repositoryDiscovery: Pick<RepositoryDiscovery, "selectRepository">;
  readonly gitCommandRunner: Pick<GitCommandRunner, "run">;
  readonly gitDiffService: GitDiffService;
  readonly symlinkUriProvider: DiffSymlinkUriProvider;
  readonly workspaceState: vscode.Memento;
  readonly developerDiagnostics?: Pick<
    DeveloperDiagnostics,
    "record" | "traceOperation"
  >;
  readonly commandExecutor: {
    executeCommand(
      commandIdentifier: string,
      ...argumentsPassed: readonly unknown[]
    ): Promise<unknown>;
  };
}

export interface DiffExperienceCommandArgument {
  readonly repositoryRoot?: vscode.Uri;
  readonly resourceUri?: vscode.Uri;
  readonly filePath?: string;
  readonly from?: DiffRepositorySource;
  readonly to?: DiffRepositorySource;
}

interface DiffViewPickItem extends vscode.QuickPickItem {
  readonly view: DiffExperienceView;
}

interface DiffPresetPickItem extends vscode.QuickPickItem {
  readonly preset: DiffExperiencePreset;
}

export class DiffExperience {
  private readonly commandExecutor: DiffExperienceServices["commandExecutor"];
  private currentSession: DiffExperienceSession | undefined;
  private disposed = false;
  private operationGeneration = 0;
  private activeAbortController: AbortController | undefined;
  private readonly contentProviderDisposables: readonly vscode.Disposable[];

  public constructor(private readonly services: DiffExperienceServices) {
    this.commandExecutor = services.commandExecutor;
    const contentProviderDisposables = [
      vscode.workspace.registerFileSystemProvider(
        "gito-empty",
        services.symlinkUriProvider,
        { isCaseSensitive: true, isReadonly: true },
      ),
      vscode.workspace.registerFileSystemProvider(
        "gito-symlink",
        services.symlinkUriProvider,
        { isCaseSensitive: true, isReadonly: true },
      ),
    ];
    this.contentProviderDisposables = contentProviderDisposables;
  }

  public registerCommands(
    commandRegistry: DiffExperienceCommandRegistry = vscode.commands,
  ): readonly vscode.Disposable[] {
    return [
      commandRegistry.registerCommand(diffExperienceCommandIds.open, () =>
        this.runSafely(() => this.openGuided()),
      ),
      commandRegistry.registerCommand(
        diffExperienceCommandIds.openSingleFile,
        (...argumentsPassed) =>
          this.runSafely(() =>
            this.openGuided("file", readCommandArgument(argumentsPassed[0])),
          ),
      ),
      commandRegistry.registerCommand(
        diffExperienceCommandIds.openRepository,
        (...argumentsPassed) =>
          this.runSafely(() =>
            this.openGuided(
              "repository",
              readCommandArgument(argumentsPassed[0]),
            ),
          ),
      ),
      commandRegistry.registerCommand(diffExperienceCommandIds.review, () =>
        this.runSafely(() => this.openPreset("review")),
      ),
      commandRegistry.registerCommand(diffExperienceCommandIds.whitespace, () =>
        this.runSafely(() => this.openPreset("whitespace")),
      ),
      commandRegistry.registerCommand(diffExperienceCommandIds.nextFile, () =>
        this.runSafely(() => this.navigate("next", "file")),
      ),
      commandRegistry.registerCommand(
        diffExperienceCommandIds.previousFile,
        () => this.runSafely(() => this.navigate("previous", "file")),
      ),
      commandRegistry.registerCommand(diffExperienceCommandIds.nextChange, () =>
        this.runSafely(() => this.navigate("next", "change")),
      ),
      commandRegistry.registerCommand(
        diffExperienceCommandIds.previousChange,
        () => this.runSafely(() => this.navigate("previous", "change")),
      ),
      commandRegistry.registerCommand(diffExperienceCommandIds.swapSides, () =>
        this.runSafely(() => this.swapSides()),
      ),
      commandRegistry.registerCommand(diffExperienceCommandIds.reopen, () =>
        this.runSafely(() => this.reopen()),
      ),
      commandRegistry.registerCommand(
        diffExperienceCommandIds.changeOptions,
        () => this.runSafely(() => this.changeOptions()),
      ),
    ];
  }

  public dispose(): void {
    this.disposed = true;
    this.operationGeneration += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;
    this.currentSession = undefined;
    for (const contentProviderDisposable of this.contentProviderDisposables)
      contentProviderDisposable.dispose();
    this.services.symlinkUriProvider.dispose();
    void this.clearSessionContext();
  }

  public getSession(): DiffExperienceSession | undefined {
    return this.currentSession;
  }

  private async openGuided(
    forcedView?: DiffExperienceView,
    commandArgument?: DiffExperienceCommandArgument,
  ): Promise<void> {
    this.recordDiagnostic("diff.command.started");
    const repository = await this.selectRepository(commandArgument);
    if (this.disposed) return;
    const repositoryBinding = await this.traceDiagnostic(
      "diff.repository.binding",
      () =>
        this.services.gitDiffService.createRepositoryBinding(
          repository.rootUri,
        ),
    );
    const from =
      commandArgument?.from ??
      (await pickDiffSource(this.services, {
        repositoryRoot: repository.rootUri,
        repositoryBinding,
        prompt: "Choose the source",
        placeHolder: "Source: Working Tree, Staged, HEAD, or a revision",
      }));
    if (this.disposed) return;
    if (from === undefined) return;
    const to =
      commandArgument?.to ??
      (await pickDiffSource(this.services, {
        repositoryRoot: repository.rootUri,
        repositoryBinding,
        prompt: "Choose the target",
        placeHolder: "Target: Working Tree, Staged, HEAD, or a revision",
      }));
    if (this.disposed) return;
    if (to === undefined) return;
    const view = forcedView ?? (await pickDiffView());
    if (this.disposed) return;
    if (view === undefined) return;
    const filePath =
      view === "file"
        ? readRelativeFilePath(
            commandArgument?.filePath,
            commandArgument?.resourceUri,
            repository.rootUri,
          )
        : undefined;
    if (view === "file" && filePath === undefined) {
      throw new Error("Select a file inside the selected Git repository.");
    }
    await this.openSelection(
      {
        repositoryRoot: repository.rootUri,
        from,
        to,
        view,
        options: this.configuredOptions("review"),
        ...(filePath === undefined ? {} : { filePath }),
      },
      repositoryBinding,
    );
    this.recordDiagnostic("diff.command.completed");
  }

  private async openPreset(preset: DiffExperiencePreset): Promise<void> {
    this.recordDiagnostic("diff.command.started");
    const repository = await this.selectRepository();
    if (this.disposed) return;
    await this.openSelection({
      repositoryRoot: repository.rootUri,
      from: createRevisionSource(repository.rootUri, "HEAD"),
      to: { kind: "working-tree", repositoryRoot: repository.rootUri },
      view: "repository",
      options: this.configuredOptions(preset),
    });
    this.recordDiagnostic("diff.command.completed");
  }

  private async openSelection(
    selection: DiffExperienceSelection,
    expectedRepositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<void> {
    const preparedOpenPlan = await this.withDiffProgress(
      `Preparing ${describeSelection(selection)}`,
      async (signal, operationGeneration) => {
        this.recordDiagnostic("diff.progress.entered");
        this.clearSessionContext(operationGeneration);
        this.assertOperationActive(operationGeneration, signal);
        let openPlanPrepared = false;
        try {
          const repositoryBinding =
            expectedRepositoryBinding ??
            (await this.traceDiagnostic("diff.repository.binding", () =>
              this.services.gitDiffService.createRepositoryBinding(
                selection.repositoryRoot,
                signal,
              ),
            ));
          const initialHeadRevision = await this.captureRepositoryHead(
            selection.repositoryRoot,
            signal,
            repositoryBinding,
          );
          this.assertOperationActive(operationGeneration, signal);
          this.services.symlinkUriProvider.beginSession();
          const initialMutableStateFingerprint =
            await this.services.gitDiffService.getMutableStateFingerprint(
              selection.repositoryRoot,
              signal,
              repositoryBinding,
            );
          this.assertOperationActive(operationGeneration, signal);
          const plan = await this.traceDiagnostic("diff.plan.creation", () =>
            this.createPlan(selection, signal, repositoryBinding),
          );
          this.assertOperationActive(operationGeneration, signal);
          await this.assertRepositoryHeadUnchanged(
            selection.repositoryRoot,
            initialHeadRevision,
            signal,
            repositoryBinding,
          );
          this.assertOperationActive(operationGeneration, signal);
          const mutableStateFingerprint =
            await this.services.gitDiffService.getMutableStateFingerprint(
              selection.repositoryRoot,
              signal,
              repositoryBinding,
            );
          this.assertOperationActive(operationGeneration, signal);
          if (mutableStateFingerprint !== initialMutableStateFingerprint) {
            await vscode.window.showWarningMessage(
              "The repository changed while preparing this diff. Reopen to refresh it.",
            );
            return;
          }
          if (plan === undefined) {
            this.assertOperationActive(operationGeneration, signal);
            await vscode.window.showInformationMessage(
              `No changes found for ${describeSelection(selection)}.`,
            );
            return;
          }
          const repositoryPlan =
            plan.kind === "file" ? createRepositoryPlanFromFile(plan) : plan;
          if (repositoryPlan.files.length === 0) {
            this.assertOperationActive(operationGeneration, signal);
            await vscode.window.showInformationMessage(
              `No changes found for ${describeSelection(selection)}.`,
            );
            return;
          }
          const session: DiffExperienceSession = {
            selection,
            plan: repositoryPlan,
            repositoryBinding,
            mutableStateFingerprint,
            activeFileIndex: 0,
            ...(repositoryPlan.navigation.entries[0] === undefined
              ? {}
              : {
                  activeChangeEntryId: repositoryPlan.navigation.entries[0].id,
                }),
            swapped: false,
          };
          const openPlan =
            plan.kind === "file"
              ? createDiffFileOpenPlan(
                  plan,
                  `${plan.displayPath} — ${describeSelection(selection)}`,
                )
              : createDiffRepositoryOpenPlan(
                  plan,
                  `${describeSelection(selection)} · ${selection.options.preset}`,
                );
          const latestMutableStateFingerprint =
            await this.services.gitDiffService.getMutableStateFingerprint(
              selection.repositoryRoot,
              signal,
              repositoryBinding,
            );
          this.assertOperationActive(operationGeneration, signal);
          if (latestMutableStateFingerprint !== mutableStateFingerprint) {
            await vscode.window.showWarningMessage(
              "The repository changed while opening this diff. Reopen to refresh it.",
            );
            return;
          }
          this.recordDiagnostic("diff.repository.validated");
          openPlanPrepared = true;
          return {
            openPlan,
            operationGeneration,
            repositoryFiles: repositoryPlan.files,
            selection,
            session,
          };
        } finally {
          if (!openPlanPrepared) this.clearSessionContext(operationGeneration);
        }
      },
    );
    if (preparedOpenPlan === undefined) return;
    this.recordDiagnostic("diff.editor.dispatching");
    const opened = await this.executeOpenPlan(
      preparedOpenPlan.openPlan,
      preparedOpenPlan.operationGeneration,
    );
    if (!opened || this.disposed) return;
    if (preparedOpenPlan.operationGeneration !== this.operationGeneration)
      return;
    this.currentSession = preparedOpenPlan.session;
    this.setSessionContext(true);
    this.recordDiagnostic("diff.session.context-dispatched");
    this.recordDiagnostic("diff.editor.dispatched");
    void this.rememberComparison(preparedOpenPlan.selection).catch(
      () => undefined,
    );
    void this.showSpecialFileMessages(preparedOpenPlan.repositoryFiles).catch(
      () => undefined,
    );
  }

  private async createPlan(
    selection: DiffExperienceSelection,
    cancellationSignal: AbortSignal,
    repositoryBinding: GitDiffRepositoryBinding,
  ): Promise<DiffPlan | undefined> {
    const request = {
      repositoryRoot: selection.repositoryRoot,
      from: selection.from,
      to: selection.to,
      options: selection.options,
      cancellationSignal,
      ...(selection.filePath === undefined
        ? {}
        : { filePath: selection.filePath }),
    };
    return this.services.gitDiffService.createDiffPlan(
      request,
      repositoryBinding,
    );
  }

  private async navigate(
    direction: DiffNavigationDirection,
    unit: DiffNavigationUnit,
  ): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) {
      await vscode.window.showInformationMessage("Open a Git'o diff first.");
      return;
    }
    if (!(await this.isSessionFresh(session))) return;
    const openPlan = createDiffNavigationOpenPlan(session, direction, unit);
    if (openPlan === undefined) {
      await vscode.window.showInformationMessage(
        direction === "next"
          ? `Already at the last ${unit}.`
          : `Already at the first ${unit}.`,
      );
      return;
    }
    const targetEntry = findNavigationTargetEntry(session, direction, unit);
    const targetIndex = targetEntry?.fileIndex;
    if (targetIndex === undefined || targetEntry === undefined) return;
    const targetFile = session.plan.files[targetIndex];
    if (targetFile === undefined) return;
    const nextEntryId = targetEntry.id;
    try {
      const opened = await this.executeOpenPlan(openPlan);
      if (!opened || this.currentSession !== session) return;
      this.currentSession = {
        ...session,
        activeFileIndex: targetIndex,
        ...(nextEntryId === undefined
          ? {}
          : { activeChangeEntryId: nextEntryId }),
      };
    } catch (error: unknown) {
      this.clearSessionContext();
      throw error;
    }
  }

  private async swapSides(): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) {
      await vscode.window.showInformationMessage("Open a Git'o diff first.");
      return;
    }
    if (!(await this.isSessionFresh(session))) return;
    const nextSwapped = !session.swapped;
    const openPlan =
      session.selection.view === "file"
        ? createDiffFileOpenPlan(
            session.plan.files[session.activeFileIndex] as DiffFileOnlyPlan,
            `${describeSelection(session.selection)} · swapped`,
            nextSwapped,
          )
        : createDiffRepositoryOpenPlan(
            session.plan,
            `${describeSelection(session.selection)} · swapped`,
            nextSwapped,
          );
    try {
      const opened = await this.executeOpenPlan(openPlan);
      if (!opened || this.currentSession !== session) return;
      this.currentSession = { ...session, swapped: nextSwapped };
    } catch (error: unknown) {
      this.clearSessionContext();
      throw error;
    }
  }

  private async reopen(): Promise<void> {
    const session = this.currentSession;
    if (session !== undefined) {
      await this.executeSessionOpenPlan(session);
      return;
    }
    const recentComparison = await this.pickRecentComparison();
    if (this.disposed) return;
    if (recentComparison === undefined) return;
    const selection = await this.restoreRecentComparison(recentComparison);
    if (this.disposed) return;
    if (selection !== undefined) await this.openSelection(selection);
  }

  private async changeOptions(): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) {
      await vscode.window.showInformationMessage("Open a Git'o diff first.");
      return;
    }
    const selectedPreset = await vscode.window.showQuickPick(
      createPresetQuickPickItems(),
      { placeHolder: "Change diff options" },
    );
    if (selectedPreset === undefined) return;
    await this.openSelection({
      ...session.selection,
      options: this.configuredOptions(selectedPreset.preset),
    });
  }

  private async executeSessionOpenPlan(
    session: DiffExperienceSession,
  ): Promise<void> {
    if (!(await this.isSessionFresh(session))) return;
    const targetFile = session.plan.files[session.activeFileIndex];
    if (targetFile === undefined) return;
    const openPlan =
      session.selection.view === "file"
        ? createDiffFileOpenPlan(
            {
              ...targetFile,
              kind: "file",
              from: session.plan.from,
              to: session.plan.to,
            },
            `${targetFile.displayPath} — ${describeSelection(session.selection)}`,
            session.swapped,
          )
        : createDiffRepositoryOpenPlan(
            session.plan,
            `${describeSelection(session.selection)} · ${session.selection.options.preset}`,
            session.swapped,
          );
    try {
      await this.executeOpenPlan(openPlan);
    } catch (error: unknown) {
      this.clearSessionContext();
      throw error;
    }
  }

  private async executeOpenPlan(
    openPlan: {
      readonly command: string;
      readonly arguments: readonly unknown[];
    },
    operationGeneration?: number,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.isOperationActive(operationGeneration, cancellationSignal))
      return false;
    let commandRejected = false;
    let commandRejection: unknown;
    let editorDispatchAccepted = false;
    try {
      const commandCompletion = this.commandExecutor.executeCommand(
        openPlan.command,
        ...openPlan.arguments,
      );
      void commandCompletion.catch((error: unknown) => {
        commandRejected = true;
        commandRejection = error;
        if (!editorDispatchAccepted) return;
        void this.handleNativeEditorOpenFailure(
          error,
          operationGeneration,
          cancellationSignal,
          openPlan,
        ).catch(() => undefined);
      });
      // Native editor commands may remain pending for the lifetime of their
      // tab. Yield once to catch immediate rejection, then treat invocation as
      // dispatch; installed-host tests prove the resulting native tab/content.
      await Promise.resolve();
      if (commandRejected) {
        return this.handleNativeEditorOpenFailure(
          commandRejection,
          operationGeneration,
          cancellationSignal,
          openPlan,
        );
      }
      editorDispatchAccepted = true;
      return true;
    } catch (error: unknown) {
      return this.handleNativeEditorOpenFailure(
        error,
        operationGeneration,
        cancellationSignal,
        openPlan,
      );
    }
  }

  private async handleNativeEditorOpenFailure(
    error: unknown,
    operationGeneration?: number,
    cancellationSignal?: AbortSignal,
    openPlan?: {
      readonly command: string;
      readonly arguments: readonly unknown[];
    },
  ): Promise<boolean> {
    if (!this.isOperationActive(operationGeneration, cancellationSignal))
      return false;
    if (openPlan?.command === "vscode.changes") {
      try {
        if (
          await this.executeChangesFallback(
            openPlan.arguments,
            operationGeneration,
            cancellationSignal,
          )
        ) {
          return true;
        }
      } catch (fallbackError: unknown) {
        error = fallbackError;
      }
    }
    if (!this.isOperationActive(operationGeneration, cancellationSignal))
      return false;
    this.recordDiagnostic("diff.editor.failed");
    this.clearSessionContext(operationGeneration);
    const message = formatGitErrorForUser(
      error,
      "Git'o could not open that diff.",
    );
    await vscode.window.showErrorMessage(message);
    return false;
  }

  private async executeChangesFallback(
    commandArguments: readonly unknown[],
    operationGeneration?: number,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    const changeEntries = commandArguments[1];
    if (!Array.isArray(changeEntries)) return false;
    for (const changeEntry of changeEntries) {
      if (!isUnknownArray(changeEntry)) return false;
      const [changeResourceUri, originalUri, modifiedUri] = changeEntry;
      if (!this.isOperationActive(operationGeneration, cancellationSignal)) {
        return false;
      }
      if (originalUri !== undefined && modifiedUri !== undefined) {
        await this.commandExecutor.executeCommand(
          "vscode.diff",
          originalUri,
          modifiedUri,
          `${typeof commandArguments[0] === "string" ? commandArguments[0] : "Git'o diff"} · ${readResourceDisplayPath(changeResourceUri)}`,
        );
      } else {
        await this.commandExecutor.executeCommand(
          "vscode.open",
          modifiedUri ?? originalUri ?? changeResourceUri,
        );
      }
    }
    return true;
  }

  private recordDiagnostic(eventName: DeveloperDiagnosticEventName): void {
    this.services.developerDiagnostics?.record(eventName);
  }

  private traceDiagnostic<OperationResult>(
    eventName: DeveloperDiagnosticEventName,
    operation: () => Promise<OperationResult>,
  ): Promise<OperationResult> {
    return (
      this.services.developerDiagnostics?.traceOperation(
        eventName,
        operation,
      ) ?? operation()
    );
  }

  private configuredOptions(
    preset: DiffExperiencePreset,
  ): DiffExperienceOptions {
    const configuration = vscode.workspace.getConfiguration("gito");
    const contextLines = configuration.get<number>(
      "diff.defaultContextLines",
      defaultDiffExperienceOptions.contextLines ?? 3,
    );
    const maxFiles = configuration.get<number>(
      "diff.maxFiles",
      defaultDiffExperienceOptions.maxFiles ?? 500,
    );
    return optionsForDiffPreset(
      preset,
      preset === "review" ? { contextLines, maxFiles } : { maxFiles },
    );
  }

  private setSessionContext(active: boolean): void {
    try {
      void this.commandExecutor
        .executeCommand("setContext", "gito.diff.sessionActive", active)
        .catch(() => undefined);
    } catch {
      // Context keys are menu affordances; local session state remains authoritative.
    }
  }

  private clearSessionContext(expectedOperationGeneration?: number): void {
    if (
      expectedOperationGeneration !== undefined &&
      expectedOperationGeneration !== this.operationGeneration
    ) {
      return;
    }
    this.currentSession = undefined;
    this.setSessionContext(false);
  }

  private async selectRepository(
    commandArgument?: DiffExperienceCommandArgument,
  ): Promise<Awaited<ReturnType<RepositoryDiscovery["selectRepository"]>>> {
    const activeEditorUri =
      commandArgument?.resourceUri ??
      vscode.window.activeTextEditor?.document.uri;
    return this.services.repositoryDiscovery.selectRepository({
      ...(activeEditorUri === undefined ? {} : { activeEditorUri }),
      ...(commandArgument?.repositoryRoot === undefined
        ? {}
        : { selectedRepositoryRoot: commandArgument.repositoryRoot }),
    });
  }

  private async rememberComparison(
    selection: DiffExperienceSelection,
    operationGeneration?: number,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    if (operationGeneration !== undefined && cancellationSignal !== undefined)
      this.assertOperationActive(operationGeneration, cancellationSignal);
    const repository = await this.traceDiagnostic(
      "diff.recent.repository",
      () =>
        this.services.repositoryDiscovery.selectRepository({
          selectedRepositoryRoot: selection.repositoryRoot,
        }),
    );
    if (operationGeneration !== undefined && cancellationSignal !== undefined)
      this.assertOperationActive(operationGeneration, cancellationSignal);
    if (!sameRepositoryUri(repository.rootUri, selection.repositoryRoot)) {
      throw new Error(
        "The Git repository closed while saving this comparison.",
      );
    }
    if (
      selection.filePath !== undefined &&
      !isUriWithinRepository(
        repository.rootUri,
        vscode.Uri.file(
          nodePath.join(repository.rootUri.fsPath, selection.filePath),
        ),
      )
    ) {
      throw new Error(
        "Recent comparison contains a path outside the repository.",
      );
    }
    const currentRecentComparisons = readRecentComparisons(
      this.services.workspaceState.get<unknown>(diffExperienceStorageKey),
    );
    const comparison = createRecentDiffComparison(selection);
    const comparisonKey = JSON.stringify({
      repositoryRoot: comparison.repositoryRoot,
      from: comparison.from,
      to: comparison.to,
      view: comparison.view,
      filePath: comparison.filePath,
      options: comparison.options,
    });
    const deduplicated = currentRecentComparisons.filter(
      (recentComparison) =>
        JSON.stringify({
          repositoryRoot: recentComparison.repositoryRoot,
          from: recentComparison.from,
          to: recentComparison.to,
          view: recentComparison.view,
          filePath: recentComparison.filePath,
          options: recentComparison.options,
        }) !== comparisonKey,
    );
    const recentComparisonStateUpdate = this.traceDiagnostic(
      "diff.recent.state",
      async () =>
        this.services.workspaceState.update(
          diffExperienceStorageKey,
          [comparison, ...deduplicated].slice(0, 10),
        ),
    );
    // Extension-state persistence must never block the native diff editor.
    void recentComparisonStateUpdate.catch(() => undefined);
    if (operationGeneration !== undefined && cancellationSignal !== undefined)
      this.assertOperationActive(operationGeneration, cancellationSignal);
  }

  private async pickRecentComparison(): Promise<
    RecentDiffComparison | undefined
  > {
    const recentComparisons = readRecentComparisons(
      this.services.workspaceState.get<unknown>(diffExperienceStorageKey),
    );
    if (recentComparisons.length === 0) {
      await vscode.window.showInformationMessage(
        "No recent Git'o comparisons.",
      );
      return undefined;
    }
    const selectedItem = await vscode.window.showQuickPick(
      recentComparisons.map((recentComparison) => ({
        label: `${recentComparison.from.kind} ↔ ${recentComparison.to.kind}`,
        description: recentComparison.repositoryRoot,
        recentComparison,
      })),
      { placeHolder: "Reopen a recent comparison" },
    );
    return selectedItem?.recentComparison;
  }

  private async restoreRecentComparison(
    recentComparison: RecentDiffComparison,
  ): Promise<DiffExperienceSelection | undefined> {
    const repositoryRoot = uriFromStoredString(recentComparison.repositoryRoot);
    const repository = await this.services.repositoryDiscovery.selectRepository(
      {
        selectedRepositoryRoot: repositoryRoot,
      },
    );
    if (
      !isUriWithinRepository(repository.rootUri, repositoryRoot) ||
      !isUriWithinRepository(repositoryRoot, repository.rootUri)
    ) {
      throw new Error(
        "Recent comparison belongs to a different Git repository.",
      );
    }
    if (
      recentComparison.filePath !== undefined &&
      !isUriWithinRepository(
        repository.rootUri,
        vscode.Uri.file(
          nodePath.join(repository.rootUri.fsPath, recentComparison.filePath),
        ),
      )
    ) {
      throw new Error(
        "Recent comparison contains a path outside the repository.",
      );
    }
    const from = restoreSource(repository.rootUri, recentComparison.from);
    const to = restoreSource(repository.rootUri, recentComparison.to);
    return {
      repositoryRoot: repository.rootUri,
      from,
      to,
      view: recentComparison.view,
      ...(recentComparison.filePath === undefined
        ? {}
        : { filePath: recentComparison.filePath }),
      options: optionsForDiffPreset(recentComparison.options.preset, {
        contextLines: recentComparison.options.contextLines,
        whitespaceMode: recentComparison.options.whitespaceMode,
        presentationMode: recentComparison.options.presentationMode,
      }),
    };
  }

  private async showSpecialFileMessages(
    files: readonly DiffRepositoryPlan["files"][number][],
  ): Promise<void> {
    const renamedCount = files.filter(
      (file) => file.metadata.changeType === "renamed",
    ).length;
    const binaryCount = files.filter((file) => file.metadata.isBinary).length;
    const submoduleCount = files.filter(
      (file) => file.metadata.isSubmodule,
    ).length;
    const messages: string[] = [];
    if (renamedCount > 0)
      messages.push(
        `${renamedCount} rename${renamedCount === 1 ? "" : "s"} detected`,
      );
    if (binaryCount > 0)
      messages.push(
        `${binaryCount} binary file${binaryCount === 1 ? "" : "s"} shown by VS Code`,
      );
    if (submoduleCount > 0)
      messages.push(
        `${submoduleCount} submodule change${submoduleCount === 1 ? "" : "s"} shown as metadata`,
      );
    if (messages.length > 0)
      await vscode.window.showInformationMessage(messages.join(" · "));
  }

  private async withDiffProgress<T>(
    title: string,
    operation: (
      cancellationSignal: AbortSignal,
      operationGeneration: number,
    ) => Promise<T>,
  ): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const abortController = new AbortController();
        const operationGeneration = ++this.operationGeneration;
        this.activeAbortController = abortController;
        const cancellationSubscription =
          cancellationToken.onCancellationRequested(() =>
            abortController.abort(),
          );
        if (cancellationToken.isCancellationRequested) abortController.abort();
        try {
          return await operation(abortController.signal, operationGeneration);
        } finally {
          cancellationSubscription.dispose();
          if (this.activeAbortController === abortController)
            this.activeAbortController = undefined;
        }
      },
    );
  }

  private assertOperationActive(
    operationGeneration: number,
    cancellationSignal: AbortSignal,
  ): void {
    if (
      this.disposed ||
      operationGeneration !== this.operationGeneration ||
      cancellationSignal.aborted
    ) {
      throw new DOMException("Git diff cancelled", "AbortError");
    }
  }

  private isOperationActive(
    operationGeneration: number | undefined,
    cancellationSignal: AbortSignal | undefined,
  ): boolean {
    return (
      !this.disposed &&
      (operationGeneration === undefined ||
        operationGeneration === this.operationGeneration) &&
      cancellationSignal?.aborted !== true
    );
  }

  private async captureRepositoryHead(
    repositoryRoot: vscode.Uri,
    cancellationSignal: AbortSignal,
    repositoryBinding: GitDiffRepositoryBinding,
  ): Promise<string> {
    const selectedRepository =
      await this.services.repositoryDiscovery.selectRepository({
        selectedRepositoryRoot: repositoryRoot,
      });
    if (!sameRepositoryUri(selectedRepository.rootUri, repositoryRoot))
      throw new Error(
        "The selected Git repository changed. Refresh and try again.",
      );
    return this.services.gitDiffService.getHeadRevision(
      repositoryRoot,
      cancellationSignal,
      repositoryBinding,
    );
  }

  private async assertRepositoryHeadUnchanged(
    repositoryRoot: vscode.Uri,
    initialHeadRevision: string,
    cancellationSignal: AbortSignal,
    repositoryBinding: GitDiffRepositoryBinding,
  ): Promise<void> {
    const currentHeadRevision =
      await this.services.gitDiffService.getHeadRevision(
        repositoryRoot,
        cancellationSignal,
        repositoryBinding,
      );
    if (currentHeadRevision !== initialHeadRevision)
      throw new Error(
        "Repository HEAD changed while preparing the diff. Try again.",
      );
  }

  private async isSessionFresh(
    session: DiffExperienceSession,
  ): Promise<boolean> {
    const currentMutableStateFingerprint =
      await this.services.gitDiffService.getMutableStateFingerprint(
        session.selection.repositoryRoot,
        undefined,
        session.repositoryBinding,
      );
    if (currentMutableStateFingerprint === session.mutableStateFingerprint) {
      return true;
    }
    await vscode.window.showWarningMessage(
      "The repository changed since this diff opened. Reopen to refresh it.",
    );
    this.clearSessionContext();
    return false;
  }

  private async runSafely(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    try {
      await operation();
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      const message = formatGitErrorForUser(
        error,
        "Git'o could not open that diff.",
      );
      await vscode.window.showErrorMessage(message);
    }
  }
}

export function createPresetQuickPickItems(): readonly DiffPresetPickItem[] {
  const nativePresets: readonly ("review" | "whitespace")[] = [
    "review",
    "whitespace",
  ];
  return nativePresets.map((preset) => ({
    label: diffExperiencePresetLabels[preset],
    description:
      preset === "whitespace"
        ? "Ignore whitespace-only changes"
        : "Balanced native diff defaults",
    preset,
  }));
}

export function createDiffViewQuickPickItems(): readonly DiffViewPickItem[] {
  return [
    {
      label: "Single file",
      description: "Open one native VS Code diff editor",
      view: "file",
    },
    {
      label: "Repository",
      description: "Open every changed file together",
      view: "repository",
    },
  ];
}

async function pickDiffView(): Promise<DiffExperienceView | undefined> {
  const selectedView = await vscode.window.showQuickPick(
    createDiffViewQuickPickItems(),
    { placeHolder: "Open as a single file or repository diff" },
  );
  return selectedView?.view;
}

function readCommandArgument(
  argumentValue: unknown,
): DiffExperienceCommandArgument {
  if (isUri(argumentValue)) return { resourceUri: argumentValue };
  if (!isRecord(argumentValue)) return {};
  return {
    ...(isUri(argumentValue.repositoryRoot)
      ? { repositoryRoot: argumentValue.repositoryRoot }
      : {}),
    ...(isUri(argumentValue.resourceUri)
      ? { resourceUri: argumentValue.resourceUri }
      : {}),
    ...(typeof argumentValue.filePath === "string"
      ? { filePath: argumentValue.filePath }
      : {}),
    ...(isDiffSource(argumentValue.from) ? { from: argumentValue.from } : {}),
    ...(isDiffSource(argumentValue.to) ? { to: argumentValue.to } : {}),
  };
}

function isDiffSource(value: unknown): value is DiffRepositorySource {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "working-tree" || value.kind === "index")
    return isUri(value.repositoryRoot);
  if (value.kind === "revision")
    return isUri(value.repositoryRoot) && typeof value.revision === "string";
  return (
    value.kind === "merge-base" &&
    isUri(value.repositoryRoot) &&
    typeof value.leftRevision === "string" &&
    typeof value.rightRevision === "string"
  );
}

function readRelativeFilePath(
  explicitFilePath: string | undefined,
  resourceUri: vscode.Uri | undefined,
  repositoryRoot: vscode.Uri,
): string | undefined {
  if (explicitFilePath !== undefined) return explicitFilePath;
  if (
    resourceUri === undefined ||
    !isUriWithinRepository(repositoryRoot, resourceUri)
  )
    return undefined;
  const relativePath = nodePath.relative(
    repositoryRoot.fsPath,
    resourceUri.fsPath,
  );
  return relativePath.length === 0
    ? undefined
    : relativePath.replaceAll(nodePath.sep, "/");
}

function createRepositoryPlanFromFile(
  filePlan: DiffFileOnlyPlan,
): DiffRepositoryPlan {
  return {
    kind: "repository",
    repositoryRoot: filePlan.repositoryRoot,
    from: filePlan.from,
    to: filePlan.to,
    files: [filePlan],
    navigation: {
      entries: filePlan.navigationEntryIds.map((entryId, rangeIndex) => ({
        id: entryId,
        fileIndex: 0,
        path: filePlan.displayPath,
        rangeIndex,
        range: filePlan.changeRanges[rangeIndex] ?? {
          oldStartLine: 0,
          oldLineCount: 0,
          newStartLine: 0,
          newLineCount: 0,
        },
      })),
      truncated: false,
    },
    presentation: filePlan.presentation,
    totalFileCount: 1,
    omittedFileCount: 0,
    truncated: false,
    caps: {
      maxFiles: 1,
      maxOutputBytes: 0,
      maxNavigationChanges: filePlan.navigationEntryIds.length,
    },
  };
}

function restoreSource(
  repositoryRoot: vscode.Uri,
  source: RecentDiffComparison["from"],
): DiffRepositorySource {
  if (source.kind === "working-tree")
    return { kind: "working-tree", repositoryRoot };
  if (source.kind === "index") return { kind: "index", repositoryRoot };
  if (source.kind === "revision")
    return createRevisionSource(repositoryRoot, source.revision!);
  return {
    kind: "merge-base",
    repositoryRoot,
    leftRevision: source.leftRevision!,
    rightRevision: source.rightRevision!,
  };
}

function readRecentComparisons(
  value: unknown,
): readonly RecentDiffComparison[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecentDiffComparison)
    .sort((left, right) => right.savedAt - left.savedAt);
}

function isRecentDiffComparison(value: unknown): value is RecentDiffComparison {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    isStoredRepositoryRoot(value.repositoryRoot) &&
    isStoredSource(value.from) &&
    isStoredSource(value.to) &&
    (value.view === "file" || value.view === "repository") &&
    (value.filePath === undefined || isSafeRelativeFilePath(value.filePath)) &&
    isStoredDiffOptions(value.options) &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt)
  );
}

function isStoredSource(value: unknown): value is RecentDiffComparison["from"] {
  if (!isRecord(value)) return false;
  if (value.kind === "working-tree" || value.kind === "index")
    return !hasUnexpectedKeys(value, ["kind"]);
  if (value.kind === "revision")
    return (
      hasOnlyKeys(value, ["kind", "revision"]) && isSafeRevision(value.revision)
    );
  return (
    value.kind === "merge-base" &&
    hasOnlyKeys(value, ["kind", "leftRevision", "rightRevision"]) &&
    isSafeRevision(value.leftRevision) &&
    isSafeRevision(value.rightRevision)
  );
}

function uriFromStoredString(value: string): vscode.Uri {
  const parsedUri = vscode.Uri.parse(value);
  if (!isFileUriPath(parsedUri))
    throw new Error("Recent comparison has an invalid repository path.");
  return parsedUri;
}

function isStoredRepositoryRoot(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    return isFileUriPath(uriFromStoredString(value));
  } catch {
    return false;
  }
}

function isFileUriPath(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && nodePath.isAbsolute(uri.fsPath);
}

function isStoredDiffOptions(
  value: unknown,
): value is RecentDiffComparison["options"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "preset",
      "contextLines",
      "whitespaceMode",
      "presentationMode",
    ])
  )
    return false;
  return (
    ["review", "whitespace"].includes(value.preset as string) &&
    Number.isInteger(value.contextLines) &&
    (value.contextLines as number) >= 0 &&
    (value.contextLines as number) <= 1_000 &&
    [
      "default",
      "ignore-all",
      "ignore-space-change",
      "ignore-space-at-eol",
      "ignore-blank-lines",
    ].includes(value.whitespaceMode as string) &&
    ["line", "word", "intraline"].includes(value.presentationMode as string)
  );
}

function isSafeRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    value.trim().length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    !value.startsWith("-")
  );
}

function isSafeRelativeFilePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096)
    return false;
  const normalizedPath = value.replaceAll("\\", "/");
  if (
    normalizedPath.includes("\0") ||
    nodePath.posix.isAbsolute(normalizedPath) ||
    /^[A-Za-z]:\//.test(normalizedPath)
  )
    return false;
  const pathSegments = normalizedPath.split("/");
  return !pathSegments.some((pathSegment) => pathSegment === "..");
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowedKeySet = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowedKeySet.has(key));
}

function hasUnexpectedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return !hasOnlyKeys(record, allowedKeys);
}

function sameRepositoryUri(leftUri: vscode.Uri, rightUri: vscode.Uri): boolean {
  return (
    leftUri.scheme === rightUri.scheme &&
    nodePath.resolve(leftUri.fsPath).replaceAll("\\", "/") ===
      nodePath.resolve(rightUri.fsPath).replaceAll("\\", "/")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function readResourceDisplayPath(resource: unknown): string {
  if (!isRecord(resource)) return "file";
  if (typeof resource.path === "string") return resource.path;
  if (typeof resource.fsPath === "string") return resource.fsPath;
  return "file";
}

function isUri(value: unknown): value is vscode.Uri {
  return (
    isRecord(value) &&
    typeof value.fsPath === "string" &&
    typeof value.scheme === "string"
  );
}
