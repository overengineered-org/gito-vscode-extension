// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await */
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
  window: { showInformationMessage: vi.fn() },
}));

import {
  registerOnboardingCommands,
  resetOnboardingRepositoryHomeContext,
  synchronizeOnboardingLocalRepositoryContext,
  synchronizeOnboardingProviderConnectionContext,
  type OnboardingCommandRegistry,
  type OnboardingCommandServices,
} from "../../../src/extension/onboarding/onboardingCommands.js";
import {
  onboardingCommandIds,
  onboardingCopy,
  onboardingNativeCommandIds,
  onboardingWalkthroughContextKeys,
  onboardingWalkthroughIdentifier,
  type OnboardingProviderId,
} from "../../../src/extension/onboarding/onboardingContent.js";

interface RegisteredOnboardingCommand {
  readonly commandIdentifier: string;
  readonly commandHandler: () => Promise<void>;
}

function createOnboardingCommandRegistry(): {
  readonly commandRegistry: OnboardingCommandRegistry;
  readonly registeredCommands: Map<string, RegisteredOnboardingCommand>;
} {
  const registeredCommands = new Map<string, RegisteredOnboardingCommand>();
  return {
    commandRegistry: {
      registerCommand: (commandIdentifier, commandHandler) => {
        registeredCommands.set(commandIdentifier, {
          commandIdentifier,
          commandHandler,
        });
        return { dispose: () => undefined };
      },
    },
    registeredCommands,
  };
}

function getRegisteredCommandHandler(
  registeredCommands: ReadonlyMap<string, RegisteredOnboardingCommand>,
  commandIdentifier: string,
): () => Promise<void> {
  const registeredCommand = registeredCommands.get(commandIdentifier);
  if (registeredCommand === undefined)
    throw new Error(
      `Missing registered onboarding command: ${commandIdentifier}`,
    );
  return registeredCommand.commandHandler;
}

function createOnboardingCommandServices(
  options: {
    readonly isLocalRepositoryOpen?: boolean;
    readonly connectProvider?: OnboardingCommandServices["connectProvider"];
    readonly revealRepositoryHome?: OnboardingCommandServices["revealRepositoryHome"];
    readonly confirmSourceControlHidden?: OnboardingCommandServices["confirmSourceControlHidden"];
  } = {},
): {
  readonly onboardingCommandServices: OnboardingCommandServices;
  readonly connectedProviderIds: OnboardingProviderId[];
  readonly nativeCommandCalls: {
    readonly commandIdentifier: string;
    readonly commandArguments: readonly unknown[];
  }[];
  readonly informationMessages: string[];
  readonly repositoryHomeRevealCount: { value: number };
} {
  const nativeCommandCalls: {
    readonly commandIdentifier: string;
    readonly commandArguments: readonly unknown[];
  }[] = [];
  const informationMessages: string[] = [];
  const connectedProviderIds: "github"[] = [];
  const repositoryHomeRevealCount = { value: 0 };
  return {
    onboardingCommandServices: {
      revealRepositoryHome:
        options.revealRepositoryHome ??
        (async () => {
          repositoryHomeRevealCount.value += 1;
        }),
      connectProvider:
        options.connectProvider ??
        (async (providerId) => {
          connectedProviderIds.push(providerId);
          return true;
        }),
      hasOpenLocalRepository: async () => options.isLocalRepositoryOpen ?? true,
      confirmSourceControlHidden:
        options.confirmSourceControlHidden ?? (async () => true),
      executeNativeCommand: async (commandIdentifier, ...commandArguments) => {
        nativeCommandCalls.push({ commandIdentifier, commandArguments });
      },
      showInformationMessage: async (message) => {
        informationMessages.push(message);
      },
    },
    connectedProviderIds,
    nativeCommandCalls,
    informationMessages,
    repositoryHomeRevealCount,
  };
}

