import type * as vscode from "vscode";

/**
 * Small in-memory model of VS Code's authentication service.
 *
 * It intentionally keeps account selection, prompt behavior, and session
 * change events stateful. Tests can therefore exercise the lifecycle instead
 * of asserting against a one-shot getSession mock.
 */
export class StatefulVscodeAuthentication {
  private readonly sessionsByProvider = new Map<
    string,
    Map<string, vscode.AuthenticationSession>
  >();
  private readonly preferredSessionIds = new Map<string, string>();
  private readonly nextInteractiveSessionIds = new Map<string, string>();
  private readonly sessionChangeListeners = new Set<
    (
      event: vscode.AuthenticationProviderAuthenticationSessionsChangeEvent,
    ) => void
  >();
  private readonly pendingInteractivePrompts: Array<{
    readonly providerId: string;
    readonly resolve: (
      session: vscode.AuthenticationSession | undefined,
    ) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private deferNextInteractivePrompt = false;

  public readonly calls: StatefulAuthenticationCall[] = [];
  public interactivePromptCount = 0;

  public readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> =
    (listener) => {
      this.sessionChangeListeners.add(listener);
      return {
        dispose: () => this.sessionChangeListeners.delete(listener),
      };
    };

  public getSession(
    providerId: string,
    scopes: readonly string[],
    options: vscode.AuthenticationGetSessionOptions = {},
  ): Thenable<vscode.AuthenticationSession | undefined> {
    this.calls.push({
      providerId,
      scopes: [...scopes],
      options: cloneAuthenticationOptions(options),
    });

    const matchingSession = this.findMatchingSession(
      providerId,
      scopes,
      options.account,
    );
    const isInteractiveRequest =
      options.forceNewSession !== undefined ||
      (options.createIfNone !== undefined && options.createIfNone !== false) ||
      options.clearSessionPreference === true;

    if (!isInteractiveRequest || options.silent === true) {
      return Promise.resolve(matchingSession);
    }

    this.interactivePromptCount += 1;
    const selectedSession = this.selectInteractiveSession(
      providerId,
      scopes,
      options.account,
    );
    if (this.deferNextInteractivePrompt) {
      this.deferNextInteractivePrompt = false;
      return new Promise<vscode.AuthenticationSession | undefined>(
        (resolve, reject) => {
          this.pendingInteractivePrompts.push({
            providerId,
            resolve,
            reject,
          });
        },
      );
    }
    this.preferredSessionIds.set(providerId, selectedSession?.id ?? "");
    return Promise.resolve(selectedSession);
  }

  public addSession(
    providerId: string,
    session: vscode.AuthenticationSession,
    options: { readonly makePreferred?: boolean } = {},
  ): void {
    const providerSessions =
      this.sessionsByProvider.get(providerId) ??
      new Map<string, vscode.AuthenticationSession>();
    providerSessions.set(session.id, session);
    this.sessionsByProvider.set(providerId, providerSessions);
    if (options.makePreferred ?? true) {
      this.preferredSessionIds.set(providerId, session.id);
    }
    this.emitSessionChange({ added: [session], removed: [], changed: [] });
  }

  public removeSession(providerId: string, sessionId: string): void {
    const providerSessions = this.sessionsByProvider.get(providerId);
    const removedSession = providerSessions?.get(sessionId);
    if (removedSession === undefined) return;
    providerSessions?.delete(sessionId);
    if (providerSessions?.size === 0)
      this.sessionsByProvider.delete(providerId);
    if (this.preferredSessionIds.get(providerId) === sessionId) {
      this.preferredSessionIds.delete(providerId);
    }
    this.emitSessionChange({
      added: [],
      removed: [removedSession],
      changed: [],
    });
  }

  public setNextInteractiveAccount(accountId: string): void {
    for (const [providerId, providerSessions] of this.sessionsByProvider) {
      const matchingSession = [...providerSessions.values()].find(
        (session) => session.account.id === accountId,
      );
      if (matchingSession !== undefined) {
        this.nextInteractiveSessionIds.set(providerId, matchingSession.id);
        return;
      }
    }
    throw new Error(`Unknown authentication account: ${accountId}`);
  }

  public deferNextInteractiveAuthentication(): void {
    this.deferNextInteractivePrompt = true;
  }

  public resolveNextInteractiveAuthentication(sessionId?: string): void {
    const pendingPrompt = this.pendingInteractivePrompts.shift();
    if (pendingPrompt === undefined) return;
    const session =
      sessionId === undefined
        ? this.selectInteractiveSession(pendingPrompt.providerId, [], undefined)
        : this.sessionsByProvider.get(pendingPrompt.providerId)?.get(sessionId);
    this.preferredSessionIds.set(pendingPrompt.providerId, session?.id ?? "");
    pendingPrompt.resolve(session);
  }

  public cancelNextInteractiveAuthentication(): void {
    const pendingPrompt = this.pendingInteractivePrompts.shift();
    pendingPrompt?.reject(new Error("Authentication prompt cancelled."));
  }

  public get pendingInteractiveAuthenticationCount(): number {
    return this.pendingInteractivePrompts.length;
  }

  public getAuthenticationApi(): {
    getSession: (
      providerId: "github",
      scopes: readonly string[],
      options: vscode.AuthenticationGetSessionOptions,
    ) => Thenable<vscode.AuthenticationSession | undefined>;
  };
  public getAuthenticationApi(): unknown {
    return {
      getSession: (
        requestedProviderId: "github",
        scopes: readonly string[],
        options: vscode.AuthenticationGetSessionOptions,
      ) => this.getSession(requestedProviderId, scopes, options),
    };
  }

  private findMatchingSession(
    providerId: string,
    scopes: readonly string[],
    account: vscode.AuthenticationSessionAccountInformation | undefined,
  ): vscode.AuthenticationSession | undefined {
    const providerSessions = this.sessionsByProvider.get(providerId);
    if (providerSessions === undefined) return undefined;
    const candidateSessions = [...providerSessions.values()].filter((session) =>
      scopes.every((scope) => session.scopes.includes(scope)),
    );
    if (account !== undefined) {
      return candidateSessions.find(
        (session) => session.account.id === account.id,
      );
    }
    const preferredSessionId = this.preferredSessionIds.get(providerId);
    return candidateSessions.find(
      (session) => session.id === preferredSessionId,
    );
  }

  private selectInteractiveSession(
    providerId: string,
    scopes: readonly string[],
    account: vscode.AuthenticationSessionAccountInformation | undefined,
  ): vscode.AuthenticationSession | undefined {
    const accountSession = this.findMatchingSession(
      providerId,
      scopes,
      account,
    );
    if (accountSession !== undefined && account !== undefined)
      return accountSession;
    const queuedSessionId = this.nextInteractiveSessionIds.get(providerId);
    this.nextInteractiveSessionIds.delete(providerId);
    if (queuedSessionId !== undefined) {
      const queuedSession = this.sessionsByProvider
        .get(providerId)
        ?.get(queuedSessionId);
      if (
        queuedSession !== undefined &&
        scopes.every((scope) => queuedSession.scopes.includes(scope))
      ) {
        return queuedSession;
      }
    }
    return accountSession ?? this.findFirstMatchingSession(providerId, scopes);
  }

  private findFirstMatchingSession(
    providerId: string,
    scopes: readonly string[],
  ): vscode.AuthenticationSession | undefined {
    return [...(this.sessionsByProvider.get(providerId)?.values() ?? [])].find(
      (session) => scopes.every((scope) => session.scopes.includes(scope)),
    );
  }

  private emitSessionChange(
    event: vscode.AuthenticationProviderAuthenticationSessionsChangeEvent,
  ): void {
    for (const listener of this.sessionChangeListeners) listener(event);
  }
}

export interface StatefulAuthenticationCall {
  readonly providerId: string;
  readonly scopes: readonly string[];
  readonly options: vscode.AuthenticationGetSessionOptions;
}

function cloneAuthenticationOptions(
  options: vscode.AuthenticationGetSessionOptions,
): vscode.AuthenticationGetSessionOptions {
  return {
    ...(options.clearSessionPreference === undefined
      ? {}
      : { clearSessionPreference: options.clearSessionPreference }),
    ...(options.createIfNone === undefined
      ? {}
      : {
          createIfNone:
            typeof options.createIfNone === "object"
              ? { ...options.createIfNone }
              : options.createIfNone,
        }),
    ...(options.forceNewSession === undefined
      ? {}
      : { forceNewSession: options.forceNewSession }),
    ...(options.silent === undefined ? {} : { silent: options.silent }),
    ...(options.account === undefined
      ? {}
      : { account: { ...options.account } }),
  };
}
