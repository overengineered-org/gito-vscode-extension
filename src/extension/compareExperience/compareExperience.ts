import * as nodePath from "node:path";
import { realpath, stat } from "node:fs/promises";
import * as vscode from "vscode";
import {
  CompareService,
  type CompareResult,
  type CompareTarget,
  type CompareRepositoryBinding,
  GitSearchService,
  parseSearchQuery,
  type SearchClause,
  type SearchIdentity,
  type SearchPage,
} from "../compare/index.js";
import {
  isAbortError,
  type GitCommandOutput,
  type GitCommandRunner,
} from "../git/gitCommandRunner.js";
import type { RepositoryDiscovery } from "../repositories/repositoryDiscovery.js";
import {
  WorkspaceReviewChecklistStore,
  type ReviewChecklistState,
} from "../compare/reviewChecklist.js";
import {
  appendSearchClause,
  createCompareModeQuickPickItems,
  createCompareOpenPlan,
  createCompareReferenceQuickPickItems,
  createCompareSummary,
  createChecklistView,
  createCompareSessionActionItems,
  createEmptySearchBuilderState,
  createSearchBuilderQuickPickItems,
  createSearchResultQuickPickItems,
  formatCompareSummary,
  invertCompareResult,
  searchBuilderStateToQuery,
  targetForReferenceItem,
  toggleSearchBuilderOption,
} from "./compareExperiencePlans.js";
import {
  compareExperienceLabels,
  compareExperienceCommandIds,
  compareExperienceContextKeys,
  type CompareExperienceSelection,
  type CompareExperienceSession,
  type CompareExperienceWorkspaceState,
  type SearchBuilderState,
  type SearchCommitActionQuickPickItem,
  type SearchResultQuickPickItem,
} from "./compareExperienceModels.js";
import { RecentComparisonsStore } from "./recentComparisons.js";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";

export interface CompareExperienceCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}

export interface CompareExperienceUi {
  showQuickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  showInputBox(options?: vscode.InputBoxOptions): Thenable<string | undefined>;
  showInformationMessage(message: string): Thenable<unknown>;
  showWarningMessage(message: string): Thenable<unknown>;
  withProgress?<Result>(
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{
        readonly message?: string;
        readonly increment?: number;
      }>,
      token: vscode.CancellationToken,
    ) => Thenable<Result> | Promise<Result>,
  ): Thenable<Result>;
}

export interface CompareExperienceServices {
  readonly repositoryDiscovery: Pick<RepositoryDiscovery, "selectRepository">;
  readonly compareService: Pick<
    CompareService,
    | "compare"
    | "assertRepositoryBinding"
    | "assertPinnedRepositoryRoot"
    | "getMutableStateFingerprint"
    | "pinRepositoryBinding"
  >;
  readonly searchService: Pick<GitSearchService, "search">;
  readonly gitCommandRunner: Pick<GitCommandRunner, "run">;
  readonly workspaceState: CompareExperienceWorkspaceState;
  readonly ui?: CompareExperienceUi;
  readonly commandExecutor: {
    executeCommand(
      commandIdentifier: string,
      ...argumentsPassed: readonly unknown[]
    ): Promise<unknown>;
  };
  readonly currentUser?: SearchIdentity;
}

export class CompareExperience {
  private readonly ui: CompareExperienceUi;
  private readonly assertPinnedRepositoryRoot: CompareExperienceServices["compareService"]["assertPinnedRepositoryRoot"];
  private readonly recentComparisons: RecentComparisonsStore;
  private activeComparisonAbortController: AbortController | undefined;
  private activeSearchAbortController: AbortController | undefined;
  private currentSession: CompareExperienceSession | undefined;
  private reviewChecklistStore: WorkspaceReviewChecklistStore | undefined;
  private disposed = false;
  private operationGeneration = 0;
  private readonly pendingContextUpdates = new Map<string, boolean>();
  private readonly inFlightContextUpdates = new Map<string, boolean>();
  private readonly appliedContextValues = new Map<string, boolean>();
  private contextUpdateQueue: Promise<void> = Promise.resolve();
  private contextUpdateFlushScheduled = false;

  public constructor(private readonly services: CompareExperienceServices) {
    this.ui = services.ui ?? defaultCompareExperienceUi;
    this.assertPinnedRepositoryRoot =
      services.compareService.assertPinnedRepositoryRoot.bind(
        services.compareService,
      );
    this.recentComparisons = new RecentComparisonsStore(
      services.workspaceState,
    );
  }

  public registerCommands(
    commandRegistry: CompareExperienceCommandRegistry = vscode.commands,
  ): readonly vscode.Disposable[] {
    return [
      commandRegistry.registerCommand(compareExperienceCommandIds.open, () =>
        this.runSafely(() => this.openGuided()),
      ),
      commandRegistry.registerCommand(compareExperienceCommandIds.search, () =>
        this.runSafely(() => this.openSearch()),
      ),
      commandRegistry.registerCommand(compareExperienceCommandIds.actions, () =>
        this.runSafely(async () => {
          const operationActive =
            (this.activeComparisonAbortController !== undefined &&
              !this.activeComparisonAbortController.signal.aborted) ||
            (this.activeSearchAbortController !== undefined &&
              !this.activeSearchAbortController.signal.aborted);
          await this.openSessionActions(operationActive);
        }),
      ),
      commandRegistry.registerCommand(compareExperienceCommandIds.recent, () =>
        this.runSafely(() => this.openRecent()),
      ),
    ];
  }

