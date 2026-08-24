// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { parse: (canonicalUrl: string) => ({ toString: () => canonicalUrl }) },
  authentication: { getSession: vi.fn() },
}));

import type * as vscode from "vscode";
import type { CloudRepositoryIdentity } from "../../../src/domain/cloudGitProvider.js";
import {
  GitHubProvider,
  classifyPullRequestState,
  normalizePullRequestSummary,
  type GitHubAuthenticationApi,
  type GitHubGraphqlClient,
} from "../../../src/extension/providers/github/index.js";

const dashboardFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../fixtures/github/dashboard.json"),
    "utf8",
  ),
) as { readonly data: Record<string, unknown> };
const detailsFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../fixtures/github/details.json"),
    "utf8",
  ),
) as { readonly data: Record<string, unknown> };

const repositoryIdentity: CloudRepositoryIdentity = {
  providerId: "github",
  owner: "octocat",
  repositoryName: "Hello-World",
};
const connection = {
  providerId: "github" as const,
  sessionId: "session-1",
  accessToken: "opaque-token",
  acquisitionGeneration: 1,
};

function createCancellationToken(): vscode.CancellationToken & {
  cancel: () => void;
} {
  let cancellationHandler: (() => void) | undefined;
  let cancellationRequested = false;
  return {
    get isCancellationRequested() {
      return cancellationRequested;
    },
    onCancellationRequested(handler: () => void) {
      cancellationHandler = handler;
      return {
        dispose: () => {
          cancellationHandler = undefined;
        },
      };
    },
    cancel() {
      cancellationRequested = true;
      cancellationHandler?.();
    },
  } as vscode.CancellationToken & { cancel: () => void };
}

function createAuthentication(): {
  authentication: GitHubAuthenticationApi;
  getSessionMock: ReturnType<typeof vi.fn>;
} {
  const getSessionMock = vi.fn(() =>
    Promise.resolve({
      id: "session-1",
      accessToken: "opaque-token",
      account: { id: "account-1", label: "Octocat" },
      scopes: ["repo", "read:user"],
    }),
  );
  return { authentication: { getSession: getSessionMock }, getSessionMock };
}

function createGraphqlClient(
  queryResponses: readonly Record<string, unknown>[] = [dashboardFixture.data],
): {
  client: GitHubGraphqlClient;
  calls: Array<{ query: string; parameters: unknown }>;
} {
  let responseIndex = 0;
  const calls: Array<{
    query: string;
    parameters: Readonly<Record<string, unknown>>;
  }> = [];
  const client: GitHubGraphqlClient = (query, parameters) => {
    calls.push({ query, parameters });
    const response = query.includes("GitHubPullRequestDetails")
      ? detailsFixture.data
      : (queryResponses[Math.min(responseIndex++, queryResponses.length - 1)] ??
        dashboardFixture.data);
    return Promise.resolve(response);
  };
  return { client, calls };
}

