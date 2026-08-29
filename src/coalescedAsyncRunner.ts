export class CoalescedAsyncRunner {
  private activeRefresh: Promise<void> | undefined;
  private forceRefreshPending = false;
  private refreshPending = false;
  private readonly runRefresh: (forceRefresh: boolean) => Promise<void>;

  public constructor(
    runRefresh: (forceRefresh: boolean) => Promise<void>,
  ) {
    this.runRefresh = runRefresh;
  }

  public requestRefresh(forceRefresh = false): Promise<void> {
    this.refreshPending = true;
    this.forceRefreshPending ||= forceRefresh;
    this.activeRefresh ??= this.runPendingRefreshes();
    return this.activeRefresh;
  }

  private async runPendingRefreshes(): Promise<void> {
    let firstRefreshFailure: unknown;
    try {
      while (this.refreshPending) {
        const forceRefresh = this.forceRefreshPending;
        this.refreshPending = false;
        this.forceRefreshPending = false;
        try {
          await this.runRefresh(forceRefresh);
        } catch (refreshFailure) {
          firstRefreshFailure ??= refreshFailure;
        }
      }
    } finally {
      this.activeRefresh = undefined;
    }
    if (firstRefreshFailure !== undefined) {
      throw firstRefreshFailure;
    }
  }
}
