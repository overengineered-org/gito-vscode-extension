import { describe, expect, it, vi } from "vitest";

import {
  GraphExperienceController,
  type GraphExperienceActions,
  type GraphExperienceDataSource,
  type GraphPageRequest,
} from "../../../src/extension/graphExperience/index.js";
import type {
  GraphPageMessage,
  GraphSummaryMessage,
} from "../../../src/protocol/graphExperienceProtocol.js";

const summary: GraphSummaryMessage = {
  repositoryRoot: "/workspace/gito",
  repositoryDisplayName: "gito",
  currentBranchName: "main",
  totalCommits: 2,
  totalReferences: 1,
  totalWorktrees: 1,
  truncated: false,
};

const page: GraphPageMessage = {
  rows: [
    {
      kind: "commit",
      rowIndex: 0,
      commitSha: "a".repeat(40),
      parents: [],
      lanes: [{ column: 0, expectedCommitSha: "a".repeat(40), colorIndex: 0 }],
      nextLanes: [],
      edges: [],
      references: [
        {
          name: "HEAD",
          targetSha: "a".repeat(40),
          kind: "head",
          isHead: true,
        },
      ],
      subject: "Initial commit",
      authorName: "Maintainer",
      authorEmail: "maintainer@example.test",
      commitDate: "2026-08-23T10:00:00+10:00",
    },
  ],
  hasMore: false,
  totalRows: 1,
  totalCommits: 1,
  truncated: false,
  snapshotKey: "1:a",
};

