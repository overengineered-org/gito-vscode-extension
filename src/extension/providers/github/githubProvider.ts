import { GraphqlResponseError, graphql } from "@octokit/graphql";
import * as vscode from "vscode";
import type {
  CloudGitProvider,
  CloudRepositoryIdentity,
  CloudResourceIdentity,
  CloudUser,
  ProviderConnection,
  RepositoryDashboardOptions,
} from "../../../domain/cloudGitProvider.js";
import type {
  PullRequestDetails,
  PullRequestIdentity,
  PullRequestState,
  PullRequestSummary,
} from "../../../domain/pullRequest.js";
import {
  githubCurrentUserQuery,
  githubDashboardQuery,
  githubPullRequestDetailsQuery,
  githubPullRequestReviewPageQuery,
} from "./githubQueries.js";
import { parseGitHubRemote } from "./githubRemote.js";
import { GitHubRequestCoordinator } from "./githubRequestCoordinator.js";
import { AuthenticationSessionPreferenceTracker } from "../authenticationSessionPreference.js";
import {
  githubAuthenticationScopes,
  GitHubProviderError,
  type GitHubAuthenticationApi,
  type GitHubCanonicalUriFactory,
  type GitHubCurrentUser,
  type GitHubGraphqlClient,
  type GitHubProviderConnection,
  type GitHubProviderDependencies,
  type GitHubPullRequestDetails,
  type GitHubRepositoryDashboardSnapshot,
  type GitHubRepositoryIdentity,
  type GitHubRateLimitSnapshot,
} from "./githubTypes.js";

const githubApiBaseUrl = "https://api.github.com";
const defaultGitHubCacheTtlMilliseconds = 60_000;
const defaultMaximumConcurrentRequests = 4;
const maximumPaginationPages = 100;
const maximumGitHubReviewNodesPerPage = 100;
const maximumGitHubReviewNodes =
  (maximumPaginationPages + 1) * maximumGitHubReviewNodesPerPage;
// Keep one dashboard operation bounded even when every pull-request and
// nested-review page is returned successfully. The response cap below only
// bounds each GraphQL response, so it cannot protect the aggregate arrays.
const maximumGitHubDashboardAggregateResponseItems = 4_096;
const maximumGitHubDashboardAggregateResponseBytes = 16 * 1024 * 1024;
const maximumGitHubDashboardCacheEntries = 64;
const maximumGitHubGenerationEntries = 256;
const defaultMaximumGitHubResponseBytes = 2 * 1024 * 1024;
const githubAuthenticationScopeDisclosure =
  "VS Code will grant Git'o repo and read:user scopes. GitHub's repo scope can grant access broader than Git'o's read-only GitHub API operations; Git'o uses these scopes only for read-only operations.";
const defaultGitHubRequestTimeoutMs = 10_000;

interface GitHubSnapshotCacheEntry {
  readonly snapshot: GitHubRepositoryDashboardSnapshot;
  readonly expiresAtMilliseconds: number;
}

interface GitHubReviewRequestNode {
  readonly requestedReviewer?: {
    readonly login?: unknown;
    readonly slug?: unknown;
  } | null;
}

interface GitHubReviewNode {
  readonly author?: { readonly login?: unknown } | null;
  readonly state?: unknown;
  readonly submittedAt?: unknown;
}

interface GitHubReviewConnection<ReviewNode> {
  readonly nodes?: readonly (ReviewNode | null)[] | null;
  readonly pageInfo?: {
    readonly hasNextPage?: unknown;
    readonly endCursor?: unknown;
  } | null;
}

class GitHubAggregateOperationBudget {
  private consumedItemCount = 0;
  private consumedByteCount = 0;

  public reserve(responseItemCount: number, responseItems: unknown): void {
    if (!Number.isSafeInteger(responseItemCount) || responseItemCount < 0) {
      throw new GitHubProviderError(
        "invalidResponse",
        "GitHub returned an invalid dashboard response.",
        { partialDataDisabled: true },
      );
    }
    if (
      this.consumedItemCount + responseItemCount >
      maximumGitHubDashboardAggregateResponseItems
    ) {
      throw new GitHubProviderError(
        "paginationIncomplete",
        "GitHub returned more dashboard data than Git'o can safely load.",
        { partialDataDisabled: true },
      );
    }
    let serializedResponse = "";
    try {
      serializedResponse = JSON.stringify(responseItems) ?? "";
    } catch {
      throw new GitHubProviderError(
        "invalidResponse",
        "GitHub returned an invalid dashboard response.",
        { partialDataDisabled: true },
      );
    }
    const responseByteCount = new TextEncoder().encode(
      serializedResponse,
    ).byteLength;
    if (
      this.consumedByteCount + responseByteCount >
      maximumGitHubDashboardAggregateResponseBytes
    ) {
      throw new GitHubProviderError(
        "paginationIncomplete",
        "GitHub returned more dashboard data than Git'o can safely load.",
        { partialDataDisabled: true },
      );
    }
    this.consumedItemCount += responseItemCount;
    this.consumedByteCount += responseByteCount;
  }
}

class GitHubOperationCancellation {
  private readonly operationController = new AbortController();
  private readonly callerCancellationHandler = (): void => {
    this.operationController.abort();
  };
  private hasFailure = false;
  private operationFailure: unknown;

  public constructor(callerCancellationSignal: AbortSignal) {
    if (callerCancellationSignal.aborted) {
      this.operationController.abort();
    } else {
      callerCancellationSignal.addEventListener(
        "abort",
        this.callerCancellationHandler,
        { once: true },
      );
    }
  }

  public get signal(): AbortSignal {
    return this.operationController.signal;
  }

  public fail(error: unknown): void {
    if (!this.hasFailure) {
      this.hasFailure = true;
      this.operationFailure = error;
    }
    this.operationController.abort();
  }

  public throwIfFailed(): void {
    if (this.hasFailure) {
      throw this.operationFailure;
    }
  }

  public dispose(callerCancellationSignal: AbortSignal): void {
    callerCancellationSignal.removeEventListener(
      "abort",
      this.callerCancellationHandler,
    );
  }
}

interface GitHubPullRequestNode {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly updatedAt?: unknown;
  readonly isDraft?: unknown;
  readonly url?: unknown;
  readonly author?: {
    readonly login?: unknown;
    readonly name?: unknown;
  } | null;
  readonly comments?: { readonly totalCount?: unknown } | null;
  readonly reviewDecision?: unknown;
  readonly mergeable?: unknown;
  readonly mergeStateStatus?: unknown;
  readonly statusCheckRollup?: { readonly state?: unknown } | null;
  readonly reviewRequests?: GitHubReviewConnection<GitHubReviewRequestNode> | null;
  readonly reviews?: GitHubReviewConnection<GitHubReviewNode> | null;
  readonly headRefName?: unknown;
  readonly baseRefName?: unknown;
}

interface GitHubGraphqlErrorShape {
  readonly type?: unknown;
  readonly message?: unknown;
}

interface GitHubGraphqlFailureShape {
  readonly status?: unknown;
  readonly message?: unknown;
  readonly headers?: Record<string, unknown> | Headers;
  readonly response?: {
    readonly status?: unknown;
    readonly headers?: Record<string, unknown> | Headers;
  };
  readonly errors?: readonly GitHubGraphqlErrorShape[];
  readonly data?: unknown;
}

function isRecord(
  candidateValue: unknown,
): candidateValue is Record<string, unknown> {
  return typeof candidateValue === "object" && candidateValue !== null;
}

function asRecord(candidateValue: unknown): Record<string, unknown> {
  return isRecord(candidateValue) ? candidateValue : {};
}

function asString(candidateValue: unknown, fallbackValue = ""): string {
  return typeof candidateValue === "string" ? candidateValue : fallbackValue;
}

function asNonNegativeInteger(
  candidateValue: unknown,
  fallbackValue = 0,
): number {
  return typeof candidateValue === "number" &&
    Number.isInteger(candidateValue) &&
    candidateValue >= 0
    ? candidateValue
    : fallbackValue;
}

