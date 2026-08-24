import { describe, expect, it } from "vitest";
import { CommitGraphQueryEngine } from "../../../src/extension/graph/index.js";

describe("commit graph bounded performance", () => {
  it("keeps repeated 100k graph page p95 within the host budget", async () => {
    const commitCount = 100_000;
    const commits = Array.from({ length: commitCount }, (_, commitIndex) => {
      const sha = commitIndex.toString(16).padStart(40, "0");
      const parentSha =
        commitIndex === commitCount - 1
          ? undefined
          : (commitIndex + 1).toString(16).padStart(40, "0");
      return {
        sha,
        parents: parentSha === undefined ? [] : [parentSha],
        subject: `commit ${commitIndex}`,
      };
    });
    const heapBefore = process.memoryUsage().heapUsed;
    const engine = new CommitGraphQueryEngine(
      {
        commits,
        references: [
          { name: "HEAD", targetSha: commits[0]!.sha, isHead: true },
        ],
      },
      { maxCommitCount: commitCount, maxRowCount: commitCount + 1 },
    );
    const warmupPage = await engine.queryAsync({ pageSize: 100 });
    expect(warmupPage.rows).toHaveLength(100);
    const elapsedMillisecondsSamples: number[] = [];
    let sampledPage = warmupPage;
    for (let sampleIndex = 0; sampleIndex < 7; sampleIndex += 1) {
      const startTime = performance.now();
      sampledPage = await engine.queryAsync({
        pageSize: 100,
        filter: { text: "commit 9" },
      });
      elapsedMillisecondsSamples.push(performance.now() - startTime);
    }
    const sortedSamples = [...elapsedMillisecondsSamples].sort(
      (left, right) => left - right,
    );
    const p95SampleIndex = Math.min(
      sortedSamples.length - 1,
      Math.ceil(sortedSamples.length * 0.95) - 1,
    );
    const p95Milliseconds =
      sortedSamples[p95SampleIndex] ?? Number.POSITIVE_INFINITY;
    const heapGrowthBytes = process.memoryUsage().heapUsed - heapBefore;

    expect(sampledPage.rows).toHaveLength(100);
    expect(sampledPage.totalCommits).toBe(commitCount);
    expect(sampledPage.totalRows).toBeGreaterThan(100);
    expect(sampledPage.truncated).toBe(false);
    expect(sampledPage.nextCursor).toBeDefined();
    expect(engine.getMinimapBuckets({ bucketCount: 100 })).toHaveLength(100);
    expect(p95Milliseconds).toBeLessThan(1_500);
    expect(heapGrowthBytes).toBeLessThan(256 * 1024 * 1024);
  }, 20_000);
});
