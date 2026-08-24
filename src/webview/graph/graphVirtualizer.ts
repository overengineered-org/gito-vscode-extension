import type {
  GraphChangedLineMetricsMessage,
  GraphPageMessage,
  GraphRowMessage,
} from "../../protocol/graphExperienceProtocol.js";

export const graphRowHeight = 48;
export const graphVirtualOverscan = 8;
export const graphVirtualDomLimit = 80;
/**
 * Keep the webview cache independent from the host's 500k-row safety cap.
 *
 * A page is 160 rows in the graph experience, so this retains roughly 25
 * pages around the active forward cursor. Older pages are replayed from the
 * query head when keyboard navigation or a minimap jump needs them again.
 */
export const graphRowStoreRetainedRowLimit = 4_096;
/** Matches the host's bounded metrics result budget. */
export const graphMetricsCacheLimit = 2_048;

export interface GraphVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topOffset: number;
  readonly bottomOffset: number;
}

export interface GraphRowStoreRetainedRange {
  /** Inclusive lowest row index retained by the bounded row store. */
  readonly startIndex: number;
  /** Exclusive upper bound of the retained row index range. */
  readonly endIndex: number;
}

/**
 * Indexed page state for the graph webview.
 *
 * Pages arrive in row order during normal scrolling. Keeping that hot path as
 * map inserts plus an append avoids rebuilding and sorting every previously
 * loaded row for each page. A bounded fallback handles retries/out-of-order
 * messages without weakening correctness.
 */
export class GraphRowStore {
  private readonly rowByIndex = new Map<number, GraphRowMessage>();
  private retainedRowIndexRanges: GraphRowStoreRetainedRange[] = [];

  public constructor(
    private readonly retainedRowLimit = graphRowStoreRetainedRowLimit,
  ) {
    if (!Number.isInteger(retainedRowLimit) || retainedRowLimit < 1)
      throw new RangeError("retainedRowLimit must be a positive integer.");
  }

  public get size(): number {
    return this.rowByIndex.size;
  }

  public get retainedRange(): GraphRowStoreRetainedRange | undefined {
    return this.retainedRowIndexRanges[0];
  }

  /** Contiguous intervals retained after out-of-order direct page replays. */
  public get retainedRanges(): readonly GraphRowStoreRetainedRange[] {
    return this.retainedRowIndexRanges;
  }

  public clear(): void {
    this.rowByIndex.clear();
    this.retainedRowIndexRanges = [];
  }

  public appendPage(page: GraphPageMessage): void {
    for (const row of page.rows) {
      const previousRow = this.rowByIndex.get(row.rowIndex);
      if (previousRow !== undefined) {
        if (previousRow !== row) this.rowByIndex.set(row.rowIndex, row);
        continue;
      }
      this.rowByIndex.set(row.rowIndex, row);
      this.recordRetainedRowIndex(row.rowIndex);
    }
    this.trimToRetainedRowLimit();
  }

  public get(rowIndex: number): GraphRowMessage | undefined {
    return this.rowByIndex.get(rowIndex);
  }

  /** Reads only the bounded viewport window, never scans all loaded pages. */
  public getWindow(startIndex: number, endIndex: number): GraphRowMessage[] {
    const boundedStartIndex = Math.max(0, Math.floor(startIndex));
    const boundedEndIndex = Math.max(boundedStartIndex, Math.floor(endIndex));
    const visibleRows: GraphRowMessage[] = [];
    for (
      let rowIndex = boundedStartIndex;
      rowIndex < boundedEndIndex;
      rowIndex += 1
    ) {
      const row = this.rowByIndex.get(rowIndex);
      if (row !== undefined) visibleRows.push(row);
    }
    return visibleRows;
  }

  private trimToRetainedRowLimit(): void {
    while (this.rowByIndex.size > this.retainedRowLimit) {
      const oldestRowIndex = this.rowByIndex.keys().next().value;
      if (typeof oldestRowIndex !== "number") return;
      this.rowByIndex.delete(oldestRowIndex);
      this.removeRetainedRowIndex(oldestRowIndex);
    }
  }

  private recordRetainedRowIndex(rowIndex: number): void {
    for (
      let rangeIndex = 0;
      rangeIndex < this.retainedRowIndexRanges.length;
      rangeIndex += 1
    ) {
      const retainedRange = this.retainedRowIndexRanges[rangeIndex]!;
      if (rowIndex < retainedRange.startIndex) {
        if (rowIndex + 1 === retainedRange.startIndex) {
          this.retainedRowIndexRanges[rangeIndex] = {
            startIndex: rowIndex,
            endIndex: retainedRange.endIndex,
          };
        } else {
          this.retainedRowIndexRanges.splice(rangeIndex, 0, {
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          });
        }
        return;
      }
      if (rowIndex < retainedRange.endIndex) return;
      if (rowIndex !== retainedRange.endIndex) continue;

      const nextRange = this.retainedRowIndexRanges[rangeIndex + 1];
      this.retainedRowIndexRanges[rangeIndex] = {
        startIndex: retainedRange.startIndex,
        endIndex:
          nextRange?.startIndex === rowIndex + 1
            ? nextRange.endIndex
            : rowIndex + 1,
      };
      if (nextRange?.startIndex === rowIndex + 1)
        this.retainedRowIndexRanges.splice(rangeIndex + 1, 1);
      return;
    }
    this.retainedRowIndexRanges.push({
      startIndex: rowIndex,
      endIndex: rowIndex + 1,
    });
  }

