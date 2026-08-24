import * as vscode from "vscode";
import {
  conflictSideExplanations,
  conflictSideLabels,
  conflictOperationSideLabels,
  operationLabel,
  type ConflictFileState,
  type ConflictOperationState,
  type ConflictOperationKind,
  type ConflictRepositorySnapshot,
  type ConflictResolutionPlan,
  type ConflictRollbackPlan,
  type ConflictSide,
} from "../conflicts/index.js";
import type {
  ConflictActionQuickPickItem,
  ConflictFileGroup,
  ConflictFileQuickPickItem,
  ConflictExperiencePreviewPair,
  ConflictStory,
} from "./conflictExperienceModels.js";
import { conflictExperienceLabels } from "./conflictExperienceModels.js";

const conflictKindLabels: Readonly<Record<ConflictFileState["kind"], string>> =
  {
    content: "Content conflicts",
    "add-add": "Add/add conflicts",
    "modify-delete": "Modify/delete conflicts",
    "delete-delete": "Delete/delete conflicts",
    rename: "Rename conflicts",
    binary: "Binary conflicts",
    submodule: "Submodule conflicts",
    unknown: "Other conflicts",
  };

const conflictKindOrder: readonly ConflictFileState["kind"][] = [
  "content",
  "add-add",
  "modify-delete",
  "delete-delete",
  "rename",
  "binary",
  "submodule",
  "unknown",
];

export const CONFLICT_CONFIRMATION_MAX_LINES = 12;
export const CONFLICT_CONFIRMATION_MAX_BYTES = 2048;

/** Explains the operation in terms users can act on, with no AI/confidence claims. */
export function buildConflictStory(
  snapshot: ConflictRepositorySnapshot,
): ConflictStory | undefined {
  const operation = snapshot.operation;
  if (operation === undefined) return undefined;
  const currentBranch = snapshot.currentBranchName ?? "detached HEAD";
  const sourceCommit = operation.sourceCommit ?? "unknown commit";
  const operationSides = conflictOperationSideLabels(operation.kind);
  const fileCount = snapshot.files.length;
  const title = `${operationLabel(operation.kind)} · ${currentBranch}`;
  const summary = `${operation.label} on ${currentBranch} · ${fileCount} unresolved ${fileCount === 1 ? "file" : "files"}`;
  const body = [
    `${operation.label} is in progress on checked-out branch ${currentBranch}.`,
    `Target: ${formatTargetSource(operation, currentBranch)}.`,
    `Source: ${formatIncomingSource(operation, sourceCommit)}.`,
    `Base: ${conflictSideExplanations.base}`,
    `${operationSides.current}: ${operationSides.currentExplanation}`,
    `${operationSides.incoming}: ${operationSides.incomingExplanation}`,
    ...(operation.kind === "merge"
      ? [
          "Current (checked-out branch at operation start): " +
            `${currentBranch}. ${conflictSideExplanations.current}`,
          "Incoming (branch/commit being applied): " +
            `${formatIncomingSource(operation, sourceCommit)}. ${conflictSideExplanations.incoming}`,
        ]
      : []),
  ].join("\n");
  return { title, summary, body, operation: operation.kind };
}

export function groupConflictFiles(
  files: readonly ConflictFileState[],
): readonly ConflictFileGroup[] {
  const filesByKind = new Map<ConflictFileState["kind"], ConflictFileState[]>();
  for (const conflictFile of files) {
    const groupedFiles = filesByKind.get(conflictFile.kind) ?? [];
    groupedFiles.push(conflictFile);
    filesByKind.set(conflictFile.kind, groupedFiles);
  }
  return conflictKindOrder.flatMap((kind) => {
    const groupedFiles = filesByKind.get(kind);
    if (groupedFiles === undefined || groupedFiles.length === 0) return [];
    return [
      {
        kind,
        label: `${conflictKindLabels[kind]} · ${groupedFiles.length}`,
        files: groupedFiles.sort((leftFile, rightFile) =>
          leftFile.path.localeCompare(rightFile.path),
        ),
      },
    ];
  });
}

export function buildConflictFileQuickPickItems(
  files: readonly ConflictFileState[],
): readonly ConflictFileQuickPickItem[] {
  const items: ConflictFileQuickPickItem[] = [];
  for (const group of groupConflictFiles(files)) {
    items.push({
      label: group.label,
      kind: vscode.QuickPickItemKind.Separator,
      conflictFile: undefined,
      isGroupHeader: true,
    });
    for (const conflictFile of group.files) {
      items.push({
        label: conflictFile.path,
        description: describeConflictFile(conflictFile),
        detail: describeStageAvailability(conflictFile),
        alwaysShow: true,
        accessibilityInformation: {
          label: `${conflictFile.path}, ${describeConflictFile(conflictFile)}, unresolved conflict`,
        },
        conflictFile,
      });
    }
  }
  return items;
}

