import type * as vscode from "vscode";

/** Exact Status enum exposed by vscode.git's public API. */
export enum Status {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18,
}

/** Structural copy of Microsoft's public vscode.git API v1. */
export interface VscodeGitResourceState {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: Status;
}

export interface VscodeGitRef {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly commitDetails?: VscodeGitCommit;
  readonly remote?: string;
}

export interface VscodeGitBranchQuery {
  readonly contains?: string;
  readonly count?: number;
  readonly pattern?: string | string[];
  readonly sort?: "alphabetically" | "committerdate" | "creatordate";
  readonly remote?: boolean;
}

export interface VscodeGitBranch extends VscodeGitRef {
  readonly upstream?: {
    readonly remote: string;
    readonly name: string;
    readonly commit?: string;
  };
  readonly ahead?: number;
  readonly behind?: number;
}

export interface VscodeGitCommit {
  readonly hash: string;
  readonly message: string;
  readonly parents: readonly string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
  readonly shortStat?: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
  };
}

export interface VscodeGitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface VscodeGitSubmodule {
  readonly name: string;
  readonly path: string;
  readonly url: string;
}

export interface VscodeGitWorktree {
  readonly name: string;
  readonly path: string;
  readonly ref: string;
  readonly main: boolean;
  readonly detached: boolean;
}

export interface VscodeGitRepositoryState {
  readonly HEAD: VscodeGitBranch | undefined;
  readonly refs: readonly VscodeGitRef[];
  readonly remotes: readonly VscodeGitRemote[];
  readonly submodules: readonly VscodeGitSubmodule[];
  readonly worktrees: readonly VscodeGitWorktree[];
  readonly rebaseCommit: VscodeGitCommit | undefined;
  readonly mergeChanges: readonly VscodeGitResourceState[];
  readonly indexChanges: readonly VscodeGitResourceState[];
  readonly workingTreeChanges: readonly VscodeGitResourceState[];
  readonly untrackedChanges: readonly VscodeGitResourceState[];
  readonly onDidChange: vscode.Event<void>;
}

export interface VscodeGitInputBox {
  value: string;
}

/** Values exposed by vscode.git's public RefType enum. */
export enum RefType {
  Head = 0,
  RemoteHead = 1,
  Tag = 2,
}

export interface VscodeGitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: VscodeGitInputBox;
  readonly state: VscodeGitRepositoryState;
  readonly kind: "repository" | "submodule" | "worktree";
  /** Re-read Git status before consumers inspect the state groups. */
  readonly status: () => Promise<void>;
  /** The bundled adapter converts each entry with `Uri.file`; paths are absolute. */
  readonly add: (absoluteFilesystemPaths: string[]) => Promise<void>;
  readonly clean: (absoluteFilesystemPaths: string[]) => Promise<void>;
  readonly revert: (absoluteFilesystemPaths: string[]) => Promise<void>;
  readonly restore: (
    absoluteFilesystemPaths: string[],
    options?: { readonly staged?: boolean; readonly ref?: string },
  ) => Promise<void>;
  readonly commit: (
    message: string,
    options?: {
      readonly all?: boolean | "tracked";
      readonly amend?: boolean;
      readonly signoff?: boolean;
      readonly signCommit?: boolean;
      readonly empty?: boolean;
      readonly noVerify?: boolean;
      readonly requireUserConfig?: boolean;
      readonly useEditor?: boolean;
      readonly verbose?: boolean;
      readonly postCommitCommand?: string | null;
    },
  ) => Promise<void>;
  readonly fetch: (options?: {
    readonly remote?: string;
    readonly ref?: string;
    readonly all?: boolean;
    readonly prune?: boolean;
    readonly depth?: number;
  }) => Promise<void>;
  readonly pull: (unshallow?: boolean) => Promise<void>;
  readonly push: (
    remoteName?: string,
    branchName?: string,
    setUpstream?: boolean,
    force?: number,
  ) => Promise<void>;
  readonly checkout: (treeish: string) => Promise<void>;
  readonly createBranch: (
    name: string,
    checkout: boolean,
    ref?: string,
  ) => Promise<void>;
  readonly deleteBranch: (name: string, force?: boolean) => Promise<void>;
  readonly getBranches: (
    query: VscodeGitBranchQuery,
  ) => Promise<VscodeGitRef[]>;
  readonly getCommit: (ref: string) => Promise<VscodeGitCommit>;
  readonly createWorktree: (options?: {
    readonly path?: string;
    readonly commitish?: string;
    readonly branch?: string;
    readonly noTrack?: boolean;
  }) => Promise<string>;
  readonly deleteWorktree: (
    worktreePath: string,
    options?: { readonly force?: boolean; readonly label?: string },
  ) => Promise<void>;
}

export interface VscodeGitApi {
  readonly state: "uninitialized" | "initialized";
  readonly onDidChangeState: vscode.Event<"uninitialized" | "initialized">;
  readonly repositories: readonly VscodeGitRepository[];
  readonly getRepository: (uri: vscode.Uri) => VscodeGitRepository | null;
  readonly getRepositoryRoot: (uri: vscode.Uri) => Promise<vscode.Uri | null>;
  readonly onDidOpenRepository: vscode.Event<VscodeGitRepository>;
  readonly onDidCloseRepository: vscode.Event<VscodeGitRepository>;
}

export interface VscodeGitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  readonly getAPI: (version: 1) => VscodeGitApi;
}

export function isVscodeGitApi(
  value: unknown,
): value is VscodeGitExtensionExports {
  if (typeof value !== "object" || value === null) return false;
  const extensionExports = value as Partial<VscodeGitExtensionExports>;
  return (
    typeof extensionExports.enabled === "boolean" &&
    typeof extensionExports.onDidChangeEnablement === "function" &&
    typeof extensionExports.getAPI === "function"
  );
}
