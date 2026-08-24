import { describe, expect, it } from "vitest";

import {
  buildGraphLayout,
  buildGraphLayoutAsync,
  graphLayoutRetainedRowLimit,
  IncrementalGraphLayoutBuilder,
} from "../../../src/extension/graph/graphLayout.js";

function graphCommit(
  sha: string,
  parents: readonly string[],
): { readonly sha: string; readonly parents: readonly string[] } {
  return { sha, parents };
}

function laneShas(
  lanes: readonly { readonly expectedCommitSha: string }[],
): readonly string[] {
  return lanes.map((lane) => lane.expectedCommitSha);
}

describe("graph layout lane ordering", () => {
  it("preserves complete explicit layouts beyond the host retention window", async () => {
    const commitCount = graphLayoutRetainedRowLimit + 17;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => ({
      sha: `commit-${commitIndex}`,
      parents:
        commitIndex + 1 < commitCount ? [`commit-${commitIndex + 1}`] : [],
    }));
    const options = { maxCommitCount: commitCount, colorCount: 12 };

    expect(buildGraphLayout(commits, [], options).rows).toHaveLength(
      commitCount,
    );
    const asyncLayout = await buildGraphLayoutAsync(
      commits,
      [],
      options,
      undefined,
      {
        chunkSize: 512,
        yieldControl: () => Promise.resolve(),
      },
    );
    expect(asyncLayout).toMatchObject({
      truncated: false,
    });
    expect(asyncLayout.rows).toHaveLength(commitCount);
  });

  it("keeps existing lanes ordered while appending a new parent", () => {
    const layout = buildGraphLayout(
      [
        graphCommit("root", ["x", "a", "y"]),
        graphCommit("a", ["q"]),
        graphCommit("x", []),
        graphCommit("y", []),
        graphCommit("q", []),
      ],
      [],
      { maxCommitCount: 20, colorCount: 12 },
    );

    expect(laneShas(layout.rows[1]?.lanes ?? [])).toEqual(["x", "a", "y"]);
    expect(laneShas(layout.rows[1]?.nextLanes ?? [])).toEqual(["x", "y", "q"]);
    expect(layout.rows[1]?.edges).toEqual([
      expect.objectContaining({
        parentSha: "q",
        fromColumn: 1,
        toColumn: 2,
        kind: "first-parent",
      }),
      expect.objectContaining({
        parentSha: "y",
        fromColumn: 2,
        toColumn: 1,
        kind: "continuation",
      }),
    ]);
  });

  it("emits continuation edges when compacting an existing parent lane", () => {
    const layout = buildGraphLayout(
      [
        graphCommit("root", ["x", "a", "y"]),
        graphCommit("a", ["y"]),
        graphCommit("x", []),
        graphCommit("y", []),
      ],
      [],
      { maxCommitCount: 20, colorCount: 12 },
    );

    expect(laneShas(layout.rows[1]?.nextLanes ?? [])).toEqual(["x", "y"]);
    expect(layout.rows[1]?.edges).toEqual([
      expect.objectContaining({
        parentSha: "y",
        fromColumn: 1,
        toColumn: 1,
        kind: "first-parent",
      }),
      expect.objectContaining({
        parentSha: "y",
        fromColumn: 2,
        toColumn: 1,
        kind: "continuation",
      }),
    ]);
  });

  it("preserves active lanes for multiple new merge parents", () => {
    const layout = buildGraphLayout(
      [
        graphCommit("root", ["x", "a", "y"]),
        graphCommit("a", ["q", "r"]),
        graphCommit("x", []),
        graphCommit("y", []),
        graphCommit("q", []),
        graphCommit("r", []),
      ],
      [],
      { maxCommitCount: 20, colorCount: 12 },
    );

    expect(laneShas(layout.rows[1]?.nextLanes ?? [])).toEqual([
      "x",
      "y",
      "q",
      "r",
    ]);
    expect(layout.rows[1]?.edges.slice(0, 2).map((edge) => edge.kind)).toEqual([
      "first-parent",
      "merge-parent",
    ]);
  });

  it("bounds retained rows while replaying evicted deep rows exactly", () => {
    const commitCount = graphLayoutRetainedRowLimit + 257;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => ({
      sha: `commit-${commitIndex}`,
      parents:
        commitIndex === commitCount - 1 ? [] : [`commit-${commitIndex + 1}`],
    }));
    const builder = new IncrementalGraphLayoutBuilder(commits, [], {
      maxCommitCount: commitCount,
      colorCount: 12,
    });

    builder.ensureAll();
    expect(builder.retainedRowCount).toBe(graphLayoutRetainedRowLimit);
    expect(builder.rows).toHaveLength(graphLayoutRetainedRowLimit);
    expect(builder.retainedRowStartIndex).toBe(257);
    expect(builder.ensureRowAt(128)?.commit.sha).toBe("commit-128");
    expect(builder.ensureRowAt(128)?.lanes[0]?.expectedCommitSha).toBe(
      "commit-128",
    );
    expect(builder.retainedRowCount).toBeLessThanOrEqual(
      graphLayoutRetainedRowLimit,
    );
    expect(builder.ensureRowAt(commitCount - 1)?.commit.sha).toBe(
      `commit-${commitCount - 1}`,
    );
  });

  it("runs valid async layout after a rejected predecessor", async () => {
    const commitCount = 2_000;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => ({
      sha: `commit-${commitIndex}`,
      parents:
        commitIndex === commitCount - 1 ? [] : [`commit-${commitIndex + 1}`],
    }));
    const builder = new IncrementalGraphLayoutBuilder(commits, [], {
      maxCommitCount: commitCount,
      colorCount: 12,
    });
    const cancellationController = new AbortController();
    let yieldedAfterProgress = false;
    const rejectedExpansion = builder.ensureRowsThroughAsync(
      1_000,
      cancellationController.signal,
      {
        chunkSize: 128,
        yieldControl: () => {
          yieldedAfterProgress = true;
          cancellationController.abort();
          return Promise.resolve();
        },
      },
    );
    const successfulExpansion = builder.ensureRowsThroughAsync(300, undefined, {
      chunkSize: 128,
      yieldControl: () => Promise.resolve(),
    });

    await expect(rejectedExpansion).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(successfulExpansion).resolves.toHaveLength(300);
    expect(yieldedAfterProgress).toBe(true);
    expect(builder.processedCommitCount).toBe(300);
  });
});
