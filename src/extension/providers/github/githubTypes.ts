import type * as vscode from "vscode";
import type {
  CloudRepositoryIdentity,
  CloudUser,
  ProviderConnection,
} from "../../../domain/cloudGitProvider.js";
import type {
  PullRequestDetails,
  PullRequestIdentity,
  PullRequestSummary,
} from "../../../domain/pullRequest.js";
import type {
  RepositoryDashboardSnapshot,
  RepositoryDashboardStaleReason,
} from "../../../domain/repositoryDashboard.js";

export const githubAuthenticationScopes = ["repo", "read:user"] as const;

export interface GitHubAuthenticationApi {
  getSession(
    providerId: "github",
    scopes: readonly string[],
    options: vscode.AuthenticationGetSessionOptions,
  ): Thenable<vscode.AuthenticationSession | undefined>;
}

export interface GitHubGraphqlClient {
  (
    query: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export type GitHubCanonicalUriFactory = (canonicalUrl: string) => vscode.Uri;

export interface GitHubProviderDependencies {
  readonly authentication?: GitHubAuthenticationApi;
  readonly graphqlClientFactory?: (accessToken: string) => GitHubGraphqlClient;
  readonly fetchImplementation?: typeof fetch;
  readonly canonicalUriFactory?: GitHubCanonicalUriFactory;
  readonly maxResponseBytes?: number;
  readonly now?: () => Date;
  readonly maximumConcurrentRequests?: number;
  readonly cacheTtlMilliseconds?: number;
  readonly requestTimeoutMs?: number;
}

export type GitHubProviderErrorKind =
  | "cancelled"
  | "authentication"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "rateLimit"
  | "server"
  | "network"
  | "invalidResponse"
  | "paginationIncomplete"
  | "staleResponse"
  | "timeout";

export interface GitHubRateLimitSnapshot {
  readonly remaining: number;
  readonly limit?: number;
  readonly used?: number;
  readonly resetAt?: string;
}

export interface GitHubRepositoryDashboardSnapshot extends RepositoryDashboardSnapshot {
  readonly cacheStatus: "fresh" | "stale";
  readonly staleReason?: Extract<
    GitHubProviderErrorKind,
    RepositoryDashboardStaleReason
  >;
  readonly rateLimit?: GitHubRateLimitSnapshot;
}

export interface GitHubPullRequestDetails extends PullRequestDetails {
  readonly cacheStatus: "fresh";
}

export interface GitHubProviderConnection extends ProviderConnection {
  readonly providerId: "github";
}

export interface GitHubCurrentUser extends CloudUser {
  readonly providerId: "github";
}

export type GitHubPullRequestSummary = PullRequestSummary & {
  readonly providerId: "github";
};

export type GitHubRepositoryIdentity = CloudRepositoryIdentity & {
  readonly providerId: "github";
};

export type GitHubPullRequestResourceIdentity = PullRequestIdentity & {
  readonly providerId: "github";
};

export class GitHubProviderError extends Error {
  public readonly kind: GitHubProviderErrorKind;
  public readonly statusCode: number | undefined;
  public readonly rateLimit: GitHubRateLimitSnapshot | undefined;
  public readonly staleSnapshot: GitHubRepositoryDashboardSnapshot | undefined;
  public readonly partialDataDisabled: boolean;

  public constructor(
    kind: GitHubProviderErrorKind,
    userMessage: string,
    details: {
      readonly statusCode?: number;
      readonly rateLimit?: GitHubRateLimitSnapshot;
      readonly staleSnapshot?: GitHubRepositoryDashboardSnapshot;
      readonly partialDataDisabled?: boolean;
    } = {},
  ) {
    super(userMessage);
    this.name = "GitHubProviderError";
    this.kind = kind;
    this.statusCode = details.statusCode;
    this.rateLimit = details.rateLimit;
    this.staleSnapshot = details.staleSnapshot;
    this.partialDataDisabled = details.partialDataDisabled ?? false;
  }
}

export function isGitHubProviderError(
  error: unknown,
): error is GitHubProviderError {
  return error instanceof GitHubProviderError;
}