function asBoolean(candidateValue: unknown, fallbackValue = false): boolean {
  return typeof candidateValue === "boolean" ? candidateValue : fallbackValue;
}

function asStringArray<T>(candidateValue: unknown): readonly T[] {
  return Array.isArray(candidateValue) ? (candidateValue as readonly T[]) : [];
}

function normalizeGraphqlResponse<GraphqlResponse>(
  response: GraphqlResponse,
): Record<string, unknown> {
  const responseRecord = asRecord(response);
  const responseErrors = asStringArray<GitHubGraphqlErrorShape>(
    responseRecord["errors"],
  ).filter(isRecord);
  if (responseErrors.length > 0) {
    throw createGraphqlResponseError(responseErrors, responseRecord);
  }
  const nestedData = responseRecord["data"];
  if (isRecord(nestedData)) {
    return nestedData;
  }
  return responseRecord;
}

function createGraphqlResponseError(
  graphqlErrors: readonly GitHubGraphqlErrorShape[],
  responseRecord: Record<string, unknown>,
): GitHubProviderError {
  const errorText = graphqlErrors
    .map((graphqlError) =>
      `${asString(graphqlError.type)} ${asString(graphqlError.message)}`.toLowerCase(),
    )
    .join(" ");
  const responseStatus = responseRecord["status"];
  const statusCode =
    typeof responseStatus === "number" && Number.isInteger(responseStatus)
      ? responseStatus
      : undefined;
  if (
    statusCode === 401 ||
    errorText.includes("unauthorized") ||
    errorText.includes("authentication")
  ) {
    return new GitHubProviderError(
      "unauthorized",
      "GitHub authentication is no longer valid. Reconnect GitHub and approve repo and read:user scopes for Git'o's read-only API operations.",
      statusCode === undefined ? {} : { statusCode },
    );
  }
  if (statusCode === 403 || errorText.includes("forbidden")) {
    return new GitHubProviderError(
      "forbidden",
      "GitHub denied access to this repository.",
      statusCode === undefined ? {} : { statusCode },
    );
  }
  if (statusCode === 404 || errorText.includes("not_found")) {
    return new GitHubProviderError(
      "notFound",
      "GitHub could not find this repository or pull request.",
      statusCode === undefined ? {} : { statusCode },
    );
  }
  return new GitHubProviderError(
    "network",
    "GitHub returned GraphQL errors for this request.",
    statusCode === undefined ? {} : { statusCode },
  );
}

function normalizeRateLimitSnapshot(
  rateLimitValue: unknown,
): GitHubRateLimitSnapshot | undefined {
  const rateLimitRecord = asRecord(rateLimitValue);
  const remainingValue = rateLimitRecord["remaining"];
  if (
    typeof remainingValue !== "number" ||
    !Number.isInteger(remainingValue) ||
    remainingValue < 0
  ) {
    return undefined;
  }

  const limitValue = rateLimitRecord["limit"];
  const usedValue = rateLimitRecord["used"];
  const resetAtValue = rateLimitRecord["resetAt"];
  return {
    remaining: remainingValue,
    ...(typeof limitValue === "number" && Number.isInteger(limitValue)
      ? { limit: limitValue }
      : {}),
    ...(typeof usedValue === "number" && Number.isInteger(usedValue)
      ? { used: usedValue }
      : {}),
    ...(typeof resetAtValue === "string" ? { resetAt: resetAtValue } : {}),
  };
}

function normalizeHttpRateLimitSnapshot(
  headers: Record<string, unknown> | Headers | undefined,
): GitHubRateLimitSnapshot | undefined {
  if (!headers) {
    return undefined;
  }
  const headerEntries =
    typeof Headers !== "undefined" && headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers);
  const normalizedHeaders = new Map(
    headerEntries.map(([headerName, headerValue]) => [
      headerName.toLowerCase(),
      String(headerValue),
    ]),
  );
  const remainingValue = Number(normalizedHeaders.get("x-ratelimit-remaining"));
  if (!Number.isInteger(remainingValue) || remainingValue < 0) {
    return undefined;
  }
  const limitValue = Number(normalizedHeaders.get("x-ratelimit-limit"));
  const usedValue = Number(normalizedHeaders.get("x-ratelimit-used"));
  const resetEpochSeconds = Number(normalizedHeaders.get("x-ratelimit-reset"));
  return {
    remaining: remainingValue,
    ...(Number.isInteger(limitValue) && limitValue >= 0
      ? { limit: limitValue }
      : {}),
    ...(Number.isInteger(usedValue) && usedValue >= 0
      ? { used: usedValue }
      : {}),
    ...(Number.isInteger(resetEpochSeconds) && resetEpochSeconds >= 0
      ? { resetAt: new Date(resetEpochSeconds * 1000).toISOString() }
      : {}),
  };
}

function normalizeGraphqlErrorShapes(
  error: unknown,
): readonly GitHubGraphqlErrorShape[] {
  if (error instanceof GraphqlResponseError) {
    return asStringArray<GitHubGraphqlErrorShape>(error.errors);
  }
  const failureShape = asRecord(error) as GitHubGraphqlFailureShape;
  return asStringArray<GitHubGraphqlErrorShape>(failureShape.errors);
}

function getFailureStatusCode(error: unknown): number | undefined {
  const failureShape = asRecord(error) as GitHubGraphqlFailureShape;
  const directStatus = failureShape.status;
  const responseStatus = failureShape.response?.status;
  const selectedStatus = directStatus ?? responseStatus;
  return typeof selectedStatus === "number" && Number.isInteger(selectedStatus)
    ? selectedStatus
    : undefined;
}

function getFailureHeaders(
  error: unknown,
): Record<string, unknown> | Headers | undefined {
  const failureShape = asRecord(error) as GitHubGraphqlFailureShape;
  return failureShape.headers ?? failureShape.response?.headers;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error["name"] === "AbortError" || error["code"] === "ABORT_ERR")
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  const errorRecord = asRecord(error);
  const causeRecord = asRecord(errorRecord["cause"]);
  return (
    errorRecord["code"] === "ETIMEDOUT" ||
    errorRecord["code"] === "ETIME" ||
    causeRecord["code"] === "ETIMEDOUT" ||
    causeRecord["code"] === "ETIME" ||
    causeRecord["name"] === "TimeoutError" ||
    asString(errorRecord["message"]).toLowerCase().includes("timed out")
  );
}

