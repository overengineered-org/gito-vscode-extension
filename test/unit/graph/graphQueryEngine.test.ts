import { describe, expect, it, vi } from "vitest";
import {
  CommitGraphQueryEngine,
  decodeGraphCursor,
  encodeGraphCursor,
  getGraphSemanticColorIndex,
  graphLayoutRetainedRowLimit,
  parseChangedLineMetrics,
  type GraphRepositorySnapshot,
} from "../../../src/extension/graph/index.js";

const commit = (sha: string, parents: readonly string[], subject = sha) => ({
  sha,
  parents,
  subject,
  authorName: "Graph Author",
  authorEmail: "graph@example.test",
  commitDate: "2026-08-23T10:00:00+10:00",
});

function createMergeSnapshot(): GraphRepositorySnapshot {
  return {
    commits: [
      commit("merge", ["feature", "main-parent"], "merge feature"),
      commit("feature", ["base"], "feature work"),
      commit("main-parent", ["base"], "main work"),
      commit("base", [], "base"),
    ],
    references: [
      { name: "HEAD", targetSha: "merge", kind: "head", isHead: true },
      {
        name: "refs/heads/main",
        targetSha: "merge",
        kind: "local",
        upstreamRefName: "refs/remotes/origin/main",
      },
      { name: "refs/heads/feature", targetSha: "feature", kind: "local" },
      {
        name: "refs/remotes/origin/main",
        targetSha: "main-parent",
        kind: "remote",
      },
      { name: "refs/tags/v1", targetSha: "base", kind: "tag" },
      { name: "refs/stash", targetSha: "feature", kind: "stash" },
    ],
    worktrees: [
      {
        path: "/repo",
        headSha: "merge",
        branchRefName: "refs/heads/main",
        isPrimary: true,
      },
      {
        path: "/repo-feature",
        headSha: "feature",
        branchRefName: "refs/heads/feature",
      },
    ],
    workingTree: {
      stagedChangeCount: 1,
      unstagedChangeCount: 2,
      untrackedChangeCount: 1,
    },
  };
}

