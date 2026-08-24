export const onboardingCommandIds = {
  openOrChooseRepository: "gito.onboarding.openOrChooseRepository",
  openHome: "gito.onboarding.openHome",
  showSourceControlSteps: "gito.onboarding.showSourceControlSteps",
  confirmSourceControlHidden: "gito.onboarding.confirmSourceControlHidden",
  acknowledgeSourceControlVisible:
    "gito.onboarding.acknowledgeSourceControlVisible",
  connectGitHub: "gito.onboarding.connectGitHub",
  skipGitHub: "gito.onboarding.skipGitHub",
  openSetup: "gito.onboarding.openSetup",
} as const;

export const onboardingNativeCommandIds = {
  openRepository: "git.openRepository",
  openWalkthrough: "workbench.action.openWalkthrough",
  setContext: "setContext",
} as const;

export const onboardingWalkthroughIdentifier = "overengineered-org.gito#setup";

export const onboardingWalkthroughContextKeys = {
  localRepositoryAvailable: "gito.onboarding.localRepositoryAvailable",
  repositoryHomeOpened: "gito.onboarding.repositoryHomeOpened",
  /** Historical acknowledgement; it does not assert current Source Control visibility. */
  sourceControlVisibilityPreferenceAcknowledged:
    "gito.onboarding.sourceControlVisibilityPreferenceAcknowledged",
  githubConnected: "gito.onboarding.githubConnected",
  /** Historical acknowledgement that the optional provider step was handled. */
  githubSetupCompleted: "gito.onboarding.githubSetupCompleted",
} as const;

export const onboardingCopy = {
  walkthroughDescription:
    "Start with local Git in a trusted workspace. Cloud providers are optional.",
  openRepositoryWalkthroughDescription:
    "Git'o uses VS Code's bundled Git extension. [Open or choose a Git repository](command:gito.onboarding.openOrChooseRepository) in the native folder picker. Local Git mutations require a trusted workspace; untrusted workspaces may expose read-only inspection. This step completes only after a repository is available.",
  openHomeWalkthroughDescription:
    "[Open Git'o Home](command:gito.onboarding.openHome) to work with your local repository. No provider connection is required.",
  sourceControlManualHideInstructions:
    "Optional: to hide the built-in Source Control icon, right-click Source Control in the Activity Bar, then clear Source Control in the context menu. Keyboard: open the Command Palette, run View: Focus Activity Bar, use the arrow keys to reach Source Control, then use your platform's context-menu shortcut (often Shift+F10; use fn if needed) and clear Source Control. Git'o works with it visible or hidden.",
  sourceControlConfirmationPrompt:
    "After manually hiding Source Control in the Activity Bar, select Confirm.",
  sourceControlWalkthroughDescription:
    "Keep VS Code's bundled `vscode.git` extension enabled: Git'o uses it for repository discovery, state, and ordinary local mutations. CLI-backed features use a configured absolute `git.path`, otherwise the executable exposed by the bundled extension. Native worktree create/remove requires a desktop `file:` repository; remote Extension Host behavior is not live-proven. Source Control can stay visible; hiding it is optional if you prefer less duplicate navigation. [Show optional hiding steps](command:gito.onboarding.showSourceControlSteps), then [confirm it was hidden](command:gito.onboarding.confirmSourceControlHidden), or [keep Source Control visible](command:gito.onboarding.acknowledgeSourceControlVisible). Git'o works either way.",
  privacyWalkthroughDescription:
    "Git'o has no account, backend, telemetry, analytics, or PAT flow. In a trusted workspace, local Git works when every provider step is skipped; untrusted workspaces may expose read-only inspection only. Setup never opens a browser or sends a provider request automatically. Reopen this walkthrough any time with [Git'o: Open Setup](command:gito.onboarding.openSetup).",
  githubWalkthroughDescription:
    "Optional GitHub.com pull-request data. [Connect GitHub](command:gito.onboarding.connectGitHub) only when you choose to sign in through VS Code's GitHub provider, or [keep GitHub disconnected](command:gito.onboarding.skipGitHub) to finish setup without cloud data. The provider controls the `repo` and `read:user` session scopes; `repo` can grant access broader than Git'o's read-only operations. Git'o has no account or PAT flow, and in a trusted workspace local Git does not depend on it.",
  providerConnectionFailure: (
    providerDisplayName: string,
    connectCommandTitle: string,
    keepDisconnectedCommandTitle: string,
  ) =>
    `${providerDisplayName} connection did not complete. Git'o does not store provider tokens or identity. Try ${connectCommandTitle} again, or choose ${keepDisconnectedCommandTitle} to finish setup without cloud data.`,
  walkthroughMediaAltText:
    "Git'o setup illustration: a violet-to-blue Git'o mark links a local repository folder to a repository summary card.",
} as const;

/** One global marker: the native first-install walkthrough was opened successfully. */
export const onboardingGlobalStateKeys = {
  firstInstallWalkthroughOpened:
    "gito.onboarding.firstInstallWalkthroughOpened",
} as const;

export type OnboardingProviderId = "github";

export function getOnboardingProviderContextKey(): string {
  return onboardingWalkthroughContextKeys.githubConnected;
}

export function getOnboardingProviderSetupCompletionContextKey(): string {
  return onboardingWalkthroughContextKeys.githubSetupCompleted;
}
