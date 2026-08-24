import * as vscode from "vscode";
import {
  getOnboardingProviderContextKey,
  getOnboardingProviderSetupCompletionContextKey,
  onboardingCommandIds,
  onboardingCopy,
  onboardingNativeCommandIds,
  onboardingWalkthroughContextKeys,
  onboardingWalkthroughIdentifier,
  type OnboardingProviderId,
} from "./onboardingContent.js";

export interface OnboardingCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    commandHandler: () => Promise<void>,
  ): vscode.Disposable;
}

export interface OnboardingCommandServices {
  /** Resolves only after Repository Home has loaded the selected local repository. */
  readonly revealRepositoryHome: () => Promise<void>;
  /** Resolves true only when the current dashboard snapshot is connected. */
  readonly connectProvider: (
    providerId: OnboardingProviderId,
  ) => Promise<boolean>;
  readonly hasOpenLocalRepository: () => Promise<boolean>;
  /** Asks the user to attest that they manually hid Source Control. */
  readonly confirmSourceControlHidden: () => Promise<boolean>;
  readonly executeNativeCommand?: (
    commandIdentifier: string,
    ...commandArguments: readonly unknown[]
  ) => Promise<unknown>;
  readonly showInformationMessage?: (message: string) => Promise<unknown>;
}

type ExecuteNativeCommand = NonNullable<
  OnboardingCommandServices["executeNativeCommand"]
>;

function executeVscodeNativeCommand(
  commandIdentifier: string,
  ...commandArguments: readonly unknown[]
): Promise<unknown> {
  return Promise.resolve(
    vscode.commands.executeCommand(commandIdentifier, ...commandArguments),
  );
}

function showVscodeInformationMessage(message: string): Promise<unknown> {
  return Promise.resolve(vscode.window.showInformationMessage(message));
}

async function setWalkthroughContext(
  executeNativeCommand: ExecuteNativeCommand,
  walkthroughContextKey: string,
  isEnabled: boolean,
): Promise<void> {
  await executeNativeCommand(
    onboardingNativeCommandIds.setContext,
    walkthroughContextKey,
    isEnabled,
  );
}

export async function synchronizeOnboardingLocalRepositoryContext(
  hasOpenLocalRepository: OnboardingCommandServices["hasOpenLocalRepository"],
  executeNativeCommand: ExecuteNativeCommand = executeVscodeNativeCommand,
): Promise<void> {
  const isLocalRepositoryOpen = await hasOpenLocalRepository();
  await setWalkthroughContext(
    executeNativeCommand,
    onboardingWalkthroughContextKeys.localRepositoryAvailable,
    isLocalRepositoryOpen,
  );
}

/** Clears Home's current-repository completion after its repository closes. */
export async function resetOnboardingRepositoryHomeContext(
  executeNativeCommand: ExecuteNativeCommand = executeVscodeNativeCommand,
): Promise<void> {
  await setWalkthroughContext(
    executeNativeCommand,
    onboardingWalkthroughContextKeys.repositoryHomeOpened,
    false,
  );
}

/**
 * Synchronizes current provider state and records successful optional setup.
 * Disconnecting never clears the explicit setup completion.
 */
export async function synchronizeOnboardingProviderConnectionContext(
  providerId: OnboardingProviderId,
  isProviderConnected: boolean,
  executeNativeCommand: ExecuteNativeCommand = executeVscodeNativeCommand,
): Promise<void> {
  await setWalkthroughContext(
    executeNativeCommand,
    getOnboardingProviderContextKey(),
    isProviderConnected,
  );
  if (isProviderConnected)
    await setWalkthroughContext(
      executeNativeCommand,
      getOnboardingProviderSetupCompletionContextKey(),
      true,
    );
}

/** Completes an optional provider step without changing provider state. */
export async function completeOnboardingProviderSetup(
  providerId: OnboardingProviderId,
  executeNativeCommand: ExecuteNativeCommand = executeVscodeNativeCommand,
): Promise<void> {
  await setWalkthroughContext(
    executeNativeCommand,
    getOnboardingProviderSetupCompletionContextKey(),
    true,
  );
}