  private removeRetainedRowIndex(rowIndex: number): void {
    const retainedRangeIndex = this.retainedRowIndexRanges.findIndex(
      (retainedRange) =>
        rowIndex >= retainedRange.startIndex &&
        rowIndex < retainedRange.endIndex,
    );
    if (retainedRangeIndex === -1) return;

    const retainedRange = this.retainedRowIndexRanges[retainedRangeIndex]!;
    if (retainedRange.endIndex === retainedRange.startIndex + 1) {
      this.retainedRowIndexRanges.splice(retainedRangeIndex, 1);
      return;
    }
    if (rowIndex === retainedRange.startIndex) {
      this.retainedRowIndexRanges[retainedRangeIndex] = {
        startIndex: rowIndex + 1,
        endIndex: retainedRange.endIndex,
      };
      return;
    }
    if (rowIndex === retainedRange.endIndex - 1) {
      this.retainedRowIndexRanges[retainedRangeIndex] = {
        startIndex: retainedRange.startIndex,
        endIndex: rowIndex,
      };
      return;
    }
    this.retainedRowIndexRanges.splice(
      retainedRangeIndex,
      1,
      { startIndex: retainedRange.startIndex, endIndex: rowIndex },
      { startIndex: rowIndex + 1, endIndex: retainedRange.endIndex },
    );
  }
}

/** Adds one metrics result while retaining the newest bounded entries. */
export function addGraphMetricsToCache(
  cachedMetrics: ReadonlyMap<string, GraphChangedLineMetricsMessage>,
  nextMetrics: GraphChangedLineMetricsMessage,
  cacheLimit = graphMetricsCacheLimit,
): ReadonlyMap<string, GraphChangedLineMetricsMessage> {
  if (!Number.isInteger(cacheLimit) || cacheLimit < 1)
    throw new RangeError("cacheLimit must be a positive integer.");
  const nextCachedMetrics = new Map(cachedMetrics);
  nextCachedMetrics.delete(nextMetrics.commitSha);
  nextCachedMetrics.set(nextMetrics.commitSha, nextMetrics);
  while (nextCachedMetrics.size > cacheLimit) {
    const oldestCommitSha = nextCachedMetrics.keys().next().value;
    if (typeof oldestCommitSha !== "string") break;
    nextCachedMetrics.delete(oldestCommitSha);
  }
  return nextCachedMetrics;
}

/** Calculates a bounded DOM window without measuring every row. */
export function calculateGraphVirtualWindow(
  totalRows: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = graphRowHeight,
  overscan = graphVirtualOverscan,
): GraphVirtualWindow {
  const boundedTotalRows = Math.max(0, Math.floor(totalRows));
  const boundedRowHeight = Math.max(1, rowHeight);
  const boundedScrollTop = Math.max(0, scrollTop);
  const boundedViewportHeight = Math.max(1, viewportHeight);
  const firstVisibleIndex = Math.min(
    boundedTotalRows,
    Math.floor(boundedScrollTop / boundedRowHeight),
  );
  const visibleRowCount = Math.ceil(boundedViewportHeight / boundedRowHeight);
  const startIndex = Math.max(0, firstVisibleIndex - Math.max(0, overscan));
  const requestedEndIndex = Math.min(
    boundedTotalRows,
    firstVisibleIndex + visibleRowCount + Math.max(0, overscan),
  );
  const endIndex = Math.min(
    boundedTotalRows,
    Math.max(startIndex, startIndex + graphVirtualDomLimit, requestedEndIndex),
  );
  return {
    startIndex,
    endIndex,
    topOffset: startIndex * boundedRowHeight,
    bottomOffset: Math.max(0, (boundedTotalRows - endIndex) * boundedRowHeight),
  };
}

export function findGraphRow(
  rows: readonly GraphRowMessage[],
  rowIndex: number,
): GraphRowMessage | undefined {
  return rows.find((row) => row.rowIndex === rowIndex);
}

export function formatShortSha(commitSha: string): string {
  return commitSha.slice(0, 8);
}

export function formatGraphDate(dateValue: string | undefined): string {
  if (dateValue === undefined) return "Date unavailable";
  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.valueOf())) return dateValue;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsedDate);
}
