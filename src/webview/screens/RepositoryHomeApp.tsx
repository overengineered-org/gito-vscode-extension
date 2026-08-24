import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  PullRequestDetails,
  PullRequestIdentity,
  RepositoryHomeFocusTarget,
  RepositoryHomeSnapshot,
} from "../../protocol/repositoryHomeProtocol.js";
import { extensionToWebviewMessageSchema } from "../../protocol/repositoryHomeProtocol.js";
import { CommitActivityGrid } from "../components/CommitActivityGrid.js";
import {
  ProviderStatusStrip,
  RepositoryHealthFooter,
} from "../components/RepositoryHealth.js";
import {
  PullRequestDetailsSurface,
  PullRequestPanel,
} from "../components/PullRequestPanels.js";
import {
  Icon,
  initialRepositoryHealth,
  postWebviewAction,
  providerDisplayName,
  summaryCards,
  type CloudProviderId,
  type ProviderContext,
  type ProviderFilter,
  type PullRequestViewModel,
} from "../components/repositoryHomeTypes.js";

type PullRequestDetailsState = "idle" | "loading" | "loaded" | "error";
type PullRequestOperation =
  "checkoutPullRequest" | "openExternalPullRequest" | undefined;

function providerIdentitySignature(
  snapshot: RepositoryHomeSnapshot | undefined,
  providerId: CloudProviderId,
): string {
  const providerDashboard = snapshot?.selectedRepository?.cloudDashboards.find(
    (cloudDashboard) => cloudDashboard.providerId === providerId,
  );
  if (providerDashboard === undefined) return "missing";
  return [
    providerDashboard.providerDisplayName,
    providerDashboard.connectionState,
    providerDashboard.accountDisplayName ?? "",
  ].join(":");
}

type PullRequestIdentityPayload = PullRequestIdentity;

function pullRequestIdentityFromSummary(
  pullRequest: PullRequestViewModel,
): PullRequestIdentityPayload {
  return {
    providerId: pullRequest.providerId,
    repositoryOwner: pullRequest.repositoryOwner,
    repositoryName: pullRequest.repositoryName,
    ...(pullRequest.repositoryProject === undefined
      ? {}
      : { repositoryProject: pullRequest.repositoryProject }),
    pullRequestNumber: pullRequest.pullRequestNumber,
  };
}

function pullRequestIdentityMatches(
  pullRequest: PullRequestViewModel,
  pullRequestIdentity: PullRequestIdentityPayload,
): boolean {
  return (
    pullRequest.providerId === pullRequestIdentity.providerId &&
    pullRequest.repositoryOwner === pullRequestIdentity.repositoryOwner &&
    pullRequest.repositoryName === pullRequestIdentity.repositoryName &&
    (pullRequest.repositoryProject ?? undefined) ===
      (pullRequestIdentity.repositoryProject ?? undefined) &&
    pullRequest.pullRequestNumber === pullRequestIdentity.pullRequestNumber
  );
}

