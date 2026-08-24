import type * as vscode from "vscode";
import type { PullRequestDetails, PullRequestIdentity } from "./pullRequest.js";
import type { RepositoryDashboardSnapshot } from "./repositoryDashboard.js";

export type CloudProviderId = "github";

export interface CloudRepositoryIdentity {
  readonly providerId: CloudProviderId;
  readonly owner: string;
  readonly repositoryName: string;
  readonly organization?: string;
  readonly project?: string;
}

export interface ProviderConnection {
  readonly providerId: CloudProviderId;
  readonly sessionId: string;
  readonly accessToken: string;
  /** Provider-internal acquisition identity; never serialized to the webview. */
  readonly acquisitionGeneration?: number;
}

export interface CloudUser {
  readonly providerId: CloudProviderId;
  readonly userId: string;
  readonly displayName: string;
}

export interface RepositoryDashboardOptions {
  readonly forceRefresh?: boolean;
}

export type CloudResourceIdentity =
  CloudRepositoryIdentity | PullRequestIdentity;

export interface CloudGitProvider {
  readonly providerId: CloudProviderId;
  detectRepository(
    remoteUrls: readonly string[],
  ): CloudRepositoryIdentity | undefined;
  connect(
    cancellationToken: vscode.CancellationToken,
  ): Promise<ProviderConnection>;
  connectSilently(
    cancellationToken: vscode.CancellationToken,
  ): Promise<ProviderConnection>;
  /** Commits a session only after its provider data is fully initialized. */
  commitConnection?(connection: ProviderConnection): void;
  /** Discards an acquired but uncommitted session after a failed request. */
  discardConnection?(connection: ProviderConnection): void;
  /** Reports expiry using the provider's actual dashboard cache policy. */
  isRepositoryDashboardCacheExpired?(
    repositoryIdentity: CloudRepositoryIdentity,
    sessionId: string,
  ): boolean;
  disconnect(): void;
  getCurrentUser(
    connection: ProviderConnection,
    cancellationSignal: AbortSignal,
  ): Promise<CloudUser>;
  getRepositoryDashboard(
    repositoryIdentity: CloudRepositoryIdentity,
    connection: ProviderConnection,
    cancellationSignal: AbortSignal,
    options?: RepositoryDashboardOptions,
  ): Promise<RepositoryDashboardSnapshot>;
  getPullRequestDetails(
    pullRequestIdentity: PullRequestIdentity,
    connection: ProviderConnection,
    cancellationSignal: AbortSignal,
  ): Promise<PullRequestDetails>;
  getCanonicalUrl(resourceIdentity: CloudResourceIdentity): vscode.Uri;
}