  public getSession(): CompareExperienceSession | undefined {
    return this.currentSession;
  }

  public getRecentComparisons() {
    return this.recentComparisons.read();
  }

  public getReviewChecklist(): ReviewChecklistState | undefined {
    return this.reviewChecklistStore?.read();
  }

  public async setReviewChecklistItem(
    itemId: string,
    checked: boolean,
  ): Promise<ReviewChecklistState> {
    if (this.reviewChecklistStore === undefined) {
      throw new Error("Open a comparison before editing its review checklist.");
    }
    return this.reviewChecklistStore.setChecked(itemId, checked);
  }

  public async resetReviewChecklist(): Promise<void> {
    await this.reviewChecklistStore?.clear();
  }

  public async setReviewChecklistNotes(
    notes: string,
  ): Promise<ReviewChecklistState> {
    if (this.reviewChecklistStore === undefined) {
      throw new Error("Open a comparison before editing its review checklist.");
    }
    return this.reviewChecklistStore.setNotes(notes);
  }

  public cancelActiveOperation(): void {
    this.operationGeneration += 1;
    this.activeComparisonAbortController?.abort();
    this.activeSearchAbortController?.abort();
    this.activeComparisonAbortController = undefined;
    this.activeSearchAbortController = undefined;
    void this.setCompareContext(
      compareExperienceContextKeys.operationActive,
      false,
    );
  }

  public async compare(
    selection: CompareExperienceSelection,
    cancellationSignal?: AbortSignal,
  ): Promise<CompareResult | undefined> {
    if (this.disposed) return undefined;
    this.cancelActiveOperation();
    const operationGeneration = this.operationGeneration;
    const operationController = new AbortController();
    this.activeComparisonAbortController = operationController;
    void this.setCompareContext(
      compareExperienceContextKeys.operationActive,
      true,
    );
    const removeExternalCancellation = linkCancellation(
      cancellationSignal,
      operationController,
    );
    try {
      const repositoryBinding =
        await this.services.compareService.pinRepositoryBinding(
          selection.repositoryRoot,
          operationController.signal,
        );
      const initialMutableStateFingerprint =
        await this.services.compareService.getMutableStateFingerprint(
          selection.repositoryRoot,
          operationController.signal,
          repositoryBinding,
        );
      const result = await this.withProgress(
        `Comparing ${describeSelection(selection)}`,
        (progressCancellationSignal) =>
          this.services.compareService.compare(
            {
              repositoryRoot: selection.repositoryRoot,
              left: selection.left,
              right: selection.right,
              mode: selection.mode,
              cancellationSignal: progressCancellationSignal,
            },
            repositoryBinding,
          ),
        operationController,
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        return undefined;
      }
      await this.services.compareService.assertRepositoryBinding(
        selection.repositoryRoot,
        operationController.signal,
        repositoryBinding,
      );
      const mutableStateFingerprint =
        await this.services.compareService.getMutableStateFingerprint(
          selection.repositoryRoot,
          operationController.signal,
          repositoryBinding,
        );
      if (
        initialMutableStateFingerprint !== undefined &&
        mutableStateFingerprint !== initialMutableStateFingerprint
      ) {
        await this.ui.showWarningMessage(
          "The repository changed while preparing this comparison. Reopen to refresh it.",
        );
        return undefined;
      }
      const gitDirectoryIdentity = await resolveGitDirectoryIdentity(
        this.services.gitCommandRunner,
        selection.repositoryRoot,
        operationController.signal,
        undefined,
        repositoryBinding,
        this.assertPinnedRepositoryRoot,
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        return undefined;
      }
      await this.recentComparisons.purgeStaleRepositoryPath(
        selection.repositoryRoot.toString(),
        gitDirectoryIdentity,
      );
      const recentComparison = await this.recentComparisons.remember(
        selection,
        Date.now(),
        gitDirectoryIdentity,
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        return undefined;
      }
      const latestMutableStateFingerprint =
        await this.services.compareService.getMutableStateFingerprint(
          selection.repositoryRoot,
          operationController.signal,
          repositoryBinding,
        );
      if (
        latestMutableStateFingerprint !== mutableStateFingerprint ||
        !this.isCurrentOperation(operationGeneration, operationController)
      ) {
        if (this.isCurrentOperation(operationGeneration, operationController)) {
          await this.ui.showWarningMessage(
            "The repository changed while opening this comparison. Reopen to refresh it.",
          );
        }
        return undefined;
      }
      this.currentSession = {
        selection,
        result,
        repositoryBinding,
        mutableStateFingerprint: mutableStateFingerprint ?? "unsupported",
        swapped: false,
        recentComparison: recentComparison[0]!,
      };
      void this.setCompareContext(
        compareExperienceContextKeys.sessionActive,
        true,
      );
      this.reviewChecklistStore = new WorkspaceReviewChecklistStore(
        this.services.workspaceState,
        {
          repositoryRootPath: selection.repositoryRoot.fsPath,
          mode: result.mode,
          left: result.left,
          right: result.right,
        },
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        return undefined;
      }
      await this.executeOpenPlan(
        createCompareOpenPlan(result),
        operationController,
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        return undefined;
      }
      await this.ui.showInformationMessage(
        formatCompareSummary(createCompareSummary(result)),
      );
      await this.openSessionActions();
      return result;
    } catch (error: unknown) {
      if (isAbortError(error) || isCancellationError(error)) return undefined;
      throw error;
    } finally {
      removeExternalCancellation();
      if (this.activeComparisonAbortController === operationController) {
        this.activeComparisonAbortController = undefined;
        void this.setCompareContext(
          compareExperienceContextKeys.operationActive,
          false,
        );
      }
    }
  }

