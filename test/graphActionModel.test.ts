import assert from "node:assert/strict";
import test from "node:test";

import { createCommitGraphActionStates } from "../src/graphActionModel.ts";

test("keeps read-only graph actions available in a dirty worktree", () => {
  const actionStates = createCommitGraphActionStates({
    commitIsHead: false,
    gitOperationInProgress: false,
    workingTreeClean: false,
  });

  assert.equal(actionStates.find(({ id }) => id === "openCommit")?.disabledReason, undefined);
  assert.equal(actionStates.find(({ id }) => id === "compareWithHead")?.disabledReason, undefined);
  assert.equal(actionStates.find(({ id }) => id === "createBranch")?.disabledReason, undefined);
  assert.equal(
    actionStates.find(({ id }) => id === "cherryPick")?.disabledReason,
    "Commit, stash, or discard working changes first.",
  );
});

test("blocks history mutations during an unfinished Git operation", () => {
  const actionStates = createCommitGraphActionStates({
    commitIsHead: false,
    gitOperationInProgress: true,
    workingTreeClean: true,
  });

  for (const actionId of ["checkoutDetached", "cherryPick", "rebaseCurrentBranchOnto", "revertCommit"] as const) {
    assert.equal(
      actionStates.find(({ id }) => id === actionId)?.disabledReason,
      "Finish the current Git operation first.",
    );
  }
});

test("only offers HEAD-specific actions on the current commit", () => {
  const currentCommitActions = createCommitGraphActionStates({
    commitIsHead: true,
    gitOperationInProgress: false,
    workingTreeClean: true,
  });
  const historicalCommitActions = createCommitGraphActionStates({
    commitIsHead: false,
    gitOperationInProgress: false,
    workingTreeClean: true,
  });

  assert.equal(
    currentCommitActions.find(({ id }) => id === "compareWithHead")?.disabledReason,
    "Select a commit other than the current HEAD.",
  );
  assert.equal(currentCommitActions.find(({ id }) => id === "undoLastCommit")?.disabledReason, undefined);
  assert.equal(
    historicalCommitActions.find(({ id }) => id === "undoLastCommit")?.disabledReason,
    "Only the current HEAD commit can be undone.",
  );
});