describe("GitHubProvider", () => {
  it("classifies an outstanding review requirement as blocked", () => {
    expect(
      classifyPullRequestState(
        false,
        "REVIEW_REQUIRED",
        "MERGEABLE",
        "CLEAN",
        "SUCCESS",
      ),
    ).toBe("blocked");
    expect(
      classifyPullRequestState(false, "", "UNKNOWN", "CLEAN", "SUCCESS"),
    ).toBe("checksRunning");
  });

  it("requests only repo and read:user scopes and keeps the token in the connection", async () => {
    const { authentication, getSessionMock } = createAuthentication();
    const provider = new GitHubProvider({ authentication });
    const cancellationToken = createCancellationToken();

    await expect(provider.connect(cancellationToken)).resolves.toEqual(
      connection,
    );
    expect(getSessionMock).toHaveBeenCalledWith(
      "github",
      ["repo", "read:user"],
      {
        clearSessionPreference: true,
        createIfNone: {
          detail:
            "VS Code will grant Git'o repo and read:user scopes. GitHub's repo scope can grant access broader than Git'o's read-only GitHub API operations; Git'o uses these scopes only for read-only operations.",
        },
      },
    );
  });

  it("silently resumes the preferred session without opening an auth prompt", async () => {
    const { authentication, getSessionMock } = createAuthentication();
    const provider = new GitHubProvider({ authentication });

    await expect(
      provider.connectSilently(createCancellationToken()),
    ).resolves.toEqual(connection);
    expect(getSessionMock).toHaveBeenCalledWith(
      "github",
      ["repo", "read:user"],
      { silent: true, clearSessionPreference: false },
    );
  });

  it("rejects cancellation observed immediately after authentication resolves", async () => {
    let cancellationCheckCount = 0;
    const cancellationToken = {
      get isCancellationRequested(): boolean {
        cancellationCheckCount += 1;
        return cancellationCheckCount >= 2;
      },
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as vscode.CancellationToken;
    const { authentication } = createAuthentication();
    const provider = new GitHubProvider({ authentication });

    await expect(provider.connect(cancellationToken)).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(cancellationCheckCount).toBeGreaterThanOrEqual(2);
  });

  it("rejects a provider session that omits a requested scope", async () => {
    const authentication: GitHubAuthenticationApi = {
      getSession: vi.fn(() =>
        Promise.resolve({
          id: "session-1",
          accessToken: "opaque-token",
          account: { id: "account-1", label: "Octocat" },
          scopes: ["read:user"],
        }),
      ),
    };
    const provider = new GitHubProvider({ authentication });

    await expect(
      provider.connect(createCancellationToken()),
    ).rejects.toMatchObject({
      kind: "authentication",
    });
  });

  it("explains the read-only scope requirement when access is denied", async () => {
    const authentication: GitHubAuthenticationApi = {
      getSession: vi.fn(() => Promise.resolve(undefined)),
    };
    const provider = new GitHubProvider({ authentication });

    await expect(
      provider.connect(createCancellationToken()),
    ).rejects.toMatchObject({
      kind: "authentication",
      message:
        "GitHub access was not granted. Git'o needs VS Code's repo and read:user scopes for read-only GitHub API operations.",
    });
  });

  it("normalizes selected-repository GraphQL data and serves the 60-second cache", async () => {
    const { client, calls } = createGraphqlClient();
    let currentTime = new Date("2030-01-01T00:00:00Z");
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      canonicalUriFactory: (canonicalUrl) =>
        ({ toString: () => canonicalUrl }) as vscode.Uri,
      now: () => currentTime,
    });
    const abortController = new AbortController();

    const firstSnapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );
    const cachedSnapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );

    expect(firstSnapshot.cacheStatus).toBe("fresh");
    expect(
      firstSnapshot.pullRequests.map(({ pullRequestNumber, state }) => ({
        pullRequestNumber,
        state,
      })),
    ).toEqual([
      { pullRequestNumber: 42, state: "ready" },
      { pullRequestNumber: 43, state: "changesRequested" },
      { pullRequestNumber: 44, state: "draft" },
    ]);
    expect(
      firstSnapshot.pullRequests.map(
        ({ pullRequestNumber, completedReviewCount, requiredReviewCount }) => ({
          pullRequestNumber,
          completedReviewCount,
          requiredReviewCount,
        }),
      ),
    ).toEqual([
      {
        pullRequestNumber: 42,
        completedReviewCount: 1,
        requiredReviewCount: 1,
      },
      {
        pullRequestNumber: 43,
        completedReviewCount: 0,
        requiredReviewCount: 2,
      },
      {
        pullRequestNumber: 44,
        completedReviewCount: 0,
        requiredReviewCount: 0,
      },
    ]);
    expect(cachedSnapshot).toEqual(firstSnapshot);
    expect(calls).toHaveLength(1);

    currentTime = new Date("2030-01-01T00:00:59Z");
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
      { forceRefresh: true },
    );
    expect(calls).toHaveLength(2);

    currentTime = new Date("2030-01-01T00:01:59Z");
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );
    expect(calls).toHaveLength(3);
  });

  it("reports expiry from the provider-owned dashboard cache entry", async () => {
    const { client } = createGraphqlClient();
    let currentTime = new Date("2030-01-01T00:00:00Z");
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      now: () => currentTime,
    });
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
    );

    expect(
      provider.isRepositoryDashboardCacheExpired(
        repositoryIdentity,
        connection.sessionId,
      ),
    ).toBe(false);
    currentTime = new Date("2030-01-01T00:01:00Z");
    expect(
      provider.isRepositoryDashboardCacheExpired(
        repositoryIdentity,
        connection.sessionId,
      ),
    ).toBe(true);
  });

  it("rejects an aborted signal before returning cached dashboard data", async () => {
    const { client, calls } = createGraphqlClient();
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    const firstRequest = new AbortController();
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      firstRequest.signal,
    );
    const abortedRequest = new AbortController();
    abortedRequest.abort();

    await expect(
      provider.getRepositoryDashboard(
        repositoryIdentity,
        connection,
        abortedRequest.signal,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(calls).toHaveLength(1);
  });

  it("rejects a declared response that exceeds the GitHub byte cap", async () => {
    const oversizedDetails = structuredClone(detailsFixture.data) as {
      repository: { pullRequest: { body: string } };
    };
    oversizedDetails.repository.pullRequest.body = "x".repeat(256);
    const responseBody = JSON.stringify({ data: oversizedDetails });
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        new Response(responseBody, {
          headers: {
            "content-type": "application/json",
            "content-length": String(
              new TextEncoder().encode(responseBody).byteLength,
            ),
          },
        }),
      ),
    );
    const provider = new GitHubProvider({
      fetchImplementation,
      maxResponseBytes: 64,
    });

    await expect(
      provider.getPullRequestDetails(
        {
          providerId: "github",
          repositoryOwner: "octocat",
          repositoryName: "Hello-World",
          pullRequestNumber: 42,
        },
        connection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "invalidResponse" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects a streamed response when the GitHub byte cap is crossed", async () => {
    const oversizedDetails = structuredClone(detailsFixture.data) as {
      repository: { pullRequest: { body: string } };
    };
    oversizedDetails.repository.pullRequest.body = "x".repeat(256);
    const responseBytes = new TextEncoder().encode(
      JSON.stringify({ data: oversizedDetails }),
    );
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(responseBytes);
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = new GitHubProvider({
      fetchImplementation,
      maxResponseBytes: 64,
    });

    await expect(
      provider.getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "invalidResponse" });
  });

  it("rejects cancellation observed after the final streamed read", async () => {
    const abortController = new AbortController();
    const responseBytes = new TextEncoder().encode(
      JSON.stringify({ data: dashboardFixture.data }),
    );
    const responseReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: responseBytes })
        .mockImplementationOnce(() => {
          abortController.abort();
          return Promise.resolve({ done: true, value: undefined });
        }),
      cancel: vi.fn(() => Promise.resolve()),
      releaseLock: vi.fn(),
    };
    const fetchImplementation = vi.fn(() =>
      Promise.resolve({
        body: { getReader: () => responseReader },
        headers: new Headers(),
        status: 200,
        statusText: "OK",
      } as unknown as Response),
    );
    const provider = new GitHubProvider({ fetchImplementation });

    await expect(
      provider.getRepositoryDashboard(
        repositoryIdentity,
        connection,
        abortController.signal,
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(responseReader.read).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation through the bounded GitHub fetch", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImplementation = vi.fn(
      async (_requestInput: RequestInfo | URL, requestInit?: RequestInit) => {
        requestSignal = requestInit?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestInit?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        });
      },
    );
    const provider = new GitHubProvider({ fetchImplementation });
    const abortController = new AbortController();
    const dashboardPromise = provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    abortController.abort();

    await expect(dashboardPromise).rejects.toMatchObject({ kind: "cancelled" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("bounds dashboard and generation state across repository identities", async () => {
    const { client } = createGraphqlClient();
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      canonicalUriFactory: (canonicalUrl) =>
        ({ toString: () => canonicalUrl }) as vscode.Uri,
    });

    for (let repositoryIndex = 0; repositoryIndex < 300; repositoryIndex += 1) {
      await provider.getRepositoryDashboard(
        {
          providerId: "github",
          owner: `owner-${repositoryIndex}`,
          repositoryName: "Hello-World",
        },
        connection,
        new AbortController().signal,
      );
    }

    const providerState = provider as unknown as {
      dashboardCache: Map<string, unknown>;
      dashboardRequestGenerations: Map<string, number>;
    };
    expect(providerState.dashboardCache.size).toBeLessThanOrEqual(64);
    expect(providerState.dashboardRequestGenerations.size).toBeLessThanOrEqual(
      256,
    );
  });

  it("rejects an evicted request after its identity is reintroduced", async () => {
    const evictedOwner = "evicted-owner";
    const pendingResponses: Array<(response: unknown) => void> = [];
    const reintroducedResponse = structuredClone(dashboardFixture.data);
    const reintroducedRepository = reintroducedResponse.repository as {
      pullRequests: { nodes: Array<{ title: string }> };
    };
    reintroducedRepository.pullRequests.nodes[0]!.title =
      "Reintroduced refresh";
    const client: GitHubGraphqlClient = (query, parameters) => {
      if (query.includes("GitHubPullRequestDetails")) {
        return Promise.resolve(detailsFixture.data);
      }
      const owner = (parameters as { readonly owner?: unknown }).owner;
      if (owner === evictedOwner) {
        return new Promise((resolveResponse) => {
          pendingResponses.push(resolveResponse);
        });
      }
      return Promise.resolve(dashboardFixture.data);
    };
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    const requestSignal = new AbortController().signal;
    const firstRequest = provider.getRepositoryDashboard(
      {
        providerId: "github",
        owner: evictedOwner,
        repositoryName: "Hello-World",
      },
      connection,
      requestSignal,
      { forceRefresh: true },
    );
    await vi.waitFor(() => expect(pendingResponses).toHaveLength(1));

    for (let repositoryIndex = 0; repositoryIndex < 256; repositoryIndex += 1) {
      await provider.getRepositoryDashboard(
        {
          providerId: "github",
          owner: `owner-${repositoryIndex}`,
          repositoryName: "Hello-World",
        },
        connection,
        requestSignal,
      );
    }

    const providerState = provider as unknown as {
      dashboardRequestGenerations: Map<string, number>;
    };
    expect(
      [...providerState.dashboardRequestGenerations.keys()].some((key) =>
        key.includes(`${evictedOwner}:hello-world`),
      ),
    ).toBe(false);

    const secondRequest = provider.getRepositoryDashboard(
      {
        providerId: "github",
        owner: evictedOwner,
        repositoryName: "Hello-World",
      },
      connection,
      requestSignal,
      { forceRefresh: true },
    );
    await vi.waitFor(() => expect(pendingResponses).toHaveLength(2));
    pendingResponses[1]!(reintroducedResponse);
    await secondRequest;
    pendingResponses[0]!(dashboardFixture.data);
    await expect(firstRequest).rejects.toMatchObject({
      kind: "staleResponse",
    });

    const cachedSnapshot = await provider.getRepositoryDashboard(
      {
        providerId: "github",
        owner: evictedOwner,
        repositoryName: "Hello-World",
      },
      connection,
      requestSignal,
    );
    expect(cachedSnapshot.pullRequests[0]?.title).toBe("Reintroduced refresh");
  });

  it("returns stale normalized data for transient failures and retains rate-limit metadata", async () => {
    const { client } = createGraphqlClient();
    let shouldFail = false;
    const failingClient: GitHubGraphqlClient = (query, parameters) => {
      if (shouldFail) {
        const rateLimitError = Object.assign(new Error("rate limited"), {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1893456000",
            },
          },
        });
        return Promise.reject(rateLimitError);
      }
      return client(query, parameters);
    };
    const provider = new GitHubProvider({
      graphqlClientFactory: () => failingClient,
      now: () => new Date("2030-01-01T00:02:00Z"),
    });
    const abortController = new AbortController();
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );
    shouldFail = true;
    const staleSnapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
      { forceRefresh: true },
    );

    expect(staleSnapshot.cacheStatus).toBe("stale");
    expect(staleSnapshot.staleReason).toBe("rateLimit");
    expect(staleSnapshot.rateLimit?.remaining).toBe(0);
  });

  it("does not let an older refresh overwrite a newer normalized snapshot", async () => {
    const pendingResponses: Array<(response: unknown) => void> = [];
    const firstResponse = structuredClone(dashboardFixture.data);
    const secondResponse = structuredClone(dashboardFixture.data);
    const secondRepository = secondResponse.repository as {
      pullRequests: { nodes: Array<{ title: string }> };
    };
    secondRepository.pullRequests.nodes[0]!.title = "Newer refresh";
    const client: GitHubGraphqlClient = () =>
      new Promise((resolveResponse) => {
        pendingResponses.push(resolveResponse);
      });
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    const firstRefresh = provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
      { forceRefresh: true },
    );
    const secondRefresh = provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
      { forceRefresh: true },
    );
    await Promise.resolve();
    expect(pendingResponses).toHaveLength(2);
    pendingResponses[1]!(secondResponse);
    await secondRefresh;
    pendingResponses[0]!(firstResponse);
    await expect(firstRefresh).rejects.toMatchObject({
      kind: "staleResponse",
    });

    const cachedSnapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
    );
    expect(cachedSnapshot.pullRequests[0]?.title).toBe("Newer refresh");
  });

  it("disconnect clears dashboard data, invalidates details, and retains no token", async () => {
    let dashboardRequestCount = 0;
    let resolveDetails:
      ((response: Record<string, unknown>) => void) | undefined;
    const client: GitHubGraphqlClient = (query) => {
      if (query.includes("GitHubPullRequestDetails")) {
        return new Promise<Record<string, unknown>>((resolveResponse) => {
          resolveDetails = resolveResponse;
        });
      }
      dashboardRequestCount += 1;
      return Promise.resolve(dashboardFixture.data);
    };
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
    });
    const requestSignal = new AbortController().signal;

    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      requestSignal,
    );
    provider.disconnect();
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      requestSignal,
    );
    expect(dashboardRequestCount).toBe(2);
    provider.disconnect();
    await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      requestSignal,
    );
    expect(dashboardRequestCount).toBe(3);

    const detailPromise = provider.getPullRequestDetails(
      {
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      },
      connection,
      requestSignal,
    );
    await Promise.resolve();
    expect(resolveDetails).toBeDefined();
    provider.disconnect();
    resolveDetails?.(detailsFixture.data);
    await expect(detailPromise).rejects.toMatchObject({
      kind: "staleResponse",
    });

    expect(Object.getOwnPropertyNames(provider)).not.toContain("accessToken");
    expect(JSON.stringify(provider)).not.toContain(connection.accessToken);
  });

  it("normalizes details and reconstructs a canonical GitHub URL", async () => {
    const { client } = createGraphqlClient();
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      canonicalUriFactory: (canonicalUrl) =>
        ({ toString: () => canonicalUrl }) as vscode.Uri,
    });
    const details = await provider.getPullRequestDetails(
      {
        providerId: "github",
        repositoryOwner: "octocat",
        repositoryName: "Hello-World",
        pullRequestNumber: 42,
      },
      connection,
      new AbortController().signal,
    );

    expect(details.bodyText).toContain("Review the dashboard");
    expect(details.sourceBranchName).toBe("feature/dashboard");
    expect(details.canonicalUrl).toBe(
      "https://github.com/octocat/Hello-World/pull/42",
    );
    expect(
      provider
        .getCanonicalUrl({
          ...repositoryIdentity,
        })
        .toString(),
    ).toBe("https://github.com/octocat/Hello-World");
  });

  it("applies the aggregate review budget to pull-request details", async () => {
    let reviewPageRequestCount = 0;
    const client: GitHubGraphqlClient = (query) => {
      if (query.includes("GitHubPullRequestDetails")) {
        const detailsWithNestedPage = structuredClone(detailsFixture.data) as {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
        };
        detailsWithNestedPage.repository.pullRequest.reviews.pageInfo = {
          hasNextPage: true,
          endCursor: "review-cursor-1",
        };
        return Promise.resolve(detailsWithNestedPage);
      }
      if (query.includes("GitHubPullRequestReviewPage")) {
        reviewPageRequestCount += 1;
        return Promise.resolve({
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: {
                  hasNextPage: true,
                  endCursor: `review-cursor-${reviewPageRequestCount + 1}`,
                },
                nodes: Array.from({ length: 100 }, (_, reviewIndex) => ({
                  author: {
                    login: `reviewer-${reviewPageRequestCount}-${reviewIndex}`,
                  },
                  state: "APPROVED",
                  submittedAt: "2030-01-01T00:00:00Z",
                })),
              },
            },
          },
        });
      }
      return Promise.reject(new Error("unexpected GitHub query"));
    };
    const provider = new GitHubProvider({ graphqlClientFactory: () => client });

    await expect(
      provider.getPullRequestDetails(
        {
          providerId: "github",
          repositoryOwner: "octocat",
          repositoryName: "Hello-World",
          pullRequestNumber: 42,
        },
        connection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      kind: "paginationIncomplete",
      partialDataDisabled: true,
    });
    expect(reviewPageRequestCount).toBe(41);
  });

  it("cancels sibling review enrichment after the first fatal dashboard failure", async () => {
    const dashboardWithTwoReviewPages = structuredClone(
      dashboardFixture.data,
    ) as {
      repository: {
        pullRequests: {
          nodes: Array<{
            reviews: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          }>;
        };
      };
    };
    dashboardWithTwoReviewPages.repository.pullRequests.nodes[0]!.reviews.pageInfo =
      {
        hasNextPage: true,
        endCursor: "review-cursor-42",
      };
    dashboardWithTwoReviewPages.repository.pullRequests.nodes[1]!.reviews.pageInfo =
      {
        hasNextPage: true,
        endCursor: "review-cursor-43",
      };
    const siblingRequestSignals: AbortSignal[] = [];
    const client: GitHubGraphqlClient = (query, parameters) => {
      const requestSignal = (
        parameters.request as { readonly signal?: AbortSignal } | undefined
      )?.signal;
      if (!requestSignal) {
        return Promise.reject(new Error("GitHub request signal missing"));
      }
      if (query.includes("GitHubRepositoryDashboard")) {
        return Promise.resolve(dashboardWithTwoReviewPages);
      }
      if (query.includes("GitHubPullRequestReviewPage")) {
        if (parameters.pullRequestNumber === 42) {
          return Promise.reject(
            Object.assign(new Error("GitHub server failure"), { status: 500 }),
          );
        }
        siblingRequestSignals.push(requestSignal);
        return new Promise<never>((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("sibling request aborted"), {
                  name: "AbortError",
                }),
              ),
            { once: true },
          );
        });
      }
      return Promise.reject(new Error("unexpected GitHub query"));
    };
    const provider = new GitHubProvider({ graphqlClientFactory: () => client });

    await expect(
      provider.getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "server" });
    expect(siblingRequestSignals).toHaveLength(1);
    expect(siblingRequestSignals[0]?.aborted).toBe(true);
  });

  it("passes AbortSignal through the request boundary", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client: GitHubGraphqlClient = async (
      _query: string,
      parameters: Readonly<Record<string, unknown>>,
    ) => {
      const requestOptions = parameters.request as
        { readonly signal?: AbortSignal } | undefined;
      const requestSignal = requestOptions?.signal;
      if (!requestSignal) {
        throw new Error("request signal missing");
      }
      receivedSignal = requestSignal;
      await new Promise<never>((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
      throw new Error("unreachable");
    };
    const provider = new GitHubProvider({ graphqlClientFactory: () => client });
    const abortController = new AbortController();
    const dashboardPromise = provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );
    abortController.abort();

    await expect(dashboardPromise).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(abortController.signal);
  });

  it("fails a hanging request at the configured deadline", async () => {
    const client: GitHubGraphqlClient = () => new Promise(() => undefined);
    const provider = new GitHubProvider({
      graphqlClientFactory: () => client,
      requestTimeoutMs: 10,
    });

    await expect(
      provider.getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps GraphQL authorization errors returned in a successful HTTP body", async () => {
    const client: GitHubGraphqlClient = () =>
      Promise.resolve({
        data: { repository: null },
        errors: [{ type: "FORBIDDEN", message: "repository policy" }],
      });
    const provider = new GitHubProvider({ graphqlClientFactory: () => client });

    await expect(
      provider.getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("counts the latest submitted review and leaves re-requested approvals incomplete", () => {
    const summary = normalizePullRequestSummary(
      {
        number: 42,
        title: "Review",
        updatedAt: "2030-01-01T00:00:00Z",
        isDraft: false,
        author: { login: "author", name: "Author" },
        comments: { totalCount: 0 },
        reviewDecision: "REVIEW_REQUIRED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: { state: "SUCCESS" },
        reviewRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ requestedReviewer: { login: "reviewer" } }],
        },
        reviews: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "reviewer" },
              state: "APPROVED",
              submittedAt: "2030-01-01T00:00:00Z",
            },
            {
              author: { login: "reviewer" },
              state: "CHANGES_REQUESTED",
              submittedAt: "2030-01-02T00:00:00Z",
            },
          ],
        },
      },
      repositoryIdentity,
      "author",
    );

    expect(summary.completedReviewCount).toBe(0);
    expect(summary.requiredReviewCount).toBe(2);
    expect(summary.state).toBe("blocked");
  });
});
