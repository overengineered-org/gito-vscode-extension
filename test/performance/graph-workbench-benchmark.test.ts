// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  CommitGraphQueryEngine,
  graphLayoutRetainedRowLimit,
} from "../../src/extension/graph/index.js";
import { GitCommitGraphLoader } from "../../src/extension/graph/gitGraphLoader.js";
import { NodeGitCommandRunner } from "../../src/extension/git/gitCommandRunner.js";
import type { GraphCursor } from "../../src/extension/graph/index.js";
import type { GraphRowMessage } from "../../src/protocol/graphExperienceProtocol.js";
import {
  graphRowStoreRetainedRowLimit,
  GraphRowStore,
} from "../../src/webview/graph/graphVirtualizer.js";
import {
  calculateP95Milliseconds,
  createTemporaryGitGraphRepository,
  graphLoaderEndToEndP95BudgetMilliseconds,
  graphLoaderFastImportCommitCount,
  type TemporaryGitGraphRepository,
} from "./fixtures/largeRepositoryFixtures.js";

const graphFixtureRepositories: TemporaryGitGraphRepository[] = [];

afterEach(async () => {
  while (graphFixtureRepositories.length > 0) {
    const graphFixtureRepository = graphFixtureRepositories.pop();
    if (graphFixtureRepository === undefined) continue;
    await rm(graphFixtureRepository.rootDirectory, {
      recursive: true,
      force: true,
    });
  }
});

function createCommitRows(rowCount: number): GraphRowMessage[] {
  return Array.from({ length: rowCount }, (_, rowIndex) => ({
    kind: "commit" as const,
    rowIndex,
    commitSha: rowIndex.toString(16).padStart(40, "0"),
    parents: [],
    lanes: [],
    nextLanes: [],
    edges: [],
    references: [],
  }));
}

function createGraphCommits(commitCount: number) {
  return Array.from({ length: commitCount }, (_, commitIndex) => ({
    sha: commitIndex.toString(16).padStart(40, "0"),
    parents:
      commitIndex === commitCount - 1
        ? []
        : [(commitIndex + 1).toString(16).padStart(40, "0")],
    subject: `commit ${commitIndex}`,
  }));
}

