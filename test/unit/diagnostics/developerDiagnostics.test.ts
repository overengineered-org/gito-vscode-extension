// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsTestState = vi.hoisted(() => {
  class Disposable {
    private disposed = false;
    public constructor(
      private readonly disposeCallback: () => void = () => {},
    ) {}
    public dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.disposeCallback();
    }
  }

  const configurationListeners = new Set<
    (event: { affectsConfiguration(settingKey: string): boolean }) => void
  >();
  return {
    Disposable,
    configurationListeners,
    commandHandlers: new Map<string, () => unknown>(),
    enabled: false,
    appendedLines: [] as string[],
    createOutputChannelArguments: [] as unknown[][],
    outputChannelDisposed: 0,
    outputChannelShown: 0,
    throwOnAppend: false,
  };
});

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  commands: {
    registerCommand: (
      commandIdentifier: string,
      commandHandler: () => unknown,
    ) => {
      diagnosticsTestState.commandHandlers.set(
        commandIdentifier,
        commandHandler,
      );
      return new diagnosticsTestState.Disposable(() =>
        diagnosticsTestState.commandHandlers.delete(commandIdentifier),
      );
    },
  },
  window: {
    createOutputChannel: (...argumentsPassed: unknown[]) => {
      diagnosticsTestState.createOutputChannelArguments.push(argumentsPassed);
      return {
        appendLine: (message: string) => {
          if (diagnosticsTestState.throwOnAppend)
            throw new Error("output channel unavailable");
          diagnosticsTestState.appendedLines.push(message);
        },
        show: () => {
          diagnosticsTestState.outputChannelShown += 1;
        },
        dispose: () => {
          diagnosticsTestState.outputChannelDisposed += 1;
        },
      };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (_settingKey: string, defaultValue: boolean) =>
        diagnosticsTestState.enabled ?? defaultValue,
      update: (settingKey: string, enabled: boolean) => {
        diagnosticsTestState.enabled = enabled;
        for (const listener of diagnosticsTestState.configurationListeners)
          listener({
            affectsConfiguration: (changedSettingKey) =>
              changedSettingKey === settingKey,
          });
        return Promise.resolve();
      },
    }),
    onDidChangeConfiguration: (
      listener: (event: {
        affectsConfiguration(settingKey: string): boolean;
      }) => void,
    ) => {
      diagnosticsTestState.configurationListeners.add(listener);
      return new diagnosticsTestState.Disposable(() =>
        diagnosticsTestState.configurationListeners.delete(listener),
      );
    },
  },
}));

import {
  DeveloperDiagnostics,
  developerDiagnosticsCommandIds,
} from "../../../src/extension/diagnostics/developerDiagnostics.js";

