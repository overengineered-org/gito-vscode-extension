import { GitHubProviderError } from "./githubTypes.js";

interface QueuedGitHubRequest<RequestResult> {
  readonly operation: (
    cancellationSignal: AbortSignal,
  ) => Promise<RequestResult>;
  readonly cancellationSignal: AbortSignal;
  readonly resolve: (requestResult: RequestResult) => void;
  readonly reject: (error: unknown) => void;
  removeAbortListener: () => void;
}

/** Bounds only this adapter's provider work; it never creates a global queue. */
export class GitHubRequestCoordinator {
  private readonly queuedRequests: Array<QueuedGitHubRequest<unknown>> = [];
  private activeRequestCount = 0;

  public constructor(private readonly maximumConcurrentRequests = 4) {
    if (
      !Number.isInteger(maximumConcurrentRequests) ||
      maximumConcurrentRequests < 1
    ) {
      throw new RangeError(
        "GitHub request concurrency must be a positive integer",
      );
    }
  }

  public get activeRequests(): number {
    return this.activeRequestCount;
  }

  public get queuedRequestsCount(): number {
    return this.queuedRequests.length;
  }

  public run<RequestResult>(
    operation: (cancellationSignal: AbortSignal) => Promise<RequestResult>,
    cancellationSignal: AbortSignal,
  ): Promise<RequestResult> {
    if (cancellationSignal.aborted) {
      return Promise.reject(createGitHubCancellationError());
    }

    return new Promise<RequestResult>((resolve, reject) => {
      const queuedRequest: QueuedGitHubRequest<RequestResult> = {
        operation,
        cancellationSignal,
        resolve,
        reject,
        removeAbortListener: () => undefined,
      };
      const abortHandler = (): void => {
        const queuedRequestIndex = this.queuedRequests.indexOf(
          queuedRequest as QueuedGitHubRequest<unknown>,
        );
        if (queuedRequestIndex < 0) {
          return;
        }
        this.queuedRequests.splice(queuedRequestIndex, 1);
        reject(createGitHubCancellationError());
      };
      cancellationSignal.addEventListener("abort", abortHandler, {
        once: true,
      });
      queuedRequest.removeAbortListener = (): void => {
        cancellationSignal.removeEventListener("abort", abortHandler);
      };
      this.queuedRequests.push(queuedRequest as QueuedGitHubRequest<unknown>);
      this.startAvailableRequests();
    });
  }

  private startAvailableRequests(): void {
    while (
      this.activeRequestCount < this.maximumConcurrentRequests &&
      this.queuedRequests.length > 0
    ) {
      const queuedRequest = this.queuedRequests.shift();
      if (!queuedRequest) {
        return;
      }
      queuedRequest.removeAbortListener();
      if (queuedRequest.cancellationSignal.aborted) {
        queuedRequest.reject(createGitHubCancellationError());
        continue;
      }
      this.activeRequestCount += 1;
      void this.executeRequest(queuedRequest);
    }
  }

  private async executeRequest(
    queuedRequest: QueuedGitHubRequest<unknown>,
  ): Promise<void> {
    try {
      const requestResult = await queuedRequest.operation(
        queuedRequest.cancellationSignal,
      );
      queuedRequest.resolve(requestResult);
    } catch (error) {
      queuedRequest.reject(error);
    } finally {
      this.activeRequestCount -= 1;
      this.startAvailableRequests();
    }
  }
}

export function createGitHubCancellationError(): GitHubProviderError {
  return new GitHubProviderError("cancelled", "GitHub request was cancelled.");
}