function createActions(
  overrides: Partial<GraphExperienceActions> = {},
): GraphExperienceActions {
  return {
    openCommit: vi.fn(() => Promise.resolve()),
    openDiff: vi.fn(() => Promise.resolve()),
    compareWithParent: vi.fn(() => Promise.resolve()),
    checkoutReference: vi.fn(() => Promise.resolve()),
    showBranchStatus: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function createDataSource(
  overrides: Partial<GraphExperienceDataSource> = {},
): GraphExperienceDataSource {
  return {
    getSummary: vi.fn(() => Promise.resolve(summary)),
    queryPage: vi.fn(() => Promise.resolve(page)),
    getMinimap: vi.fn(() => Promise.resolve([])),
    getChangedLineMetrics: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  };
}

function queryMessage(requestId = 1) {
  return {
    protocolVersion: 1 as const,
    messageType: "graphQuery" as const,
    requestId,
    pageSize: 40,
    append: false,
    filter: { scope: "all" as const },
    includeWip: true,
    includeWorktrees: true,
  };
}

describe("GraphExperienceController", () => {
  it("rejects untrusted message shapes before reaching the data source", async () => {
    const dataSource = createDataSource();
    const controller = new GraphExperienceController({
      dataSource,
      actions: createActions(),
    });

    await expect(
      controller.handleMessage({
        protocolVersion: 1,
        messageType: "graphQuery",
        requestId: 1,
        pageSize: 40,
        append: false,
        filter: { scope: "all" },
        includeWip: true,
        includeWorktrees: true,
        unexpected: "reject me",
      }),
    ).resolves.toBeUndefined();
    expect(dataSource.queryPage).not.toHaveBeenCalled();
  });

  it("rejects hostile checkout references before reaching an action adapter", async () => {
    const actions = createActions();
    const controller = new GraphExperienceController({
      dataSource: createDataSource(),
      actions,
    });

    await expect(
      controller.handleMessage({
        protocolVersion: 1,
        messageType: "graphAction",
        requestId: 9,
        action: "checkoutReference",
        referenceName: "--upload-pack=evil",
      }),
    ).resolves.toMatchObject({
      messageType: "graphOperationFailed",
      operation: "action",
    });
    expect(actions.checkoutReference).not.toHaveBeenCalled();
  });

  it("preserves loaded-looking branch references for the host binding check", async () => {
    const actions = createActions();
    const controller = new GraphExperienceController({
      dataSource: createDataSource(),
      actions,
    });

    await expect(
      controller.handleMessage({
        protocolVersion: 1,
        messageType: "graphAction",
        requestId: 10,
        action: "checkoutReference",
        referenceName: "refs/heads/main",
      }),
    ).resolves.toMatchObject({
      messageType: "graphActionCompleted",
      action: "checkoutReference",
    });
    expect(actions.checkoutReference).toHaveBeenCalledWith(
      "refs/heads/main",
      expect.any(AbortSignal),
    );
  });

  it("returns strict page responses and maps actions to existing service adapters", async () => {
    const actions = createActions();
    const controller = new GraphExperienceController({
      dataSource: createDataSource(),
      actions,
    });

    await expect(
      controller.handleMessage(queryMessage()),
    ).resolves.toMatchObject({
      messageType: "graphPageLoaded",
      requestId: 1,
      page,
    });
    await expect(
      controller.handleMessage({
        protocolVersion: 1,
        messageType: "graphAction",
        requestId: 2,
        action: "openDiff",
        commitSha: "a".repeat(40),
      }),
    ).resolves.toMatchObject({
      messageType: "graphActionCompleted",
      action: "openDiff",
    });
    expect(actions.openDiff).toHaveBeenCalledWith(
      "a".repeat(40),
      expect.any(AbortSignal),
    );
    await controller.handleMessage({
      protocolVersion: 1,
      messageType: "graphAction",
      requestId: 3,
      action: "compareWithParent",
      commitSha: "a".repeat(40),
      parentSha: "b".repeat(40),
    });
    expect(actions.compareWithParent).toHaveBeenCalledWith(
      "a".repeat(40),
      expect.any(AbortSignal),
      "b".repeat(40),
    );
  });

  it("observes cancellation after paged work begins", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const dataSource = createDataSource({
      queryPage: vi.fn(
        async (
          _request: GraphPageRequest,
          cancellationSignal: AbortSignal,
        ): Promise<GraphPageMessage> => {
          resolveStarted?.();
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 100);
            cancellationSignal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                const cancellationError = new Error("cancelled");
                cancellationError.name = "AbortError";
                reject(cancellationError);
              },
              { once: true },
            );
          });
          return page;
        },
      ),
    });
    const controller = new GraphExperienceController({
      dataSource,
      actions: createActions(),
    });

    const queryPromise = controller.handleMessage(queryMessage(8));
    await started;
    await controller.handleMessage({
      protocolVersion: 1,
      messageType: "graphCancel",
      requestId: 8,
    });
    await expect(queryPromise).resolves.toBeUndefined();
  });

  it("returns a safe failure when an action target is missing", async () => {
    const controller = new GraphExperienceController({
      dataSource: createDataSource(),
      actions: createActions(),
    });
    await expect(
      controller.handleMessage({
        protocolVersion: 1,
        messageType: "graphAction",
        requestId: 4,
        action: "openCommit",
      }),
    ).resolves.toEqual({
      protocolVersion: 1,
      messageType: "graphOperationFailed",
      requestId: 4,
      operation: "action",
      userMessage: "Select a commit or reference before running this action.",
    });
  });

  it("centralizes Git error redaction before graph transport", async () => {
    const actions = createActions({
      openCommit: vi.fn(() =>
        Promise.reject(new Error("authorization: Bearer ghp_sensitive-value")),
      ),
    });
    const controller = new GraphExperienceController({
      dataSource: createDataSource(),
      actions,
    });

    await expect(
      controller.handleMessage({
        protocolVersion: 1,
        messageType: "graphAction",
        requestId: 5,
        action: "openCommit",
        commitSha: "a".repeat(40),
      }),
    ).resolves.toMatchObject({
      messageType: "graphOperationFailed",
      requestId: 5,
      userMessage: "authorization: Bearer [redacted]",
    });
  });
});
