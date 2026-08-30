import assert from "node:assert/strict";
import test from "node:test";

import {
  listAvailableNativeGitActions,
  nativeGitActions,
} from "../src/gitActionMenu.ts";

test("keeps publish actions available without a commit message", () => {
  assert.deepEqual(
    listAvailableNativeGitActions({
      hasCommitMessage: false,
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUncommittedChanges: true,
    }).map((nativeGitAction) => nativeGitAction.command),
    [
      "git.push",
      "git.pushTo",
      "git.pushWithTags",
      "git.pushTags",
      "git.pushForce",
      "git.pushToForce",
    ],
  );
});

test("only offers commit actions valid for the current repository state", () => {
  assert.deepEqual(
    listAvailableNativeGitActions({
      hasCommitMessage: true,
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUncommittedChanges: false,
    }).map((nativeGitAction) => nativeGitAction.command),
    [
      "git.commitAmend",
      "git.push",
      "git.pushTo",
      "git.pushWithTags",
      "git.pushTags",
      "git.pushForce",
      "git.pushToForce",
    ],
  );

  assert.deepEqual(
    listAvailableNativeGitActions({
      hasCommitMessage: true,
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUncommittedChanges: true,
    }).map((nativeGitAction) => nativeGitAction.command),
    nativeGitActions.map((nativeGitAction) => nativeGitAction.command),
  );
});

test("groups force push actions under an explicit warning section", () => {
  const forcePushActions = nativeGitActions.filter(
    (nativeGitAction) => nativeGitAction.section === "Rewrite remote history",
  );

  assert.deepEqual(
    forcePushActions.map((nativeGitAction) => nativeGitAction.command),
    ["git.pushForce", "git.pushToForce"],
  );
  assert.ok(
    forcePushActions.every((nativeGitAction) =>
      nativeGitAction.description.includes("VS Code"),
    ),
  );
});