export function registerOnboardingCommands(
  commandRegistry: OnboardingCommandRegistry,
  onboardingCommandServices: OnboardingCommandServices,
): readonly vscode.Disposable[] {
  const executeNativeCommand =
    onboardingCommandServices.executeNativeCommand ??
    executeVscodeNativeCommand;
  const showInformationMessage =
    onboardingCommandServices.showInformationMessage ??
    showVscodeInformationMessage;

  return [
    commandRegistry.registerCommand(
      onboardingCommandIds.openOrChooseRepository,
      async () => {
        await executeNativeCommand(onboardingNativeCommandIds.openRepository);
        await synchronizeOnboardingLocalRepositoryContext(
          onboardingCommandServices.hasOpenLocalRepository,
          executeNativeCommand,
        );
      },
    ),
    commandRegistry.registerCommand(onboardingCommandIds.openHome, async () => {
      if (!(await onboardingCommandServices.hasOpenLocalRepository())) {
        await setWalkthroughContext(
          executeNativeCommand,
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        );
        await showInformationMessage(
          "Open a local Git repository before opening Git'o Home.",
        );
        return;
      }
      await setWalkthroughContext(
        executeNativeCommand,
        onboardingWalkthroughContextKeys.repositoryHomeOpened,
        false,
      );
      await onboardingCommandServices.revealRepositoryHome();
      await setWalkthroughContext(
        executeNativeCommand,
        onboardingWalkthroughContextKeys.repositoryHomeOpened,
        true,
      );
    }),
    commandRegistry.registerCommand(
      onboardingCommandIds.showSourceControlSteps,
      async () => {
        await showInformationMessage(
          onboardingCopy.sourceControlManualHideInstructions,
        );
      },
    ),
    commandRegistry.registerCommand(
      onboardingCommandIds.confirmSourceControlHidden,
      async () => {
        if (!(await onboardingCommandServices.confirmSourceControlHidden()))
          return;
        await setWalkthroughContext(
          executeNativeCommand,
          onboardingWalkthroughContextKeys.sourceControlVisibilityPreferenceAcknowledged,
          true,
        );
      },
    ),
    commandRegistry.registerCommand(
      onboardingCommandIds.acknowledgeSourceControlVisible,
      async () => {
        await setWalkthroughContext(
          executeNativeCommand,
          onboardingWalkthroughContextKeys.sourceControlVisibilityPreferenceAcknowledged,
          true,
        );
      },
    ),
    commandRegistry.registerCommand(onboardingCommandIds.connectGitHub, () =>
      connectOnboardingProvider(
        onboardingCommandServices.connectProvider,
        executeNativeCommand,
        showInformationMessage,
        "github",
      ),
    ),
    commandRegistry.registerCommand(onboardingCommandIds.skipGitHub, () =>
      completeOnboardingProviderSetup("github", executeNativeCommand),
    ),
    commandRegistry.registerCommand(
      onboardingCommandIds.openSetup,
      async () => {
        await executeNativeCommand(
          onboardingNativeCommandIds.openWalkthrough,
          onboardingWalkthroughIdentifier,
        );
      },
    ),
  ];
}

async function connectOnboardingProvider(
  connectProvider: OnboardingCommandServices["connectProvider"],
  executeNativeCommand: ExecuteNativeCommand,
  showInformationMessage: (message: string) => Promise<unknown>,
  providerId: OnboardingProviderId,
): Promise<void> {
  try {
    const isProviderConnected = await connectProvider(providerId);
    await synchronizeOnboardingProviderConnectionContext(
      providerId,
      isProviderConnected,
      executeNativeCommand,
    );
    if (!isProviderConnected)
      await showInformationMessage(getProviderConnectionFailureMessage());
  } catch {
    await showInformationMessage(getProviderConnectionFailureMessage());
  }
}

function getProviderConnectionFailureMessage(): string {
  return onboardingCopy.providerConnectionFailure(
    "GitHub",
    "Git'o: Connect GitHub",
    "Git'o: Keep GitHub Disconnected",
  );
}
