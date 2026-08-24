import type * as vscode from "vscode";

export interface AuthenticationSessionPreference {
  readonly sessionId: string;
  readonly account: vscode.AuthenticationSessionAccountInformation;
}

export interface AuthenticationSessionAcquisition {
  readonly generation: number;
  readonly preferredAccount:
    vscode.AuthenticationSessionAccountInformation | undefined;
}

/**
 * Tracks only the committed session identity. Authentication tokens remain
 * request-scoped and are never retained by this tracker.
 */
export class AuthenticationSessionPreferenceTracker {
  private generation = 0;
  private committedPreference: AuthenticationSessionPreference | undefined;
  private pendingPreference:
    | (AuthenticationSessionPreference & { readonly generation: number })
    | undefined;

  public beginAcquisition(
    interactive: boolean,
  ): AuthenticationSessionAcquisition {
    this.generation += 1;
    this.pendingPreference = undefined;
    return {
      generation: this.generation,
      preferredAccount:
        interactive || this.committedPreference === undefined
          ? undefined
          : { ...this.committedPreference.account },
    };
  }

  public observeSession(
    acquisitionGeneration: number,
    session: vscode.AuthenticationSession | undefined,
  ): void {
    if (
      acquisitionGeneration !== this.generation ||
      session === undefined ||
      typeof session.id !== "string" ||
      session.id.length === 0 ||
      session.account === undefined ||
      typeof session.account.id !== "string" ||
      session.account.id.length === 0 ||
      typeof session.account.label !== "string"
    ) {
      return;
    }
    this.pendingPreference = {
      generation: acquisitionGeneration,
      sessionId: session.id,
      account: { ...session.account },
    };
  }

  public cancelAcquisition(acquisitionGeneration: number): void {
    if (acquisitionGeneration !== this.generation) return;
    this.generation += 1;
    this.pendingPreference = undefined;
  }

  public commitSession(
    sessionId: string,
    acquisitionGeneration: number | undefined,
  ): void {
    if (acquisitionGeneration === undefined) return;
    if (
      this.pendingPreference?.sessionId === sessionId &&
      this.pendingPreference.generation === acquisitionGeneration &&
      acquisitionGeneration === this.generation
    ) {
      const { sessionId: committedSessionId, account } = this.pendingPreference;
      this.committedPreference = {
        sessionId: committedSessionId,
        account: { ...account },
      };
      this.pendingPreference = undefined;
    }
  }

  public discardSession(
    sessionId: string,
    acquisitionGeneration: number | undefined,
  ): void {
    if (
      this.pendingPreference?.sessionId === sessionId &&
      this.pendingPreference.generation === acquisitionGeneration
    ) {
      this.pendingPreference = undefined;
    }
  }

  public clear(): void {
    this.generation += 1;
    this.committedPreference = undefined;
    this.pendingPreference = undefined;
  }

  public get committedSessionId(): string | undefined {
    return this.committedPreference?.sessionId;
  }
}
