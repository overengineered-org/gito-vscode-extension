import {
  formatRelativeTimestamp,
  Icon,
  ProviderIcon,
  providerConnectionLabel,
  postWebviewAction,
  staleReasonLabel,
  type ProviderContext,
  type RepositoryHealthSnapshot,
} from "./repositoryHomeTypes.js";

export function ProviderStatusStrip({
  cloudDashboards,
  providerContexts,
}: {
  readonly cloudDashboards: readonly {
    readonly providerId: "github";
    readonly providerDisplayName: string;
    readonly connectionState:
      "disconnected" | "connecting" | "connected" | "failed";
    readonly accountDisplayName?: string | undefined;
    readonly cacheStatus?: "fresh" | "stale" | undefined;
    readonly staleReason?:
      | "rateLimit"
      | "server"
      | "network"
      | "timeout"
      | "rateLimited"
      | "serverFailure"
      | "networkFailure"
      | undefined;
  }[];
  readonly providerContexts: ReadonlyMap<"github", ProviderContext>;
}) {
  return (
    <section
      class="provider-status-strip"
      aria-label="Cloud provider connections"
    >
      {cloudDashboards.map((cloudDashboard) => {
        const providerContext = providerContexts.get(
          cloudDashboard.providerId,
        ) ?? {
          providerDisplayName: cloudDashboard.providerDisplayName,
          connectionState: cloudDashboard.connectionState,
        };
        const dashboardIsStale = cloudDashboard.cacheStatus === "stale";
        const dashboardFreshnessLabel = dashboardIsStale
          ? `Stale data (${staleReasonLabel(cloudDashboard.staleReason)})`
          : undefined;
        return (
          <div
            class="provider-status"
            role="group"
            aria-label={`${cloudDashboard.providerDisplayName} connection`}
            key={cloudDashboard.providerId}
          >
            <ProviderIcon />
            <span class="provider-status-copy">
              <strong>{cloudDashboard.providerDisplayName}</strong>
              <small>
                {cloudDashboard.accountDisplayName ??
                  providerConnectionLabel(providerContext)}
              </small>
              {dashboardFreshnessLabel !== undefined ? (
                <small class="provider-cache-status">
                  {dashboardFreshnessLabel}
                </small>
              ) : null}
            </span>
            {cloudDashboard.connectionState === "connected" ? (
              <>
                <span
                  class="provider-connection-state"
                  role="status"
                  aria-label={`${cloudDashboard.providerDisplayName} connected${dashboardFreshnessLabel === undefined ? "" : `; ${dashboardFreshnessLabel.toLowerCase()}`}`}
                >
                  <Icon name={dashboardIsStale ? "warning" : "check"} />
                  <span class="sr-only">
                    {dashboardIsStale
                      ? `Connected; ${dashboardFreshnessLabel}`
                      : "Connected"}
                  </span>
                </span>
                <button
                  type="button"
                  class="provider-connect-button"
                  aria-label={`Disconnect ${cloudDashboard.providerDisplayName}`}
                  onClick={() =>
                    postWebviewAction({
                      messageType: "disconnectProvider",
                      providerId: cloudDashboard.providerId,
                    })
                  }
                >
                  Disconnect
                </button>
              </>
            ) : cloudDashboard.connectionState === "connecting" ? (
              <span
                class="provider-connection-state"
                role="status"
                aria-label={`${cloudDashboard.providerDisplayName} connecting`}
              >
                <Icon name="loading" />
                <span class="sr-only">Connecting</span>
              </span>
            ) : (
              <button
                type="button"
                class="provider-connect-button"
                aria-label={`${cloudDashboard.connectionState === "failed" ? "Try again to connect to" : "Connect to"} ${cloudDashboard.providerDisplayName}`}
                onClick={() =>
                  postWebviewAction({
                    messageType: "connectProvider",
                    providerId: cloudDashboard.providerId,
                  })
                }
              >
                {cloudDashboard.connectionState === "failed"
                  ? "Try again"
                  : "Connect"}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function RepositoryHealthFooter({
  repositoryHealth,
}: {
  readonly repositoryHealth: RepositoryHealthSnapshot;
}) {
  const aheadBehindLabel =
    repositoryHealth.aheadCount === 0 && repositoryHealth.behindCount === 0
      ? "Up to date"
      : `${repositoryHealth.aheadCount} ahead, ${repositoryHealth.behindCount} behind`;
  return (
    <section class="repository-health" aria-label="Repository health">
      <div class="health-item">
        <Icon name="git-branch" />
        <span>
          <small>Current branch</small>
          <strong>{repositoryHealth.branchName}</strong>
        </span>
      </div>
      <div class="health-item">
        <Icon name="file" />
        <span>
          {repositoryHealth.uncommittedChangeCount} uncommitted{" "}
          {repositoryHealth.uncommittedChangeCount === 1 ? "change" : "changes"}
        </span>
      </div>
      <div class="health-item">
        <Icon name="arrow-swap" />
        <span>
          <small>{aheadBehindLabel}</small>
          <strong>
            {repositoryHealth.lastSuccessfulFetchAt
              ? `Fetched ${formatRelativeTimestamp(repositoryHealth.lastSuccessfulFetchAt)}`
              : "Not fetched yet"}
          </strong>
        </span>
      </div>
    </section>
  );
}
