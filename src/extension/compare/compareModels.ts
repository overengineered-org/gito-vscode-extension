import type * as vscode from "vscode";

/** A revision or one of Git'o's two mutable repository views. */
export type CompareTarget =
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "upstream" }
  | { readonly kind: "working" }
  | { readonly kind: "index" };

export type CompareMode = "common-base" | "direct";

export interface CompareRequest {
  readonly repositoryRoot: vscode.Uri;
  readonly left: CompareTarget | string;
  readonly right: CompareTarget | string;
  readonly mode?: CompareMode;
  readonly options?: CompareOptions;
  readonly cancellationSignal?: AbortSignal;
}

export interface CompareOptions {
  /** Maximum commit records retained in either commit set. */
  readonly maxCommits?: number;
  /** Maximum file records retained in the file summary. */
  readonly maxFiles?: number;
  /** Maximum bytes read from each Git metadata stream. */
  readonly maxOutputBytes?: number;
  readonly renameSimilarityPercent?: number;
}

export interface ResolvedCompareTarget {
  readonly target: CompareTarget;
  /** Undefined for working/index because those views have no commit SHA. */
  readonly commitSha?: string;
  /** The exact revision argument used for a resolved ref. */
  readonly revision?: string;
}

export interface CompareCommit {
  readonly commitSha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly commitDate: string;
  readonly refs: readonly string[];
  readonly files: readonly CompareCommitFile[];
  readonly patch?: string;
}

export interface CompareCommitFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: CompareFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

export type CompareFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged";

export interface CompareFileChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: CompareFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
  readonly isSubmodule?: boolean;
  readonly isSymlink?: boolean;
  readonly similarityPercent?: number;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly originalUri?: vscode.Uri;
  readonly modifiedUri?: vscode.Uri;
}

export interface CompareFileCounts {
  readonly total: number;
  readonly added: number;
  readonly deleted: number;
  readonly modified: number;
  readonly renamed: number;
  readonly copied: number;
  readonly typeChanged: number;
  readonly unmerged: number;
  readonly binary: number;
  readonly additions: number;
  readonly deletions: number;
  /** Present when one or more compared entries are submodules. */
  readonly submodules?: number;
  /** Present when one or more compared entries are symbolic links. */
  readonly symlinks?: number;
}

export interface CompareMultiDiffResource {
  readonly originalUri?: vscode.Uri;
  readonly modifiedUri?: vscode.Uri;
  readonly path: string;
  readonly status: CompareFileStatus;
  readonly isSubmodule?: boolean;
  readonly isSymlink?: boolean;
}

export interface CompareMultiDiffPlan {
  /** Public VS Code command used to open all comparable resources. */
  readonly command: "vscode.changes";
  readonly title: string;
  readonly resources: readonly CompareMultiDiffResource[];
}

export interface CompareResult {
  readonly repositoryRoot: vscode.Uri;
  readonly mode: CompareMode;
  readonly left: ResolvedCompareTarget;
  readonly right: ResolvedCompareTarget;
  readonly commonBaseSha?: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly aheadCommits: readonly CompareCommit[];
  readonly behindCommits: readonly CompareCommit[];
  readonly files: readonly CompareFileChange[];
  readonly fileCounts: CompareFileCounts;
  readonly multiDiffPlan: CompareMultiDiffPlan;
  readonly truncated: boolean;
}

export const defaultCompareOptions = {
  maxCommits: 2_000,
  maxFiles: 1_000,
  maxOutputBytes: 16 * 1024 * 1024,
  renameSimilarityPercent: 50,
} as const satisfies Required<CompareOptions>;

export function refTarget(ref: string): CompareTarget {
  return { kind: "ref", ref };
}

export function upstreamTarget(): CompareTarget {
  return { kind: "upstream" };
}

export function workingTarget(): CompareTarget {
  return { kind: "working" };
}

export function indexTarget(): CompareTarget {
  return { kind: "index" };
}

export function normalizeCompareTarget(
  target: CompareTarget | string,
): CompareTarget {
  if (typeof target !== "string") return target;
  if (target === "working" || target === "working-tree") return workingTarget();
  if (target === "index") return indexTarget();
  if (target === "upstream" || target === "@{upstream}")
    return upstreamTarget();
  return refTarget(target);
}

export function emptyCompareFileCounts(): CompareFileCounts {
  return {
    total: 0,
    added: 0,
    deleted: 0,
    modified: 0,
    renamed: 0,
    copied: 0,
    typeChanged: 0,
    unmerged: 0,
    binary: 0,
    additions: 0,
    deletions: 0,
  };
}

export function countCompareFiles(
  files: readonly Pick<
    CompareFileChange,
    | "status"
    | "additions"
    | "deletions"
    | "isBinary"
    | "isSubmodule"
    | "isSymlink"
  >[],
): CompareFileCounts {
  const counts: MutableCompareFileCounts = emptyCompareFileCounts();
  for (const file of files) {
    counts.total += 1;
    counts.additions += file.additions;
    counts.deletions += file.deletions;
    if (file.isBinary) counts.binary += 1;
    if (file.isSubmodule) counts.submodules = (counts.submodules ?? 0) + 1;
    if (file.isSymlink) counts.symlinks = (counts.symlinks ?? 0) + 1;
    switch (file.status) {
      case "added":
        counts.added += 1;
        break;
      case "deleted":
        counts.deleted += 1;
        break;
      case "modified":
        counts.modified += 1;
        break;
      case "renamed":
        counts.renamed += 1;
        break;
      case "copied":
        counts.copied += 1;
        break;
      case "type-changed":
        counts.typeChanged += 1;
        break;
      case "unmerged":
        counts.unmerged += 1;
        break;
    }
  }
  return counts;
}

type MutableCompareFileCounts = {
  -readonly [Property in keyof CompareFileCounts]: CompareFileCounts[Property];
};
