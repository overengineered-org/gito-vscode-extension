import assert from "node:assert/strict";
import test from "node:test";

import { createBranchPresentation } from "../src/branchPresentation.ts";
import {
  type BranchAvailability,
  type CurrentBranchSyncStatus,
  GitReferenceType,
} from "../src/gitModel.ts";

test("presents local-only and remote-only branches without relying on colour alone", () => {
  assert.deepEqual(
    createBranchPresentation(createBranchAvailability("local", false)),
    {
      colorId: "charts.yellow",
      description: "Local only",
      iconId: "device-desktop",
      tooltip: "This branch exists locally but not on any known remote, based on fetched refs.",
    },
  );
  assert.deepEqual(
    createBranchPresentation(createBranchAvailability("remoteTracking", false)),
    {
      colorId: "charts.blue",
      description: "Remote only",
      iconId: "cloud",
      tooltip: "This branch exists on the remote but not locally, based on fetched refs.",
    },
  );
});

test("presents every current branch upstream state", () => {
  const expectedPresentations: Readonly<
    Record<CurrentBranchSyncStatus, readonly [string, string, string | undefined]>
  > = {
    ahead: ["Current · 2 commits ahead", "arrow-up", "charts.purple"],
    behind: ["Current · 3 commits behind", "arrow-down", "charts.yellow"],
    diverged: ["Current · 2 ahead · 3 behind", "warning", "charts.red"],
    notTracking: ["Current · No upstream", "circle-large-outline", "charts.yellow"],
    synced: ["Current · Synced", "pass-filled", "charts.green"],
    unknown: ["Current · Status unknown", "question", undefined],
  };

  for (const [currentSyncStatus, expectedPresentation] of Object.entries(
    expectedPresentations,
  ) as [CurrentBranchSyncStatus, readonly [string, string, string | undefined]][]) {
    const branchPresentation = createBranchPresentation({
      ...createBranchAvailability("local", true),
      currentSyncStatus,
      isCurrent: true,
      reference: {
        ahead: 2,
        behind: 3,
        name: "main",
        type: GitReferenceType.localBranch,
        upstream: { name: "main", remote: "origin" },
      },
    });
    assert.equal(branchPresentation.description, expectedPresentation[0]);
    assert.equal(branchPresentation.iconId, expectedPresentation[1]);
    assert.equal(branchPresentation.colorId, expectedPresentation[2]);
  }
});

function createBranchAvailability(
  location: BranchAvailability["location"],
  counterpartAvailable: boolean,
): BranchAvailability {
  return {
    availableLocally: location === "local" || counterpartAvailable,
    availableRemotely: location === "remoteTracking" || counterpartAvailable,
    isCurrent: false,
    location,
    reference: {
      name: location === "local" ? "feature/local" : "origin/feature/remote",
      type:
        location === "local"
          ? GitReferenceType.localBranch
          : GitReferenceType.remoteBranch,
    },
  };
}