export function buildConflictActionQuickPickItems(
  snapshot: ConflictRepositorySnapshot,
  selectedFiles: readonly ConflictFileState[],
): readonly ConflictActionQuickPickItem[] {
  const canOpenMergeEditor = selectedFiles.every(
    (conflictFile) =>
      conflictFile.kind !== "binary" && conflictFile.kind !== "submodule",
  );
  const actions: ConflictActionQuickPickItem[] =
    selectedFiles.length === 0
      ? []
      : [
          {
            label: "Resolve selected files",
            description: `${selectedFiles.length} selected · choose a safe resolution`,
            accessibilityInformation: {
              label: "Resolve selected files, choose a safe resolution",
            },
            action: "resolve",
          },
          {
            label: "Preview Base ↔ Current",
            description: "Native VS Code diff for the selected files",
            action: "preview-base-current",
          },
          {
            label: "Preview Base ↔ Incoming",
            description: "Native VS Code diff for the selected files",
            action: "preview-base-incoming",
          },
          {
            label: "Preview Current ↔ Incoming",
            description: "Native VS Code diff for the selected files",
            action: "preview-current-incoming",
          },
          ...(canOpenMergeEditor
            ? [
                {
                  label: "Open native merge editor",
                  description:
                    "Base, Current, and Incoming in VS Code's merge editor",
                  action: "manual" as const,
                },
              ]
            : []),
        ];
  if (snapshot.canContinue) {
    actions.push({
      label: conflictExperienceLabels.continue,
      description: "Advance the in-progress operation",
      action: "continue",
    });
  }
  if (isSkipValid(snapshot.operation)) {
    actions.push({
      label: conflictExperienceLabels.skip,
      description: "Skip the current operation step",
      action: "skip",
    });
  }
  if (snapshot.canAbort && snapshot.operation?.canAbort === true) {
    actions.push({
      label: conflictExperienceLabels.abort,
      description: "Restore the repository before this operation",
      action: "abort",
    });
  }
  return actions.map((action) => ({
    ...action,
    accessibilityInformation: {
      label: `${action.label}${action.description === undefined ? "" : `, ${action.description}`}`,
    },
  }));
}

export function buildResolutionActionQuickPickItems(
  selectedFiles: readonly ConflictFileState[],
  operation?: ConflictOperationKind,
): readonly ConflictActionQuickPickItem[] {
  const hasCombineIneligibleFile = selectedFiles.some(
    (conflictFile) =>
      conflictFile.kind === "binary" || conflictFile.kind === "submodule",
  );
  const hasSubmoduleFile = selectedFiles.some(
    (conflictFile) => conflictFile.kind === "submodule",
  );
  const actions: ConflictActionQuickPickItem[] = [
    {
      label: "Preview Base ↔ Current",
      description: "Native VS Code diff for the selected files",
      action: "preview-base-current",
    },
    {
      label: "Preview Base ↔ Incoming",
      description: "Native VS Code diff for the selected files",
      action: "preview-base-incoming",
    },
    {
      label: "Preview Current ↔ Incoming",
      description: "Native VS Code diff for the selected files",
      action: "preview-current-incoming",
    },
    ...(hasSubmoduleFile
      ? []
      : [
          {
            label: conflictExperienceLabels.keepCurrent,
            description: `Use ${operation === undefined ? "Current (checked-out branch)" : conflictOperationSideLabels(operation).current} for every selected file`,
            action: "keep-current" as const,
          },
          {
            label: conflictExperienceLabels.keepIncoming,
            description: `Use ${operation === undefined ? "Incoming (operation source)" : conflictOperationSideLabels(operation).incoming} for every selected file`,
            action: "keep-incoming" as const,
          },
        ]),
  ];
  if (!hasCombineIneligibleFile) {
    actions.push({
      label: conflictExperienceLabels.manual,
      description: "Open each selected file in the native merge editor",
      action: "manual",
    });
  } else if (hasSubmoduleFile) {
    actions.push({
      label: "Resolve submodule manually",
      description:
        "Choose the gitlink in Git's native tooling, then stage the resolved submodule path",
      action: "manual",
    });
  }
  if (!hasCombineIneligibleFile) {
    actions.splice(2, 0, {
      label: conflictExperienceLabels.combine,
      description: "Enter explicit combined content before applying",
      action: "combine",
    });
  }
  return actions.map((action) => ({
    ...action,
    accessibilityInformation: {
      label: `${action.label}${action.description === undefined ? "" : `, ${action.description}`}`,
    },
  }));
}

export function formatRecoveryPlan(rollbackPlan: ConflictRollbackPlan): string {
  return [
    "Recovery plan saved for this resolution.",
    "Automatic rollback runs on any partial transactional apply failure; manual editor plans never auto-apply.",
    rollbackPlan.warning,
    ...rollbackPlan.commandPlan.map((command) => `  ${command}`),
  ].join("\n");
}

