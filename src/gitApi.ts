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
  readonly refNames?: readonly string[];
  readonly range?: string;
}

export interface GitRepositoryState {
  readonly HEAD?: GitReference;
  readonly indexChanges: readonly GitChange[];
  readonly mergeChanges: readonly GitChange[];
  readonly onDidChange: vscode.Event<void>;
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

export interface GitRemote {
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
  add(resourceUris: readonly vscode.Uri[]): Promise<void>;
  clean(resourceUris: readonly vscode.Uri[]): Promise<void>;
  createWorktree(options: {
    readonly branch: string;
    readonly commitish: string;
    readonly path: string;
  }): Promise<string>;
  deleteWorktree(
    worktreePath: string,
    options?: { readonly force?: boolean; readonly label?: string },
  ): Promise<void>;
  getBranchBase(branchName: string): Promise<GitReference | undefined>;
  getRefs(query: GitReferenceQuery): Promise<readonly GitReference[]>;
  log(options?: GitLogOptions): Promise<readonly GitCommit[]>;
  revert(resourceUris: readonly vscode.Uri[]): Promise<void>;
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
