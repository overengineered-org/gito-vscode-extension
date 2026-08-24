import { describe, expect, it } from "vitest";

import {
  addGraphMetricsToCache,
  calculateGraphVirtualWindow,
  graphMetricsCacheLimit,
  graphVirtualDomLimit,
  GraphRowStore,
} from "../../../src/webview/graph/graphVirtualizer.js";
import type { GraphChangedLineMetricsMessage } from "../../../src/protocol/graphExperienceProtocol.js";

function row(rowIndex: number) {
  return {
    kind: "commit" as const,
    rowIndex,
    commitSha: `${rowIndex}`.padStart(40, "0"),
    parents: [],
    lanes: [],
    nextLanes: [],
    edges: [],
    references: [],
  };
}

describe("graph virtualizer", () => {
  it("keeps the rendered window bounded for a 100k-row graph", () => {
    const virtualWindow = calculateGraphVirtualWindow(100_000, 2_400_000, 720);
    expect(virtualWindow.startIndex).toBeGreaterThan(0);
    expect(
      virtualWindow.endIndex - virtualWindow.startIndex,
    ).toBeLessThanOrEqual(graphVirtualDomLimit);
    expect(virtualWindow.bottomOffset).toBeGreaterThan(0);
  });

  it("clamps negative scroll and empty graphs", () => {
    expect(calculateGraphVirtualWindow(0, -100, 0)).toEqual({
      startIndex: 0,
      endIndex: 0,
      topOffset: 0,
      bottomOffset: 0,
    });
  });

  it("evicts the oldest rows at the configured retention boundary", () => {
    const rowStore = new GraphRowStore(3);
    rowStore.appendPage({
      rows: [row(0), row(1)],
      hasMore: true,
      totalRows: 5,
      totalCommits: 5,
      truncated: false,
      snapshotKey: "bounded",
    });
    rowStore.appendPage({
      rows: [row(2), row(3), row(4)],
      hasMore: false,
      totalRows: 5,
      totalCommits: 5,
      truncated: false,
      snapshotKey: "bounded",
    });
    expect(rowStore.size).toBe(3);
    expect(rowStore.retainedRange).toEqual({ startIndex: 2, endIndex: 5 });
    expect(rowStore.get(0)).toBeUndefined();
    expect(rowStore.getWindow(2, 5).map((nextRow) => nextRow.rowIndex)).toEqual(
      [2, 3, 4],
    );
  });

  it("reports contiguous ranges after a direct out-of-order replay", () => {
    const rowStore = new GraphRowStore(5);
    rowStore.appendPage({
      rows: [row(0), row(1)],
      hasMore: true,
      totalRows: 6,
      totalCommits: 6,
      truncated: false,
      snapshotKey: "bounded",
    });
    rowStore.appendPage({
      rows: [row(4), row(5)],
      hasMore: false,
      totalRows: 6,
      totalCommits: 6,
      truncated: false,
      snapshotKey: "bounded",
    });
    expect(rowStore.retainedRanges).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 4, endIndex: 6 },
    ]);
  });

  it("keeps exact ranges when insertion-order eviction splits a range", () => {
    const rowStore = new GraphRowStore(3);
    rowStore.appendPage({
      rows: [row(0), row(2), row(1)],
      hasMore: true,
      totalRows: 5,
      totalCommits: 5,
      truncated: false,
      snapshotKey: "bounded",
    });
    rowStore.appendPage({
      rows: [row(3), row(4)],
      hasMore: false,
      totalRows: 5,
      totalCommits: 5,
      truncated: false,
      snapshotKey: "bounded",
    });
    expect(rowStore.retainedRanges).toEqual([
      { startIndex: 1, endIndex: 2 },
      { startIndex: 3, endIndex: 5 },
    ]);
  });

  it("caps metrics while refreshing an existing entry as newest", () => {
    const initialMetrics = new Map<string, GraphChangedLineMetricsMessage>();
    for (
      let metricsIndex = 0;
      metricsIndex < graphMetricsCacheLimit;
      metricsIndex += 1
    )
      initialMetrics.set(`${metricsIndex}`, {
        commitSha: `${metricsIndex}`,
        additions: metricsIndex,
        deletions: 0,
        changedFileCount: 1,
        binaryFileCount: 0,
      });
    const refreshedMetrics = addGraphMetricsToCache(initialMetrics, {
      commitSha: "0",
      additions: 999,
      deletions: 1,
      changedFileCount: 2,
      binaryFileCount: 0,
    });
    const boundedMetrics = addGraphMetricsToCache(refreshedMetrics, {
      commitSha: "newest",
      additions: 1,
      deletions: 1,
      changedFileCount: 1,
      binaryFileCount: 0,
    });
    expect(boundedMetrics.size).toBe(graphMetricsCacheLimit);
    expect(boundedMetrics.get("0")?.additions).toBe(999);
    expect(boundedMetrics.has("1")).toBe(false);
    expect(boundedMetrics.has("newest")).toBe(true);
  });
});
