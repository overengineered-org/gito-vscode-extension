import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  CompareExperience,
  compareExperienceCommandIds,
  type CompareExperienceServices,
  type CompareExperienceUi,
} from "../../../src/extension/compareExperience/index.js";
import type { CompareResult } from "../../../src/extension/compare/compareModels.js";
import type { CompareRepositoryBinding } from "../../../src/extension/compare/compareService.js";

type CancellationListener = Parameters<
  vscode.CancellationToken["onCancellationRequested"]
>[0];

function testUri(path: string): vscode.Uri {
  const uri: vscode.Uri = {
    scheme: "file",
    authority: "",
    path,
    query: "",
    fragment: "",
    fsPath: path,
    with(change) {
      return testUri(change.path ?? path);
    },
    toString() {
      return `file://${path}`;
    },
    toJSON() {
      return { scheme: "file", path };
    },
  };
  return uri;
}

class MemoryWorkspaceState {
  public readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

function createResult(): CompareResult {
  return {
    repositoryRoot: testUri("/repo"),
    mode: "common-base",
    left: { target: { kind: "ref", ref: "left" }, commitSha: "a" },
    right: { target: { kind: "ref", ref: "right" }, commitSha: "b" },
    commonBaseSha: "base",
    aheadCount: 1,
    behindCount: 2,
    aheadCommits: [],
    behindCommits: [],
    files: [],
    fileCounts: {
      total: 0,
      added: 0,
      deleted: 0,
      modified: 0,
      renamed: 0,
      copied: 0,
      typeChanged: 0,
      unmerged: 0,
      binary: 0,
      additions: 0,
      deletions: 0,
    },
    multiDiffPlan: {
      command: "vscode.changes",
      title: "compare",
      resources: [],
    },
    truncated: false,
  };
}

function createUi(): CompareExperienceUi {
  return {
    showQuickPick<T extends vscode.QuickPickItem>(): Promise<T | undefined> {
      return Promise.resolve(undefined);
    },
    showInputBox(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    showInformationMessage(): Promise<unknown> {
      return Promise.resolve(undefined);
    },
    showWarningMessage(): Promise<unknown> {
      return Promise.resolve(undefined);
    },
  };
}

function createServices(
  workspaceState: MemoryWorkspaceState,
  compare: CompareExperienceServices["compareService"]["compare"],
  executeCommand: (...argumentsPassed: readonly unknown[]) => Promise<unknown>,
  getMutableStateFingerprint?: CompareExperienceServices["compareService"]["getMutableStateFingerprint"],
  ui: CompareExperienceUi = createUi(),
): CompareExperienceServices {
  const canonicalRepositoryPath = process.cwd();
  const repositoryBinding: CompareRepositoryBinding = {
    requestedPath: "/repo",
    canonicalPath: canonicalRepositoryPath,
    filesystemIdentity: { device: 1n, inode: 1n },
    rootBinding: {
      canonicalPath: canonicalRepositoryPath,
      device: "1",
      inode: "1",
      gitDirectory: {
        canonicalPath: `${canonicalRepositoryPath}/.git`,
        device: "1",
        inode: "2",
      },
      commonDirectory: {
        canonicalPath: `${canonicalRepositoryPath}/.git`,
        device: "1",
        inode: "2",
      },
    },
  };
  const compareService = {
    canonicalRepositoryPath,
    compare,
    pinRepositoryBinding: vi.fn(() => Promise.resolve(repositoryBinding)),
    assertRepositoryBinding: vi.fn(() =>
      Promise.resolve(testUri(canonicalRepositoryPath)),
    ),
    assertPinnedRepositoryRoot(): Promise<string> {
      return Promise.resolve(this.canonicalRepositoryPath);
    },
    getMutableStateFingerprint:
      getMutableStateFingerprint ?? vi.fn(() => Promise.resolve("stable")),
  };
  return {
    repositoryDiscovery: {
      selectRepository: () =>
        Promise.reject(new Error("repository selection not used in this test")),
    },
    compareService,
    searchService: { search: vi.fn() },
    gitCommandRunner: {
      run: vi.fn(() =>
        Promise.resolve({
          standardOutput: ".git\n",
          standardError: "",
          exitCode: 0,
        }),
      ),
    },
    workspaceState,
    ui,
    commandExecutor: { executeCommand },
  };
}

describe("premium compare experience controller", () => {
  it("registers only entrypoint and active-session action commands", () => {
    const registeredCommandIds: string[] = [];
    const experience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(() => Promise.resolve(createResult())),
        () => Promise.resolve(undefined),
      ),
    );
    experience.registerCommands({
      registerCommand(commandIdentifier) {
        registeredCommandIds.push(commandIdentifier);
        return { dispose: () => undefined };
      },
    });
    expect(registeredCommandIds).toEqual([
      compareExperienceCommandIds.open,
      compareExperienceCommandIds.search,
      compareExperienceCommandIds.actions,
      compareExperienceCommandIds.recent,
    ]);
  });

  it("stores workspace-local checklist/recent state and opens public changes", async () => {
    const workspaceState = new MemoryWorkspaceState();
    const executedCommands: unknown[][] = [];
    const experience = new CompareExperience(
      createServices(
        workspaceState,
        vi.fn(() => Promise.resolve(createResult())),
        (...argumentsPassed) => {
          executedCommands.push([...argumentsPassed]);
          return Promise.resolve(undefined);
        },
      ),
    );
    const result = await experience.compare({
      repositoryRoot: testUri("/repo"),
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "common-base",
    });
    expect(result?.commonBaseSha).toBe("base");
    expect(
      executedCommands.find(
        (argumentsPassed) => argumentsPassed[0] === "vscode.changes",
      )?.[0],
    ).toBe("vscode.changes");
    expect(
      executedCommands.some(
        (argumentsPassed) =>
          argumentsPassed[0] === "setContext" &&
          argumentsPassed[1] === "gito.compare.sessionActive" &&
          argumentsPassed[2] === true,
      ),
    ).toBe(true);
    expect(experience.getRecentComparisons()).toHaveLength(1);
    expect(experience.getReviewChecklist()).toEqual({
      checkedItemIds: [],
      notes: "",
    });
    await experience.setReviewChecklistNotes("Review follow-up");
    expect(experience.getReviewChecklist()?.notes).toBe("Review follow-up");
    await experience.setReviewChecklistItem("files-reviewed", true);
    expect(experience.getReviewChecklist()?.checkedItemIds).toEqual([
      "files-reviewed",
    ]);
    await experience.resetReviewChecklist();
    expect(experience.getReviewChecklist()).toEqual({
      checkedItemIds: [],
      notes: "",
    });
    await experience.swapSides();
    expect(
      executedCommands.filter(
        (argumentsPassed) => argumentsPassed[0] === "vscode.changes",
      ),
    ).toHaveLength(2);
    expect(experience.getSession()?.swapped).toBe(true);
  });

  it("blocks open-all after the mutable comparison fingerprint changes", async () => {
    const workspaceState = new MemoryWorkspaceState();
    const executedCommands: unknown[][] = [];
    let mutableStateFingerprint = "before";
    const experience = new CompareExperience(
      createServices(
        workspaceState,
        vi.fn(() => Promise.resolve(createResult())),
        (...argumentsPassed) => {
          executedCommands.push([...argumentsPassed]);
          return Promise.resolve(undefined);
        },
        vi.fn(() => Promise.resolve(mutableStateFingerprint)),
      ),
    );

    await experience.compare({
      repositoryRoot: testUri("/repo"),
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "common-base",
    });
    mutableStateFingerprint = "after";
    await experience.openAll();

    expect(
      executedCommands.filter(
        (argumentsPassed) => argumentsPassed[0] === "vscode.changes",
      ),
    ).toHaveLength(1);
    experience.dispose();
  });

  it("cancels an in-flight compare and propagates a stale-repository error", async () => {
    const workspaceState = new MemoryWorkspaceState();
    let cancellationSignal: AbortSignal | undefined;
    const cancellationCompare = vi.fn(
      ({
        cancellationSignal: signal,
      }: {
        cancellationSignal?: AbortSignal;
      }) => {
        cancellationSignal = signal;
        return new Promise<CompareResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        });
      },
    );
    const experience = new CompareExperience(
      createServices(workspaceState, cancellationCompare, () =>
        Promise.resolve(undefined),
      ),
    );
    const comparePromise = experience.compare({
      repositoryRoot: testUri("/stale-repo"),
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "direct",
    });
    await vi.waitFor(() => expect(cancellationSignal).toBeDefined());
    experience.cancelActiveOperation();
    await expect(comparePromise).resolves.toBeUndefined();

    const staleError = new Error(
      "Compare request is bound to a different Git repository.",
    );
    const staleExperience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(() => Promise.reject(staleError)),
        () => Promise.resolve(undefined),
      ),
    );
    await expect(
      staleExperience.compare({
        repositoryRoot: testUri("/stale-repo"),
        left: { kind: "ref", ref: "left" },
        right: { kind: "ref", ref: "right" },
        mode: "direct",
      }),
    ).rejects.toThrow("different Git repository");
  });

  it("aborts compare when progress is already cancelled", async () => {
    let receivedSignal: AbortSignal | undefined;
    const cancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } satisfies vscode.CancellationToken;
    const experience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(
          ({
            cancellationSignal,
          }: Parameters<
            CompareExperienceServices["compareService"]["compare"]
          >[0]) => {
            receivedSignal = cancellationSignal;
            return Promise.reject(new DOMException("cancelled", "AbortError"));
          },
        ),
        () => Promise.resolve(undefined),
        undefined,
        {
          ...createUi(),
          withProgress: (_options, task) =>
            task({ report: () => undefined }, cancellationToken),
        },
      ),
    );

    await expect(
      experience.compare({
        repositoryRoot: testUri("/cancelled"),
        left: { kind: "ref", ref: "left" },
        right: { kind: "ref", ref: "right" },
        mode: "direct",
      }),
    ).resolves.toBeUndefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("propagates later progress cancellation to the compare operation", async () => {
    let requestCancellation: CancellationListener | undefined;
    let receivedSignal: AbortSignal | undefined;
    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: CancellationListener) => {
        requestCancellation = listener;
        return { dispose: () => undefined };
      },
    } satisfies vscode.CancellationToken;
    const experience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(
          ({
            cancellationSignal,
          }: Parameters<
            CompareExperienceServices["compareService"]["compare"]
          >[0]) =>
            new Promise<CompareResult>((_resolve, reject) => {
              receivedSignal = cancellationSignal;
              cancellationSignal?.addEventListener("abort", () =>
                reject(new DOMException("cancelled", "AbortError")),
              );
            }),
        ),
        () => Promise.resolve(undefined),
        undefined,
        {
          ...createUi(),
          withProgress: (_options, task) =>
            task({ report: () => undefined }, cancellationToken),
        },
      ),
    );

    const comparePromise = experience.compare({
      repositoryRoot: testUri("/later-cancelled"),
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "direct",
    });
    await vi.waitFor(() => expect(requestCancellation).toBeDefined());
    requestCancellation?.(undefined);
    await expect(comparePromise).resolves.toBeUndefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("serializes context updates and preserves the final command-palette state", async () => {
    const contextCalls: unknown[][] = [];
    let releaseFirstContextUpdate: (() => void) | undefined;
    const executeCommand = vi.fn(
      (...argumentsPassed: readonly unknown[]): Promise<unknown> => {
        contextCalls.push([...argumentsPassed]);
        if (
          argumentsPassed[0] === "setContext" &&
          contextCalls.filter((call) => call[0] === "setContext").length === 1
        ) {
          return new Promise<void>((resolve) => {
            releaseFirstContextUpdate = resolve;
          });
        }
        return Promise.resolve(undefined);
      },
    );
    const experience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(() => Promise.resolve(createResult())),
        executeCommand,
      ),
    );

    const comparePromise = experience.compare({
      repositoryRoot: testUri("/repo"),
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "direct",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(releaseFirstContextUpdate).toBeDefined();
    releaseFirstContextUpdate?.();
    await comparePromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const contextStates = contextCalls
      .filter((call) => call[0] === "setContext")
      .map((call) => [call[1], call[2]]);
    expect(contextStates).toContainEqual(["gito.compare.sessionActive", true]);
    expect(contextStates.at(-1)).toEqual([
      "gito.compare.operationActive",
      false,
    ]);
  });

  it("stops public fallback when its compare operation is cancelled or disposed", async () => {
    const workspaceState = new MemoryWorkspaceState();
    const cancellationController = new AbortController();
    const cancellationCalls: string[] = [];
    const cancellationExperience = new CompareExperience(
      createServices(
        workspaceState,
        vi.fn(() => Promise.resolve(createResult())),
        (commandIdentifier) => {
          cancellationCalls.push(String(commandIdentifier));
          if (commandIdentifier === "vscode.changes")
            return Promise.reject(new Error("changes command unavailable"));
          cancellationController.abort();
          return Promise.resolve(undefined);
        },
      ),
    );
    const openPlan = {
      command: "vscode.changes",
      title: "compare",
      arguments: [
        "compare",
        [
          [
            testUri("/repo/one.txt"),
            testUri("/repo/one-old.txt"),
            testUri("/repo/one-new.txt"),
          ],
          [
            testUri("/repo/two.txt"),
            testUri("/repo/two-old.txt"),
            testUri("/repo/two-new.txt"),
          ],
        ],
      ],
    };
    const cancellationPrivateExperience = cancellationExperience as unknown as {
      executeOpenPlan: (
        plan: unknown,
        operationController: AbortController,
      ) => Promise<void>;
    };
    await cancellationPrivateExperience.executeOpenPlan(
      openPlan,
      cancellationController,
    );
    expect(
      cancellationCalls.filter(
        (command) =>
          command.startsWith("vscode.") || command.startsWith("_workbench."),
      ),
    ).toEqual(["vscode.changes", "vscode.diff"]);

    const disposalCalls: string[] = [];
    const disposalExperience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(() => Promise.resolve(createResult())),
        (command) => {
          disposalCalls.push(String(command));
          if (command === "vscode.changes")
            return Promise.reject(new Error("changes command unavailable"));
          disposalExperience.dispose();
          return Promise.resolve(undefined);
        },
      ),
    );
    const disposalPrivateExperience = disposalExperience as unknown as {
      executeOpenPlan: (plan: unknown) => Promise<void>;
    };
    await disposalPrivateExperience.executeOpenPlan(openPlan);
    expect(
      disposalCalls.filter(
        (command) =>
          command.startsWith("vscode.") || command.startsWith("_workbench."),
      ),
    ).toEqual(["vscode.changes", "vscode.diff"]);
  });

  it("opens one-sided compare resources with the public open command", async () => {
    const executedCommands: string[] = [];
    const experience = new CompareExperience(
      createServices(
        new MemoryWorkspaceState(),
        vi.fn(() => Promise.resolve(createResult())),
        (commandIdentifier) => {
          executedCommands.push(String(commandIdentifier));
          return commandIdentifier === "vscode.changes"
            ? Promise.reject(new Error("changes unavailable"))
            : Promise.resolve(undefined);
        },
      ),
    );
    const privateExperience = experience as unknown as {
      executeOpenPlan: (plan: unknown) => Promise<void>;
    };

    await privateExperience.executeOpenPlan({
      command: "vscode.changes",
      title: "compare",
      arguments: [
        "compare",
        [[testUri("/repo/added.txt"), undefined, testUri("/repo/added.txt")]],
      ],
    });

    expect(executedCommands).toEqual(["vscode.changes", "vscode.open"]);
    experience.dispose();
  });

  it("shows cancellable progress while enumerating commit search results", async () => {
    let receivedCancellationSignal: AbortSignal | undefined;
    const searchPage = {
      pageIndex: 0,
      pageSize: 50,
      totalMatches: 1,
      hasMore: false,
      nextPageIndex: undefined,
      documents: [],
      truncated: false,
    } as never;
    const searchService = vi.fn(
      (
        _repositoryRoot: vscode.Uri,
        _source: string,
        options: { readonly cancellationSignal?: AbortSignal },
      ) => {
        receivedCancellationSignal = options.cancellationSignal;
        return Promise.resolve(searchPage);
      },
    );
    const withProgressInvocation = vi.fn();
    const ui: CompareExperienceUi = {
      ...createUi(),
      withProgress<Result>(
        options: vscode.ProgressOptions,
        task: (
          progress: vscode.Progress<{
            readonly message?: string;
            readonly increment?: number;
          }>,
          token: vscode.CancellationToken,
        ) => Thenable<Result> | Promise<Result>,
      ): Thenable<Result> {
        withProgressInvocation(options, task);
        return task(
          { report: vi.fn() },
          {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: vi.fn() }),
          },
        );
      },
    };
    const services = createServices(
      new MemoryWorkspaceState(),
      vi.fn(() => Promise.resolve(createResult())),
      () => Promise.resolve(undefined),
      undefined,
      ui,
    );
    services.searchService.search = searchService;

    const result = await new CompareExperience(services).search(
      testUri("/repo"),
      "message:fix",
    );

    expect(result).toBe(searchPage);
    expect(withProgressInvocation).toHaveBeenCalledWith(
      {
        location: 15,
        title: "Searching commits",
        cancellable: true,
      },
      expect.any(Function),
    );
    expect(receivedCancellationSignal).toBeInstanceOf(AbortSignal);
  });
});
