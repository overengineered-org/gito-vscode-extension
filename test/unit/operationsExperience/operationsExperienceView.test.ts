import { describe, expect, it } from "vitest";
import {
  buildOperationRiskReadout,
  buildOperationsMenuItems,
  formatOperationConfirmationSummary,
  formatOperationPreview,
  OPERATION_CONFIRMATION_MAX_BYTES,
  OPERATION_CONFIRMATION_MAX_LINES,
} from "../../../src/extension/operationsExperience/operationsExperienceView.js";
import type { GitOperationPreview } from "../../../src/extension/operations/index.js";

describe("Operations Experience view", () => {
  it("puts active rebase actions first and keeps keyboard-searchable details", () => {
    const items = buildOperationsMenuItems({
      repositoryRoot: "/repo",
      operation: "rebase",
      branch: "feature/one",
      summary: "Rebase in progress · feature/one · 2 worktree changes",
    });

    expect(items.slice(0, 3).map((item) => item.action)).toEqual([
      "continue",
      "skip",
      "abort",
    ]);
    expect(items.some((item) => item.detail?.includes("preview"))).toBe(true);
    expect(items.some((item) => item.detail?.includes("recovery"))).toBe(true);
  });

  it("offers only continue and abort for paused merge, cherry-pick, and revert", () => {
    for (const operation of ["merge", "cherry-pick", "revert"] as const) {
      const actions = buildOperationsMenuItems({
        repositoryRoot: "/repo",
        operation,
        summary: `${operation} in progress`,
      })
        .slice(0, 2)
        .map((item) => item.action);
      expect(actions).toEqual(["continue", "abort"]);
    }
  });

  it("does not expose invalid generic actions for an active bisect", () => {
    const items = buildOperationsMenuItems({
      repositoryRoot: "/repo",
      operation: "bisect",
      summary: "bisect in progress",
    });
    expect(items.slice(0, 1).map((item) => item.action)).toEqual(["stash"]);
  });

  it("renders repository, exact command, impact, reversibility, and recovery", () => {
    const preview = createPreview("clean.execute", [
      "clean",
      "-fd",
      "--",
      "build/",
    ]);
    const formattedPreview = formatOperationPreview(preview);

    expect(formattedPreview).toContain("Repository: /repo");
    expect(formattedPreview).toContain("Exact refs/files: clean -fd -- build/");
    expect(formattedPreview).toContain("Irreversible");
    expect(formattedPreview).toContain("No Git recovery route");
    expect(buildOperationRiskReadout(preview).impact).toContain("Remove");
  });

  it("bounds confirmation summaries but keeps identity, risk, and command access", () => {
    const preview = createPreview("reset", ["reset", "--hard", "HEAD"]);
    const longPreview = {
      ...preview,
      confirmationPlan: {
        ...preview.confirmationPlan,
        summary: "A".repeat(10_000),
      },
      expectedPostcondition: "B".repeat(10_000),
    };
    const summary = formatOperationConfirmationSummary(longPreview);

    expect(summary.split("\n").length).toBeLessThanOrEqual(
      OPERATION_CONFIRMATION_MAX_LINES,
    );
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(
      OPERATION_CONFIRMATION_MAX_BYTES,
    );
    expect(summary).toContain("Operation: reset");
    expect(summary).toContain("Repository: /repo");
    expect(summary).toContain("Command: git reset --hard HEAD");
    expect(summary).toContain("Full exact preview opened");
  });

  it("gives actionable quick-pick items accessible labels", () => {
    const items = buildOperationsMenuItems();
    for (const item of items) {
      const accessibilityLabel = item.accessibilityInformation?.label;
      if (accessibilityLabel === undefined) continue;
      expect(accessibilityLabel).toContain(item.label);
    }
  });
});

function createPreview(
  operation: GitOperationPreview["operation"],
  displayArguments: readonly string[],
): GitOperationPreview {
  return {
    operation,
    repositoryRoot: "/repo",
    displayArguments,
    destructive: true,
    state: {
      repositoryRoot: "/repo",
      headCommit: "0123456789012345678901234567890123456789",
      headRef: "main",
      isClean: true,
      hasConflicts: false,
      statusPorcelain: "",
    },
    preconditions: [],
    confirmationPlan: {
      confirmationToken: "token",
      operation,
      repositoryRoot: "/repo",
      summary: "Remove the exact untracked candidates shown by clean preview.",
      consequences: ["The requested clean candidates no longer exist."],
      cancellationSupported: true,
    },
    expectedPostcondition: "The requested clean candidates no longer exist.",
    generatedAt: "2026-08-23T00:00:00.000Z",
  };
}
