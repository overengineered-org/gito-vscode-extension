import assert from "node:assert/strict";

import * as vscode from "vscode";

import { WorkingTreeChanges } from "../../src/workingTreeChanges.ts";
import { CommitView } from "../../src/commitView.ts";
import { ConflictGuide, inspectConflictContext } from "../../src/conflictGuide.ts";
import { createConflictGuidePresentation } from "../../src/conflictGuideModel.ts";
import { loadBuiltInGitApi } from "../../src/gitApi.ts";
import { GitSidebar } from "../../src/gitSidebar.ts";
import { loadCommitGraphPage } from "../../src/graphHistory.ts";
import { searchCommitHistory } from "../../src/graphSearch.ts";
import { GitReferenceType } from "../../src/gitModel.ts";
import { GraphView } from "../../src/graphView.ts";
import { pathsIdentifySameLocation } from "../../src/pathIdentity.ts";
import { listRemoteTagReferences } from "../../src/remoteTags.ts";
import { WorkspaceRepositories } from "../../src/workspaceRepositories.ts";
import { createWorktreeCheckoutPath } from "../../src/worktreeModel.ts";
import { Worktrees } from "../../src/worktrees.ts";
import { loadWorktreeWipSummary } from "../../src/worktreeStatus.ts";

interface PostedGraphMessage {
  readonly actions?: readonly { readonly disabledReason?: string; readonly id: string }[];
  readonly commitHash?: string;
  readonly fileHistoryPath?: string;
  readonly repositoryName?: string;
  readonly rows?: readonly { readonly hash: string; readonly subject: string }[];
  readonly searchText?: string;
  readonly syncPreview?: {
    readonly incomingCommitCount: number;
    readonly outgoingCommitCount: number;
    readonly upstreamName: string;
    readonly workingTreeClean: boolean;
  };
  readonly type?: string;
  readonly worktrees?: readonly { readonly displayName: string; readonly summary: string }[];
}