export function RepositoryHomeApp() {
  const [repositoryHomeSnapshot, setRepositoryHomeSnapshot] = useState<
    RepositoryHomeSnapshot | undefined
  >(undefined);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [activeMetric, setActiveMetric] = useState<string | undefined>(
    undefined,
  );
  const [selectedPullRequest, setSelectedPullRequest] = useState<
    PullRequestViewModel | undefined
  >(undefined);
  const [pullRequestDetails, setPullRequestDetails] = useState<
    PullRequestDetails | undefined
  >(undefined);
  const [pullRequestDetailsState, setPullRequestDetailsState] =
    useState<PullRequestDetailsState>("idle");
  const [pullRequestDetailsError, setPullRequestDetailsError] = useState<
    string | undefined
  >(undefined);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [operationError, setOperationError] = useState<string | undefined>(
    undefined,
  );
  const [operationAnnouncement, setOperationAnnouncement] = useState("");
  const [pendingFocusTarget, setPendingFocusTarget] = useState<
    RepositoryHomeFocusTarget | undefined
  >(undefined);
  const [activePullRequestOperation, setActivePullRequestOperation] =
    useState<PullRequestOperation>(undefined);
  const [staleSelectionGeneration, setStaleSelectionGeneration] = useState<
    number | undefined
  >(undefined);
  const repositoryHomeSnapshotReference = useRef<
    RepositoryHomeSnapshot | undefined
  >(undefined);
  const latestRequestGenerationReference = useRef(-1);
  const selectedPullRequestReference = useRef<PullRequestViewModel | undefined>(
    undefined,
  );
  const pullRequestTriggerReference = useRef<HTMLButtonElement | null>(null);
  const latestPullRequestDetailsGenerationReference = useRef(-1);
  const pullRequestDetailsHeadingReference = useRef<HTMLHeadingElement | null>(
    null,
  );
  const reviewPanelHeadingReference = useRef<HTMLHeadingElement | null>(null);
  const minePanelHeadingReference = useRef<HTMLHeadingElement | null>(null);
  const repositoryHomeHeadingReference = useRef<HTMLHeadingElement | null>(
    null,
  );

  useEffect(() => {
    selectedPullRequestReference.current = selectedPullRequest;
  }, [selectedPullRequest]);

  useEffect(() => {
    const handleExtensionMessage = (messageEvent: MessageEvent<unknown>) => {
      const parsedMessage = extensionToWebviewMessageSchema.safeParse(
        messageEvent.data,
      );
      if (!parsedMessage.success) return;
      if (parsedMessage.data.messageType === "operationFailed") {
        setIsRefreshing(false);
        setActivePullRequestOperation(undefined);
        setOperationError(parsedMessage.data.userMessage);
        if (
          parsedMessage.data.operationName === "openPullRequestDetails" &&
          selectedPullRequestReference.current !== undefined
        ) {
          setPullRequestDetailsState("error");
          setPullRequestDetailsError(parsedMessage.data.userMessage);
        }
        return;
      }
      if (parsedMessage.data.messageType === "operationCompleted") {
        setOperationAnnouncement(parsedMessage.data.announcement);
        setIsRefreshing(false);
        setActivePullRequestOperation(undefined);
        return;
      }
      if (parsedMessage.data.messageType === "pullRequestDetailsLoaded") {
        const selectedPullRequest = selectedPullRequestReference.current;
        if (
          selectedPullRequest === undefined ||
          parsedMessage.data.requestGeneration <
            latestPullRequestDetailsGenerationReference.current ||
          !pullRequestIdentityMatches(
            selectedPullRequest,
            parsedMessage.data.pullRequestIdentity,
          )
        )
          return;
        latestPullRequestDetailsGenerationReference.current =
          parsedMessage.data.requestGeneration;
        setPullRequestDetails(parsedMessage.data.pullRequestDetails);
        setPullRequestDetailsState("loaded");
        setPullRequestDetailsError(undefined);
        setOperationError(undefined);
        setOperationAnnouncement("Pull request details loaded.");
        return;
      }
      const nextSnapshot = parsedMessage.data.repositoryHomeSnapshot;
      if (
        nextSnapshot.requestGeneration <
        latestRequestGenerationReference.current
      )
        return;
      const previousSnapshot = repositoryHomeSnapshotReference.current;
      const selectedPullRequest = selectedPullRequestReference.current;
      const repositoryChanged =
        previousSnapshot?.selectedRepository?.repositoryRoot !==
        nextSnapshot.selectedRepository?.repositoryRoot;
      const providerFilterChanged =
        previousSnapshot?.providerFilter !== nextSnapshot.providerFilter;
      const selectedProviderIdentityChanged =
        selectedPullRequest !== undefined &&
        providerIdentitySignature(
          previousSnapshot,
          selectedPullRequest.providerId,
        ) !==
          providerIdentitySignature(
            nextSnapshot,
            selectedPullRequest.providerId,
          );
      const nextSnapshotPullRequests =
        nextSnapshot.selectedRepository?.cloudDashboards.flatMap(
          (cloudDashboard) => cloudDashboard.pullRequests,
        ) ?? [];
      const selectedPullRequestIsStillAvailable =
        selectedPullRequest === undefined ||
        ((nextSnapshot.providerFilter === "all" ||
          selectedPullRequest.providerId === nextSnapshot.providerFilter) &&
          nextSnapshotPullRequests.some((pullRequest) =>
            pullRequestIdentityMatches(
              pullRequest,
              pullRequestIdentityFromSummary(selectedPullRequest),
            ),
          ));
      const stalePullRequestSelection =
        selectedPullRequest !== undefined &&
        !selectedPullRequestIsStillAvailable;
      latestRequestGenerationReference.current = nextSnapshot.requestGeneration;
      repositoryHomeSnapshotReference.current = nextSnapshot;
      if (
        repositoryChanged ||
        providerFilterChanged ||
        selectedProviderIdentityChanged ||
        stalePullRequestSelection
      ) {
        setActiveMetric(undefined);
        setSelectedPullRequest(undefined);
        setPullRequestDetails(undefined);
        setPullRequestDetailsState("idle");
        setPullRequestDetailsError(undefined);
        pullRequestTriggerReference.current = null;
        setActivePullRequestOperation(undefined);
        if (stalePullRequestSelection) {
          setStaleSelectionGeneration(nextSnapshot.requestGeneration);
          setOperationAnnouncement(
            "The selected pull request is no longer available; selection cleared.",
          );
        }
      }
      setRepositoryHomeSnapshot(nextSnapshot);
      setProviderFilter(nextSnapshot.providerFilter);
      setIsRefreshing(false);
      setOperationError(undefined);
      if (parsedMessage.data.focusTarget === "pullRequests") {
        setPendingFocusTarget(parsedMessage.data.focusTarget);
        setOperationAnnouncement("Pull requests section focused.");
      }
      if (
        parsedMessage.data.focusTarget === undefined &&
        !stalePullRequestSelection
      )
        setOperationAnnouncement("");
    };
    window.addEventListener("message", handleExtensionMessage);
    postWebviewAction({ messageType: "ready" });
    return () => window.removeEventListener("message", handleExtensionMessage);
  }, []);

  useEffect(() => {
    if (pendingFocusTarget === "pullRequests") {
      reviewPanelHeadingReference.current?.focus();
      setPendingFocusTarget(undefined);
    }
  }, [pendingFocusTarget, repositoryHomeSnapshot]);

  useEffect(() => {
    if (selectedPullRequest !== undefined)
      pullRequestDetailsHeadingReference.current?.focus();
    if (activeMetric === "review") reviewPanelHeadingReference.current?.focus();
    if (
      activeMetric === "mine" ||
      activeMetric === "drafts" ||
      activeMetric === "ready"
    )
      minePanelHeadingReference.current?.focus();
  }, [
    activeMetric,
    pullRequestDetailsError,
    pullRequestDetailsState,
    selectedPullRequest,
  ]);

  useEffect(() => {
    if (staleSelectionGeneration === undefined) return;
    repositoryHomeHeadingReference.current?.focus();
    setStaleSelectionGeneration(undefined);
  }, [staleSelectionGeneration]);

  useEffect(() => {
    if (
      selectedPullRequest &&
      providerFilter !== "all" &&
      selectedPullRequest.providerId !== providerFilter
    ) {
      setSelectedPullRequest(undefined);
      setPullRequestDetails(undefined);
      setPullRequestDetailsState("idle");
      setPullRequestDetailsError(undefined);
      pullRequestTriggerReference.current = null;
    }
  }, [providerFilter, selectedPullRequest]);

  const selectedRepository = repositoryHomeSnapshot?.selectedRepository ?? null;
  const pullRequestProviderErrors = useMemo(() => {
    const providerErrors = new Map<CloudProviderId, string>();
    for (const sectionError of repositoryHomeSnapshot?.sectionErrors ?? []) {
      if (sectionError.section === "github")
        providerErrors.set(sectionError.section, sectionError.userMessage);
    }
    return providerErrors;
  }, [repositoryHomeSnapshot]);
  const selectedPullRequests = useMemo(
    () =>
      selectedRepository?.cloudDashboards
        .flatMap((cloudDashboard) => cloudDashboard.pullRequests)
        .filter(
          (pullRequest) =>
            !pullRequestProviderErrors.has(pullRequest.providerId),
        ) ?? [],
    [pullRequestProviderErrors, selectedRepository],
  );
  const reviewPullRequests = useMemo(
    () =>
      selectedPullRequests.filter(
        (pullRequest) => pullRequest.reviewRequestedFromCurrentUser,
      ),
    [selectedPullRequests],
  );
  const authoredPullRequests = useMemo(
    () =>
      selectedPullRequests.filter(
        (pullRequest) => pullRequest.isAuthoredByCurrentUser,
      ),
    [selectedPullRequests],
  );
  const providerContexts = useMemo(() => {
    const contexts = new Map<CloudProviderId, ProviderContext>();
    for (const cloudDashboard of selectedRepository?.cloudDashboards ?? []) {
      contexts.set(cloudDashboard.providerId, {
        providerDisplayName: cloudDashboard.providerDisplayName,
        connectionState: cloudDashboard.connectionState,
        ...(cloudDashboard.cacheStatus === undefined
          ? {}
          : { cacheStatus: cloudDashboard.cacheStatus }),
        ...(cloudDashboard.staleReason === undefined
          ? {}
          : { staleReason: cloudDashboard.staleReason }),
      });
    }
    return contexts;
  }, [selectedRepository]);
  const providerFilteredPullRequests = selectedPullRequests.filter(
    (pullRequest) =>
      providerFilter === "all" || pullRequest.providerId === providerFilter,
  );
  const summaryCounts: Record<(typeof summaryCards)[number]["key"], number> = {
    review: reviewPullRequests.filter(
      (pullRequest) =>
        providerFilter === "all" || pullRequest.providerId === providerFilter,
    ).length,
    mine: authoredPullRequests.filter(
      (pullRequest) =>
        providerFilter === "all" || pullRequest.providerId === providerFilter,
    ).length,
    drafts: authoredPullRequests.filter(
      (pullRequest) =>
        pullRequest.isDraft &&
        (providerFilter === "all" || pullRequest.providerId === providerFilter),
    ).length,
    ready: authoredPullRequests.filter(
      (pullRequest) =>
        !pullRequest.isDraft &&
        pullRequest.state === "ready" &&
        (providerFilter === "all" || pullRequest.providerId === providerFilter),
    ).length,
  };
  const selectedPullRequestKey = selectedPullRequest
    ? `${selectedPullRequest.providerId}:${selectedPullRequest.repositoryOwner}/${selectedPullRequest.repositoryName}/${selectedPullRequest.repositoryProject ?? ""}#${selectedPullRequest.pullRequestNumber}`
    : undefined;
  const repositoryHealth =
    selectedRepository?.repositoryHealth ?? initialRepositoryHealth;
  const repositoryDisplayName =
    selectedRepository?.repositoryDisplayName ?? "No repository selected";
  const isCommitActivityLoading =
    repositoryHomeSnapshot === undefined ||
    repositoryHomeSnapshot.loadingSections.includes("commitActivity");
  const isPullRequestLoading =
    repositoryHomeSnapshot === undefined ||
    repositoryHomeSnapshot.loadingSections.includes("github");
  const hasPullRequestSectionError =
    providerFilter === "all"
      ? selectedRepository !== null &&
        selectedRepository.cloudDashboards.length > 0 &&
        selectedRepository.cloudDashboards.every(({ providerId }) =>
          pullRequestProviderErrors.has(providerId),
        )
      : pullRequestProviderErrors.has(providerFilter);
  const commitActivityError = repositoryHomeSnapshot?.sectionErrors.find(
    (sectionError) => sectionError.section === "commitActivity",
  )?.userMessage;
  const unavailableProviderNames = [...pullRequestProviderErrors.keys()]
    .filter(
      (providerId) => providerFilter === "all" || providerId === providerFilter,
    )
    .map((providerId) => providerDisplayName(providerId));
  const availableProviderNames =
    selectedRepository?.cloudDashboards
      .filter(
        ({ providerId }) =>
          (providerFilter === "all" || providerId === providerFilter) &&
          !pullRequestProviderErrors.has(providerId),
      )
      .map(({ providerId }) => providerDisplayName(providerId)) ?? [];
  const pullRequestAggregateStatus =
    unavailableProviderNames.length === 0
      ? undefined
      : unavailableProviderNames.length === 1
        ? `${unavailableProviderNames[0]} pull requests are unavailable.${
            availableProviderNames.length === 0
              ? ""
              : ` ${availableProviderNames.join(" and ")} pull request results remain available.`
          }`
        : `Pull requests are unavailable for ${unavailableProviderNames.join(" and ")}.`;
  const areSummaryMetricsInteractive =
    selectedRepository !== null &&
    !isPullRequestLoading &&
    !hasPullRequestSectionError;

  const handleMetricSelect = (metricKey: string) => {
    setActiveMetric((currentMetric) =>
      currentMetric === metricKey ? undefined : metricKey,
    );
  };
  const handleProviderFilterChange = (nextProviderFilter: ProviderFilter) => {
    if (nextProviderFilter !== providerFilter) {
      setActiveMetric(undefined);
      setSelectedPullRequest(undefined);
      setPullRequestDetails(undefined);
      setPullRequestDetailsState("idle");
      setPullRequestDetailsError(undefined);
      pullRequestTriggerReference.current = null;
    }
    setProviderFilter(nextProviderFilter);
    postWebviewAction({
      messageType: "setProviderFilter",
      providerFilter: nextProviderFilter,
    });
  };
  const handleRepositoryChange = (repositoryRoot: string) => {
    setActiveMetric(undefined);
    setSelectedPullRequest(undefined);
    setPullRequestDetails(undefined);
    setPullRequestDetailsState("idle");
    setPullRequestDetailsError(undefined);
    pullRequestTriggerReference.current = null;
    postWebviewAction({
      messageType: "selectRepository",
      repositoryRoot,
    });
  };
  const handleSelectPullRequest = (
    pullRequest: PullRequestViewModel,
    triggerElement: HTMLButtonElement,
  ) => {
    pullRequestTriggerReference.current = triggerElement;
    setSelectedPullRequest(pullRequest);
    setPullRequestDetails(undefined);
    setPullRequestDetailsState("loading");
    setPullRequestDetailsError(undefined);
    setOperationError(undefined);
    postWebviewAction({
      messageType: "openPullRequestDetails",
      pullRequestIdentity: pullRequestIdentityFromSummary(pullRequest),
    });
  };
  const handleClosePullRequestDetails = () => {
    const triggerElement = pullRequestTriggerReference.current;
    setSelectedPullRequest(undefined);
    setPullRequestDetails(undefined);
    setPullRequestDetailsState("idle");
    setPullRequestDetailsError(undefined);
    if (triggerElement !== null && document.contains(triggerElement))
      triggerElement.focus();
    pullRequestTriggerReference.current = null;
  };
  const handleRefresh = () => {
    setOperationError(undefined);
    setOperationAnnouncement("");
    setIsRefreshing(true);
    postWebviewAction({ messageType: "refreshDashboard" });
  };
  const handleOpenExternalPullRequest = () => {
    if (selectedPullRequest === undefined || !pullRequestDetails) return;
    setActivePullRequestOperation("openExternalPullRequest");
    setOperationAnnouncement("Opening provider pull request page…");
    postWebviewAction({
      messageType: "openExternalPullRequest",
      pullRequestIdentity: pullRequestIdentityFromSummary(selectedPullRequest),
    });
  };
  const handleCheckoutPullRequest = () => {
    if (selectedPullRequest === undefined || !pullRequestDetails) return;
    setActivePullRequestOperation("checkoutPullRequest");
    setOperationAnnouncement(
      `Checking out branch ${pullRequestDetails.sourceBranchName}…`,
    );
    postWebviewAction({
      messageType: "checkoutPullRequest",
      pullRequestIdentity: pullRequestIdentityFromSummary(selectedPullRequest),
    });
  };

  return (
    <main class="repository-home" aria-labelledby="repository-home-title">
      <header class="dashboard-header">
        <div class="dashboard-title-group">
          <p class="eyebrow">Git'o</p>
          <h1
            id="repository-home-title"
            ref={repositoryHomeHeadingReference}
            tabIndex={-1}
          >
            Repository Home
          </h1>
          <p class="dashboard-subtitle">Open-source Git tooling for VS Code.</p>
        </div>
        <div class="dashboard-actions">
          <label class="select-control">
            <Icon name="server" />
            <span class="sr-only">Repository</span>
            <select
              value={selectedRepository?.repositoryRoot ?? ""}
              disabled={
                repositoryHomeSnapshot === undefined ||
                repositoryHomeSnapshot.repositories.length === 0
              }
              onChange={(changeEvent) =>
                handleRepositoryChange(changeEvent.currentTarget.value)
              }
            >
              {repositoryHomeSnapshot?.repositories.length === 0 ? (
                <option value="">No repository selected</option>
              ) : null}
              {repositoryHomeSnapshot?.repositories.map((repositoryOption) => (
                <option
                  value={repositoryOption.repositoryRoot}
                  key={repositoryOption.repositoryRoot}
                >
                  {repositoryOption.repositoryDisplayName}
                </option>
              ))}
            </select>
          </label>
          <label class="select-control">
            <Icon name="filter" />
            <span class="sr-only">Provider</span>
            <select
              value={providerFilter}
              onChange={(changeEvent) =>
                handleProviderFilterChange(
                  changeEvent.currentTarget.value as ProviderFilter,
                )
              }
            >
              <option value="all">All providers</option>
              <option value="github">GitHub</option>
            </select>
          </label>
          <button
            type="button"
            class="refresh-button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label={
              isRefreshing
                ? "Refreshing repository dashboard"
                : "Refresh repository dashboard"
            }
          >
            <Icon name={isRefreshing ? "loading" : "refresh"} />
            <span>{isRefreshing ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
      </header>

      <p class="sr-only" aria-live="polite">
        {operationAnnouncement}
      </p>
      {operationError ? (
        <div class="operation-error" role="alert">
          <Icon name="error" />
          <span>{operationError}</span>
        </div>
      ) : null}
      {repositoryHomeSnapshot?.sectionErrors
        .filter((sectionError) => sectionError.section !== "github")
        .map((sectionError) => (
          <div class="section-error" role="alert" key={sectionError.section}>
            <Icon name="warning" />
            <span>{sectionError.userMessage}</span>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              Retry
            </button>
          </div>
        ))}

      {selectedRepository ? (
        <section class="repository-context" aria-label="Selected repository">
          <span class="repository-context-icon">
            <Icon name="repo" />
          </span>
          <span>
            <strong>{repositoryDisplayName}</strong>
            <small>{selectedRepository.repositoryRoot}</small>
          </span>
        </section>
      ) : repositoryHomeSnapshot !== undefined ? (
        <section
          class="repository-empty-state"
          aria-labelledby="repository-empty-state-heading"
        >
          <span class="repository-context-icon" aria-hidden="true">
            <Icon name="repo" />
          </span>
          <span class="repository-empty-state-content">
            <h2 id="repository-empty-state-heading">
              Open a repository to begin
            </h2>
            <p>
              Choose a local Git repository to see activity, branch health, and
              pull requests here.
            </p>
            <a
              class="repository-empty-action"
              href="command:gito.onboarding.openOrChooseRepository"
            >
              <Icon name="folder-opened" />
              <span>Open or choose repository</span>
            </a>
          </span>
        </section>
      ) : (
        <section class="repository-context" aria-label="Selected repository">
          <span class="repository-context-icon">
            <Icon name="repo" />
          </span>
          <span>
            <strong>{repositoryDisplayName}</strong>
            <small>Open a repository to see local Git state.</small>
          </span>
        </section>
      )}
      {selectedRepository ? (
        <ProviderStatusStrip
          cloudDashboards={selectedRepository.cloudDashboards}
          providerContexts={providerContexts}
        />
      ) : null}

      <section class="metrics-grid" aria-label="Pull request summary">
        {summaryCards.map((summaryCard) => (
          <button
            type="button"
            class={`metric-card${activeMetric === summaryCard.key ? " is-active" : ""}`}
            aria-pressed={activeMetric === summaryCard.key}
            onClick={() => handleMetricSelect(summaryCard.key)}
            disabled={
              !areSummaryMetricsInteractive ||
              summaryCounts[summaryCard.key] === 0
            }
            key={summaryCard.key}
          >
            <span class="metric-icon">
              <Icon name={summaryCard.icon} />
            </span>
            <span class="metric-copy">
              <span>{summaryCard.label}</span>
              <strong>
                {selectedRepository
                  ? summaryCounts[summaryCard.key]
                  : "Not available"}
              </strong>
            </span>
          </button>
        ))}
      </section>
      {activeMetric ? (
        <button
          type="button"
          class="clear-filter-button"
          onClick={() => setActiveMetric(undefined)}
        >
          Clear summary filter
        </button>
      ) : null}

      <CommitActivityGrid
        commitActivity={selectedRepository?.commitActivity.days ?? []}
        totalCommitCount={
          selectedRepository?.commitActivity.totalCommitCount ?? 0
        }
        safetyCapReached={
          selectedRepository?.commitActivity.safetyCapReached ?? false
        }
        outputTruncated={
          selectedRepository?.commitActivity.outputTruncated ?? false
        }
        isLoading={isCommitActivityLoading}
        hasSelectedRepository={selectedRepository !== null}
        {...(commitActivityError === undefined
          ? {}
          : { errorMessage: commitActivityError })}
      />

      {pullRequestAggregateStatus !== undefined ? (
        <p
          class="pull-request-aggregate-status"
          role="status"
          aria-live="polite"
        >
          {pullRequestAggregateStatus}
        </p>
      ) : null}
      <div class="pull-request-grid">
        <PullRequestPanel
          heading="Needs your review"
          headingId="needs-review-heading"
          pullRequests={reviewPullRequests}
          providerContexts={providerContexts}
          listKind="review"
          isLoading={isPullRequestLoading}
          hasSnapshot={repositoryHomeSnapshot !== undefined}
          hasSelectedRepository={selectedRepository !== null}
          providerFilter={providerFilter}
          providerErrors={pullRequestProviderErrors}
          activeMetric={activeMetric}
          selectedPullRequestKey={selectedPullRequestKey}
          onSelectPullRequest={handleSelectPullRequest}
          onRetry={handleRefresh}
          headingReference={(headingElement) => {
            reviewPanelHeadingReference.current = headingElement;
          }}
        />
        <PullRequestPanel
          heading="Your pull requests"
          headingId="your-pull-requests-heading"
          pullRequests={authoredPullRequests}
          providerContexts={providerContexts}
          listKind="mine"
          isLoading={isPullRequestLoading}
          hasSnapshot={repositoryHomeSnapshot !== undefined}
          hasSelectedRepository={selectedRepository !== null}
          providerFilter={providerFilter}
          providerErrors={pullRequestProviderErrors}
          activeMetric={activeMetric}
          selectedPullRequestKey={selectedPullRequestKey}
          onSelectPullRequest={handleSelectPullRequest}
          onRetry={handleRefresh}
          headingReference={(headingElement) => {
            minePanelHeadingReference.current = headingElement;
          }}
        />
      </div>

      {selectedPullRequest ? (
        <PullRequestDetailsSurface
          pullRequest={selectedPullRequest}
          detailsState={
            pullRequestDetailsState === "idle"
              ? "loading"
              : pullRequestDetailsState
          }
          pullRequestDetails={pullRequestDetails}
          detailsError={pullRequestDetailsError}
          activeOperation={activePullRequestOperation}
          providerContext={
            providerContexts.get(selectedPullRequest.providerId) ?? {
              providerDisplayName: providerDisplayName(
                selectedPullRequest.providerId,
              ),
              connectionState: "connected",
            }
          }
          headingReference={pullRequestDetailsHeadingReference}
          onClose={handleClosePullRequestDetails}
          onCheckout={handleCheckoutPullRequest}
          onOpenExternal={handleOpenExternalPullRequest}
        />
      ) : null}
      {repositoryHomeSnapshot !== undefined &&
      selectedRepository !== null &&
      providerFilteredPullRequests.length === 0 ? (
        <p class="cloud-empty-note">
          No provider pull requests are available for this repository yet.
        </p>
      ) : null}
      <RepositoryHealthFooter repositoryHealth={repositoryHealth} />
    </main>
  );
}