function getNormalizedFailureError(
  error: unknown,
  cancellationSignal?: AbortSignal,
): GitHubProviderError {
  if (error instanceof GitHubProviderError) {
    return error;
  }
  const nestedCause = asRecord(error)["cause"];
  if (nestedCause instanceof GitHubProviderError) {
    return nestedCause;
  }
  if (cancellationSignal?.aborted || isAbortLikeError(error)) {
    return new GitHubProviderError(
      "cancelled",
      "GitHub request was cancelled.",
    );
  }
  if (isTimeoutLikeError(error)) {
    return new GitHubProviderError(
      "timeout",
      "GitHub did not respond before the request deadline.",
    );
  }

  const statusCode = getFailureStatusCode(error);
  const rateLimit = normalizeHttpRateLimitSnapshot(getFailureHeaders(error));
  const graphqlErrors = normalizeGraphqlErrorShapes(error);
  const failureMessage = asString(asRecord(error)["message"]).toLowerCase();
  const graphqlRateLimitError = graphqlErrors.some(
    (graphqlError) =>
      asString(graphqlError.type).toUpperCase() === "RATE_LIMITED" ||
      asString(graphqlError.message).toLowerCase().includes("rate limit"),
  );
  const failureDetails = {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
  if (statusCode === 401) {
    return new GitHubProviderError(
      "unauthorized",
      "GitHub authentication is no longer valid. Reconnect GitHub and approve repo and read:user scopes for Git'o's read-only API operations.",
      failureDetails,
    );
  }
  if (
    statusCode === 403 &&
    (rateLimit?.remaining === 0 || failureMessage.includes("rate limit"))
  ) {
    return new GitHubProviderError(
      "rateLimit",
      "GitHub API rate limit reached. Try again after the reset time.",
      failureDetails,
    );
  }
  if (statusCode === 403) {
    return new GitHubProviderError(
      "forbidden",
      "GitHub denied access to this repository.",
      failureDetails,
    );
  }
  if (statusCode === 404) {
    return new GitHubProviderError(
      "notFound",
      "GitHub could not find this repository or pull request.",
      failureDetails,
    );
  }
  if (statusCode === 429 || graphqlRateLimitError) {
    return new GitHubProviderError(
      "rateLimit",
      "GitHub API rate limit reached. Try again after the reset time.",
      failureDetails,
    );
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return new GitHubProviderError(
      "server",
      "GitHub is temporarily unavailable. Showing the last successful data when available.",
      failureDetails,
    );
  }
  if (statusCode !== undefined) {
    return new GitHubProviderError(
      "network",
      "GitHub request failed. Try again.",
      failureDetails,
    );
  }
  return new GitHubProviderError(
    "network",
    "GitHub could not be reached. Try again.",
    failureDetails,
  );
}

function readPullRequestNodes(
  graphqlData: Record<string, unknown>,
  operationBudget: GitHubAggregateOperationBudget,
): readonly GitHubPullRequestNode[] {
  const repositoryRecord = asRecord(graphqlData["repository"]);
  const pullRequestRecord = asRecord(repositoryRecord["pullRequests"]);
  const candidatePullRequestNodes = asStringArray<GitHubPullRequestNode>(
    pullRequestRecord["nodes"],
  );
  operationBudget.reserve(
    candidatePullRequestNodes.length,
    candidatePullRequestNodes,
  );
  return candidatePullRequestNodes.filter(
    (pullRequestNode): pullRequestNode is GitHubPullRequestNode =>
      isRecord(pullRequestNode),
  );
}

function readNextPullRequestCursor(
  graphqlData: Record<string, unknown>,
): string | undefined {
  const repositoryRecord = asRecord(graphqlData["repository"]);
  const pullRequestRecord = asRecord(repositoryRecord["pullRequests"]);
  const pageInfoRecord = asRecord(pullRequestRecord["pageInfo"]);
  if (typeof pageInfoRecord["hasNextPage"] !== "boolean") {
    throw new GitHubProviderError(
      "paginationIncomplete",
      "GitHub returned incomplete pull-request pagination data.",
      { partialDataDisabled: true },
    );
  }
  if (!pageInfoRecord["hasNextPage"]) {
    return undefined;
  }
  const endCursor = pageInfoRecord["endCursor"];
  if (typeof endCursor !== "string" || endCursor.length === 0) {
    throw new GitHubProviderError(
      "paginationIncomplete",
      "GitHub returned an incomplete pull-request pagination cursor.",
      { partialDataDisabled: true },
    );
  }
  return endCursor;
}

function readNextReviewCursor(
  reviewConnection:
    GitHubPullRequestNode["reviewRequests"] | GitHubPullRequestNode["reviews"],
  reviewConnectionName: "review requests" | "reviews",
): string | undefined {
  if (reviewConnection === undefined || reviewConnection === null) {
    throw new GitHubProviderError(
      "paginationIncomplete",
      `GitHub returned incomplete ${reviewConnectionName} pagination data.`,
      { partialDataDisabled: true },
    );
  }
  const pageInfoRecord = asRecord(reviewConnection.pageInfo);
  if (typeof pageInfoRecord["hasNextPage"] !== "boolean") {
    throw new GitHubProviderError(
      "paginationIncomplete",
      `GitHub returned incomplete ${reviewConnectionName} pagination data.`,
      { partialDataDisabled: true },
    );
  }
  if (pageInfoRecord["hasNextPage"] === false) {
    return undefined;
  }
  const endCursor = pageInfoRecord["endCursor"];
  if (typeof endCursor !== "string" || endCursor.length === 0) {
    throw new GitHubProviderError(
      "paginationIncomplete",
      `GitHub returned an incomplete ${reviewConnectionName} pagination cursor.`,
      { partialDataDisabled: true },
    );
  }
  return endCursor;
}

function appendBoundedGitHubReviewNodes<ReviewNode extends object>(
  reviewNodes: ReviewNode[],
  candidateNodes: unknown,
  reviewConnectionName: "review requests" | "reviews",
  operationBudget: GitHubAggregateOperationBudget,
): void {
  const candidateReviewNodes = asStringArray<ReviewNode>(candidateNodes);
  operationBudget.reserve(candidateReviewNodes.length, candidateReviewNodes);
  if (candidateReviewNodes.length > maximumGitHubReviewNodes) {
    throw new GitHubProviderError(
      "paginationIncomplete",
      `GitHub returned more ${reviewConnectionName} than Git'o can safely load.`,
      { partialDataDisabled: true },
    );
  }
  const pageReviewNodes = candidateReviewNodes.filter(isRecord);
  if (reviewNodes.length + pageReviewNodes.length > maximumGitHubReviewNodes) {
    throw new GitHubProviderError(
      "paginationIncomplete",
      `GitHub returned more ${reviewConnectionName} than Git'o can safely load.`,
      { partialDataDisabled: true },
    );
  }
  reviewNodes.push(...pageReviewNodes);
}

function readPullRequestNode(
  graphqlData: Record<string, unknown>,
): GitHubPullRequestNode | undefined {
  const repositoryRecord = asRecord(graphqlData["repository"]);
  const pullRequestRecord = repositoryRecord["pullRequest"];
  return isRecord(pullRequestRecord) ? pullRequestRecord : undefined;
}

function normalizeViewer(
  graphqlData: Record<string, unknown>,
): GitHubCurrentUser {
  const viewerRecord = asRecord(graphqlData["viewer"]);
  const login = asString(viewerRecord["login"]);
  const userId = asString(viewerRecord["id"], login);
  if (!login) {
    throw new GitHubProviderError(
      "invalidResponse",
      "GitHub returned an incomplete account identity.",
    );
  }
  return {
    providerId: "github",
    userId,
    displayName: asString(viewerRecord["name"], login),
  };
}

function readViewerLogin(graphqlData: Record<string, unknown>): string {
  return asString(asRecord(graphqlData["viewer"])["login"]);
}

function normalizePullRequestSummary(
  pullRequestNode: GitHubPullRequestNode,
  repositoryIdentity: GitHubRepositoryIdentity,
  currentUserLogin: string,
): PullRequestSummary {
  const pullRequestNumber = asNonNegativeInteger(pullRequestNode.number);
  const authorRecord = pullRequestNode.author;
  const authorLogin = asString(authorRecord?.login, "unknown");
  const requestedReviewerNodes = asStringArray<{
    readonly requestedReviewer?: {
      readonly login?: unknown;
      readonly slug?: unknown;
    } | null;
  }>(pullRequestNode.reviewRequests?.nodes).filter(
    (
      reviewRequestNode,
    ): reviewRequestNode is {
      readonly requestedReviewer?: {
        readonly login?: unknown;
        readonly slug?: unknown;
      } | null;
    } => isRecord(reviewRequestNode),
  );
  const reviewNodes = asStringArray<GitHubReviewNode>(
    pullRequestNode.reviews?.nodes,
  ).filter((reviewNode): reviewNode is GitHubReviewNode =>
    isRecord(reviewNode),
  );
  // Review history is not a decision. Select the latest opinion per reviewer
  // by submittedAt; ambiguous histories stay incomplete rather than counting
  // an approval that may have been superseded by a re-request.
  const reviewOpinionsByReviewer = new Map<
    string,
    Array<{ readonly state: string; readonly submittedAtMs?: number }>
  >();
  for (const reviewNode of reviewNodes) {
    const reviewerLogin = asString(reviewNode.author?.login);
    if (reviewerLogin) {
      const reviewerKey = reviewerLogin.toLowerCase();
      const reviewerOpinions = reviewOpinionsByReviewer.get(reviewerKey) ?? [];
      const submittedAt = asString(reviewNode.submittedAt);
      const submittedAtMs = submittedAt ? Date.parse(submittedAt) : Number.NaN;
      reviewerOpinions.push({
        state: asString(reviewNode.state).toUpperCase(),
        ...(Number.isFinite(submittedAtMs) ? { submittedAtMs } : {}),
      });
      reviewOpinionsByReviewer.set(reviewerKey, reviewerOpinions);
    }
  }
  const latestReviewStateByReviewer = new Map<string, string>();
  const ambiguousReviewerKeys = new Set<string>();
  for (const [reviewerKey, reviewerOpinions] of reviewOpinionsByReviewer) {
    if (reviewerOpinions.length === 1) {
      latestReviewStateByReviewer.set(reviewerKey, reviewerOpinions[0]!.state);
      continue;
    }
    if (
      reviewerOpinions.some(
        (reviewOpinion) => reviewOpinion.submittedAtMs === undefined,
      )
    ) {
      ambiguousReviewerKeys.add(reviewerKey);
      continue;
    }
    const orderedOpinions = [...reviewerOpinions].sort(
      (leftOpinion, rightOpinion) =>
        leftOpinion.submittedAtMs! - rightOpinion.submittedAtMs!,
    );
    const latestOpinion = orderedOpinions.at(-1)!;
    const sameTimestampOpinions = orderedOpinions.filter(
      (reviewOpinion) =>
        reviewOpinion.submittedAtMs === latestOpinion.submittedAtMs,
    );
    if (
      new Set(sameTimestampOpinions.map((reviewOpinion) => reviewOpinion.state))
        .size > 1
    ) {
      ambiguousReviewerKeys.add(reviewerKey);
      continue;
    }
    latestReviewStateByReviewer.set(reviewerKey, latestOpinion.state);
  }
  const pendingReviewerKeys = new Set<string>();
  for (const reviewRequestNode of requestedReviewerNodes) {
    const requestedReviewer = reviewRequestNode.requestedReviewer;
    const reviewerKey =
      asString(requestedReviewer?.login) || asString(requestedReviewer?.slug);
    if (reviewerKey) {
      pendingReviewerKeys.add(reviewerKey.toLowerCase());
    }
  }
  // Required count is the known unique reviewer set plus one unknown policy
  // slot when GitHub reports REVIEW_REQUIRED without exposing branch rules.
  const knownReviewerKeys = new Set([
    ...latestReviewStateByReviewer.keys(),
    ...ambiguousReviewerKeys,
    ...pendingReviewerKeys,
  ]);
  // A re-requested reviewer is not complete even if their previous review was
  // approved; GitHub's review request is the current requirement.
  const completedReviewCount = Array.from(
    latestReviewStateByReviewer.entries(),
  ).filter(
    ([reviewerKey, reviewState]) =>
      reviewState === "APPROVED" && !pendingReviewerKeys.has(reviewerKey),
  ).length;
  const knownReviewerCount = knownReviewerKeys.size;
  const reviewDecision = asString(pullRequestNode.reviewDecision).toUpperCase();
  // REVIEW_REQUIRED adds the missing reviewer that GitHub does not identify.
  const requiredReviewCount =
    reviewDecision === "REVIEW_REQUIRED"
      ? knownReviewerCount + 1
      : knownReviewerCount;
  const isDraft = asBoolean(pullRequestNode.isDraft);

  return {
    providerId: "github",
    repositoryOwner: repositoryIdentity.owner,
    repositoryName: repositoryIdentity.repositoryName,
    pullRequestNumber,
    title: asString(pullRequestNode.title, "Untitled pull request"),
    authorDisplayName: asString(authorRecord?.name, authorLogin),
    updatedAt: asString(pullRequestNode.updatedAt),
    commentCount: asNonNegativeInteger(pullRequestNode.comments?.totalCount),
    isAuthoredByCurrentUser:
      authorLogin.toLowerCase() === currentUserLogin.toLowerCase(),
    reviewRequestedFromCurrentUser: requestedReviewerNodes.some(
      (reviewRequestNode) =>
        asString(reviewRequestNode.requestedReviewer?.login).toLowerCase() ===
        currentUserLogin.toLowerCase(),
    ),
    isDraft,
    state: classifyPullRequestState(
      isDraft,
      reviewDecision,
      asString(pullRequestNode.mergeable).toUpperCase(),
      asString(pullRequestNode.mergeStateStatus).toUpperCase(),
      asString(pullRequestNode.statusCheckRollup?.state).toUpperCase(),
    ),
    completedReviewCount,
    requiredReviewCount,
  };
}

function classifyPullRequestState(
  isDraft: boolean,
  reviewDecision: string,
  mergeableState: string,
  mergeStateStatus: string,
  checksState: string,
): PullRequestState {
  if (isDraft) {
    return "draft";
  }
  if (
    mergeableState === "CONFLICTING" ||
    mergeStateStatus === "DIRTY" ||
    mergeStateStatus === "BLOCKED" ||
    mergeStateStatus === "BEHIND" ||
    checksState === "FAILURE" ||
    checksState === "ERROR"
  ) {
    return "blocked";
  }
  if (mergeableState === "UNKNOWN" || mergeableState.length === 0) {
    return "checksRunning";
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "changesRequested";
  }
  if (reviewDecision === "REVIEW_REQUIRED") {
    return "blocked";
  }
  if (
    checksState === "EXPECTED" ||
    checksState === "PENDING" ||
    mergeStateStatus === "UNKNOWN" ||
    mergeStateStatus === "UNSTABLE"
  ) {
    return "checksRunning";
  }
  return "ready";
}

function normalizePullRequestDetails(
  pullRequestNode: GitHubPullRequestNode,
  repositoryIdentity: GitHubRepositoryIdentity,
  currentUserLogin: string,
): GitHubPullRequestDetails {
  const summary = normalizePullRequestSummary(
    pullRequestNode,
    repositoryIdentity,
    currentUserLogin,
  );
  return {
    ...summary,
    cacheStatus: "fresh",
    bodyText: asString(pullRequestNode.body),
    sourceBranchName: asString(pullRequestNode.headRefName),
    targetBranchName: asString(pullRequestNode.baseRefName),
    canonicalUrl: createGitHubCanonicalUrl(summary),
  };
}

function createGitHubCanonicalUrl(
  resourceIdentity: CloudRepositoryIdentity | PullRequestIdentity,
): string {
  const repositoryOwner =
    "owner" in resourceIdentity
      ? resourceIdentity.owner
      : resourceIdentity.repositoryOwner;
  const repositoryUrl = `https://github.com/${encodeURIComponent(
    repositoryOwner,
  )}/${encodeURIComponent(resourceIdentity.repositoryName)}`;
  if ("pullRequestNumber" in resourceIdentity) {
    return `${repositoryUrl}/pull/${resourceIdentity.pullRequestNumber}`;
  }
  return repositoryUrl;
}

function createGitHubResponseLimitError(): GitHubProviderError {
  return new GitHubProviderError(
    "invalidResponse",
    "GitHub returned a response larger than Git'o can safely process.",
  );
}

async function cancelGitHubResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already invalid or cancelled.
  }
}

