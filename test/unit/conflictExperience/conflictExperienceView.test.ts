import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  QuickPickItemKind: { Separator: -1, Default: 0 },
}));
import {
  buildConflictActionQuickPickItems,
  buildConflictFileQuickPickItems,
  buildResolutionActionQuickPickItems,
  buildConflictStory,
  groupConflictFiles,
  isSkipValid,
} from "../../../src/extension/conflictExperience/index.js";
import type {
  ConflictFileState,
  ConflictRepositorySnapshot,
} from "../../../src/extension/conflicts/index.js";

describe("conflict experience view", () => {
  it("names the operation, actual checked-out branch, source commit, and three Git sides", () => {
    const story = buildConflictStory(createSnapshot("merge", true));

    expect(story?.title).toBe("Merge conflict · main");
    expect(story?.summary).toContain("1 unresolved file");
    expect(story?.body).toContain("checked-out branch main");
    expect(story?.body).toContain(
      "Base: The shared version before the operation began.",
    );
    expect(story?.body).toContain(
      "Current (checked-out branch at operation start): main.",
    );
    expect(story?.body).toContain(
      "Incoming (branch/commit being applied): The branch or commit being merged into the checked-out branch. (abcdef123456…)",
    );
    expect(story?.body).not.toMatch(/confidence|\bAI\b|model/i);
  });

  it("groups every supported conflict kind and makes file selection accessible", () => {
    const files = [
      createFile("z.txt", "content"),
      createFile("a.txt", "binary"),
      createFile("b.txt", "submodule"),
      createFile("c.txt", "add-add"),
      createFile("d.txt", "modify-delete"),
      createFile("e.txt", "rename"),
    ];

    expect(groupConflictFiles(files).map((group) => group.label)).toEqual([
      "Content conflicts · 1",
      "Add/add conflicts · 1",
      "Modify/delete conflicts · 1",
      "Rename conflicts · 1",
      "Binary conflicts · 1",
      "Submodule conflicts · 1",
    ]);
    const items = buildConflictFileQuickPickItems(files);
    expect(
      items
        .filter((item) => item.conflictFile !== undefined)
        .map((item) => item.label),
    ).toEqual(["z.txt", "c.txt", "d.txt", "e.txt", "a.txt", "b.txt"]);
    expect(
      items.find((item) => item.conflictFile?.path === "z.txt")
        ?.accessibilityInformation?.label,
    ).toContain("unresolved conflict");
  });

  it("shows safe actions and only exposes Continue, Skip, Abort when valid", () => {
    const unresolvedMerge = createSnapshot("merge", false);
    const mergeLabels = buildConflictActionQuickPickItems(
      unresolvedMerge,
      unresolvedMerge.files,
    ).map((item) => item.label);
    expect(mergeLabels).toEqual([
      "Resolve selected files",
      "Preview Base ↔ Current",
      "Preview Base ↔ Incoming",
      "Preview Current ↔ Incoming",
      "Open native merge editor",
      "Abort Operation",
    ]);
    expect(mergeLabels).not.toContain("Continue Operation");
    expect(mergeLabels).not.toContain("Skip Operation Step");

    const resolvedRebase = createSnapshot("rebase", true);
    const rebaseLabels = buildConflictActionQuickPickItems(
      resolvedRebase,
      resolvedRebase.files,
    ).map((item) => item.label);
    expect(rebaseLabels).toContain("Continue Operation");
    expect(rebaseLabels).toContain("Skip Operation Step");
    expect(rebaseLabels).toContain("Abort Operation");
    expect(isSkipValid(resolvedRebase.operation)).toBe(true);
    expect(
      buildResolutionActionQuickPickItems([
        createFile("binary.dat", "binary"),
      ]).map((item) => item.label),
    ).not.toContain("Combine");
  });
});

function createSnapshot(
  operationKind: "merge" | "rebase",
  canContinue: boolean,
): ConflictRepositorySnapshot {
  return {
    repositoryRoot: "/repo",
    fingerprint: `${operationKind}-${canContinue}`,
    headCommit: "head",
    currentBranchName: "main",
    operation: {
      kind: operationKind,
      label: operationKind === "merge" ? "Merge conflict" : "Rebase conflict",
      sourceDescription:
        operationKind === "merge"
          ? "The branch or commit being merged into the checked-out branch."
          : "The commit currently being replayed onto the checked-out branch.",
      sourceCommit: "abcdef1234567890",
      metadataPath: "/repo/.git/MERGE_HEAD",
      canAbort: true,
    },
    files: [createFile("conflict.txt", "content")],
    hasUnmergedEntries: !canContinue,
    canContinue,
    continueReason: canContinue ? undefined : "Resolve conflicts first.",
    canAbort: true,
    abortReason: undefined,
  };
}

function createFile(
  path: string,
  kind: ConflictFileState["kind"],
): ConflictFileState {
  return {
    path,
    originalPath: undefined,
    statusCode: "UU",
    kind,
    stages: {
      base: {
        side: "base",
        objectId: "base",
        mode: "100644",
        exists: true,
        kind: kind === "binary" ? "binary" : "text",
        content: Buffer.from("base\n"),
      },
      current: {
        side: "current",
        objectId: "current",
        mode: "100644",
        exists: true,
        kind: kind === "binary" ? "binary" : "text",
        content: Buffer.from("current\n"),
      },
      incoming: {
        side: "incoming",
        objectId: "incoming",
        mode: "100644",
        exists: true,
        kind: kind === "binary" ? "binary" : "text",
        content: Buffer.from("incoming\n"),
      },
    },
    workingTreeContent: Buffer.from("markers\n"),
    isResolved: false,
  };
}
