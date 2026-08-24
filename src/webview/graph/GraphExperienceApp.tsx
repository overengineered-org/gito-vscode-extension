import { Fragment } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import {
  graphExtensionToWebviewMessageSchema,
  graphWebviewToExtensionMessageSchema,
  gitoProtocolVersion,
  type GraphChangedLineMetricsMessage,
  type GraphFilterMessage,
  type GraphMinimapBucketMessage,
  type GraphRowMessage,
  type GraphSummaryMessage,
  type GraphWebviewToExtensionMessage,
} from "../../protocol/graphExperienceProtocol.js";
import { vscodeWebviewApi } from "../vscodeApi.js";
import {
  getCommitSubjectLabel,
  getGraphRowDomId,
  GraphRow,
} from "./GraphRow.js";
import {
  addGraphMetricsToCache,
  calculateGraphVirtualWindow,
  formatGraphDate,
  formatShortSha,
  graphMetricsCacheLimit,
  graphRowHeight,
  graphVirtualOverscan,
  GraphRowStore,
} from "./graphVirtualizer.js";

const initialFilter: GraphFilterMessage = { scope: "all" };
const graphLayoutStyleElementId = "gito-graph-layout-style";
const graphQueryPageSize = 160;
export const graphSearchDebounceMilliseconds = 200;

function postGraphMessage(message: GraphWebviewToExtensionMessage): void {
  const parsedMessage = graphWebviewToExtensionMessageSchema.safeParse(message);
  if (parsedMessage.success) vscodeWebviewApi.postMessage(parsedMessage.data);
}

function isCommitRow(
  row: GraphRowMessage | undefined,
): row is Extract<GraphRowMessage, { kind: "commit" }> {
  return row?.kind === "commit";
}

function graphFilterFromState(
  scope: GraphFilterMessage["scope"],
  text: string,
): GraphFilterMessage {
  const normalizedText = text.trim();
  return {
    scope: scope ?? "all",
    ...(normalizedText.length === 0 ? {} : { text: normalizedText }),
  };
}

function readGraphScope(scopeValue: string): GraphFilterMessage["scope"] {
  if (
    scopeValue === "current" ||
    scopeValue === "local" ||
    scopeValue === "remote" ||
    scopeValue === "tags" ||
    scopeValue === "stashes" ||
    scopeValue === "worktrees"
  )
    return scopeValue;
  return "all";
}

function readGraphCursorRowOffset(
  cursor: string | undefined,
): number | undefined {
  if (cursor === undefined) return undefined;
  const separatorIndex = cursor.lastIndexOf(":");
  if (separatorIndex < 0) return undefined;
  const rowOffset = Number(cursor.slice(separatorIndex + 1));
  return Number.isInteger(rowOffset) && rowOffset >= 0 ? rowOffset : undefined;
}

function supportsLocalBranchStatus(referenceName: string): boolean {
  return referenceName.startsWith("refs/heads/");
}

interface GraphDetailsPanelProps {
  readonly selectedRow: GraphRowMessage | undefined;
  readonly metrics: GraphChangedLineMetricsMessage | undefined;
  readonly metricsLoading: boolean;
  readonly metricsError: string | undefined;
  readonly actionError: string | undefined;
  readonly onAction: (
    action:
      | "openCommit"
      | "openDiff"
      | "compareWithParent"
      | "checkoutReference"
      | "showBranchStatus",
    target: {
      readonly commitSha?: string;
      readonly parentSha?: string;
      readonly referenceName?: string;
    },
  ) => void;
}

