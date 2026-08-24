import * as vscode from "vscode";
import type {
  GitOperationKind,
  GitOperationPreview,
  GitOperationResult,
} from "../operations/index.js";
import type {
  OperationsExperienceAction,
  OperationsExperienceQuickPickItem,
  OperationsStateBanner,
} from "./operationsExperienceModels.js";

export const OPERATION_CONFIRMATION_MAX_LINES = 12;
export const OPERATION_CONFIRMATION_MAX_BYTES = 2048;

const categoryItems = [
  {
    action: "stash",
    label: "$(archive) Save work with Stash",
    description: "Create, inspect, apply, pop, drop, or branch from stashes",
    detail:
      "Safe default: preview first; applying and dropping require confirmation.",
    category: "Save and share",
  },
  {
    action: "tags",
    label: "$(bookmark) Tags",
    description: "Create, delete, or push a tag",
    detail: "Exact tag ref and target commit are shown before changes.",
    category: "Save and share",
  },
  {
    action: "patch",
    label: "$(diff) Patches",
    description: "Create a patch or check/apply one",
    detail: "Patch text is inspected before any apply.",
    category: "Save and share",
  },
  {
    action: "history",
    label: "$(git-commit) Change history",
    description: "Merge, cherry-pick, revert, or reset",
    detail: "Refs, commits, working-tree impact, and recovery are explicit.",
    category: "Rewrite and integrate",
  },
  {
    action: "rebase",
    label: "$(git-merge) Rebase",
    description: "Start, continue, skip, or abort",
    detail: "Active rebase state is surfaced as a banner above this menu.",
    category: "Rewrite and integrate",
  },
  {
    action: "bisect",
    label: "$(search) Bisect",
    description: "Find the first bad commit",
    detail: "Each good/bad/skip step is previewed and cancellable.",
    category: "Rewrite and integrate",
  },
  {
    action: "reflog",
    label: "$(history) Reflog and recovery",
    description: "Inspect history or recover a commit",
    detail: "Recovery target, reset mode, and rollback route are shown.",
    category: "Rewrite and integrate",
  },
  {
    action: "branches",
    label: "$(branch) Branches",
    description: "Rename a branch or set its upstream",
    detail: "Branch refs are exact and stale selection is rejected.",
    category: "Repository",
  },
  {
    action: "remotes",
    label: "$(cloud) Remotes",
    description: "Add, rename, remove, or prune a remote",
    detail: "Remote names and URLs are read back; credentials stay redacted.",
    category: "Repository",
  },
  {
    action: "network",
    label: "$(sync) Fetch, pull, push",
    description: "Synchronize local and remote refs",
    detail:
      "Force modes and exact refspecs are called out before confirmation.",
    category: "Repository",
  },
  {
    action: "clean",
    label: "$(trash) Clean untracked files",
    description: "Preview candidates, then remove only confirmed paths",
    detail: "Preview is read-only. Removal has no Git recovery route.",
    category: "Repository",
  },
] as const satisfies readonly {
  readonly action: OperationsExperienceAction;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly category: string;
}[];

