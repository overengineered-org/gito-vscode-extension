import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class TestUri {
    public readonly scheme = "file";
    public readonly authority = "";
    public readonly path: string;
    public readonly query = "";
    public readonly fragment = "";

    public constructor(public readonly fsPath: string) {
      this.path = fsPath;
    }

    public toString(): string {
      return `file:${this.fsPath}`;
    }

    public static file(filePath: string): TestUri {
      return new TestUri(filePath);
    }
  }
  return { Uri: TestUri };
});

import {
  createDiffFileOpenPlan,
  createDiffNavigationOpenPlan,
  createDiffRepositoryOpenPlan,
  createRecentDiffComparison,
  findNavigationTargetIndex,
  optionsForDiffPreset,
} from "../../../src/extension/diffExperience/diffExperiencePlans.js";
import { createDiffSourceQuickPickItems } from "../../../src/extension/diffExperience/diffSourcePicker.js";
import type {
  DiffFileOnlyPlan,
  DiffRepositoryPlan,
} from "../../../src/extension/diff/index.js";
import type {
  DiffExperienceSelection,
  DiffExperienceSession,
} from "../../../src/extension/diffExperience/diffExperienceModels.js";

const repositoryRoot = {
  fsPath: "/repo",
  path: "/repo",
  scheme: "file",
  with: (changes: { path: string; query: string; fragment: string }) => ({
    fsPath: changes.path,
    path: changes.path,
    scheme: "file",
    query: changes.query,
    fragment: changes.fragment,
  }),
  toString: () => "file:/repo",
} as never;
const originalUri = { fsPath: "/repo/old.txt", scheme: "git" } as never;
const modifiedUri = { fsPath: "/repo/new.txt", scheme: "file" } as never;

function createFilePlan(): DiffFileOnlyPlan {
  return {
    kind: "file",
    repositoryRoot,
    originalUri,
    modifiedUri,
    displayPath: "new.txt",
    metadata: {
      changeType: "renamed",
      oldPath: "old.txt",
      newPath: "new.txt",
      similarityPercent: 90,
      additions: 1,
      deletions: 1,
      isBinary: false,
      isSubmodule: false,
      isSymlink: false,
    },
    presentation: {
      mode: "line",
      contextLines: 3,
      whitespaceMode: "default",
      wordComparison: false,
      intralineComparison: false,
    },
    changeRanges: [
      { oldStartLine: 1, oldLineCount: 1, newStartLine: 1, newLineCount: 1 },
    ],
    navigationEntryIds: ["change-1"],
    from: { kind: "revision", repositoryRoot, revision: "HEAD" },
    to: { kind: "working-tree", repositoryRoot },
  };
}

function createSession(): DiffExperienceSession {
  const filePlan = createFilePlan();
  const secondFile = {
    ...filePlan,
    displayPath: "second.txt",
    navigationEntryIds: ["change-2"],
  };
  const plan: DiffRepositoryPlan = {
    kind: "repository",
    repositoryRoot,
    from: filePlan.from,
    to: filePlan.to,
    files: [filePlan, secondFile],
    navigation: {
      entries: [
        {
          id: "change-1",
          fileIndex: 0,
          path: "new.txt",
          rangeIndex: 0,
          range: filePlan.changeRanges[0]!,
        },
        {
          id: "change-2",
          fileIndex: 1,
          path: "second.txt",
          rangeIndex: 0,
          range: filePlan.changeRanges[0]!,
        },
      ],
      truncated: false,
    },
    presentation: filePlan.presentation,
    totalFileCount: 2,
    omittedFileCount: 0,
    truncated: false,
    caps: { maxFiles: 500, maxOutputBytes: 1_000, maxNavigationChanges: 5_000 },
  };
  const selection: DiffExperienceSelection = {
    repositoryRoot,
    from: plan.from,
    to: plan.to,
    view: "repository",
    options: optionsForDiffPreset("review"),
  };
  return {
    selection,
    plan,
    repositoryBinding: {
      requestedRootPath: "/repo",
      rootBinding: {
        canonicalPath: "/repo",
        device: "1",
        inode: "1",
        gitDirectory: { canonicalPath: "/repo/.git", device: "1", inode: "2" },
        commonDirectory: {
          canonicalPath: "/repo/.git",
          device: "1",
          inode: "2",
        },
      },
    },
    mutableStateFingerprint: "fingerprint",
    activeFileIndex: 0,
    activeChangeEntryId: "change-1",
    swapped: false,
  };
}

