import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import {
  createCompareModeQuickPickItems,
  createCompareOpenPlan,
  createCompareReferenceQuickPickItems,
  createCompareSessionActionItems,
  createCompareSummary,
  createEmptySearchBuilderState,
  createSearchBuilderQuickPickItems,
  createSearchQueryChips,
  invertCompareResult,
  searchBuilderStateToQuery,
  targetForReferenceItem,
  toggleSearchBuilderOption,
} from "../../../src/extension/compareExperience/index.js";
import type { CompareResult } from "../../../src/extension/compare/compareModels.js";

function testUri(path: string): vscode.Uri {
  const uri: vscode.Uri = {
    scheme: "file",
    authority: "",
    path,
    query: "",
    fragment: "",
    fsPath: path,
    with(change) {
      return testUri(change.path ?? path);
    },
    toString() {
      return `file://${path}`;
    },
    toJSON() {
      return { scheme: "file", path };
    },
  };
  return uri;
}

describe("premium compare experience plans", () => {
  it("keeps active-session actions bounded and cancellation contextual", () => {
    expect(
      createCompareSessionActionItems().map((item) => item.action),
    ).toEqual([
      "open-all",
      "swap-sides",
      "checklist",
      "reset-checklist",
      "done",
    ]);
    expect(
      createCompareSessionActionItems(true).map((item) => item.action),
    ).toContain("cancel");
  });

  it("offers task-first refs with exact targets and plain mode explanations", () => {
    const referenceItems = createCompareReferenceQuickPickItems([
      "right",
      "main",
      "right",
      "",
    ]);
    expect(referenceItems.slice(0, 5).map((item) => item.label)).toEqual([
      "Current",
      "Upstream",
      "Working tree",
      "Staged",
      "Branch, tag, or commit…",
    ]);
    expect(referenceItems.slice(5).map((item) => item.label)).toEqual([
      "right",
      "main",
    ]);
    expect(referenceItems[0]?.target).toEqual({ kind: "ref", ref: "HEAD" });
    expect(referenceItems[2]?.target).toEqual({ kind: "working" });
    expect(targetForReferenceItem(referenceItems[4]!, "feature/x")).toEqual({
      kind: "ref",
      ref: "feature/x",
    });

    expect(createCompareModeQuickPickItems().map((item) => item.mode)).toEqual([
      "common-base",
      "direct",
    ]);
    expect(createCompareModeQuickPickItems()[0]?.description).toContain(
      "shared ancestor",
    );
    expect(createCompareModeQuickPickItems()[1]?.description).toContain(
      "exactly",
    );
  });

  it("creates a complete summary and public changes plan, including swaps", () => {
    const originalUri = testUri("/repo/old.txt");
    const modifiedUri = testUri("/repo/new.txt");
    const result = {
      repositoryRoot: testUri("/repo"),
      mode: "common-base",
      left: { target: { kind: "ref", ref: "left" }, commitSha: "a" },
      right: { target: { kind: "ref", ref: "right" }, commitSha: "b" },
      commonBaseSha: "base",
      aheadCount: 2,
      behindCount: 1,
      aheadCommits: [],
      behindCommits: [],
      files: [],
      fileCounts: {
        total: 3,
        added: 1,
        deleted: 1,
        modified: 0,
        renamed: 1,
        copied: 0,
        typeChanged: 0,
        unmerged: 0,
        binary: 1,
        additions: 4,
        deletions: 2,
      },
      multiDiffPlan: {
        command: "vscode.changes",
        title: "engine title",
        resources: [
          {
            path: "new.txt",
            status: "renamed",
            originalUri,
            modifiedUri,
          },
        ],
      },
      truncated: false,
    } satisfies CompareResult;
    const summary = createCompareSummary(result);
    expect(summary.explanation).toContain("shared ancestor");
    expect(summary.metrics).toEqual([
      { id: "ahead", label: "Ahead", value: 2 },
      { id: "behind", label: "Behind", value: 1 },
      { id: "commits", label: "Commits", value: 3 },
      { id: "files", label: "Files", value: 3 },
      { id: "additions", label: "Additions", value: 4 },
      { id: "deletions", label: "Deletions", value: 2 },
      { id: "renames", label: "Renames", value: 1 },
      { id: "binary", label: "Binary", value: 1 },
    ]);
    const plan = createCompareOpenPlan(result);
    const swappedPlan = createCompareOpenPlan(result, true);
    expect(plan.command).toBe("vscode.changes");
    expect(plan.arguments[0]).toBe(plan.title);
    expect(plan.arguments[1][0]).toEqual([
      expect.objectContaining({ path: "/repo/new.txt" }),
      originalUri,
      modifiedUri,
    ]);
    expect(swappedPlan.arguments[1][0]).toEqual([
      expect.objectContaining({ path: "/repo/new.txt" }),
      modifiedUri,
      originalUri,
    ]);
    expect(plan.arguments[1][0]?.[0]).toMatchObject({
      scheme: "file",
      path: "/repo/new.txt",
      query: "",
      fragment: "",
    });
  });

  it("keeps submodules in compare data but excludes them from text changes", () => {
    const result = {
      repositoryRoot: testUri("/repo"),
      mode: "direct",
      left: { target: { kind: "ref", ref: "left" }, commitSha: "a" },
      right: { target: { kind: "ref", ref: "right" }, commitSha: "b" },
      aheadCount: 0,
      behindCount: 0,
      aheadCommits: [],
      behindCommits: [],
      files: [],
      fileCounts: {
        total: 1,
        added: 0,
        deleted: 0,
        modified: 1,
        renamed: 0,
        copied: 0,
        typeChanged: 0,
        unmerged: 0,
        binary: 0,
        additions: 0,
        deletions: 0,
        submodules: 1,
      },
      multiDiffPlan: {
        command: "vscode.changes",
        title: "submodule",
        resources: [
          {
            path: "nested-module",
            status: "modified",
            isSubmodule: true,
            originalUri: testUri("/repo/nested-module-old"),
            modifiedUri: testUri("/repo/nested-module-new"),
          },
        ],
      },
      truncated: false,
    } satisfies CompareResult;

    expect(createCompareOpenPlan(result).arguments[1]).toEqual([
      [
        expect.objectContaining({ path: "/repo/nested-module" }),
        result.multiDiffPlan.resources[0]!.originalUri,
        result.multiDiffPlan.resources[0]!.modifiedUri,
      ],
    ]);
  });

  it("keeps search fields visible as chips and preserves all builder options", () => {
    let state = createEmptySearchBuilderState({
      name: "Ada Lovelace",
      email: "ada@example.test",
    });
    state = {
      ...state,
      clauses: [
        { field: "message", value: "parser fix", operator: "contains" },
        { field: "author", value: "ada", operator: "contains" },
        { field: "sha", value: "abc123", operator: "contains" },
        { field: "file", value: "src/parser.ts", operator: "contains" },
        { field: "patch", value: "needle", operator: "contains" },
        { field: "date", value: "2026-08-01", operator: "on-or-after" },
        { field: "ref", value: "main", operator: "contains" },
        { field: "@me", value: "", operator: "equals" },
      ],
    };
    state = toggleSearchBuilderOption(state, "regex");
    state = toggleSearchBuilderOption(state, "matchCase");
    state = toggleSearchBuilderOption(state, "matchAll");
    expect(createSearchQueryChips(state).map((chip) => chip.label)).toEqual([
      "Message: parser fix",
      "Author: ada",
      "SHA: abc123",
      "File: src/parser.ts",
      "Patch: needle",
      "Date: >=2026-08-01",
      "Ref: main",
      "@me",
    ]);
    const query = searchBuilderStateToQuery(state);
    expect(query).toMatchObject({
      matchCase: true,
      regex: true,
      matchAll: true,
      currentUser: { email: "ada@example.test" },
    });
    expect(
      createSearchBuilderQuickPickItems(state).map((item) => item.label),
    ).toEqual([
      "Add Message",
      "Add Author",
      "Add SHA",
      "Add File",
      "Add Patch",
      "Add Date",
      "Add Ref",
      "Add @me",
      "Regex: On",
      "Case-sensitive: On",
      "Match all: On",
      "Run search",
      "Clear query",
    ]);
  });

  it("hides @me when the selected repository has no Git identity", () => {
    expect(
      createSearchBuilderQuickPickItems(createEmptySearchBuilderState()).map(
        (item) => item.label,
      ),
    ).not.toContain("Add @me");
  });

  it("reverses directional counts, rename paths, URIs, and titles", () => {
    const result = {
      repositoryRoot: testUri("/repo"),
      mode: "direct",
      left: { target: { kind: "ref", ref: "left" }, commitSha: "a" },
      right: { target: { kind: "ref", ref: "right" }, commitSha: "b" },
      aheadCount: 4,
      behindCount: 1,
      aheadCommits: [],
      behindCommits: [],
      files: [
        {
          path: "new.txt",
          previousPath: "old.txt",
          status: "renamed",
          additions: 3,
          deletions: 2,
          isBinary: false,
          oldMode: "100644",
          newMode: "100755",
          originalUri: testUri("/repo/old.txt"),
          modifiedUri: testUri("/repo/new.txt"),
        },
        {
          path: "added.txt",
          status: "added",
          additions: 1,
          deletions: 0,
          isBinary: false,
          modifiedUri: testUri("/repo/added.txt"),
        },
      ],
      fileCounts: {
        total: 1,
        added: 0,
        deleted: 0,
        modified: 0,
        renamed: 1,
        copied: 0,
        typeChanged: 0,
        unmerged: 0,
        binary: 0,
        additions: 3,
        deletions: 2,
      },
      multiDiffPlan: {
        command: "vscode.changes",
        title: "forward",
        resources: [
          {
            path: "new.txt",
            status: "renamed",
            originalUri: testUri("/repo/old.txt"),
            modifiedUri: testUri("/repo/new.txt"),
          },
          {
            path: "added.txt",
            status: "added",
            modifiedUri: testUri("/repo/added.txt"),
          },
        ],
      },
      truncated: false,
    } satisfies CompareResult;
    const inverted = invertCompareResult(result);
    expect(inverted.left.target).toEqual(result.right.target);
    expect(inverted.aheadCount).toBe(1);
    expect(inverted.behindCount).toBe(4);
    expect(inverted.files[0]).toMatchObject({
      path: "old.txt",
      previousPath: "new.txt",
      additions: 2,
      deletions: 3,
      oldMode: "100755",
      newMode: "100644",
    });
    expect(inverted.files[1]).toMatchObject({
      path: "added.txt",
      status: "deleted",
    });
    expect(inverted.files[1]?.originalUri?.fsPath).toBe("/repo/added.txt");
    expect(inverted.files[1]?.modifiedUri).toBeUndefined();
    expect(inverted.multiDiffPlan.resources[0]?.path).toBe("old.txt");
    expect(inverted.multiDiffPlan.resources[0]?.originalUri?.fsPath).toBe(
      "/repo/new.txt",
    );
    expect(inverted.multiDiffPlan.resources[0]?.modifiedUri?.fsPath).toBe(
      "/repo/old.txt",
    );
    expect(inverted.multiDiffPlan.resources[1]).toMatchObject({
      path: "added.txt",
      status: "deleted",
    });
    expect(inverted.multiDiffPlan.resources[1]?.originalUri?.fsPath).toBe(
      "/repo/added.txt",
    );
    expect(inverted.multiDiffPlan.resources[1]?.modifiedUri).toBeUndefined();
    expect(inverted.multiDiffPlan.title).toContain("right");
    const swappedPlan = createCompareOpenPlan(result, true);
    expect(swappedPlan.arguments[1][0]?.[0]).toMatchObject({
      path: "/repo/old.txt",
    });
    expect(swappedPlan.arguments[1][0]?.[1]).toMatchObject({
      fsPath: "/repo/new.txt",
    });
    expect(swappedPlan.arguments[1][0]?.[2]).toMatchObject({
      fsPath: "/repo/old.txt",
    });
  });
});