describe("premium graph performance budgets", () => {
  it("loads and queries a 5,000-commit fast-import graph end to end", async () => {
    const graphFixtureRepository = await createTemporaryGitGraphRepository();
    graphFixtureRepositories.push(graphFixtureRepository);
    const graphLoadAndQueryElapsedMilliseconds: number[] = [];

    for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
      const pipelineStartTime = performance.now();
      const graphLoader = new GitCommitGraphLoader(new NodeGitCommandRunner());
      const graphSnapshot = await graphLoader.load(
        graphFixtureRepository.repositoryPath,
        { maxCommitCount: graphLoaderFastImportCommitCount },
      );
      const graphQueryEngine = new CommitGraphQueryEngine(graphSnapshot, {
        maxCommitCount: graphLoaderFastImportCommitCount,
        maxRowCount: graphLoaderFastImportCommitCount,
      });
      const firstGraphPage = await graphQueryEngine.queryAsync(
        { pageSize: 160 },
        { chunkSize: 256, yieldControl: () => Promise.resolve() },
      );
      graphLoadAndQueryElapsedMilliseconds.push(
        performance.now() - pipelineStartTime,
      );

      expect(graphSnapshot.commits).toHaveLength(
        graphLoaderFastImportCommitCount,
      );
      expect(firstGraphPage.rows).toHaveLength(160);
      expect(firstGraphPage.totalCommits).toBe(
        graphLoaderFastImportCommitCount,
      );
      expect(firstGraphPage.totalRows).toBe(graphLoaderFastImportCommitCount);
      expect(firstGraphPage.truncated).toBe(false);
    }

    expect(
      calculateP95Milliseconds(graphLoadAndQueryElapsedMilliseconds),
    ).toBeLessThanOrEqual(graphLoaderEndToEndP95BudgetMilliseconds);
  }, 30_000);

  it("appends 100k webview rows without page-wide rebuilds", () => {
    const rows = createCommitRows(100_000);
    const rowStore = new GraphRowStore();
    const pageElapsedMilliseconds: number[] = [];
    const appendStartTime = performance.now();
    for (let pageStart = 0; pageStart < rows.length; pageStart += 100) {
      const pageStartTime = performance.now();
      rowStore.appendPage({
        rows: rows.slice(pageStart, pageStart + 100),
        hasMore: pageStart + 100 < rows.length,
        totalRows: rows.length,
        totalCommits: rows.length,
        truncated: false,
        snapshotKey: "graph-performance",
      });
      pageElapsedMilliseconds.push(performance.now() - pageStartTime);
    }
    expect(rowStore.size).toBe(graphRowStoreRetainedRowLimit);
    expect(rowStore.size).toBeLessThan(rows.length);
    expect(rowStore.getWindow(99_920, 100_000)).toHaveLength(80);
    expect(performance.now() - appendStartTime).toBeLessThanOrEqual(2_000);
    expect(Math.max(...pageElapsedMilliseconds)).toBeLessThanOrEqual(100);
  });

  it("keeps 100k graph page and minimap work bounded", async () => {
    const commitCount = 100_000;
    const engine = new CommitGraphQueryEngine(
      {
        commits: createGraphCommits(commitCount),
        references: [],
      },
      { maxCommitCount: commitCount, maxRowCount: commitCount },
    );
    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const pageStartTime = performance.now();
    const page = await engine.queryAsync(
      { pageSize: 160 },
      { chunkSize: 256, yieldControl: () => Promise.resolve() },
    );
    const pageElapsedMilliseconds = performance.now() - pageStartTime;
    expect(page.rows).toHaveLength(160);
    expect(page.totalRows).toBe(commitCount);

    const minimapStartTime = performance.now();
    const minimap = await engine.getMinimapBucketsAsync(
      { bucketCount: 120 },
      { chunkSize: 1_024, yieldControl: () => Promise.resolve() },
    );
    const minimapElapsedMilliseconds = performance.now() - minimapStartTime;
    const heapGrowthBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBeforeBytes,
    );

    expect(minimap).toHaveLength(120);
    expect(pageElapsedMilliseconds).toBeLessThanOrEqual(2_000);
    expect(minimapElapsedMilliseconds).toBeLessThanOrEqual(2_000);
    expect(heapGrowthBytes).toBeLessThan(256 * 1024 * 1024);
  }, 20_000);

  it("pages the complete 100k graph without cursor rescans", async () => {
    const commitCount = 100_000;
    const engine = new CommitGraphQueryEngine(
      { commits: createGraphCommits(commitCount), references: [] },
      { maxCommitCount: commitCount, maxRowCount: commitCount },
    );
    const pageSize = 160;
    let cursor: GraphCursor | undefined;
    let loadedRowCount = 0;
    let pageCount = 0;
    const pagingStartTime = performance.now();
    do {
      const page = await engine.queryAsync(
        {
          pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { chunkSize: 256, yieldControl: () => Promise.resolve() },
      );
      loadedRowCount += page.rows.length;
      pageCount += 1;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (pageCount <= Math.ceil(commitCount / pageSize) + 1);

    expect(loadedRowCount).toBe(commitCount);
    expect(pageCount).toBe(Math.ceil(commitCount / pageSize));
    expect(cursor).toBeUndefined();
    expect(performance.now() - pagingStartTime).toBeLessThanOrEqual(5_000);
  }, 20_000);

  it("bounds host layout retention for a deep cursor page", async () => {
    const commitCount = 50_000;
    const engine = new CommitGraphQueryEngine(
      { commits: createGraphCommits(commitCount), references: [] },
      { maxCommitCount: commitCount, maxRowCount: commitCount },
    );
    const asyncOptions = {
      chunkSize: 1_024,
      yieldControl: () => Promise.resolve(),
    };
    const firstPage = await engine.queryAsync({ pageSize: 1 }, asyncOptions);
    const deepRowOffset = commitCount - 160;
    const deepPageStartTime = performance.now();
    const deepPage = await engine.queryAsync(
      {
        pageSize: 160,
        cursor: {
          snapshotKey: firstPage.snapshotKey,
          rowOffset: deepRowOffset,
        },
      },
      asyncOptions,
    );
    const deepPageElapsedMilliseconds = performance.now() - deepPageStartTime;
    const layoutBuilder = (
      engine as unknown as {
        readonly incrementalLayoutBuilder: {
          readonly retainedRowCount: number;
        };
      }
    ).incrementalLayoutBuilder;

    expect(deepPage.rows).toHaveLength(160);
    expect(deepPage.rows[0]?.kind).toBe("commit");
    expect(
      deepPage.rows[0]?.kind === "commit" && deepPage.rows[0].commitSha,
    ).toBe(deepRowOffset.toString(16).padStart(40, "0"));
    expect(layoutBuilder.retainedRowCount).toBeLessThanOrEqual(
      graphLayoutRetainedRowLimit,
    );
    expect(deepPageElapsedMilliseconds).toBeLessThanOrEqual(2_000);
  }, 20_000);
});
