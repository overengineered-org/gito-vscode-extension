// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const mockDisposableState = vi.hoisted(() => ({
  activeCount: 0,
  activeAuthenticationSessionListenerCount: 0,
  activeWindowStateListenerCount: 0,
  closeDocumentEventRegistrationCount: 0,
  contentProviderRegistrations: [] as Array<{
    scheme: string;
    provider: unknown;
    disposed: boolean;
  }>,
  fileSystemProviderRegistrations: [] as Array<{
    scheme: string;
    provider: unknown;
    options: { isCaseSensitive?: boolean; isReadonly?: boolean };
    disposed: boolean;
  }>,
}));

vi.mock("vscode", () => {
  type MockEventListener<EventValue> = (eventValue: EventValue) => unknown;
  type MockListenerRegistration<EventValue> = {
    listener: MockEventListener<EventValue>;
    registrationDisposable?: MockDisposable;
  };

  class MockDisposable {
    private disposed = false;

    public constructor(private readonly disposeAction: () => void = () => {}) {
      mockDisposableState.activeCount += 1;
    }

    public dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      mockDisposableState.activeCount -= 1;
      this.disposeAction();
    }
  }

  class MockEventEmitter<EventValue> {
    private readonly listenerRegistrations: MockListenerRegistration<EventValue>[] =
      [];

    public constructor(
      private readonly activeListenerCount: keyof Pick<
        typeof mockDisposableState,
        | "activeAuthenticationSessionListenerCount"
        | "activeWindowStateListenerCount"
      >,
    ) {}

    public readonly event = (
      listener: MockEventListener<EventValue>,
    ): MockDisposable => {
      const listenerRegistration: MockListenerRegistration<EventValue> = {
        listener,
      };
      this.listenerRegistrations.push(listenerRegistration);
      mockDisposableState[this.activeListenerCount] += 1;
      const registrationDisposable = new MockDisposable(() => {
        const registrationIndex =
          this.listenerRegistrations.indexOf(listenerRegistration);
        if (registrationIndex < 0) return;
        this.listenerRegistrations.splice(registrationIndex, 1);
        mockDisposableState[this.activeListenerCount] -= 1;
      });
      listenerRegistration.registrationDisposable = registrationDisposable;
      return registrationDisposable;
    };

    public fire(eventValue: EventValue): void {
      for (const { listener } of [...this.listenerRegistrations])
        listener(eventValue);
    }

    public dispose(): void {
      for (const { registrationDisposable } of [...this.listenerRegistrations])
        registrationDisposable?.dispose();
    }
  }

  class MockTreeItem {
    public command: unknown;
    public iconPath: unknown;
    public contextValue: string | undefined;

    public constructor(
      public readonly label: string,
      public readonly collapsibleState: number,
    ) {}
  }

  class MockUri {
    public readonly scheme = "file";
    public readonly authority = "";
    public readonly path: string;
    public readonly fsPath: string;
    public readonly query = "";
    public readonly fragment = "";

    public constructor(path: string) {
      this.path = path;
      this.fsPath = path;
    }

    public static file(filePath: string): MockUri {
      return new MockUri(filePath);
    }

    public static parse(uri: string): MockUri {
      return new MockUri(uri.replace(/^file:\/\//, ""));
    }

    public static joinPath(uri: MockUri, ...pathSegments: string[]): MockUri {
      return new MockUri([uri.path, ...pathSegments].join("/"));
    }

    public with(change: { path?: string }): MockUri {
      return new MockUri(change.path ?? this.path);
    }

    public toString(): string {
      return `file://${this.path}`;
    }
  }

  const disposable = (): MockDisposable => new MockDisposable();
  const authenticationSessionEventEmitter = new MockEventEmitter<unknown>(
    "activeAuthenticationSessionListenerCount",
  );
  const windowStateEventEmitter = new MockEventEmitter<unknown>(
    "activeWindowStateListenerCount",
  );
  return {
    Disposable: MockDisposable,
    EventEmitter: MockEventEmitter,
    ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    Uri: MockUri,
    ThemeIcon: class MockThemeIcon {
      public constructor(public readonly id: string) {}
    },
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: { None: 0 },
    ViewColumn: { Active: 1 },
    commands: {
      registerCommand: vi.fn(() => new MockDisposable()),
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    },
    window: {
      createOutputChannel: vi.fn(() => {
        const lifecycle = new MockDisposable();
        return {
          appendLine: vi.fn(),
          show: vi.fn(),
          dispose: () => lifecycle.dispose(),
        };
      }),
      registerTreeDataProvider: vi.fn(() => new MockDisposable()),
      registerWebviewPanelSerializer: vi.fn(() => new MockDisposable()),
      onDidChangeActiveTextEditor: vi.fn(disposable),
      onDidChangeTextEditorSelection: vi.fn(disposable),
      onDidChangeWindowState: vi.fn(windowStateEventEmitter.event),
      createTextEditorDecorationType: vi.fn(disposable),
      createStatusBarItem: vi.fn(disposable),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    },
    workspace: {
      isTrusted: true,
      onDidGrantWorkspaceTrust: vi.fn(disposable),
      onDidChangeTextDocument: vi.fn(disposable),
      onDidCloseTextDocument: vi.fn(() => {
        mockDisposableState.closeDocumentEventRegistrationCount += 1;
        return disposable();
      }),
      onDidChangeConfiguration: vi.fn(disposable),
      registerTextDocumentContentProvider: vi.fn(
        (scheme: string, provider: unknown) => {
          const registration = { scheme, provider, disposed: false };
          mockDisposableState.contentProviderRegistrations.push(registration);
          return new MockDisposable(() => {
            registration.disposed = true;
          });
        },
      ),
      registerFileSystemProvider: vi.fn(
        (
          scheme: string,
          provider: unknown,
          options: { isCaseSensitive?: boolean; isReadonly?: boolean },
        ) => {
          const registration = {
            scheme,
            provider,
            options,
            disposed: false,
          };
          mockDisposableState.fileSystemProviderRegistrations.push(
            registration,
          );
          return new MockDisposable(() => {
            registration.disposed = true;
          });
        },
      ),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, defaultValue: boolean) => defaultValue),
      })),
    },
    extensions: { onDidChange: vi.fn(disposable) },
    languages: {
      registerHoverProvider: vi.fn(() => new MockDisposable()),
      registerCodeLensProvider: vi.fn(() => new MockDisposable()),
    },
    authentication: {
      getSession: vi.fn(() => Promise.resolve(undefined)),
      onDidChangeSessions: vi.fn(authenticationSessionEventEmitter.event),
    },
  };
});

