import { describe, expect, it } from "vitest";
import {
  createGitHubCancellationError,
  GitHubRequestCoordinator,
} from "../../../src/extension/providers/github/githubRequestCoordinator.js";

describe("GitHubRequestCoordinator", () => {
  it("keeps concurrent provider requests within the adapter-local limit", async () => {
    const coordinator = new GitHubRequestCoordinator(2);
    let activeRequestCount = 0;
    let observedMaximumActiveRequestCount = 0;
    const requestPromises = Array.from({ length: 8 }, (_, requestNumber) =>
      coordinator.run(async () => {
        activeRequestCount += 1;
        observedMaximumActiveRequestCount = Math.max(
          observedMaximumActiveRequestCount,
          activeRequestCount,
        );
        await Promise.resolve();
        activeRequestCount -= 1;
        return requestNumber;
      }, new AbortController().signal),
    );

    await expect(Promise.all(requestPromises)).resolves.toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(observedMaximumActiveRequestCount).toBe(2);
    expect(coordinator.activeRequests).toBe(0);
    expect(coordinator.queuedRequestsCount).toBe(0);
  });

  it("rejects queued requests when their signal is cancelled", async () => {
    const coordinator = new GitHubRequestCoordinator(1);
    let releaseActiveRequest: (() => void) | undefined;
    const activeRequest = coordinator.run(
      () =>
        new Promise<void>((resolve) => {
          releaseActiveRequest = resolve;
        }),
      new AbortController().signal,
    );
    const queuedAbortController = new AbortController();
    const queuedRequest = coordinator.run(
      () => Promise.resolve(undefined),
      queuedAbortController.signal,
    );
    queuedAbortController.abort();

    await expect(queuedRequest).rejects.toMatchObject({ kind: "cancelled" });
    releaseActiveRequest?.();
    await activeRequest;
    expect(createGitHubCancellationError().kind).toBe("cancelled");
  });
});
