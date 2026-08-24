import {
  onboardingGlobalStateKeys,
  onboardingNativeCommandIds,
  onboardingWalkthroughIdentifier,
} from "./onboardingContent.js";

/** The minimal persisted shape needed for first-install walkthrough guidance. */
export interface OnboardingGlobalState {
  get<Value>(storageKey: string, defaultValue?: Value): Value | undefined;
  update(storageKey: string, storedValue: unknown): Thenable<void>;
}

export interface OpenWalkthroughCommandExecutor {
  executeCommand(
    commandIdentifier: string,
    ...commandArguments: readonly unknown[]
  ): Thenable<unknown> | Promise<unknown>;
}

/**
 * Opens native setup once after installation. The marker is written only after
 * VS Code accepts the native command, so a transient command failure can retry.
 */
export async function openFirstInstallWalkthroughOnce(
  globalState: OnboardingGlobalState,
  commandExecutor: OpenWalkthroughCommandExecutor,
): Promise<boolean> {
  if (
    globalState.get<boolean>(
      onboardingGlobalStateKeys.firstInstallWalkthroughOpened,
    )
  ) {
    return false;
  }
  await commandExecutor.executeCommand(
    onboardingNativeCommandIds.openWalkthrough,
    onboardingWalkthroughIdentifier,
  );
  await globalState.update(
    onboardingGlobalStateKeys.firstInstallWalkthroughOpened,
    true,
  );
  return true;
}
