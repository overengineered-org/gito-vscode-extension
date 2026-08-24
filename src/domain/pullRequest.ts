import type { CloudProviderId } from "./cloudGitProvider.js";

export type PullRequestState =
  "ready" | "changesRequested" | "checksRunning" | "draft" | "blocked";

export interface PullRequestIdentity {
  readonly providerId: CloudProviderId;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly repositoryProject?: string;
  readonly pullRequestNumber: number;
}

export interface PullRequestSummary extends PullRequestIdentity {
  readonly title: string;
  readonly authorDisplayName: string;
  readonly updatedAt: string;
  readonly commentCount: number;
  readonly isAuthoredByCurrentUser: boolean;
  readonly reviewRequestedFromCurrentUser: boolean;
  readonly isDraft: boolean;
  readonly state: PullRequestState;
  readonly completedReviewCount: number;
  readonly requiredReviewCount: number;
}

export interface PullRequestDetails extends PullRequestSummary {
  readonly bodyText: string;
  readonly sourceBranchName: string;
  readonly targetBranchName: string;
  readonly canonicalUrl: string;
}
