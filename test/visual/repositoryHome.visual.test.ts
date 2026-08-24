import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { h } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/preact";

const postMessageMock = vi.fn();

vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: postMessageMock,
  getState: () => undefined,
  setState: () => undefined,
}));

let RepositoryHomeApp: typeof import("../../src/webview/screens/RepositoryHomeApp.js").RepositoryHomeApp;

const visualSnapshot = {
  requestGeneration: 7,
  repositories: [
    { repositoryRoot: "/workspace/gito", repositoryDisplayName: "gito" },
  ],
  selectedRepository: {
    repositoryRoot: "/workspace/gito",
    repositoryDisplayName: "gito",
    repositoryHealth: {
      branchName: "main",
      uncommittedChangeCount: 0,
      aheadCount: 0,
      behindCount: 0,
      lastSuccessfulFetchAt: "2026-08-23T00:00:00.000Z",
    },
    commitActivity: {
      days: [],
      totalCommitCount: 0,
      safetyCapReached: false,
    },
    cloudDashboards: [
      {
        providerId: "github",
        providerDisplayName: "GitHub",
        connectionState: "connected",
        accountDisplayName: "maintainer",
        pullRequests: [],
        fetchedAt: "2026-08-23T00:00:00.000Z",
      },
    ],
  },
  providerFilter: "all",
  loadingSections: [],
  sectionErrors: [],
};

function publishVisualSnapshot(): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        protocolVersion: 1,
        messageType: "repositoryHomeChanged",
        repositoryHomeSnapshot: visualSnapshot,
      },
    }),
  );
}

describe("Repository Home visual behavior", () => {
  beforeAll(async () => {
    ({ RepositoryHomeApp } =
      await import("../../src/webview/screens/RepositoryHomeApp.js"));
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    postMessageMock.mockClear();
  });

  it("keeps the approved dashboard hierarchy in the empty normalized state", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() => publishVisualSnapshot());
    expect(container.querySelector(".dashboard-header h1")?.textContent).toBe(
      "Repository Home",
    );
    expect(container.querySelectorAll(".metric-card")).toHaveLength(4);
    expect(container.querySelector(".commit-card")).toBeTruthy();
    expect(container.querySelectorAll(".pull-request-panel")).toHaveLength(2);
    expect(container.querySelector(".repository-health")).toBeTruthy();
    expect(
      screen.getByText("No matching commits for the configured author emails."),
    ).toBeTruthy();
  });

  it("keeps provider filtering action-oriented", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() => publishVisualSnapshot());
    const providerElement = screen.getByLabelText("Provider");
    if (!(providerElement instanceof HTMLSelectElement))
      throw new Error("Provider control is not a select.");
    const providerSelect = providerElement;
    providerSelect.value = "github";
    await act(() => {
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(postMessageMock).toHaveBeenCalledWith({
      protocolVersion: 1,
      messageType: "setProviderFilter",
      providerFilter: "github",
    });
  });

  it("wraps selected repository names and paths instead of hiding them", async () => {
    const stylesheetElement = document.createElement("style");
    stylesheetElement.textContent = readFileSync(
      resolve(process.cwd(), "src/webview/styles/repositoryHome.css"),
      "utf8",
    );
    document.head.append(stylesheetElement);
    try {
      const { container } = render(h(RepositoryHomeApp, {}));
      await act(() => publishVisualSnapshot());
      const repositoryName = container.querySelector<HTMLElement>(
        ".repository-context strong",
      );
      const repositoryPath = container.querySelector<HTMLElement>(
        ".repository-context small",
      );
      if (repositoryName === null || repositoryPath === null)
        throw new Error("Selected repository context was not rendered.");
      expect(getComputedStyle(repositoryName).whiteSpace).toBe("normal");
      expect(getComputedStyle(repositoryName).overflowWrap).toBe("anywhere");
      expect(getComputedStyle(repositoryPath).whiteSpace).toBe("normal");
      expect(getComputedStyle(repositoryPath).overflowWrap).toBe("anywhere");
    } finally {
      stylesheetElement.remove();
    }
  });

  it("gives each provider connection an accessible action", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() => publishVisualSnapshot());
    expect(
      screen.getByRole("button", { name: "Disconnect GitHub" }),
    ).toBeTruthy();
    await act(() =>
      screen.getByRole("button", { name: "Disconnect GitHub" }).click(),
    );
    expect(postMessageMock).toHaveBeenCalledWith({
      protocolVersion: 1,
      messageType: "disconnectProvider",
      providerId: "github",
    });
  });

  it("keeps heatmap targets at 24px with an internal narrow-viewport scroll", async () => {
    const stylesheetElement = document.createElement("style");
    stylesheetElement.textContent = readFileSync(
      resolve(process.cwd(), "src/webview/styles/repositoryHome.css"),
      "utf8",
    );
    document.head.append(stylesheetElement);
    try {
      const { container } = render(h(RepositoryHomeApp, {}));
      await act(() => publishVisualSnapshot());
      const heatmapScrollRegion = container.querySelector(
        ".heatmap-scroll-region",
      );
      const heatmapCell = container.querySelector(
        ".heatmap-grid .heatmap-cell",
      );
      if (!(heatmapScrollRegion instanceof HTMLElement))
        throw new Error("Heatmap scroll region was not rendered.");
      if (!(heatmapCell instanceof HTMLElement))
        throw new Error("Heatmap cell was not rendered.");

      const originalViewportWidth = window.innerWidth;
      try {
        for (const viewportWidth of [320, 160]) {
          Object.defineProperty(window, "innerWidth", {
            configurable: true,
            value: viewportWidth,
          });
          expect(getComputedStyle(heatmapScrollRegion).overflowX).toBe("auto");
          expect(getComputedStyle(heatmapCell).width).toBe("24px");
          expect(getComputedStyle(heatmapCell).height).toBe("24px");
          expect(getComputedStyle(heatmapCell).minWidth).toBe("24px");
          expect(getComputedStyle(heatmapCell).minHeight).toBe("24px");
        }
      } finally {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: originalViewportWidth,
        });
      }
      expect(stylesheetElement.textContent).toContain(
        "grid-template-rows: repeat(7, 24px)",
      );
      expect(stylesheetElement.textContent).toContain(
        "@media (max-width: 42rem)",
      );
    } finally {
      stylesheetElement.remove();
    }
  });
});
