import { useEffect, useState } from "preact/hooks";
import type { PullRequestDetails } from "../../protocol/repositoryHomeProtocol.js";
import {
  formatRelativeTimestamp,
  Icon,
  pullRequestKey,
  ProviderIcon,
  providerDisplayName,
  pullRequestStateLabels,
  type CloudProviderId,
  type ProviderContext,
  type ProviderFilter,
  type PullRequestListKind,
  type PullRequestViewModel,
} from "./repositoryHomeTypes.js";

function PullRequestRow({
  pullRequest,
  providerContext,
  listKind,
  isSelected,
  onSelect,
}: {
  readonly pullRequest: PullRequestViewModel;
  readonly providerContext: ProviderContext;
  readonly listKind: PullRequestListKind;
  readonly isSelected: boolean;
  readonly onSelect: (triggerElement: HTMLButtonElement) => void;
}) {
  const isReviewRequest = listKind === "review";
  const reviewProgress = `${pullRequest.completedReviewCount}/${pullRequest.requiredReviewCount}`;
  const statusLabel = pullRequestStateLabels[pullRequest.state];
  const rowLabel = isReviewRequest
    ? `${providerContext.providerDisplayName} pull request ${pullRequest.pullRequestNumber}, ${pullRequest.title}, ${reviewProgress} reviews, ${pullRequest.commentCount} comments`
    : `${providerContext.providerDisplayName} pull request ${pullRequest.pullRequestNumber}, ${pullRequest.title}, ${statusLabel}, ${pullRequest.commentCount} comments`;

  return (
    <button
      type="button"
      class={`pull-request-row${isSelected ? " is-selected" : ""}`}
      aria-pressed={isSelected}
      aria-label={rowLabel}
      onClick={(clickEvent) => onSelect(clickEvent.currentTarget)}
    >
      <ProviderIcon />
      <span class="pull-request-copy">
        <span class="pull-request-title">
          <Icon name="git-pull-request" />
          <span>{pullRequest.title}</span>
        </span>
        <span class="pull-request-meta">
          <span>{providerContext.providerDisplayName}</span>
          <span aria-hidden="true">·</span>
          <span>#{pullRequest.pullRequestNumber}</span>
          <span aria-hidden="true">·</span>
          {isReviewRequest ? (
            <span>{pullRequest.authorDisplayName}</span>
          ) : null}
          {isReviewRequest ? <span aria-hidden="true">·</span> : null}
          <span>{formatRelativeTimestamp(pullRequest.updatedAt)}</span>
        </span>
      </span>
      {isReviewRequest ? (
        <span
          class={`review-progress review-progress--${pullRequest.completedReviewCount >= pullRequest.requiredReviewCount ? "complete" : "pending"}`}
          aria-label={`${reviewProgress} reviews complete`}
        >
          <Icon
            name={
              pullRequest.completedReviewCount >=
              pullRequest.requiredReviewCount
                ? "pass-filled"
                : "circle-large-outline"
            }
          />
          <span>{reviewProgress}</span>
        </span>
      ) : (
        <span class={`status-badge status-badge--${pullRequest.state}`}>
          <Icon
            name={
              pullRequest.state === "ready"
                ? "pass"
                : pullRequest.state === "blocked"
                  ? "error"
                  : "circle-large-outline"
            }
          />
          <span>{statusLabel}</span>
        </span>
      )}
      <span
        class="comment-count"
        aria-label={`${pullRequest.commentCount} comments`}
      >
        <Icon name="comment" />
        <span>{pullRequest.commentCount}</span>
      </span>
    </button>
  );
}

