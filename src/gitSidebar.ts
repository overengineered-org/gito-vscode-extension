import * as vscode from "vscode";

import { createBranchPresentation } from "./branchPresentation.ts";
import { type GitApi, type GitRepository, loadGitCommitsWithTimeout } from "./gitApi.ts";
import {
  type BranchAvailability,
  type BranchLocation,
  buildBranchInventory,
  type BranchLagNotice,
  countRepositoryChanges,
  determineCurrentBranchSyncStatus,
  type GitReference,
  GitReferenceType,
  type NamedGitReference,
  listBranchLagNotices,
  listPrunableLocalBranches,
  listSwitchableReferences,
  listTagAvailability,
  type RepositoryReferenceType,
  type TagAvailability,
} from "./gitModel.ts";
import { createGitSidebarTreeItemId } from "./gitSidebarIdentity.ts";
import { listRemoteTagReferences } from "./remoteTags.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";
import {
  createRepositoryFamilyKey,
  findPrimaryWorktree,
  formatWorktreeBranchName,
  selectRepositoryFamilyRepresentatives,
} from "./worktreeModel.ts";
import type { Worktrees } from "./worktrees.ts";
import { formatWorktreeWipSummary } from "./worktreeStatus.ts";
import { gitThemeColorIds } from "./gitTheme.ts";
import { pathsIdentifySameLocation } from "./pathIdentity.ts";

interface RemoteTagSnapshot {
  readonly remoteName: string;
  readonly tagReferences: readonly GitReference[];
}

interface BranchLagSnapshot {
  readonly branchLagNotices: readonly BranchLagNotice[];
  readonly repositoryStateKey: string;
}

interface BranchLagRefresh {
  readonly repositoryStateKey: string;
  readonly promise: Promise<void>;
}

export type GitSidebarNode =
  | { readonly nodeType: "repository"; readonly repository: GitRepository }
  | { readonly nodeType: "worktreeGroup"; readonly repository: GitRepository }
  | { readonly nodeType: "createWorktree"; readonly repository: GitRepository }
  | {
      readonly nodeType: "worktree";
      readonly repository: GitRepository;
      readonly worktree: GitRepository["state"]["worktrees"][number];
    }
  | {
      readonly nodeType: "createReference";
      readonly referenceType: RepositoryReferenceType;
      readonly repository: GitRepository;
    }
  | {
      readonly nodeType: "switchReference";
      readonly referenceType: RepositoryReferenceType;
      readonly repository: GitRepository;
    }
  | {
      readonly nodeType: "referenceGroup";
      readonly referenceType: RepositoryReferenceType;
      readonly repository: GitRepository;
    }
  | { readonly nodeType: "fetchRemoteBranches"; readonly repository: GitRepository }
  | { readonly nodeType: "pruneLocalBranches"; readonly repository: GitRepository }
  | {
      readonly branchLagNotice: BranchLagNotice;
      readonly nodeType: "branchLag";
      readonly repository: GitRepository;
    }
  | {
      readonly branchLocation: BranchLocation;
      readonly branches: readonly BranchAvailability[];
      readonly nodeType: "branchCollection";
      readonly repository: GitRepository;
    }
  | {
      readonly availability: BranchAvailability;
      readonly nodeType: "branchReference";
      readonly repository: GitRepository;
    }
  | { readonly nodeType: "compareRemoteTags"; readonly repository: GitRepository }
  | {
      readonly availability: TagAvailability;
      readonly nodeType: "tagReference";
      readonly repository: GitRepository;
    };

export class GitSidebar implements vscode.TreeDataProvider<GitSidebarNode>, vscode.Disposable {
  private readonly branchLagSnapshots = new Map<string, BranchLagSnapshot>();
  private readonly branchLagRefreshes = new Map<string, BranchLagRefresh>();
  private readonly remoteTagComparisonTokens = new Map<string, symbol>();
  private readonly remoteTagSnapshots = new Map<string, RemoteTagSnapshot>();
  private readonly worktreeSubscription: vscode.Disposable;
  private readonly workspaceRepositorySubscription: vscode.Disposable;
  private readonly windowFocusSubscription: vscode.Disposable;
  private readonly treeChangedEmitter = new vscode.EventEmitter<GitSidebarNode | undefined>();
  private scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
  private workspaceStateVersion = 0;

  public readonly onDidChangeTreeData = this.treeChangedEmitter.event;