interface PostedCommitMessage {
  readonly completed?: boolean;
  readonly changeGroups?: readonly {
    readonly changes: readonly { readonly filePath: string }[];
    readonly groupKind: string;
  }[];
  readonly type?: string;
  readonly message?: string;
}

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Integration workspace did not open.");

  const gitApi = await loadBuiltInGitApi();
  const availableVsCodeCommands = new Set(await vscode.commands.getCommands(true));
  const missingNativeGitCommands = [
    "git.branch",
    "git.checkout",
    "git.commit",
    "git.commitAll",
    "git.commitAmend",
    "git.commitStaged",
    "git.createTag",
    "git.deleteBranch",
    "git.fetch",
    "git.fetchPrune",
    "git.openChange",
    "git.openMergeEditor",
    "git.push",
    "git.pushForce",
    "git.pushTags",
    "git.pushTo",
    "git.pushToForce",
    "git.pushWithTags",
    "git.rebaseAbort",
    "git.viewCommit",
    "vscode.openFolder",
  ].filter((commandId) => !availableVsCodeCommands.has(commandId));
  assert.deepEqual(
    missingNativeGitCommands,
    [],
    `VS Code no longer provides native commands used by Git'o: ${missingNativeGitCommands.join(", ")}`,
  );
  const repository = await waitForRepository(gitApi, workspaceFolder.uri.fsPath);
  const [branchReferences, tagReferences] = await Promise.all([
    repository.getRefs({ pattern: ["refs/heads", "refs/remotes"] }),
    repository.getRefs({ pattern: "refs/tags" }),
  ]);
  const graphPage = await loadCommitGraphPage(
    repository,
    [...branchReferences, ...tagReferences],
    50,
  );
  assert.deepEqual(
    graphPage.rows.slice(0, 2).map((graphRow) => graphRow.subject),
    ["test: second history entry", "test: first history entry"],
  );
  const fileHistoryPage = await loadCommitGraphPage(
    repository,
    [...branchReferences, ...tagReferences],
    50,
    "history.txt",
  );
  assert.deepEqual(
    fileHistoryPage.rows.map((graphRow) => graphRow.subject),
    ["test: second history entry", "test: first history entry"],
  );
  const searchedHistoryPage = await searchCommitHistory(
    {
      environment: gitApi.git.env,
      executablePath: gitApi.git.path,
      repositoryPath: repository.rootUri.fsPath,
    },
    [...branchReferences, ...tagReferences],
    "message:second author:Repository",
    undefined,
    50,
  );
  assert.deepEqual(
    searchedHistoryPage.commits.map((gitCommit) => gitCommit.message),
    ["test: second history entry"],
  );

  const remoteTagReferences = await listRemoteTagReferences(
    gitApi.git.path,
    gitApi.git.env,
    repository.rootUri.fsPath,
    "origin",
  );
  assert.deepEqual(
    remoteTagReferences.map((tagReference) => tagReference.name),
    ["v1.0.0", "v1.1.0"],
  );
  const localAnnotatedTag = tagReferences.find(
    (tagReference) =>
      tagReference.type === GitReferenceType.tag && tagReference.name === "v1.0.0",
  );
  const remoteAnnotatedTag = remoteTagReferences.find(
    (tagReference) => tagReference.name === "v1.0.0",
  );
  assert.equal(remoteAnnotatedTag?.commit, localAnnotatedTag?.commit);

  const workspaceRepositories = new WorkspaceRepositories(gitApi);
  const diagnostics = vscode.window.createOutputChannel("Git'o integration", { log: true });
  const globalState = new MemoryMemento();
  const worktrees = new Worktrees(gitApi, globalState, diagnostics);
  const gitSidebar = new GitSidebar(gitApi, workspaceRepositories, worktrees, diagnostics);
  const workingTreeChanges = new WorkingTreeChanges(workspaceRepositories);
  const conflictGuide = new ConflictGuide(diagnostics);
  const commitView = new CommitView(
    workspaceRepositories,
    workingTreeChanges,
    conflictGuide,
    diagnostics,
  );
  const gitTreeRefreshTargets: unknown[] = [];
  const gitTreeRefreshSubscription = gitSidebar.onDidChangeTreeData((refreshTarget) => {
    gitTreeRefreshTargets.push(refreshTarget);
  });
  const graphView = new GraphView(gitApi, workspaceRepositories, worktrees, diagnostics);
  const messageEmitter = new vscode.EventEmitter<unknown>();
  const disposalEmitter = new vscode.EventEmitter<void>();
  const visibilityEmitter = new vscode.EventEmitter<void>();
  const postedGraphMessages: PostedGraphMessage[] = [];
  const commitMessageEmitter = new vscode.EventEmitter<unknown>();
  const commitDisposalEmitter = new vscode.EventEmitter<void>();
  const postedCommitMessages: PostedCommitMessage[] = [];
  const testCommitWebview = {
    html: "",
    onDidReceiveMessage: commitMessageEmitter.event,
    options: {},
    postMessage: (commitMessage: PostedCommitMessage) => {
      postedCommitMessages.push(commitMessage);
      return Promise.resolve(true);
    },
  };
  const testCommitWebviewView = {
    onDidDispose: commitDisposalEmitter.event,
    webview: testCommitWebview,
  } as unknown as vscode.WebviewView;
  const testWebview = {
    html: "",
    onDidReceiveMessage: messageEmitter.event,
    options: {},
    postMessage: (graphMessage: PostedGraphMessage) => {
      postedGraphMessages.push(graphMessage);
      return Promise.resolve(true);
    },
  };
  const testWebviewView = {
    onDidChangeVisibility: visibilityEmitter.event,
    onDidDispose: disposalEmitter.event,
    visible: true,
    webview: testWebview,
  } as unknown as vscode.WebviewView;
  let createdWorktreePath: string | undefined;
  let integrationChangeCreated = false;
  let mergeConflictStarted = false;
  const integrationChangeUri = vscode.Uri.joinPath(repository.rootUri, "integration-change.txt");
  const mergeConflictUri = vscode.Uri.joinPath(repository.rootUri, "merge-conflict.txt");

  try {
    commitView.resolveWebviewView(testCommitWebviewView);
    commitMessageEmitter.fire({ type: "ready" });
    const expectedWorktreePath = createWorktreeCheckoutPath(
      repository.rootUri.fsPath,
      repository.state.worktrees,
      "",
      "Integration Worktree",
      "unused-home",
    );
    createdWorktreePath = await worktrees.createFeatureWorktree(repository, {
      branchName: "test/integration-worktree",
      displayName: "Integration Worktree",
    });
    assert.equal(createdWorktreePath, expectedWorktreePath);
    const createdWorktree = (
      await worktrees.refreshRepositoryWorktrees(repository)
    ).find((candidateWorktree) => candidateWorktree.path === expectedWorktreePath);
    assert.ok(createdWorktree, "Git'o did not discover the created worktree.");
    assert.equal(createdWorktree.ref, "refs/heads/test/integration-worktree");
    assert.equal(createdWorktree.main, false);
    assert.equal(
      expectedWorktreePath.startsWith(`${repository.rootUri.fsPath}/`),
      false,
      "Linked worktree must be outside the primary checkout.",
    );
    await worktrees.setDisplayName(createdWorktree.path, "Parallel integration task");

    await waitForAutomaticTagComparison(gitSidebar);
    gitTreeRefreshTargets.length = 0;
    await gitSidebar.compareRemoteTags(repository.rootUri);
    assert.equal(
      gitTreeRefreshTargets.at(-1),
      undefined,
      "Tag comparison must refresh the visible tree root.",
    );
    const repositoryNode = (await gitSidebar.getChildren()).find(
      (sidebarNode) => sidebarNode.nodeType === "repository",
    );
    assert.ok(repositoryNode);
    const tagGroupNode = (await gitSidebar.getChildren(repositoryNode)).find(
      (sidebarNode) =>
        sidebarNode.nodeType === "referenceGroup" && sidebarNode.referenceType === "tag",
    );
    assert.ok(tagGroupNode);
    const comparedTagStates = (await gitSidebar.getChildren(tagGroupNode)).flatMap(
      (sidebarNode) =>
        sidebarNode.nodeType === "tagReference"
          ? [[sidebarNode.availability.name, sidebarNode.availability.syncStatus] as const]
          : [],
    );
    assert.deepEqual(comparedTagStates, [
      ["local-only", "localOnly"],
      ["v1.0.0", "synced"],
      ["v1.1.0", "remoteOnly"],
    ]);
    const worktreeGroupNode = (await gitSidebar.getChildren(repositoryNode)).find(
      (sidebarNode) => sidebarNode.nodeType === "worktreeGroup",
    );
    assert.ok(worktreeGroupNode);
    const createdWorktreeNode = (await gitSidebar.getChildren(worktreeGroupNode)).find(
      (sidebarNode) =>
        sidebarNode.nodeType === "worktree" && sidebarNode.worktree.path === expectedWorktreePath,
    );
    assert.ok(createdWorktreeNode);
    const createdWorktreeTreeItem = gitSidebar.getTreeItem(createdWorktreeNode);
    assert.equal(createdWorktreeTreeItem.label, "Parallel integration task");
    assert.equal(createdWorktreeTreeItem.contextValue, "gito.worktree.available");
    assert.equal(createdWorktreeTreeItem.command?.command, "gito.openWorktreeInNewWindow");
    const linkedWorktreeChangeUri = vscode.Uri.file(
      `${createdWorktree.path}/linked-worktree-change.txt`,
    );
    await vscode.workspace.fs.writeFile(
      linkedWorktreeChangeUri,
      new TextEncoder().encode("parallel work\n"),
    );
    const linkedWorktreeWip = await loadWorktreeWipSummary({
      environment: gitApi.git.env,
      executablePath: gitApi.git.path,
      repositoryPath: createdWorktree.path,
    });
    assert.equal(linkedWorktreeWip.untrackedCount, 1);
    const refreshedWorktreeNode = (await gitSidebar.getChildren(worktreeGroupNode)).find(
      (sidebarNode) =>
        sidebarNode.nodeType === "worktree" &&
        sidebarNode.worktree.path === expectedWorktreePath,
    );
    assert.ok(refreshedWorktreeNode);
    const refreshedWorktreeTreeItem = gitSidebar.getTreeItem(refreshedWorktreeNode);
    assert.match(String(refreshedWorktreeTreeItem.description), /1 untracked/u);
    assert.equal(
      (refreshedWorktreeTreeItem.iconPath as vscode.ThemeIcon).color?.id,
      "charts.yellow",
    );

    await vscode.workspace.fs.writeFile(
      integrationChangeUri,
      new TextEncoder().encode("integration change\n"),
    );
    integrationChangeCreated = true;
    await repository.status();
    await waitForRepositoryState(
      () =>
        [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges].some((change) =>
          pathsIdentifySameLocation(change.uri.fsPath, integrationChangeUri.fsPath),
        ),
      "VS Code Git did not report the untracked integration change.",
    );
    await waitForCommitState(
      postedCommitMessages,
      (commitState) => commitStateContainsChange(commitState, "unstaged", integrationChangeUri.fsPath),
    );
    commitMessageEmitter.fire({
      action: "stage",
      filePath: integrationChangeUri.fsPath,
      groupKind: "unstaged",
      repositoryPath: repository.rootUri.fsPath,
      type: "changeAction",
    });
    const stageStatus = await waitForCommitActionStatus(postedCommitMessages);
    assert.equal(stageStatus.message, undefined);
    await waitForRepositoryState(
      () =>
        repository.state.indexChanges.some((change) =>
          pathsIdentifySameLocation(change.uri.fsPath, integrationChangeUri.fsPath),
        ),
      "VS Code Git did not stage the requested integration change.",
    );
    await waitForCommitState(
      postedCommitMessages,
      (commitState) => commitStateContainsChange(commitState, "staged", integrationChangeUri.fsPath),
    );
    commitMessageEmitter.fire({
      action: "unstage",
      filePath: integrationChangeUri.fsPath,
      groupKind: "staged",
      repositoryPath: repository.rootUri.fsPath,
      type: "changeAction",
    });
    const unstageStatus = await waitForCommitActionStatus(postedCommitMessages, stageStatus);
    assert.equal(unstageStatus.message, undefined);
    await waitForRepositoryState(
      () =>
        [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges].some((change) =>
          pathsIdentifySameLocation(change.uri.fsPath, integrationChangeUri.fsPath),
        ),
      "VS Code Git did not unstage the requested integration change.",
    );

    graphView.resolveWebviewView(testWebviewView);
    messageEmitter.fire({ type: "ready" });
    const deliveredGraphState = await waitForGraphState(postedGraphMessages);
    assert.equal(
      deliveredGraphState.repositoryName,
      undefined,
      "The graph must not repeat repository context already shown by Git'o.",
    );
    assert.deepEqual(
      deliveredGraphState.rows?.slice(0, 2).map((graphRow) => graphRow.subject),
      ["test: second history entry", "test: first history entry"],
    );
    const selectedCommitHash = deliveredGraphState.rows?.[1]?.hash;
    assert.ok(selectedCommitHash);
    messageEmitter.fire({
      commitHash: selectedCommitHash,
      repositoryPath: repository.rootUri.fsPath,
      type: "selectCommit",
    });
    const commitActionsMessage = await waitForGraphMessage(
      postedGraphMessages,
      (graphMessage) =>
        graphMessage.type === "commitActions" && graphMessage.commitHash === selectedCommitHash,
    );
    assert.equal(
      commitActionsMessage.actions?.find(({ id }) => id === "compareWithHead")?.disabledReason,
      undefined,
    );
    messageEmitter.fire({
      repositoryPath: repository.rootUri.fsPath,
      type: "previewSync",
    });
    const syncPreviewMessage = await waitForGraphMessage(
      postedGraphMessages,
      (graphMessage) => graphMessage.type === "syncPreview",
    );
    assert.deepEqual(syncPreviewMessage.syncPreview, {
      conflictRisk: "none",
      incomingChangedPaths: [],
      incomingCommitCount: 0,
      outgoingChangedPaths: [],
      outgoingCommitCount: 0,
      upstreamName: "origin/main",
      workingTreeClean: false,
    });
    const worktreeMessage = await waitForGraphMessage(
      postedGraphMessages,
      (graphMessage) => graphMessage.type === "worktrees",
    );
    assert.equal(
      worktreeMessage.worktrees?.some(
        (worktreeState) =>
          worktreeState.displayName === "Parallel integration task" &&
          worktreeState.summary === "1 untracked",
      ),
      true,
    );
    messageEmitter.fire({ searchText: "message:first", type: "search" });
    messageEmitter.fire({ searchText: "message:second", type: "search" });
    const latestSearchState = await waitForGraphState(
      postedGraphMessages,
      (graphState) => graphState.searchText === "message:second",
    );
    assert.deepEqual(
      latestSearchState.rows?.map((graphRow) => graphRow.subject),
      ["test: second history entry"],
      "A stale graph search must not replace the latest query.",
    );
    await graphView.showFileHistory(vscode.Uri.joinPath(repository.rootUri, "history.txt"));
    const visualFileHistoryState = await waitForGraphState(
      postedGraphMessages,
      (graphState) => graphState.fileHistoryPath === "history.txt",
    );
    assert.deepEqual(
      visualFileHistoryState.rows?.map((graphRow) => graphRow.subject),
      ["test: second history entry", "test: first history entry"],
    );

    await repository.createBranch("test/conflict-source", true);
    await vscode.workspace.fs.writeFile(
      mergeConflictUri,
      new TextEncoder().encode("source branch\n"),
    );
    await repository.add([mergeConflictUri.fsPath]);
    await repository.commit("test: create source conflict");
    await repository.checkout("main");
    await vscode.workspace.fs.writeFile(
      mergeConflictUri,
      new TextEncoder().encode("target branch\n"),
    );
    await repository.add([mergeConflictUri.fsPath]);
    await repository.commit("test: create target conflict");
    await assert.rejects(repository.merge("test/conflict-source"));
    mergeConflictStarted = true;
    await waitForRepositoryState(
      () => repository.state.mergeChanges.length === 1,
      "VS Code Git did not report the merge conflict.",
    );
    const conflictGroupNode = workingTreeChanges
      .getGroups()
      .find((changeGroup) => changeGroup.groupKind === "conflicts");
    assert.ok(conflictGroupNode);
    await waitForCommitState(
      postedCommitMessages,
      (commitState) => commitStateContainsChange(commitState, "conflicts", mergeConflictUri.fsPath),
    );
    const [mergeConflictNode] = workingTreeChanges.getChanges(conflictGroupNode);
    if (mergeConflictNode === undefined) {
      throw new Error("Git'o did not expose the merge conflict file.");
    }
    assert.equal(mergeConflictNode.changePosition, 1);
    assert.equal(mergeConflictNode.changeCount, 1);
    const mergeConflictPresentation = createConflictGuidePresentation(
      await inspectConflictContext(repository),
    );
    assert.equal(
      mergeConflictPresentation.operationTitle,
      "Merging test/conflict-source into main",
    );
    assert.equal(
      mergeConflictPresentation.firstInputLabel,
      "Left · Changes from: test/conflict-source",
    );
    assert.equal(mergeConflictPresentation.secondInputLabel, "Right · Target branch: main");
    await repository.mergeAbort();
    mergeConflictStarted = false;
    await waitForRepositoryState(
      () => repository.state.mergeChanges.length === 0,
      "VS Code Git did not clear the aborted merge conflict.",
    );
  } finally {
    try {
      if (mergeConflictStarted) {
        await repository.mergeAbort();
      }
      if (integrationChangeCreated) {
        await vscode.workspace.fs.delete(integrationChangeUri, { useTrash: false });
      }
      if (createdWorktreePath !== undefined) {
        await repository.deleteWorktree(createdWorktreePath, {
          force: true,
          label: "Integration Worktree",
        });
      }
    } finally {
      gitSidebar.dispose();
      commitView.dispose();
      gitTreeRefreshSubscription.dispose();
      graphView.dispose();
      worktrees.dispose();
      workspaceRepositories.dispose();
      diagnostics.dispose();
      messageEmitter.dispose();
      disposalEmitter.dispose();
      visibilityEmitter.dispose();
      commitMessageEmitter.dispose();
      commitDisposalEmitter.dispose();
    }
  }
}

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }
}