function createResponseFromBytes(
  response: Response,
  responseBytes: Uint8Array,
): Response {
  return new Response(new TextDecoder().decode(responseBytes), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readBoundedGitHubResponse(
  response: Response,
  maximumResponseBytes: number,
  cancellationSignal: AbortSignal | null | undefined,
): Promise<Response> {
  if (cancellationSignal?.aborted) {
    await cancelGitHubResponseBody(response);
    throw new GitHubProviderError("cancelled", "GitHub request was cancelled.");
  }
  const declaredResponseBytes = response.headers.get("content-length");
  const parsedDeclaredResponseBytes = Number(declaredResponseBytes);
  if (
    declaredResponseBytes !== null &&
    Number.isFinite(parsedDeclaredResponseBytes) &&
    parsedDeclaredResponseBytes > maximumResponseBytes
  ) {
    await cancelGitHubResponseBody(response);
    throw createGitHubResponseLimitError();
  }
  if (response.body === null) {
    const responseText = await response.text();
    if (cancellationSignal?.aborted) {
      throw new GitHubProviderError(
        "cancelled",
        "GitHub request was cancelled.",
      );
    }
    const responseBytes = new TextEncoder().encode(responseText);
    if (responseBytes.byteLength > maximumResponseBytes) {
      throw createGitHubResponseLimitError();
    }
    return createResponseFromBytes(response, responseBytes);
  }

  const responseReader = response.body.getReader();
  const responseChunks: Uint8Array[] = [];
  let responseByteCount = 0;
  const cancelResponseReader = (): void => {
    void responseReader.cancel().catch(() => undefined);
  };
  cancellationSignal?.addEventListener("abort", cancelResponseReader, {
    once: true,
  });
  try {
    while (true) {
      if (cancellationSignal?.aborted) {
        throw new GitHubProviderError(
          "cancelled",
          "GitHub request was cancelled.",
        );
      }
      const responseChunk = await responseReader.read();
      if (responseChunk.done) break;
      responseByteCount += responseChunk.value.byteLength;
      if (responseByteCount > maximumResponseBytes) {
        await responseReader.cancel();
        throw createGitHubResponseLimitError();
      }
      responseChunks.push(responseChunk.value);
    }
  } catch (error: unknown) {
    if (cancellationSignal?.aborted) {
      throw new GitHubProviderError(
        "cancelled",
        "GitHub request was cancelled.",
      );
    }
    throw error;
  } finally {
    cancellationSignal?.removeEventListener("abort", cancelResponseReader);
    responseReader.releaseLock();
  }
  if (cancellationSignal?.aborted) {
    throw new GitHubProviderError("cancelled", "GitHub request was cancelled.");
  }
  const responseBytes = new Uint8Array(responseByteCount);
  let responseByteOffset = 0;
  for (const responseChunk of responseChunks) {
    responseBytes.set(responseChunk, responseByteOffset);
    responseByteOffset += responseChunk.byteLength;
  }
  return createResponseFromBytes(response, responseBytes);
}

function createBoundedGitHubFetch(
  fetchImplementation: typeof fetch,
  maximumResponseBytes: number,
): typeof fetch {
  return (requestInput, requestInit) =>
    fetchImplementation(requestInput, requestInit).then((response) =>
      readBoundedGitHubResponse(
        response,
        maximumResponseBytes,
        requestInit?.signal,
      ),
    );
}

function createDefaultGraphqlClient(
  accessToken: string,
  fetchImplementation: typeof fetch,
  maximumResponseBytes: number,
): GitHubGraphqlClient {
  return graphql.defaults({
    baseUrl: githubApiBaseUrl,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
    },
    request: {
      fetch: createBoundedGitHubFetch(
        fetchImplementation,
        maximumResponseBytes,
      ),
    },
  });
}

function createDefaultCanonicalUri(canonicalUrl: string): vscode.Uri {
  return vscode.Uri.parse(canonicalUrl);
}

function buildGitHubSnapshotCacheKey(
  repositoryIdentity: GitHubRepositoryIdentity,
  connection: Pick<GitHubProviderConnection, "sessionId">,
): string {
  return [
    connection.sessionId,
    repositoryIdentity.owner.toLowerCase(),
    repositoryIdentity.repositoryName.toLowerCase(),
  ].join(":");
}

function cloneGitHubDashboardSnapshot(
  snapshot: GitHubRepositoryDashboardSnapshot,
): GitHubRepositoryDashboardSnapshot {
  return {
    ...snapshot,
    pullRequests: snapshot.pullRequests.map((pullRequest) => ({
      ...pullRequest,
    })),
    ...(snapshot.rateLimit === undefined
      ? {}
      : { rateLimit: { ...snapshot.rateLimit } }),
  };
}

function buildGitHubPullRequestGenerationKey(
  pullRequestIdentity: PullRequestIdentity,
  connection: GitHubProviderConnection,
): string {
  return [
    connection.sessionId,
    pullRequestIdentity.repositoryOwner.toLowerCase(),
    pullRequestIdentity.repositoryName.toLowerCase(),
    pullRequestIdentity.pullRequestNumber,
  ].join(":");
}

function setBoundedGitHubMapValue<Value>(
  entries: Map<string, Value>,
  key: string,
  value: Value,
  maximumEntries: number,
): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > maximumEntries) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

