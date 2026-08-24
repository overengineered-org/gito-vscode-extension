import { describe, expect, it } from "vitest";
import { getCommandEligibleChanges } from "../../../src/extension/commands/gitChangeSelection.js";
import type {
  LocalGitChange,
  LocalGitChangesSnapshot,
} from "../../../src/extension/git/localGitModels.js";

function createChange(
  relativePath: string,
  group: LocalGitChange["group"],
): LocalGitChange {
  return {
    relativePath,
    group,
    statusLabel: "Changed",
    resourceUri: { toString: () => `file:///repo/${relativePath}` } as never,
  };
}

const changesSnapshot: LocalGitChangesSnapshot = {
  repositoryRoot: { toString: () => "file:///repo" } as never,
  mergeChanges: [createChange("conflict.ts", "mergeChanges")],
  stagedChanges: [createChange("staged.ts", "stagedChanges")],
  changes: [createChange("modified.ts", "changes")],
  untracked: [createChange("new.ts", "untracked")],
  totalChangeCount: 4,
};

describe("local Git command selection", () => {
  it("limits stage and discard prompts to unstaged groups", () => {
    expect(
      getCommandEligibleChanges(changesSnapshot, "stage").map(
        (change) => change.relativePath,
      ),
    ).toEqual(["conflict.ts", "modified.ts", "new.ts"]);
    expect(
      getCommandEligibleChanges(changesSnapshot, "discard").map(
        (change) => change.relativePath,
      ),
    ).toEqual(["modified.ts", "new.ts"]);
  });

  it("limits unstage prompts to staged changes and never falls back to all state", () => {
    expect(
      getCommandEligibleChanges(changesSnapshot, "unstage").map(
        (change) => change.relativePath,
      ),
    ).toEqual(["staged.ts"]);
    expect(
      getCommandEligibleChanges(
        { ...changesSnapshot, stagedChanges: [] },
        "unstage",
      ),
    ).toEqual([]);
  });

  it("never stages or discards ignored changes", () => {
    const ignoredChange = {
      ...createChange(".env", "untracked"),
      status: 8,
    };
    const snapshotWithIgnoredChange = {
      ...changesSnapshot,
      untracked: [...changesSnapshot.untracked, ignoredChange],
    };
    expect(
      getCommandEligibleChanges(snapshotWithIgnoredChange, "stage").some(
        (change) => change.relativePath === ".env",
      ),
    ).toBe(false);
    expect(
      getCommandEligibleChanges(snapshotWithIgnoredChange, "discard").some(
        (change) => change.relativePath === ".env",
      ),
    ).toBe(false);
  });
});
