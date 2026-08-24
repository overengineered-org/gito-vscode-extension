import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const vscodeMocks = vi.hoisted(() => ({
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  withProgress: vi.fn<typeof vscode.window.withProgress>(),
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  window: vscodeMocks,
}));

import { pickDiffSource } from "../../../src/extension/diffExperience/diffSourcePicker.js";

const repositoryRoot = {
  fsPath: "/repo",
  toString: () => "file:/repo",
} as never;

describe("diff source picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads revisions in cancellable progress before opening the picker", async () => {
    const listGitRevisions = vi.fn(() => Promise.resolve(["main", "0123456"]));
    vscodeMocks.withProgress.mockImplementationOnce((_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: vi.fn() }),
        },
      ),
    );
    vscodeMocks.showQuickPick.mockResolvedValueOnce({
      label: "HEAD",
      sourceKind: "revision-choice",
      revision: "HEAD",
    });

    const source = await pickDiffSource(
      { gitDiffService: { listGitRevisions } },
      {
        repositoryRoot,
        prompt: "Choose the source",
        placeHolder: "Source",
      },
    );

    expect(vscodeMocks.withProgress).toHaveBeenCalledWith(
      {
        location: 15,
        title: "Loading Git revisions",
        cancellable: true,
      },
      expect.any(Function),
    );
    expect(listGitRevisions).toHaveBeenCalledWith(
      repositoryRoot,
      expect.any(AbortSignal),
      undefined,
    );
    expect(
      vscodeMocks.showQuickPick.mock.invocationCallOrder[0],
    ).toBeGreaterThan(vscodeMocks.withProgress.mock.invocationCallOrder[0]!);
    expect(source).toMatchObject({ kind: "revision", revision: "HEAD" });
  });

  it("propagates progress cancellation and does not open stale choices", async () => {
    let cancellationListener: (() => void) | undefined;
    let receivedCancellationSignal: AbortSignal | undefined;
    const listGitRevisions = vi.fn(
      (_repositoryRoot: unknown, cancellationSignal?: AbortSignal) => {
        receivedCancellationSignal = cancellationSignal;
        return new Promise<readonly string[]>((_resolve, reject) => {
          cancellationSignal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        });
      },
    );
    vscodeMocks.withProgress.mockImplementationOnce((_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: (listener) => {
            cancellationListener = () => {
              listener(undefined);
            };
            return { dispose: vi.fn() };
          },
        },
      ),
    );

    const pickPromise = pickDiffSource(
      { gitDiffService: { listGitRevisions } },
      {
        repositoryRoot,
        prompt: "Choose the source",
        placeHolder: "Source",
      },
    );
    await vi.waitFor(() => expect(receivedCancellationSignal).toBeDefined());
    cancellationListener?.();

    await expect(pickPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(vscodeMocks.showQuickPick).not.toHaveBeenCalled();
    expect(receivedCancellationSignal?.aborted).toBe(true);
  });
});
