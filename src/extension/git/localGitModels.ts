import type * as vscode from "vscode";
import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type {
  VscodeGitBranch,
  VscodeGitRef,
  VscodeGitResourceState,
} from "./vscodeGitApi.js";
import { RefType, Status } from "./vscodeGitApi.js";

export { Status } from "./vscodeGitApi.js";

export type GitChangeGroup =
  "mergeChanges" | "stagedChanges" | "changes" | "untracked";

export interface LocalGitChange {
  /** Stable identity for this exact index/working-tree resource state. */
  readonly changeId?: string;
  readonly status?: number;
  readonly group: GitChangeGroup;
  readonly resourceUri: vscode.Uri;
  readonly originalUri?: vscode.Uri;
  readonly renameUri?: vscode.Uri;
  readonly relativePath: string;
  readonly statusLabel: string;
}

export interface LocalGitChangesSnapshot {
  readonly repositoryRoot: vscode.Uri;
  readonly mergeChanges: readonly LocalGitChange[];
  readonly stagedChanges: readonly LocalGitChange[];
  readonly changes: readonly LocalGitChange[];
  readonly untracked: readonly LocalGitChange[];
  readonly totalChangeCount: number;
}

export interface LocalGitRepositoryHealth {
  readonly branchName: string;
  readonly upstreamBranchName?: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly uncommittedChangeCount: number;
  readonly headCommit?: string;
  readonly lastSuccessfulFetchAt?: string;
}

export interface LocalGitBranch {
  readonly name: string;
  readonly isRemote: boolean;
  readonly isCurrent: boolean;
  readonly upstreamBranchName?: string;
  readonly upstreamRemoteName?: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly lastCommit?: string;
}

export interface LocalGitCommitSummary {
  readonly commitSha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly commitDate: string;
  readonly refs: readonly string[];
}

export interface LocalGitCommitFileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changeType:
    | "added"
    | "deleted"
    | "modified"
    | "renamed"
    | "copied"
    | "binary"
    | "type-changed";
  readonly previousPath?: string;
}

export interface LocalGitCommitDetails extends LocalGitCommitSummary {
  readonly body: string;
  readonly parentShas: readonly string[];
  readonly files: readonly LocalGitCommitFileChange[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  /** True when Git output was safely capped and the detail is partial. */
  readonly truncated?: boolean;
}

export interface LocalGitWorktree {
  readonly path: string;
  readonly headSha: string;
  readonly branchName?: string;
  readonly isLocked: boolean;
  readonly lockReason?: string;
  readonly isPrunable: boolean;
  readonly pruneReason?: string;
}

export interface RepositoryRelativePathResolver {
  resolve(resourceUri: vscode.Uri): string;
}

export function createLocalGitChange(
  repositoryRoot: vscode.Uri,
  group: GitChangeGroup,
  resourceState: VscodeGitResourceState,
  relativePathResolver: RepositoryRelativePathResolver = createRepositoryRelativePathResolver(
    repositoryRoot,
  ),
): LocalGitChange {
  const currentPath = relativePathResolver.resolve(resourceState.uri);
  const originalMatchesCurrent =
    resourceState.originalUri.toString() === resourceState.uri.toString();
  const originalPath = originalMatchesCurrent
    ? currentPath
    : relativePathResolver.resolve(resourceState.originalUri);
  const renamePath =
    resourceState.renameUri === undefined
      ? ""
      : relativePathResolver.resolve(resourceState.renameUri);
  return {
    changeId: createLocalGitChangeIdFromPaths(
      group,
      resourceState.status,
      currentPath,
      originalPath,
      renamePath,
    ),
    status: resourceState.status,
    group,
    resourceUri: resourceState.uri,
    ...(originalMatchesCurrent
      ? {}
      : { originalUri: resourceState.originalUri }),
    ...(resourceState.renameUri === undefined
      ? {}
      : { renameUri: resourceState.renameUri }),
    relativePath: currentPath,
    statusLabel: getGitStatusLabel(group, resourceState.status),
  };
}

export function createLocalGitChangeId(
  repositoryRoot: vscode.Uri,
  changeGroup: GitChangeGroup,
  resourceState: VscodeGitResourceState,
  relativePathResolver: RepositoryRelativePathResolver = createRepositoryRelativePathResolver(
    repositoryRoot,
  ),
): string {
  const currentPath = relativePathResolver.resolve(resourceState.uri);
  const originalPath =
    resourceState.originalUri.toString() === resourceState.uri.toString()
      ? currentPath
      : relativePathResolver.resolve(resourceState.originalUri);
  const renamePath =
    resourceState.renameUri === undefined
      ? ""
      : relativePathResolver.resolve(resourceState.renameUri);
  return createLocalGitChangeIdFromPaths(
    changeGroup,
    resourceState.status,
    currentPath,
    originalPath,
    renamePath,
  );
}

function createLocalGitChangeIdFromPaths(
  changeGroup: GitChangeGroup,
  resourceStateStatus: number,
  currentPath: string,
  originalPath: string,
  renamePath: string,
): string {
  return [
    changeGroup,
    String(resourceStateStatus),
    currentPath,
    originalPath,
    renamePath,
  ].join("\u0000");
}

export function toRepositoryRelativePath(
  repositoryRoot: vscode.Uri,
  resourceUri: vscode.Uri,
): string {
  return createRepositoryRelativePathResolver(repositoryRoot).resolve(
    resourceUri,
  );
}

/** Create a resolver for one bounded snapshot or action mapping operation. */
export function createRepositoryRelativePathResolver(
  repositoryRoot: vscode.Uri,
): RepositoryRelativePathResolver {
  const canonicalRepositoryPath = resolvePathThroughNearestExistingAncestor(
    normalizePath(repositoryRoot.fsPath),
  );
  const canonicalResourceParentPaths = new Map<string, string>();

  return {
    resolve(resourceUri: vscode.Uri): string {
      assertCompatibleRepositoryUri(repositoryRoot, resourceUri);
      const resourcePath = normalizePath(resourceUri.fsPath);
      const resourceParentPath = path.dirname(resourcePath);
      let canonicalResourceParentPath =
        canonicalResourceParentPaths.get(resourceParentPath);
      if (canonicalResourceParentPath === undefined) {
        // Resolve only the parent so a tracked symlink leaf stays lexical.
        canonicalResourceParentPath =
          resolvePathThroughNearestExistingAncestor(resourceParentPath);
        canonicalResourceParentPaths.set(
          resourceParentPath,
          canonicalResourceParentPath,
        );
      }
      const canonicalResourcePath = path.join(
        canonicalResourceParentPath,
        path.basename(resourcePath),
      );
      const relativePath = path.relative(
        canonicalRepositoryPath,
        canonicalResourcePath,
      );
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error("Git resource is outside the selected repository.");
      }
      return relativePath.length === 0
        ? "."
        : relativePath.replaceAll(path.sep, "/");
    },
  };
}

