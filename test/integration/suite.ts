import assert from "node:assert/strict";

import * as vscode from "vscode";

import { loadBuiltInGitApi } from "../../src/gitApi.ts";
import { GitSidebar } from "../../src/gitSidebar.ts";
import { loadCommitGraphPage } from "../../src/graphHistory.ts";
import { GitReferenceType } from "../../src/gitModel.ts";
import { GraphView } from "../../src/graphView.ts";
import { listRemoteTagReferences } from "../../src/remoteTags.ts";
import { WorkspaceRepositories } from "../../src/workspaceRepositories.ts";

interface PostedGraphMessage {
  readonly rows?: readonly { readonly subject: string }[];
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
  const gitSidebar = new GitSidebar(gitApi, workspaceRepositories, diagnostics);
  const gitTreeRefreshTargets: unknown[] = [];
  const gitTreeRefreshSubscription = gitSidebar.onDidChangeTreeData((refreshTarget) => {
    gitTreeRefreshTargets.push(refreshTarget);
  });
  const graphView = new GraphView(workspaceRepositories, diagnostics);
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

  try {
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

    graphView.resolveWebviewView(testWebviewView);
    messageEmitter.fire({ type: "ready" });
    const deliveredGraphState = await waitForGraphState(postedGraphMessages);
    assert.deepEqual(
      deliveredGraphState.rows?.slice(0, 2).map((graphRow) => graphRow.subject),
      ["test: second history entry", "test: first history entry"],
    );
  } finally {
    gitSidebar.dispose();
    gitTreeRefreshSubscription.dispose();
    graphView.dispose();
    workspaceRepositories.dispose();
    diagnostics.dispose();
    messageEmitter.dispose();
    disposalEmitter.dispose();
    visibilityEmitter.dispose();
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
): Promise<PostedGraphMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const graphState = postedGraphMessages.find(
      (postedGraphMessage) => postedGraphMessage.type === "state",
    );
    if (graphState !== undefined) {
      return graphState;
    }
    await delay(25);
  }
  throw new Error("Graph webview did not receive history within 15 seconds.");
}

function delay(delayMilliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMilliseconds));
}
