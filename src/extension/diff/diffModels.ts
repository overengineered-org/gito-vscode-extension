import type * as vscode from "vscode";

export type DiffComparisonPreset =
  "working-vs-index" | "index-vs-head" | "working-vs-head" | "commit-vs-parent";

export type DiffWhitespaceMode =
  | "default"
  | "ignore-all"
  | "ignore-space-change"
  | "ignore-space-at-eol"
  | "ignore-blank-lines";

export type DiffPresentationMode = "line" | "word" | "intraline";

export interface DiffRepositorySource {
  readonly kind: "working-tree" | "index" | "revision" | "merge-base";
  readonly repositoryRoot: vscode.Uri;
  readonly revision?: string;
  readonly leftRevision?: string;
  readonly rightRevision?: string;
}

export interface DiffPlanOptions {
  /** Number of unchanged lines to request around each change. */
  readonly contextLines?: number;
  readonly whitespaceMode?: DiffWhitespaceMode;
  readonly presentationMode?: DiffPresentationMode;
  readonly renameDetection?: boolean;
  readonly renameSimilarityPercent?: number;
  /** Copy detection is opt-in because Git's default heuristic can be surprising. */
  readonly copyDetection?: "none" | "default" | "harder";
  /** Maximum number of file plans retained in a repository plan. */
  readonly maxFiles?: number;
  /** Maximum raw Git output retained for metadata and hunk discovery. */
  readonly maxOutputBytes?: number;
  /** Maximum navigation ranges retained across all files. */
  readonly maxNavigationChanges?: number;
}

export interface DiffPlanRequest {
  readonly repositoryRoot: vscode.Uri;
  readonly from: DiffRepositorySource;
  readonly to: DiffRepositorySource;
  readonly filePath?: string;
  readonly options?: DiffPlanOptions;
  readonly cancellationSignal?: AbortSignal;
}

export interface CommitParentDiffRequest {
  readonly repositoryRoot: vscode.Uri;
  readonly commitRevision: string;
  readonly parentRevision?: string;
  readonly filePath?: string;
  readonly options?: DiffPlanOptions;
  readonly cancellationSignal?: AbortSignal;
}

export interface DiffFileMetadata {
  readonly changeType:
    | "added"
    | "deleted"
    | "modified"
    | "renamed"
    | "copied"
    | "type-changed"
    | "unmerged";
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly similarityPercent?: number;
  readonly additions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
  readonly isSubmodule: boolean;
  readonly isSymlink: boolean;
  readonly oldMode?: string;
  readonly newMode?: string;
}

export interface DiffChangeRange {
  readonly oldStartLine: number;
  readonly oldLineCount: number;
  readonly newStartLine: number;
  readonly newLineCount: number;
}

export interface DiffPresentationDescriptor {
  readonly mode: DiffPresentationMode;
  readonly contextLines: number;
  readonly whitespaceMode: DiffWhitespaceMode;
  readonly wordComparison: boolean;
  readonly intralineComparison: boolean;
}

export interface DiffUriPair {
  /** Empty sides use the gito-empty content provider; only unavailable plans omit a URI. */
  readonly originalUri?: vscode.Uri;
  /** Empty sides use the gito-empty content provider; only unavailable plans omit a URI. */
  readonly modifiedUri?: vscode.Uri;
}

export interface DiffFilePlan extends DiffUriPair {
  readonly repositoryRoot: vscode.Uri;
  readonly metadata: DiffFileMetadata;
  readonly displayPath: string;
  readonly presentation: DiffPresentationDescriptor;
  readonly changeRanges: readonly DiffChangeRange[];
  readonly navigationEntryIds: readonly string[];
}

export interface DiffNavigationEntry {
  readonly id: string;
  readonly fileIndex: number;
  readonly path: string;
  readonly rangeIndex: number;
  readonly range: DiffChangeRange;
}

export interface DiffNavigationModel {
  readonly entries: readonly DiffNavigationEntry[];
  readonly truncated: boolean;
  readonly nextEntryId?: (currentEntryId?: string) => string | undefined;
  readonly previousEntryId?: (currentEntryId?: string) => string | undefined;
}

export interface DiffRepositoryPlan {
  readonly kind: "repository";
  readonly repositoryRoot: vscode.Uri;
  readonly from: DiffRepositorySource;
  readonly to: DiffRepositorySource;
  readonly files: readonly DiffFilePlan[];
  readonly navigation: DiffNavigationModel;
  readonly presentation: DiffPresentationDescriptor;
  readonly totalFileCount: number;
  readonly omittedFileCount: number;
  readonly truncated: boolean;
  readonly caps: {
    readonly maxFiles: number;
    readonly maxOutputBytes: number;
    readonly maxNavigationChanges: number;
  };
}

export interface DiffFileOnlyPlan extends DiffFilePlan {
  readonly kind: "file";
  readonly from: DiffRepositorySource;
  readonly to: DiffRepositorySource;
}

export type DiffPlan = DiffRepositoryPlan | DiffFileOnlyPlan;

/** Resource pair retained for the public `vscode.changes` command. */
export interface DiffMultiEditorResource {
  readonly originalUri?: vscode.Uri;
  readonly modifiedUri?: vscode.Uri;
}

export interface DiffMultiEditorPlan {
  readonly command: "vscode.changes";
  readonly title: string;
  readonly resources: readonly DiffMultiEditorResource[];
}

export const defaultDiffPlanOptions = {
  contextLines: 3,
  whitespaceMode: "default",
  presentationMode: "line",
  renameDetection: true,
  renameSimilarityPercent: 50,
  copyDetection: "none",
  maxFiles: 500,
  maxOutputBytes: 10 * 1024 * 1024,
  maxNavigationChanges: 5_000,
} as const satisfies Required<DiffPlanOptions>;

export const gitEmptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function createWorkingTreeSource(
  repositoryRoot: vscode.Uri,
): DiffRepositorySource {
  return { kind: "working-tree", repositoryRoot };
}

export function createIndexSource(
  repositoryRoot: vscode.Uri,
): DiffRepositorySource {
  return { kind: "index", repositoryRoot };
}

export function createRevisionSource(
  repositoryRoot: vscode.Uri,
  revision: string,
): DiffRepositorySource {
  return { kind: "revision", repositoryRoot, revision };
}

export function createMergeBaseSource(
  repositoryRoot: vscode.Uri,
  leftRevision: string,
  rightRevision: string,
): DiffRepositorySource {
  return {
    kind: "merge-base",
    repositoryRoot,
    leftRevision,
    rightRevision,
  };
}