describe("Git'o setup commands", () => {
  it("registers every native walkthrough action with required real callbacks", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const {
      onboardingCommandServices,
      connectedProviderIds,
      nativeCommandCalls,
      informationMessages,
      repositoryHomeRevealCount,
    } = createOnboardingCommandServices();

    expect(
      registerOnboardingCommands(commandRegistry, onboardingCommandServices),
    ).toHaveLength(Object.values(onboardingCommandIds).length);
    expect([...registeredCommands.keys()]).toEqual(
      Object.values(onboardingCommandIds),
    );

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.openOrChooseRepository,
    )();
    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.openHome,
    )();
    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.showSourceControlSteps,
    )();
    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.confirmSourceControlHidden,
    )();
    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.connectGitHub,
    )();
    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.skipGitHub,
    )();
    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.openSetup,
    )();

    expect(repositoryHomeRevealCount.value).toBe(1);
    expect(connectedProviderIds).toEqual(["github"]);
    expect(informationMessages).toEqual([
      onboardingCopy.sourceControlManualHideInstructions,
    ]);
    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.openRepository,
        commandArguments: [],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.localRepositoryAvailable,
          true,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          true,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.sourceControlVisibilityPreferenceAcknowledged,
          true,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.githubConnected,
          true,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.githubSetupCompleted,
          true,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.githubSetupCompleted,
          true,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.openWalkthrough,
        commandArguments: [onboardingWalkthroughIdentifier],
      },
    ]);
  });

  it("does not claim a local repository exists after the native picker is cancelled", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const { onboardingCommandServices, nativeCommandCalls } =
      createOnboardingCommandServices({ isLocalRepositoryOpen: false });
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.openOrChooseRepository,
    )();

    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.openRepository,
        commandArguments: [],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.localRepositoryAvailable,
          false,
        ],
      },
    ]);
  });

  it("does not open or complete Home without a local repository", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const {
      onboardingCommandServices,
      informationMessages,
      nativeCommandCalls,
      repositoryHomeRevealCount,
    } = createOnboardingCommandServices({ isLocalRepositoryOpen: false });
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.openHome,
    )();

    expect(repositoryHomeRevealCount.value).toBe(0);
    expect(informationMessages).toEqual([
      "Open a local Git repository before opening Git'o Home.",
    ]);
    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        ],
      },
    ]);
  });

  it("clears Home completion before a failed load and a later retry", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    let revealAttemptCount = 0;
    const { onboardingCommandServices, nativeCommandCalls } =
      createOnboardingCommandServices({
        revealRepositoryHome: async () => {
          revealAttemptCount += 1;
          if (revealAttemptCount === 1)
            throw new Error("Repository Home failed to load.");
        },
      });
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await expect(
      getRegisteredCommandHandler(
        registeredCommands,
        onboardingCommandIds.openHome,
      )(),
    ).rejects.toThrow("Repository Home failed to load.");
    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        ],
      },
    ]);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.openHome,
    )();

    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          true,
        ],
      },
    ]);
  });

  it("does not complete manual Source Control hiding without confirmation", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const { onboardingCommandServices, nativeCommandCalls } =
      createOnboardingCommandServices({
        confirmSourceControlHidden: async () => false,
      });
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.confirmSourceControlHidden,
    )();

    expect(nativeCommandCalls).toEqual([]);
  });

  it("completes optional Source Control setup when the user keeps it visible", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const { onboardingCommandServices, nativeCommandCalls } =
      createOnboardingCommandServices();
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.acknowledgeSourceControlVisible,
    )();

    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.sourceControlVisibilityPreferenceAcknowledged,
          true,
        ],
      },
    ]);
  });

  it("does not mark a provider connected when user-triggered authentication fails", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const {
      onboardingCommandServices,
      nativeCommandCalls,
      informationMessages,
    } = createOnboardingCommandServices({
      connectProvider: async () => {
        throw new Error("User cancelled provider sign-in.");
      },
    });
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await expect(
      getRegisteredCommandHandler(
        registeredCommands,
        onboardingCommandIds.connectGitHub,
      )(),
    ).resolves.toBeUndefined();
    expect(nativeCommandCalls).toEqual([]);
    expect(informationMessages).toHaveLength(1);
    expect(informationMessages[0]).toContain(
      "GitHub connection did not complete",
    );
    expect(informationMessages[0]).toContain("Keep GitHub Disconnected");
  });

  it("does not complete a provider step without verified dashboard connection", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const {
      onboardingCommandServices,
      nativeCommandCalls,
      informationMessages,
    } = createOnboardingCommandServices({
      connectProvider: async () => false,
    });
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.connectGitHub,
    )();

    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.githubConnected,
          false,
        ],
      },
    ]);
    expect(informationMessages).toHaveLength(1);
    expect(informationMessages[0]).toContain(
      "GitHub connection did not complete",
    );
  });

  it("completes an optional provider step without connecting it", async () => {
    const { commandRegistry, registeredCommands } =
      createOnboardingCommandRegistry();
    const {
      onboardingCommandServices,
      connectedProviderIds,
      nativeCommandCalls,
    } = createOnboardingCommandServices();
    registerOnboardingCommands(commandRegistry, onboardingCommandServices);

    await getRegisteredCommandHandler(
      registeredCommands,
      onboardingCommandIds.skipGitHub,
    )();

    expect(connectedProviderIds).toEqual([]);
    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.githubSetupCompleted,
          true,
        ],
      },
    ]);
  });

  it("synchronizes the local repository context without global state", async () => {
    const nativeCommandCalls: {
      readonly commandIdentifier: string;
      readonly commandArguments: readonly unknown[];
    }[] = [];

    await synchronizeOnboardingLocalRepositoryContext(
      async () => false,
      async (commandIdentifier, ...commandArguments) => {
        nativeCommandCalls.push({ commandIdentifier, commandArguments });
      },
    );

    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.localRepositoryAvailable,
          false,
        ],
      },
    ]);
  });

  it("clears current Home and provider contexts without clearing acknowledgement history", async () => {
    const nativeCommandCalls: {
      readonly commandIdentifier: string;
      readonly commandArguments: readonly unknown[];
    }[] = [];
    const executeNativeCommand = async (
      commandIdentifier: string,
      ...commandArguments: readonly unknown[]
    ) => {
      nativeCommandCalls.push({ commandIdentifier, commandArguments });
    };

    await resetOnboardingRepositoryHomeContext(executeNativeCommand);
    await synchronizeOnboardingProviderConnectionContext(
      "github",
      false,
      executeNativeCommand,
    );

    expect(nativeCommandCalls).toEqual([
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.repositoryHomeOpened,
          false,
        ],
      },
      {
        commandIdentifier: onboardingNativeCommandIds.setContext,
        commandArguments: [
          onboardingWalkthroughContextKeys.githubConnected,
          false,
        ],
      },
    ]);
  });

  it("keeps every outcome-bearing callback mandatory", () => {
    type RequiredOnboardingCommandServiceKey = {
      [
        serviceKey in keyof OnboardingCommandServices
      ]-?: undefined extends OnboardingCommandServices[serviceKey]
        ? never
        : serviceKey;
    }[keyof OnboardingCommandServices];

    expectTypeOf<RequiredOnboardingCommandServiceKey>().toEqualTypeOf<
      | "revealRepositoryHome"
      | "connectProvider"
      | "hasOpenLocalRepository"
      | "confirmSourceControlHidden"
    >();
    expectTypeOf<
      OnboardingCommandServices["connectProvider"]
    >().returns.toEqualTypeOf<Promise<boolean>>();
  });
});

