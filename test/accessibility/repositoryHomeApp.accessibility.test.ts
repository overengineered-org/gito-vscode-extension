import { h } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/preact";
import * as axe from "axe-core";
import {
  buildCalendarDays,
  buildCalendarMonthLabels,
  formatMonthLabel,
} from "../../src/webview/state/commitActivity.js";
import type {
  PullRequestDetails,
  RepositoryHomeSnapshot,
} from "../../src/protocol/repositoryHomeProtocol.js";

const postMessageMock = vi.fn();

vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: postMessageMock,
  getState: () => undefined,
  setState: () => undefined,
}));

let RepositoryHomeApp: typeof import("../../src/webview/screens/RepositoryHomeApp.js").RepositoryHomeApp;

const repositoryHomeSnapshot: RepositoryHomeSnapshot = {
  requestGeneration: 1,
  repositories: [
    { repositoryRoot: "/workspace/gito", repositoryDisplayName: "gito" },
  ],
  selectedRepository: {
    repositoryRoot: "/workspace/gito",
    repositoryDisplayName: "gito",
    repositoryHealth: {
      branchName: "main",
      uncommittedChangeCount: 1,
      aheadCount: 1,
      behindCount: 0,
    },
    commitActivity: {
      days: [{ date: "2026-08-23", commitCount: 2 }],
      totalCommitCount: 2,
      safetyCapReached: false,
    },
    cloudDashboards: [
      {
        providerId: "github",
        providerDisplayName: "GitHub",
        connectionState: "connected",
        accountDisplayName: "maintainer",
        pullRequests: [
          {
            providerId: "github",
            repositoryOwner: "overengineered-org",
            repositoryName: "gito",
            pullRequestNumber: 12,
            title: "Improve repository home",
            authorDisplayName: "Maintainer",
            updatedAt: "2026-08-23T00:00:00.000Z",
            commentCount: 2,
            isAuthoredByCurrentUser: true,
            reviewRequestedFromCurrentUser: false,
            isDraft: false,
            state: "ready",
            completedReviewCount: 2,
            requiredReviewCount: 2,
          },
        ],
        fetchedAt: "2026-08-23T00:00:00.000Z",
      },
    ],
  },
  providerFilter: "all",
  loadingSections: [],
  sectionErrors: [],
};

function publishSnapshot(
  nextSnapshot: RepositoryHomeSnapshot = repositoryHomeSnapshot,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        protocolVersion: 1,
        messageType: "repositoryHomeChanged",
        repositoryHomeSnapshot: nextSnapshot,
      },
    }),
  );
}

function publishPullRequestDetails(
  pullRequestDetails: PullRequestDetails,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        protocolVersion: 1,
        messageType: "pullRequestDetailsLoaded",
        requestGeneration: 2,
        pullRequestIdentity: {
          providerId: pullRequestDetails.providerId,
          repositoryOwner: pullRequestDetails.repositoryOwner,
          repositoryName: pullRequestDetails.repositoryName,
          ...(pullRequestDetails.repositoryProject === undefined
            ? {}
            : { repositoryProject: pullRequestDetails.repositoryProject }),
          pullRequestNumber: pullRequestDetails.pullRequestNumber,
        },
        pullRequestDetails,
      },
    }),
  );
}

