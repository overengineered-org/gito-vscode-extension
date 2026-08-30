import * as vscode from "vscode";

import { completeGitOperationBeforeTimeout } from "./gitOperationTimeout.ts";
import type { GitReference } from "./gitModel.ts";

export interface GitChange {
  readonly status: number;
  readonly uri: vscode.Uri;
}

export interface GitCommit {
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly commitDate?: Date;
  readonly hash: string;
  readonly message: string;
  readonly parents: readonly string[];
}

export interface GitLogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
  readonly refNames?: readonly string[];
  readonly range?: string;
}

interface GitRepositoryState {
  readonly HEAD?: GitReference;
  readonly indexChanges: readonly GitChange[];
  readonly mergeChanges: readonly GitChange[];
  readonly onDidChange: vscode.Event<void>;
  readonly rebaseCommit?: GitCommit;
  readonly remotes: readonly GitRemote[];
  readonly untrackedChanges: readonly GitChange[];
  readonly worktrees: readonly GitWorktree[];
  readonly workingTreeChanges: readonly GitChange[];
}

export interface GitWorktree {
  readonly detached: boolean;
  readonly main: boolean;
  readonly name: string;
  readonly path: string;
  readonly ref: string;
}

interface GitRemote {
  readonly name: string;
}

export interface GitRepository {
  readonly inputBox: { value: string };
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  readonly ui: {
    readonly onDidChange: vscode.Event<void>;
    readonly selected: boolean;
  };
  add(filePaths: readonly string[]): Promise<void>;
  checkout(gitReference: string): Promise<void>;
  clean(filePaths: readonly string[]): Promise<void>;
  commit(message: string): Promise<void>;
  createBranch(branchName: string, checkout: boolean, gitReference?: string): Promise<void>;
  createWorktree(options: {
    readonly branch: string;
    readonly commitish: string;
    readonly path: string;
  }): Promise<string>;
  deleteWorktree(
    worktreePath: string,
    options?: { readonly force?: boolean; readonly label?: string },
  ): Promise<void>;
  fetch(options?: { readonly prune?: boolean; readonly remote?: string }): Promise<void>;
  getBranchBase(branchName: string): Promise<GitReference | undefined>;
  getCommit(gitReference: string): Promise<GitCommit>;
  getRefs(query: GitReferenceQuery): Promise<readonly GitReference[]>;
  log(options?: GitLogOptions): Promise<readonly GitCommit[]>;
  merge(gitReference: string): Promise<void>;
  mergeAbort(): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(
    remoteName?: string,
    branchName?: string,
    setUpstream?: boolean,
    forceMode?: number,
  ): Promise<void>;
  revert(filePaths: readonly string[]): Promise<void>;
  status(): Promise<void>;
  tag(tagName: string, message: string, gitReference?: string): Promise<void>;
}

interface GitReferenceQuery {
  readonly pattern?: string | readonly string[];
  readonly sort?: "alphabetically" | "committerdate" | "creatordate";
}

export interface GitApi {
  readonly git: {
    readonly env: Readonly<Record<string, string>>;
    readonly path: string;
  };
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly repositories: readonly GitRepository[];
  openRepository(repositoryRootUri: vscode.Uri): GitRepository | null;
}

export async function loadGitCommitsWithTimeout(
  repository: GitRepository,
  gitLogOptions: GitLogOptions,
  timeoutMilliseconds = 15_000,
): Promise<readonly GitCommit[]> {
  return completeGitOperationBeforeTimeout(
    repository.log(gitLogOptions),
    timeoutMilliseconds,
    "Git history",
  );
}

interface BuiltInGitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export async function loadBuiltInGitApi(): Promise<GitApi> {
  const builtInGitExtension = vscode.extensions.getExtension<BuiltInGitExtension>("vscode.git");
  if (builtInGitExtension === undefined) {
    throw new Error("VS Code's built-in Git extension is unavailable.");
  }

  const activatedGitExtension = await builtInGitExtension.activate();
  if (!activatedGitExtension.enabled) {
    throw new Error("Enable VS Code's built-in Git extension to use Git'o.");
  }

  return activatedGitExtension.getAPI(1);
}
