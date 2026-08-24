import type * as vscode from "vscode";
import type {
  CompareMode,
  CompareResult,
  CompareTarget,
} from "../compare/compareModels.js";
import type {
  SearchClause,
  SearchIdentity,
  SearchPage,
} from "../compare/index.js";
import type { CompareRepositoryBinding } from "../compare/index.js";

/** Commands owned by the native compare/search experience. */
export const compareExperienceCommandIds = {
  open: "gito.compare.open",
  search: "gito.compare.search",
  actions: "gito.compare.actions",
  recent: "gito.compare.recent",
} as const;

export type CompareReferenceKind =
  "current" | "upstream" | "working" | "staged" | "revision";

export interface CompareReferenceQuickPickItem extends vscode.QuickPickItem {
  readonly referenceKind: CompareReferenceKind;
  readonly target?: CompareTarget;
  readonly revision?: string;
}

export interface CompareModeQuickPickItem extends vscode.QuickPickItem {
  readonly mode: CompareMode;
}

export interface CompareExperienceSelection {
  readonly repositoryRoot: vscode.Uri;
  readonly left: CompareTarget;
  readonly right: CompareTarget;
  readonly mode: CompareMode;
}

export interface CompareSummaryMetric {
  readonly id:
    | "ahead"
    | "behind"
    | "commits"
    | "files"
    | "additions"
    | "deletions"
    | "renames"
    | "binary"
    | "submodules"
    | "symlinks";
  readonly label: string;
  readonly value: number;
}

export interface CompareSummary {
  readonly title: string;
  readonly explanation: string;
  readonly metrics: readonly CompareSummaryMetric[];
  readonly truncated: boolean;
}

export interface CompareOpenPlan {
  readonly command: "vscode.changes";
  readonly title: string;
  /** `vscode.changes` entries: display URI, original URI, modified URI. */
  readonly arguments: readonly [
    string,
    readonly (readonly [
      vscode.Uri,
      vscode.Uri | undefined,
      vscode.Uri | undefined,
    ])[],
  ];
}

export interface SerializableCompareSelection {
  readonly version: 2;
  readonly repositoryRoot: string;
  /** Canonical `.git` directory, not the user-facing worktree path. */
  readonly gitDirectoryIdentity: string;
  readonly left: CompareTarget;
  readonly right: CompareTarget;
  readonly mode: CompareMode;
  readonly savedAt: number;
}

export interface CompareExperienceSession {
  readonly selection: CompareExperienceSelection;
  readonly result: CompareResult;
  readonly repositoryBinding?: CompareRepositoryBinding;
  readonly mutableStateFingerprint: string;
  readonly swapped: boolean;
  readonly recentComparison: SerializableCompareSelection;
}

export interface SearchQueryChip {
  readonly id: string;
  readonly label: string;
  readonly field: SearchClause["field"];
  readonly value?: string;
}

export interface SearchFieldOption {
  readonly field: SearchClause["field"];
  readonly label: string;
  readonly description: string;
}

export interface SearchBuilderState {
  readonly clauses: readonly SearchClause[];
  readonly matchCase: boolean;
  readonly regex: boolean;
  readonly matchAll: boolean;
  readonly currentUser?: SearchIdentity;
}

export interface SearchBuilderQuickPickItem extends vscode.QuickPickItem {
  readonly action:
    | "field"
    | "toggle-regex"
    | "toggle-case"
    | "toggle-match-all"
    | "run"
    | "clear";
  readonly field?: SearchClause["field"];
}

export interface SearchResultQuickPickItem extends vscode.QuickPickItem {
  readonly action: "commit" | "next-page";
  readonly document?: SearchPage["items"][number];
}

export interface SearchCommitActionQuickPickItem extends vscode.QuickPickItem {
  readonly action: "compare-current" | "copy-sha" | "cancel";
}

export interface CompareExperienceWorkspaceState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export const compareExperienceStorageKeys = {
  recentComparisons: "gito.compare.recentComparisons",
} as const;

export const compareExperienceLabels = {
  current: "Current",
  upstream: "Upstream",
  working: "Working tree",
  staged: "Staged",
  revision: "Branch, tag, or commit…",
  direct: "Direct comparison",
  commonBase: "Common-base comparison",
} as const;

export const compareExperienceContextKeys = {
  sessionActive: "gito.compare.sessionActive",
  operationActive: "gito.compare.operationActive",
} as const;

export type CompareSessionAction =
  | "open-all"
  | "swap-sides"
  | "checklist"
  | "reset-checklist"
  | "cancel"
  | "done";

export interface CompareSessionActionQuickPickItem
  extends vscode.QuickPickItem {
  readonly action: CompareSessionAction;
}
