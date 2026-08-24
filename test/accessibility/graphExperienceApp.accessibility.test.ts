import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { h } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/preact";
import * as axe from "axe-core";

import type {
  GraphPageMessage,
  GraphSummaryMessage,
} from "../../src/protocol/graphExperienceProtocol.js";
import { graphWebviewToExtensionMessageSchema } from "../../src/protocol/graphExperienceProtocol.js";

const postMessageMock = vi.fn();
vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: postMessageMock,
  getState: () => undefined,
  setState: () => undefined,
}));

let GraphExperienceApp: typeof import("../../src/webview/graph/GraphExperienceApp.js").GraphExperienceApp;

const summary: GraphSummaryMessage = {
  repositoryRoot: "/workspace/gito",
  repositoryDisplayName: "gito",
  currentBranchName: "main",
  totalCommits: 100_000,
  totalReferences: 12,
  totalWorktrees: 1,
  truncated: false,
};

const commitSha = "a".repeat(40);
const page: GraphPageMessage = {
  rows: [
    {
      kind: "commit",
      rowIndex: 0,
      commitSha,
      parents: [],
      lanes: [{ column: 0, expectedCommitSha: commitSha, colorIndex: 0 }],
      nextLanes: [],
      edges: [],
      references: [
        { name: "HEAD", targetSha: commitSha, kind: "head", isHead: true },
      ],
      subject: "Initial commit",
      authorName: "Maintainer",
      authorEmail: "maintainer@example.test",
      commitDate: "2026-08-23T10:00:00+10:00",
    },
  ],
  hasMore: true,
  nextCursor: { snapshotKey: "snapshot", rowOffset: 1 },
  totalRows: 100_000,
  totalCommits: 100_000,
  truncated: false,
  snapshotKey: "snapshot",
};

function publishMessage(message: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
}