  public constructor(
    private readonly gitApi: GitApi,
    private readonly workspaceRepositories: WorkspaceRepositories,
    private readonly worktrees: Worktrees,
    private readonly diagnostics: vscode.LogOutputChannel,
  ) {
    this.workspaceRepositorySubscription = workspaceRepositories.onDidChange(() =>
      this.scheduleRefresh(),
    );
    this.worktreeSubscription = worktrees.onDidChange(() => this.refresh());
    this.windowFocusSubscription = vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) this.scheduleRefresh();
    });
  }

  public dispose(): void {
    this.workspaceRepositorySubscription.dispose();
    this.worktreeSubscription.dispose();
    this.windowFocusSubscription.dispose();
    if (this.scheduledRefresh !== undefined) {
      clearTimeout(this.scheduledRefresh);
    }
    this.treeChangedEmitter.dispose();
  }

  public async getChildren(parentNode?: GitSidebarNode): Promise<GitSidebarNode[]> {
    if (parentNode === undefined) {
      return this.getWorkspaceRepositories().map(
        (repository): GitSidebarNode => ({ nodeType: "repository", repository }),
      );
    }

    switch (parentNode.nodeType) {
      case "repository":
        return createRepositoryChildren(parentNode.repository);
      case "worktreeGroup":
        const repositoryWorktrees = await this.worktrees.refreshRepositoryWorktrees(
          parentNode.repository,
        );
        return [
          { nodeType: "createWorktree", repository: parentNode.repository },
          ...repositoryWorktrees.map(
            (worktree): GitSidebarNode => ({
              nodeType: "worktree",
              repository: parentNode.repository,
              worktree,
            }),
          ),
        ];
      case "referenceGroup":
        return parentNode.referenceType === "branch"
          ? this.getBranchGroupChildren(parentNode.repository)
          : this.getTagGroupChildren(parentNode.repository);
      case "branchCollection":
        return parentNode.branches.map(
          (branchAvailability): GitSidebarNode => ({
            availability: branchAvailability,
            nodeType: "branchReference",
            repository: parentNode.repository,
          }),
        );
      default:
        return [];
    }
  }

  public getTreeItem(sidebarNode: GitSidebarNode): vscode.TreeItem {
    switch (sidebarNode.nodeType) {
      case "repository":
        return this.createRepositoryTreeItem(sidebarNode.repository);
      case "worktreeGroup":
        return this.createWorktreeGroupTreeItem(sidebarNode.repository);
      case "createWorktree":
        return createCommandTreeItem(
          createGitSidebarTreeItemId(
            createRepositoryFamilyKey(
              sidebarNode.repository.rootUri.fsPath,
              sidebarNode.repository.state.worktrees,
            ),
            "create-worktree",
          ),
          "Create Feature Worktree…",
          "add",
          "gito.createWorktree",
          sidebarNode.repository.rootUri,
        );
      case "worktree":
        return this.createWorktreeTreeItem(sidebarNode);
      case "createReference":
        return this.createReferenceActionTreeItem(sidebarNode);
      case "switchReference":
        return createCommandTreeItem(
          createGitSidebarTreeItemId(
            sidebarNode.repository.rootUri.fsPath,
            "switch-reference",
            sidebarNode.referenceType,
          ),
          sidebarNode.referenceType === "branch" ? "Switch Branch…" : "Switch Local Tag…",
          sidebarNode.referenceType === "branch" ? "git-branch" : "tag",
          "gito.switchReference",
          sidebarNode.repository.rootUri,
          sidebarNode.referenceType,
        );
      case "referenceGroup":
        return this.createReferenceGroupTreeItem(sidebarNode);
      case "fetchRemoteBranches":
        return createCommandTreeItem(
          createGitSidebarTreeItemId(
            sidebarNode.repository.rootUri.fsPath,
            "fetch-remote-branches",
          ),
          "Fetch Remote Updates…",
          "git-fetch",
          "git.fetch",
          sidebarNode.repository.rootUri,
        );
      case "pruneLocalBranches":
        return createCommandTreeItem(
          createGitSidebarTreeItemId(
            sidebarNode.repository.rootUri.fsPath,
            "prune-local-branches",
          ),
          "Prune Local Branches…",
          "clear-all",
          "gito.pruneLocalBranches",
          sidebarNode.repository.rootUri,
        );
      case "branchLag":
        return createBranchLagTreeItem(sidebarNode);
      case "branchCollection":
        return createBranchCollectionTreeItem(sidebarNode);
      case "branchReference":
        return this.createBranchTreeItem(sidebarNode);
      case "compareRemoteTags":
        return createCommandTreeItem(
          createGitSidebarTreeItemId(
            sidebarNode.repository.rootUri.fsPath,
            "compare-remote-tags",
          ),
          "Compare with Remote…",
          "sync",
          "gito.compareRemoteTags",
          sidebarNode.repository.rootUri,
        );
      case "tagReference":
        return this.createTagTreeItem(sidebarNode);
    }
  }

  public async compareRemoteTags(repositoryRootUri: vscode.Uri): Promise<void> {
    const repository = this.workspaceRepositories.findRepository(repositoryRootUri.fsPath);
    if (repository === undefined) {
      void vscode.window.showErrorMessage(
        "Git'o could not find this repository in the opened workspace.",
      );
      return;
    }
    const remoteNames = [
      ...new Set(
        repository.state.remotes
          .map((remote) => remote.name)
          .filter((remoteName) => remoteName !== ""),
      ),
    ].toSorted();
    if (remoteNames.length === 0) {
      void vscode.window.showInformationMessage("Git'o: This repository has no Git remotes.");
      return;
    }

    const remoteName =
      remoteNames.length === 1
        ? remoteNames[0]
        : await vscode.window.showQuickPick(remoteNames, {
            placeHolder: "Select the remote whose tags you want to compare",
            title: "Git'o: Compare Tags",
          });
    if (remoteName === undefined) {
      return;
    }

    const repositoryPath = repository.rootUri.fsPath;
    const comparisonToken = Symbol(remoteName);
    this.remoteTagComparisonTokens.set(repositoryPath, comparisonToken);
    try {
      const remoteTagReferences = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Git'o: Comparing tags with ${remoteName}`,
        },
        () =>
          listRemoteTagReferences(
            this.gitApi.git.path,
            this.gitApi.git.env,
            repository.rootUri.fsPath,
            remoteName,
          ),
      );
      const currentRepository = this.workspaceRepositories.findRepository(repositoryPath);
      if (
        this.remoteTagComparisonTokens.get(repositoryPath) !== comparisonToken ||
        currentRepository === undefined ||
        !currentRepository.state.remotes.some((remote) => remote.name === remoteName)
      ) {
        return;
      }
      this.remoteTagSnapshots.set(repositoryPath, {
        remoteName,
        tagReferences: remoteTagReferences,
      });
      // Tree nodes are rebuilt on demand, so a newly-created repository node is
      // not the same object currently held by VS Code. Refresh the root to make
      // the saved comparison visible immediately.
      this.treeChangedEmitter.fire(undefined);
      void vscode.window.showInformationMessage(
        `Git'o: Compared ${remoteTagReferences.length} remote ${remoteTagReferences.length === 1 ? "tag" : "tags"} with ${remoteName}.`,
      );
    } catch (tagComparisonFailure) {
      this.diagnostics.error(
        `Remote tag comparison failed for '${remoteName}'.`,
        tagComparisonFailure,
      );
      if (this.remoteTagComparisonTokens.get(repositoryPath) === comparisonToken) {
        void vscode.window.showErrorMessage(
          `Git'o could not read tags from '${remoteName}'. Check the remote and VS Code's Git authentication, then retry.`,
        );
      }
    } finally {
      if (this.remoteTagComparisonTokens.get(repositoryPath) === comparisonToken) {
        this.remoteTagComparisonTokens.delete(repositoryPath);
      }
    }
  }

  public async switchReference(
    repositoryRootUri: vscode.Uri,
    referenceType: RepositoryReferenceType,
  ): Promise<void> {
    const repository = this.workspaceRepositories.findRepository(repositoryRootUri.fsPath);
    if (repository === undefined) {
      void vscode.window.showErrorMessage(
        "Git'o could not find this repository in the opened workspace.",
      );
      return;
    }

    const gitReferences = await repository.getRefs({
      pattern:
        referenceType === "branch" ? ["refs/heads", "refs/remotes"] : "refs/tags",
      sort: "alphabetically",
    });
    const switchableReferences = listSwitchableReferences(gitReferences, referenceType);
    if (switchableReferences.length === 0) {
      void vscode.window.showInformationMessage(
        `Git'o: This repository has no ${referenceType === "branch" ? "branches" : "local tags"} to switch to.`,
      );
      return;
    }

    const selectedReference = await vscode.window.showQuickPick(
      switchableReferences.map((gitReference) => ({
        description:
          gitReference.type === GitReferenceType.localBranch
            ? "Local branch"
            : gitReference.type === GitReferenceType.remoteBranch
              ? "Remote-tracking branch"
              : "Local tag",
        iconPath: new vscode.ThemeIcon(
          gitReference.type === GitReferenceType.tag ? "tag" : "git-branch",
        ),
        label: gitReference.name,
        referenceName: gitReference.name,
      })),
      {
        placeHolder: `Select a ${referenceType === "branch" ? "branch" : "local tag"}`,
        title: `Git'o: Switch ${referenceType === "branch" ? "Branch" : "Local Tag"}`,
      },
    );
    if (selectedReference === undefined) {
      return;
    }
    await vscode.commands.executeCommand(
      "git.checkout",
      repository.rootUri,
      selectedReference.referenceName,
    );
  }

  public async pruneLocalBranches(repositoryRootUri: vscode.Uri): Promise<void> {
    const repository = this.workspaceRepositories.findRepository(repositoryRootUri.fsPath);
    if (repository === undefined) {
      void vscode.window.showErrorMessage(
        "Git'o could not find this repository in the opened workspace.",
      );
      return;
    }
    if (repository.state.remotes.length === 0) {
      void vscode.window.showInformationMessage(
        "Git'o: This repository has no remotes to compare local branches with.",
      );
      return;
    }

    let branchReferences: readonly GitReference[];
    try {
      await vscode.commands.executeCommand("git.fetchPrune", repository.rootUri);
      branchReferences = await repository.getRefs({
        pattern: ["refs/heads", "refs/remotes"],
        sort: "alphabetically",
      });
    } catch (branchRefreshFailure) {
      this.diagnostics.error("Remote branch refresh failed.", branchRefreshFailure);
      void vscode.window.showErrorMessage(
        "Git'o could not refresh remote branches. No local branches were deleted.",
      );
      return;
    }
    const prunableLocalBranches = listPrunableLocalBranches(
      branchReferences,
      repository.state.HEAD?.name,
    );
    if (prunableLocalBranches.length === 0) {
      void vscode.window.showInformationMessage(
        "Git'o: No local branches are missing from every remote.",
      );
      return;
    }

    const selectedBranches = await vscode.window.showQuickPick(
      prunableLocalBranches.map((branchReference) => ({
        branchName: branchReference.name,
        description: "Missing from every remote",
        label: branchReference.name,
      })),
      {
        canPickMany: true,
        placeHolder: "Select local branches to delete",
        title: "Git'o: Prune Local Branches",
      },
    );
    if (selectedBranches === undefined || selectedBranches.length === 0) {
      return;
    }

    const deleteConfirmation = await vscode.window.showWarningMessage(
      `Delete ${selectedBranches.length} selected local ${selectedBranches.length === 1 ? "branch" : "branches"}?`,
      {
        detail:
          "Only local branches are deleted. Unmerged branches require another confirmation from VS Code.",
        modal: true,
      },
      "Delete Local Branches",
    );
    if (deleteConfirmation !== "Delete Local Branches") {
      return;
    }

    const branchesThatCouldNotBeDeleted: string[] = [];
    for (const selectedBranch of selectedBranches) {
      try {
        await vscode.commands.executeCommand(
          "git.deleteBranch",
          repository.rootUri,
          selectedBranch.branchName,
        );
      } catch (branchDeletionFailure) {
        this.diagnostics.error(
          `Local branch deletion failed for '${selectedBranch.branchName}'.`,
          branchDeletionFailure,
        );
        branchesThatCouldNotBeDeleted.push(selectedBranch.branchName);
      }
    }
    if (branchesThatCouldNotBeDeleted.length > 0) {
      void vscode.window.showErrorMessage(
        `Git'o could not delete: ${branchesThatCouldNotBeDeleted.join(", ")}`,
      );
    }
  }

  private async getBranchGroupChildren(repository: GitRepository): Promise<GitSidebarNode[]> {
    const allBranches = await repository.getRefs({
      pattern: ["refs/heads", "refs/remotes"],
      sort: "alphabetically",
    });
    const branchLagNotices = this.getCurrentBranchLagNotices(repository);
    const { localBranches, remoteTrackingBranches } = buildBranchInventory(
      allBranches,
      repository.state.HEAD,
    );
    const currentBranchAvailability = localBranches.find(
      (branchAvailability) => branchAvailability.isCurrent,
    );
    const nonCurrentLocalBranches = localBranches.filter(
      (branchAvailability) => !branchAvailability.isCurrent,
    );
    return [
      { nodeType: "createReference", referenceType: "branch", repository },
      { nodeType: "switchReference", referenceType: "branch", repository },
      ...(currentBranchAvailability === undefined
        ? []
        : [
            {
              availability: currentBranchAvailability,
              nodeType: "branchReference" as const,
              repository,
            },
          ]),
      ...branchLagNotices.map(
        (branchLagNotice): GitSidebarNode => ({
          branchLagNotice,
          nodeType: "branchLag",
          repository,
        }),
      ),
      {
        branchLocation: "local",
        branches: nonCurrentLocalBranches,
        nodeType: "branchCollection",
        repository,
      },
      {
        branchLocation: "remoteTracking",
        branches: remoteTrackingBranches,
        nodeType: "branchCollection",
        repository,
      },
      { nodeType: "fetchRemoteBranches", repository },
      { nodeType: "pruneLocalBranches", repository },
    ];
  }

  private getCurrentBranchLagNotices(repository: GitRepository): readonly BranchLagNotice[] {
    const currentBranch = repository.state.HEAD;
    if (
      currentBranch?.name === undefined ||
      currentBranch.type !== GitReferenceType.localBranch
    ) {
      return [];
    }

    const namedCurrentBranch: NamedGitReference = {
      ...currentBranch,
      name: currentBranch.name,
    };
    const repositoryStateKey = createRepositoryStateKey(
      namedCurrentBranch,
      this.workspaceStateVersion,
    );
    const repositoryPath = repository.rootUri.fsPath;
    const cachedBranchLag = this.branchLagSnapshots.get(repositoryPath);
    if (cachedBranchLag?.repositoryStateKey === repositoryStateKey) {
      return cachedBranchLag.branchLagNotices;
    }
    if (
      this.branchLagRefreshes.get(repositoryPath)?.repositoryStateKey !== repositoryStateKey
    ) {
      const branchLagRefreshPromise = this.refreshBranchLagSnapshot(
        repository,
        namedCurrentBranch,
        repositoryStateKey,
      ).finally(() => {
        if (this.branchLagRefreshes.get(repositoryPath)?.promise === branchLagRefreshPromise) {
          this.branchLagRefreshes.delete(repositoryPath);
        }
      });
      this.branchLagRefreshes.set(repositoryPath, {
        repositoryStateKey,
        promise: branchLagRefreshPromise,
      });
    }
    return [];
  }

  private async refreshBranchLagSnapshot(
    repository: GitRepository,
    currentBranch: NamedGitReference,
    repositoryStateKey: string,
  ): Promise<void> {
    let branchLagNotices: readonly BranchLagNotice[] = [];
    try {
      const sourceBranch = await repository.getBranchBase(currentBranch.name);
      if (sourceBranch?.name !== undefined) {
        const sourceBranchName = formatBranchReferenceName(sourceBranch);
        const commitsBehindSource = await loadGitCommitsWithTimeout(repository, {
          maxEntries: 1_001,
          range: `${currentBranch.name}..${sourceBranchName}`,
        });
        branchLagNotices = listBranchLagNotices(currentBranch, {
          behindCommitCount: commitsBehindSource.length,
          referenceName: sourceBranchName,
        }).filter((branchLagNotice) => branchLagNotice.comparisonKind === "source");
      }
    } catch (branchLagFailure) {
      this.diagnostics.warn("Source branch comparison failed.", branchLagFailure);
    }
    const currentRepository = this.workspaceRepositories.findRepository(repository.rootUri.fsPath);
    const currentHead = currentRepository?.state.HEAD;
    if (
      currentRepository === undefined ||
      currentHead?.name === undefined ||
      createRepositoryStateKey(
        { ...currentHead, name: currentHead.name },
        this.workspaceStateVersion,
      ) !== repositoryStateKey
    ) {
      return;
    }
    this.branchLagSnapshots.set(repository.rootUri.fsPath, {
      branchLagNotices,
      repositoryStateKey,
    });
    this.treeChangedEmitter.fire(undefined);
  }

  private async getTagGroupChildren(repository: GitRepository): Promise<GitSidebarNode[]> {
    const localTagReferences = await repository.getRefs({
      pattern: "refs/tags",
      sort: "alphabetically",
    });
    return [
      { nodeType: "createReference", referenceType: "tag", repository },
      { nodeType: "switchReference", referenceType: "tag", repository },
      { nodeType: "compareRemoteTags", repository },
      ...listTagAvailability(
        localTagReferences,
        this.remoteTagSnapshots.get(repository.rootUri.fsPath)?.tagReferences,
      ).map(
        (availability): GitSidebarNode => ({
          availability,
          nodeType: "tagReference",
          repository,
        }),
      ),
    ];
  }

  public refresh(): void {
    this.workspaceStateVersion += 1;
    const workspaceRepositoryPaths = new Set(
      this.getWorkspaceRepositories().map((repository) => repository.rootUri.fsPath),
    );
    for (const repositoryPath of this.remoteTagSnapshots.keys()) {
      if (!workspaceRepositoryPaths.has(repositoryPath)) {
        this.remoteTagSnapshots.delete(repositoryPath);
      }
    }
    for (const repositoryPath of this.remoteTagComparisonTokens.keys()) {
      if (!workspaceRepositoryPaths.has(repositoryPath)) {
        this.remoteTagComparisonTokens.delete(repositoryPath);
      }
    }
    for (const repositoryPath of this.branchLagSnapshots.keys()) {
      if (!workspaceRepositoryPaths.has(repositoryPath)) {
        this.branchLagSnapshots.delete(repositoryPath);
      }
    }
    for (const repositoryPath of this.branchLagRefreshes.keys()) {
      if (!workspaceRepositoryPaths.has(repositoryPath)) {
        this.branchLagRefreshes.delete(repositoryPath);
      }
    }
    for (const repository of this.getWorkspaceRepositories()) {
      const repositoryPath = repository.rootUri.fsPath;
      const remoteTagSnapshot = this.remoteTagSnapshots.get(repositoryPath);
      if (
        remoteTagSnapshot !== undefined &&
        !repository.state.remotes.some((remote) => remote.name === remoteTagSnapshot.remoteName)
      ) {
        this.remoteTagSnapshots.delete(repositoryPath);
      }
    }
    this.treeChangedEmitter.fire(undefined);
  }

  private scheduleRefresh(): void {
    if (this.scheduledRefresh !== undefined) {
      clearTimeout(this.scheduledRefresh);
    }
    this.scheduledRefresh = setTimeout(() => {
      this.scheduledRefresh = undefined;
      this.refresh();
    }, 100);
  }

  private getWorkspaceRepositories(): readonly GitRepository[] {
    const workspaceRepositories = this.workspaceRepositories.repositories;
    const representativeRepositoryPaths = selectRepositoryFamilyRepresentatives(
      workspaceRepositories.map((repository) => ({
        repositoryPath: repository.rootUri.fsPath,
        worktrees: repository.state.worktrees,
      })),
      this.workspaceRepositories.selectedRepository?.rootUri.fsPath,
    );
    return representativeRepositoryPaths.flatMap((representativeRepositoryPath) => {
      const representativeRepository = workspaceRepositories.find(
        (repository) => repository.rootUri.fsPath === representativeRepositoryPath,
      );
      return representativeRepository === undefined ? [] : [representativeRepository];
    });
  }

  private createRepositoryTreeItem(repository: GitRepository): vscode.TreeItem {
    const primaryWorktree = findPrimaryWorktree(
      repository.rootUri.fsPath,
      repository.state.worktrees,
    );
    const repositoryName =
      primaryWorktree.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? primaryWorktree.path;
    const currentReference = repository.state.HEAD;
    const branchName = currentReference?.name ?? "Detached HEAD";
    const currentReferenceIconId = currentReference?.name === undefined ? "git-commit" : "git-branch";
    const repositoryTreeItem = new vscode.TreeItem(
      repositoryName,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    repositoryTreeItem.id = createGitSidebarTreeItemId(
      createRepositoryFamilyKey(repository.rootUri.fsPath, repository.state.worktrees),
      "repository",
    );
    const changeCount = countRepositoryChanges(repository.state);
    repositoryTreeItem.description =
      changeCount === 0 ? branchName : `${branchName} · ${changeCount} changes`;
    const currentBranchPresentation =
      currentReference?.name === undefined
        ? undefined
        : createBranchPresentation({
            availableLocally: true,
            availableRemotely: currentReference.upstream !== undefined,
            currentSyncStatus: determineCurrentBranchSyncStatus(currentReference),
            isCurrent: true,
            location: "local",
            reference: { ...currentReference, name: currentReference.name },
          });
    repositoryTreeItem.iconPath =
      currentBranchPresentation?.colorId === undefined
        ? new vscode.ThemeIcon(currentReferenceIconId)
        : new vscode.ThemeIcon(
            currentReferenceIconId,
            new vscode.ThemeColor(currentBranchPresentation.colorId),
          );
    repositoryTreeItem.tooltip = new vscode.MarkdownString(
      currentBranchPresentation === undefined
        ? `**Detached HEAD**\n\n${repository.rootUri.fsPath}`
        : `**${branchName}** — ${currentBranchPresentation.description}\n\n${currentBranchPresentation.tooltip}\n\n${repository.rootUri.fsPath}`,
    );
    repositoryTreeItem.accessibilityInformation = {
      label: `${repositoryName} repository, ${branchName} ${branchName === "Detached HEAD" ? "state" : "branch"}`,
    };
    return repositoryTreeItem;
  }

  private createWorktreeGroupTreeItem(repository: GitRepository): vscode.TreeItem {
    const worktreeGroupTreeItem = new vscode.TreeItem(
      "Worktrees",
      vscode.TreeItemCollapsibleState.Expanded,
    );
    worktreeGroupTreeItem.id = createGitSidebarTreeItemId(
      createRepositoryFamilyKey(repository.rootUri.fsPath, repository.state.worktrees),
      "worktree-group",
    );
    worktreeGroupTreeItem.description = String(repository.state.worktrees.length);
    worktreeGroupTreeItem.iconPath = new vscode.ThemeIcon("repo-forked");
    worktreeGroupTreeItem.tooltip =
      "Primary and linked worktrees for this repository. Each worktree has independent files, staging, and uncommitted changes.";
    return worktreeGroupTreeItem;
  }

  private createWorktreeTreeItem(
    worktreeNode: Extract<GitSidebarNode, { readonly nodeType: "worktree" }>,
  ): vscode.TreeItem {
    const { repository, worktree } = worktreeNode;
    const worktreeDisplayName = this.worktrees.getDisplayName(worktree);
    const isCurrentWorktree = pathsIdentifySameLocation(
      worktree.path,
      repository.rootUri.fsPath,
    );
    const branchName = formatWorktreeBranchName(worktree);
    const worktreeWipSummary = this.worktrees.getWipSummary(worktree.path);
    const formattedWipSummary =
      worktreeWipSummary === undefined ? "Status unavailable" : formatWorktreeWipSummary(worktreeWipSummary);
    const worktreeTreeItem = new vscode.TreeItem(worktreeDisplayName);
    worktreeTreeItem.id = createGitSidebarTreeItemId(
      createRepositoryFamilyKey(repository.rootUri.fsPath, repository.state.worktrees),
      "worktree",
      worktree.path,
    );
    worktreeTreeItem.contextValue = isCurrentWorktree
      ? "gito.worktree.current"
      : "gito.worktree.available";
    worktreeTreeItem.description = [
      isCurrentWorktree ? "Current" : undefined,
      branchName,
      worktree.main ? "Primary" : undefined,
      formattedWipSummary,
    ]
      .filter((worktreeDetail): worktreeDetail is string => worktreeDetail !== undefined)
      .join(" · ");
    const worktreeColor = worktreeWipSummary === undefined
      ? isCurrentWorktree ? new vscode.ThemeColor(gitThemeColorIds.clean) : undefined
      : worktreeWipSummary.conflictCount > 0
        ? new vscode.ThemeColor(gitThemeColorIds.conflict)
        : formattedWipSummary !== "Clean"
          ? new vscode.ThemeColor(gitThemeColorIds.wip)
          : isCurrentWorktree
            ? new vscode.ThemeColor(gitThemeColorIds.clean)
            : undefined;
    worktreeTreeItem.iconPath = new vscode.ThemeIcon(
      worktree.main ? "repo" : "repo-forked",
      worktreeColor,
    );
    worktreeTreeItem.tooltip = new vscode.MarkdownString(
      `**${branchName}**\n\n${formattedWipSummary}\n\n${worktree.main ? "Primary worktree" : "Linked worktree"}\n\n${worktree.path}`,
    );
    worktreeTreeItem.accessibilityInformation = {
      label: `${worktreeDisplayName}, ${branchName}, ${isCurrentWorktree ? "current" : "available"} worktree, ${formattedWipSummary}`,
    };
    if (!isCurrentWorktree) {
      worktreeTreeItem.command = {
        arguments: [worktree.path],
        command: "gito.openWorktreeInNewWindow",
        title: `Open ${worktreeDisplayName} in New Window`,
      };
    }
    return worktreeTreeItem;
  }

  private createReferenceActionTreeItem(
    createReferenceNode: Extract<GitSidebarNode, { readonly nodeType: "createReference" }>,
  ): vscode.TreeItem {
    const referenceLabel =
      createReferenceNode.referenceType === "branch" ? "Branch" : "Local Tag";
    return createCommandTreeItem(
      createGitSidebarTreeItemId(
        createReferenceNode.repository.rootUri.fsPath,
        "create-reference",
        createReferenceNode.referenceType,
      ),
      `Create ${referenceLabel}…`,
      "add",
      createReferenceNode.referenceType === "branch" ? "git.branch" : "git.createTag",
      createReferenceNode.repository.rootUri,
    );
  }

  private createReferenceGroupTreeItem(
    referenceGroupNode: Extract<GitSidebarNode, { readonly nodeType: "referenceGroup" }>,
  ): vscode.TreeItem {
    const groupLabel = referenceGroupNode.referenceType === "branch" ? "Branches" : "Tags";
    const referenceGroupTreeItem = new vscode.TreeItem(
      groupLabel,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    referenceGroupTreeItem.id = createGitSidebarTreeItemId(
      referenceGroupNode.repository.rootUri.fsPath,
      "reference-group",
      referenceGroupNode.referenceType,
    );
    if (referenceGroupNode.referenceType === "tag") {
      const remoteTagSnapshot = this.remoteTagSnapshots.get(
        referenceGroupNode.repository.rootUri.fsPath,
      );
      referenceGroupTreeItem.description =
        remoteTagSnapshot === undefined ? "remote unchecked" : `${remoteTagSnapshot.remoteName} checked`;
    }
    referenceGroupTreeItem.iconPath = new vscode.ThemeIcon(
      referenceGroupNode.referenceType === "branch" ? "git-branch" : "tag",
    );
    return referenceGroupTreeItem;
  }

  private createBranchTreeItem(
    branchNode: Extract<GitSidebarNode, { readonly nodeType: "branchReference" }>,
  ): vscode.TreeItem {
    const branchTreeItem = new vscode.TreeItem(branchNode.availability.reference.name);
    branchTreeItem.id = createGitSidebarTreeItemId(
      branchNode.repository.rootUri.fsPath,
      "branch",
      `${branchNode.availability.location}:${branchNode.availability.reference.name}`,
    );
    const branchPresentation = createBranchPresentation(branchNode.availability);
    branchTreeItem.description = branchPresentation.description;
    branchTreeItem.iconPath =
      branchPresentation.colorId === undefined
        ? new vscode.ThemeIcon(branchPresentation.iconId)
        : new vscode.ThemeIcon(
            branchPresentation.iconId,
            new vscode.ThemeColor(branchPresentation.colorId),
          );
    branchTreeItem.command = {
      arguments: [branchNode.repository.rootUri, branchNode.availability.reference.name],
      command: "git.checkout",
      title: `Checkout ${branchNode.availability.reference.name}`,
    };
    branchTreeItem.tooltip = new vscode.MarkdownString(
      `${branchPresentation.tooltip}\n\nCommit: \`${branchNode.availability.reference.commit ?? "unknown"}\``,
    );
    return branchTreeItem;
  }

  private createTagTreeItem(
    tagNode: Extract<GitSidebarNode, { readonly nodeType: "tagReference" }>,
  ): vscode.TreeItem {
    const tagTreeItem = new vscode.TreeItem(tagNode.availability.name);
    tagTreeItem.id = createGitSidebarTreeItemId(
      tagNode.repository.rootUri.fsPath,
      "tag",
      tagNode.availability.name,
    );
    const remoteName = this.remoteTagSnapshots.get(tagNode.repository.rootUri.fsPath)?.remoteName;
    const tagPresentation = createTagPresentation(tagNode.availability, remoteName);
    tagTreeItem.description = tagPresentation.description;
    tagTreeItem.iconPath =
      tagPresentation.colorId === undefined
        ? new vscode.ThemeIcon(tagPresentation.iconId)
        : new vscode.ThemeIcon(
            tagPresentation.iconId,
            new vscode.ThemeColor(tagPresentation.colorId),
          );
    tagTreeItem.tooltip = tagPresentation.tooltip;
    if (tagNode.availability.availableLocally) {
      tagTreeItem.command = {
        arguments: [tagNode.repository.rootUri, tagNode.availability.name],
        command: "git.checkout",
        title: `Checkout ${tagNode.availability.name}`,
      };
    }
    return tagTreeItem;
  }
}

function createRepositoryChildren(repository: GitRepository): GitSidebarNode[] {
  return [
    { nodeType: "worktreeGroup", repository },
    { nodeType: "referenceGroup", referenceType: "branch", repository },
    { nodeType: "referenceGroup", referenceType: "tag", repository },
  ];
}

function createBranchCollectionTreeItem(
  branchCollectionNode: Extract<GitSidebarNode, { readonly nodeType: "branchCollection" }>,
): vscode.TreeItem {
  const isLocalCollection = branchCollectionNode.branchLocation === "local";
  const branchCollectionTreeItem = new vscode.TreeItem(
    isLocalCollection ? "Local" : "Remote-tracking",
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  branchCollectionTreeItem.id = createGitSidebarTreeItemId(
    branchCollectionNode.repository.rootUri.fsPath,
    "branch-collection",
    branchCollectionNode.branchLocation,
  );
  const branchesWithoutCounterpart = branchCollectionNode.branches.filter(
    (branchAvailability) =>
      isLocalCollection
        ? !branchAvailability.availableRemotely
        : !branchAvailability.availableLocally,
  ).length;
  const locationSummary = isLocalCollection ? "local only" : "remote only";
  branchCollectionTreeItem.description =
    branchesWithoutCounterpart === 0
      ? String(branchCollectionNode.branches.length)
      : `${branchCollectionNode.branches.length} · ${branchesWithoutCounterpart} ${locationSummary}`;
  branchCollectionTreeItem.iconPath =
    branchesWithoutCounterpart === 0
      ? new vscode.ThemeIcon(isLocalCollection ? "device-desktop" : "cloud")
      : new vscode.ThemeIcon(
          isLocalCollection ? "device-desktop" : "cloud",
          new vscode.ThemeColor(
            isLocalCollection ? gitThemeColorIds.localOnly : gitThemeColorIds.remoteOnly,
          ),
        );
  branchCollectionTreeItem.tooltip = isLocalCollection
    ? "Branches available locally"
    : "Remote branches known from the latest fetch";
  return branchCollectionTreeItem;
}

function createBranchLagTreeItem(
  branchLagNode: Extract<GitSidebarNode, { readonly nodeType: "branchLag" }>,
): vscode.TreeItem {
  const { branchLagNotice } = branchLagNode;
  const behindCommitCount =
    branchLagNotice.behindCommitCount > 1_000
      ? "1,000+"
      : String(branchLagNotice.behindCommitCount);
  const branchLagTreeItem = new vscode.TreeItem(
    `Behind ${branchLagNotice.referenceName} by ${behindCommitCount} ${branchLagNotice.behindCommitCount === 1 ? "commit" : "commits"}`,
  );
  branchLagTreeItem.id = createGitSidebarTreeItemId(
    branchLagNode.repository.rootUri.fsPath,
    "branch-lag",
    `${branchLagNotice.comparisonKind}:${branchLagNotice.referenceName}`,
  );
  branchLagTreeItem.description =
    branchLagNotice.comparisonKind === "source" ? "Source branch" : "Upstream";
  branchLagTreeItem.iconPath = new vscode.ThemeIcon(
    "warning",
    new vscode.ThemeColor(gitThemeColorIds.behind),
  );
  branchLagTreeItem.tooltip =
    branchLagNotice.comparisonKind === "source"
      ? "The current branch is behind the branch VS Code detected as its source. Based on fetched refs."
      : "The current branch is behind its configured upstream. Based on fetched refs.";
  return branchLagTreeItem;
}

function formatBranchReferenceName(branchReference: GitReference): string {
  if (branchReference.name === undefined) {
    return "";
  }
  return branchReference.remote !== undefined &&
    !branchReference.name.startsWith(`${branchReference.remote}/`)
    ? `${branchReference.remote}/${branchReference.name}`
    : branchReference.name;
}

function createRepositoryStateKey(
  currentBranch: NamedGitReference,
  workspaceStateVersion: number,
): string {
  return [
    workspaceStateVersion,
    currentBranch.name,
    currentBranch.commit ?? "",
    currentBranch.ahead ?? "",
    currentBranch.behind ?? "",
    currentBranch.upstream?.remote ?? "",
    currentBranch.upstream?.name ?? "",
  ].join(":");
}

interface TagPresentation {
  readonly colorId?: string;
  readonly description: string;
  readonly iconId: string;
  readonly tooltip: string;
}

function createTagPresentation(
  tagAvailability: TagAvailability,
  remoteName: string | undefined,
): TagPresentation {
  const comparedRemoteName = remoteName ?? "remote";
  switch (tagAvailability.syncStatus) {
    case "synced":
      return {
        colorId: gitThemeColorIds.clean,
        description: `Synced with ${comparedRemoteName}`,
        iconId: "check",
        tooltip: `Available locally and on ${comparedRemoteName}.`,
      };
    case "localOnly":
      return {
        colorId: gitThemeColorIds.localOnly,
        description: "Local only · not pushed",
        iconId: "cloud-upload",
        tooltip: `Local only. Not pushed to ${comparedRemoteName}.`,
      };
    case "remoteOnly":
      return {
        colorId: gitThemeColorIds.remoteOnly,
        description: `${comparedRemoteName} only · not fetched`,
        iconId: "cloud-download",
        tooltip: `Available on ${comparedRemoteName}. Not fetched locally.`,
      };
    case "conflict":
      return {
        colorId: gitThemeColorIds.conflict,
        description: "Conflict · same name, different commit",
        iconId: "warning",
        tooltip: `This tag name points to different commits locally and on ${comparedRemoteName}.`,
      };
    case "unchecked":
      return {
        description: "Local · remote unchecked",
        iconId: "tag",
        tooltip: "Available locally. Remote status has not been checked.",
      };
  }
}

function createCommandTreeItem(
  treeItemId: string,
  actionLabel: string,
  themeIconId: string,
  commandId: string,
  ...commandArguments: readonly unknown[]
): vscode.TreeItem {
  const commandTreeItem = new vscode.TreeItem(actionLabel);
  commandTreeItem.id = treeItemId;
  commandTreeItem.iconPath = new vscode.ThemeIcon(themeIconId);
  commandTreeItem.command = {
    arguments: [...commandArguments],
    command: commandId,
    title: actionLabel,
  };
  return commandTreeItem;
}
