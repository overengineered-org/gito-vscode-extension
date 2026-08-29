import { isAbsolute, relative, sep } from "node:path";

export const GitReferenceType = {
  localBranch: 0,
  remoteBranch: 1,
  tag: 2,
} as const;

export interface GitReference {
  readonly ahead?: number;
  readonly behind?: number;
  readonly commit?: string;
  readonly name?: string;
  readonly remote?: string;
  readonly type: number;
  readonly upstream?: { readonly name: string; readonly remote: string };
}

export type NamedGitReference = GitReference & { readonly name: string };

export type BranchLocation = "local" | "remoteTracking";
export type RepositoryReferenceType = "branch" | "tag";
export type CurrentBranchSyncStatus =
  | "ahead"
  | "behind"
  | "diverged"
  | "notTracking"
  | "synced"
  | "unknown";

export interface BranchAvailability {
  readonly availableLocally: boolean;
  readonly availableRemotely: boolean;
  readonly currentSyncStatus?: CurrentBranchSyncStatus;
  readonly isCurrent: boolean;
  readonly location: BranchLocation;
  readonly reference: NamedGitReference;
}

export interface BranchInventory {
  readonly localBranches: readonly BranchAvailability[];
  readonly remoteTrackingBranches: readonly BranchAvailability[];
}

export interface BranchLagNotice {
  readonly behindCommitCount: number;
  readonly comparisonKind: "source" | "upstream";
  readonly referenceName: string;
}

export interface SourceBranchComparison {
  readonly behindCommitCount: number;
  readonly referenceName: string;
}

export interface RepositoryChangeCollections {
  readonly indexChanges: readonly unknown[];
  readonly mergeChanges: readonly unknown[];
  readonly untrackedChanges: readonly unknown[];
  readonly workingTreeChanges: readonly unknown[];
}

export type TagSyncStatus = "conflict" | "localOnly" | "remoteOnly" | "synced" | "unchecked";

export interface TagAvailability {
  readonly availableLocally: boolean;
  readonly localCommit?: string;
  readonly name: string;
  readonly remoteCommit?: string;
  readonly syncStatus: TagSyncStatus;
}

export function buildBranchInventory(
  gitReferences: readonly GitReference[],
  currentBranch?: GitReference,
): BranchInventory {
  const localBranchReferences = sortNamedReferences(
    gitReferences.filter(
      (gitReference) => gitReference.type === GitReferenceType.localBranch,
    ),
  );
  const remoteTrackingBranchReferences = sortNamedReferences(
    gitReferences.filter(
      (gitReference) =>
        gitReference.type === GitReferenceType.remoteBranch &&
        gitReference.name !== undefined &&
        !gitReference.name.endsWith("/HEAD"),
    ),
  );
  const localBranchNames = new Set(
    localBranchReferences.map((localBranchReference) => localBranchReference.name),
  );
  const remoteBranchNames = new Set(
    remoteTrackingBranchReferences.map((remoteBranchReference) =>
      removeRemotePrefix(remoteBranchReference.name, remoteBranchReference.remote),
    ),
  );

  return {
    localBranches: localBranchReferences.map((localBranchReference): BranchAvailability => {
      const isCurrent = currentBranch?.name === localBranchReference.name;
      const effectiveBranchReference =
        isCurrent && currentBranch?.name !== undefined
          ? { ...localBranchReference, ...currentBranch, name: currentBranch.name }
          : localBranchReference;
      return {
        availableLocally: true,
        availableRemotely: remoteBranchNames.has(localBranchReference.name),
        ...(isCurrent
          ? { currentSyncStatus: determineCurrentBranchSyncStatus(effectiveBranchReference) }
          : {}),
        isCurrent,
        location: "local",
        reference: effectiveBranchReference,
      };
    }),
    remoteTrackingBranches: remoteTrackingBranchReferences.map(
      (remoteBranchReference): BranchAvailability => ({
        availableLocally: localBranchNames.has(
          removeRemotePrefix(remoteBranchReference.name, remoteBranchReference.remote),
        ),
        availableRemotely: true,
        isCurrent: false,
        location: "remoteTracking",
        reference: remoteBranchReference,
      }),
    ),
  };
}