function ensureGitHubRepositoryIdentity(
  repositoryIdentity: CloudRepositoryIdentity,
): GitHubRepositoryIdentity {
  if (
    repositoryIdentity.providerId !== "github" ||
    !repositoryIdentity.owner ||
    !repositoryIdentity.repositoryName
  ) {
    throw new GitHubProviderError(
      "invalidResponse",
      "This repository is not a supported GitHub.com repository.",
    );
  }
  return { ...repositoryIdentity, providerId: "github" };
}

function ensureGitHubConnection(
  connection: ProviderConnection,
): GitHubProviderConnection {
  if (
    connection.providerId !== "github" ||
    !connection.sessionId ||
    !connection.accessToken
  ) {
    throw new GitHubProviderError(
      "authentication",
      "Connect GitHub before loading repository data.",
    );
  }
  return { ...connection, providerId: "github" };
}

function hasGitHubAuthenticationScopes(
  authenticationSession: vscode.AuthenticationSession,
): boolean {
  const grantedScopes = new Set(authenticationSession.scopes);
  return githubAuthenticationScopes.every((requiredScope) =>
    grantedScopes.has(requiredScope),
  );
}

/** GitHub.com-only, read-only provider adapter. */
export class GitHubProvider implements CloudGitProvider {
  public readonly providerId = "github" as const;

  private readonly authentication: GitHubAuthenticationApi;
  private readonly graphqlClientFactory: (
    accessToken: string,
  ) => GitHubGraphqlClient;
  private readonly canonicalUriFactory: GitHubCanonicalUriFactory;
  private readonly fetchImplementation: typeof fetch;
  private readonly maximumResponseBytes: number;
  private readonly now: () => Date;
  private readonly cacheTtlMilliseconds: number;
  private readonly requestTimeoutMs: number;
  private readonly requestCoordinator: GitHubRequestCoordinator;
  private readonly sessionPreference =
    new AuthenticationSessionPreferenceTracker();
  private readonly dashboardCache = new Map<string, GitHubSnapshotCacheEntry>();
  private readonly dashboardRequestGenerations = new Map<string, number>();
  /** Details are never cached; generations reject results after disconnect. */
  private readonly detailRequestGenerations = new Map<string, number>();
  private requestGenerationCounter = 0;