export function PullRequestPanel({
  heading,
  headingId,
  pullRequests,
  providerContexts,
  listKind,
  isLoading,
  hasSnapshot,
  hasSelectedRepository,
  providerFilter,
  providerErrors,
  activeMetric,
  selectedPullRequestKey,
  onSelectPullRequest,
  onRetry,
  headingReference,
}: {
  readonly heading: string;
  readonly headingId: string;
  readonly pullRequests: readonly PullRequestViewModel[];
  readonly providerContexts: ReadonlyMap<CloudProviderId, ProviderContext>;
  readonly listKind: PullRequestListKind;
  readonly isLoading: boolean;
  readonly hasSnapshot: boolean;
  readonly hasSelectedRepository: boolean;
  readonly providerFilter: ProviderFilter;
  readonly providerErrors: ReadonlyMap<CloudProviderId, string>;
  readonly activeMetric: string | undefined;
  readonly selectedPullRequestKey: string | undefined;
  readonly onRetry: () => void;
  readonly onSelectPullRequest: (
    pullRequest: PullRequestViewModel,
    triggerElement: HTMLButtonElement,
  ) => void;
  readonly headingReference: (
    headingElement: HTMLHeadingElement | null,
  ) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const visibleProviderErrors = [...providerErrors.entries()].filter(
    ([providerId]) => providerFilter === "all" || providerId === providerFilter,
  );
  const failedProviderIds = new Set(
    visibleProviderErrors.map(([providerId]) => providerId),
  );
  const providerFilteredPullRequests = pullRequests
    .filter((pullRequest) => !failedProviderIds.has(pullRequest.providerId))
    .filter(
      (pullRequest) =>
        providerFilter === "all" || pullRequest.providerId === providerFilter,
    );
  const metricFilteredPullRequests = providerFilteredPullRequests.filter(
    (pullRequest) => {
      if (activeMetric === undefined) return true;
      if (listKind === "review") return activeMetric === "review";
      if (activeMetric === "review") return false;
      if (activeMetric === "mine") return true;
      if (activeMetric === "drafts") return pullRequest.isDraft;
      if (activeMetric === "ready")
        return !pullRequest.isDraft && pullRequest.state === "ready";
      return true;
    },
  );
  const visiblePullRequests = isExpanded
    ? metricFilteredPullRequests
    : metricFilteredPullRequests.slice(0, 3);
  const isPanelUnavailable =
    visibleProviderErrors.length > 0 &&
    providerFilteredPullRequests.length === 0;

  useEffect(() => {
    if (metricFilteredPullRequests.length <= 3) setIsExpanded(false);
  }, [providerFilter, activeMetric, metricFilteredPullRequests.length]);

  return (
    <section class="pull-request-panel" aria-labelledby={headingId}>
      <div class="panel-heading-row">
        <h2 id={headingId} tabIndex={-1} ref={headingReference}>
          {heading}
        </h2>
        <span
          class="panel-count"
          aria-label={
            isPanelUnavailable
              ? "Pull requests unavailable"
              : visibleProviderErrors.length === 0
                ? `${metricFilteredPullRequests.length} pull requests`
                : `${metricFilteredPullRequests.length} pull requests shown; some providers unavailable`
          }
        >
          {isPanelUnavailable ? "—" : metricFilteredPullRequests.length}
        </span>
      </div>
      <div class="pull-request-list">
        {isLoading ? <p class="empty-message">Loading pull requests</p> : null}
        {visibleProviderErrors.map(([providerId, providerError]) => (
          <p
            class="empty-message pull-request-error"
            role="alert"
            key={providerId}
          >
            <span>
              {providerDisplayName(providerId)}: {providerError}
            </span>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </p>
        ))}
        {!isLoading && hasSnapshot && !hasSelectedRepository ? (
          <p class="empty-message">Open a repository to see pull requests.</p>
        ) : null}
        {!isLoading && hasSnapshot && hasSelectedRepository
          ? visiblePullRequests.map((pullRequest) => {
              const providerContext = providerContexts.get(
                pullRequest.providerId,
              ) ?? {
                providerDisplayName: providerDisplayName(
                  pullRequest.providerId,
                ),
                connectionState: "connected" as const,
              };
              return (
                <PullRequestRow
                  key={pullRequestKey(pullRequest)}
                  pullRequest={pullRequest}
                  providerContext={providerContext}
                  listKind={listKind}
                  isSelected={
                    selectedPullRequestKey === pullRequestKey(pullRequest)
                  }
                  onSelect={(triggerElement) =>
                    onSelectPullRequest(pullRequest, triggerElement)
                  }
                />
              );
            })
          : null}
        {!isPanelUnavailable &&
        !isLoading &&
        hasSnapshot &&
        hasSelectedRepository &&
        visiblePullRequests.length === 0 ? (
          <p class="empty-message">
            {providerFilteredPullRequests.length === 0
              ? "No pull requests for this provider."
              : "No pull requests match this summary."}
          </p>
        ) : null}
      </div>
      {metricFilteredPullRequests.length > 3 ? (
        <button
          class="text-button"
          type="button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          aria-expanded={isExpanded}
        >
          {isExpanded
            ? "Show less"
            : `View all ${metricFilteredPullRequests.length}`}
        </button>
      ) : null}
    </section>
  );
}

export function PullRequestDetailsSurface({
  pullRequest,
  providerContext,
  detailsState,
  pullRequestDetails,
  detailsError,
  activeOperation,
  headingReference,
  onClose,
  onCheckout,
  onOpenExternal,
}: {
  readonly pullRequest: PullRequestViewModel;
  readonly providerContext: ProviderContext;
  readonly detailsState: "loading" | "loaded" | "error";
  readonly pullRequestDetails: PullRequestDetails | undefined;
  readonly detailsError: string | undefined;
  readonly activeOperation:
    "checkoutPullRequest" | "openExternalPullRequest" | undefined;
  readonly headingReference: { current: HTMLHeadingElement | null };
  readonly onClose: () => void;
  readonly onCheckout: () => void;
  readonly onOpenExternal: () => void;
}) {
  const isLoaded =
    detailsState === "loaded" && pullRequestDetails !== undefined;
  const detailViewModel = pullRequestDetails ?? pullRequest;
  const sourceBranchName =
    isLoaded && pullRequestDetails !== undefined
      ? pullRequestDetails.sourceBranchName
      : "branch";
  return (
    <section
      class="pull-request-details"
      aria-labelledby="pull-request-details-heading"
      aria-busy={detailsState === "loading" ? "true" : undefined}
    >
      <div class="details-heading-row">
        <div>
          <p class="eyebrow">Pull request detail</p>
          <h2
            id="pull-request-details-heading"
            tabIndex={-1}
            ref={(headingElement) => {
              headingReference.current = headingElement;
            }}
          >
            Pull request #{pullRequest.pullRequestNumber}
          </h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="Close pull request details"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="details-provider-line">
        <ProviderIcon />
        <span>{providerContext.providerDisplayName}</span>
        <span aria-hidden="true">·</span>
        <span>
          {pullRequest.repositoryOwner}/{pullRequest.repositoryName}
        </span>
      </div>
      <h3>{detailViewModel.title}</h3>
      {detailsState === "loading" ? (
        <p class="details-status" role="status" aria-live="polite">
          Loading pull request details…
        </p>
      ) : null}
      {detailsState === "error" && detailsError !== undefined ? (
        <p class="details-status" role="alert">
          {detailsError}
        </p>
      ) : null}
      {isLoaded ? (
        <div class="pull-request-body">
          <h3>Description</h3>
          <p>{pullRequestDetails.bodyText || "No description provided."}</p>
        </div>
      ) : null}
      <dl class="pull-request-detail-list">
        <div>
          <dt>Author</dt>
          <dd>{detailViewModel.authorDisplayName}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatRelativeTimestamp(detailViewModel.updatedAt)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{pullRequestStateLabels[detailViewModel.state]}</dd>
        </div>
        <div>
          <dt>Review progress</dt>
          <dd>
            {detailViewModel.completedReviewCount}/
            {detailViewModel.requiredReviewCount}
          </dd>
        </div>
        <div>
          <dt>Comments</dt>
          <dd>{detailViewModel.commentCount}</dd>
        </div>
        {isLoaded ? (
          <>
            <div>
              <dt>Source branch</dt>
              <dd>{pullRequestDetails.sourceBranchName}</dd>
            </div>
            <div>
              <dt>Target branch</dt>
              <dd>{pullRequestDetails.targetBranchName}</dd>
            </div>
          </>
        ) : null}
      </dl>
      <div class="details-actions">
        <button
          type="button"
          class="secondary-button"
          disabled={!isLoaded || activeOperation === "openExternalPullRequest"}
          onClick={onOpenExternal}
          aria-busy={activeOperation === "openExternalPullRequest"}
        >
          <Icon name="link-external" />
          {activeOperation === "openExternalPullRequest"
            ? "Opening provider page…"
            : "Open provider page"}
        </button>
        <button
          type="button"
          class="secondary-button"
          disabled={!isLoaded || activeOperation === "checkoutPullRequest"}
          onClick={onCheckout}
          aria-busy={activeOperation === "checkoutPullRequest"}
          aria-describedby="checkout-working-tree-help"
          aria-label={
            activeOperation === "checkoutPullRequest"
              ? `Checking out branch ${sourceBranchName} into the local working tree`
              : `Check out branch ${sourceBranchName} into the local working tree`
          }
        >
          <Icon name="git-branch" />
          {activeOperation === "checkoutPullRequest"
            ? `Checking out ${sourceBranchName}…`
            : `Check out ${sourceBranchName}`}
        </button>
      </div>
      <p class="sr-only" id="checkout-working-tree-help">
        Checkout changes the local working tree to this pull request source
        branch.
      </p>
    </section>
  );
}