export function formatResolutionPreview(
  preview: string,
  rollbackPlan: ConflictRollbackPlan,
): string {
  return `${preview}\n\n${formatRecoveryPlan(rollbackPlan)}`;
}

/** Small modal summary; the exact resolution plan is opened natively first. */
export function formatConflictConfirmationSummary(
  plan: ConflictResolutionPlan,
): string {
  const selectedPaths = plan.requests.map((request) => request.path);
  const pathReadout =
    selectedPaths.length === 0
      ? "none"
      : `${selectedPaths.slice(0, 2).join(", ")}${selectedPaths.length > 2 ? `, +${selectedPaths.length - 2} more` : ""}`;
  return boundConflictConfirmationText(
    [
      `${capitalizeOperation(plan.operation)} conflict resolution`,
      `Repository: ${shortConflictConfirmationField(plan.repositoryRoot)}`,
      `Selected paths: ${selectedPaths.length} (${pathReadout})`,
      `Action: ${plan.requiresManualEditing ? "manual merge-editor editing" : "apply selected resolution and stage paths"}`,
      `Recovery: Recovery plan saved for this resolution. ${shortConflictConfirmationField(plan.rollback.warning)}`,
      `Recovery command: ${shortConflictConfirmationField(plan.rollback.commandPlan[0] ?? "saved rollback plan")}`,
      "Full exact resolution preview opened in a scrollable native document.",
      "Confirm only after checking operation, repository, selected paths, and recovery route.",
      "Only selected paths change; unrelated files stay outside this plan.",
    ].join("\n"),
  );
}

function shortConflictConfirmationField(value: string): string {
  return value.length <= 280 ? value : `${value.slice(0, 279)}…`;
}

export function boundConflictConfirmationText(value: string): string {
  const lines = value.split(/\r?\n/);
  const lineLimited = lines.slice(0, CONFLICT_CONFIRMATION_MAX_LINES);
  if (lines.length > CONFLICT_CONFIRMATION_MAX_LINES)
    lineLimited[lineLimited.length - 1] =
      "Full exact preview is open in the native document.";
  let bounded = lineLimited.join("\n");
  while (
    byteLength(bounded) > CONFLICT_CONFIRMATION_MAX_BYTES &&
    bounded.length > 0
  ) {
    bounded = bounded.slice(0, Math.max(0, bounded.length - 1));
  }
  return bounded;
}

export function pairLabel(
  pair: ConflictExperiencePreviewPair,
  operation?: ConflictOperationKind,
): string {
  const operationSideLabels =
    operation === undefined || operation === "merge"
      ? undefined
      : conflictOperationSideLabels(operation);
  const currentLabel =
    operationSideLabels?.current ?? conflictSideLabels.current;
  const incomingLabel =
    operationSideLabels?.incoming ?? conflictSideLabels.incoming;
  switch (pair) {
    case "base-current":
      return `${conflictSideLabels.base} ↔ ${currentLabel}`;
    case "base-incoming":
      return `${conflictSideLabels.base} ↔ ${incomingLabel}`;
    case "current-incoming":
      return `${currentLabel} ↔ ${incomingLabel}`;
  }
}

export function pairSides(
  pair: ConflictExperiencePreviewPair,
): readonly [ConflictSide, ConflictSide] {
  switch (pair) {
    case "base-current":
      return ["base", "current"];
    case "base-incoming":
      return ["base", "incoming"];
    case "current-incoming":
      return ["current", "incoming"];
  }
}

export function isSkipValid(
  operation: ConflictOperationState | undefined,
): boolean {
  return (
    operation?.kind === "rebase" ||
    operation?.kind === "am" ||
    operation?.kind === "cherry-pick"
  );
}

function formatTargetSource(
  operation: ConflictOperationState,
  currentBranch: string,
): string {
  const targetRef = operation.targetRef ?? currentBranch;
  return operation.targetCommit === undefined ||
    targetRef === operation.targetCommit
    ? targetRef
    : `${targetRef} @ ${operation.targetCommit}`;
}

function formatIncomingSource(
  operation: ConflictOperationState,
  sourceCommit: string,
): string {
  const abbreviatedCommit =
    sourceCommit.length > 12 ? `${sourceCommit.slice(0, 12)}…` : sourceCommit;
  return `${operation.sourceDescription} (${abbreviatedCommit})`;
}

function capitalizeOperation(operation: ConflictOperationKind): string {
  return operation === "cherry-pick"
    ? "Cherry-pick"
    : operation.charAt(0).toUpperCase() + operation.slice(1);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function describeConflictFile(conflictFile: ConflictFileState): string {
  return conflictKindLabels[conflictFile.kind];
}

function describeStageAvailability(conflictFile: ConflictFileState): string {
  const availableSides = (["base", "current", "incoming"] as const).filter(
    (side) => conflictFile.stages[side]?.exists === true,
  );
  return availableSides.length === 0
    ? "No stage content available"
    : `Stages: ${availableSides.join(", ")}`;
}