async function waitForRepository(
  gitApi: Awaited<ReturnType<typeof loadBuiltInGitApi>>,
  repositoryPath: string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const repository = gitApi.repositories.find(
      (candidateRepository) => candidateRepository.rootUri.fsPath === repositoryPath,
    );
    if (repository !== undefined) {
      return repository;
    }
    await delay(100);
  }
  throw new Error(`VS Code Git did not open ${repositoryPath}.`);
}

async function waitForGraphState(
  postedGraphMessages: readonly PostedGraphMessage[],
  graphStateMatches: (graphState: PostedGraphMessage) => boolean = () => true,
): Promise<PostedGraphMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const graphState = postedGraphMessages.findLast(
      (postedGraphMessage) =>
        postedGraphMessage.type === "state" && graphStateMatches(postedGraphMessage),
    );
    if (graphState !== undefined) {
      return graphState;
    }
    await delay(25);
  }
  throw new Error("Graph webview did not receive history within 15 seconds.");
}

async function waitForGraphMessage(
  postedGraphMessages: readonly PostedGraphMessage[],
  graphMessageMatches: (graphMessage: PostedGraphMessage) => boolean,
): Promise<PostedGraphMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const graphMessage = postedGraphMessages.findLast(graphMessageMatches);
    if (graphMessage !== undefined) return graphMessage;
    await delay(25);
  }
  throw new Error("Graph webview did not receive the expected interaction within 15 seconds.");
}