import { activateGitoExtension } from "../../src/extension/activateGitoExtension.js";
import { calculateP95Milliseconds } from "./fixtures/largeRepositoryFixtures.js";

const activationSampleCount = 15;
const activationP95BudgetMilliseconds = 50;

describe("extension activation performance", () => {
  it("keeps repeated source activation samples within the p95 budget", () => {
    const extensionContext = {
      extensionUri: { fsPath: "/performance/extension" },
      subscriptions: [] as { dispose(): void }[],
      globalState: {
        get: <Value>(_key: string, defaultValue?: Value): Value | undefined =>
          defaultValue,
        update: (): Promise<void> => Promise.resolve(),
      },
      workspaceState: {
        get: <Value>(_key: string, defaultValue?: Value): Value | undefined =>
          defaultValue,
        update: (): Promise<void> => Promise.resolve(),
        keys: (): readonly string[] => [],
      },
    };

    // Warm the module/runtime once; the measured samples represent activation work.
    activateGitoExtension(extensionContext as never);
    expect(mockDisposableState.closeDocumentEventRegistrationCount).toBe(1);
    expect(mockDisposableState.activeAuthenticationSessionListenerCount).toBe(
      1,
    );
    expect(mockDisposableState.activeWindowStateListenerCount).toBe(1);
    expect(mockDisposableState.contentProviderRegistrations).toHaveLength(1);
    expect(mockDisposableState.fileSystemProviderRegistrations).toHaveLength(2);
    const warmSymlinkProviderRegistration =
      mockDisposableState.fileSystemProviderRegistrations.find(
        ({ scheme }) => scheme === "gito-symlink",
      );
    if (warmSymlinkProviderRegistration === undefined)
      throw new Error("symlink provider registration was not created");
    expect(typeof warmSymlinkProviderRegistration.provider).toBe("object");
    expect(warmSymlinkProviderRegistration).toMatchObject({
      scheme: "gito-symlink",
      options: { isCaseSensitive: true, isReadonly: true },
      disposed: false,
    });
    const warmActivationSubscriptionCount =
      extensionContext.subscriptions.length;
    const warmNonActivationDisposableCount =
      mockDisposableState.activeCount - warmActivationSubscriptionCount;
    // Provider registrations created during composition are not subscriptions;
    // activation disposal must still release them completely.
    expect(warmNonActivationDisposableCount).toBeGreaterThanOrEqual(2);
    disposeActivationSubscriptions(extensionContext);
    expect(mockDisposableState.activeAuthenticationSessionListenerCount).toBe(
      0,
    );
    expect(mockDisposableState.activeWindowStateListenerCount).toBe(0);
    const persistentDisposableCount = mockDisposableState.activeCount;
    expect(warmSymlinkProviderRegistration.disposed).toBe(true);
    const perActivationNonSubscriptionDisposableCount =
      warmNonActivationDisposableCount - persistentDisposableCount;
    const elapsedMilliseconds: number[] = [];
    let expectedSubscriptionCount: number | undefined;
    try {
      for (
        let sampleIndex = 0;
        sampleIndex < activationSampleCount;
        sampleIndex++
      ) {
        const activationStartTime = performance.now();
        const activationReturnValue = activateGitoExtension(
          extensionContext as never,
        );
        elapsedMilliseconds.push(performance.now() - activationStartTime);
        expect(activationReturnValue).toBeUndefined();
        expect(mockDisposableState.closeDocumentEventRegistrationCount).toBe(
          sampleIndex + 2,
        );
        expect(
          mockDisposableState.activeAuthenticationSessionListenerCount,
        ).toBe(1);
        expect(mockDisposableState.activeWindowStateListenerCount).toBe(1);
        expect(mockDisposableState.contentProviderRegistrations).toHaveLength(
          sampleIndex + 2,
        );
        expect(
          mockDisposableState.fileSystemProviderRegistrations,
        ).toHaveLength((sampleIndex + 2) * 2);
        const symlinkProviderRegistration =
          mockDisposableState.fileSystemProviderRegistrations
            .slice(-2)
            .find(({ scheme }) => scheme === "gito-symlink");
        if (symlinkProviderRegistration === undefined)
          throw new Error("symlink provider registration was not created");
        expect(typeof symlinkProviderRegistration.provider).toBe("object");
        expect(symlinkProviderRegistration).toMatchObject({
          scheme: "gito-symlink",
          options: { isCaseSensitive: true, isReadonly: true },
          disposed: false,
        });
        expect(extensionContext.subscriptions.length).toBeGreaterThan(0);
        expectedSubscriptionCount ??= extensionContext.subscriptions.length;
        expect(extensionContext.subscriptions.length).toBe(
          expectedSubscriptionCount,
        );
        expect(mockDisposableState.activeCount).toBe(
          persistentDisposableCount +
            extensionContext.subscriptions.length +
            perActivationNonSubscriptionDisposableCount,
        );
        disposeActivationSubscriptions(
          extensionContext,
          persistentDisposableCount,
        );
        expect(
          mockDisposableState.activeAuthenticationSessionListenerCount,
        ).toBe(0);
        expect(mockDisposableState.activeWindowStateListenerCount).toBe(0);
        expect(symlinkProviderRegistration?.disposed).toBe(true);
      }
    } finally {
      disposeActivationSubscriptions(
        extensionContext,
        persistentDisposableCount,
      );
    }

    const activationP95Milliseconds =
      calculateP95Milliseconds(elapsedMilliseconds);
    expect(activationP95Milliseconds).toBeLessThanOrEqual(
      activationP95BudgetMilliseconds,
    );
  });
});

function disposeActivationSubscriptions(
  extensionContext: {
    subscriptions: { dispose(): void }[];
  },
  expectedRemainingDisposableCount?: number,
): void {
  for (const disposable of extensionContext.subscriptions) disposable.dispose();
  extensionContext.subscriptions = [];
  if (expectedRemainingDisposableCount !== undefined)
    expect(mockDisposableState.activeCount).toBe(
      expectedRemainingDisposableCount,
    );
}