describe("diff experience plans", () => {
  it("builds native single-file command with exact URIs and renderer options", () => {
    const plan = createDiffFileOpenPlan(
      createFilePlan(),
      "new.txt — HEAD ↔ Working Tree",
    );
    expect(plan).toMatchObject({
      command: "vscode.diff",
      title: "new.txt — HEAD ↔ Working Tree",
    });
    expect(plan.arguments).toEqual([
      originalUri,
      modifiedUri,
      "new.txt — HEAD ↔ Working Tree",
      { preview: false, preserveFocus: false },
    ]);
  });

  it("maps review presets to stable Git options", () => {
    expect(optionsForDiffPreset("whitespace")).toMatchObject({
      preset: "whitespace",
      contextLines: 3,
      whitespaceMode: "ignore-all",
    });
  });

  it("keeps public changes for repository plans with multiple files", () => {
    const repositoryPlan = createSession().plan;
    const openPlan = createDiffRepositoryOpenPlan(
      repositoryPlan,
      "Repository diff",
    );

    expect(openPlan.command).toBe("vscode.changes");
    expect(openPlan.arguments).toEqual([
      "Repository diff",
      [
        [
          expect.objectContaining({ path: "/repo/new.txt" }),
          originalUri,
          modifiedUri,
        ],
        [
          expect.objectContaining({ path: "/repo/second.txt" }),
          originalUri,
          modifiedUri,
        ],
      ],
    ]);
  });

  it("keeps swapped rename labels aligned with swapped URI sides", () => {
    const repositoryPlan = createSession().plan;
    const secondFile = repositoryPlan.files[1]!;
    const secondMetadataWithoutPreviousPath = { ...secondFile.metadata };
    delete secondMetadataWithoutPreviousPath.oldPath;
    const swappedPlan = createDiffRepositoryOpenPlan(
      {
        ...repositoryPlan,
        files: [
          repositoryPlan.files[0]!,
          {
            ...secondFile,
            metadata: {
              ...secondMetadataWithoutPreviousPath,
              newPath: "second.txt",
            },
          },
        ],
      },
      "Repository diff",
      true,
    );

    expect(swappedPlan.command).toBe("vscode.changes");
    expect(swappedPlan.arguments[1]).toEqual([
      [
        expect.objectContaining({ path: "/repo/old.txt" }),
        modifiedUri,
        originalUri,
      ],
      [
        expect.objectContaining({ path: "/repo/second.txt" }),
        modifiedUri,
        originalUri,
      ],
    ]);
  });

  it("retains all-submodule tuples and opens a single submodule URI", () => {
    const firstSubmodule = {
      ...createFilePlan(),
      displayPath: "modules/one",
      metadata: { ...createFilePlan().metadata, isSubmodule: true },
    };
    const secondSubmodule = {
      ...firstSubmodule,
      displayPath: "modules/two",
    };
    const allSubmodulePlan = createDiffRepositoryOpenPlan(
      {
        ...createSession().plan,
        files: [firstSubmodule, secondSubmodule],
        totalFileCount: 2,
      },
      "Submodules",
    );

    expect(allSubmodulePlan.command).toBe("vscode.changes");
    const submoduleChangeEntries = allSubmodulePlan
      .arguments[1] as readonly (readonly unknown[])[];
    expect(submoduleChangeEntries).toHaveLength(2);
    expect(submoduleChangeEntries[0]?.[0]).toMatchObject({
      path: "/repo/modules/one",
    });

    const singleSubmodulePlan = createDiffFileOpenPlan(
      {
        ...firstSubmodule,
        kind: "file",
        from: firstSubmodule.from,
        to: firstSubmodule.to,
      },
      "Submodule",
    );
    expect(singleSubmodulePlan).toMatchObject({
      command: "vscode.open",
      arguments: [modifiedUri, { preview: false, preserveFocus: false }],
    });
  });

  it("opens one repository change in the focused native diff", () => {
    const multiFilePlan = createSession().plan;
    const firstFile = multiFilePlan.files[0]!;
    const openPlan = createDiffRepositoryOpenPlan(
      {
        ...multiFilePlan,
        files: [firstFile],
        totalFileCount: 1,
      },
      "Repository diff",
    );

    expect(openPlan).toEqual({
      command: "vscode.diff",
      title: "Repository diff",
      arguments: [
        originalUri,
        modifiedUri,
        "Repository diff",
        { preview: false, preserveFocus: false },
      ],
    });
  });

  it("navigates files and changes with the same native diff command shape", () => {
    const session = createSession();
    expect(findNavigationTargetIndex(session, "next", "file")).toBe(1);
    expect(
      findNavigationTargetIndex(session, "previous", "change"),
    ).toBeUndefined();
    const nextPlan = createDiffNavigationOpenPlan(session, "next", "file");
    expect(nextPlan?.command).toBe("vscode.diff");
    expect(nextPlan?.arguments[1]).toBe(modifiedUri);
  });

  it("stores only nonsecret comparison metadata", () => {
    const session = createSession();
    const recent = createRecentDiffComparison(session.selection, 42);
    expect(recent).toEqual({
      version: 1,
      repositoryRoot: "file:/repo",
      from: { kind: "revision", revision: "HEAD" },
      to: { kind: "working-tree" },
      view: "repository",
      options: {
        preset: "review",
        contextLines: 3,
        whitespaceMode: "default",
        presentationMode: "line",
      },
      savedAt: 42,
    });
    expect(JSON.stringify(recent)).not.toContain("token");
  });

  it("uses plain source labels for the guided picker", () => {
    const labels = createDiffSourceQuickPickItems(["main", "v1.0.0"]).map(
      (item) => item.label,
    );
    expect(labels.slice(0, 5)).toEqual([
      "Working Tree",
      "Staged",
      "HEAD",
      "Branch, tag, or commit…",
      "Common base…",
    ]);
  });
});