describe("DeveloperDiagnostics", () => {
  beforeEach(() => {
    diagnosticsTestState.configurationListeners.clear();
    diagnosticsTestState.commandHandlers.clear();
    diagnosticsTestState.enabled = false;
    diagnosticsTestState.appendedLines.length = 0;
    diagnosticsTestState.createOutputChannelArguments.length = 0;
    diagnosticsTestState.outputChannelDisposed = 0;
    diagnosticsTestState.outputChannelShown = 0;
    diagnosticsTestState.throwOnAppend = false;
  });

  it("stays silent by default and toggles only the user-level setting", async () => {
    const diagnostics = new DeveloperDiagnostics();
    diagnostics.record("repository.state.changed");
    expect(diagnosticsTestState.appendedLines).toEqual([]);

    await diagnosticsTestState.commandHandlers.get(
      developerDiagnosticsCommandIds.toggle,
    )?.();
    expect(diagnosticsTestState.enabled).toBe(true);
    expect(diagnosticsTestState.outputChannelShown).toBe(1);
    expect(diagnosticsTestState.appendedLines).toEqual([
      "diagnostics.state outcome=enabled",
    ]);

    diagnostics.record("repository.state.changed");
    expect(diagnosticsTestState.appendedLines.at(-1)).toBe(
      "repository.state.changed",
    );
    diagnostics.dispose();
  });

  it("records fixed outcomes and durations without error details", async () => {
    diagnosticsTestState.enabled = true;
    let monotonicMilliseconds = 0;
    vi.spyOn(performance, "now").mockImplementation(
      () => (monotonicMilliseconds += 300),
    );
    const diagnostics = new DeveloperDiagnostics();

    await diagnostics.traceOperation("dashboard.refresh.repository-state", () =>
      Promise.resolve("complete"),
    );
    await expect(
      diagnostics.traceOperation("dashboard.refresh.repository-state", () =>
        Promise.reject(new Error("token ghp_private /private/repository")),
      ),
    ).rejects.toThrow("token ghp_private");
    await expect(
      diagnostics.traceOperation("dashboard.refresh.repository-state", () =>
        Promise.reject(
          new DOMException("cancelled private path", "AbortError"),
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const serializedDiagnostics = diagnosticsTestState.appendedLines.join("\n");
    expect(serializedDiagnostics).toMatch(/outcome=completed durationMs=\d+/u);
    expect(serializedDiagnostics).toMatch(/outcome=failed durationMs=\d+/u);
    expect(serializedDiagnostics).toMatch(/outcome=cancelled durationMs=\d+/u);
    expect(serializedDiagnostics).not.toMatch(
      /ghp_private|private\/repository|cancelled private path/u,
    );
    diagnostics.dispose();
  });

  it("never changes product behavior when the output channel fails", async () => {
    diagnosticsTestState.enabled = true;
    diagnosticsTestState.throwOnAppend = true;
    const diagnostics = new DeveloperDiagnostics();

    await expect(
      diagnostics.traceOperation("dashboard.refresh.repository-state", () =>
        Promise.resolve(42),
      ),
    ).resolves.toBe(42);
    expect(() => diagnostics.record("repository.state.changed")).not.toThrow();
    diagnostics.dispose();
  });

  it("uses an unfiltered channel and rejects unsafe runtime input", () => {
    diagnosticsTestState.enabled = true;
    const diagnostics = new DeveloperDiagnostics();

    diagnostics.record("dynamic /private/path ghp_secret" as never, {
      outcome: "unsafe-token" as never,
      durationMilliseconds: Number.NaN,
    });
    diagnostics.record("dashboard.refresh.repository-state", {
      outcome: "unsafe-token" as never,
      durationMilliseconds: Number.NaN,
    });
    expect(() =>
      diagnostics.record("repository.state.changed", null as never),
    ).not.toThrow();

    expect(diagnosticsTestState.createOutputChannelArguments).toEqual([
      ["Git'o Diagnostics"],
    ]);
    expect(diagnosticsTestState.appendedLines).toEqual([
      "dashboard.refresh.repository-state",
    ]);
    diagnostics.dispose();
  });

  it("coalesces repeated events and reports the suppressed count", () => {
    diagnosticsTestState.enabled = true;
    let monotonicMilliseconds = 0;
    vi.spyOn(performance, "now").mockImplementation(
      () => monotonicMilliseconds,
    );
    const diagnostics = new DeveloperDiagnostics();

    diagnostics.record("repository.state.changed");
    monotonicMilliseconds = 10;
    diagnostics.record("repository.state.changed");
    monotonicMilliseconds = 300;
    diagnostics.record("repository.state.changed");

    expect(diagnosticsTestState.appendedLines).toEqual([
      "repository.state.changed",
      "repository.state.changed suppressed=1",
    ]);
    diagnostics.dispose();
  });

  it("disposes its listener, commands, and output channel once", () => {
    const diagnostics = new DeveloperDiagnostics();
    diagnostics.dispose();
    diagnostics.dispose();

    expect(diagnosticsTestState.configurationListeners.size).toBe(0);
    expect(diagnosticsTestState.commandHandlers.size).toBe(0);
    expect(diagnosticsTestState.outputChannelDisposed).toBe(1);
  });
});
