import type * as vscode from "vscode";
import type {
  ConflictFileState,
  ConflictOperationKind,
} from "../conflicts/index.js";

/** Stable command id kept here so activation can register the experience. */
export const conflictExperienceCommandIds = {
  open: "gito.openConflicts",
} as const;

export type ConflictExperiencePreviewPair =
  "base-current" | "base-incoming" | "current-incoming";

export const conflictExperienceLabels: Readonly<{
  readonly keepCurrent: "Keep Current";
  readonly keepIncoming: "Keep Incoming";
  readonly combine: "Combine";
  readonly manual: "Manual (Open Merge Editor)";
  readonly continue: "Continue Operation";
  readonly skip: "Skip Operation Step";
  readonly abort: "Abort Operation";
}> = {
  keepCurrent: "Keep Current",
  keepIncoming: "Keep Incoming",
  combine: "Combine",
  manual: "Manual (Open Merge Editor)",
  continue: "Continue Operation",
  skip: "Skip Operation Step",
  abort: "Abort Operation",
};

export interface ConflictStory {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly operation: ConflictOperationKind;
}

export interface ConflictFileGroup {
  readonly kind: ConflictFileState["kind"];
  readonly label: string;
  readonly files: readonly ConflictFileState[];
}

export interface ConflictFileQuickPickItem extends vscode.QuickPickItem {
  readonly conflictFile: ConflictFileState | undefined;
  readonly isGroupHeader?: boolean;
  readonly accessibilityInformation?: vscode.AccessibilityInformation;
}

export interface ConflictActionQuickPickItem extends vscode.QuickPickItem {
  readonly accessibilityInformation?: vscode.AccessibilityInformation;
  readonly action:
    | "resolve"
    | "preview-base-current"
    | "preview-base-incoming"
    | "preview-current-incoming"
    | "manual"
    | "keep-current"
    | "keep-incoming"
    | "combine"
    | "continue"
    | "skip"
    | "abort";
}

export interface ConflictExperienceUi {
  readonly showQuickPick: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ) => Promise<T | readonly T[] | undefined>;
  readonly showInputBox: (
    options: vscode.InputBoxOptions,
  ) => Promise<string | undefined>;
  readonly showInformationMessage: (
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ) => Promise<string | undefined>;
  readonly showWarningMessage: (
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ) => Promise<string | undefined>;
  readonly showErrorMessage: (message: string) => Promise<string | undefined>;
  /** Opens complete resolution/operation details in a scrollable native editor. */
  readonly showPreviewDocument: (options: {
    readonly title: string;
    readonly content: string;
  }) => Promise<void>;
  readonly withProgress: <T>(
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{
        readonly message?: string;
        readonly increment?: number;
      }>,
      cancellationToken: vscode.CancellationToken,
    ) => Promise<T>,
  ) => Promise<T>;
  readonly executeCommand: (
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ) => Promise<unknown>;
  readonly openTextDocument: (options: {
    readonly content: string;
    readonly language: string;
  }) => Promise<{ readonly uri: vscode.Uri }>;
  /** Opens a multiline editable document and returns its current text. */
  readonly openEditableTextDocument?: (options: {
    readonly content: string;
    readonly language: string;
  }) => Promise<{ readonly uri: vscode.Uri; readonly getText: () => string }>;
}

export interface ConflictExperienceRepositoryProvider {
  readonly getRepositoryRoot: () => Promise<string | undefined>;
}

export interface ConflictExperienceCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}
