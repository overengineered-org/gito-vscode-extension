import { describe, expect, it } from "vitest";
import {
  buildDiscardConfirmationMessage,
  resolveDiscardChanges,
} from "../../../src/extension/git/discardChangeSafety.js";
import type {
  LocalGitChange,
  LocalGitChangesSnapshot,
} from "../../../src/extension/git/localGitModels.js";

function createChange(
  relativePath: string,
  group: LocalGitChange["group"],
  repositoryPath = "/repo",
): LocalGitChange {
  return {
    relativePath,
    group,
    statusLabel: "Changed",
    resourceUri: {
      toString: () => `file://${repositoryPath}/${relativePath}`,
    } as never,
  };
}

function createSnapshot(
  changes: readonly LocalGitChange[],
  untracked: readonly LocalGitChange[] = [],
  stagedChanges: readonly LocalGitChange[] = [],
): LocalGitChangesSnapshot {
  return {
    repositoryRoot: { toString: () => "file:///repo" } as never,
    mergeChanges: [],
    stagedChanges,
    changes,
    untracked,
    totalChangeCount: changes.length + untracked.length + stagedChanges.length,
  };
}

describe("discard change safety", () => {
  it("re-resolves current working and untracked changes and removes duplicates", () => {
    const currentModifiedChange = createChange("modified.ts", "changes");
    const currentUntrackedChange = createChange("new.ts", "untracked");
    const resolution = resolveDiscardChanges(
      createSnapshot([currentModifiedChange], [currentUntrackedChange]),
      [
        createChange("modified.ts", "changes"),
        createChange("modified.ts", "changes"),
        createChange("new.ts", "untracked"),
      ],
    );
    expect(resolution.eligibleChanges).toEqual([
      currentModifiedChange,
      currentUntrackedChange,
    ]);
    expect(resolution.rejectedChanges).toEqual([]);
    expect(buildDiscardConfirmationMessage(resolution.eligibleChanges)).toBe(
      "Discard these changes? This cannot be undone.\n\n• modified.ts\n• new.ts",
    );
  });

  it.each([
    ["staged selection", [createChange("staged.ts", "stagedChanges")]],
    ["stale selection", [createChange("deleted.ts", "changes")]],
    [
      "cross-repository selection",
      [createChange("modified.ts", "changes", "/other-repo")],
    ],
  ])("rejects %s", (_description, requestedChanges) => {
    const resolution = resolveDiscardChanges(
      createSnapshot([createChange("modified.ts", "changes")]),
      requestedChanges,
    );
    expect(resolution.eligibleChanges).toEqual([]);
    expect(resolution.rejectedChanges).toEqual(requestedChanges);
  });

  it("rejects a mixed valid and staged selection instead of partially cleaning", () => {
    const validChange = createChange("modified.ts", "changes");
    const stagedChange = createChange("staged.ts", "stagedChanges");
    const resolution = resolveDiscardChanges(
      createSnapshot([validChange], [], [stagedChange]),
      [validChange, stagedChange],
    );
    expect(resolution.eligibleChanges).toEqual([validChange]);
    expect(resolution.rejectedChanges).toEqual([stagedChange]);
  });

  it("never discards ignored tracked or untracked changes", () => {
    const ignoredTrackedChange = {
      ...createChange("ignored-tracked.txt", "changes"),
      status: 8,
    };
    const ignoredUntrackedChange = {
      ...createChange("ignored-untracked.txt", "untracked"),
      status: 8,
    };
    const resolution = resolveDiscardChanges(
      createSnapshot([ignoredTrackedChange], [ignoredUntrackedChange]),
      [ignoredTrackedChange, ignoredUntrackedChange],
    );
    expect(resolution.eligibleChanges).toEqual([]);
    expect(resolution.rejectedChanges).toEqual([
      ignoredTrackedChange,
      ignoredUntrackedChange,
    ]);
  });
});