  public async search(
    repositoryRoot: vscode.Uri,
    source: string,
    options: {
      readonly pageIndex?: number;
      readonly pageSize?: number;
      readonly maxResults?: number;
      readonly maxOutputBytes?: number;
      readonly matchCase?: boolean;
      readonly regex?: boolean;
      readonly matchAll?: boolean;
      readonly currentUser?: SearchIdentity;
      readonly cancellationSignal?: AbortSignal;
    } = {},
  ): Promise<SearchPage> {
    this.cancelActiveOperation();
    const operationGeneration = this.operationGeneration;
    const operationController = new AbortController();
    this.activeSearchAbortController = operationController;
    void this.setCompareContext(
      compareExperienceContextKeys.operationActive,
      true,
    );
    const { cancellationSignal: externalCancellationSignal, ...searchOptions } =
      options;
    const removeExternalCancellation = linkCancellation(
      externalCancellationSignal,
      operationController,
    );
    try {
      const page = await this.withProgress(
        "Searching commits",
        (progressCancellationSignal) =>
          this.services.searchService.search(repositoryRoot, source, {
            ...searchOptions,
            cancellationSignal: progressCancellationSignal,
          }),
        operationController,
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        throw createOperationCancelledError();
      }
      return page;
    } finally {
      removeExternalCancellation();
      if (this.activeSearchAbortController === operationController) {
        this.activeSearchAbortController = undefined;
        void this.setCompareContext(
          compareExperienceContextKeys.operationActive,
          false,
        );
      }
    }
  }

  private isCurrentOperation(
    operationGeneration: number,
    operationController: AbortController,
  ): boolean {
    return (
      !this.disposed &&
      !operationController.signal.aborted &&
      this.operationGeneration === operationGeneration
    );
  }

