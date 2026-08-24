import { describe, expect, it } from "vitest";
import {
  openFirstInstallWalkthroughOnce,
  type OnboardingGlobalState,
  type OpenWalkthroughCommandExecutor,
} from "../../../src/extension/onboarding/firstInstallWalkthrough.js";
import {
  onboardingGlobalStateKeys,
  onboardingNativeCommandIds,
  onboardingWalkthroughIdentifier,
} from "../../../src/extension/onboarding/onboardingContent.js";

function createFirstInstallWalkthroughServices(options?: {
  readonly rejectWalkthroughOpen?: boolean;
}): {
  readonly globalState: OnboardingGlobalState;
  readonly commandExecutor: OpenWalkthroughCommandExecutor;
  readonly commandCalls: readonly {
    readonly commandIdentifier: string;
    readonly commandArguments: readonly unknown[];
  }[];
  readonly storedValues: ReadonlyMap<string, unknown>;
} {
  const storedValues = new Map<string, unknown>();
  const commandCalls: {
    readonly commandIdentifier: string;
    readonly commandArguments: readonly unknown[];
  }[] = [];
  return {
    globalState: {
      get: <Value>(storageKey: string, defaultValue?: Value) =>
        (storedValues.get(storageKey) as Value | undefined) ?? defaultValue,
      update: (storageKey, storedValue) => {
        storedValues.set(storageKey, storedValue);
        return Promise.resolve();
      },
    },
    commandExecutor: {
      executeCommand: (commandIdentifier, ...commandArguments) => {
        commandCalls.push({ commandIdentifier, commandArguments });
        if (options?.rejectWalkthroughOpen)
          return Promise.reject(
            new Error("Native walkthrough command failed."),
          );
        return Promise.resolve();
      },
    },
    commandCalls,
    storedValues,
  };
}

describe("first-install native walkthrough", () => {
  it("opens setup once and persists only its successful native opening", async () => {
    const { globalState, commandExecutor, commandCalls, storedValues } =
      createFirstInstallWalkthroughServices();

    await expect(
      openFirstInstallWalkthroughOnce(globalState, commandExecutor),
    ).resolves.toBe(true);
    await expect(
      openFirstInstallWalkthroughOnce(globalState, commandExecutor),
    ).resolves.toBe(false);

    expect(commandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.openWalkthrough,
        commandArguments: [onboardingWalkthroughIdentifier],
      },
    ]);
    expect([...storedValues.entries()]).toEqual([
      [onboardingGlobalStateKeys.firstInstallWalkthroughOpened, true],
    ]);
  });

  it("does not persist a marker when VS Code rejects the native walkthrough", async () => {
    const { globalState, commandExecutor, storedValues } =
      createFirstInstallWalkthroughServices({ rejectWalkthroughOpen: true });

    await expect(
      openFirstInstallWalkthroughOnce(globalState, commandExecutor),
    ).rejects.toThrow("Native walkthrough command failed.");
    expect(storedValues).toEqual(new Map());
  });
});