describe("CommitGraphQueryEngine", () => {
  it("keeps exact merge topology and semantic lane continuity", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    const page = engine.query({
      pageSize: 20,
      includeWip: true,
      includeWorktrees: true,
    });
    const commitRows = page.rows.filter((row) => row.kind === "commit");
    expect(commitRows.map((row) => row.commitSha)).toEqual([
      "merge",
      "feature",
      "main-parent",
      "base",
    ]);
    expect(commitRows[0]?.parents).toEqual(["feature", "main-parent"]);
    expect(commitRows[0]?.edges.map((edge) => edge.parentSha)).toEqual([
      "feature",
      "main-parent",
    ]);
    expect(commitRows[0]?.edges[0]?.kind).toBe("first-parent");
    expect(commitRows[0]?.edges[1]?.kind).toBe("merge-parent");
    expect(commitRows[1]?.lanes.map((lane) => lane.expectedCommitSha)).toEqual([
      "feature",
      "main-parent",
    ]);
    expect(commitRows[2]?.lanes.map((lane) => lane.expectedCommitSha)).toEqual([
      "main-parent",
      "base",
    ]);
    expect(page.rows[0]?.kind).toBe("wip");
    expect(
      page.rows
        .filter((row) => row.kind === "worktree")
        .map((row) => row.worktree.path),
    ).toEqual(["/repo", "/repo-feature"]);
  });

  it("places refs by semantic kind and supports scopes", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    const allRows = engine
      .query({ pageSize: 20 })
      .rows.filter((row) => row.kind === "commit");
    expect(allRows[0]?.references.map((reference) => reference.name)).toEqual([
      "HEAD",
      "refs/heads/main",
    ]);
    expect(
      engine
        .query({ pageSize: 20, filter: { scope: "remote" } })
        .rows.map((row) => row.kind),
    ).toEqual(["commit", "commit"]);
    expect(
      engine
        .query({ pageSize: 20, filter: { scope: "tags" } })
        .rows.map((row) => row.kind),
    ).toEqual(["commit"]);
  });

  it("computes merge-base and ahead/behind counts from the DAG", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    expect(engine.findMergeBase("merge", "main-parent")).toBe("main-parent");
    expect(engine.getBranchStatus("refs/heads/main")).toEqual({
      localRefName: "refs/heads/main",
      upstreamRefName: "refs/remotes/origin/main",
      mergeBaseSha: "main-parent",
      aheadCount: 2,
      behindCount: 0,
    });
  });

  it("keeps only best common ancestors for criss-cross history", () => {
    const crissCrossSnapshot: GraphRepositorySnapshot = {
      commits: [
        commit("left-tip", ["left-base", "right-base"]),
        commit("right-tip", ["right-base", "left-base"]),
        commit("left-base", ["root"]),
        commit("right-base", ["root"]),
        commit("root", []),
      ],
    };
    const engine = new CommitGraphQueryEngine(crissCrossSnapshot);
    expect(engine.findMergeBase("left-tip", "right-tip")).toBe("left-base");
  });

  it("does not report branch topology from a truncated or incomplete snapshot", () => {
    const truncatedEngine = new CommitGraphQueryEngine({
      ...createMergeSnapshot(),
      truncated: true,
    });
    expect(truncatedEngine.getBranchStatus("refs/heads/main")).toBeUndefined();
    expect(
      truncatedEngine.findMergeBase("merge", "main-parent"),
    ).toBeUndefined();

    const incompleteEngine = new CommitGraphQueryEngine({
      commits: [commit("tip", ["missing-parent"])],
      references: [
        {
          name: "refs/heads/tip",
          targetSha: "tip",
          kind: "local",
          upstreamRefName: "refs/remotes/origin/tip",
        },
        {
          name: "refs/remotes/origin/tip",
          targetSha: "missing-parent",
          kind: "remote",
        },
      ],
    });
    expect(incompleteEngine.getBranchStatus("refs/heads/tip")).toBeUndefined();
    expect(
      incompleteEngine.findMergeBase("tip", "missing-parent"),
    ).toBeUndefined();
  });

  it("paginates with an opaque snapshot-bound cursor", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    const firstPage = engine.query({ pageSize: 2 });
    expect(
      firstPage.rows.map((row) => row.kind === "commit" && row.commitSha),
    ).toEqual(["merge", "feature"]);
    expect(firstPage.nextCursor).toBeDefined();
    const encodedCursor = encodeGraphCursor(firstPage.nextCursor!);
    expect(decodeGraphCursor(encodedCursor)).toEqual(firstPage.nextCursor);
    const secondPage = engine.query({ pageSize: 2, cursor: encodedCursor });
    expect(
      secondPage.rows.map((row) => row.kind === "commit" && row.commitSha),
    ).toEqual(["main-parent", "base"]);
    expect(() =>
      engine.query({ cursor: { snapshotKey: "stale", rowOffset: 2 } }),
    ).toThrow(/different repository snapshot/);
  });

  it("keeps deep cursor layout retention bounded and replays exact rows", () => {
    const commitCount = graphLayoutRetainedRowLimit + 512;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => ({
      sha: `commit-${commitIndex}`,
      parents:
        commitIndex === commitCount - 1 ? [] : [`commit-${commitIndex + 1}`],
      subject: `subject-${commitIndex}`,
    }));
    const engine = new CommitGraphQueryEngine(
      { commits },
      { maxCommitCount: commitCount, maxRowCount: commitCount },
    );
    const firstPage = engine.query({ pageSize: 1 });
    const deepCursor = {
      snapshotKey: firstPage.snapshotKey,
      rowOffset: commitCount - 25,
    };
    const deepPage = engine.query({ pageSize: 25, cursor: deepCursor });
    expect(
      deepPage.rows.map((row) => row.kind === "commit" && row.commitSha),
    ).toEqual(
      Array.from(
        { length: 25 },
        (_, offset) => `commit-${commitCount - 25 + offset}`,
      ),
    );

    const layoutBuilder = (
      engine as unknown as {
        readonly incrementalLayoutBuilder: {
          readonly retainedRowCount: number;
        };
      }
    ).incrementalLayoutBuilder;
    expect(layoutBuilder.retainedRowCount).toBeLessThanOrEqual(
      graphLayoutRetainedRowLimit,
    );
    const matchingRowCountCache = (
      engine as unknown as {
        readonly matchingRowCountCache: ReadonlyMap<
          string,
          { readonly matchingRowCheckpoints: readonly unknown[] }
        >;
      }
    ).matchingRowCountCache;
    const matchingRowCount = [...matchingRowCountCache.values()][0];
    expect(matchingRowCount?.matchingRowCheckpoints.length).toBeLessThan(50);

    const replayedFirstPage = engine.query({
      pageSize: 25,
      cursor: { snapshotKey: firstPage.snapshotKey, rowOffset: 0 },
    });
    expect(
      replayedFirstPage.rows.map(
        (row) => row.kind === "commit" && row.commitSha,
      ),
    ).toEqual(Array.from({ length: 25 }, (_, offset) => `commit-${offset}`));
  });

  it("serializes concurrent deep and replayed async cursors", async () => {
    const commitCount = graphLayoutRetainedRowLimit + 256;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => ({
      sha: `commit-${commitIndex}`,
      parents:
        commitIndex === commitCount - 1 ? [] : [`commit-${commitIndex + 1}`],
    }));
    const engine = new CommitGraphQueryEngine(
      { commits },
      { maxCommitCount: commitCount, maxRowCount: commitCount },
    );
    const snapshotKey = engine.query({ pageSize: 1 }).snapshotKey;
    const asyncOptions = {
      chunkSize: 512,
      yieldControl: () => Promise.resolve(),
    };
    const [deepPage, firstPage] = await Promise.all([
      engine.queryAsync(
        {
          pageSize: 10,
          cursor: {
            snapshotKey,
            rowOffset: commitCount - 10,
          },
        },
        asyncOptions,
      ),
      engine.queryAsync({ pageSize: 10 }, asyncOptions),
    ]);
    expect(
      deepPage.rows[0]?.kind === "commit" && deepPage.rows[0].commitSha,
    ).toBe(`commit-${commitCount - 10}`);
    expect(
      firstPage.rows[0]?.kind === "commit" && firstPage.rows[0].commitSha,
    ).toBe("commit-0");
  });

  it("keeps sparse filtered checkpoints from skipping the first match", () => {
    const commitCount = 1_024;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => ({
      sha: `commit-${commitIndex}`,
      parents:
        commitIndex === commitCount - 1 ? [] : [`commit-${commitIndex + 1}`],
    }));
    const engine = new CommitGraphQueryEngine(
      { commits },
      { maxCommitCount: commitCount, maxRowCount: commitCount },
    );
    const page = engine.query({
      pageSize: 1,
      filter: { commitShas: ["commit-17"] },
    });
    expect(page.rows[0]?.kind === "commit" && page.rows[0].commitSha).toBe(
      "commit-17",
    );
  });

  it("bounds full filter indexes to one retained query", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    const matchingRowCountCache = (
      engine as unknown as {
        readonly matchingRowCountCache: ReadonlyMap<string, unknown>;
      }
    ).matchingRowCountCache;

    const firstFilterPage = engine.query({
      pageSize: 20,
      filter: { commitShas: ["merge"] },
    });
    const firstFilterCacheKey = [...matchingRowCountCache.keys()][0];
    expect(firstFilterPage.rows.map((row) => row.kind)).toEqual(["commit"]);
    expect(matchingRowCountCache.size).toBe(1);
    expect(firstFilterCacheKey).toBeDefined();

    const secondFilterPage = engine.query({
      pageSize: 20,
      filter: { commitShas: ["feature"] },
    });
    expect(secondFilterPage.rows.map((row) => row.kind)).toEqual(["commit"]);
    expect(matchingRowCountCache.size).toBe(1);
    expect([...matchingRowCountCache.keys()][0]).not.toBe(firstFilterCacheKey);

    const firstFilterAgainPage = engine.query({
      pageSize: 20,
      filter: { commitShas: ["merge"] },
    });
    expect(firstFilterAgainPage.rows.map((row) => row.kind)).toEqual([
      "commit",
    ]);
    expect(matchingRowCountCache.size).toBe(1);
  });

  it("loads changed lines lazily and bounds cache entries", async () => {
    const metricsLoader = vi.fn((commitSha: string) =>
      Promise.resolve({
        commitSha,
        additions: 4,
        deletions: 2,
        changedFileCount: 1,
        binaryFileCount: 0,
      }),
    );
    const engine = new CommitGraphQueryEngine(createMergeSnapshot(), {
      metricsLoader,
      maxMetricsCacheEntries: 1,
    });
    expect(metricsLoader).not.toHaveBeenCalled();
    await expect(engine.getChangedLineMetrics("merge")).resolves.toMatchObject({
      additions: 4,
    });
    await engine.getChangedLineMetrics("feature");
    await engine.getChangedLineMetrics("merge");
    expect(metricsLoader).toHaveBeenCalledTimes(3);
  });

  it("cancels before and after async layout work begins", async () => {
    const cancellationController = new AbortController();
    cancellationController.abort();
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    expect(() =>
      engine.query({ cancellationSignal: cancellationController.signal }),
    ).toThrowError(/cancelled/);
    const manyCommits = Array.from({ length: 2_000 }, (_, commitIndex) =>
      commit(
        `c${String(commitIndex).padStart(4, "0")}`,
        commitIndex === 1_999
          ? []
          : [`c${String(commitIndex + 1).padStart(4, "0")}`],
      ),
    );
    const manyEngine = new CommitGraphQueryEngine({ commits: manyCommits });
    const delayedController = new AbortController();
    let yieldedAfterProgress = false;
    await expect(
      manyEngine.queryAsync(
        { cancellationSignal: delayedController.signal, pageSize: 20 },
        {
          chunkSize: 128,
          yieldControl: () => {
            yieldedAfterProgress = true;
            delayedController.abort();
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(yieldedAfterProgress).toBe(true);
  });

  it("parses aggregate numstat while discarding paths", () => {
    expect(
      parseChangedLineMetrics("merge", "2\t3\tsrc/a.ts\n-\t-\tasset.bin\n"),
    ).toEqual({
      commitSha: "merge",
      additions: 2,
      deletions: 3,
      changedFileCount: 2,
      binaryFileCount: 1,
    });
    expect(getGraphSemanticColorIndex("merge", 12)).toBe(7);
    expect(getGraphSemanticColorIndex("feature", 12)).toBe(5);
    expect(getGraphSemanticColorIndex("main", 12)).toBe(0);
  });

  it("aggregates minimap buckets without exposing patch bodies", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    expect(engine.getMinimapBuckets({ bucketCount: 2 })).toEqual([
      expect.objectContaining({
        bucketIndex: 0,
        commitCount: 2,
        mergeCount: 1,
      }),
      expect.objectContaining({
        bucketIndex: 1,
        commitCount: 2,
        mergeCount: 0,
      }),
    ]);
  });

  it("reports commit hard-cap truncation explicitly", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot(), {
      maxCommitCount: 3,
    });
    const page = engine.query({ pageSize: 10 });
    expect(page.totalCommits).toBe(3);
    expect(page.truncated).toBe(true);
  });

  it("reports an exact row cap and binds cursors to row-shaping state", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot(), {
      maxRowCount: 4,
    });
    const cappedPage = engine.query({
      pageSize: 4,
      includeWip: true,
      includeWorktrees: true,
    });
    expect(cappedPage.totalRows).toBe(4);
    expect(cappedPage.hasMore).toBe(false);
    expect(cappedPage.truncated).toBe(true);

    const firstPage = engine.query({ pageSize: 1, includeWip: true });
    expect(firstPage.nextCursor).toBeDefined();
    expect(() =>
      engine.query({
        cursor: firstPage.nextCursor!,
        pageSize: 1,
        includeWip: false,
      }),
    ).toThrow(/different repository snapshot/iu);
  });

  it("uses global minimap row indexes when WIP and worktrees are present", () => {
    const engine = new CommitGraphQueryEngine(createMergeSnapshot());
    const buckets = engine.getMinimapBuckets({
      bucketCount: 7,
      includeWip: true,
      includeWorktrees: true,
    });
    expect(buckets[0]).toMatchObject({
      startRow: 0,
      endRow: 0,
      commitCount: 0,
    });
    expect(buckets[1]).toMatchObject({
      startRow: 1,
      endRow: 1,
      commitCount: 0,
    });
    expect(buckets[2]).toMatchObject({
      startRow: 2,
      endRow: 2,
      commitCount: 1,
    });
    expect(buckets.at(-1)).toMatchObject({
      startRow: 6,
      endRow: 6,
      commitCount: 1,
    });
  });

  it("lets one cancelled layout waiter leave shared layout work for another", async () => {
    const manyCommits = Array.from({ length: 2_000 }, (_, commitIndex) =>
      commit(
        `c${String(commitIndex).padStart(4, "0")}`,
        commitIndex === 1_999
          ? []
          : [`c${String(commitIndex + 1).padStart(4, "0")}`],
      ),
    );
    const engine = new CommitGraphQueryEngine({ commits: manyCommits });
    const cancelledController = new AbortController();
    const successfulController = new AbortController();
    let firstYield = true;
    const cancelledQuery = engine.queryAsync(
      { pageSize: 20, cancellationSignal: cancelledController.signal },
      {
        chunkSize: 128,
        yieldControl: () => {
          if (firstYield) {
            firstYield = false;
            cancelledController.abort();
          }
          return Promise.resolve();
        },
      },
    );
    const successfulQuery = engine.queryAsync(
      { pageSize: 20, cancellationSignal: successfulController.signal },
      { chunkSize: 128, yieldControl: () => Promise.resolve() },
    );
    await expect(cancelledQuery).rejects.toMatchObject({ name: "AbortError" });
    await expect(successfulQuery).resolves.toMatchObject({
      totalCommits: 2_000,
    });
  });
});