describe("Repository Home accessibility", () => {
  beforeAll(() => {
    document.body.innerHTML = "";
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => null,
    );
  });

  beforeAll(async () => {
    ({ RepositoryHomeApp } =
      await import("../../src/webview/screens/RepositoryHomeApp.js"));
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    postMessageMock.mockClear();
  });

  it("has no axe findings with normalized data", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    const axeResults = await axe.run(container);
    expect(axeResults.violations).toEqual([]);
  }, 15_000);

  it("visibly discloses stale provider data and retains its pull request", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        selectedRepository: {
          ...repositoryHomeSnapshot.selectedRepository!,
          cloudDashboards: [
            {
              ...repositoryHomeSnapshot.selectedRepository!.cloudDashboards[0]!,
              cacheStatus: "stale",
              staleReason: "server",
            },
          ],
        },
      }),
    );

    expect(screen.getByText("Stale data (server error)")).toBeTruthy();
    expect(
      screen.getByRole("status", {
        name: "GitHub connected; stale data (server error)",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /GitHub pull request 12, Improve repository home/i,
      }),
    ).toBeTruthy();
    expect(screen.getByText("Improve repository home")).toBeTruthy();
  });

  it("exposes pressed summary cards and readable PR details", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    const summaryCard = screen.getByRole("button", { name: /Merge-ready 1/i });
    expect(summaryCard.getAttribute("aria-pressed")).toBe("false");
    await act(() => summaryCard.click());
    expect(summaryCard.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Your pull requests" }),
    ).toBeTruthy();
  });

  it("focuses and announces the pull-request section from Home focus metadata", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            protocolVersion: 1,
            messageType: "repositoryHomeChanged",
            focusTarget: "pullRequests",
            repositoryHomeSnapshot,
          },
        }),
      );
    });

    expect(document.activeElement?.id).toBe("needs-review-heading");
    expect(screen.getByText("Pull requests section focused.")).toBeTruthy();
  });

  it("announces commit activity loading and error transitions politely", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        loadingSections: ["commitActivity"],
      }),
    );
    const statusElement = container.querySelector(".commit-summary-status");
    expect(statusElement?.getAttribute("role")).toBe("status");
    expect(statusElement?.getAttribute("aria-live")).toBe("polite");
    expect(statusElement?.textContent).toBe("Loading commit activity…");

    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 3,
        sectionErrors: [
          {
            section: "commitActivity",
            userMessage: "Commit activity is unavailable.",
          },
        ],
      }),
    );
    expect(statusElement?.textContent).toBe("Commit activity unavailable.");
    expect(container.querySelector(".commit-error")?.textContent).toBe(
      "Commit activity is unavailable.",
    );
    expect(statusElement?.textContent).not.toBe(
      container.querySelector(".commit-error")?.textContent,
    );
  });

  it("moves commit activity focus with arrow keys", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    const initialFocusedDay = container.querySelector(
      ".heatmap-cell[tabindex='0']",
    );
    if (!(initialFocusedDay instanceof HTMLButtonElement))
      throw new Error("Heatmap did not expose a roving tab stop.");
    initialFocusedDay.focus();
    await act(() => {
      initialFocusedDay.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(document.activeElement).not.toBe(initialFocusedDay);
    expect(
      container.querySelectorAll(".heatmap-cell[tabindex='0']"),
    ).toHaveLength(1);
  });

  it("uses Monday-first dates and keeps month labels aligned with the grid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 12));
    try {
      const calendarDays = buildCalendarDays([]);
      const expectedMonthLabels = buildCalendarMonthLabels(calendarDays);
      const { container } = render(h(RepositoryHomeApp, {}));
      await act(() => publishSnapshot());

      const monthLabelElements = [
        ...container.querySelectorAll(".heatmap-month-labels span"),
      ];
      expect(monthLabelElements[0]?.textContent).toBe(
        formatMonthLabel(
          calendarDays.find((calendarDay) => calendarDay.isInWindow)!.date,
        ),
      );
      expect(monthLabelElements).toHaveLength(expectedMonthLabels.length);
      expect(monthLabelElements[0]?.getAttribute("style")).toContain(
        "grid-column-start: 1",
      );

      const weekdayLabelElements = [
        ...container.querySelectorAll<HTMLSpanElement>(
          ".heatmap-weekday-labels span",
        ),
      ];
      expect(weekdayLabelElements.map((label) => label.textContent)).toEqual([
        "Mon",
        "Wed",
        "Fri",
      ]);
      expect(weekdayLabelElements.map((label) => label.style.gridRow)).toEqual([
        "1",
        "3",
        "5",
      ]);

      const heatmapGrid = container.querySelector(".heatmap-grid");
      const monthLabelContainer = container.querySelector(
        ".heatmap-month-labels",
      );
      expect(heatmapGrid?.parentElement).toBe(
        monthLabelContainer?.parentElement,
      );
      expect(monthLabelContainer?.getAttribute("style")).toContain(
        "repeat(53, 24px)",
      );
      expect(heatmapGrid?.getAttribute("style")).toContain("repeat(53, 24px)");

      const mondayRow = container.querySelector(
        ".heatmap-grid-row[aria-rowindex='1']",
      );
      const mondayButtons = [
        ...(mondayRow?.querySelectorAll("button.heatmap-cell") ?? []),
      ];
      expect(mondayButtons.length).toBeGreaterThan(50);
      expect(
        mondayButtons.every((button) =>
          button.getAttribute("aria-label")?.startsWith("Monday"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports week and month keyboard navigation using real date labels", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 12));
    try {
      const { container } = render(h(RepositoryHomeApp, {}));
      await act(() => publishSnapshot());
      const mondayButton = screen.getByRole("button", {
        name: /Monday, August 25, 2025: 0 commits/,
      });
      mondayButton.focus();

      await act(() => {
        mondayButton.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(
        /^Tuesday, August 26, 2025:/,
      );

      const tuesdayButton = document.activeElement;
      if (!(tuesdayButton instanceof HTMLButtonElement))
        throw new Error("Tuesday heatmap button was not focused.");
      await act(() => {
        tuesdayButton.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        );
      });
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(
        /^Monday, August 25, 2025:/,
      );

      const homeButton = document.activeElement;
      if (!(homeButton instanceof HTMLButtonElement))
        throw new Error("Home heatmap button was not focused.");
      await act(() => {
        homeButton.dispatchEvent(
          new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
        );
      });
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(
        /^Thursday, September 25, 2025:/,
      );

      expect(
        container.querySelectorAll(".heatmap-cell[tabindex='0']"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps loading and no-repository heatmaps noninteractive", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    const loadingPlaceholder = container.querySelector(".heatmap-placeholder");
    expect(loadingPlaceholder?.textContent).toBe("Loading…");
    expect(loadingPlaceholder?.getAttribute("aria-hidden")).toBe("true");
    expect(
      container
        .querySelector(".heatmap-scroll-region")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(container.querySelector(".heatmap-grid")).toBeNull();
    expect(container.querySelectorAll("[role='gridcell']")).toHaveLength(0);

    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        selectedRepository: null,
      }),
    );
    const noRepositoryPlaceholder = container.querySelector(
      ".heatmap-placeholder",
    );
    expect(noRepositoryPlaceholder?.textContent).toBe("Select a repository");
    expect(noRepositoryPlaceholder?.getAttribute("aria-hidden")).toBe("true");
    expect(
      container
        .querySelector(".heatmap-scroll-region")
        ?.getAttribute("aria-busy"),
    ).toBeNull();
    expect(container.querySelector(".heatmap-grid")).toBeNull();
    expect(container.querySelectorAll("[role='gridcell']")).toHaveLength(0);
  });

  it("offers a keyboard-accessible repository CTA when no repository is selected", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        selectedRepository: null,
      }),
    );

    const repositoryCta = screen.getByRole("link", {
      name: "Open or choose repository",
    });
    expect(repositoryCta).toBeInstanceOf(HTMLAnchorElement);
    expect(repositoryCta.getAttribute("href")).toBe(
      "command:gito.onboarding.openOrChooseRepository",
    );
    expect(
      screen.getByRole("heading", { name: "Open a repository to begin" }),
    ).toBeTruthy();
    expect(container.querySelector(".repository-empty-state")).toBeTruthy();
  });

  it("ignores stale snapshots and restores focus after closing details", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    const pullRequestTrigger = screen.getByRole("button", {
      name: /GitHub pull request 12/i,
    });
    await act(() => pullRequestTrigger.click());
    const detailsHeading = screen.getByRole("heading", {
      name: "Pull request #12",
    });
    expect(document.activeElement).toBe(detailsHeading);

    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 0,
        selectedRepository: null,
      }),
    );
    expect(screen.getByRole("heading", { name: "Pull request #12" })).toBe(
      detailsHeading,
    );

    await act(() =>
      screen
        .getByRole("button", { name: "Close pull request details" })
        .click(),
    );
    expect(document.activeElement).toBe(pullRequestTrigger);
    expect(container.querySelector(".pull-request-details")).toBeNull();
  });

  it("renders escaped loaded details and keeps actions distinct", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    const pullRequestTrigger = screen.getByRole("button", {
      name: /GitHub pull request 12/i,
    });
    await act(() => pullRequestTrigger.click());
    await act(() =>
      publishPullRequestDetails({
        providerId: "github",
        repositoryOwner: "overengineered-org",
        repositoryName: "gito",
        pullRequestNumber: 12,
        title: "Improve repository home",
        authorDisplayName: "Maintainer",
        updatedAt: "2026-08-23T00:00:00.000Z",
        commentCount: 3,
        isAuthoredByCurrentUser: true,
        reviewRequestedFromCurrentUser: false,
        isDraft: false,
        state: "ready",
        completedReviewCount: 2,
        requiredReviewCount: 2,
        bodyText: "<img src=x onerror=alert(1)>",
        sourceBranchName: "feature/home",
        targetBranchName: "main",
        canonicalUrl: "https://github.com/overengineered-org/gito/pull/12",
      }),
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("feature/home")).toBeTruthy();
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    expect(screen.getByText("Pull request detail")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Check out branch feature\/home into the local working tree/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Checkout changes the local working tree/),
    ).toBeTruthy();

    await act(() =>
      screen.getByRole("button", { name: /Open provider page/i }).click(),
    );
    await act(() =>
      screen.getByRole("button", { name: /Check out branch/i }).click(),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "openExternalPullRequest" }),
    );
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "checkoutPullRequest" }),
    );
  }, 15_000);

  it("clears a pull-request selection removed by a fresh snapshot", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    await act(() =>
      screen.getByRole("button", { name: /GitHub pull request 12/i }).click(),
    );
    expect(
      screen.getByRole("heading", { name: "Pull request #12" }),
    ).toBeTruthy();

    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        selectedRepository: {
          ...repositoryHomeSnapshot.selectedRepository!,
          cloudDashboards: [
            {
              ...repositoryHomeSnapshot.selectedRepository!.cloudDashboards[0]!,
              pullRequests: [],
            },
          ],
        },
      }),
    );
    expect(
      screen.queryByRole("heading", { name: "Pull request #12" }),
    ).toBeNull();
    expect(document.activeElement?.id).toBe("repository-home-title");
    expect(document.body.textContent).toContain(
      "selected pull request is no longer available; selection cleared",
    );
  });

  it("clears summary metric filters when the provider changes", async () => {
    render(h(RepositoryHomeApp, {}));
    await act(() => publishSnapshot());
    await act(() =>
      screen.getByRole("button", { name: /Merge-ready 1/i }).click(),
    );
    expect(
      screen.getByRole("button", { name: "Clear summary filter" }),
    ).toBeTruthy();

    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        providerFilter: "github",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Clear summary filter" }),
    ).toBeNull();
  });

  it("disables empty summary metrics and exposes section retry alerts", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 2,
        sectionErrors: [
          { section: "github", userMessage: "GitHub is unavailable." },
        ],
      }),
    );
    expect(
      screen
        .getByRole("button", { name: /Review requested 0/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("alert")
        .some((alertElement) =>
          alertElement.textContent?.includes("GitHub is unavailable"),
        ),
    ).toBe(true);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    expect(container.querySelectorAll(".section-error")).toHaveLength(0);
  });

  it("does not render stale activity or pull requests during section errors", async () => {
    const { container } = render(h(RepositoryHomeApp, {}));
    await act(() =>
      publishSnapshot({
        ...repositoryHomeSnapshot,
        requestGeneration: 3,
        sectionErrors: [
          {
            section: "commitActivity",
            userMessage: "Commit activity is unavailable.",
          },
          { section: "github", userMessage: "GitHub is unavailable." },
        ],
      }),
    );
    expect(container.querySelector(".heatmap-grid")).toBeNull();
    expect(container.querySelector(".heatmap-placeholder")?.textContent).toBe(
      "Commit activity unavailable",
    );
    expect(container.querySelectorAll(".pull-request-row")).toHaveLength(0);
    expect(
      [...container.querySelectorAll(".panel-count")].every(
        (panelCount) => panelCount.textContent === "—",
      ),
    ).toBe(true);
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(2);
  });
});