  public constructor(dependencies: GitHubProviderDependencies = {}) {
    this.authentication = dependencies.authentication ?? vscode.authentication;
    const fetchImplementation =
      dependencies.fetchImplementation ?? globalThis.fetch;
    if (fetchImplementation === undefined) {
      throw new Error("Fetch is unavailable in the GitHub extension host.");
    }
    this.fetchImplementation = fetchImplementation;
    this.maximumResponseBytes =
      dependencies.maxResponseBytes ?? defaultMaximumGitHubResponseBytes;
    if (
      !Number.isSafeInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1
    ) {
      throw new RangeError(
        "GitHub maximum response bytes must be a positive integer",
      );
    }
    this.graphqlClientFactory =
      dependencies.graphqlClientFactory ??
      ((accessToken) =>
        createDefaultGraphqlClient(
          accessToken,
          this.fetchImplementation,
          this.maximumResponseBytes,
        ));
    this.canonicalUriFactory =
      dependencies.canonicalUriFactory ?? createDefaultCanonicalUri;
    this.now = dependencies.now ?? (() => new Date());
    this.cacheTtlMilliseconds =
      dependencies.cacheTtlMilliseconds ?? defaultGitHubCacheTtlMilliseconds;
    this.requestTimeoutMs =
      dependencies.requestTimeoutMs ?? defaultGitHubRequestTimeoutMs;
    if (
      !Number.isFinite(this.cacheTtlMilliseconds) ||
      this.cacheTtlMilliseconds < 0
    ) {
      throw new RangeError("GitHub cache TTL must be a non-negative number");
    }
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1
    ) {
      throw new RangeError("GitHub request timeout must be a positive integer");
    }
    this.requestCoordinator = new GitHubRequestCoordinator(
      dependencies.maximumConcurrentRequests ??
        defaultMaximumConcurrentRequests,
    );
  }

  public detectRepository(
    remoteUrls: readonly string[],
  ): CloudRepositoryIdentity | undefined {
    for (const remoteUrl of remoteUrls) {
      const repositoryIdentity = parseGitHubRemote(remoteUrl);
      if (repositoryIdentity) {
        return repositoryIdentity;
      }
    }
    return undefined;
  }

  public async connect(
    cancellationToken: vscode.CancellationToken,
  ): Promise<ProviderConnection> {
    return this.acquireAuthenticationSession(cancellationToken, true);
  }

  /** Reuses the preferred VS Code session without opening an auth prompt. */
  public async connectSilently(
    cancellationToken: vscode.CancellationToken,
  ): Promise<ProviderConnection> {
    return this.acquireAuthenticationSession(cancellationToken, false);
  }

  private async acquireAuthenticationSession(
    cancellationToken: vscode.CancellationToken,
    interactive: boolean,
  ): Promise<ProviderConnection> {
    if (cancellationToken.isCancellationRequested) {
      throw new GitHubProviderError(
        "cancelled",
        "GitHub connection was cancelled.",
      );
    }
    const sessionAcquisition =
      this.sessionPreference.beginAcquisition(interactive);
    const sessionOptions = interactive
      ? {
          clearSessionPreference: true,
          createIfNone: { detail: githubAuthenticationScopeDisclosure },
        }
      : {
          silent: true,
          clearSessionPreference: false,
          ...(sessionAcquisition.preferredAccount === undefined
            ? {}
            : { account: sessionAcquisition.preferredAccount }),
        };
    const sessionPromise = Promise.resolve(
      this.authentication.getSession(
        "github",
        githubAuthenticationScopes,
        sessionOptions,
      ),
    ).then((session) => {
      // A prompt may resolve after cancellation. Record only a live
      // acquisition's metadata; never retain its token or session object.
      this.sessionPreference.observeSession(
        sessionAcquisition.generation,
        session,
      );
      return session;
    });
    let cancellationDisposable: vscode.Disposable | undefined;
    const cancellationPromise = new Promise<never>((_, reject) => {
      cancellationDisposable = cancellationToken.onCancellationRequested(() => {
        reject(
          new GitHubProviderError(
            "cancelled",
            "GitHub connection was cancelled.",
          ),
        );
      });
    });
    let acquired = false;
    try {
      const session = await Promise.race([sessionPromise, cancellationPromise]);
      if (cancellationToken.isCancellationRequested) {
        throw new GitHubProviderError(
          "cancelled",
          "GitHub connection was cancelled.",
        );
      }
      if (!session) {
        throw new GitHubProviderError(
          "authentication",
          "GitHub access was not granted. Git'o needs VS Code's repo and read:user scopes for read-only GitHub API operations.",
        );
      }
      if (!hasGitHubAuthenticationScopes(session)) {
        throw new GitHubProviderError(
          "authentication",
          "GitHub access is missing the repo and read:user scopes required for Git'o's read-only API operations. Reconnect GitHub and approve both scopes.",
        );
      }
      if (
        typeof session.id !== "string" ||
        session.id.length === 0 ||
        typeof session.accessToken !== "string" ||
        session.accessToken.length === 0
      ) {
        throw new GitHubProviderError(
          "authentication",
          "GitHub returned an invalid session. Reconnect GitHub and approve repo and read:user scopes.",
        );
      }
      acquired = true;
      return {
        providerId: "github",
        sessionId: session.id,
        accessToken: session.accessToken,
        acquisitionGeneration: sessionAcquisition.generation,
      };
    } catch (error) {
      if (error instanceof GitHubProviderError) {
        throw error;
      }
      throw new GitHubProviderError(
        "authentication",
        "GitHub connection failed. Approve repo and read:user scopes in VS Code for Git'o's read-only GitHub API operations.",
      );
    } finally {
      cancellationDisposable?.dispose();
      if (!acquired)
        this.sessionPreference.cancelAcquisition(sessionAcquisition.generation);
    }
  }

  public commitConnection(connection: ProviderConnection): void {
    if (connection.providerId !== "github") return;
    this.sessionPreference.commitSession(
      connection.sessionId,
      connection.acquisitionGeneration,
    );
  }

  public discardConnection(connection: ProviderConnection): void {
    if (connection.providerId !== "github") return;
    this.sessionPreference.discardSession(
      connection.sessionId,
      connection.acquisitionGeneration,
    );
  }

  public isRepositoryDashboardCacheExpired(
    repositoryIdentity: CloudRepositoryIdentity,
    sessionId: string,
  ): boolean {
    const githubRepositoryIdentity =
      ensureGitHubRepositoryIdentity(repositoryIdentity);
    const cacheEntry = this.dashboardCache.get(
      buildGitHubSnapshotCacheKey(githubRepositoryIdentity, { sessionId }),
    );
    return (
      cacheEntry === undefined ||
      cacheEntry.expiresAtMilliseconds <= this.now().getTime()
    );
  }

  public async getCurrentUser(
    connection: ProviderConnection,
    cancellationSignal: AbortSignal,
  ): Promise<CloudUser> {
    const githubConnection = ensureGitHubConnection(connection);
    const graphqlClient = this.graphqlClientFactory(
      githubConnection.accessToken,
    );
    const graphqlData = await this.executeGraphqlRequest(
      graphqlClient,
      githubCurrentUserQuery,
      { request: { signal: cancellationSignal } },
      cancellationSignal,
    );
    return normalizeViewer(graphqlData);
  }

  public async getRepositoryDashboard(
    repositoryIdentity: CloudRepositoryIdentity,
    connection: ProviderConnection,
    cancellationSignal: AbortSignal,
    options: RepositoryDashboardOptions = {},
  ): Promise<GitHubRepositoryDashboardSnapshot> {
    const githubRepositoryIdentity =
      ensureGitHubRepositoryIdentity(repositoryIdentity);
    const githubConnection = ensureGitHubConnection(connection);
    if (cancellationSignal.aborted) {
      throw new GitHubProviderError(
        "cancelled",
        "GitHub request was cancelled.",
      );
    }
    const cacheKey = buildGitHubSnapshotCacheKey(
      githubRepositoryIdentity,
      githubConnection,
    );
    const cachedEntry = this.dashboardCache.get(cacheKey);
    const currentTimeMilliseconds = this.now().getTime();
    if (
      !options.forceRefresh &&
      cachedEntry &&
      cachedEntry.expiresAtMilliseconds > currentTimeMilliseconds
    ) {
      setBoundedGitHubMapValue(
        this.dashboardCache,
        cacheKey,
        cachedEntry,
        maximumGitHubDashboardCacheEntries,
      );
      return {
        ...cloneGitHubDashboardSnapshot(cachedEntry.snapshot),
        cacheStatus: "fresh",
      };
    }

    const requestGeneration = this.allocateRequestGeneration();
    setBoundedGitHubMapValue(
      this.dashboardRequestGenerations,
      cacheKey,
      requestGeneration,
      maximumGitHubGenerationEntries,
    );
    try {
      const freshSnapshot = await this.fetchRepositoryDashboard(
        githubRepositoryIdentity,
        githubConnection,
        cancellationSignal,
      );
      if (
        this.dashboardRequestGenerations.get(cacheKey) === requestGeneration
      ) {
        const immutableSnapshot = cloneGitHubDashboardSnapshot(freshSnapshot);
        setBoundedGitHubMapValue(
          this.dashboardCache,
          cacheKey,
          {
            snapshot: immutableSnapshot,
            expiresAtMilliseconds:
              this.now().getTime() + this.cacheTtlMilliseconds,
          },
          maximumGitHubDashboardCacheEntries,
        );
        return cloneGitHubDashboardSnapshot(immutableSnapshot);
      }
      throw new GitHubProviderError(
        "staleResponse",
        "A newer GitHub request superseded this response.",
      );
    } catch (error) {
      const normalizedError = getNormalizedFailureError(
        error,
        cancellationSignal,
      );
      if (
        this.dashboardRequestGenerations.get(cacheKey) !== requestGeneration
      ) {
        throw new GitHubProviderError(
          "staleResponse",
          "A newer GitHub request superseded this response.",
        );
      }
      if (
        cachedEntry &&
        (normalizedError.kind === "rateLimit" ||
          normalizedError.kind === "server" ||
          normalizedError.kind === "network" ||
          normalizedError.kind === "timeout")
      ) {
        const staleSnapshot: GitHubRepositoryDashboardSnapshot = {
          ...cloneGitHubDashboardSnapshot(cachedEntry.snapshot),
          cacheStatus: "stale",
          staleReason: normalizedError.kind,
          ...(normalizedError.rateLimit
            ? { rateLimit: normalizedError.rateLimit }
            : {}),
        };
        return staleSnapshot;
      }
      throw normalizedError;
    }
  }

  public async getPullRequestDetails(
    pullRequestIdentity: PullRequestIdentity,
    connection: ProviderConnection,
    cancellationSignal: AbortSignal,
  ): Promise<PullRequestDetails> {
    if (pullRequestIdentity.providerId !== "github") {
      throw new GitHubProviderError(
        "invalidResponse",
        "This pull request is not a GitHub.com pull request.",
      );
    }
    const githubConnection = ensureGitHubConnection(connection);
    const detailGenerationKey = buildGitHubPullRequestGenerationKey(
      pullRequestIdentity,
      githubConnection,
    );
    const requestGeneration = this.allocateRequestGeneration();
    setBoundedGitHubMapValue(
      this.detailRequestGenerations,
      detailGenerationKey,
      requestGeneration,
      maximumGitHubGenerationEntries,
    );
    const repositoryIdentity: GitHubRepositoryIdentity = {
      providerId: "github",
      owner: pullRequestIdentity.repositoryOwner,
      repositoryName: pullRequestIdentity.repositoryName,
    };
    const operationCancellation = new GitHubOperationCancellation(
      cancellationSignal,
    );
    const operationBudget = new GitHubAggregateOperationBudget();
    try {
      const graphqlClient = this.graphqlClientFactory(
        githubConnection.accessToken,
      );
      const graphqlData = await this.executeGraphqlRequest(
        graphqlClient,
        githubPullRequestDetailsQuery,
        {
          owner: repositoryIdentity.owner,
          repository: repositoryIdentity.repositoryName,
          pullRequestNumber: pullRequestIdentity.pullRequestNumber,
          request: { signal: operationCancellation.signal },
        },
        operationCancellation.signal,
      );
      normalizeViewer(graphqlData);
      let pullRequestNode = readPullRequestNode(graphqlData);
      if (!pullRequestNode) {
        throw new GitHubProviderError(
          "notFound",
          "GitHub could not find this pull request.",
        );
      }
      pullRequestNode = await this.completeReviewConnections(
        repositoryIdentity,
        pullRequestNode,
        graphqlClient,
        operationCancellation,
        operationBudget,
      );
      if (
        this.detailRequestGenerations.get(detailGenerationKey) !==
        requestGeneration
      ) {
        throw new GitHubProviderError(
          "staleResponse",
          "A newer GitHub request superseded this response.",
        );
      }
      return normalizePullRequestDetails(
        pullRequestNode,
        repositoryIdentity,
        readViewerLogin(graphqlData),
      );
    } catch (error: unknown) {
      operationCancellation.fail(error);
      throw error;
    } finally {
      operationCancellation.dispose(cancellationSignal);
      if (
        this.detailRequestGenerations.get(detailGenerationKey) ===
        requestGeneration
      ) {
        this.detailRequestGenerations.delete(detailGenerationKey);
      }
    }
  }

  public getCanonicalUrl(resourceIdentity: CloudResourceIdentity): vscode.Uri {
    if (resourceIdentity.providerId !== "github") {
      throw new GitHubProviderError(
        "invalidResponse",
        "This resource is not a GitHub.com resource.",
      );
    }
    return this.canonicalUriFactory(createGitHubCanonicalUrl(resourceIdentity));
  }

  private clearCache(): void {
    this.invalidateRequestGenerations(this.dashboardRequestGenerations);
    this.invalidateRequestGenerations(this.detailRequestGenerations);
    this.dashboardCache.clear();
  }

  private allocateRequestGeneration(): number {
    if (this.requestGenerationCounter === Number.MAX_SAFE_INTEGER) {
      throw new GitHubProviderError(
        "invalidResponse",
        "GitHub request generation limit was exceeded.",
      );
    }
    this.requestGenerationCounter += 1;
    return this.requestGenerationCounter;
  }

  private invalidateRequestGenerations(
    requestGenerations: Map<string, number>,
  ): void {
    for (const requestKey of requestGenerations.keys()) {
      requestGenerations.set(requestKey, this.allocateRequestGeneration());
    }
  }

  public disconnect(): void {
    this.clearCache();
    this.sessionPreference.clear();
  }

  public get requestConcurrency(): {
    readonly activeRequests: number;
    readonly queuedRequests: number;
  } {
    return {
      activeRequests: this.requestCoordinator.activeRequests,
      queuedRequests: this.requestCoordinator.queuedRequestsCount,
    };
  }

  private async completeReviewConnections(
    repositoryIdentity: GitHubRepositoryIdentity,
    pullRequestNode: GitHubPullRequestNode,
    graphqlClient: GitHubGraphqlClient,
    operationCancellation: GitHubOperationCancellation,
    operationBudget: GitHubAggregateOperationBudget,
  ): Promise<GitHubPullRequestNode> {
    try {
      let reviewRequestsConnection = pullRequestNode.reviewRequests;
      let reviewsConnection = pullRequestNode.reviews;
      const reviewRequestNodes: GitHubReviewRequestNode[] = [];
      const reviewNodes: GitHubReviewNode[] = [];
      appendBoundedGitHubReviewNodes(
        reviewRequestNodes,
        reviewRequestsConnection?.nodes,
        "review requests",
        operationBudget,
      );
      appendBoundedGitHubReviewNodes(
        reviewNodes,
        reviewsConnection?.nodes,
        "reviews",
        operationBudget,
      );
      let reviewRequestsPageInfo = reviewRequestsConnection?.pageInfo;
      let reviewsPageInfo = reviewsConnection?.pageInfo;
      let reviewRequestsCursor = readNextReviewCursor(
        reviewRequestsConnection,
        "review requests",
      );
      let reviewsCursor = readNextReviewCursor(reviewsConnection, "reviews");

      for (
        let pageNumber = 0;
        reviewRequestsCursor !== undefined || reviewsCursor !== undefined;
        pageNumber += 1
      ) {
        if (pageNumber >= maximumPaginationPages) {
          throw new GitHubProviderError(
            "paginationIncomplete",
            "GitHub returned more review pages than Git'o can safely load.",
            { partialDataDisabled: true },
          );
        }
        const pageGraphqlData = await this.executeGraphqlRequest(
          graphqlClient,
          githubPullRequestReviewPageQuery,
          {
            owner: repositoryIdentity.owner,
            repository: repositoryIdentity.repositoryName,
            pullRequestNumber: pullRequestNode.number,
            reviewRequestsCursor,
            reviewsCursor,
            request: { signal: operationCancellation.signal },
          },
          operationCancellation.signal,
        );
        const pagePullRequestNode = readPullRequestNode(pageGraphqlData);
        if (!pagePullRequestNode) {
          throw new GitHubProviderError(
            "notFound",
            "GitHub could not find this pull request.",
          );
        }

        if (reviewRequestsCursor !== undefined) {
          const pageReviewRequestsConnection =
            pagePullRequestNode.reviewRequests;
          const nextReviewRequestsCursor = readNextReviewCursor(
            pageReviewRequestsConnection,
            "review requests",
          );
          appendBoundedGitHubReviewNodes(
            reviewRequestNodes,
            pageReviewRequestsConnection?.nodes,
            "review requests",
            operationBudget,
          );
          if (pageReviewRequestsConnection?.pageInfo !== undefined) {
            reviewRequestsPageInfo = pageReviewRequestsConnection.pageInfo;
          }
          reviewRequestsCursor = nextReviewRequestsCursor;
        }

        if (reviewsCursor !== undefined) {
          const pageReviewsConnection = pagePullRequestNode.reviews;
          const nextReviewsCursor = readNextReviewCursor(
            pageReviewsConnection,
            "reviews",
          );
          appendBoundedGitHubReviewNodes(
            reviewNodes,
            pageReviewsConnection?.nodes,
            "reviews",
            operationBudget,
          );
          if (pageReviewsConnection?.pageInfo !== undefined) {
            reviewsPageInfo = pageReviewsConnection.pageInfo;
          }
          reviewsCursor = nextReviewsCursor;
        }
      }

      if (
        reviewRequestsConnection !== undefined &&
        reviewRequestsConnection !== null
      ) {
        reviewRequestsConnection = {
          ...reviewRequestsConnection,
          nodes: reviewRequestNodes,
          ...(reviewRequestsPageInfo !== undefined
            ? { pageInfo: reviewRequestsPageInfo }
            : {}),
        };
      }
      if (reviewsConnection !== undefined && reviewsConnection !== null) {
        reviewsConnection = {
          ...reviewsConnection,
          nodes: reviewNodes,
          ...(reviewsPageInfo !== undefined
            ? { pageInfo: reviewsPageInfo }
            : {}),
        };
      }

      return {
        ...pullRequestNode,
        reviewRequests: reviewRequestsConnection ?? null,
        reviews: reviewsConnection ?? null,
      };
    } catch (error: unknown) {
      operationCancellation.fail(error);
      throw error;
    }
  }

  private async fetchRepositoryDashboard(
    repositoryIdentity: GitHubRepositoryIdentity,
    connection: GitHubProviderConnection,
    cancellationSignal: AbortSignal,
  ): Promise<GitHubRepositoryDashboardSnapshot> {
    const graphqlClient = this.graphqlClientFactory(connection.accessToken);
    const operationBudget = new GitHubAggregateOperationBudget();
    const operationCancellation = new GitHubOperationCancellation(
      cancellationSignal,
    );
    const pullRequestNodes: GitHubPullRequestNode[] = [];
    let pullRequestCursor: string | null = null;
    let graphqlData: Record<string, unknown> = {};
    let currentUserLogin = "";

    try {
      for (let pageNumber = 0; ; pageNumber += 1) {
        if (pageNumber >= maximumPaginationPages) {
          throw new GitHubProviderError(
            "paginationIncomplete",
            "GitHub returned more pull-request pages than Git'o can safely load.",
            { partialDataDisabled: true },
          );
        }
        graphqlData = await this.executeGraphqlRequest(
          graphqlClient,
          githubDashboardQuery,
          {
            owner: repositoryIdentity.owner,
            repository: repositoryIdentity.repositoryName,
            pullRequestCursor,
            request: { signal: operationCancellation.signal },
          },
          operationCancellation.signal,
        );
        if (!isRecord(graphqlData["repository"])) {
          throw new GitHubProviderError(
            "notFound",
            "GitHub could not find this repository.",
          );
        }
        if (!currentUserLogin) {
          const normalizedCurrentUser = normalizeViewer(graphqlData);
          currentUserLogin =
            readViewerLogin(graphqlData) || normalizedCurrentUser.displayName;
        }
        const dashboardPagePullRequestNodes = readPullRequestNodes(
          graphqlData,
          operationBudget,
        );
        const completionResults = await Promise.allSettled(
          dashboardPagePullRequestNodes.map((pullRequestNode) =>
            this.completeReviewConnections(
              repositoryIdentity,
              pullRequestNode,
              graphqlClient,
              operationCancellation,
              operationBudget,
            ),
          ),
        );
        operationCancellation.throwIfFailed();
        const rejectedCompletion = completionResults.find(
          (completionResult): completionResult is PromiseRejectedResult =>
            completionResult.status === "rejected",
        );
        if (rejectedCompletion) {
          throw rejectedCompletion.reason;
        }
        pullRequestNodes.push(
          ...completionResults.map((completionResult) => {
            if (completionResult.status !== "fulfilled") {
              throw completionResult.reason;
            }
            return completionResult.value;
          }),
        );
        const nextCursor = readNextPullRequestCursor(graphqlData);
        if (nextCursor === undefined) {
          break;
        }
        pullRequestCursor = nextCursor;
      }

      if (!currentUserLogin) {
        throw new GitHubProviderError(
          "invalidResponse",
          "GitHub returned an incomplete repository response.",
        );
      }
      const normalizedPullRequests = pullRequestNodes.map((pullRequestNode) =>
        normalizePullRequestSummary(
          pullRequestNode,
          repositoryIdentity,
          currentUserLogin,
        ),
      );
      const normalizedRateLimit = normalizeRateLimitSnapshot(
        graphqlData["rateLimit"],
      );
      return {
        repositoryRoot: createGitHubCanonicalUrl(repositoryIdentity),
        providerId: "github",
        pullRequests: normalizedPullRequests,
        fetchedAt: this.now().toISOString(),
        cacheStatus: "fresh",
        ...(normalizedRateLimit ? { rateLimit: normalizedRateLimit } : {}),
      };
    } finally {
      operationCancellation.dispose(cancellationSignal);
    }
  }

  private async executeGraphqlRequest(
    graphqlClient: GitHubGraphqlClient,
    query: string,
    parameters: Readonly<Record<string, unknown>>,
    cancellationSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (cancellationSignal.aborted) {
      throw new GitHubProviderError(
        "cancelled",
        "GitHub request was cancelled.",
      );
    }
    const requestController = new AbortController();
    let didTimeout = false;
    const abortForCaller = (): void => requestController.abort();
    cancellationSignal.addEventListener("abort", abortForCaller, {
      once: true,
    });
    const timeoutHandle = setTimeout(() => {
      didTimeout = true;
      requestController.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await this.requestCoordinator.run(
        async (requestSignal) => {
          let removeAbortListener = (): void => undefined;
          const abortPromise = new Promise<never>((_, reject) => {
            const abortHandler = (): void => {
              reject(
                didTimeout && !cancellationSignal.aborted
                  ? new GitHubProviderError(
                      "timeout",
                      "GitHub did not respond before the request deadline.",
                    )
                  : new GitHubProviderError(
                      "cancelled",
                      "GitHub request was cancelled.",
                    ),
              );
            };
            requestSignal.addEventListener("abort", abortHandler, {
              once: true,
            });
            removeAbortListener = (): void =>
              requestSignal.removeEventListener("abort", abortHandler);
          });
          try {
            return await Promise.race([
              graphqlClient(query, {
                ...parameters,
                request: { signal: requestSignal },
              }),
              abortPromise,
            ]);
          } finally {
            removeAbortListener();
          }
        },
        requestController.signal,
      );
      return normalizeGraphqlResponse(response);
    } catch (error) {
      if (didTimeout && !cancellationSignal.aborted) {
        throw new GitHubProviderError(
          "timeout",
          "GitHub did not respond before the request deadline.",
        );
      }
      throw getNormalizedFailureError(error, cancellationSignal);
    } finally {
      clearTimeout(timeoutHandle);
      cancellationSignal.removeEventListener("abort", abortForCaller);
    }
  }
}

export {
  buildGitHubSnapshotCacheKey,
  classifyPullRequestState,
  createGitHubCanonicalUrl,
  normalizePullRequestDetails,
  normalizePullRequestSummary,
  normalizeRateLimitSnapshot,
  parseGitHubRemote,
};