export function getGitStatusLabel(
  changeGroup: GitChangeGroup,
  resourceStateType: number | undefined,
): string {
  if (changeGroup === "mergeChanges") return "Conflict";
  if (resourceStateType === gitStatus.IGNORED) return "Ignored";
  if (changeGroup === "untracked") return "Untracked";
  if (changeGroup === "stagedChanges") {
    return resourceStateType === gitStatus.INDEX_ADDED
      ? "Added"
      : resourceStateType === gitStatus.INDEX_DELETED
        ? "Deleted"
        : "Staged";
  }
  if (resourceStateType === gitStatus.DELETED) return "Deleted";
  if (resourceStateType === gitStatus.MODIFIED) return "Modified";
  return "Changed";
}

export const gitStatus = Status;

export function normalizeVscodeGitBranch(
  branch: VscodeGitRef &
    Partial<Pick<VscodeGitBranch, "upstream" | "ahead" | "behind">> & {
      readonly name: string;
    },
  currentBranchName: string | undefined,
): LocalGitBranch {
  const isRemote = branch.type === RefType.RemoteHead;
  return {
    name: branch.name,
    isRemote,
    isCurrent: !isRemote && branch.name === currentBranchName,
    ...(branch.upstream?.name === undefined
      ? {}
      : { upstreamBranchName: branch.upstream.name }),
    ...(branch.upstream?.remote === undefined
      ? {}
      : { upstreamRemoteName: branch.upstream.remote }),
    aheadCount: branch.ahead ?? 0,
    behindCount: branch.behind ?? 0,
    ...(branch.commit === undefined ? {} : { lastCommit: branch.commit }),
  };
}

function normalizePath(filePath: string): string {
  const normalizedPath = path.normalize(filePath);
  const rootPath = path.parse(normalizedPath).root;
  if (normalizedPath === rootPath) return rootPath;
  let pathWithoutTrailingSeparators = normalizedPath;
  while (pathWithoutTrailingSeparators.endsWith(path.sep)) {
    pathWithoutTrailingSeparators = pathWithoutTrailingSeparators.slice(0, -1);
  }
  return pathWithoutTrailingSeparators.length === 0
    ? rootPath
    : pathWithoutTrailingSeparators;
}

/** Resolve existing aliases and symlinks, then preserve any missing suffix. */
function resolvePathThroughNearestExistingAncestor(filePath: string): string {
  let candidatePath = filePath;
  const missingPathComponents: string[] = [];
  while (true) {
    try {
      return path.join(
        realpathSync.native(candidatePath),
        ...missingPathComponents,
      );
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (isSymlinkPath(candidatePath)) throw error;
      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) throw error;
      missingPathComponents.unshift(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  }
}

function isSymlinkPath(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertCompatibleRepositoryUri(
  repositoryRoot: vscode.Uri,
  resourceUri: vscode.Uri,
): void {
  if (
    repositoryRoot.scheme !== resourceUri.scheme ||
    (repositoryRoot.authority ?? "") !== (resourceUri.authority ?? "")
  ) {
    throw new Error("Git resource uses an incompatible URI.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
