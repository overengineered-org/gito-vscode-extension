import type * as vscode from "vscode";

/** A repository root accepted by the history service. */
export type HistoryRepositoryRoot = vscode.Uri | string;

export type HistoryRevision = string;

/** Opaque continuation token returned by bounded history operations. */
export type HistoryContinuationCursor = string;

export interface HistoryIdentity {
  readonly name: string;
  readonly email: string;
}

export interface HistoryFileChange {
  readonly path: string;
  readonly changeType:
    | "added"
    | "deleted"
    | "modified"
    | "renamed"
    | "copied"
    | "binary"
    | "type-changed";
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface HistoryCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committerDate: string;
  readonly parentShas: readonly string[];
  readonly changedFiles: readonly HistoryFileChange[];
}

export interface HistoryPage {
  readonly commits: readonly HistoryCommit[];
  readonly hasMore: boolean;
  readonly reachedSafetyCap: boolean;
  readonly nextCursor?: HistoryContinuationCursor;
  /** True when Git output ended at the byte safety cap. */
  readonly truncated?: boolean;
}

export interface FileHistoryEntry extends HistoryCommit {
  readonly path: string;
  readonly previousPath?: string;
}

export interface FileHistoryPage {
  readonly entries: readonly FileHistoryEntry[];
  readonly hasMore: boolean;
  readonly reachedSafetyCap: boolean;
  readonly nextCursor?: HistoryContinuationCursor;
  /** True when Git output ended at the byte safety cap. */
  readonly truncated?: boolean;
}

export interface HistoryScopeOptions {
  readonly revision?: HistoryRevision;
  readonly maxEntries?: number;
  readonly cursor?: HistoryContinuationCursor;
  readonly cancellationSignal?: AbortSignal;
}

export interface LineHistoryEntry extends HistoryCommit {
  readonly path: string;
  readonly lineNumber: number;
}

export interface BlameLine {
  readonly lineNumber: number;
  readonly content: string;
  readonly commitSha: string;
  readonly originalLineNumber: number;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly summary: string;
  readonly pathAtRevision: string;
}

export interface BlameRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface BlameOptions {
  readonly revision?: HistoryRevision;
  readonly range?: BlameRange;
  readonly cancellationSignal?: AbortSignal;
}

export interface ContributorSummary {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly commitCount: number;
  readonly firstAuthorDate: string;
  readonly lastAuthorDate: string;
}

export interface ContributorsSnapshot {
  readonly contributors: readonly ContributorSummary[];
  readonly examinedCommitCount: number;
  readonly reachedSafetyCap: boolean;
  /** True when Git output ended at the byte safety cap. */
  readonly truncated?: boolean;
}

export type HistoryQueryField = "message" | "author" | "sha" | "file" | "patch";

export interface HistoryQueryTerm {
  readonly field: HistoryQueryField;
  readonly value: string;
}

/** Query terms are ANDed when matchAll is true; otherwise they are ORed. */
export interface HistoryQuery {
  readonly terms: readonly HistoryQueryTerm[];
  readonly matchCase?: boolean;
  readonly regex?: boolean;
  readonly matchAll?: boolean;
  readonly limit?: number;
  /** Opaque cursor from a previous result page. */
  readonly cursor?: HistoryContinuationCursor;
  readonly revision?: HistoryRevision;
  readonly filePath?: string;
}

export interface HistoryQueryMatch extends HistoryCommit {
  readonly matchingFields: readonly HistoryQueryField[];
  readonly patchText?: string;
}

export interface HistoryQueryResult {
  readonly matches: readonly HistoryQueryMatch[];
  readonly examinedCommitCount: number;
  readonly hasMore: boolean;
  readonly reachedSafetyCap: boolean;
  readonly nextCursor?: HistoryContinuationCursor;
  /** True when the streaming history output hit the byte safety cap. */
  readonly truncated?: boolean;
  /** True when one or more patch probes were bounded before completion. */
  readonly patchResultsIncomplete?: boolean;
}

export interface GitRevisionResource {
  /** Filesystem path used by Git commands. */
  readonly repositoryRoot: string;
  /** Full URI identity, including scheme and authority. */
  readonly repositoryRootIdentity: string;
  readonly revisionSha: string;
  readonly relativePath: string;
}

/** Stable data for a later `vscode.commands.executeCommand('vscode.diff', ...)`. */
export interface NativeDiffPlan {
  readonly left: GitRevisionResource;
  readonly right: GitRevisionResource;
  readonly title: string;
}

export interface RevisionParent {
  readonly sha: string;
  readonly index: number;
}

export interface RevisionNavigationPlan {
  readonly current: GitRevisionResource;
  readonly currentCommit: HistoryCommit;
  readonly parents: readonly RevisionParent[];
  readonly selectedParent?: RevisionParent;
  readonly previousRevision?: GitRevisionResource;
  readonly nextRevision?: GitRevisionResource;
  readonly previousDiff?: NativeDiffPlan;
  readonly nextDiff?: NativeDiffPlan;
}

export const HISTORY_QUERY_SAFETY_CAP = 100_000;

export const DEFAULT_HISTORY_PAGE_SIZE = 100;
