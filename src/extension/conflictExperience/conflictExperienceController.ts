import { Buffer } from "node:buffer";
import { extname } from "node:path";
import * as vscode from "vscode";
import {
  ConflictOperationError,
  ConflictService,
  type ConflictFileState,
  type ConflictOperationKind,
  type ConflictRepositorySnapshot,
  type ConflictResolutionChoice,
  type ConflictResolutionPlan,
} from "../conflicts/index.js";
import { redactGitErrorMessage } from "../git/gitErrorFormatting.js";
import { isAbortError } from "../git/gitCommandRunner.js";
import {
  conflictExperienceCommandIds,
  type ConflictActionQuickPickItem,
  type ConflictExperienceCommandRegistry,
  type ConflictExperienceRepositoryProvider,
  type ConflictExperienceUi,
  type ConflictFileQuickPickItem,
  type ConflictExperiencePreviewPair,
} from "./conflictExperienceModels.js";
import {
  buildConflictActionQuickPickItems,
  buildConflictFileQuickPickItems,
  buildConflictStory,
  buildResolutionActionQuickPickItems,
  boundConflictConfirmationText,
  formatConflictConfirmationSummary,
  formatResolutionPreview,
  pairLabel,
  pairSides,
} from "./conflictExperienceView.js";

const operationSkipCommands: Partial<
  Record<ConflictOperationKind, readonly string[]>
> = {
  rebase: ["-c", "core.editor=true", "rebase", "--skip"],
  am: ["-c", "core.editor=true", "am", "--skip"],
  "cherry-pick": ["-c", "core.editor=true", "cherry-pick", "--skip"],
} as const;
const MAX_COMBINED_CONTENT_BYTES = 4 * 1024 * 1024;
const CONFLICT_PREVIEW_SCHEME = "gito-conflict-preview";
const conflictPreviewContents = new Map<string, string>();
let conflictPreviewSequence = 0;
let conflictPreviewProviderRegistration: vscode.Disposable | undefined;
let conflictPreviewCloseListener: vscode.Disposable | undefined;

/** Native, confirmation-first conflict workflow. It never renders a custom diff. */
export class ConflictExperienceController {
  private readonly disposalController = new AbortController();
  private disposed = false;

  public constructor(
    private readonly conflictService: ConflictService,
    private readonly ui: ConflictExperienceUi = createVscodeConflictExperienceUi(),
  ) {}

