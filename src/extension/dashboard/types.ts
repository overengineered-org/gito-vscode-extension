import type * as vscode from "vscode";
import type {
  CloudGitProvider,
  CloudProviderId,
} from "../../domain/cloudGitProvider.js";
import type {
  PullRequestDetails,
  PullRequestIdentity,
} from "../../domain/pullRequest.js";
import type { GitHistoryService } from "../git/gitHistoryService.js";
import type { LocalGitRepositoryService } from "../git/localGitRepositoryService.js";
import type {
  RepositoryDiscovery,
  RepositorySelectionContext,
} from "../repositories/repositoryDiscovery.js";
import type { RepositoryHomeSnapshot } from "../../protocol/repositoryHomeProtocol.js";

export interface DashboardWorkspaceTrustGuard {
  runTrustedMutation<Result>(
    operationName: string,
    mutation: () => Promise<Result> | Result,
  ): Promise<Result>;
}

export type DashboardSection =
  "localSummary" | "commitActivity" | CloudProviderId;

export interface DashboardDependencies {
  readonly repositoryDiscovery: RepositoryDiscovery;
  readonly repositoryService: LocalGitRepositoryService;
  readonly historyService: GitHistoryService;
  readonly providers: readonly CloudGitProvider[];
  readonly authorEmails?: readonly string[];
  readonly clock?: () => Date;
  /** Required final trust gate; checked after confirmation and async work. */
  readonly workspaceTrustGuard: DashboardWorkspaceTrustGuard;
}

export interface DashboardSnapshotListener {
  (snapshot: RepositoryHomeSnapshot): void;
}

export interface DashboardOrchestratorApi {
  getSnapshot(): RepositoryHomeSnapshot;
  shouldRefreshProviderDashboard(providerId: CloudProviderId): boolean;
  subscribe(listener: DashboardSnapshotListener): DashboardDisposable;
  load(options?: DashboardLoadOptions): Promise<void>;
  refresh(options?: DashboardRefreshOptions): Promise<void>;
  refreshProvider(providerId: CloudProviderId): Promise<void>;
  selectRepository(repositoryRoot: string): Promise<void>;
  setProviderFilter(
    providerFilter: RepositoryHomeSnapshot["providerFilter"],
  ): void;
  connectProvider(providerId: CloudProviderId): Promise<void>;
  disconnectProvider(providerId: CloudProviderId): void;
  cancelPendingRequests(): void;
  getPullRequestDetails(
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal?: AbortSignal,
  ): Promise<PullRequestDetails>;
  checkoutPullRequest(
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal?: AbortSignal,
  ): Promise<void>;
  openExternalPullRequest(
    pullRequestIdentity: PullRequestIdentity,
    cancellationSignal?: AbortSignal,
  ): Promise<void>;
  dispose(): void;
}

export interface DashboardLoadOptions extends RepositorySelectionContext {
  readonly providerFilter?: "all" | CloudProviderId;
}

export interface DashboardRefreshOptions {
  /** Re-read bundled Git status unless the caller already received a state event. */
  readonly refreshStatus?: boolean;
}

export type DashboardFailureCode =
  | "disposed"
  | "repositoryDiscovery"
  | "repositorySelection"
  | "repositoryNotFound"
  | "localSummary"
  | "commitActivity"
  | "providerDetection"
  | "providerUnavailable"
  | "providerConnection"
  | "providerData"
  | "pullRequestRepositoryMismatch"
  | "pullRequestDetails"
  | "checkoutPullRequest"
  | "openExternalPullRequest"
  | "cancelled"
  | "stale";

export interface DashboardFailureDetails {
  readonly code: DashboardFailureCode;
  readonly operationName: string;
  readonly section?: DashboardSection;
  readonly providerId?: CloudProviderId;
  readonly cause?: unknown;
}

export class DashboardOrchestrationError extends Error {
  public readonly code: DashboardFailureCode;
  public readonly operationName: string;
  public readonly section: DashboardSection | undefined;
  public readonly providerId: CloudProviderId | undefined;
  override readonly cause: unknown;

  public constructor(userMessage: string, details: DashboardFailureDetails) {
    super(userMessage, { cause: details.cause });
    this.name = "DashboardOrchestrationError";
    this.code = details.code;
    this.operationName = details.operationName;
    this.section = details.section;
    this.providerId = details.providerId;
    this.cause = details.cause;
  }
}

export function isDashboardOrchestrationError(
  error: unknown,
): error is DashboardOrchestrationError {
  return error instanceof DashboardOrchestrationError;
}

export type DashboardDisposable = vscode.Disposable;