describe("GraphExperienceApp accessibility", () => {
  beforeAll(async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => null,
    );
    ({ GraphExperienceApp } =
      await import("../../src/webview/graph/GraphExperienceApp.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.body.innerHTML = "";
    postMessageMock.mockClear();
  });

  it("exposes a readable treegrid and details rail without axe findings", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page,
      });
    });
    const axeResults = await axe.run(container);
    expect(axeResults.violations).toEqual([]);
    const treegrid = screen.getByRole("treegrid", {
      name: "Commit history tree",
    });
    expect(treegrid).toBeTruthy();
    expect(screen.getByRole("row", { name: /Initial commit/ })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Commit details and actions" }),
    ).toBeTruthy();
    const compareButton = screen.getByRole("button", {
      name: "Compare with parent",
    });
    expect(compareButton.hasAttribute("disabled")).toBe(true);
    expect(compareButton.getAttribute("aria-describedby")).toBe(
      "graph-compare-parent-help",
    );
    expect(
      screen.getByText("This root commit has no parent to compare."),
    ).toBeTruthy();
    const checkoutButton = screen.getByRole("button", {
      name: "Checkout HEAD",
    });
    expect(checkoutButton.getAttribute("aria-describedby")).toBe(
      "graph-head-checkout-help",
    );
    expect(checkoutButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Workspace trust may be requested/)).toBeTruthy();
    await act(() => {
      checkoutButton.click();
    });
    expect(
      postMessageMock.mock.calls
        .map(([message]) =>
          graphWebviewToExtensionMessageSchema.safeParse(message),
        )
        .some(
          (parsedMessage) =>
            parsedMessage.success &&
            parsedMessage.data.messageType === "graphAction" &&
            parsedMessage.data.action === "checkoutReference",
        ),
    ).toBe(false);
    expect(treegrid.getAttribute("aria-rowcount")).toBe("100001");
    expect(
      treegrid
        .querySelector<HTMLElement>(".graph-table-header")
        ?.getAttribute("aria-rowindex"),
    ).toBe("1");
    expect(
      treegrid
        .querySelector<HTMLElement>(".graph-row")
        ?.getAttribute("aria-rowindex"),
    ).toBe("2");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("provides one Tab stop and keeps the active descendant on the treegrid", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: {
          ...page,
          rows: [
            page.rows[0]!,
            {
              ...page.rows[0]!,
              rowIndex: 1,
              commitSha: "b".repeat(40),
              subject: "Second commit",
            },
          ],
          totalRows: 2,
          totalCommits: 2,
          hasMore: false,
          nextCursor: undefined,
        },
      });
    });

    const treegrid = screen.getByRole("treegrid", {
      name: "Commit history tree",
    });
    expect(treegrid.getAttribute("tabindex")).toBe("0");
    expect(treegrid.getAttribute("aria-activedescendant")).toBe(
      "gito-graph-row-0",
    );
    expect(
      container.querySelector("[data-row-index='0']")?.getAttribute("tabindex"),
    ).toBe("-1");

    treegrid.focus();
    expect(document.activeElement).toBe(treegrid);
    await act(() => {
      treegrid.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(treegrid);
    expect(treegrid.getAttribute("aria-activedescendant")).toBe(
      "gito-graph-row-1",
    );
    expect(
      container
        .querySelector("[data-row-index='1']")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("returns focus to the treegrid before the active virtual row unmounts", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    const makeRow = (rowIndex: number) => ({
      ...page.rows[0]!,
      rowIndex,
      commitSha: rowIndex.toString(16).padStart(40, "0"),
    });
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: {
          ...page,
          rows: Array.from({ length: 200 }, (_, rowIndex) => makeRow(rowIndex)),
          totalRows: 200,
          totalCommits: 200,
          hasMore: false,
          nextCursor: undefined,
        },
      });
    });
    const treegrid = screen.getByRole("treegrid", {
      name: "Commit history tree",
    });
    const firstRow = container.querySelector<HTMLElement>(
      "[data-row-index='0']",
    );
    const scrollRegion = container.querySelector<HTMLElement>(
      ".graph-scroll-region",
    );
    if (firstRow === null || scrollRegion === null)
      throw new Error("Graph virtualization fixture did not render.");
    Object.defineProperty(scrollRegion, "clientHeight", {
      configurable: true,
      value: 640,
    });
    firstRow.focus();
    expect(document.activeElement).toBe(firstRow);

    await act(() => {
      scrollRegion.scrollTop = 100 * 48;
      scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(document.activeElement).toBe(treegrid);
    expect(container.querySelector("[data-row-index='0']")).toBeNull();
    expect(treegrid.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("wraps long repository and branch labels in the graph header", async () => {
    const stylesheetElement = document.createElement("style");
    stylesheetElement.textContent = readFileSync(
      resolve(process.cwd(), "src/webview/graph/graph.css"),
      "utf8",
    );
    document.head.append(stylesheetElement);
    try {
      const { container } = render(h(GraphExperienceApp, {}));
      await act(() => {
        publishMessage({
          protocolVersion: 1,
          messageType: "graphReady",
          summary: {
            ...summary,
            repositoryDisplayName: "repository-with-a-very-long-name".repeat(3),
            currentBranchName: "feature/with-a-very-long-branch-name".repeat(3),
          },
        });
        publishMessage({
          protocolVersion: 1,
          messageType: "graphPageLoaded",
          requestId: 1,
          append: false,
          page,
        });
      });
      const title = container.querySelector<HTMLElement>(".graph-title");
      const subtitle = container.querySelector<HTMLElement>(".graph-subtitle");
      if (title === null || subtitle === null)
        throw new Error("Graph header labels were not rendered.");
      expect(getComputedStyle(title).whiteSpace).toBe("normal");
      expect(getComputedStyle(title).overflowWrap).toBe("anywhere");
      expect(getComputedStyle(subtitle).whiteSpace).toBe("normal");
      expect(getComputedStyle(subtitle).overflowWrap).toBe("anywhere");
    } finally {
      stylesheetElement.remove();
    }
  });

  it.each([
    {
      subject: "  Subject with surrounding whitespace  ",
      expectedSubject: "Subject with surrounding whitespace",
    },
    { subject: " \t ", expectedSubject: "Commit subject unavailable" },
    { subject: undefined, expectedSubject: "Commit subject unavailable" },
  ])(
    "shares the normalized subject between row text, row label, and details ($subject)",
    async ({ subject, expectedSubject }) => {
      const { container } = render(h(GraphExperienceApp, {}));
      const rowWithoutSubject = { ...page.rows[0]! };
      if (rowWithoutSubject.kind !== "commit")
        throw new Error("Expected a commit fixture row.");
      delete rowWithoutSubject.subject;
      const graphRowPayload =
        subject === undefined
          ? rowWithoutSubject
          : { ...page.rows[0]!, subject };
      await act(() => {
        publishMessage({
          protocolVersion: 1,
          messageType: "graphReady",
          summary,
        });
        publishMessage({
          protocolVersion: 1,
          messageType: "graphPageLoaded",
          requestId: 1,
          append: false,
          page: { ...page, rows: [graphRowPayload] },
        });
      });

      const graphRowElement = screen.getByRole("row", {
        name: new RegExp(expectedSubject),
      });
      expect(graphRowElement.getAttribute("aria-label")).toContain(
        expectedSubject,
      );
      expect(
        graphRowElement.querySelector<HTMLElement>(".graph-commit-subject")
          ?.textContent,
      ).toBe(expectedSubject);
      expect(
        screen.getByRole("heading", { name: expectedSubject }).textContent,
      ).toBe(expectedSubject);
      expect(container.querySelector(".graph-details-title")?.textContent).toBe(
        expectedSubject,
      );
    },
  );

  it("shows branch status only for local branch references", async () => {
    const branchReferencesPage = {
      ...page,
      rows: [
        {
          ...page.rows[0]!,
          references: [
            {
              name: "HEAD",
              targetSha: commitSha,
              kind: "head" as const,
              isHead: true,
            },
            {
              name: "refs/heads/topic",
              targetSha: commitSha,
              kind: "local" as const,
            },
            {
              name: "refs/remotes/origin/topic",
              targetSha: commitSha,
              kind: "remote" as const,
            },
            {
              name: "refs/tags/v1",
              targetSha: commitSha,
              kind: "tag" as const,
            },
            {
              name: "refs/stash",
              targetSha: commitSha,
              kind: "stash" as const,
            },
          ],
        },
      ],
    };
    render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: branchReferencesPage,
      });
    });
    expect(screen.getByRole("button", { name: "Show topic" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show HEAD" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show origin/topic" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show refs/tags/v1" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show refs/stash" }),
    ).toBeNull();
    await act(() => {
      screen.getByRole("button", { name: "Show topic" }).click();
    });
    expect(
      postMessageMock.mock.calls
        .map(([message]) =>
          graphWebviewToExtensionMessageSchema.safeParse(message),
        )
        .some(
          (parsedMessage) =>
            parsedMessage.success &&
            parsedMessage.data.messageType === "graphAction" &&
            parsedMessage.data.action === "showBranchStatus" &&
            parsedMessage.data.referenceName === "refs/heads/topic",
        ),
    ).toBe(true);
  });

  it("keeps the DOM window bounded while retaining 100k-row scroll geometry", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page,
      });
    });
    expect(container.querySelectorAll("[role='row']")).toHaveLength(2);
    expect(
      document.getElementById("gito-graph-layout-style")?.textContent,
    ).toContain("height: 4800000px");
  });

  it("uses arrow keys to move selected row focus", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: {
          ...page,
          rows: [
            page.rows[0]!,
            { ...page.rows[0]!, rowIndex: 1, commitSha: "b".repeat(40) },
          ],
        },
      });
    });
    const firstRow = container.querySelector<HTMLDivElement>(".graph-row");
    if (firstRow === null) throw new Error("Graph row was not rendered.");
    firstRow.focus();
    await act(() => {
      firstRow.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(container.querySelector("[data-row-index='1']")).toBeTruthy();
  });

  it("continues paging until the bottom viewport row is available", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    const makeRow = (rowIndex: number) => ({
      ...page.rows[0]!,
      rowIndex,
      commitSha: rowIndex.toString(16).padStart(40, "0"),
    });
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: {
          ...page,
          rows: [makeRow(0)],
          totalRows: 500,
          totalCommits: 500,
          hasMore: true,
          nextCursor: { snapshotKey: "snapshot", rowOffset: 160 },
        },
      });
    });
    const scrollRegion = container.querySelector<HTMLElement>(
      ".graph-scroll-region",
    );
    if (scrollRegion === null) throw new Error("Graph scroll region missing.");
    Object.defineProperty(scrollRegion, "clientHeight", {
      configurable: true,
      value: 640,
    });
    scrollRegion.scrollTop = 23_500;
    await act(() => {
      scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const appendQueries = () =>
      postMessageMock.mock.calls.filter(([message]) => {
        const parsedMessage =
          graphWebviewToExtensionMessageSchema.safeParse(message);
        return (
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphQuery" &&
          parsedMessage.data.append
        );
      });
    expect(appendQueries()).toHaveLength(1);
    const directViewportQuery = graphWebviewToExtensionMessageSchema.safeParse(
      appendQueries()[0]?.[0],
    );
    expect(
      directViewportQuery.success &&
        directViewportQuery.data.messageType === "graphQuery"
        ? directViewportQuery.data.cursor
        : undefined,
    ).toBe("snapshot:499");
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: true,
        page: {
          ...page,
          rows: [makeRow(499)],
          totalRows: 500,
          totalCommits: 500,
          hasMore: false,
          nextCursor: undefined,
        },
      });
    });
    expect(appendQueries()).toHaveLength(1);
    expect(container.querySelector("[data-row-index='499']")).toBeTruthy();
  });

  it("replays a >4096-row minimap jump directly", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    const makeRow = (rowIndex: number) => ({
      ...page.rows[0]!,
      rowIndex,
      commitSha: rowIndex.toString(16).padStart(40, "0"),
    });
    const lastRow = makeRow(99_999);
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphMinimapLoaded",
        requestId: 2,
        buckets: [
          {
            bucketIndex: 95,
            startRow: 99_999,
            endRow: 99_999,
            commitCount: 1,
            mergeCount: 0,
            referenceCount: 0,
            colorCounts: [1],
          },
        ],
      });
    });
    await act(() => {
      screen
        .getByRole("button", { name: "Jump to commits 100000 to 100000" })
        .click();
    });
    const appendQueries = () =>
      postMessageMock.mock.calls.filter(([message]) => {
        const parsedMessage =
          graphWebviewToExtensionMessageSchema.safeParse(message);
        return (
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphQuery" &&
          parsedMessage.data.append
        );
      });
    expect(appendQueries()).toHaveLength(1);
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: true,
        page: {
          ...page,
          rows: [lastRow],
          totalRows: 100_000,
          totalCommits: 100_000,
          hasMore: false,
          nextCursor: undefined,
        },
      });
    });
    expect(appendQueries()).toHaveLength(1);
    const directJumpQuery = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .filter(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphQuery" &&
          parsedMessage.data.append,
      )
      .at(-1);
    expect(
      directJumpQuery?.success &&
        directJumpQuery.data.messageType === "graphQuery"
        ? directJumpQuery.data.cursor
        : undefined,
    ).toBe("snapshot:99999");
    expect(screen.getByText(lastRow.commitSha)).toBeTruthy();

    const scrollRegion = container.querySelector<HTMLElement>(
      ".graph-scroll-region",
    );
    if (scrollRegion === null) throw new Error("Graph scroll region missing.");
    Object.defineProperty(scrollRegion, "clientHeight", {
      configurable: true,
      value: 640,
    });
    await act(() => {
      scrollRegion.scrollTop = 200 * 48;
      scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(appendQueries()).toHaveLength(2);
    const directBackscrollQuery = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .filter(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphQuery" &&
          parsedMessage.data.append,
      )
      .at(-1);
    expect(
      directBackscrollQuery?.success &&
        directBackscrollQuery.data.messageType === "graphQuery"
        ? directBackscrollQuery.data.cursor
        : undefined,
    ).toBe("snapshot:221");
  });

  it("replays Home directly after the retained window evicts backscroll", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    const makeRow = (rowIndex: number) => ({
      ...page.rows[0]!,
      rowIndex,
      commitSha: rowIndex.toString(16).padStart(40, "0"),
    });
    const retainedPage: GraphPageMessage = {
      ...page,
      rows: Array.from({ length: 2_000 }, (_, rowIndex) => makeRow(rowIndex)),
      hasMore: true,
      nextCursor: { snapshotKey: "snapshot", rowOffset: 2_000 },
      totalRows: 5_000,
      totalCommits: 5_000,
    };
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: retainedPage,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: true,
        page: {
          ...retainedPage,
          rows: Array.from({ length: 2_000 }, (_, rowOffset) =>
            makeRow(rowOffset + 2_000),
          ),
          hasMore: true,
          nextCursor: { snapshotKey: "snapshot", rowOffset: 4_000 },
        },
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: true,
        page: {
          ...retainedPage,
          rows: Array.from({ length: 1_000 }, (_, rowOffset) =>
            makeRow(rowOffset + 4_000),
          ),
          hasMore: false,
          nextCursor: undefined,
        },
      });
    });
    const scrollRegion = container.querySelector<HTMLElement>(
      ".graph-scroll-region",
    );
    if (scrollRegion === null) throw new Error("Graph scroll region missing.");
    Object.defineProperty(scrollRegion, "clientHeight", {
      configurable: true,
      value: 640,
    });
    await act(() => {
      scrollRegion.scrollTop = 4_999 * 48;
      scrollRegion.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const lastRenderedRow = container.querySelector<HTMLElement>(
      "[data-row-index='4999']",
    );
    if (lastRenderedRow === null)
      throw new Error("Last retained graph row missing.");
    await act(() => {
      lastRenderedRow.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    const directJumpQueries = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .filter(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphQuery" &&
          parsedMessage.data.append,
      );
    expect(directJumpQueries).toHaveLength(1);
    expect(
      directJumpQueries[0]?.success &&
        directJumpQueries[0].data.messageType === "graphQuery"
        ? directJumpQueries[0].data.cursor
        : undefined,
    ).toBe("snapshot:0");
  });

  it("loads every page needed for a distant minimap jump", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    const makeRow = (rowIndex: number) => ({
      ...page.rows[0]!,
      rowIndex,
      commitSha: rowIndex.toString(16).padStart(40, "0"),
    });
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary: { ...summary, totalCommits: 500 },
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: {
          ...page,
          rows: [makeRow(0)],
          hasMore: true,
          nextCursor: { snapshotKey: "snapshot", rowOffset: 160 },
          totalRows: 500,
          totalCommits: 500,
        },
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphMinimapLoaded",
        requestId: 2,
        buckets: [
          {
            bucketIndex: 0,
            startRow: 321,
            endRow: 321,
            commitCount: 1,
            mergeCount: 0,
            referenceCount: 0,
            colorCounts: [1],
          },
        ],
      });
    });
    await act(() => {
      screen
        .getByRole("button", { name: "Jump to commits 322 to 322" })
        .click();
    });

    const appendQueries = () =>
      postMessageMock.mock.calls.filter(([message]) => {
        const parsedMessage =
          graphWebviewToExtensionMessageSchema.safeParse(message);
        return (
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphQuery" &&
          parsedMessage.data.append
        );
      });
    expect(appendQueries()).toHaveLength(1);
    const directQuery = graphWebviewToExtensionMessageSchema.safeParse(
      appendQueries()[0]?.[0],
    );
    expect(
      directQuery.success && directQuery.data.messageType === "graphQuery"
        ? directQuery.data.cursor
        : undefined,
    ).toBe("snapshot:321");

    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: true,
        page: {
          ...page,
          rows: [makeRow(321)],
          hasMore: false,
          nextCursor: undefined,
          totalRows: 500,
          totalCommits: 500,
        },
      });
    });
    expect(appendQueries()).toHaveLength(1);
    expect(container.querySelector(".graph-details-sha")?.textContent).toBe(
      makeRow(321).commitSha,
    );
    const treegrid = screen.getByRole("treegrid", {
      name: "Commit history tree",
    });
    expect(document.activeElement).toBe(treegrid);
    expect(treegrid.getAttribute("aria-activedescendant")).toBe(
      "gito-graph-row-321",
    );
  });

  it("keeps metrics failures local and clears metrics loading", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page,
      });
    });
    const metricsRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphMetrics",
      );
    const metricsRequestId =
      metricsRequest?.success &&
      metricsRequest.data.messageType === "graphMetrics"
        ? metricsRequest.data.requestId
        : undefined;
    if (metricsRequestId === undefined)
      throw new Error("Graph metrics request was not posted.");
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphOperationFailed",
        operation: "metrics",
        requestId: metricsRequestId,
        userMessage: "Commit metrics unavailable.",
      });
    });
    expect(
      container.querySelector(".graph-metrics")?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(screen.getByRole("alert").textContent).toContain(
      "Commit metrics unavailable",
    );
    expect(screen.getByRole("status", { name: "Graph loaded" })).toBeTruthy();
  });

  it("clears an action error when selection moves to another commit", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: {
          ...page,
          rows: [
            page.rows[0]!,
            { ...page.rows[0]!, rowIndex: 1, commitSha: "b".repeat(40) },
          ],
          totalRows: 2,
          totalCommits: 2,
          hasMore: false,
          nextCursor: undefined,
        },
      });
    });
    await act(() => {
      screen.getByRole("button", { name: "Open commit" }).click();
    });
    const actionRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphAction",
      );
    if (
      !actionRequest?.success ||
      actionRequest.data.messageType !== "graphAction"
    )
      throw new Error("Graph action request was not posted.");
    const actionRequestId = actionRequest.data.requestId;
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphOperationFailed",
        operation: "action",
        requestId: actionRequestId,
        userMessage: "Commit action unavailable.",
      });
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Commit action unavailable",
    );
    const secondRow = container.querySelector<HTMLElement>(
      "[data-row-index='1']",
    );
    if (secondRow === null)
      throw new Error("Second graph row was not rendered.");
    await act(() => {
      secondRow.focus();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels the previous minimap request when filters refresh the graph", async () => {
    render(h(GraphExperienceApp, {}));
    const searchInputElement = document.getElementById("graph-search");
    if (!(searchInputElement instanceof HTMLInputElement))
      throw new Error("Graph search input was not rendered.");
    const initialMinimapRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphMinimap",
      );
    if (
      !initialMinimapRequest?.success ||
      initialMinimapRequest.data.messageType !== "graphMinimap"
    )
      throw new Error("Initial minimap request was not posted.");
    const initialMinimapRequestId = initialMinimapRequest.data.requestId;

    await act(() => {
      searchInputElement.value = "feature";
      searchInputElement.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const cancelledMinimap = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphCancel" &&
          parsedMessage.data.requestId === initialMinimapRequestId,
      );
    expect(cancelledMinimap).toMatchObject({
      success: true,
      data: {
        messageType: "graphCancel",
        requestId: initialMinimapRequestId,
      },
    });
  });

  it("coalesces search query and minimap work into one 200ms refresh", async () => {
    vi.useFakeTimers();
    render(h(GraphExperienceApp, {}));
    const searchInputElement = document.getElementById("graph-search");
    if (!(searchInputElement instanceof HTMLInputElement))
      throw new Error("Graph search input was not rendered.");
    const graphMessages = () =>
      postMessageMock.mock.calls
        .map(([message]) =>
          graphWebviewToExtensionMessageSchema.safeParse(message),
        )
        .filter((parsedMessage) => parsedMessage.success)
        .map((parsedMessage) => parsedMessage.data);
    const initialQueryCount = graphMessages().filter(
      (message) => message.messageType === "graphQuery" && !message.append,
    ).length;
    const initialMinimapCount = graphMessages().filter(
      (message) => message.messageType === "graphMinimap",
    ).length;
    await act(() => {
      for (const searchValue of ["f", "fe", "fea"] as const) {
        searchInputElement.value = searchValue;
        searchInputElement.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(
      graphMessages().filter(
        (message) => message.messageType === "graphQuery" && !message.append,
      ),
    ).toHaveLength(initialQueryCount);
    expect(
      graphMessages().filter(
        (message) => message.messageType === "graphMinimap",
      ),
    ).toHaveLength(initialMinimapCount);
    await act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(
      graphMessages().filter(
        (message) => message.messageType === "graphQuery" && !message.append,
      ),
    ).toHaveLength(initialQueryCount);
    await act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      graphMessages().filter(
        (message) => message.messageType === "graphQuery" && !message.append,
      ),
    ).toHaveLength(initialQueryCount + 1);
    expect(
      graphMessages().filter(
        (message) => message.messageType === "graphMinimap",
      ),
    ).toHaveLength(initialMinimapCount + 1);
  });

  it("exposes minimap failures with an actionable retry", async () => {
    render(h(GraphExperienceApp, {}));
    const initialMinimapRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphMinimap",
      );
    if (
      !initialMinimapRequest?.success ||
      initialMinimapRequest.data.messageType !== "graphMinimap"
    )
      throw new Error("Initial minimap request was not posted.");
    const initialMinimapRequestId = initialMinimapRequest.data.requestId;
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphOperationFailed",
        operation: "minimap",
        requestId: initialMinimapRequestId,
        userMessage: "Minimap unavailable.",
      });
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Minimap unavailable",
    );
    await act(() => {
      screen.getByRole("button", { name: "Retry minimap" }).click();
    });
    expect(
      postMessageMock.mock.calls
        .map(([message]) =>
          graphWebviewToExtensionMessageSchema.safeParse(message),
        )
        .some(
          (parsedMessage) =>
            parsedMessage.success &&
            parsedMessage.data.messageType === "graphMinimap" &&
            parsedMessage.data.requestId !== initialMinimapRequestId,
        ),
    ).toBe(true);
  });

  it("hides delayed old minimap markers and rejects their stale row jumps", async () => {
    vi.useFakeTimers();
    render(h(GraphExperienceApp, {}));
    const initialMinimapRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphMinimap",
      );
    if (
      !initialMinimapRequest?.success ||
      initialMinimapRequest.data.messageType !== "graphMinimap"
    )
      throw new Error("Initial minimap request was not posted.");
    const oldMinimapRequestId = initialMinimapRequest.data.requestId;
    const oldBucket = {
      bucketIndex: 0,
      startRow: 0,
      endRow: 0,
      commitCount: 1,
      mergeCount: 0,
      referenceCount: 0,
      colorCounts: [1],
    };
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphMinimapLoaded",
        requestId: oldMinimapRequestId,
        buckets: [oldBucket],
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page,
      });
    });
    const staleMarker = screen.getByRole("button", {
      name: "Jump to commits 1 to 1",
    });

    const searchInputElement = document.getElementById("graph-search");
    if (!(searchInputElement instanceof HTMLInputElement))
      throw new Error("Graph search input was not rendered.");
    await act(() => {
      searchInputElement.value = "new graph";
      searchInputElement.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => {
      vi.advanceTimersByTime(200);
    });
    const newMinimapRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .filter(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphMinimap",
      )
      .at(-1);
    if (
      !newMinimapRequest?.success ||
      newMinimapRequest.data.messageType !== "graphMinimap"
    )
      throw new Error("Refreshed minimap request was not posted.");
    const newMinimapRequestId = newMinimapRequest.data.requestId;

    await act(() => {
      staleMarker.click();
      publishMessage({
        protocolVersion: 1,
        messageType: "graphMinimapLoaded",
        requestId: oldMinimapRequestId,
        buckets: [oldBucket],
      });
    });
    expect(
      screen.queryByRole("button", { name: "Jump to commits 1 to 1" }),
    ).toBeNull();
    expect(
      postMessageMock.mock.calls
        .map(([message]) =>
          graphWebviewToExtensionMessageSchema.safeParse(message),
        )
        .some(
          (parsedMessage) =>
            parsedMessage.success &&
            parsedMessage.data.messageType === "graphQuery" &&
            parsedMessage.data.append,
        ),
    ).toBe(false);

    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphMinimapLoaded",
        requestId: newMinimapRequestId,
        buckets: [
          {
            ...oldBucket,
            startRow: 4,
            endRow: 4,
          },
        ],
      });
    });
    expect(
      screen.queryByRole("button", { name: "Jump to commits 1 to 1" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Jump to commits 5 to 5" }),
    ).toBeTruthy();
  });

  it("refreshes all graph surfaces after checkout while preserving focus and announcement", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    const checkoutCommit = page.rows[0];
    if (checkoutCommit?.kind !== "commit")
      throw new Error("Expected a commit checkout fixture.");
    const checkoutPage = {
      ...page,
      rows: [
        {
          ...checkoutCommit,
          references: [
            ...checkoutCommit.references,
            {
              name: "refs/heads/topic",
              targetSha: commitSha,
              kind: "local" as const,
            },
          ],
        },
      ],
    };
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: 1,
        append: false,
        page: checkoutPage,
      });
    });
    const checkoutButton = screen.getByRole("button", {
      name: "Checkout topic",
    });
    await act(() => {
      checkoutButton.click();
    });
    const actionRequest = postMessageMock.mock.calls
      .map(([message]) =>
        graphWebviewToExtensionMessageSchema.safeParse(message),
      )
      .find(
        (parsedMessage) =>
          parsedMessage.success &&
          parsedMessage.data.messageType === "graphAction" &&
          parsedMessage.data.action === "checkoutReference",
      );
    if (
      !actionRequest?.success ||
      actionRequest.data.messageType !== "graphAction"
    )
      throw new Error("Checkout action request was not posted.");
    const checkoutRequestId = actionRequest.data.requestId;

    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphActionCompleted",
        requestId: checkoutRequestId,
        action: "checkoutReference",
        announcement: "Checkout reference completed.",
      });
    });
    const graphMessages = () =>
      postMessageMock.mock.calls
        .map(([message]) =>
          graphWebviewToExtensionMessageSchema.safeParse(message),
        )
        .filter((parsedMessage) => parsedMessage.success)
        .map((parsedMessage) => parsedMessage.data);
    const refreshedQuery = graphMessages()
      .filter((message) => message.messageType === "graphQuery")
      .at(-1);
    const refreshedMinimap = graphMessages()
      .filter((message) => message.messageType === "graphMinimap")
      .at(-1);
    if (
      refreshedQuery?.messageType !== "graphQuery" ||
      refreshedMinimap?.messageType !== "graphMinimap"
    )
      throw new Error("Checkout did not refresh graph query and minimap.");
    expect(refreshedQuery.append).toBe(false);
    expect(
      graphMessages().some(
        (message) =>
          message.messageType === "graphReady" && message.protocolVersion === 1,
      ),
    ).toBe(true);

    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary: { ...summary, currentBranchName: "checked-out" },
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphPageLoaded",
        requestId: refreshedQuery.requestId,
        append: false,
        page: checkoutPage,
      });
    });
    expect(
      screen.getByRole("status", { name: "Graph loaded" }).textContent,
    ).toBe("Ready");
    expect(screen.getByText("Checkout reference completed.")).toBeTruthy();
    expect(container.querySelector("[data-row-index='0']")).toBeTruthy();
  });

  it("announces current graph failures and marks status as error", async () => {
    const { container } = render(h(GraphExperienceApp, {}));
    await act(() => {
      publishMessage({
        protocolVersion: 1,
        messageType: "graphReady",
        summary,
      });
      publishMessage({
        protocolVersion: 1,
        messageType: "graphOperationFailed",
        requestId: 1,
        userMessage: "The selected Git repository changed; refresh the graph.",
      });
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "selected Git repository changed",
    );
    expect(
      screen.getByRole("status", { name: "Graph error" }).textContent,
    ).toBe("Error");
    expect(screen.getByRole("button", { name: "Retry graph" })).toBeTruthy();
    expect(container.querySelector(".graph-status-dot.is-error")).toBeTruthy();
  });
});
