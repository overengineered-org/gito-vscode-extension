import type * as vscode from "vscode";
import type {
  DiffFileOnlyPlan,
  DiffPlanOptions,
  DiffRepositoryPlan,
  DiffRepositorySource,
  DiffWhitespaceMode,
  GitDiffRepositoryBinding,
} from "../diff/index.js";

export type DiffExperiencePreset = "review" | "whitespace";

export type DiffExperienceView = "file" | "repository";

export type DiffNavigationDirection = "next" | "previous";

export type DiffNavigationUnit = "file" | "change";

export interface DiffExperienceOptions extends DiffPlanOptions {
  readonly preset: DiffExperiencePreset;
}

export interface DiffExperienceSelection {
  readonly repositoryRoot: vscode.Uri;
  readonly from: DiffRepositorySource;
  readonly to: DiffRepositorySource;
  readonly view: DiffExperienceView;
  readonly options: DiffExperienceOptions;
  readonly filePath?: string;
}

export interface DiffOpenCommandPlan {
  readonly command: "vscode.changes" | "vscode.diff" | "vscode.open";
  readonly arguments: readonly unknown[];
  readonly title: string;
}

export interface DiffExperienceSession {
  readonly selection: DiffExperienceSelection;
  readonly plan: DiffRepositoryPlan;
  readonly repositoryBinding: GitDiffRepositoryBinding;
  readonly mutableStateFingerprint: string;
  readonly activeFileIndex: number;
  readonly activeChangeEntryId?: string;
  readonly swapped: boolean;
}

export interface SerializableDiffSource {
  readonly kind: DiffRepositorySource["kind"];
  readonly revision?: string;
  readonly leftRevision?: string;
  readonly rightRevision?: string;
}

export interface RecentDiffComparison {
  readonly version: 1;
  readonly repositoryRoot: string;
  readonly from: SerializableDiffSource;
  readonly to: SerializableDiffSource;
  readonly view: DiffExperienceView;
  readonly filePath?: string;
  readonly options: {
    readonly preset: DiffExperiencePreset;
    readonly contextLines: number;
    readonly whitespaceMode: DiffWhitespaceMode;
    readonly presentationMode: NonNullable<DiffPlanOptions["presentationMode"]>;
  };
  readonly savedAt: number;
}

export type DiffExperiencePlan = DiffRepositoryPlan | DiffFileOnlyPlan;

export const diffExperienceStorageKey = "gito.diffExperience.recentComparisons";

export const diffExperienceCommandIds = {
  open: "gito.diff.open",
  openSingleFile: "gito.diff.openSingleFile",
  openRepository: "gito.diff.openRepository",
  review: "gito.diff.review",
  whitespace: "gito.diff.whitespace",
  nextFile: "gito.diff.nextFile",
  previousFile: "gito.diff.previousFile",
  nextChange: "gito.diff.nextChange",
  previousChange: "gito.diff.previousChange",
  swapSides: "gito.diff.swapSides",
  reopen: "gito.diff.reopen",
  changeOptions: "gito.diff.changeOptions",
} as const;

export const diffExperiencePresetLabels: Readonly<
  Record<"review" | "whitespace", string>
> = {
  review: "Review",
  whitespace: "Ignore whitespace",
};