  public async openAll(): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) {
      await this.ui.showInformationMessage("Open a comparison first.");
      return;
    }
    if (!(await this.isSessionFresh(session))) return;
    await this.executeOpenPlan(createCompareOpenPlan(session.result));
  }

  public async swapSides(): Promise<void> {
    const session = this.currentSession;
    if (session === undefined) {
      await this.ui.showInformationMessage("Open a comparison first.");
      return;
    }
    if (!(await this.isSessionFresh(session))) return;
    const invertedResult = invertCompareResult(session.result);
    const nextSession: CompareExperienceSession = {
      ...session,
      result: invertedResult,
      selection: {
        ...session.selection,
        left: session.selection.right,
        right: session.selection.left,
      },
      recentComparison: {
        ...session.recentComparison,
        left: session.recentComparison.right,
        right: session.recentComparison.left,
      },
      swapped: !session.swapped,
    };
    this.currentSession = nextSession;
    this.reviewChecklistStore = new WorkspaceReviewChecklistStore(
      this.services.workspaceState,
      {
        repositoryRootPath: invertedResult.repositoryRoot.fsPath,
        mode: invertedResult.mode,
        left: invertedResult.left,
        right: invertedResult.right,
      },
    );
    await this.openAll();
  }

  /**
   * Shows actions only for the current, fingerprint-checked comparison.
   * This is the production route for commands that stay out of the palette
   * until a compare session exists.
   */
  public async openSessionActions(operationActive = false): Promise<void> {
    if (this.currentSession === undefined && !operationActive) {
      await this.ui.showInformationMessage("Open a comparison first.");
      return;
    }
    const selectedAction = await this.ui.showQuickPick(
      createCompareSessionActionItems(
        operationActive,
        this.currentSession !== undefined,
      ),
      { placeHolder: "Comparison actions" },
    );
    if (selectedAction === undefined || selectedAction.action === "done")
      return;
    switch (selectedAction.action) {
      case "open-all":
        await this.openAll();
        return;
      case "swap-sides":
        await this.swapSides();
        return;
      case "checklist":
        await this.openReviewChecklist();
        return;
      case "reset-checklist":
        await this.resetReviewChecklist();
        return;
      case "cancel":
        this.cancelActiveOperation();
        return;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelActiveOperation();
    this.currentSession = undefined;
    this.reviewChecklistStore = undefined;
    void this.setCompareContext(
      compareExperienceContextKeys.sessionActive,
      false,
    );
    void this.setCompareContext(
      compareExperienceContextKeys.operationActive,
      false,
    );
  }

  private async openGuided(): Promise<void> {
    const repository =
      await this.services.repositoryDiscovery.selectRepository();
    const repositoryBinding =
      await this.services.compareService.pinRepositoryBinding(
        repository.rootUri,
      );
    const revisions = await this.runCancellableEnumeration(
      "Loading compare references",
      (cancellationSignal) =>
        listCompareRevisions(
          this.services.gitCommandRunner,
          repository.rootUri,
          repositoryBinding,
          this.assertPinnedRepositoryRoot,
          cancellationSignal,
        ),
    );
    const left = await this.pickReference(revisions, "Choose the left side");
    if (left === undefined) return;
    const right = await this.pickReference(revisions, "Choose the right side");
    if (right === undefined) return;
    const modeItem = await this.ui.showQuickPick(
      createCompareModeQuickPickItems(),
      {
        placeHolder: "How should Git'o compare these sides?",
        matchOnDescription: true,
      },
    );
    if (modeItem === undefined) return;
    await this.compare({
      repositoryRoot: repository.rootUri,
      left,
      right,
      mode: modeItem.mode,
    });
  }

  private async pickReference(
    revisions: readonly string[],
    placeHolder: string,
  ): Promise<CompareTarget | undefined> {
    const selectedItem = await this.ui.showQuickPick(
      createCompareReferenceQuickPickItems(revisions),
      { placeHolder, matchOnDescription: true },
    );
    if (selectedItem === undefined) return undefined;
    if (
      selectedItem.referenceKind === "revision" &&
      selectedItem.target === undefined
    ) {
      const revision = await this.ui.showInputBox({
        prompt: "Branch, tag, or commit",
        placeHolder: "main, v1.2.0, or 0123456",
        validateInput: (candidate) =>
          candidate.trim().length === 0 ? "Enter a Git reference." : undefined,
      });
      return targetForReferenceItem(selectedItem, revision);
    }
    return targetForReferenceItem(selectedItem);
  }

  private async openSearch(): Promise<void> {
    const repository =
      await this.services.repositoryDiscovery.selectRepository();
    const repositoryBinding =
      await this.services.compareService.pinRepositoryBinding(
        repository.rootUri,
      );
    await this.services.compareService.assertRepositoryBinding(
      repository.rootUri,
      undefined,
      repositoryBinding,
    );
    const currentUser = await this.runCancellableEnumeration(
      "Loading commit search",
      (cancellationSignal) =>
        resolveCurrentUserIdentity(
          this.services.gitCommandRunner,
          repository.rootUri,
          repositoryBinding,
          this.assertPinnedRepositoryRoot,
          cancellationSignal,
        ),
    );
    let builderState = createEmptySearchBuilderState(currentUser);
    while (true) {
      const selectedItem = await this.ui.showQuickPick(
        createSearchBuilderQuickPickItems(builderState),
        { placeHolder: "Build a commit search", matchOnDescription: true },
      );
      if (selectedItem === undefined) return;
      if (selectedItem.action === "run") {
        await this.showSearchResults(
          repository.rootUri,
          searchBuilderStateToQuery(builderState),
        );
        return;
      }
      if (selectedItem.action === "clear") {
        builderState = createEmptySearchBuilderState(currentUser);
        continue;
      }
      if (
        selectedItem.action === "toggle-regex" ||
        selectedItem.action === "toggle-case" ||
        selectedItem.action === "toggle-match-all"
      ) {
        const option =
          selectedItem.action === "toggle-regex"
            ? "regex"
            : selectedItem.action === "toggle-case"
              ? "matchCase"
              : "matchAll";
        builderState = toggleSearchBuilderOption(builderState, option);
        continue;
      }
      if (selectedItem.field === undefined) continue;
      if (selectedItem.field === "@me") {
        builderState = appendSearchClause(builderState, {
          field: "@me",
          value: "",
          operator: "equals",
        });
        continue;
      }
      const enteredValue = await this.ui.showInputBox({
        prompt: `${selectedItem.label.replace(/^Add /, "")} value`,
        placeHolder:
          selectedItem.field === "date"
            ? "2026-08-23 or >=2026-08-23"
            : "Search value",
      });
      if (enteredValue === undefined || enteredValue.trim().length === 0)
        continue;
      const parsedClause = parseSearchClause(
        selectedItem.field,
        enteredValue,
        builderState,
      );
      builderState = appendSearchClause(builderState, parsedClause);
    }
  }

  private async openReviewChecklist(): Promise<void> {
    const checklistStore = this.reviewChecklistStore;
    if (checklistStore === undefined) {
      await this.ui.showInformationMessage("Open a comparison first.");
      return;
    }
    const checklistItems = createChecklistView(checklistStore.read()).map(
      (item) => ({
        label: `${item.checked ? "$(check)" : "$(circle-outline)"} ${item.label}`,
        description: item.checked ? "Checked" : "Not checked",
        id: item.id,
        action: "toggle" as const,
      }),
    );
    const selectedItem = await this.ui.showQuickPick(
      [
        ...checklistItems,
        {
          label: "Edit review notes…",
          description: checklistStore.read().notes || "No notes yet",
          action: "notes" as const,
        },
      ],
      { placeHolder: "Review checklist" },
    );
    if (selectedItem === undefined) return;
    if (selectedItem.action === "notes") {
      await this.editReviewChecklistNotes();
      return;
    }
    const checklistItem = checklistItems.find(
      (item) => item.id === selectedItem.id,
    );
    if (checklistItem !== undefined)
      await checklistStore.setChecked(
        checklistItem.id,
        !checklistStore.read().checkedItemIds.includes(checklistItem.id),
      );
  }

  private async editReviewChecklistNotes(): Promise<void> {
    const checklistStore = this.reviewChecklistStore;
    if (checklistStore === undefined) {
      await this.ui.showInformationMessage("Open a comparison first.");
      return;
    }
    const notes = await this.ui.showInputBox({
      prompt: "Review notes",
      value: checklistStore.read().notes,
      placeHolder: "Risks, follow-ups, or validation notes",
    });
    if (notes !== undefined) await checklistStore.setNotes(notes);
  }

  private async showSearchResults(
    repositoryRoot: vscode.Uri,
    query: ReturnType<typeof searchBuilderStateToQuery>,
    pageIndex = 0,
  ): Promise<void> {
    const page = await this.search(repositoryRoot, query.source, {
      pageIndex,
      matchCase: query.matchCase,
      regex: query.regex,
      matchAll: query.matchAll,
      ...(query.currentUser === undefined
        ? {}
        : { currentUser: query.currentUser }),
    });
    const items = createSearchResultQuickPickItems(page);
    const selectedItem = await this.ui.showQuickPick(items, {
      placeHolder: `Search results · page ${page.pageIndex + 1}`,
      matchOnDescription: true,
    });
    if (selectedItem === undefined) return;
    if (selectedItem.action === "next-page") {
      await this.showSearchResults(
        repositoryRoot,
        query,
        page.nextPageIndex ?? pageIndex + 1,
      );
      return;
    }
    if (selectedItem.document === undefined) return;
    const action = await this.ui.showQuickPick(
      createSearchCommitActionItems(selectedItem),
      { placeHolder: "Commit action" },
    );
    if (action === undefined || action.action === "cancel") return;
    if (action.action === "copy-sha") {
      await vscode.env.clipboard.writeText(selectedItem.document.commitSha);
      await this.ui.showInformationMessage("Commit SHA copied.");
      return;
    }
    await this.compare({
      repositoryRoot,
      left: { kind: "ref", ref: selectedItem.document.commitSha },
      right: { kind: "ref", ref: "HEAD" },
      mode: "direct",
    });
  }

  private async openRecent(): Promise<void> {
    if (
      this.currentSession !== undefined &&
      !(await this.isSessionFresh(this.currentSession))
    ) {
      return;
    }
    const recentEntries = this.recentComparisons.read();
    if (recentEntries.length === 0) {
      await this.ui.showInformationMessage("No recent comparisons.");
      return;
    }
    const selectedEntry = await this.ui.showQuickPick(
      recentEntries.map((entry) => ({
        label: `${targetLabel(entry.left)} ↔ ${targetLabel(entry.right)}`,
        description: `${entry.mode === "common-base" ? "Common base" : "Direct"} · ${entry.repositoryRoot}`,
        entry,
      })),
      { placeHolder: "Recent comparisons", matchOnDescription: true },
    );
    if (selectedEntry === undefined) return;
    const selectedRepositoryRoot = vscode.Uri.parse(
      selectedEntry.entry.repositoryRoot,
    );
    let discoveredRepositoryRoot: vscode.Uri;
    try {
      discoveredRepositoryRoot = (
        await this.services.repositoryDiscovery.selectRepository({
          selectedRepositoryRoot,
        })
      ).rootUri;
    } catch {
      await this.recentComparisons.forget(selectedEntry.entry);
      await this.ui.showWarningMessage(
        "Recent comparison repository is no longer open.",
      );
      return;
    }
    let discoveredRepositoryBinding: CompareRepositoryBinding;
    try {
      discoveredRepositoryBinding =
        await this.services.compareService.pinRepositoryBinding(
          discoveredRepositoryRoot,
        );
    } catch {
      await this.recentComparisons.forget(selectedEntry.entry);
      await this.ui.showWarningMessage(
        "Recent comparison repository is no longer open.",
      );
      return;
    }
    const currentGitDirectoryIdentity = await resolveGitDirectoryIdentity(
      this.services.gitCommandRunner,
      discoveredRepositoryRoot,
      undefined,
      undefined,
      discoveredRepositoryBinding,
      this.assertPinnedRepositoryRoot,
    ).catch(() => undefined);
    if (
      currentGitDirectoryIdentity === undefined ||
      currentGitDirectoryIdentity !== selectedEntry.entry.gitDirectoryIdentity
    ) {
      await this.recentComparisons.forget(selectedEntry.entry);
      await this.ui.showWarningMessage(
        "Recent comparison no longer belongs to this Git repository.",
      );
      return;
    }
    await this.compare({
      repositoryRoot: discoveredRepositoryRoot,
      left: selectedEntry.entry.left,
      right: selectedEntry.entry.right,
      mode: selectedEntry.entry.mode,
    });
  }

  private async isSessionFresh(
    session: CompareExperienceSession,
  ): Promise<boolean> {
    const currentMutableStateFingerprint =
      await this.readMutableStateFingerprint(
        session.selection.repositoryRoot,
        undefined,
        session.repositoryBinding,
      );
    if (
      currentMutableStateFingerprint === undefined ||
      session.mutableStateFingerprint === undefined ||
      currentMutableStateFingerprint === session.mutableStateFingerprint
    ) {
      return true;
    }
    await this.ui.showWarningMessage(
      "The repository changed since this comparison opened. Reopen to refresh it.",
    );
    void this.setCompareContext(
      compareExperienceContextKeys.sessionActive,
      false,
    );
    return false;
  }

  private async readMutableStateFingerprint(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
    repositoryBinding?: CompareRepositoryBinding,
  ): Promise<string | undefined> {
    return this.services.compareService.getMutableStateFingerprint(
      repositoryRoot,
      cancellationSignal,
      repositoryBinding,
    );
  }

  private async executeOpenPlan(
    plan: ReturnType<typeof createCompareOpenPlan>,
    operationController?: AbortController,
  ): Promise<void> {
    const executeCommand = (
      commandIdentifier: string,
      ...argumentsPassed: readonly unknown[]
    ): Promise<unknown> =>
      this.services.commandExecutor.executeCommand(
        commandIdentifier,
        ...argumentsPassed,
      );
    try {
      if (!this.isOpenPlanActive(operationController)) return;
      await executeCommand(plan.command, ...plan.arguments);
    } catch {
      if (!this.isOpenPlanActive(operationController)) return;
      // Keep the comparison usable on hosts where the public changes command
      // is unavailable by opening each pair through public commands.
      for (const [changeResourceUri, originalUri, modifiedUri] of plan
        .arguments[1]) {
        if (!this.isOpenPlanActive(operationController)) return;
        if (originalUri !== undefined && modifiedUri !== undefined) {
          try {
            await executeCommand(
              "vscode.diff",
              originalUri,
              modifiedUri,
              `${plan.title} · ${changeResourceUri.path}`,
            );
          } catch (error: unknown) {
            if (!this.isOpenPlanActive(operationController)) return;
            throw error;
          }
        } else {
          const availableUri = modifiedUri ?? originalUri ?? changeResourceUri;
          try {
            await executeCommand("vscode.open", availableUri);
          } catch (error: unknown) {
            if (!this.isOpenPlanActive(operationController)) return;
            throw error;
          }
        }
      }
    }
  }

  private isOpenPlanActive(operationController?: AbortController): boolean {
    return (
      !this.disposed &&
      (operationController === undefined || !operationController.signal.aborted)
    );
  }

  private async setCompareContext(
    contextKey: string,
    enabled: boolean,
  ): Promise<void> {
    if (this.pendingContextUpdates.get(contextKey) === enabled) return;
    if (this.inFlightContextUpdates.get(contextKey) === enabled) return;
    if (
      !this.pendingContextUpdates.has(contextKey) &&
      this.appliedContextValues.get(contextKey) === enabled
    )
      return;
    this.pendingContextUpdates.set(contextKey, enabled);
    if (!this.contextUpdateFlushScheduled) {
      this.contextUpdateFlushScheduled = true;
      this.contextUpdateQueue = this.contextUpdateQueue.then(() =>
        this.flushCompareContextUpdates(),
      );
    }
    await this.contextUpdateQueue;
  }

  private async flushCompareContextUpdates(): Promise<void> {
    try {
      while (this.pendingContextUpdates.size > 0) {
        const nextContextUpdate = this.pendingContextUpdates.entries().next();
        if (nextContextUpdate.done) break;
        const [nextContextKey, nextEnabled] = nextContextUpdate.value;
        this.pendingContextUpdates.delete(nextContextKey);
        this.inFlightContextUpdates.set(nextContextKey, nextEnabled);
        try {
          await this.services.commandExecutor.executeCommand(
            "setContext",
            nextContextKey,
            nextEnabled,
          );
          this.appliedContextValues.set(nextContextKey, nextEnabled);
        } catch {
          // Context keys are only palette affordances; a minimal host may omit them.
        } finally {
          this.inFlightContextUpdates.delete(nextContextKey);
        }
      }
    } finally {
      this.contextUpdateFlushScheduled = false;
    }
  }

  private async runCancellableEnumeration<Result>(
    title: string,
    operation: (cancellationSignal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.disposed) throw createOperationCancelledError();
    this.cancelActiveOperation();
    const operationGeneration = this.operationGeneration;
    const operationController = new AbortController();
    this.activeComparisonAbortController = operationController;
    void this.setCompareContext(
      compareExperienceContextKeys.operationActive,
      true,
    );
    try {
      const result = await this.withProgress(
        title,
        operation,
        operationController,
      );
      if (!this.isCurrentOperation(operationGeneration, operationController)) {
        throw createOperationCancelledError();
      }
      return result;
    } finally {
      if (this.activeComparisonAbortController === operationController) {
        this.activeComparisonAbortController = undefined;
        void this.setCompareContext(
          compareExperienceContextKeys.operationActive,
          false,
        );
      }
    }
  }

  private async withProgress<Result>(
    title: string,
    operation: (signal: AbortSignal) => Promise<Result>,
    operationController: AbortController,
  ): Promise<Result> {
    if (this.ui.withProgress === undefined)
      return operation(operationController.signal);
    return this.ui.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      (_progress, cancellationToken) => {
        if (cancellationToken.isCancellationRequested) {
          operationController.abort();
        }
        const cancellationSubscription =
          cancellationToken.onCancellationRequested(() =>
            operationController.abort(),
          );
        return operation(operationController.signal).finally(() => {
          cancellationSubscription.dispose();
        });
      },
    );
  }

  private async runSafely(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      if (isAbortError(error) || isCancellationError(error)) return;
      await this.ui.showWarningMessage(
        formatGitErrorForUser(
          error,
          "Git'o could not complete that comparison.",
        ),
      );
    }
  }
}

