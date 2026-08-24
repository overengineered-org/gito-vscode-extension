import type { RepositoryHomeSnapshot } from "../../protocol/repositoryHomeProtocol.js";
import { gitoProtocolVersion } from "../../protocol/repositoryHomeProtocol.js";
import { vscodeWebviewApi } from "../vscodeApi.js";

export type CloudProviderId = "github";
export type ProviderFilter = "all" | CloudProviderId;
export type PullRequestListKind = "review" | "mine";
export type SelectedRepositorySnapshot = NonNullable<
  RepositoryHomeSnapshot["selectedRepository"]
>;
export type CloudDashboardSnapshot =
  SelectedRepositorySnapshot["cloudDashboards"][number];
export type CloudDashboardCacheStatus = NonNullable<
  CloudDashboardSnapshot["cacheStatus"]
>;
export type CloudDashboardStaleReason = NonNullable<
  CloudDashboardSnapshot["staleReason"]
>;
export type PullRequestViewModel =
  SelectedRepositorySnapshot["cloudDashboards"][number]["pullRequests"][number];
export type PullRequestState = PullRequestViewModel["state"];
export type RepositoryHealthSnapshot =
  SelectedRepositorySnapshot["repositoryHealth"];
export type CommitActivityDay =
  SelectedRepositorySnapshot["commitActivity"]["days"][number];

export interface ProviderContext {
  readonly providerDisplayName: string;
  readonly connectionState:
    "disconnected" | "connecting" | "connected" | "failed";
  readonly cacheStatus?: CloudDashboardCacheStatus;
  readonly staleReason?: CloudDashboardStaleReason;
}

export const initialRepositoryHealth: RepositoryHealthSnapshot = {
  branchName: "Not available",
  uncommittedChangeCount: 0,
  aheadCount: 0,
  behindCount: 0,
};

const shippedProviderNames: Readonly<Record<CloudProviderId, string>> = {
  github: "GitHub",
};

export const pullRequestStateLabels: Record<PullRequestState, string> = {
  ready: "Ready",
  changesRequested: "Changes requested",
  checksRunning: "Checks running",
  draft: "Draft",
  blocked: "Blocked",
};

export const summaryCards = [
  { key: "review", label: "Review requested", icon: "organization" },
  { key: "mine", label: "My pull requests", icon: "git-pull-request" },
  { key: "drafts", label: "Drafts", icon: "file" },
  { key: "ready", label: "Merge-ready", icon: "pass" },
] as const;

export function Icon({ name }: { readonly name: string }) {
  return <span aria-hidden="true" class={`codicon codicon-${name}`} />;
}

export function providerDisplayName(providerId: CloudProviderId): string {
  return shippedProviderNames[providerId];
}

export function providerConnectionLabel(
  providerContext: ProviderContext,
): string {
  if (providerContext.connectionState === "connected")
    return providerContext.providerDisplayName;
  if (providerContext.connectionState === "connecting") return "Connecting";
  if (providerContext.connectionState === "failed") return "Connection failed";
  return "Not connected";
}

export function staleReasonLabel(
  staleReason: CloudDashboardStaleReason | undefined,
): string {
  switch (staleReason) {
    case "rateLimit":
    case "rateLimited":
      return "rate limit";
    case "server":
    case "serverFailure":
      return "server error";
    case "network":
    case "networkFailure":
      return "network error";
    case "timeout":
      return "timeout";
    default:
      return "previous successful data";
  }
}

export function ProviderIcon() {
  return (
    <span class="provider-icon" aria-hidden="true">
      <Icon name="github-inverted" />
    </span>
  );
}

export function formatCommitCount(commitCount: number): string {
  return commitCount >= 250000
    ? "250,000+"
    : new Intl.NumberFormat().format(commitCount);
}

export function formatRelativeTimestamp(timestamp: string): string {
  const timestampMilliseconds = Date.parse(timestamp);
  if (!Number.isFinite(timestampMilliseconds)) return timestamp;
  const elapsedSeconds = Math.round(
    (Date.now() - timestampMilliseconds) / 1000,
  );
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  const elapsedHours = Math.round(elapsedMinutes / 60);
  const elapsedDays = Math.round(elapsedHours / 24);
  if (Math.abs(elapsedSeconds) < 60) return "just now";
  if (Math.abs(elapsedMinutes) < 60) return `${Math.abs(elapsedMinutes)}m ago`;
  if (Math.abs(elapsedHours) < 24) return `${Math.abs(elapsedHours)}h ago`;
  if (Math.abs(elapsedDays) < 30) return `${Math.abs(elapsedDays)}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(timestampMilliseconds),
  );
}

export function pullRequestKey(pullRequest: PullRequestViewModel): string {
  return `${pullRequest.providerId}:${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.pullRequestNumber}`;
}

export function postWebviewAction(message: Record<string, unknown>): void {
  vscodeWebviewApi.postMessage({
    protocolVersion: gitoProtocolVersion,
    ...message,
  });
}
