/**
 * Shared fail-closed boundary for operations that can change a local
 * repository or premium local state.
 *
 * The guard deliberately has no VS Code dependency. Composition supplies the
 * current trust reader and, when appropriate, the native trust-management
 * request. Every entrypoint re-reads trust immediately before work, and
 * service hooks receive a checkpoint for the final side effect after prompts
 * or other asynchronous work.
 */

export interface WorkspaceTrustDisposable {
  dispose(): void;
}

export interface WorkspaceTrustGuardDependencies {
  readonly isWorkspaceTrusted: () => boolean;
  readonly requestWorkspaceTrust?: (operationName: string) => Promise<void>;
  readonly onDidGrantWorkspaceTrust?: (
    listener: () => void,
  ) => WorkspaceTrustDisposable;
}

export class WorkspaceTrustError extends Error {
  public constructor(public readonly operationName: string) {
    super(
      `Cannot ${operationName} in an untrusted workspace. Trust the workspace and try again.`,
    );
    this.name = "WorkspaceTrustError";
  }
}

export type WorkspaceMutationClass = "local" | "premium";
export type WorkspaceTrustCheckpoint = () => void;

/** Context key used by manifest `when` clauses for trusted Git surfaces. */
export const workspaceTrustContextKey = "gito.workspaceTrusted";

/**
 * One auditable registry for command handlers that may mutate local state.
 * Read-only commands must not be added here; the security test checks that
 * every registered mutation has an explicit class.
 */
export const workspaceMutationCommandClassifications = {
  "gito.stageChanges": "local",
  "gito.unstageChanges": "local",
  "gito.stageAll": "local",
  "gito.unstageAll": "local",
  "gito.discardChanges": "local",
  "gito.commit": "local",
  "gito.fetch": "local",
  "gito.pull": "local",
  "gito.push": "local",
  "gito.sync": "local",
  "gito.checkoutBranch": "local",
  "gito.createBranch": "local",
  "gito.publishBranch": "local",
  "gito.deleteBranch": "local",
  "gito.forceDeleteBranch": "local",
  "gito.createWorktree": "local",
  "gito.removeWorktree": "local",
  "gito.openOperations": "local",
  "gito.compare.actions": "premium",
} as const satisfies Readonly<Record<string, WorkspaceMutationClass>>;

export class WorkspaceTrustGuard {
  private readonly dependencies: WorkspaceTrustGuardDependencies;

  public constructor(dependencies: WorkspaceTrustGuardDependencies) {
    this.dependencies = dependencies;
  }

  public isWorkspaceTrusted(): boolean {
    return this.dependencies.isWorkspaceTrusted() === true;
  }

  /** Throw without invoking any mutation callback when trust is absent. */
  public assertTrusted(operationName: string): void {
    if (!this.isWorkspaceTrusted()) {
      throw new WorkspaceTrustError(operationName);
    }
  }

  /**
   * Optionally opens the host trust flow, then re-reads trust. A missing
   * requester is intentionally a hard failure, never implicit approval.
   */
  public async requireTrusted(operationName: string): Promise<void> {
    if (this.isWorkspaceTrusted()) return;
    await this.dependencies.requestWorkspaceTrust?.(operationName);
    this.assertTrusted(operationName);
  }

  public async runTrustedMutation<Result>(
    operationName: string,
    mutation: (
      assertTrustedImmediatelyBeforeMutation: WorkspaceTrustCheckpoint,
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    await this.requireTrusted(operationName);
    const assertTrustedImmediatelyBeforeMutation =
      this.createMutationCheckpoint(operationName);
    assertTrustedImmediatelyBeforeMutation();
    return mutation(assertTrustedImmediatelyBeforeMutation);
  }

  /** Inject into service hooks and call immediately before each side effect. */
  public createMutationCheckpoint(
    operationName: string,
  ): WorkspaceTrustCheckpoint {
    return () => this.assertTrusted(operationName);
  }

  public onDidGrantWorkspaceTrust(
    listener: () => void,
  ): WorkspaceTrustDisposable | undefined {
    return this.dependencies.onDidGrantWorkspaceTrust?.(listener);
  }
}

export function createWorkspaceTrustGuard(
  dependencies: WorkspaceTrustGuardDependencies,
): WorkspaceTrustGuard {
  return new WorkspaceTrustGuard(dependencies);
}