export function determineCurrentBranchSyncStatus(
  currentBranch: GitReference,
): CurrentBranchSyncStatus {
  if (currentBranch.upstream === undefined) {
    return "notTracking";
  }
  if (currentBranch.ahead === undefined && currentBranch.behind === undefined) {
    return "unknown";
  }
  const commitsAhead = currentBranch.ahead ?? 0;
  const commitsBehind = currentBranch.behind ?? 0;
  if (commitsAhead > 0 && commitsBehind > 0) {
    return "diverged";
  }
  if (commitsAhead > 0) {
    return "ahead";
  }
  if (commitsBehind > 0) {
    return "behind";
  }
  return "synced";
}

export function listBranchLagNotices(
  currentBranch: GitReference,
  sourceBranchComparison?: SourceBranchComparison,
): readonly BranchLagNotice[] {
  const upstreamReferenceName = currentBranch.upstream
    ? formatRemoteBranchName(currentBranch.upstream.remote, currentBranch.upstream.name)
    : undefined;
  const commitsBehindUpstream = currentBranch.behind ?? 0;
  const branchLagNotices: BranchLagNotice[] = [];
  if (commitsBehindUpstream > 0 && upstreamReferenceName !== undefined) {
    branchLagNotices.push({
      behindCommitCount: commitsBehindUpstream,
      comparisonKind: "upstream",
      referenceName: upstreamReferenceName,
    });
  }
  if (
    sourceBranchComparison !== undefined &&
    sourceBranchComparison.behindCommitCount > 0 &&
    sourceBranchComparison.referenceName !== upstreamReferenceName
  ) {
    branchLagNotices.push({
      ...sourceBranchComparison,
      comparisonKind: "source",
    });
  }
  return branchLagNotices;
}

export function listPrunableLocalBranches(
  gitReferences: readonly GitReference[],
  currentBranchName: string | undefined,
): readonly NamedGitReference[] {
  const remoteBranchNames = new Set(
    gitReferences.flatMap((gitReference) =>
      gitReference.type === GitReferenceType.remoteBranch && gitReference.name !== undefined
        ? [removeRemotePrefix(gitReference.name, gitReference.remote)]
        : [],
    ),
  );
  return sortNamedReferences(
    gitReferences.filter(
      (gitReference) =>
        gitReference.type === GitReferenceType.localBranch &&
        gitReference.name !== undefined &&
        gitReference.name !== currentBranchName &&
        !remoteBranchNames.has(gitReference.name),
    ),
  );
}

export function listSwitchableReferences(
  gitReferences: readonly GitReference[],
  referenceType: RepositoryReferenceType,
): readonly NamedGitReference[] {
  return sortNamedReferences(
    gitReferences.filter((gitReference) =>
      referenceType === "tag"
        ? gitReference.type === GitReferenceType.tag
        : (gitReference.type === GitReferenceType.localBranch ||
            gitReference.type === GitReferenceType.remoteBranch) &&
          gitReference.name !== undefined &&
          !gitReference.name.endsWith("/HEAD"),
    ),
  );
}