async function waitForCommitState(
  postedCommitMessages: readonly PostedCommitMessage[],
  commitStateMatches: (commitState: PostedCommitMessage) => boolean,
): Promise<PostedCommitMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const commitState = postedCommitMessages.findLast(
      (postedCommitMessage) =>
        postedCommitMessage.type === "state" && commitStateMatches(postedCommitMessage),
    );
    if (commitState !== undefined) return commitState;
    await delay(25);
  }
  throw new Error("Combined Changes webview did not receive working tree state within 15 seconds.");
}

async function waitForCommitActionStatus(
  postedCommitMessages: readonly PostedCommitMessage[],
  previousStatus?: PostedCommitMessage,
): Promise<PostedCommitMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const commitActionStatus = postedCommitMessages.findLast(
      (postedCommitMessage) =>
        postedCommitMessage.type === "changeStatus" &&
        postedCommitMessage.completed === true &&
        postedCommitMessage !== previousStatus,
    );
    if (commitActionStatus !== undefined) return commitActionStatus;
    await delay(25);
  }
  throw new Error("Combined Changes webview action did not complete within 15 seconds.");
}

function commitStateContainsChange(
  commitState: PostedCommitMessage,
  groupKind: string,
  expectedFilePath: string,
): boolean {
  return commitState.changeGroups?.some(
    (changeGroup) =>
      changeGroup.groupKind === groupKind &&
      changeGroup.changes.some((change) =>
        pathsIdentifySameLocation(change.filePath, expectedFilePath),
      ),
  ) ?? false;
}

async function waitForRepositoryState(
  repositoryStateMatches: () => boolean,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (repositoryStateMatches()) {
      return;
    }
    await delay(100);
  }
  throw new Error(timeoutMessage);
}

async function waitForAutomaticTagComparison(gitSidebar: GitSidebar): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const repositoryNode = (await gitSidebar.getChildren()).find(
      (sidebarNode) => sidebarNode.nodeType === "repository",
    );
    if (repositoryNode !== undefined) {
      const tagGroupNode = (await gitSidebar.getChildren(repositoryNode)).find(
        (sidebarNode) =>
          sidebarNode.nodeType === "referenceGroup" && sidebarNode.referenceType === "tag",
      );
      if (
        tagGroupNode !== undefined &&
        gitSidebar.getTreeItem(tagGroupNode).description === "origin checked"
      ) {
        return;
      }
    }
    await delay(100);
  }
  throw new Error("Git'o did not compare tags with the default remote automatically.");
}

function delay(delayMilliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMilliseconds));
}
