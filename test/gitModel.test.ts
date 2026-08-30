import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildBranchInventory,
  countRepositoryChanges,
  determineCurrentBranchSyncStatus,
  GitReferenceType,
  isRepositoryInWorkspaceContext,
  listBranchLagNotices,
  listPrunableLocalBranches,
  listSwitchableReferences,
  listTagAvailability,
  type RepositoryChangeCollections,
} from "../src/gitModel.ts";

test("separates complete local and remote-tracking branch inventories", () => {
  assert.deepEqual(
    buildBranchInventory([
      { name: "main", type: GitReferenceType.localBranch },
      { name: "feature/zebra", type: GitReferenceType.localBranch },
      { name: "origin/main", type: GitReferenceType.remoteBranch },
      { name: "origin/release", type: GitReferenceType.remoteBranch },
      { name: "origin/HEAD", type: GitReferenceType.remoteBranch },
      { name: "v1.0.0", type: GitReferenceType.tag },
    ]),
    {
      localBranches: [
        {
          availableLocally: true,
          availableRemotely: false,
          isCurrent: false,
          location: "local",
          reference: { name: "feature/zebra", type: GitReferenceType.localBranch },
        },
        {
          availableLocally: true,
          availableRemotely: true,
          isCurrent: false,
          location: "local",
          reference: { name: "main", type: GitReferenceType.localBranch },
        },
      ],
      remoteTrackingBranches: [
        {
          availableLocally: true,
          availableRemotely: true,
          isCurrent: false,
          location: "remoteTracking",
          reference: { name: "origin/main", type: GitReferenceType.remoteBranch },
        },
        {
          availableLocally: false,
          availableRemotely: true,
          isCurrent: false,
          location: "remoteTracking",
          reference: { name: "origin/release", type: GitReferenceType.remoteBranch },
        },
      ],
    },
  );
});

test("classifies current branch upstream states", () => {
  const trackedBranch = {
    name: "main",
    type: GitReferenceType.localBranch,
    upstream: { name: "main", remote: "origin" },
  };

  assert.equal(determineCurrentBranchSyncStatus({ ...trackedBranch, ahead: 0, behind: 0 }), "synced");
  assert.equal(determineCurrentBranchSyncStatus({ ...trackedBranch, ahead: 2, behind: 0 }), "ahead");
  assert.equal(determineCurrentBranchSyncStatus({ ...trackedBranch, ahead: 0, behind: 3 }), "behind");
  assert.equal(determineCurrentBranchSyncStatus({ ...trackedBranch, ahead: 2, behind: 3 }), "diverged");
  assert.equal(determineCurrentBranchSyncStatus(trackedBranch), "unknown");
  assert.equal(
    determineCurrentBranchSyncStatus({ name: "local", type: GitReferenceType.localBranch }),
    "notTracking",
  );
});

test("finds local branches missing from every remote without offering the current branch", () => {
  assert.deepEqual(
    listPrunableLocalBranches(
      [
        { name: "feature/current", type: GitReferenceType.localBranch },
        { name: "main", type: GitReferenceType.localBranch },
        { name: "nested/release", type: GitReferenceType.localBranch },
        { name: "old/local-only", type: GitReferenceType.localBranch },
        { name: "origin/HEAD", remote: "origin", type: GitReferenceType.remoteBranch },
        { name: "origin/main", remote: "origin", type: GitReferenceType.remoteBranch },
        {
          name: "upstream/nested/release",
          remote: "upstream",
          type: GitReferenceType.remoteBranch,
        },
      ],
      "feature/current",
    ),
    [{ name: "old/local-only", type: GitReferenceType.localBranch }],
  );
});

test("matches differently named local branches through their configured upstream", () => {
  const trackedLocalBranch = {
    name: "deploy",
    type: GitReferenceType.localBranch,
    upstream: { name: "release/deploy", remote: "origin" },
  };
  const trackedRemoteBranch = {
    name: "origin/release/deploy",
    remote: "origin",
    type: GitReferenceType.remoteBranch,
  };

  const branchInventory = buildBranchInventory([trackedLocalBranch, trackedRemoteBranch]);
  assert.equal(branchInventory.localBranches[0]?.availableRemotely, true);
  assert.equal(branchInventory.remoteTrackingBranches[0]?.availableLocally, true);
  assert.deepEqual(
    listPrunableLocalBranches([trackedLocalBranch, trackedRemoteBranch], undefined),
    [],
  );
});