export function listTagAvailability(
  localTagReferences: readonly GitReference[],
  remoteTagReferences?: readonly GitReference[],
): readonly TagAvailability[] {
  const localTagsByName = mapNamedReferences(localTagReferences);
  if (remoteTagReferences === undefined) {
    return [...localTagsByName.entries()]
      .map(
        ([tagName, localTagReference]): TagAvailability => ({
          availableLocally: true,
          ...(localTagReference.commit === undefined
            ? {}
            : { localCommit: localTagReference.commit }),
          name: tagName,
          syncStatus: "unchecked",
        }),
      )
      .toSorted(compareTagNames);
  }

  const remoteTagsByName = mapNamedReferences(remoteTagReferences);
  const allTagNames = new Set([...localTagsByName.keys(), ...remoteTagsByName.keys()]);
  return [...allTagNames]
    .map((tagName): TagAvailability => {
      const localTagReference = localTagsByName.get(tagName);
      const remoteTagReference = remoteTagsByName.get(tagName);
      const localCommit = localTagReference?.commit;
      const remoteCommit = remoteTagReference?.commit;
      return {
        availableLocally: localTagReference !== undefined,
        ...(localCommit === undefined ? {} : { localCommit }),
        name: tagName,
        ...(remoteCommit === undefined ? {} : { remoteCommit }),
        syncStatus: determineTagSyncStatus(localTagReference, remoteTagReference),
      };
    })
    .toSorted(compareTagNames);
}

export function countRepositoryChanges(repositoryState: RepositoryChangeCollections): number {
  return (
    repositoryState.indexChanges.length +
    repositoryState.mergeChanges.length +
    repositoryState.untrackedChanges.length +
    repositoryState.workingTreeChanges.length
  );
}

export function isRepositoryInWorkspaceContext(
  repositoryRootPath: string,
  workspaceFolderPaths: readonly string[],
): boolean {
  return workspaceFolderPaths.some(
    (workspaceFolderPath) =>
      isSameOrDescendantPath(workspaceFolderPath, repositoryRootPath) ||
      isSameOrDescendantPath(repositoryRootPath, workspaceFolderPath),
  );
}

function isSameOrDescendantPath(ancestorPath: string, candidatePath: string): boolean {
  const pathFromAncestor = relative(ancestorPath, candidatePath);
  return (
    pathFromAncestor === "" ||
    (pathFromAncestor !== ".." &&
      !pathFromAncestor.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromAncestor))
  );
}

function formatRemoteBranchName(remoteName: string, branchName: string): string {
  return branchName.startsWith(`${remoteName}/`) ? branchName : `${remoteName}/${branchName}`;
}

function removeRemotePrefix(remoteBranchName: string, remoteName: string | undefined): string {
  const remotePrefix = remoteName ? `${remoteName}/` : undefined;
  if (remotePrefix !== undefined && remoteBranchName.startsWith(remotePrefix)) {
    return remoteBranchName.slice(remotePrefix.length);
  }
  const firstPathSeparator = remoteBranchName.indexOf("/");
  return firstPathSeparator === -1
    ? remoteBranchName
    : remoteBranchName.slice(firstPathSeparator + 1);
}

function mapNamedReferences(
  gitReferences: readonly GitReference[],
): ReadonlyMap<string, GitReference> {
  return new Map(
    gitReferences.flatMap((gitReference) =>
      gitReference.name === undefined ? [] : [[gitReference.name, gitReference] as const],
    ),
  );
}

function determineTagSyncStatus(
  localTagReference: GitReference | undefined,
  remoteTagReference: GitReference | undefined,
): Exclude<TagSyncStatus, "unchecked"> {
  if (localTagReference === undefined) {
    return "remoteOnly";
  }
  if (remoteTagReference === undefined) {
    return "localOnly";
  }
  return localTagReference.commit !== undefined &&
    localTagReference.commit === remoteTagReference.commit
    ? "synced"
    : "conflict";
}

function compareTagNames(firstTag: TagAvailability, secondTag: TagAvailability): number {
  return firstTag.name.localeCompare(secondTag.name);
}

function sortNamedReferences(gitReferences: readonly GitReference[]): readonly NamedGitReference[] {
  return gitReferences
    .filter(
      (gitReference): gitReference is GitReference & { readonly name: string } =>
        gitReference.name !== undefined,
    )
    .toSorted((firstReference, secondReference) =>
      firstReference.name.localeCompare(secondReference.name),
    );
}