function createSearchCommitActionItems(
  resultItem: SearchResultQuickPickItem,
): readonly SearchCommitActionQuickPickItem[] {
  if (resultItem.document === undefined) return [];
  return [
    {
      label: "Compare with Current",
      description: "Open this commit against HEAD",
      action: "compare-current",
    },
    {
      label: "Copy commit SHA",
      description: resultItem.document.commitSha,
      action: "copy-sha",
    },
    { label: "Cancel", action: "cancel" },
  ];
}

async function listCompareRevisions(
  gitCommandRunner: Pick<GitCommandRunner, "run">,
  repositoryRoot: vscode.Uri,
  repositoryBinding: CompareRepositoryBinding,
  assertRepositoryBinding: (
    repositoryRoot: vscode.Uri,
    repositoryBinding: CompareRepositoryBinding,
  ) => Promise<string>,
  cancellationSignal?: AbortSignal,
): Promise<readonly string[]> {
  const runRevisionGitCommand = async (
    argumentsPassed: readonly string[],
  ): Promise<GitCommandOutput> => {
    return gitCommandRunner.run({
      repositoryRoot: repositoryBinding.canonicalPath,
      rootBinding: repositoryBinding.rootBinding,
      arguments: argumentsPassed,
      cancellationSignal,
    });
  };
  throwIfCompareCancelled(cancellationSignal);
  const [refs, recentCommits] = await Promise.all([
    runRevisionGitCommand([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]),
    runRevisionGitCommand(["log", "--format=%H", "-n", "20", "HEAD"]),
  ]);
  throwIfCompareCancelled(cancellationSignal);
  await assertRepositoryBinding(repositoryRoot, repositoryBinding);
  throwIfCompareCancelled(cancellationSignal);
  const revisions = new Set<string>();
  for (const revision of `${refs.standardOutput}\n${recentCommits.standardOutput}`.split(
    /\r?\n/,
  )) {
    const trimmedRevision = revision.trim();
    if (trimmedRevision.length > 0) revisions.add(trimmedRevision);
  }
  return [...revisions];
}