test("separates switchable branches and tags", () => {
  const gitReferences = [
    { name: "main", type: GitReferenceType.localBranch },
    { name: "origin/main", type: GitReferenceType.remoteBranch },
    { name: "origin/HEAD", type: GitReferenceType.remoteBranch },
    { name: "v1.0.0", type: GitReferenceType.tag },
  ];

  assert.deepEqual(listSwitchableReferences(gitReferences, "branch"), [
    { name: "main", type: GitReferenceType.localBranch },
    { name: "origin/main", type: GitReferenceType.remoteBranch },
  ]);
  assert.deepEqual(listSwitchableReferences(gitReferences, "tag"), [
    { name: "v1.0.0", type: GitReferenceType.tag },
  ]);
});

test("reports upstream and source lag without duplicating the same reference", () => {
  const currentBranch = {
    behind: 2,
    name: "feature/work",
    type: GitReferenceType.localBranch,
    upstream: { name: "feature/work", remote: "origin" },
  };

  assert.deepEqual(
    listBranchLagNotices(currentBranch, {
      behindCommitCount: 4,
      referenceName: "origin/main",
    }),
    [
      {
        behindCommitCount: 2,
        comparisonKind: "upstream",
        referenceName: "origin/feature/work",
      },
      {
        behindCommitCount: 4,
        comparisonKind: "source",
        referenceName: "origin/main",
      },
    ],
  );
  assert.deepEqual(
    listBranchLagNotices(currentBranch, {
      behindCommitCount: 2,
      referenceName: "origin/feature/work",
    }),
    [
      {
        behindCommitCount: 2,
        comparisonKind: "upstream",
        referenceName: "origin/feature/work",
      },
    ],
  );
});

test("matches repositories to the opened workspace context", () => {
  const workspaceRootPath = resolve("workspace");
  const repositoryRootPath = join(workspaceRootPath, "repository");

  assert.equal(isRepositoryInWorkspaceContext(workspaceRootPath, [workspaceRootPath]), true);
  assert.equal(isRepositoryInWorkspaceContext(repositoryRootPath, [workspaceRootPath]), true);
  assert.equal(
    isRepositoryInWorkspaceContext(repositoryRootPath, [join(repositoryRootPath, "packages", "app")]),
    true,
  );
  assert.equal(
    isRepositoryInWorkspaceContext(resolve("unrelated-repository"), [workspaceRootPath]),
    false,
  );
});

test("classifies synced, local-only, remote-only, and conflicting tags", () => {
  const localTagReferences = [
    { commit: "aaaaaaaa", name: "v-conflict", type: GitReferenceType.tag },
    { commit: "bbbbbbbb", name: "v-local", type: GitReferenceType.tag },
    { commit: "cccccccc", name: "v-synced", type: GitReferenceType.tag },
  ];
  const remoteTagReferences = [
    { commit: "dddddddd", name: "v-conflict", type: GitReferenceType.tag },
    { commit: "eeeeeeee", name: "v-remote", type: GitReferenceType.tag },
    { commit: "cccccccc", name: "v-synced", type: GitReferenceType.tag },
  ];

  assert.deepEqual(listTagAvailability(localTagReferences, remoteTagReferences), [
    {
      availableLocally: true,
      localCommit: "aaaaaaaa",
      name: "v-conflict",
      remoteCommit: "dddddddd",
      syncStatus: "conflict",
    },
    {
      availableLocally: true,
      localCommit: "bbbbbbbb",
      name: "v-local",
      syncStatus: "localOnly",
    },
    {
      availableLocally: false,
      name: "v-remote",
      remoteCommit: "eeeeeeee",
      syncStatus: "remoteOnly",
    },
    {
      availableLocally: true,
      localCommit: "cccccccc",
      name: "v-synced",
      remoteCommit: "cccccccc",
      syncStatus: "synced",
    },
  ]);
  assert.equal(listTagAvailability(localTagReferences)[0]?.syncStatus, "unchecked");
});

test("counts staged, conflicted, untracked, and working-tree changes", () => {
  const repositoryState = {
    indexChanges: [{ path: "staged.ts" }],
    mergeChanges: [{ path: "conflicted.ts" }],
    untrackedChanges: [{ path: "new.ts" }],
    workingTreeChanges: [{ path: "changed.ts" }, { path: "also-changed.ts" }],
  } satisfies RepositoryChangeCollections;

  assert.equal(countRepositoryChanges(repositoryState), 5);
});
