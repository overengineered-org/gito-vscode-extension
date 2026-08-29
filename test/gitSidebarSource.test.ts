import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitSidebarSource = readFileSync(
  new URL("../src/gitSidebar.ts", import.meta.url),
  "utf8",
);

test("uses a native tree icon instead of inline codicon markup", () => {
  assert.doesNotMatch(gitSidebarSource, /\$\(\$\{currentReferenceIconId\}\)/u);
  assert.match(
    gitSidebarSource,
    /new vscode\.ThemeIcon\(\s*currentReferenceIconId,/u,
  );
});

test("refreshes the visible tree after comparing tags", () => {
  const compareRemoteTagsSource = gitSidebarSource.slice(
    gitSidebarSource.indexOf("public async compareRemoteTags"),
    gitSidebarSource.indexOf("public async switchReference"),
  );
  assert.match(
    compareRemoteTagsSource,
    /remoteTagSnapshots\.set[\s\S]*treeChangedEmitter\.fire\(undefined\)/u,
  );
  assert.doesNotMatch(compareRemoteTagsSource, /treeChangedEmitter\.fire\(\{/u);
});

test("loads source-branch lag outside the tree child request", () => {
  assert.doesNotMatch(gitSidebarSource, /Promise\.all\(\[\s*repository\.getRefs/u);
  assert.match(gitSidebarSource, /void this\.refreshBranchLagSnapshot|refreshBranchLagSnapshot\(/u);
});

test("never refreshes reconstructed tree nodes by object identity", () => {
  assert.doesNotMatch(gitSidebarSource, /treeChangedEmitter\.fire\(\{/u);
});

test("invalidates source-branch lag when repository state changes", () => {
  assert.match(gitSidebarSource, /workspaceStateVersion \+= 1/u);
  assert.match(gitSidebarSource, /createRepositoryStateKey\([\s\S]*workspaceStateVersion/u);
});