function GraphDetailsPanel({
  selectedRow,
  metrics,
  metricsLoading,
  metricsError,
  actionError,
  onAction,
}: GraphDetailsPanelProps) {
  const selectedCommit = isCommitRow(selectedRow) ? selectedRow : undefined;
  return (
    <aside class="graph-details" aria-label="Commit details and actions">
      <div class="graph-details-heading">
        <span>Details</span>
        {selectedCommit ? (
          <span>{formatShortSha(selectedCommit.commitSha)}</span>
        ) : null}
      </div>
      <div class="graph-details-body">
        {selectedCommit === undefined ? (
          <p class="graph-details-empty">
            Select a commit to inspect metadata, changed lines, and next
            actions.
          </p>
        ) : (
          <>
            <div>
              <h2 class="graph-details-title">
                {getCommitSubjectLabel(selectedCommit.subject)}
              </h2>
              <p class="graph-details-sha">{selectedCommit.commitSha}</p>
            </div>
            <dl class="graph-details-meta">
              <div>
                <dt>Author</dt>
                <dd>{selectedCommit.authorName ?? "Unknown author"}</dd>
              </div>
              <div>
                <dt>Committed</dt>
                <dd>
                  {formatGraphDate(
                    selectedCommit.commitDate ?? selectedCommit.authorDate,
                  )}
                </dd>
              </div>
            </dl>
            <div
              class="graph-metrics"
              aria-label="Changed line metrics"
              aria-busy={metricsLoading}
            >
              <div class="graph-metric">
                <span class="graph-metric-value">
                  {metricsLoading ? "…" : (metrics?.additions ?? "—")}
                </span>
                <span class="graph-metric-label">Added</span>
              </div>
              <div class="graph-metric">
                <span class="graph-metric-value">
                  {metricsLoading ? "…" : (metrics?.deletions ?? "—")}
                </span>
                <span class="graph-metric-label">Removed</span>
              </div>
              <div class="graph-metric">
                <span class="graph-metric-value">
                  {metricsLoading ? "…" : (metrics?.changedFileCount ?? "—")}
                </span>
                <span class="graph-metric-label">Files</span>
              </div>
            </div>
            {metricsError !== undefined ? (
              <p class="graph-details-error" role="alert">
                {metricsError}
              </p>
            ) : null}
            {actionError !== undefined ? (
              <p class="graph-details-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div class="graph-action-list" aria-label="Commit actions">
              <button
                class="graph-action-button graph-action-primary"
                onClick={() =>
                  onAction("openCommit", {
                    commitSha: selectedCommit.commitSha,
                  })
                }
                type="button"
              >
                <span>Open commit</span>
                <span aria-hidden="true" class="codicon codicon-arrow-right" />
              </button>
              <button
                class="graph-action-button"
                onClick={() =>
                  onAction("openDiff", { commitSha: selectedCommit.commitSha })
                }
                type="button"
              >
                <span>Open diff</span>
                <span aria-hidden="true" class="codicon codicon-arrow-right" />
              </button>
              <button
                class="graph-action-button"
                disabled={selectedCommit.parents.length === 0}
                {...(selectedCommit.parents.length === 0
                  ? { "aria-describedby": "graph-compare-parent-help" }
                  : {})}
                onClick={() =>
                  onAction("compareWithParent", {
                    commitSha: selectedCommit.commitSha,
                    ...(selectedCommit.parents[0] === undefined
                      ? {}
                      : { parentSha: selectedCommit.parents[0] }),
                  })
                }
                type="button"
              >
                <span>Compare with parent</span>
                <span aria-hidden="true" class="codicon codicon-arrow-right" />
              </button>
              {selectedCommit.parents.length === 0 ? (
                <p class="sr-only" id="graph-compare-parent-help">
                  This root commit has no parent to compare.
                </p>
              ) : null}
            </div>
            {selectedCommit.references.length > 0 ? (
              <div class="graph-action-list" aria-label="Reference actions">
                <p class="sr-only" id="graph-checkout-reference-help">
                  Checkout changes the current branch or opens a detached
                  commit. Workspace trust may be requested; cancelling leaves
                  the repository unchanged.
                </p>
                <p class="sr-only" id="graph-head-checkout-help">
                  HEAD is already checked out and cannot be checked out again.
                </p>
                {selectedCommit.references.slice(0, 4).map((reference) => {
                  const referenceIsHead =
                    reference.isHead === true || reference.name === "HEAD";
                  const referenceSupportsBranchStatus =
                    supportsLocalBranchStatus(reference.name);
                  return (
                    <Fragment key={reference.name}>
                      {referenceSupportsBranchStatus ? (
                        <button
                          class="graph-action-button"
                          onClick={() =>
                            onAction("showBranchStatus", {
                              referenceName: reference.name,
                            })
                          }
                          type="button"
                        >
                          <span>
                            Show{" "}
                            {reference.name.replace(
                              /^refs\/(heads|remotes)\//u,
                              "",
                            )}
                          </span>
                          <span
                            aria-hidden="true"
                            class="codicon codicon-info"
                          />
                        </button>
                      ) : null}
                      <button
                        aria-describedby={
                          referenceIsHead
                            ? "graph-head-checkout-help"
                            : "graph-checkout-reference-help"
                        }
                        class="graph-action-button"
                        disabled={referenceIsHead}
                        onClick={() =>
                          onAction("checkoutReference", {
                            referenceName: reference.name,
                          })
                        }
                        type="button"
                      >
                        <span>
                          Checkout{" "}
                          {reference.name.replace(
                            /^refs\/(heads|remotes)\//u,
                            "",
                          )}
                        </span>
                        <span
                          aria-hidden="true"
                          class="codicon codicon-git-branch"
                        />
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

interface GraphMinimapProps {
  readonly available: boolean;
  readonly buckets: readonly GraphMinimapBucketMessage[];
  readonly error: string | undefined;
  readonly selectedRowIndex: number | undefined;
  readonly onJump: (rowIndex: number) => void;
  readonly onRetry: () => void;
}

function GraphMinimap({
  available,
  buckets,
  error,
  selectedRowIndex,
  onJump,
  onRetry,
}: GraphMinimapProps) {
  const visibleBuckets = available ? buckets : [];
  return (
    <aside class="graph-minimap" aria-label="Commit graph minimap">
      <div class="graph-minimap-heading">
        <span>Map</span>
        <span>
          {visibleBuckets.length > 0 ? `${visibleBuckets.length} ranges` : "—"}
        </span>
      </div>
      <div class="graph-minimap-markers">
        {error !== undefined ? (
          <div class="graph-minimap-error" role="alert">
            <p>{error}</p>
            <button onClick={onRetry} type="button">
              Retry minimap
            </button>
          </div>
        ) : null}
        {error === undefined
          ? visibleBuckets.map((bucket) => {
              const isSelected =
                selectedRowIndex !== undefined &&
                selectedRowIndex >= bucket.startRow &&
                selectedRowIndex <= bucket.endRow;
              const strongestColorIndex = bucket.colorCounts.reduce(
                (currentColorIndex, colorCount, colorIndex, colorCounts) =>
                  colorCount > (colorCounts[currentColorIndex] ?? 0)
                    ? colorIndex
                    : currentColorIndex,
                0,
              );
              return (
                <button
                  aria-label={`Jump to commits ${bucket.startRow + 1} to ${bucket.endRow + 1}`}
                  class={`graph-minimap-marker${isSelected ? " is-selected" : ""}`}
                  key={bucket.bucketIndex}
                  onClick={() => onJump(bucket.startRow)}
                  type="button"
                >
                  <span class="graph-minimap-lines" aria-hidden="true">
                    {Array.from({
                      length: Math.min(
                        6,
                        Math.max(1, bucket.commitCount > 0 ? 1 : 0),
                      ),
                    }).map((_, lineIndex) => (
                      <span
                        class={`graph-minimap-line graph-lane-color-${strongestColorIndex % 12}${bucket.mergeCount > 0 && lineIndex === 0 ? " is-merge" : ""}`}
                        key={lineIndex}
                      />
                    ))}
                  </span>
                  <span class="graph-minimap-count">{bucket.commitCount}</span>
                </button>
              );
            })
          : null}
        {error === undefined && visibleBuckets.length === 0 ? (
          <p class="graph-details-empty">
            {available
              ? "Minimap appears after graph data loads."
              : "Minimap loading for the current graph."}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

export function GraphExperienceApp() {
  const [summary, setSummary] = useState<GraphSummaryMessage | undefined>(
    undefined,
  );
  const [rowStoreRevision, setRowStoreRevision] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<GraphFilterMessage["scope"]>(
    initialFilter.scope,
  );
  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const [includeWip, setIncludeWip] = useState(true);
  const [includeWorktrees, setIncludeWorktrees] = useState(true);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | undefined>(
    undefined,
  );
  const [minimapBuckets, setMinimapBuckets] = useState<
    readonly GraphMinimapBucketMessage[]
  >([]);
  const [minimapAvailable, setMinimapAvailable] = useState(false);
  const [minimapError, setMinimapError] = useState<string | undefined>(
    undefined,
  );
  const [metricsByCommitSha, setMetricsByCommitSha] = useState<
    ReadonlyMap<string, GraphChangedLineMetricsMessage>
  >(new Map());
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | undefined>(
    undefined,
  );
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("Loading commit graph.");
  const [queryRetryToken, setQueryRetryToken] = useState(0);
  const [minimapRetryToken, setMinimapRetryToken] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const requestIdReference = useRef(0);
  const activeQueryRequestIdReference = useRef(-1);
  const activeMinimapRequestIdReference = useRef(-1);
  const activeMetricsRequestIdReference = useRef(-1);
  const activeActionRequestIdReference = useRef(-1);
  const summaryRequestPendingReference = useRef(false);
  const graphTreegridReference = useRef<HTMLDivElement | null>(null);
  const scrollRegionReference = useRef<HTMLDivElement | null>(null);
  const rowReferences = useRef(new Map<number, HTMLDivElement>());
  const rowStoreReference = useRef(new GraphRowStore());
  const graphGenerationReference = useRef(0);
  const activeMinimapQueryKeyReference = useRef<string | undefined>(undefined);
  const loadedMinimapQueryKeyReference = useRef<string | undefined>(undefined);
  const snapshotKeyReference = useRef<string | undefined>(undefined);
  const selectedRowIndexReference = useRef<number | undefined>(undefined);
  const preservedActionAnnouncementReference = useRef<string | undefined>(
    undefined,
  );
  const refreshAfterCheckoutReference = useRef(false);
  const focusRowAfterRefreshReference = useRef<number | undefined>(undefined);
  selectedRowIndexReference.current = selectedRowIndex;

  const selectedRow = useMemo(
    () => rowStoreReference.current.get(selectedRowIndex ?? -1),
    [rowStoreRevision, selectedRowIndex],
  );
  const selectedMetrics = isCommitRow(selectedRow)
    ? metricsByCommitSha.get(selectedRow.commitSha)
    : undefined;
  const selectedActionKey =
    selectedRow === undefined
      ? undefined
      : `${selectedRow.kind}:${selectedRow.rowIndex}:${isCommitRow(selectedRow) ? selectedRow.commitSha : ""}`;
  const virtualWindow = calculateGraphVirtualWindow(
    totalRows,
    scrollTop,
    scrollRegionReference.current?.clientHeight ?? 640,
  );
  const visibleRows = rowStoreReference.current.getWindow(
    virtualWindow.startIndex,
    virtualWindow.endIndex,
  );
  const activeRowIsRendered =
    selectedRowIndex !== undefined &&
    visibleRows.some((row) => row.rowIndex === selectedRowIndex);
  const activeRowDomId = activeRowIsRendered
    ? getGraphRowDomId(selectedRowIndex)
    : undefined;
  const graphFilter = graphFilterFromState(scope, debouncedSearchText);
  const graphQueryKey = JSON.stringify({
    scope,
    searchText: debouncedSearchText,
    includeWip,
    includeWorktrees,
    queryRetryToken,
  });
  const renderedGraphGeneration = graphGenerationReference.current;
  const totalRowsReference = useRef(totalRows);
  const hasMoreReference = useRef(hasMore);
  const nextCursorReference = useRef(nextCursor);
  const isLoadingReference = useRef(isLoading);
  const graphFilterReference = useRef(graphFilter);
  const includeWipReference = useRef(includeWip);
  const includeWorktreesReference = useRef(includeWorktrees);
  const pendingJumpRowIndexReference = useRef<number | undefined>(undefined);
  const pendingFocusRowIndexReference = useRef<number | undefined>(undefined);
  const pendingVisibleRowIndexReference = useRef<number | undefined>(undefined);
  const lastRequestedCursorReference = useRef<string | undefined>(undefined);
  const graphLayoutStyleReference = useRef<HTMLStyleElement | undefined>(
    undefined,
  );
  totalRowsReference.current = totalRows;
  hasMoreReference.current = hasMore;
  nextCursorReference.current = nextCursor;
  isLoadingReference.current = isLoading;
  graphFilterReference.current = graphFilter;
  includeWipReference.current = includeWip;
  includeWorktreesReference.current = includeWorktrees;
  const isMinimapCurrent =
    minimapAvailable &&
    loadedMinimapQueryKeyReference.current === graphQueryKey;

  useEffect(() => {
    if (searchText === debouncedSearchText) return;
    const debounceTimer = window.setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, graphSearchDebounceMilliseconds);
    return () => window.clearTimeout(debounceTimer);
  }, [debouncedSearchText, searchText]);

  useEffect(() => {
    if (searchText === debouncedSearchText) return;
    const activeMinimapRequestId = activeMinimapRequestIdReference.current;
    if (activeMinimapRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: activeMinimapRequestId,
      });
    activeMinimapRequestIdReference.current = -1;
    loadedMinimapQueryKeyReference.current = undefined;
    setMinimapBuckets([]);
    setMinimapAvailable(false);
    setMinimapError(undefined);
  }, [debouncedSearchText, searchText]);

  useLayoutEffect(() => {
    const styleElement = document.createElement("style");
    styleElement.id = graphLayoutStyleElementId;
    const styleNonce = document
      .querySelector<HTMLMetaElement>('meta[name="gito-webview-style-nonce"]')
      ?.getAttribute("content");
    if (styleNonce !== undefined && styleNonce !== null)
      styleElement.setAttribute("nonce", styleNonce);
    document.head.append(styleElement);
    graphLayoutStyleReference.current = styleElement;
    return () => {
      styleElement.remove();
      if (graphLayoutStyleReference.current === styleElement)
        graphLayoutStyleReference.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    const styleElement = graphLayoutStyleReference.current;
    if (styleElement === undefined) return;
    const boundedTotalRows = Number.isFinite(totalRows)
      ? Math.max(0, Math.floor(totalRows))
      : 0;
    const boundedTopOffset = Number.isFinite(virtualWindow.topOffset)
      ? Math.max(0, Math.floor(virtualWindow.topOffset))
      : 0;
    styleElement.textContent = `#gito-graph-root .graph-scroll-content { height: ${boundedTotalRows * graphRowHeight}px; } #gito-graph-root .graph-row-window { top: ${boundedTopOffset}px; transform: translateZ(0); }`;
  }, [totalRows, virtualWindow.topOffset]);

  const restartGraphQueryFromHead = (): boolean => {
    if (activeQueryRequestIdReference.current < 0) return false;
    const previousQueryRequestId = activeQueryRequestIdReference.current;
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphCancel",
      requestId: previousQueryRequestId,
    });
    const restartedQueryRequestId = ++requestIdReference.current;
    activeQueryRequestIdReference.current = restartedQueryRequestId;
    const previousMetricsRequestId = activeMetricsRequestIdReference.current;
    if (previousMetricsRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: previousMetricsRequestId,
      });
    activeMetricsRequestIdReference.current = -1;
    graphGenerationReference.current += 1;
    rowStoreReference.current.clear();
    rowReferences.current.clear();
    lastRequestedCursorReference.current = undefined;
    snapshotKeyReference.current = undefined;
    hasMoreReference.current = false;
    nextCursorReference.current = undefined;
    isLoadingReference.current = true;
    setRowStoreRevision((currentRevision) => currentRevision + 1);
    setHasMore(false);
    setNextCursor(undefined);
    setSelectedRowIndex(undefined);
    setIsLoading(true);
    setGraphError(undefined);
    setMetricsByCommitSha(new Map());
    setMetricsLoading(false);
    setMetricsError(undefined);
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphQuery",
      requestId: restartedQueryRequestId,
      pageSize: graphQueryPageSize,
      append: false,
      filter: graphFilterReference.current,
      includeWip: includeWipReference.current,
      includeWorktrees: includeWorktreesReference.current,
    });
    return true;
  };

  const requestNextGraphPage = (): boolean => {
    const cursor = nextCursorReference.current;
    if (
      !hasMoreReference.current ||
      cursor === undefined ||
      isLoadingReference.current ||
      activeQueryRequestIdReference.current < 0
    )
      return false;
    if (cursor === lastRequestedCursorReference.current) {
      pendingJumpRowIndexReference.current = undefined;
      pendingVisibleRowIndexReference.current = undefined;
      return false;
    }
    lastRequestedCursorReference.current = cursor;
    isLoadingReference.current = true;
    setIsLoading(true);
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphQuery",
      requestId: activeQueryRequestIdReference.current,
      cursor,
      pageSize: graphQueryPageSize,
      append: true,
      filter: graphFilterReference.current,
      includeWip: includeWipReference.current,
      includeWorktrees: includeWorktreesReference.current,
    });
    return true;
  };

  /** Replays one missing jump target directly instead of draining forward pages. */
  const requestGraphPageAtRow = (targetRowIndex: number): boolean => {
    const snapshotKey = snapshotKeyReference.current;
    if (
      snapshotKey === undefined ||
      targetRowIndex < 0 ||
      targetRowIndex >= totalRowsReference.current ||
      isLoadingReference.current ||
      activeQueryRequestIdReference.current < 0
    )
      return false;
    const cursor = `${encodeURIComponent(snapshotKey)}:${targetRowIndex}`;
    if (cursor === lastRequestedCursorReference.current) return false;
    lastRequestedCursorReference.current = cursor;
    isLoadingReference.current = true;
    setIsLoading(true);
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphQuery",
      requestId: activeQueryRequestIdReference.current,
      cursor,
      pageSize: graphQueryPageSize,
      append: true,
      filter: graphFilterReference.current,
      includeWip: includeWipReference.current,
      includeWorktrees: includeWorktreesReference.current,
    });
    return true;
  };

  const pendingVisibleRowNeedsDirectReplay = (rowIndex: number): boolean => {
    const retainedRange = rowStoreReference.current.retainedRange;
    if (retainedRange !== undefined && rowIndex < retainedRange.startIndex)
      return true;
    const nextPageStartIndex = readGraphCursorRowOffset(
      nextCursorReference.current,
    );
    return (
      nextPageStartIndex === undefined ||
      rowIndex < nextPageStartIndex ||
      rowIndex >= nextPageStartIndex + graphQueryPageSize
    );
  };

  const continuePendingVisibleRowLoad = (): void => {
    const pendingRowIndex = pendingVisibleRowIndexReference.current;
    if (pendingRowIndex === undefined) return;
    if (rowStoreReference.current.get(pendingRowIndex) !== undefined) {
      pendingVisibleRowIndexReference.current = undefined;
      return;
    }
    if (pendingVisibleRowNeedsDirectReplay(pendingRowIndex)) {
      if (isLoadingReference.current) return;
      if (requestGraphPageAtRow(pendingRowIndex)) return;
      pendingVisibleRowIndexReference.current = undefined;
      setAnnouncement("The requested graph row is unavailable.");
      return;
    }
    if (
      !hasMoreReference.current ||
      nextCursorReference.current === undefined
    ) {
      restartGraphQueryFromHead();
      return;
    }
    requestNextGraphPage();
  };

  const continuePendingRowJump = (): void => {
    const pendingRowIndex = pendingJumpRowIndexReference.current;
    if (pendingRowIndex === undefined) return;
    if (rowStoreReference.current.get(pendingRowIndex) !== undefined) {
      pendingJumpRowIndexReference.current = undefined;
      pendingFocusRowIndexReference.current = pendingRowIndex;
      setSelectedRowIndex(pendingRowIndex);
      const scrollElement = scrollRegionReference.current;
      if (scrollElement !== null) {
        scrollElement.scrollTop = pendingRowIndex * graphRowHeight;
        setScrollTop(scrollElement.scrollTop);
      }
      const rowElement = rowReferences.current.get(pendingRowIndex);
      if (rowElement !== undefined)
        pendingFocusRowIndexReference.current = undefined;
      graphTreegridReference.current?.focus();
      return;
    }
    if (isLoadingReference.current) return;
    if (requestGraphPageAtRow(pendingRowIndex)) return;
    pendingJumpRowIndexReference.current = undefined;
    pendingFocusRowIndexReference.current = undefined;
    setAnnouncement("The requested graph row is unavailable.");
  };

  useLayoutEffect(() => {
    const pendingRowIndex = pendingFocusRowIndexReference.current;
    if (pendingRowIndex === undefined) return;
    const rowElement = rowReferences.current.get(pendingRowIndex);
    const graphTreegrid = graphTreegridReference.current;
    if (graphTreegrid !== null) {
      pendingFocusRowIndexReference.current = undefined;
      graphTreegrid.focus();
      return;
    }
    if (rowElement === undefined) return;
    pendingFocusRowIndexReference.current = undefined;
    rowElement.focus();
  }, [rowStoreRevision, scrollTop, selectedRowIndex]);

  useEffect(() => {
    const handleExtensionMessage = (messageEvent: MessageEvent<unknown>) => {
      const parsedMessage = graphExtensionToWebviewMessageSchema.safeParse(
        messageEvent.data,
      );
      if (!parsedMessage.success) return;
      const message = parsedMessage.data;
      if (message.messageType === "graphReady") {
        summaryRequestPendingReference.current = false;
        setSummary(message.summary);
        setGraphError(undefined);
        setAnnouncement(
          preservedActionAnnouncementReference.current ??
            `Graph ready. ${message.summary.totalCommits.toLocaleString()} commits.`,
        );
        return;
      }
      if (message.messageType === "graphPageLoaded") {
        if (message.requestId !== activeQueryRequestIdReference.current) return;
        if (!message.append) rowStoreReference.current.clear();
        rowStoreReference.current.appendPage(message.page);
        snapshotKeyReference.current = message.page.snapshotKey;
        setRowStoreRevision((currentRevision) => currentRevision + 1);
        setTotalRows(message.page.totalRows);
        setHasMore(message.page.hasMore);
        const nextPageCursor =
          message.page.nextCursor === undefined
            ? undefined
            : `${encodeURIComponent(message.page.nextCursor.snapshotKey)}:${message.page.nextCursor.rowOffset}`;
        hasMoreReference.current = message.page.hasMore;
        nextCursorReference.current = nextPageCursor;
        setNextCursor(nextPageCursor);
        isLoadingReference.current = false;
        setIsLoading(false);
        setGraphError(undefined);
        setAnnouncement(
          preservedActionAnnouncementReference.current ??
            `${message.page.totalCommits.toLocaleString()} commits in graph${message.page.truncated ? "; safety cap reached" : ""}.`,
        );
        if (message.page.rows[0] !== undefined)
          setSelectedRowIndex((currentSelectedRowIndex) =>
            currentSelectedRowIndex === undefined
              ? message.page.rows[0]!.rowIndex
              : currentSelectedRowIndex,
          );
        continuePendingRowJump();
        if (pendingJumpRowIndexReference.current === undefined)
          continuePendingVisibleRowLoad();
        return;
      }
      if (message.messageType === "graphMinimapLoaded") {
        if (message.requestId !== activeMinimapRequestIdReference.current)
          return;
        loadedMinimapQueryKeyReference.current =
          activeMinimapQueryKeyReference.current;
        setMinimapBuckets(message.buckets);
        setMinimapAvailable(true);
        setMinimapError(undefined);
        return;
      }
      if (message.messageType === "graphMetricsLoaded") {
        if (message.requestId !== activeMetricsRequestIdReference.current)
          return;
        setMetricsLoading(false);
        setMetricsError(undefined);
        if (message.metrics !== null) {
          setMetricsByCommitSha((currentMetrics) => {
            return addGraphMetricsToCache(
              currentMetrics,
              message.metrics!,
              graphMetricsCacheLimit,
            );
          });
        }
        return;
      }
      if (message.messageType === "graphActionCompleted") {
        if (message.requestId !== activeActionRequestIdReference.current)
          return;
        setActionError(undefined);
        preservedActionAnnouncementReference.current =
          message.action === "checkoutReference"
            ? message.announcement
            : undefined;
        setAnnouncement(message.announcement);
        if (message.action === "checkoutReference") {
          refreshAfterCheckoutReference.current = true;
          focusRowAfterRefreshReference.current =
            selectedRowIndexReference.current;
          summaryRequestPendingReference.current = true;
          setQueryRetryToken((currentToken) => currentToken + 1);
          postGraphMessage({
            protocolVersion: gitoProtocolVersion,
            messageType: "graphReady",
          });
        }
        return;
      }
      if (message.messageType === "graphOperationFailed") {
        const operation =
          message.operation ??
          (message.requestId === undefined
            ? "summary"
            : message.requestId === activeQueryRequestIdReference.current
              ? "query"
              : message.requestId === activeMinimapRequestIdReference.current
                ? "minimap"
                : message.requestId === activeMetricsRequestIdReference.current
                  ? "metrics"
                  : message.requestId === activeActionRequestIdReference.current
                    ? "action"
                    : undefined);
        if (operation === undefined) return;
        const operationIsCurrent =
          operation === "summary"
            ? message.requestId === undefined &&
              summaryRequestPendingReference.current
            : message.requestId ===
              (operation === "query"
                ? activeQueryRequestIdReference.current
                : operation === "minimap"
                  ? activeMinimapRequestIdReference.current
                  : operation === "metrics"
                    ? activeMetricsRequestIdReference.current
                    : activeActionRequestIdReference.current);
        if (!operationIsCurrent) return;
        if (operation === "metrics") {
          setMetricsLoading(false);
          setMetricsError(message.userMessage);
          setAnnouncement(`Commit metrics error: ${message.userMessage}`);
          return;
        }
        if (operation === "action") {
          setActionError(message.userMessage);
          setAnnouncement(`Graph action error: ${message.userMessage}`);
          return;
        }
        if (operation === "minimap") {
          loadedMinimapQueryKeyReference.current = undefined;
          setMinimapBuckets([]);
          setMinimapAvailable(false);
          setMinimapError(message.userMessage);
          setAnnouncement(`Graph minimap error: ${message.userMessage}`);
          return;
        }
        isLoadingReference.current = false;
        pendingJumpRowIndexReference.current = undefined;
        pendingFocusRowIndexReference.current = undefined;
        pendingVisibleRowIndexReference.current = undefined;
        setIsLoading(false);
        setGraphError(message.userMessage);
        setAnnouncement(`Graph error: ${message.userMessage}`);
        return;
      }
      return;
    };
    window.addEventListener("message", handleExtensionMessage);
    summaryRequestPendingReference.current = true;
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphReady",
    });
    return () => window.removeEventListener("message", handleExtensionMessage);
  }, []);

  useEffect(() => {
    const preserveCheckoutAnnouncement = refreshAfterCheckoutReference.current;
    refreshAfterCheckoutReference.current = false;
    if (!preserveCheckoutAnnouncement)
      preservedActionAnnouncementReference.current = undefined;
    const requestId = ++requestIdReference.current;
    const previousRequestId = activeQueryRequestIdReference.current;
    const previousMinimapRequestId = activeMinimapRequestIdReference.current;
    const previousMetricsRequestId = activeMetricsRequestIdReference.current;
    if (previousRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: previousRequestId,
      });
    if (previousMinimapRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: previousMinimapRequestId,
      });
    if (previousMetricsRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: previousMetricsRequestId,
      });
    activeMetricsRequestIdReference.current = -1;
    activeQueryRequestIdReference.current = requestId;
    graphGenerationReference.current += 1;
    rowStoreReference.current.clear();
    rowReferences.current.clear();
    setMinimapBuckets([]);
    setMinimapAvailable(false);
    setMinimapError(undefined);
    loadedMinimapQueryKeyReference.current = undefined;
    activeMinimapQueryKeyReference.current = graphQueryKey;
    hasMoreReference.current = false;
    nextCursorReference.current = undefined;
    lastRequestedCursorReference.current = undefined;
    snapshotKeyReference.current = undefined;
    isLoadingReference.current = true;
    const focusRowAfterRefresh = focusRowAfterRefreshReference.current;
    pendingJumpRowIndexReference.current = focusRowAfterRefresh;
    pendingFocusRowIndexReference.current = undefined;
    pendingVisibleRowIndexReference.current = undefined;
    focusRowAfterRefreshReference.current = undefined;
    setRowStoreRevision((currentRevision) => currentRevision + 1);
    setTotalRows(0);
    setHasMore(false);
    setNextCursor(undefined);
    setSelectedRowIndex(focusRowAfterRefresh);
    setIsLoading(true);
    setGraphError(undefined);
    setMetricsByCommitSha(new Map());
    setMetricsLoading(false);
    setMetricsError(undefined);
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphQuery",
      requestId,
      pageSize: graphQueryPageSize,
      append: false,
      filter: graphFilter,
      includeWip,
      includeWorktrees,
    });
    const minimapRequestId = ++requestIdReference.current;
    activeMinimapRequestIdReference.current = minimapRequestId;
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphMinimap",
      requestId: minimapRequestId,
      bucketCount: 96,
      filter: graphFilter,
      includeWip,
      includeWorktrees,
    });
  }, [
    scope,
    debouncedSearchText,
    includeWip,
    includeWorktrees,
    queryRetryToken,
    minimapRetryToken,
  ]);

  useEffect(() => {
    const previousActionRequestId = activeActionRequestIdReference.current;
    if (previousActionRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: previousActionRequestId,
      });
    activeActionRequestIdReference.current = -1;
    setActionError(undefined);
  }, [selectedActionKey]);

  useEffect(() => {
    if (!isCommitRow(selectedRow)) {
      setMetricsLoading(false);
      setMetricsError(undefined);
      return;
    }
    if (metricsByCommitSha.has(selectedRow.commitSha)) {
      setMetricsLoading(false);
      setMetricsError(undefined);
      return;
    }
    const requestId = ++requestIdReference.current;
    const previousRequestId = activeMetricsRequestIdReference.current;
    if (previousRequestId >= 0)
      postGraphMessage({
        protocolVersion: gitoProtocolVersion,
        messageType: "graphCancel",
        requestId: previousRequestId,
      });
    activeMetricsRequestIdReference.current = requestId;
    setMetricsLoading(true);
    setMetricsError(undefined);
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphMetrics",
      requestId,
      commitSha: selectedRow.commitSha,
    });
  }, [
    selectedRow?.kind === "commit" ? selectedRow.commitSha : undefined,
    metricsByCommitSha,
  ]);

  const requestMoreRows = (): void => {
    const pendingJumpRowIndex = pendingJumpRowIndexReference.current;
    if (pendingJumpRowIndex !== undefined) {
      if (requestGraphPageAtRow(pendingJumpRowIndex)) return;
      if (isLoadingReference.current) return;
    }
    const pendingVisibleRowIndex = pendingVisibleRowIndexReference.current;
    if (
      pendingVisibleRowIndex !== undefined &&
      pendingVisibleRowNeedsDirectReplay(pendingVisibleRowIndex)
    ) {
      if (requestGraphPageAtRow(pendingVisibleRowIndex)) return;
      if (isLoadingReference.current) return;
    }
    if (requestNextGraphPage()) return;
    if (
      !isLoadingReference.current &&
      (pendingVisibleRowIndexReference.current !== undefined ||
        pendingJumpRowIndexReference.current !== undefined)
    )
      restartGraphQueryFromHead();
  };

  const handleScroll = (event: Event): void => {
    const scrollElement = event.currentTarget;
    if (!(scrollElement instanceof HTMLElement)) return;
    const nextScrollTop = scrollElement.scrollTop;
    setScrollTop(nextScrollTop);
    const viewportHeight = Math.max(scrollElement.clientHeight, 640);
    const nextVirtualWindow = calculateGraphVirtualWindow(
      totalRows,
      nextScrollTop,
      viewportHeight,
    );
    const focusedElement = document.activeElement;
    if (focusedElement instanceof HTMLElement) {
      const focusedRow = focusedElement.closest<HTMLElement>(".graph-row");
      const focusedRowIndex = Number(focusedRow?.dataset.rowIndex);
      const focusedRowRemainsRendered =
        focusedRow !== null &&
        Number.isInteger(focusedRowIndex) &&
        focusedRowIndex >= nextVirtualWindow.startIndex &&
        focusedRowIndex < nextVirtualWindow.endIndex;
      if (focusedRow !== null && !focusedRowRemainsRendered)
        graphTreegridReference.current?.focus();
    }
    const visibleEndRowIndex = Math.min(
      totalRows - 1,
      Math.floor((nextScrollTop + viewportHeight) / graphRowHeight) +
        graphVirtualOverscan,
    );
    if (
      visibleEndRowIndex >= 0 &&
      rowStoreReference.current.get(visibleEndRowIndex) === undefined
    ) {
      pendingVisibleRowIndexReference.current = visibleEndRowIndex;
      if (!isLoadingReference.current) requestMoreRows();
    } else {
      pendingVisibleRowIndexReference.current = undefined;
    }
    const rowAtBottom = Math.floor(
      (nextScrollTop + scrollElement.clientHeight) / graphRowHeight,
    );
    if (rowAtBottom > rowStoreReference.current.size - 48) requestMoreRows();
  };

  const focusRow = (rowIndex: number, expectedGeneration: number): void => {
    if (expectedGeneration !== graphGenerationReference.current) return;
    if (rowIndex < 0 || rowIndex >= totalRows) return;
    pendingVisibleRowIndexReference.current = undefined;
    if (rowStoreReference.current.get(rowIndex) === undefined) {
      pendingJumpRowIndexReference.current = rowIndex;
      if (!isLoadingReference.current) requestMoreRows();
      return;
    }
    setSelectedRowIndex(rowIndex);
    const rowElement = rowReferences.current.get(rowIndex);
    if (rowElement === undefined) {
      const scrollElement = scrollRegionReference.current;
      if (scrollElement !== null) {
        scrollElement.scrollTop = rowIndex * graphRowHeight;
        setScrollTop(scrollElement.scrollTop);
      }
    }
    graphTreegridReference.current?.focus();
  };

  const handleRowKeyDown = (
    event: KeyboardEvent,
    row: GraphRowMessage,
  ): void => {
    if (renderedGraphGeneration !== graphGenerationReference.current) return;
    let nextRowIndex: number | undefined;
    if (event.key === "ArrowDown")
      nextRowIndex = Math.min(totalRows - 1, row.rowIndex + 1);
    else if (event.key === "ArrowUp")
      nextRowIndex = Math.max(0, row.rowIndex - 1);
    else if (event.key === "Home") nextRowIndex = 0;
    else if (event.key === "End") nextRowIndex = Math.max(0, totalRows - 1);
    else if (event.key === "Enter") {
      setSelectedRowIndex(row.rowIndex);
      return;
    }
    if (nextRowIndex === undefined || nextRowIndex === row.rowIndex) return;
    event.preventDefault();
    focusRow(nextRowIndex, renderedGraphGeneration);
  };

  const handleTreegridKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== event.currentTarget) return;
    const keyboardRow =
      (selectedRowIndex === undefined
        ? visibleRows[0]
        : rowStoreReference.current.get(selectedRowIndex)) ?? visibleRows[0];
    if (keyboardRow === undefined) return;
    handleRowKeyDown(event, keyboardRow);
  };

  const runAction = (
    action: GraphActionMessage,
    target: {
      readonly commitSha?: string;
      readonly parentSha?: string;
      readonly referenceName?: string;
    },
  ): void => {
    const requestId = ++requestIdReference.current;
    activeActionRequestIdReference.current = requestId;
    setActionError(undefined);
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphAction",
      requestId,
      action,
      ...(target.commitSha === undefined
        ? {}
        : { commitSha: target.commitSha }),
      ...(target.parentSha === undefined
        ? {}
        : { parentSha: target.parentSha }),
      ...(target.referenceName === undefined
        ? {}
        : { referenceName: target.referenceName }),
    });
  };

  const retryGraph = (): void => {
    setGraphError(undefined);
    setAnnouncement("Refreshing commit graph.");
    setIsLoading(true);
    setQueryRetryToken((currentToken) => currentToken + 1);
    summaryRequestPendingReference.current = true;
    postGraphMessage({
      protocolVersion: gitoProtocolVersion,
      messageType: "graphReady",
    });
  };

  const retryMinimap = (): void => {
    setMinimapError(undefined);
    setAnnouncement("Refreshing graph minimap.");
    setMinimapRetryToken((currentToken) => currentToken + 1);
  };

  return (
    <main class="graph-experience" aria-labelledby="graph-experience-title">
      <div class="graph-shell">
        <header class="graph-header">
          <div class="graph-title-block">
            <h1 class="graph-title" id="graph-experience-title">
              {summary?.repositoryDisplayName ?? "Commit graph"}
            </h1>
            <p class="graph-subtitle">
              {summary?.currentBranchName ?? "Repository history"} ·{" "}
              {summary?.totalCommits.toLocaleString() ?? "—"} commits
            </p>
          </div>
          <div
            class={`graph-header-status${graphError === undefined ? "" : " is-error"}`}
            aria-label={
              graphError === undefined
                ? isLoading
                  ? "Graph loading"
                  : "Graph loaded"
                : "Graph error"
            }
            role="status"
          >
            <span
              class={`graph-status-dot${graphError === undefined ? "" : " is-error"}`}
              aria-hidden="true"
            />
            <span>
              {graphError === undefined
                ? isLoading
                  ? "Loading"
                  : "Ready"
                : "Error"}
            </span>
          </div>
        </header>

        <section class="graph-toolbar" aria-label="Graph filters">
          <label class="sr-only" htmlFor="graph-search">
            Search commits
          </label>
          <input
            class="graph-filter-input"
            id="graph-search"
            onInput={(event) => setSearchText(event.currentTarget.value)}
            placeholder="Search subject, author, SHA, ref"
            type="search"
            value={searchText}
          />
          <label class="sr-only" htmlFor="graph-scope">
            Graph scope
          </label>
          <select
            class="graph-scope-select"
            id="graph-scope"
            onChange={(event) =>
              setScope(readGraphScope(event.currentTarget.value))
            }
            value={scope}
          >
            <option value="all">All history</option>
            <option value="current">Current branch</option>
            <option value="local">Local branches</option>
            <option value="remote">Remote branches</option>
            <option value="tags">Tags</option>
            <option value="stashes">Stashes</option>
            <option value="worktrees">Worktrees</option>
          </select>
          <label class="graph-check-control">
            <input
              checked={includeWip}
              onChange={(event) => setIncludeWip(event.currentTarget.checked)}
              type="checkbox"
            />
            Working tree
          </label>
          <label class="graph-check-control">
            <input
              checked={includeWorktrees}
              onChange={(event) =>
                setIncludeWorktrees(event.currentTarget.checked)
              }
              type="checkbox"
            />
            Worktrees
          </label>
        </section>

        <p class="graph-announcement" aria-live="polite" role="status">
          {announcement}
        </p>
        {graphError !== undefined ? (
          <div class="graph-error" role="alert">
            <span aria-hidden="true" class="codicon codicon-error" />
            <span>{graphError}</span>
            <button type="button" onClick={retryGraph}>
              Retry graph
            </button>
          </div>
        ) : null}

        <div class="graph-layout">
          <section class="graph-main-region" aria-label="Commit history">
            <div
              aria-busy={isLoading}
              aria-colcount={3}
              aria-activedescendant={activeRowDomId}
              aria-label="Commit history tree"
              aria-rowcount={totalRows + 1}
              class="graph-treegrid"
              onFocus={(event) => {
                if (event.target !== event.currentTarget) return;
                if (
                  selectedRowIndex === undefined &&
                  visibleRows[0] !== undefined
                )
                  setSelectedRowIndex(visibleRows[0].rowIndex);
              }}
              onKeyDown={handleTreegridKeyDown}
              ref={graphTreegridReference}
              role="treegrid"
              tabIndex={0}
            >
              <div class="graph-table-header" aria-rowindex={1} role="row">
                <span role="columnheader">Topology</span>
                <span role="columnheader">Commit</span>
                <span role="columnheader">Actions</span>
              </div>
              <div
                class="graph-scroll-region"
                onScroll={handleScroll}
                ref={scrollRegionReference}
              >
                {totalRows === 0 && isLoading ? (
                  <div class="graph-loading-state">
                    Loading repository history…
                  </div>
                ) : null}
                {totalRows === 0 && !isLoading ? (
                  <div class="graph-empty-state">
                    No commits match these filters.
                  </div>
                ) : null}
                {totalRows > 0 ? (
                  <div class="graph-scroll-content">
                    <div class="graph-row-window">
                      {visibleRows.map((row) => (
                        <GraphRow
                          isSelected={row.rowIndex === selectedRowIndex}
                          key={row.rowIndex}
                          onKeyDown={handleRowKeyDown}
                          onSelect={(nextRow) => {
                            if (
                              renderedGraphGeneration ===
                              graphGenerationReference.current
                            )
                              setSelectedRowIndex(nextRow.rowIndex);
                          }}
                          row={row}
                          totalRows={totalRows}
                          rowRef={(element) => {
                            if (element === null)
                              rowReferences.current.delete(row.rowIndex);
                            else
                              rowReferences.current.set(row.rowIndex, element);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            {summary?.truncated ? (
              <p class="graph-truncation-note">
                History is safety-capped. Older commits are not shown.
              </p>
            ) : null}
          </section>
          <GraphMinimap
            available={isMinimapCurrent}
            buckets={minimapBuckets}
            error={minimapError}
            onJump={(rowIndex) => focusRow(rowIndex, renderedGraphGeneration)}
            onRetry={retryMinimap}
            selectedRowIndex={selectedRowIndex}
          />
          <GraphDetailsPanel
            actionError={actionError}
            metrics={selectedMetrics}
            metricsError={metricsError}
            metricsLoading={metricsLoading}
            onAction={runAction}
            selectedRow={selectedRow}
          />
        </div>
      </div>
    </main>
  );
}

type GraphActionMessage =
  | "openCommit"
  | "openDiff"
  | "compareWithParent"
  | "checkoutReference"
  | "showBranchStatus";
