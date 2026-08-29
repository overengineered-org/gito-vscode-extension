import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import type { GitWorktree } from "./gitApi.ts";
import { canonicalizePath } from "./pathIdentity.ts";

export interface RepositoryFamilyCandidate {
  readonly repositoryPath: string;
  readonly worktrees: readonly GitWorktree[];
}

export function findPrimaryWorktree(
  repositoryPath: string,
  worktrees: readonly GitWorktree[],
): GitWorktree {
  return (
    worktrees.find((worktree) => worktree.main) ?? {
      detached: false,
      main: true,
      name: basename(repositoryPath),
      path: repositoryPath,
      ref: "",
    }
  );
}

export function createRepositoryFamilyKey(
  repositoryPath: string,
  worktrees: readonly GitWorktree[],
): string {
  return canonicalizePath(findPrimaryWorktree(repositoryPath, worktrees).path);
}

export function selectRepositoryFamilyRepresentatives(
  repositoryCandidates: readonly RepositoryFamilyCandidate[],
  selectedRepositoryPath: string | undefined,
): readonly string[] {
  const representativeByFamily = new Map<string, string>();
  for (const repositoryCandidate of repositoryCandidates) {
    const repositoryFamilyKey = createRepositoryFamilyKey(
      repositoryCandidate.repositoryPath,
      repositoryCandidate.worktrees,
    );
    if (
      !representativeByFamily.has(repositoryFamilyKey) ||
      repositoryCandidate.repositoryPath === selectedRepositoryPath
    ) {
      representativeByFamily.set(repositoryFamilyKey, repositoryCandidate.repositoryPath);
    }
  }
  return [...representativeByFamily.values()];
}

export function createWorktreeCheckoutPath(
  repositoryPath: string,
  worktrees: readonly GitWorktree[],
  configuredStorageRoot: string,
  worktreeDisplayName: string,
  userHomePath: string,
): string {
  const primaryWorktreePath = canonicalizePath(
    findPrimaryWorktree(repositoryPath, worktrees).path,
  );
  const storageRoot = resolveWorktreeStorageRoot(
    primaryWorktreePath,
    configuredStorageRoot,
    userHomePath,
  );
  return join(
    storageRoot,
    basename(primaryWorktreePath),
    createPortableWorktreeDirectoryName(worktreeDisplayName),
  );
}

export function createPortableWorktreeDirectoryName(worktreeDisplayName: string): string {
  const portableDirectoryName = worktreeDisplayName
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
  const lengthLimitedDirectoryName = [...portableDirectoryName].slice(0, 80).join("");
  return lengthLimitedDirectoryName === "" ? "worktree" : lengthLimitedDirectoryName;
}

export function formatWorktreeBranchName(worktree: GitWorktree): string {
  return worktree.detached
    ? "Detached HEAD"
    : worktree.ref.replace(/^refs\/heads\//u, "") || worktree.name;
}

function resolveWorktreeStorageRoot(
  primaryWorktreePath: string,
  configuredStorageRoot: string,
  userHomePath: string,
): string {
  const trimmedStorageRoot = configuredStorageRoot.trim();
  if (trimmedStorageRoot === "") {
    return join(dirname(primaryWorktreePath), ".gito-worktrees");
  }
  const expandedStorageRoot =
    trimmedStorageRoot === "~"
      ? userHomePath
      : /^~[\\/]/u.test(trimmedStorageRoot)
        ? join(userHomePath, trimmedStorageRoot.slice(2))
        : trimmedStorageRoot;
  if (!isAbsolute(expandedStorageRoot)) {
    throw new Error("Git'o worktree storage must be an absolute path or start with '~'.");
  }
  return normalize(expandedStorageRoot);
}