  /** Cancels inspection and every in-flight mutation owned by this controller. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalController.abort();
    disposeConflictPreviewProvider();
  }

  public async open(repositoryRoot: string): Promise<void> {
    try {
      const snapshot = await this.inspectWithProgress(repositoryRoot);
      if (snapshot.operation === undefined) {
        await this.ui.showInformationMessage(
          "No active Git conflict operation. Start a merge, rebase, cherry-pick, or revert first.",
        );
        return;
      }
      await this.openOperationStory(snapshot);
    } catch (error: unknown) {
      await this.reportError(error);
    }
  }

  private async openOperationStory(
    initialSnapshot: ConflictRepositorySnapshot,
  ): Promise<void> {
    const story = buildConflictStory(initialSnapshot);
    if (story === undefined) return;
    const storyItem: ConflictActionQuickPickItem = {
      label: story.title,
      description: story.summary,
      detail: story.body,
      action: "resolve",
      alwaysShow: true,
      accessibilityInformation: {
        label: `${story.title}, ${story.summary}. ${story.body.replace(/\n/g, " ")}`,
      },
    };
    const operationItems = buildConflictActionQuickPickItems(
      initialSnapshot,
      initialSnapshot.files,
    );
    const selectedAction = singleQuickPick(
      await this.ui.showQuickPick([storyItem, ...operationItems], {
        title: "Conflict Story",
        placeHolder: story.body,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
      }),
    );
    if (selectedAction === undefined) return;
    if (selectedAction.action === "resolve") {
      await this.openFileSelection(initialSnapshot);
      return;
    }
    await this.runOperationAction(initialSnapshot, selectedAction.action);
  }

  private async openFileSelection(
    snapshot: ConflictRepositorySnapshot,
  ): Promise<void> {
    const fileItems = buildConflictFileQuickPickItems(snapshot.files);
    const selectedItems = await this.ui.showQuickPick(fileItems, {
      title: "Select conflict files",
      placeHolder: "Select one or more files to preview or resolve",
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selectedItems === undefined) return;
    const selectedFiles = normalizeSelectedFileItems(selectedItems);
    if (selectedFiles.length === 0) return;
    await this.openFileActions(snapshot, selectedFiles);
  }

  private async openFileActions(
    snapshot: ConflictRepositorySnapshot,
    selectedFiles: readonly ConflictFileState[],
  ): Promise<void> {
    const actionItems = buildResolutionActionQuickPickItems(
      selectedFiles,
      snapshot.operation?.kind,
    );
    const selectedAction = singleQuickPick(
      await this.ui.showQuickPick(actionItems, {
        title: `Resolve ${selectedFiles.length} selected ${selectedFiles.length === 1 ? "file" : "files"}`,
        placeHolder: "Preview first, then choose a resolution",
        ignoreFocusOut: true,
        matchOnDescription: true,
      }),
    );
    if (selectedAction === undefined) return;
    switch (selectedAction.action) {
      case "preview-base-current":
        await this.previewPair(snapshot, selectedFiles, "base-current");
        return;
      case "preview-base-incoming":
        await this.previewPair(snapshot, selectedFiles, "base-incoming");
        return;
      case "preview-current-incoming":
        await this.previewPair(snapshot, selectedFiles, "current-incoming");
        return;
      case "manual":
        await this.openManualEditors(snapshot, selectedFiles);
        return;
      case "keep-current":
        await this.applySafeChoice(snapshot, selectedFiles, "keep-current");
        return;
      case "keep-incoming":
        await this.applySafeChoice(snapshot, selectedFiles, "keep-incoming");
        return;
      case "combine":
        await this.applyCombinedContent(snapshot, selectedFiles);
        return;
      default:
        return;
    }
  }

  private async previewPair(
    snapshot: ConflictRepositorySnapshot,
    selectedFiles: readonly ConflictFileState[],
    pair: ConflictExperiencePreviewPair,
  ): Promise<void> {
    const [leftSide, rightSide] = pairSides(pair);
    for (const conflictFile of selectedFiles) {
      if (conflictFile.kind === "binary" || conflictFile.kind === "submodule") {
        await this.ui.showInformationMessage(
          `${conflictFile.path}: native text diff is unavailable for ${conflictFile.kind} content.`,
        );
        continue;
      }
      const leftDocument = await this.ui.openTextDocument({
        content: decodeSideContent(conflictFile, leftSide),
        language: languageForPath(conflictFile.path),
      });
      const rightDocument = await this.ui.openTextDocument({
        content: decodeSideContent(conflictFile, rightSide),
        language: languageForPath(conflictFile.path),
      });
      await this.ui.executeCommand(
        "vscode.diff",
        leftDocument.uri,
        rightDocument.uri,
        `${conflictFile.path} · ${pairLabel(pair, snapshot.operation?.kind)}`,
      );
    }
  }

  private async openManualEditors(
    snapshot: ConflictRepositorySnapshot,
    selectedFiles: readonly ConflictFileState[],
  ): Promise<void> {
    const selectedSubmodule = selectedFiles.find(
      (conflictFile) => conflictFile.kind === "submodule",
    );
    if (selectedSubmodule !== undefined) {
      await this.ui.showInformationMessage(
        `${selectedSubmodule.path}: submodule sides are not auto-selected. Resolve the gitlink with Git's native tooling, then stage the path.`,
      );
      return;
    }
    const plan = await this.createPlan(snapshot, selectedFiles, "manual");
    const preview = formatResolutionPreview(plan.preview, plan.rollback);
    await this.ui.showPreviewDocument({
      title: `Git'o ${plan.operation} conflict resolution preview`,
      content: preview,
    });
    const selectedAction = await this.ui.showWarningMessage(
      boundConflictConfirmationText(
        `${formatConflictConfirmationSummary(plan)}\n\nManual resolution changes only after you save and stage in the merge editor.`,
      ),
      { modal: true },
      "Open native merge editor",
      "Cancel",
    );
    if (selectedAction !== "Open native merge editor") return;
    for (const action of plan.actions) {
      if (action.type !== "open-merge-editor") continue;
      const editorReadiness = (
        this.conflictService as unknown as {
          readonly assertMergeEditorOpenReady?: (
            plan: ConflictResolutionPlan,
            relativePath: string,
            options?: { readonly cancellationSignal?: AbortSignal },
          ) => Promise<void>;
        }
      ).assertMergeEditorOpenReady;
      if (editorReadiness !== undefined) {
        await editorReadiness.call(
          this.conflictService,
          plan,
          action.path,
          this.operationOptions(),
        );
      }
      const mergeEditorCommand = this.conflictService.createMergeEditorCommand(
        plan.repositoryRoot,
        action.path,
      );
      await this.ui.executeCommand(
        mergeEditorCommand.commandIdentifier,
        ...mergeEditorArguments(mergeEditorCommand.arguments[0]),
      );
    }
  }

  private async applySafeChoice(
    snapshot: ConflictRepositorySnapshot,
    selectedFiles: readonly ConflictFileState[],
    choice: Extract<ConflictResolutionChoice, "keep-current" | "keep-incoming">,
  ): Promise<void> {
    const plan = await this.createPlan(snapshot, selectedFiles, choice);
    await this.applyPlanWithConfirmation(plan);
  }

  private async applyCombinedContent(
    snapshot: ConflictRepositorySnapshot,
    selectedFiles: readonly ConflictFileState[],
  ): Promise<void> {
    const requests = [];
    if (this.ui.openEditableTextDocument === undefined) {
      throw new ConflictOperationError(
        "operation-unavailable",
        "Multiline combine requires an editable VS Code document workflow.",
      );
    }
    for (const conflictFile of selectedFiles) {
      const editableDocument = await this.ui.openEditableTextDocument({
        content: decodeWorkingTreeContent(conflictFile),
        language: languageForPath(conflictFile.path),
      });
      const selectedAction = await this.ui.showWarningMessage(
        `Edit ${conflictFile.path} in the opened document, save it, then continue.`,
        { modal: true },
        "Use edited document",
        "Cancel",
      );
      if (selectedAction !== "Use edited document") return;
      const editedText = editableDocument.getText();
      if (Buffer.byteLength(editedText, "utf8") > MAX_COMBINED_CONTENT_BYTES) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Combined content for ${conflictFile.path} exceeds the ${MAX_COMBINED_CONTENT_BYTES} byte safety cap. Resolve it manually instead.`,
        );
      }
      requests.push({
        path: conflictFile.path,
        choice: "combine" as const,
        combinedContent: Buffer.from(editedText, "utf8"),
      });
    }
    const plan = await this.conflictService.previewResolutions(
      snapshot.repositoryRoot,
      requests,
      this.operationOptions(),
    );
    await this.applyPlanWithConfirmation(plan);
  }

  private async createPlan(
    snapshot: ConflictRepositorySnapshot,
    selectedFiles: readonly ConflictFileState[],
    choice: ConflictResolutionChoice,
  ): Promise<ConflictResolutionPlan> {
    return this.conflictService.previewResolutions(
      snapshot.repositoryRoot,
      selectedFiles.map((conflictFile) => ({
        path: conflictFile.path,
        choice,
      })),
      this.operationOptions(),
    );
  }

  private async applyPlanWithConfirmation(
    plan: ConflictResolutionPlan,
  ): Promise<void> {
    const preview = formatResolutionPreview(plan.preview, plan.rollback);
    await this.ui.showPreviewDocument({
      title: `Git'o ${plan.operation} conflict resolution preview`,
      content: preview,
    });
    const applyResult = await this.conflictService.applyResolution(
      { ...plan, preview },
      {
        confirm: async () =>
          (await this.ui.showWarningMessage(
            boundConflictConfirmationText(
              `${formatConflictConfirmationSummary(plan)}\n\nOnly the selected paths will change and be staged.`,
            ),
            { modal: true },
            "Apply resolution",
            "Cancel",
          )) === "Apply resolution",
      },
      this.operationOptions(),
    );
    await this.ui.showInformationMessage(
      `Applied resolution to ${applyResult.appliedPaths.length} selected ${applyResult.appliedPaths.length === 1 ? "file" : "files"}. ${applyResult.snapshotAfterApply.hasUnmergedEntries ? "More conflicts remain." : "No unresolved conflicts remain."}`,
    );
  }

  private async runOperationAction(
    snapshot: ConflictRepositorySnapshot,
    action: ConflictActionQuickPickItem["action"],
  ): Promise<void> {
    return this.withConflictProgress(
      `Running ${snapshot.operation?.kind ?? "Git"} ${action}`,
      (cancellationSignal) =>
        this.runOperationActionWithSignal(snapshot, action, cancellationSignal),
    );
  }

  private async runOperationActionWithSignal(
    snapshot: ConflictRepositorySnapshot,
    action: ConflictActionQuickPickItem["action"],
    cancellationSignal: AbortSignal,
  ): Promise<void> {
    if (action === "continue") {
      await this.conflictService.continue(
        snapshot.repositoryRoot,
        this.createOperationConfirmation("continue", snapshot),
        snapshot.fingerprint,
        this.operationOptions(cancellationSignal),
      );
      await this.ui.showInformationMessage(
        `${snapshot.operation?.label ?? "Git operation"} continued.`,
      );
      return;
    }
    if (action === "abort") {
      await this.conflictService.abort(
        snapshot.repositoryRoot,
        this.createOperationConfirmation("abort", snapshot),
        snapshot.fingerprint,
        this.operationOptions(cancellationSignal),
      );
      await this.ui.showInformationMessage(
        `${snapshot.operation?.label ?? "Git operation"} aborted and repository state restored.`,
      );
      return;
    }
    if (action === "skip") {
      await this.skipOperation(snapshot, cancellationSignal);
    }
  }

  private createOperationConfirmation(
    action: "continue" | "abort",
    snapshot: ConflictRepositorySnapshot,
  ): {
    readonly confirm: (preview: string) => Promise<boolean>;
  } {
    return {
      confirm: async (preview) => {
        await this.ui.showPreviewDocument({
          title: `Git'o ${snapshot.operation?.kind ?? "Git"} ${action} preview`,
          content: preview,
        });
        const operationName = snapshot.operation?.label ?? "Git operation";
        const summary = boundConflictConfirmationText(
          [
            `${capitalizeOperationName(snapshot.operation?.kind)} ${action}`,
            `Repository: ${snapshot.repositoryRoot}`,
            `Operation: ${operationName}`,
            action === "abort"
              ? "Risk: Git may discard the in-progress operation conflict state."
              : "Risk: Git advances using the currently staged resolution.",
            "Full exact operation preview opened in a scrollable native document.",
            "Confirm only after checking operation, repository, and current staged state.",
          ].join("\n"),
        );
        return (
          (await this.ui.showWarningMessage(
            summary,
            { modal: true },
            action === "abort" ? "Abort operation" : "Continue operation",
            "Cancel",
          )) === (action === "abort" ? "Abort operation" : "Continue operation")
        );
      },
    };
  }

  private async skipOperation(
    snapshot: ConflictRepositorySnapshot,
    cancellationSignal: AbortSignal = this.disposalController.signal,
  ): Promise<void> {
    const operation = snapshot.operation;
    if (operation === undefined) {
      throw new ConflictOperationError(
        "operation-unavailable",
        "Skip is available only for an active rebase, patch apply, or cherry-pick step.",
      );
    }
    const skipCommand = operationSkipCommands[operation.kind];
    if (skipCommand === undefined)
      throw new ConflictOperationError(
        "operation-unavailable",
        "Skip is available only for an active rebase, patch apply, or cherry-pick step.",
      );
    const exactPreview = [
      `Operation: ${operation.kind}`,
      `Repository: ${snapshot.repositoryRoot}`,
      `Command: git ${skipCommand.join(" ")}`,
      `Current state: ${operation.label}`,
    ].join("\n");
    await this.ui.showPreviewDocument({
      title: `Git'o ${operation.kind} skip preview`,
      content: exactPreview,
    });
    const confirmationSummary = boundConflictConfirmationText(
      [
        `${capitalizeOperationName(operation.kind)} skip`,
        `Repository: ${snapshot.repositoryRoot}`,
        `Operation: ${operation.label}`,
        "Risk: Git discards the current operation step.",
        "Full exact operation preview opened in a scrollable native document.",
        "Confirm only after checking operation, repository, and current state.",
      ].join("\n"),
    );
    await this.conflictService.skip(
      snapshot.repositoryRoot,
      {
        confirm: async () =>
          (await this.ui.showWarningMessage(
            boundConflictConfirmationText(
              `${confirmationSummary}\n\nUnrelated files stay outside this operation step.`,
            ),
            { modal: true },
            "Skip operation step",
            "Cancel",
          )) === "Skip operation step",
      },
      snapshot.fingerprint,
      this.operationOptions(cancellationSignal),
    );
    await this.ui.showInformationMessage(`${operation.label} step skipped.`);
  }

  private async inspectWithProgress(
    repositoryRoot: string,
  ): Promise<ConflictRepositorySnapshot> {
    return this.ui.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Loading Conflict Story",
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const cancellation = cancellationSignalFromToken(
          cancellationToken,
          this.disposalController.signal,
        );
        try {
          return await this.conflictService.inspect(repositoryRoot, {
            cancellationSignal: cancellation.signal,
          });
        } finally {
          cancellation.dispose();
        }
      },
    );
  }

  private operationOptions(
    cancellationSignal = this.disposalController.signal,
  ): { readonly cancellationSignal: AbortSignal } {
    return { cancellationSignal };
  }

  private async withConflictProgress<T>(
    title: string,
    operation: (cancellationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.ui.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const cancellation = cancellationSignalFromToken(
          cancellationToken,
          this.disposalController.signal,
        );
        try {
          return await operation(cancellation.signal);
        } finally {
          cancellation.dispose();
        }
      },
    );
  }

  private async reportError(error: unknown): Promise<void> {
    if (this.disposalController.signal.aborted || isAbortError(error)) return;
    const message =
      error instanceof ConflictOperationError
        ? redactGitErrorMessage(error.message)
        : "Git conflict operation failed. Review the repository state and try again.";
    await this.ui.showErrorMessage(message);
  }
}

export function registerConflictExperienceCommands(
  commandRegistry: ConflictExperienceCommandRegistry,
  controller: ConflictExperienceController,
  repositoryProvider: ConflictExperienceRepositoryProvider,
): readonly vscode.Disposable[] {
  return [
    commandRegistry.registerCommand(conflictExperienceCommandIds.open, () =>
      repositoryProvider.getRepositoryRoot().then((repositoryRoot) => {
        if (repositoryRoot === undefined) {
          return undefined;
        }
        return controller.open(repositoryRoot);
      }),
    ),
  ];
}

export function createVscodeConflictExperienceUi(): ConflictExperienceUi {
  ensureConflictPreviewProvider();
  return {
    showQuickPick: (items, options) =>
      Promise.resolve(vscode.window.showQuickPick(items, options)),
    showInputBox: (options) =>
      Promise.resolve(vscode.window.showInputBox(options)),
    showInformationMessage: (message, options, ...items) =>
      options === undefined
        ? Promise.resolve(
            vscode.window.showInformationMessage(message, ...items),
          )
        : Promise.resolve(
            vscode.window.showInformationMessage(message, options, ...items),
          ),
    showWarningMessage: (message, options, ...items) =>
      options === undefined
        ? Promise.resolve(vscode.window.showWarningMessage(message, ...items))
        : Promise.resolve(
            vscode.window.showWarningMessage(message, options, ...items),
          ),
    showErrorMessage: (message) =>
      Promise.resolve(vscode.window.showErrorMessage(message)),
    showPreviewDocument: async ({ title, content }) => {
      const safeTitle = sanitizeConflictPreviewTitle(title);
      const documentUri = vscode.Uri.parse(
        `${CONFLICT_PREVIEW_SCHEME}:/${encodeURIComponent(safeTitle)}-${++conflictPreviewSequence}.txt`,
      );
      const documentKey = documentUri.toString();
      conflictPreviewContents.set(documentKey, content);
      try {
        const document = await vscode.workspace.openTextDocument(documentUri);
        await vscode.window.showTextDocument(document, {
          preview: false,
          // Put the exact preview in the active editor before any destructive
          // confirmation modal is shown. The modal remains the transaction gate.
          preserveFocus: false,
        });
      } catch (error: unknown) {
        conflictPreviewContents.delete(documentKey);
        throw error;
      }
    },
    withProgress: (options, task) =>
      Promise.resolve(vscode.window.withProgress(options, task)),
    executeCommand: (commandIdentifier, ...argumentsPassed) =>
      Promise.resolve(
        vscode.commands.executeCommand(commandIdentifier, ...argumentsPassed),
      ),
    openTextDocument: ({ content, language }) =>
      Promise.resolve(vscode.workspace.openTextDocument({ content, language })),
    openEditableTextDocument: async ({ content, language }) => {
      const document = await vscode.workspace.openTextDocument({
        content,
        language,
      });
      await vscode.window.showTextDocument(document);
      return { uri: document.uri, getText: () => document.getText() };
    },
  };
}

function ensureConflictPreviewProvider(): void {
  if (conflictPreviewProviderRegistration !== undefined) return;
  conflictPreviewProviderRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      CONFLICT_PREVIEW_SCHEME,
      {
        provideTextDocumentContent: (uri) =>
          conflictPreviewContents.get(uri.toString()) ?? "",
      },
    );
  conflictPreviewCloseListener = vscode.workspace.onDidCloseTextDocument(
    (document) => {
      if (document.uri.scheme === CONFLICT_PREVIEW_SCHEME) {
        conflictPreviewContents.delete(document.uri.toString());
      }
    },
  );
}

function disposeConflictPreviewProvider(): void {
  conflictPreviewContents.clear();
  conflictPreviewProviderRegistration?.dispose();
  conflictPreviewProviderRegistration = undefined;
  conflictPreviewCloseListener?.dispose();
  conflictPreviewCloseListener = undefined;
}

function sanitizeConflictPreviewTitle(title: string): string {
  const sanitizedTitle = title
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return sanitizedTitle.length > 0 ? sanitizedTitle : "Conflict preview";
}

function capitalizeOperationName(
  operation: ConflictOperationKind | undefined,
): string {
  return operation === "cherry-pick"
    ? "Cherry-pick"
    : operation === undefined
      ? "Git operation"
      : operation.charAt(0).toUpperCase() + operation.slice(1);
}

function normalizeSelectedFileItems(
  selectedItems:
    ConflictFileQuickPickItem | readonly ConflictFileQuickPickItem[],
): readonly ConflictFileState[] {
  const items: readonly ConflictFileQuickPickItem[] = isFileItemArray(
    selectedItems,
  )
    ? selectedItems
    : [selectedItems];
  return items
    .map((item) => item.conflictFile)
    .filter(
      (conflictFile): conflictFile is ConflictFileState =>
        conflictFile !== undefined,
    );
}

function isFileItemArray(
  selectedItems:
    ConflictFileQuickPickItem | readonly ConflictFileQuickPickItem[],
): selectedItems is readonly ConflictFileQuickPickItem[] {
  return Array.isArray(selectedItems);
}

function decodeSideContent(
  conflictFile: ConflictFileState,
  side: "base" | "current" | "incoming",
): string {
  const content = conflictFile.stages[side]?.content;
  return content === undefined ? "" : Buffer.from(content).toString("utf8");
}

function decodeWorkingTreeContent(conflictFile: ConflictFileState): string {
  return conflictFile.workingTreeContent === undefined
    ? ""
    : Buffer.from(conflictFile.workingTreeContent).toString("utf8");
}

function mergeEditorArguments(
  mergeEditorArgument: unknown,
): readonly [unknown] {
  if (typeof mergeEditorArgument !== "string") return [mergeEditorArgument];
  const filesystemPath = mergeEditorArgument;
  const uriFactory = (
    vscode.Uri as unknown as
      { readonly file?: (path: string) => unknown } | undefined
  )?.file;
  return [
    uriFactory === undefined ? filesystemPath : uriFactory(filesystemPath),
  ];
}

function languageForPath(relativePath: string): string {
  const extension = extname(relativePath).slice(1);
  return extension.length === 0 ? "plaintext" : extension;
}

interface CancellationSignalHandle {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

function cancellationSignalFromToken(
  cancellationToken: vscode.CancellationToken,
  disposalSignal?: AbortSignal,
): CancellationSignalHandle {
  const controller = new AbortController();
  if (cancellationToken.isCancellationRequested) controller.abort();
  const cancellationSubscription = cancellationToken.onCancellationRequested(
    () => controller.abort(),
  );
  const disposalHandler = (): void => controller.abort();
  if (disposalSignal?.aborted === true) controller.abort();
  disposalSignal?.addEventListener("abort", disposalHandler, { once: true });
  const dispose = (): void => {
    cancellationSubscription.dispose();
    disposalSignal?.removeEventListener("abort", disposalHandler);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  if (controller.signal.aborted) dispose();
  return { signal: controller.signal, dispose };
}

function singleQuickPick<T>(
  selection: T | readonly T[] | undefined,
): T | undefined {
  if (selection === undefined || Array.isArray(selection)) return undefined;
  return selection as T;
}