function parseSearchClause(
  field: SearchClause["field"],
  value: string,
  state: SearchBuilderState,
): SearchClause {
  const source = `${field}:${quoteSearchValue(value.trim())}`;
  const parsed = parseSearchQuery(source, {
    matchCase: state.matchCase,
    regex: state.regex,
    matchAll: state.matchAll,
    ...(state.currentUser === undefined
      ? {}
      : { currentUser: state.currentUser }),
  });
  const clause = parsed.clauses[0];
  if (clause === undefined)
    throw new Error("Search value did not produce a clause.");
  return clause;
}

function quoteSearchValue(value: string): string {
  return /\s|["\\]/.test(value)
    ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : value;
}

function describeSelection(selection: CompareExperienceSelection): string {
  return `${targetLabel(selection.left)} ↔ ${targetLabel(selection.right)}`;
}

function targetLabel(target: CompareTarget): string {
  switch (target.kind) {
    case "ref":
      return target.ref === "HEAD"
        ? compareExperienceLabels.current
        : target.ref;
    case "upstream":
      return compareExperienceLabels.upstream;
    case "working":
      return compareExperienceLabels.working;
    case "index":
      return compareExperienceLabels.staged;
  }
}

function linkCancellation(
  externalSignal: AbortSignal | undefined,
  operationController: AbortController,
): () => void {
  if (externalSignal === undefined) return () => undefined;
  const abortOperation = (): void => operationController.abort();
  if (externalSignal.aborted) operationController.abort();
  else externalSignal.addEventListener("abort", abortOperation, { once: true });
  return () => externalSignal.removeEventListener("abort", abortOperation);
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createOperationCancelledError(): DOMException {
  return new DOMException("Compare operation cancelled", "AbortError");
}

function throwIfCompareCancelled(
  cancellationSignal: AbortSignal | undefined,
): void {
  if (cancellationSignal?.aborted) throw createOperationCancelledError();
}

interface PinnedRepositoryRoot {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export async function resolveGitDirectoryIdentity(
  gitCommandRunner: Pick<GitCommandRunner, "run">,
  repositoryRoot: vscode.Uri,
  cancellationSignal?: AbortSignal,
  expectedPinnedRoot?: PinnedRepositoryRoot,
  expectedRepositoryBinding?: CompareRepositoryBinding,
  assertPinnedRepositoryRootForBinding?: (
    repositoryRoot: vscode.Uri,
    repositoryBinding: CompareRepositoryBinding,
  ) => Promise<string>,
): Promise<string> {
  const pinnedRoot =
    expectedPinnedRoot ??
    (expectedRepositoryBinding === undefined
      ? await pinRepositoryRoot(repositoryRoot)
      : createPinnedRepositoryRoot(expectedRepositoryBinding));
  const output = await runPinnedGitCommand(
    gitCommandRunner,
    repositoryRoot,
    pinnedRoot,
    ["rev-parse", "--git-common-dir"],
    cancellationSignal,
    expectedRepositoryBinding,
  );
  const gitDirectory = output.standardOutput.trim();
  if (gitDirectory.length === 0) {
    throw new Error("Git returned no repository identity.");
  }
  const resolvedIdentity = nodePath.resolve(
    pinnedRoot.canonicalPath,
    gitDirectory,
  );
  let canonicalIdentityPath: string;
  try {
    canonicalIdentityPath = await realpath(resolvedIdentity);
  } catch (error: unknown) {
    throw new Error("Git repository identity could not be canonicalized.", {
      cause: error,
    });
  }
  const filesystemIdentity = await stat(canonicalIdentityPath, {
    bigint: true,
  });
  if (expectedRepositoryBinding !== undefined) {
    if (assertPinnedRepositoryRootForBinding === undefined) {
      throw new Error("Compare repository binding validator is required.");
    }
    await assertPinnedRepositoryRootForBinding(
      repositoryRoot,
      expectedRepositoryBinding,
    );
  } else {
    await assertPinnedRepositoryRoot(pinnedRoot);
  }
  // Include ctime as well as device/inode: filesystems may reuse an inode
  // when a checkout is deleted and recreated at the same path.
  if (filesystemIdentity.dev > 0n && filesystemIdentity.ino > 0n) {
    return `git:${canonicalIdentityPath}:${filesystemIdentity.dev}:${filesystemIdentity.ino}:${filesystemIdentity.ctimeNs}`;
  }
  return canonicalIdentityPath;
}

async function resolveCurrentUserIdentity(
  gitCommandRunner: Pick<GitCommandRunner, "run">,
  repositoryRoot: vscode.Uri,
  repositoryBinding: CompareRepositoryBinding,
  assertPinnedRepositoryRoot: (
    repositoryRoot: vscode.Uri,
    repositoryBinding: CompareRepositoryBinding,
  ) => Promise<string>,
  cancellationSignal?: AbortSignal,
): Promise<SearchIdentity | undefined> {
  const pinnedRoot = createPinnedRepositoryRoot(repositoryBinding);
  const readConfigValue = async (
    configKey: "user.name" | "user.email",
  ): Promise<string | undefined> => {
    try {
      const output = await runPinnedGitCommand(
        gitCommandRunner,
        repositoryRoot,
        pinnedRoot,
        ["config", "--get", configKey],
        cancellationSignal,
        repositoryBinding,
      );
      const configValue = output.standardOutput.trim();
      return configValue.length === 0 ? undefined : configValue;
    } catch (error: unknown) {
      if (isRepositoryBindingError(error)) throw error;
      return undefined;
    }
  };
  const [name, email] = await Promise.all([
    readConfigValue("user.name"),
    readConfigValue("user.email"),
  ]);
  throwIfCompareCancelled(cancellationSignal);
  await assertPinnedRepositoryRoot(repositoryRoot, repositoryBinding);
  return name === undefined && email === undefined
    ? undefined
    : {
        ...(name === undefined ? {} : { name }),
        ...(email === undefined ? {} : { email }),
      };
}

async function pinRepositoryRoot(
  repositoryRoot: vscode.Uri,
): Promise<PinnedRepositoryRoot> {
  const requestedPath = nodePath.resolve(repositoryRoot.fsPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error: unknown) {
    throw new Error("Compare repository binding changed before Git could run", {
      cause: error,
    });
  }
  try {
    const filesystemStats = await stat(canonicalPath, { bigint: true });
    return {
      requestedPath,
      canonicalPath,
      device: filesystemStats.dev,
      inode: filesystemStats.ino,
    };
  } catch (error: unknown) {
    throw new Error("Compare repository binding changed before Git could run", {
      cause: error,
    });
  }
}

function createPinnedRepositoryRoot(
  repositoryBinding: CompareRepositoryBinding,
): PinnedRepositoryRoot {
  return {
    requestedPath: repositoryBinding.requestedPath,
    canonicalPath: repositoryBinding.canonicalPath,
    device: repositoryBinding.filesystemIdentity.device,
    inode: repositoryBinding.filesystemIdentity.inode,
  };
}

async function assertPinnedRepositoryRoot(
  pinnedRoot: PinnedRepositoryRoot,
): Promise<void> {
  let currentCanonicalPath: string;
  try {
    currentCanonicalPath = await realpath(pinnedRoot.requestedPath);
    const filesystemStats = await stat(currentCanonicalPath, { bigint: true });
    if (
      currentCanonicalPath !== pinnedRoot.canonicalPath ||
      filesystemStats.dev !== pinnedRoot.device ||
      filesystemStats.ino !== pinnedRoot.inode
    ) {
      throw new Error("repository root identity changed");
    }
  } catch (error: unknown) {
    const bindingError = new Error(
      "Compare repository binding changed before Git could run",
      { cause: error },
    );
    bindingError.name = "CompareRepositoryBindingError";
    throw bindingError;
  }
}

async function runPinnedGitCommand(
  gitCommandRunner: Pick<GitCommandRunner, "run">,
  repositoryRoot: vscode.Uri,
  pinnedRoot: PinnedRepositoryRoot,
  argumentsPassed: readonly string[],
  cancellationSignal?: AbortSignal,
  expectedRepositoryBinding?: CompareRepositoryBinding,
): Promise<GitCommandOutput> {
  if (
    expectedRepositoryBinding !== undefined &&
    !sameRepositoryPath(
      nodePath.resolve(repositoryRoot.fsPath),
      expectedRepositoryBinding.requestedPath,
    )
  ) {
    throw new Error(
      "Compare repository binding does not match the requested repository.",
    );
  }
  if (expectedRepositoryBinding === undefined) {
    await assertPinnedRepositoryRoot(pinnedRoot);
  }
  const output = await gitCommandRunner.run({
    repositoryRoot: pinnedRoot.canonicalPath,
    ...(expectedRepositoryBinding === undefined
      ? {}
      : { rootBinding: expectedRepositoryBinding.rootBinding }),
    arguments: argumentsPassed,
    cancellationSignal,
  });
  if (expectedRepositoryBinding === undefined) {
    await assertPinnedRepositoryRoot(pinnedRoot);
  }
  return output;
}

function isRepositoryBindingError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "CompareRepositoryBindingError"
  );
}

function sameRepositoryPath(leftPath: string, rightPath: string): boolean {
  return (
    nodePath.normalize(leftPath).replace(/[\\/]$/, "") ===
    nodePath.normalize(rightPath).replace(/[\\/]$/, "")
  );
}

const defaultCompareExperienceUi: CompareExperienceUi = {
  showQuickPick: (items, options) =>
    vscode.window.showQuickPick(items, options),
  showInputBox: (options) => vscode.window.showInputBox(options),
  showInformationMessage: (message) =>
    vscode.window.showInformationMessage(message),
  showWarningMessage: (message) => vscode.window.showWarningMessage(message),
  withProgress: (options, task) => vscode.window.withProgress(options, task),
};