export function buildOperationsMenuItems(
  stateBanner?: OperationsStateBanner,
): readonly OperationsExperienceQuickPickItem[] {
  const items: OperationsExperienceQuickPickItem[] = [];
  if (
    stateBanner?.operation !== undefined &&
    stateBanner.operation !== "bisect"
  ) {
    const operationLabel = capitalizeWords(stateBanner.operation);
    items.push({
      action: "continue",
      label: `$(warning) Active ${operationLabel}: Continue`,
      description: stateBanner.summary,
      detail: `${stateBanner.repositoryRoot}\nContinue after resolving files; preview and confirmation required.`,
      category: "Active operation",
      alwaysShow: true,
    });
    if (stateBanner.operation === "rebase") {
      items.push({
        action: "skip",
        label: `$(debug-step-over) Active ${operationLabel}: Skip step`,
        description:
          "Discard the current rebase step after explicit confirmation",
        detail:
          "The skipped commit is not applied. Rebase state remains explicit.",
        category: "Active operation",
        alwaysShow: true,
      });
    }
    items.push({
      action: "abort",
      label: `$(circle-slash) Active ${operationLabel}: Abort`,
      description: "Restore the pre-operation branch state",
      detail:
        "Abort is reversible only through the operation's own recovery state; confirm exact repository first.",
      category: "Active operation",
      alwaysShow: true,
    });
  }
  let previousCategory: string | undefined;
  for (const categoryItem of categoryItems) {
    if (categoryItem.category !== previousCategory) {
      items.push({
        action: categoryItem.action,
        label: categoryItem.category,
        kind: vscode.QuickPickItemKind.Separator,
        category: categoryItem.category,
      });
      previousCategory = categoryItem.category;
    }
    items.push({ ...categoryItem });
  }
  return items.map((item) =>
    item.kind === vscode.QuickPickItemKind.Separator
      ? item
      : {
          ...item,
          accessibilityInformation: {
            label: `${item.label}${item.description === undefined ? "" : `, ${item.description}`}`,
          },
        },
  );
}

export interface OperationRiskReadout {
  readonly reversibility: string;
  readonly recovery: string;
  readonly impact: string;
}

export function buildOperationRiskReadout(
  preview: GitOperationPreview,
): OperationRiskReadout {
  const irreversibleOperations = new Set<GitOperationKind>([
    "clean.execute",
    "reset",
    "reflog.recover",
    "tag.delete",
    "remote.remove",
    "push",
  ]);
  const riskyForcePush =
    preview.operation === "push" &&
    preview.displayArguments.includes("--force");
  const exactForceLeasePush =
    preview.operation === "push" &&
    preview.displayArguments.some((argument) =>
      argument.startsWith("--force-with-lease="),
    );
  const isIrreversible =
    irreversibleOperations.has(preview.operation) || riskyForcePush;
  const impact = preview.confirmationPlan.summary;
  if (preview.operation === "clean.execute") {
    return {
      impact,
      reversibility:
        "Irreversible: untracked files/directories are removed from disk.",
      recovery: "No Git recovery route. Keep a copy or cancel.",
    };
  }
  if (exactForceLeasePush) {
    return {
      impact,
      reversibility:
        "High impact: remote history can be rewritten, guarded by an exact remote OID lease.",
      recovery:
        "Recovery route: inspect the remote reflog/provider recovery; a changed remote ref is refused.",
    };
  }
  if (isIrreversible) {
    return {
      impact,
      reversibility:
        "High impact: history, refs, remote state, or local files can be lost.",
      recovery:
        "Recovery route: inspect HEAD/reflog immediately; remote changes may require provider-side recovery.",
    };
  }
  return {
    impact,
    reversibility: "Reversible: Git records refs and/or the operation state.",
    recovery:
      "Recovery route: use reflog, abort/continue state, or the inverse Git operation after reviewing readback.",
  };
}

