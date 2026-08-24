import type { CloudProviderId } from "./cloudGitProvider.js";
import type { PullRequestSummary } from "./pullRequest.js";

export type RepositoryDashboardCacheStatus = "fresh" | "stale";
export type RepositoryDashboardStaleReason =
  | "rateLimit"
  | "server"
  | "network"
  | "timeout"
  | "rateLimited"
  | "serverFailure"
  | "networkFailure";

export interface CommitActivityDay {
  readonly date: string;
  readonly commitCount: number;
}

export interface RepositoryHealthSnapshot {
  readonly branchName: string;
  readonly uncommittedChangeCount: number;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly lastSuccessfulFetchAt?: string | undefined;
}

export interface RepositoryDashboardSnapshot {
  readonly repositoryRoot: string;
  readonly providerId: CloudProviderId;
  readonly pullRequests: readonly PullRequestSummary[];
  readonly fetchedAt: string;
  readonly cacheStatus?: RepositoryDashboardCacheStatus;
  readonly staleReason?: RepositoryDashboardStaleReason;
}

export interface RepositoryHomeSnapshot {
  readonly repositoryRoot: string;
  readonly repositoryDisplayName: string;
  readonly repositoryHealth: RepositoryHealthSnapshot;
  readonly commitActivity: readonly CommitActivityDay[];
  readonly cloudDashboards: readonly RepositoryDashboardSnapshot[];
}
