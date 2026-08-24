// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

vi.mock("vscode", () => ({
  Uri: { parse: (canonicalUrl: string) => ({ toString: () => canonicalUrl }) },
  authentication: { getSession: vi.fn() },
}));

import type { CloudRepositoryIdentity } from "../../../src/domain/cloudGitProvider.js";
import {
  GitHubProvider,
  GitHubProviderError,
} from "../../../src/extension/providers/github/index.js";

const dashboardFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../fixtures/github/dashboard.json"),
    "utf8",
  ),
) as { data: Record<string, unknown> };
const detailsFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../fixtures/github/details.json"),
    "utf8",
  ),
) as { data: Record<string, unknown> };

const repositoryIdentity: CloudRepositoryIdentity = {
  providerId: "github",
  owner: "octocat",
  repositoryName: "Hello-World",
};
const connection = {
  providerId: "github" as const,
  sessionId: "contract-session",
  accessToken: "contract-token",
};

function createGraphqlResponse(data: Record<string, unknown>): Response {
  return HttpResponse.json({ data });
}

const server = setupServer(
  http.post("https://api.github.com/graphql", async ({ request }) => {
    const requestBody = (await request.json()) as {
      readonly query?: string;
      readonly variables?: Record<string, unknown>;
    };
    if (requestBody.query?.includes("GitHubPullRequestDetails")) {
      return createGraphqlResponse(detailsFixture.data);
    }
    return createGraphqlResponse(dashboardFixture.data);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("GitHub GraphQL contract", () => {
  it("uses Octokit GraphQL against github.com and sends only the selected repository", async () => {
    let receivedVariables: Record<string, unknown> | undefined;
    let receivedQuery = "";
    let receivedRequestUrl = "";
    let receivedAuthorization = "";
    let receivedRequestBody = "";
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        receivedRequestUrl = request.url;
        receivedAuthorization = request.headers.get("authorization") ?? "";
        receivedRequestBody = await request.text();
        const requestBody = JSON.parse(receivedRequestBody) as {
          readonly query?: string;
          readonly variables?: Record<string, unknown>;
        };
        receivedQuery = requestBody.query ?? "";
        receivedVariables = requestBody.variables;
        return createGraphqlResponse(dashboardFixture.data);
      }),
    );
    const provider = new GitHubProvider();

    const snapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
    );

    expect(snapshot.pullRequests).toHaveLength(3);
    expect(receivedVariables).toEqual({
      owner: "octocat",
      repository: "Hello-World",
      pullRequestCursor: null,
    });
    expect(receivedQuery).not.toContain("          body");
    expect(receivedRequestUrl).toBe("https://api.github.com/graphql");
    expect(receivedAuthorization).toBe(`Bearer ${connection.accessToken}`);
    expect(receivedRequestUrl).not.toContain(connection.accessToken);
    expect(receivedRequestBody).not.toContain(connection.accessToken);
    expect(JSON.stringify(provider)).not.toContain(connection.accessToken);
  });

  it("derives canonical output from identity when GitHub payload URLs are hostile", async () => {
    const hostileDashboardData = structuredClone(dashboardFixture.data) as {
      repository: {
        pullRequests: { nodes: Array<{ url?: string }> };
      };
    };
    for (const pullRequestNode of hostileDashboardData.repository.pullRequests
      .nodes) {
      pullRequestNode.url = "https://evil.example/redirect/dashboard";
    }
    const hostileDetailsData = structuredClone(detailsFixture.data) as {
      repository: { pullRequest: { url?: string } };
    };
    hostileDetailsData.repository.pullRequest.url =
      "https://evil.example/redirect/details";
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const requestBody = (await request.json()) as {
          readonly query?: string;
        };
        return createGraphqlResponse(
          requestBody.query?.includes("GitHubPullRequestDetails")
            ? hostileDetailsData
            : hostileDashboardData,
        );
      }),
    );
    const provider = new GitHubProvider();

    const dashboard = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
    );
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

    expect(dashboard.repositoryRoot).toBe(
      "https://github.com/octocat/Hello-World",
    );
    expect(details.canonicalUrl).toBe(
      "https://github.com/octocat/Hello-World/pull/42",
    );
  });

  it("follows bounded pull-request pagination", async () => {
    let requestCount = 0;
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        requestCount += 1;
        const requestBody = (await request.json()) as {
          readonly variables?: { readonly pullRequestCursor?: string | null };
        };
        const firstPage = requestBody.variables?.pullRequestCursor === null;
        const firstPageData = structuredClone(dashboardFixture.data);
        const firstPageRepository = firstPageData["repository"] as {
          pullRequests: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: readonly unknown[];
          };
        };
        firstPageRepository.pullRequests.pageInfo = firstPage
          ? { hasNextPage: true, endCursor: "cursor-2" }
          : { hasNextPage: false, endCursor: null };
        if (!firstPage) {
          firstPageRepository.pullRequests.nodes =
            firstPageRepository.pullRequests.nodes.slice(0, 1);
        }
        return createGraphqlResponse(firstPageData);
      }),
    );
    const provider = new GitHubProvider();

    const snapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
    );

    expect(requestCount).toBe(2);
    expect(snapshot.pullRequests).toHaveLength(4);
  });

  it("fails closed before retaining an unbounded dashboard pull-request stream", async () => {
    let dashboardRequestCount = 0;
    server.use(
      http.post("https://api.github.com/graphql", () => {
        dashboardRequestCount += 1;
        const pageData = structuredClone(dashboardFixture.data) as {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<Record<string, unknown>>;
            };
          };
        };
        const basePullRequestNode = pageData.repository.pullRequests.nodes[0]!;
        pageData.repository.pullRequests.nodes = Array.from(
          { length: 100 },
          (_, pullRequestIndex) => {
            const pullRequestNode = structuredClone(basePullRequestNode);
            pullRequestNode.number = pullRequestIndex + 1;
            pullRequestNode.reviewRequests = {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            };
            pullRequestNode.reviews = {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            };
            return pullRequestNode;
          },
        );
        pageData.repository.pullRequests.pageInfo = {
          hasNextPage: true,
          endCursor: `pull-request-cursor-${dashboardRequestCount + 1}`,
        };
        return createGraphqlResponse(pageData);
      }),
    );
    const provider = new GitHubProvider();

    const error = await provider
      .getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      )
      .catch((requestError: unknown) => requestError);

    expect(error).toMatchObject({
      kind: "paginationIncomplete",
      partialDataDisabled: true,
    });
    expect(dashboardRequestCount).toBe(41);
  });

  it("fails closed before retaining an unbounded nested-review stream", async () => {
    let reviewPageRequestCount = 0;
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const requestBody = (await request.json()) as {
          readonly query?: string;
        };
        if (requestBody.query?.includes("GitHubPullRequestReviewPage")) {
          reviewPageRequestCount += 1;
          return createGraphqlResponse({
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
        const dashboardWithNestedPage = structuredClone(
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
        dashboardWithNestedPage.repository.pullRequests.nodes[0]!.reviews.pageInfo =
          {
            hasNextPage: true,
            endCursor: "review-cursor-1",
          };
        return createGraphqlResponse(dashboardWithNestedPage);
      }),
    );
    const provider = new GitHubProvider();

    const error = await provider
      .getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      )
      .catch((requestError: unknown) => requestError);

    expect(error).toMatchObject({
      kind: "paginationIncomplete",
      partialDataDisabled: true,
    });
    expect(reviewPageRequestCount).toBe(41);
  });

  it("maps HTTP rate limits and unauthorized responses without exposing response text", async () => {
    server.use(
      http.post(
        "https://api.github.com/graphql",
        () =>
          new HttpResponse(
            JSON.stringify({ message: "private response body" }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4999",
              },
            },
          ),
      ),
    );
    const provider = new GitHubProvider();

    const error = await provider
      .getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      )
      .catch((requestError: unknown) => requestError);

    expect(error).toBeInstanceOf(GitHubProviderError);
    expect(error).toMatchObject({ kind: "unauthorized", statusCode: 401 });
    expect((error as Error).message).not.toContain("private response body");
  });

  it.each([
    [403, "forbidden", {}],
    [404, "notFound", {}],
    [429, "rateLimit", { "x-ratelimit-remaining": "0" }],
    [500, "server", {}],
  ] as const)(
    "maps HTTP %s to %s",
    async (statusCode, expectedKind, extraHeaders) => {
      server.use(
        http.post(
          "https://api.github.com/graphql",
          () =>
            new HttpResponse(JSON.stringify({ message: "provider failure" }), {
              status: statusCode,
              headers: {
                "content-type": "application/json",
                ...extraHeaders,
              },
            }),
        ),
      );
      const provider = new GitHubProvider();

      const error = await provider
        .getRepositoryDashboard(
          repositoryIdentity,
          connection,
          new AbortController().signal,
        )
        .catch((requestError: unknown) => requestError);

      expect(error).toBeInstanceOf(GitHubProviderError);
      expect(error).toMatchObject({ kind: expectedKind, statusCode });
    },
  );

  it("completes nested review pagination before normalizing", async () => {
    let reviewPageRequestCount = 0;
    const reviewPageCursors: Array<{
      readonly reviewRequestsCursor: string | null;
      readonly reviewsCursor: string | null;
    }> = [];
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const requestBody = (await request.json()) as {
          readonly query?: string;
          readonly variables?: {
            readonly reviewRequestsCursor?: string | null;
            readonly reviewsCursor?: string | null;
          };
        };
        if (requestBody.query?.includes("GitHubPullRequestReviewPage")) {
          reviewPageCursors.push({
            reviewRequestsCursor:
              requestBody.variables?.reviewRequestsCursor ?? null,
            reviewsCursor: requestBody.variables?.reviewsCursor ?? null,
          });
          reviewPageRequestCount += 1;
          const hasNextPage = reviewPageRequestCount === 1;
          const nextPageSuffix = reviewPageRequestCount + 2;
          return createGraphqlResponse({
            repository: {
              pullRequest: {
                reviewRequests: {
                  pageInfo: {
                    hasNextPage,
                    endCursor: hasNextPage
                      ? `review-request-cursor-${nextPageSuffix}`
                      : null,
                  },
                  nodes: [
                    {
                      requestedReviewer: {
                        login: `review-request-${nextPageSuffix}`,
                      },
                    },
                  ],
                },
                reviews: {
                  pageInfo: {
                    hasNextPage,
                    endCursor: hasNextPage
                      ? `review-cursor-${nextPageSuffix}`
                      : null,
                  },
                  nodes: [
                    {
                      author: { login: `reviewer-${nextPageSuffix}` },
                      state: "APPROVED",
                    },
                  ],
                },
              },
            },
          });
        }
        const dashboardWithNestedPage = structuredClone(dashboardFixture.data);
        const repositoryRecord = dashboardWithNestedPage.repository as {
          pullRequests: {
            nodes: Array<{
              reviewRequests: {
                pageInfo: {
                  hasNextPage: boolean;
                  endCursor: string | null;
                };
              };
              reviews: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            }>;
          };
        };
        repositoryRecord.pullRequests.nodes[0]!.reviewRequests.pageInfo = {
          hasNextPage: true,
          endCursor: "review-request-cursor-2",
        };
        repositoryRecord.pullRequests.nodes[0]!.reviews.pageInfo = {
          hasNextPage: true,
          endCursor: "review-cursor-2",
        };
        return createGraphqlResponse(dashboardWithNestedPage);
      }),
    );
    const provider = new GitHubProvider();

    const snapshot = await provider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      new AbortController().signal,
    );

    expect(reviewPageRequestCount).toBe(2);
    expect(reviewPageCursors).toEqual([
      {
        reviewRequestsCursor: "review-request-cursor-2",
        reviewsCursor: "review-cursor-2",
      },
      {
        reviewRequestsCursor: "review-request-cursor-3",
        reviewsCursor: "review-cursor-3",
      },
    ]);
    const nestedPullRequestSummary = snapshot.pullRequests[0];
    expect(nestedPullRequestSummary).toMatchObject({
      pullRequestNumber: 42,
      completedReviewCount: 3,
      requiredReviewCount: 5,
    });
    // The fixture reports APPROVED, so nested pagination contributes only the
    // five known reviewer identities. REVIEW_REQUIRED is the only signal that
    // adds GitHub's otherwise-unidentified policy slot.
    expect(nestedPullRequestSummary?.requiredReviewCount).toBe(5);
  });

  it("fails closed at the nested review pagination cap", async () => {
    let reviewPageRequestCount = 0;
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const requestBody = (await request.json()) as {
          readonly query?: string;
        };
        if (requestBody.query?.includes("GitHubPullRequestReviewPage")) {
          reviewPageRequestCount += 1;
          return createGraphqlResponse({
            repository: {
              pullRequest: {
                reviewRequests: {
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: `review-request-cursor-${reviewPageRequestCount + 2}`,
                  },
                  nodes: [],
                },
                reviews: {
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: `review-cursor-${reviewPageRequestCount + 2}`,
                  },
                  nodes: [],
                },
              },
            },
          });
        }
        const dashboardWithNestedPage = structuredClone(dashboardFixture.data);
        const repositoryRecord = dashboardWithNestedPage.repository as {
          pullRequests: {
            nodes: Array<{
              reviewRequests: {
                pageInfo: {
                  hasNextPage: boolean;
                  endCursor: string | null;
                };
              };
              reviews: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            }>;
          };
        };
        repositoryRecord.pullRequests.nodes[0]!.reviewRequests.pageInfo = {
          hasNextPage: true,
          endCursor: "review-request-cursor-2",
        };
        repositoryRecord.pullRequests.nodes[0]!.reviews.pageInfo = {
          hasNextPage: true,
          endCursor: "review-cursor-2",
        };
        return createGraphqlResponse(dashboardWithNestedPage);
      }),
    );
    const provider = new GitHubProvider();

    const error = await provider
      .getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      )
      .catch((requestError: unknown) => requestError);

    expect(error).toMatchObject({
      kind: "paginationIncomplete",
      partialDataDisabled: true,
    });
    expect(reviewPageRequestCount).toBe(100);
  });

  it("fails explicitly when nested pagination has no cursor", async () => {
    server.use(
      http.post("https://api.github.com/graphql", () => {
        const malformedDashboard = structuredClone(dashboardFixture.data);
        const repositoryRecord = malformedDashboard.repository as {
          pullRequests: {
            nodes: Array<{
              reviews: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            }>;
          };
        };
        repositoryRecord.pullRequests.nodes[0]!.reviews.pageInfo = {
          hasNextPage: true,
          endCursor: null,
        };
        return createGraphqlResponse(malformedDashboard);
      }),
    );
    const provider = new GitHubProvider();

    const error = await provider
      .getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      )
      .catch((requestError: unknown) => requestError);

    expect(error).toMatchObject({
      kind: "paginationIncomplete",
      partialDataDisabled: true,
    });
  });

  it("normalizes timeout and cancellation as typed failures", async () => {
    const timeoutClient = () =>
      Promise.reject(
        Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
      );
    const timeoutProvider = new GitHubProvider({
      graphqlClientFactory: () => timeoutClient,
    });
    const timeoutError = await timeoutProvider
      .getRepositoryDashboard(
        repositoryIdentity,
        connection,
        new AbortController().signal,
      )
      .catch((requestError: unknown) => requestError);
    expect(timeoutError).toMatchObject({ kind: "timeout" });

    let requestSignal: AbortSignal | undefined;
    const cancellationClient = vi.fn(
      (_query: string, parameters: Readonly<Record<string, unknown>>) =>
        new Promise<never>((_resolve, reject) => {
          requestSignal = (
            parameters.request as { readonly signal: AbortSignal }
          ).signal;
          requestSignal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        }),
    );
    const cancellationProvider = new GitHubProvider({
      graphqlClientFactory: () => cancellationClient,
    });
    const abortController = new AbortController();
    const cancellationPromise = cancellationProvider.getRepositoryDashboard(
      repositoryIdentity,
      connection,
      abortController.signal,
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    abortController.abort();
    await expect(cancellationPromise).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(cancellationClient).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("loads read-only pull-request details from the selected repository", async () => {
    const provider = new GitHubProvider();
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

    expect(details.canonicalUrl).toBe(
      "https://github.com/octocat/Hello-World/pull/42",
    );
    expect(details.bodyText).toContain("Review the dashboard");
  });
});