describe("Git'o setup manifest and copy", () => {
  it("contributes a working native walkthrough and no dead viewsWelcome entry", () => {
    const packageManifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as {
      readonly activationEvents: readonly string[];
      readonly extensionDependencies: readonly string[];
      readonly contributes: {
        readonly commands: readonly { readonly command: string }[];
        readonly walkthroughs: readonly {
          readonly id: string;
          readonly title: string;
          readonly description: string;
          readonly steps: readonly {
            readonly id: string;
            readonly title: string;
            readonly description: string;
            readonly completionEvents: readonly string[];
            readonly media: {
              readonly svg: string;
              readonly altText: string;
            };
          }[];
        }[];
        readonly viewsWelcome?: unknown;
        readonly menus: {
          readonly commandPalette: readonly {
            readonly command: string;
            readonly when: string;
          }[];
        };
      };
    };
    const setupWalkthrough = packageManifest.contributes.walkthroughs.find(
      (walkthrough) => walkthrough.id === "setup",
    );

    expect(packageManifest.extensionDependencies).toContain("vscode.git");
    expect(packageManifest.contributes.viewsWelcome).toBeUndefined();
    expect(packageManifest.activationEvents).not.toContain("onStartupFinished");
    expect(
      packageManifest.contributes.commands.map(({ command }) => command),
    ).toEqual(expect.arrayContaining(Object.values(onboardingCommandIds)));
    expect(packageManifest.activationEvents).toEqual(
      expect.arrayContaining(
        Object.values(onboardingCommandIds).map(
          (commandIdentifier) => `onCommand:${commandIdentifier}`,
        ),
      ),
    );
    expect(setupWalkthrough).toMatchObject({
      title: "Set up Git'o",
      description: onboardingCopy.walkthroughDescription,
    });
    expect(setupWalkthrough?.steps).toHaveLength(5);
    expect(
      setupWalkthrough?.steps.map(
        ({ description: walkthroughStepDescription }) =>
          walkthroughStepDescription,
      ),
    ).toEqual([
      onboardingCopy.openRepositoryWalkthroughDescription,
      onboardingCopy.openHomeWalkthroughDescription,
      onboardingCopy.sourceControlWalkthroughDescription,
      onboardingCopy.githubWalkthroughDescription,
      onboardingCopy.privacyWalkthroughDescription,
    ]);
    for (const walkthroughStep of setupWalkthrough?.steps ?? []) {
      expect(walkthroughStep.media).toEqual({
        svg: "media/onboarding/setup.svg",
        altText: onboardingCopy.walkthroughMediaAltText,
      });
    }
    const walkthroughMedia = readFileSync("media/onboarding/setup.svg", "utf8");
    expect(walkthroughMedia).toContain("#7c3aed");
    expect(walkthroughMedia).toContain("#0ea5e9");
    expect(walkthroughMedia).not.toMatch(/orange|#f97316|#fb923c|#ea580c/i);
    expect(setupWalkthrough?.steps).toEqual([
      expect.objectContaining({
        id: "open-or-choose-repository",
        completionEvents: [
          `onContext:${onboardingWalkthroughContextKeys.localRepositoryAvailable}`,
        ],
      }),
      expect.objectContaining({
        id: "open-repository-home",
        completionEvents: [
          `onContext:${onboardingWalkthroughContextKeys.repositoryHomeOpened}`,
        ],
      }),
      expect.objectContaining({
        id: "keep-the-bundled-git-engine",
        description: onboardingCopy.sourceControlWalkthroughDescription,
        completionEvents: [
          `onContext:${onboardingWalkthroughContextKeys.sourceControlVisibilityPreferenceAcknowledged}`,
        ],
      }),
      expect.objectContaining({
        id: "connect-github-optional",
        description: onboardingCopy.githubWalkthroughDescription,
        completionEvents: [
          `onContext:${onboardingWalkthroughContextKeys.githubSetupCompleted}`,
        ],
      }),
      expect.objectContaining({ id: "privacy-completion-and-reopening" }),
    ]);
    expect(
      setupWalkthrough?.steps.find(
        (walkthroughStep) =>
          walkthroughStep.id === "keep-the-bundled-git-engine",
      )?.completionEvents,
    ).not.toContain("stepSelected");
    expect(
      packageManifest.contributes.menus.commandPalette.filter(({ command }) =>
        command.startsWith("gito.onboarding."),
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          command: onboardingCommandIds.showSourceControlSteps,
          when: "!gito.onboarding.sourceControlVisibilityPreferenceAcknowledged",
        },
        {
          command: onboardingCommandIds.confirmSourceControlHidden,
          when: "!gito.onboarding.sourceControlVisibilityPreferenceAcknowledged",
        },
        {
          command: onboardingCommandIds.acknowledgeSourceControlVisible,
          when: "!gito.onboarding.sourceControlVisibilityPreferenceAcknowledged",
        },
      ]),
    );
    expect(packageManifest.contributes.menus.commandPalette).toContainEqual({
      command: onboardingCommandIds.openSetup,
      when: "true",
    });
    expect(onboardingCopy.openRepositoryWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.openOrChooseRepository}`,
    );
    expect(onboardingCopy.openHomeWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.openHome}`,
    );
    expect(onboardingCopy.sourceControlWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.showSourceControlSteps}`,
    );
    expect(onboardingCopy.sourceControlWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.confirmSourceControlHidden}`,
    );
    expect(onboardingCopy.sourceControlWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.acknowledgeSourceControlVisible}`,
    );
    expect(onboardingCopy.githubWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.connectGitHub}`,
    );
    expect(onboardingCopy.githubWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.skipGitHub}`,
    );
    expect(onboardingCopy.privacyWalkthroughDescription).toContain(
      `command:${onboardingCommandIds.openSetup}`,
    );
  });

  it("keeps onboarding claims truthful and privacy-first", () => {
    const onboardingDocumentation = readFileSync("docs/ONBOARDING.md", "utf8");
    const onboardingCommandSource = readFileSync(
      "src/extension/onboarding/onboardingCommands.ts",
      "utf8",
    );
    const onboardingCopyText = [
      onboardingCopy.walkthroughDescription,
      onboardingCopy.openRepositoryWalkthroughDescription,
      onboardingCopy.openHomeWalkthroughDescription,
      onboardingCopy.sourceControlManualHideInstructions,
      onboardingCopy.sourceControlWalkthroughDescription,
      onboardingCopy.privacyWalkthroughDescription,
      onboardingCopy.githubWalkthroughDescription,
      onboardingCopy.providerConnectionFailure(
        "GitHub",
        "Git'o: Connect GitHub",
        "Git'o: Keep GitHub Disconnected",
      ),
      onboardingDocumentation,
      onboardingCommandSource,
    ].join("\n");

    expect(Object.values(onboardingCommandIds)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/azure|devops|microsoft/i),
      ]),
    );
    expect(onboardingCommandSource).not.toMatch(/azure|devops|microsoft/i);

    expect(onboardingCopyText).toContain("Git'o cannot hide it for you.");
    expect(onboardingCopyText).toContain("View: Focus Activity Bar");
    expect(onboardingCopyText).toContain("trusted workspace");
    expect(onboardingCopyText).toContain("keep Source Control visible");
    expect(onboardingCopyText).toContain("configured absolute `git.path`");
    expect(onboardingCopyText).toContain(
      "remote Extension Host behavior is not live-proven",
    );
    expect(onboardingCopyText).toContain("no account");
    expect(onboardingCopyText).toContain("PAT flow");
    expect(onboardingCopyText).toContain(
      "`repo` and `read:user` session scopes",
    );
    expect(onboardingCopyText).toContain("explicitly confirm the action");
    expect(onboardingCopyText).toContain("The provider controls");
    expect(onboardingDocumentation).toContain(
      "Current repository and provider status is session-scoped",
    );
    expect(onboardingDocumentation).toContain("keep-disconnected choice");
    expect(onboardingCopyText).toContain(
      "Git'o does not store provider tokens or identity",
    );
    expect(onboardingDocumentation).not.toMatch(
      /gito\.onboarding\.|globalState|registerOnboardingCommands|dashboardOrchestrator|localGitExtensionHost/,
    );
    expect(onboardingCopyText).not.toMatch(/\bMVP\b/i);
    expect(onboardingCommandSource).not.toMatch(
      /globalState|workspace\.getConfiguration/,
    );
    expect(onboardingCommandSource).not.toMatch(/openExternal|https?:\/\//);
  });
});
