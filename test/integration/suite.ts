import assert from "node:assert/strict";

import * as vscode from "vscode";

import { ChangesSidebar } from "../../src/changesSidebar.ts";
import { inspectConflictContext } from "../../src/conflictGuide.ts";
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
  readonly fileHistoryPath?: string;
  readonly rows?: readonly { readonly subject: string }[];
  readonly searchText?: string;
  readonly type?: string;
}

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Integration workspace did not open.");

  const gitApi = await loadBuiltInGitApi();
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
  const changesSidebar = new ChangesSidebar(workspaceRepositories);
  const gitTreeRefreshTargets: unknown[] = [];
  const gitTreeRefreshSubscription = gitSidebar.onDidChangeTreeData((refreshTarget) => {
    gitTreeRefreshTargets.push(refreshTarget);
  });
  const graphView = new GraphView(gitApi, workspaceRepositories, diagnostics);
  const messageEmitter = new vscode.EventEmitter<unknown>();
  const disposalEmitter = new vscode.EventEmitter<void>();
  const visibilityEmitter = new vscode.EventEmitter<void>();
  const postedGraphMessages: PostedGraphMessage[] = [];
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
    const unstagedGroup = changesSidebar
      .getChildren()
      .find(
        (sidebarNode) => sidebarNode.nodeType === "group" && sidebarNode.groupKind === "unstaged",
      );
    assert.ok(unstagedGroup);
    const untrackedChangeNode = changesSidebar
      .getChildren(unstagedGroup)
      .find(
        (sidebarNode) =>
          sidebarNode.nodeType === "change" &&
          pathsIdentifySameLocation(sidebarNode.change.uri.fsPath, integrationChangeUri.fsPath),
      );
    assert.ok(untrackedChangeNode);
    await changesSidebar.runChangeAction("stage", untrackedChangeNode);
    await waitForRepositoryState(
      () =>
        repository.state.indexChanges.some((change) =>
          pathsIdentifySameLocation(change.uri.fsPath, integrationChangeUri.fsPath),
        ),
      "VS Code Git did not stage the requested integration change.",
    );
    const stagedGroup = changesSidebar
      .getChildren()
      .find(
        (sidebarNode) => sidebarNode.nodeType === "group" && sidebarNode.groupKind === "staged",
      );
    assert.ok(stagedGroup);
    const stagedChangeNode = changesSidebar
      .getChildren(stagedGroup)
      .find(
        (sidebarNode) =>
          sidebarNode.nodeType === "change" &&
          pathsIdentifySameLocation(sidebarNode.change.uri.fsPath, integrationChangeUri.fsPath),
      );
    assert.ok(stagedChangeNode);
    await changesSidebar.runChangeAction("unstage", stagedChangeNode);
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
    assert.deepEqual(
      deliveredGraphState.rows?.slice(0, 2).map((graphRow) => graphRow.subject),
      ["test: second history entry", "test: first history entry"],
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
    const conflictGroupNode = changesSidebar
      .getChildren()
      .find(
        (sidebarNode) => sidebarNode.nodeType === "group" && sidebarNode.groupKind === "conflicts",
      );
    assert.ok(conflictGroupNode);
    assert.equal(changesSidebar.getTreeItem(conflictGroupNode).label, "Resolve Conflicts");
    const [mergeConflictNode] = changesSidebar.getChildren(conflictGroupNode);
    assert.equal(mergeConflictNode?.nodeType, "change");
    if (mergeConflictNode?.nodeType !== "change") {
      throw new Error("Git'o did not expose the merge conflict file.");
    }
    assert.equal(mergeConflictNode.changePosition, 1);
    assert.equal(mergeConflictNode.changeCount, 1);
    assert.equal(
      changesSidebar.getTreeItem(mergeConflictNode).command?.command,
      "gito.resolveConflict",
    );
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
      changesSidebar.dispose();
      gitTreeRefreshSubscription.dispose();
      graphView.dispose();
      worktrees.dispose();
      workspaceRepositories.dispose();
      diagnostics.dispose();
      messageEmitter.dispose();
      disposalEmitter.dispose();
      visibilityEmitter.dispose();
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

function delay(delayMilliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMilliseconds));
}