export function formatOperationPreview(
  preview: GitOperationPreview,
  extraReadout?: string,
): string {
  const riskReadout = buildOperationRiskReadout(preview);
  const commandText = ["git", ...preview.displayArguments]
    .map((argument) => quoteArgument(argument))
    .join(" ");
  const stateLines = [
    `Repository: ${preview.repositoryRoot}`,
    `HEAD: ${preview.state.headRef ?? "detached"}${preview.state.headCommit === undefined ? "" : ` @ ${preview.state.headCommit}`}`,
    `Working tree: ${preview.state.isClean ? "clean" : "has changes"}`,
    `Conflicts: ${preview.state.hasConflicts ? "present" : "none"}`,
    `Exact changed files: ${preview.state.statusPorcelain.length === 0 ? "none" : preview.state.statusPorcelain}`,
    `Command: ${commandText}`,
    `Impact: ${riskReadout.impact}`,
    `Reversible: ${riskReadout.reversibility}`,
    `Recovery: ${riskReadout.recovery}`,
    `Expected readback: ${preview.expectedPostcondition}`,
  ];
  if (preview.commandSequence !== undefined)
    stateLines.push(
      `Commands: ${preview.commandSequence
        .map((commandArguments) =>
          ["git", ...commandArguments]
            .map((argument) => quoteArgument(argument))
            .join(" "),
        )
        .join("; then ")}`,
    );
  if (preview.contentSummary !== undefined)
    stateLines.push(
      `Content: ${preview.contentSummary.description} ${preview.contentSummary.bytes} bytes, sha256 ${preview.contentSummary.sha256}`,
    );
  const exactArguments = preview.displayArguments.join(" ");
  if (exactArguments.length > 0)
    stateLines.push(`Exact refs/files: ${exactArguments}`);
  const unsatisfiedPreconditions = preview.preconditions.filter(
    (precondition) => !precondition.satisfied,
  );
  if (unsatisfiedPreconditions.length > 0) {
    stateLines.push(
      `Blocked: ${unsatisfiedPreconditions.map((precondition) => precondition.description).join("; ")}`,
    );
  }
  if (extraReadout !== undefined && extraReadout.length > 0)
    stateLines.push(`Read-only preview output:\n${extraReadout}`);
  return stateLines.join("\n");
}

/**
 * Small confirmation readout. The complete exact preview is opened in a
 * native document immediately before this summary is shown.
 */
export function formatOperationConfirmationSummary(
  preview: GitOperationPreview,
): string {
  const riskReadout = buildOperationRiskReadout(preview);
  const commandText = ["git", ...preview.displayArguments]
    .map((argument) => quoteArgument(argument))
    .join(" ");
  return boundConfirmationText(
    [
      `Operation: ${preview.operation}`,
      `Repository: ${shortConfirmationField(preview.repositoryRoot)}`,
      `Action: ${shortConfirmationField(preview.confirmationPlan.summary)}`,
      `Risk: ${shortConfirmationField(riskReadout.reversibility)}`,
      `Expected readback: ${shortConfirmationField(preview.expectedPostcondition)}`,
      `Command: ${commandText}`,
      `State: HEAD ${preview.state.headRef ?? "detached"}; ${preview.state.isClean ? "working tree clean" : "working tree has changes"}; ${preview.state.hasConflicts ? "conflicts present" : "no conflicts"}.`,
      "Full exact preview opened in a scrollable native document.",
      "Confirm only after checking repository, refs, files, command, and recovery route.",
    ].join("\n"),
  );
}

function shortConfirmationField(value: string): string {
  return value.length <= 280 ? value : `${value.slice(0, 279)}…`;
}

export function boundConfirmationText(value: string): string {
  const lines = value.split(/\r?\n/);
  const lineLimited = lines.slice(0, OPERATION_CONFIRMATION_MAX_LINES);
  if (lines.length > OPERATION_CONFIRMATION_MAX_LINES)
    lineLimited[lineLimited.length - 1] =
      "Full exact preview is open in the native document.";
  let bounded = lineLimited.join("\n");
  while (
    byteLength(bounded) > OPERATION_CONFIRMATION_MAX_BYTES &&
    bounded.length > 0
  ) {
    bounded = bounded.slice(0, Math.max(0, bounded.length - 1));
  }
  return bounded;
}

export function formatOperationResult(result: GitOperationResult): string {
  const output = result.standardOutput.trim();
  const errorOutput = result.standardError.trim();
  const outputText =
    output.length > 0 ? `\nOutput:\n${truncate(output, 4000)}` : "";
  const errorText =
    errorOutput.length > 0 ? `\nGit note:\n${truncate(errorOutput, 1000)}` : "";
  return `Completed: ${result.operation}\nRepository: ${result.repositoryRoot}\nReadback: ${result.postcondition.verified ? "verified" : "failed"}\n${result.postcondition.description}${outputText}${errorText}`;
}

function capitalizeWords(value: string): string {
  if (value === "cherry-pick") return "Cherry-pick";
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function quoteArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}\n… output truncated …`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
