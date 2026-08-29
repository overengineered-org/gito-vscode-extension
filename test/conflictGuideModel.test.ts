import assert from "node:assert/strict";
import test from "node:test";

import {
  containsUnresolvedConflictMarkers,
  createConflictGuidePresentation,
} from "../src/conflictGuideModel.ts";

const featureCommit = {
  hash: "1234567890abcdef",
  message: "feat: improve sign in\n\nCommit body",
  parents: ["parent"],
};

test("names merge roles with real branches instead of current and incoming", () => {
  assert.deepEqual(
    createConflictGuidePresentation({
      currentBranchName: "main",
      operationCommit: featureCommit,
      operationKind: "merge",
      sourceReferenceName: "feat/sign-in",
    }),
    {
      abortActionLabel: "Abort Merge",
      firstInputLabel: "Left · Changes from: feat/sign-in",
      operationTitle: "Merging feat/sign-in into main",
      resultLabel: "Result · Resolved file",
      secondInputLabel: "Right · Target branch: main",
    },
  );
});

test("explains rebase roles without Git's reversed ours and theirs language", () => {
  assert.deepEqual(
    createConflictGuidePresentation({
      baseReferenceName: "origin/main",
      operationCommit: featureCommit,
      operationKind: "rebase",
      sourceReferenceName: "feat/sign-in",
    }),
    {
      abortActionLabel: "Abort Rebase",
      firstInputLabel: "Left · New base: origin/main",
      operationTitle: "Rebasing feat/sign-in onto origin/main",
      resultLabel: "Result · Resolved file",
      secondInputLabel: "Right · Your commit: 1234567 · feat: improve sign in",
    },
  );
});

test("identifies a cherry-picked commit and the target branch", () => {
  assert.deepEqual(
    createConflictGuidePresentation({
      currentBranchName: "release/2.0",
      operationCommit: featureCommit,
      operationKind: "cherryPick",
    }),
    {
      firstInputLabel: "Left · Chosen commit: 1234567 · feat: improve sign in",
      operationTitle: "Applying 1234567 · feat: improve sign in to release/2.0",
      resultLabel: "Result · Resolved file",
      secondInputLabel: "Right · Target branch: release/2.0",
    },
  );
});

test("uses honest neutral labels when Git cannot identify the operation", () => {
  assert.deepEqual(createConflictGuidePresentation({ operationKind: "unknown" }), {
    firstInputLabel: "Left · Other changes",
    operationTitle: "Resolving repository conflict",
    resultLabel: "Result · Resolved file",
    secondInputLabel: "Right · Your working copy",
  });
});

test("blocks resolved staging only when a complete conflict marker remains", () => {
  assert.equal(
    containsUnresolvedConflictMarkers(
      "before\n<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feat/sign-in\nafter\n",
    ),
    true,
  );
  assert.equal(containsUnresolvedConflictMarkers("const comparison = '<<<<<<<';\n"), false);
  assert.equal(containsUnresolvedConflictMarkers("fully resolved contents\n"), false);
});
