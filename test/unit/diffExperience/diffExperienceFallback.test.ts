import { describe, expect, it, vi } from "vitest";

const lifecycleMock = vi.hoisted(() => ({
  cancelProgress: false,
  informationMessageCompletion: undefined as Promise<unknown> | undefined,
}));

function createTestFileUri(filePath: string) {
  return {
    scheme: "file",
    fsPath: filePath,
    path: filePath,
    query: "",
    fragment: "",
    with: (changes: { path: string; query: string; fragment: string }) =>
      createTestFileUri(changes.path),
  };
}

vi.mock("vscode", () => ({
  commands: {},
  window: {
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    showInformationMessage: vi.fn(
      () =>
        lifecycleMock.informationMessageCompletion ??
        Promise.resolve(undefined),
    ),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    withProgress: vi.fn(
      (
        _options: unknown,
        operation: (
          progress: unknown,
          cancellationToken: {
            isCancellationRequested: boolean;
            onCancellationRequested: () => { dispose: () => void };
          },
        ) => Promise<unknown>,
      ) =>
        operation(
          {},
          {
            isCancellationRequested: lifecycleMock.cancelProgress,
            onCancellationRequested: () => ({ dispose: () => undefined }),
          },
        ),
    ),
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: vi.fn() }),
    registerFileSystemProvider: () => ({ dispose: vi.fn() }),
  },
  ProgressLocation: { Notification: 15 },
  Uri: {
    file: (fsPath: string) => ({ scheme: "file", fsPath }),
  },
}));

import { DiffExperience } from "../../../src/extension/diffExperience/diffExperience.js";

const symlinkUriProvider = {
  provideTextDocumentContent: () => "",
  beginSession: vi.fn(),
  empty: vi.fn(),
  symlink: vi.fn(),
  dispose: vi.fn(),
} as never;

describe("diff experience native editor lifecycle", () => {
  it("does not await the native editor tab lifetime after dispatch", async () => {
    const commandCompletion = new Promise<void>(() => undefined);
    const commandExecutor = {
      executeCommand: vi.fn(() => commandCompletion),
    };
    const experience = new DiffExperience({
      repositoryDiscovery: { selectRepository: vi.fn() },
      gitCommandRunner: { run: vi.fn() },
      gitDiffService: {} as never,
      workspaceState: {} as never,
      symlinkUriProvider,
      commandExecutor,
    });
    const experienceWithPrivateOpen = experience as unknown as {
      executeOpenPlan: (openPlan: unknown) => Promise<void>;
    };

    const openPromise = experienceWithPrivateOpen.executeOpenPlan({
      command: "vscode.changes",
      arguments: ["Repository diff", []],
    });

    expect(commandExecutor.executeCommand).toHaveBeenCalledWith(
      "vscode.changes",
      "Repository diff",
      [],
    );
    await expect(openPromise).resolves.toBe(true);
    experience.dispose();
  });

  it("keeps a successful changes open to one command", async () => {
    const commandExecutor = {
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    };
    const experience = new DiffExperience({
      repositoryDiscovery: { selectRepository: vi.fn() },
      gitCommandRunner: { run: vi.fn() },
      gitDiffService: {} as never,
      workspaceState: {} as never,
      symlinkUriProvider,
      commandExecutor,
    });
    const experienceWithPrivateOpen = experience as unknown as {
      executeOpenPlan: (openPlan: unknown) => Promise<void>;
    };

    await experienceWithPrivateOpen.executeOpenPlan({
      command: "vscode.changes",
      arguments: [
        "Repository diff",
        [
          [
            { path: "/repo/one.txt" },
            { fsPath: "/repo/one-old.txt" },
            { fsPath: "/repo/one-new.txt" },
          ],
          [
            { path: "/repo/two.txt" },
            { fsPath: "/repo/two-old.txt" },
            { fsPath: "/repo/two-new.txt" },
          ],
        ],
      ],
    });

    expect(commandExecutor.executeCommand).toHaveBeenCalledTimes(1);
    expect(commandExecutor.executeCommand).toHaveBeenCalledWith(
      "vscode.changes",
      "Repository diff",
      expect.any(Array),
    );
    experience.dispose();
  });

  it("falls back to public single-file commands when changes is unavailable", async () => {
    const commandExecutor = {
      executeCommand: vi.fn((commandIdentifier: string) =>
        commandIdentifier === "vscode.changes"
          ? Promise.reject(new Error("changes unavailable"))
          : Promise.resolve(undefined),
      ),
    };
    const experience = new DiffExperience({
      repositoryDiscovery: { selectRepository: vi.fn() },
      gitCommandRunner: { run: vi.fn() },
      gitDiffService: {} as never,
      workspaceState: {} as never,
      symlinkUriProvider,
      commandExecutor,
    });
    const experienceWithPrivateOpen = experience as unknown as {
      executeOpenPlan: (openPlan: unknown) => Promise<void>;
    };

    await experienceWithPrivateOpen.executeOpenPlan({
      command: "vscode.changes",
      arguments: [
        "Repository diff",
        [
          [
            { path: "/repo/one.txt" },
            { fsPath: "/repo/one-old.txt" },
            { fsPath: "/repo/one-new.txt" },
          ],
          [{ path: "/repo/two.txt" }, undefined, { fsPath: "/repo/two.txt" }],
        ],
      ],
    });
    await vi.waitFor(() =>
      expect(commandExecutor.executeCommand).toHaveBeenCalledTimes(3),
    );

    expect(
      commandExecutor.executeCommand.mock.calls.map(
        (commandCall) => commandCall[0],
      ),
    ).toEqual(["vscode.changes", "vscode.diff", "vscode.open"]);
    experience.dispose();
  });

  it("blocks navigation when the mutable diff fingerprint changes", async () => {
    const commandExecutor = {
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    };
    const experience = new DiffExperience({
      repositoryDiscovery: { selectRepository: vi.fn() },
      gitCommandRunner: { run: vi.fn() },
      gitDiffService: {
        getMutableStateFingerprint: vi.fn(() => Promise.resolve("after")),
      } as never,
      workspaceState: {} as never,
      symlinkUriProvider,
      commandExecutor,
    });
    const session = {
      selection: { repositoryRoot: { fsPath: "/repo", scheme: "file" } },
      mutableStateFingerprint: "before",
    };
    const experienceWithPrivateState = experience as unknown as {
      currentSession: unknown;
      navigate: (
        direction: "next" | "previous",
        unit: "file" | "change",
      ) => Promise<void>;
    };
    experienceWithPrivateState.currentSession = session;

    await experienceWithPrivateState.navigate("next", "file");

    expect(commandExecutor.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "gito.diff.sessionActive",
      false,
    );
    experience.dispose();
  });

  it("does not publish context or session when preparation drifts", async () => {
    const { experience, commandExecutor } = createLifecycleExperience(
      ["before", "before", "after"],
      createRepositoryPlan(),
    );

    await openSelection(experience);

    expect(commandNames(commandExecutor)).toEqual(["setContext", "setContext"]);
    expect(setContextValues(commandExecutor)).toEqual([false, false]);
    expect(experience.getSession()).toBeUndefined();
    experience.dispose();
  });

  it("clears context and session on an empty plan", async () => {
    const { experience, commandExecutor } = createLifecycleExperience(
      ["before", "before"],
      { kind: "repository", files: [] },
    );

    await openSelection(experience);

    expect(commandNames(commandExecutor)).toEqual(["setContext", "setContext"]);
    expect(setContextValues(commandExecutor)).toEqual([false, false]);
    expect(experience.getSession()).toBeUndefined();
    experience.dispose();
  });

  it("dispatches all-submodule comparison tuples after metadata guidance", async () => {
    const repositoryPlan = createRepositoryPlan() as {
      readonly files: readonly {
        readonly metadata: Record<string, unknown>;
        readonly [propertyName: string]: unknown;
      }[];
      readonly [propertyName: string]: unknown;
    };
    const allSubmodulePlan = {
      ...repositoryPlan,
      files: [
        ...repositoryPlan.files.map((file) => ({
          ...file,
          metadata: { ...file.metadata, isSubmodule: true },
        })),
        {
          ...repositoryPlan.files[0]!,
          displayPath: "nested-two",
          metadata: {
            ...repositoryPlan.files[0]!.metadata,
            isSubmodule: true,
          },
        },
      ],
    };
    const { experience, commandExecutor } = createLifecycleExperience(
      ["before", "before"],
      allSubmodulePlan,
    );

    await openSelection(experience);

    expect(experience.getSession()).toBeDefined();
    expect(commandNames(commandExecutor)).toEqual([
      "setContext",
      "vscode.changes",
      "setContext",
    ]);
    expect(setContextValues(commandExecutor)).toEqual([false, true]);
    experience.dispose();
  });

  it("clears context and session when no plan exists", async () => {
    const { experience, commandExecutor } = createLifecycleExperience(
      ["before", "before"],
      undefined,
    );

    await openSelection(experience);

    expect(commandNames(commandExecutor)).toEqual(["setContext", "setContext"]);
    expect(setContextValues(commandExecutor)).toEqual([false, false]);
    expect(experience.getSession()).toBeUndefined();
    experience.dispose();
  });

  it("clears context and session when opening the native editor fails", async () => {
    const { experience, commandExecutor, workspaceState } =
      createLifecycleExperience(
        ["before", "before", "before"],
        createRepositoryPlan(),
        true,
      );

    await openSelection(experience);
    await Promise.resolve();

    expect(commandNames(commandExecutor)).toEqual([
      "setContext",
      "vscode.diff",
      "setContext",
    ]);
    expect(setContextValues(commandExecutor)).toEqual([false, false]);
    expect(experience.getSession()).toBeUndefined();
    expect(workspaceState.update).not.toHaveBeenCalled();
    experience.dispose();
  });

  it("does not restore a stale session after navigation open rejection", async () => {
    const { experience } = createLifecycleExperience(
      ["before", "before", "before"],
      createNavigableRepositoryPlan(),
      true,
    );
    const privateExperience = experience as unknown as {
      currentSession: unknown;
      navigate: (
        direction: "next" | "previous",
        unit: "file" | "change",
      ) => Promise<void>;
    };
    privateExperience.currentSession = createSessionForTest(
      createNavigableRepositoryPlan(),
    );

    await privateExperience.navigate("next", "file");

    expect(experience.getSession()).toBeUndefined();
    experience.dispose();
  });

  it("does not restore a stale session after swap open rejection", async () => {
    const { experience } = createLifecycleExperience(
      ["before", "before", "before"],
      createRepositoryPlan(),
      true,
    );
    const privateExperience = experience as unknown as {
      currentSession: unknown;
      swapSides: () => Promise<void>;
    };
    privateExperience.currentSession = createSessionForTest(
      createRepositoryPlan(),
    );

    await privateExperience.swapSides();

    expect(experience.getSession()).toBeUndefined();
    experience.dispose();
  });

  it("keeps context inactive when progress is cancelled", async () => {
    const { experience, commandExecutor } = createLifecycleExperience(
      ["before"],
      createRepositoryPlan(),
      false,
      true,
    );

    await expect(openSelection(experience)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(commandNames(commandExecutor)).toEqual(["setContext"]);
    expect(experience.getSession()).toBeUndefined();
    experience.dispose();
  });

  it("publishes context after validation and awaits editor completion", async () => {
    const { experience, commandExecutor, workspaceState } =
      createLifecycleExperience(
        ["before", "before", "before"],
        createRepositoryPlan(),
      );

    await openSelection(experience);

    expect(commandNames(commandExecutor)).toEqual([
      "setContext",
      "vscode.diff",
      "setContext",
    ]);
    expect(setContextValues(commandExecutor)).toEqual([false, true]);
    expect(experience.getSession()).toBeDefined();
    await vi.waitFor(() =>
      expect(workspaceState.update).toHaveBeenCalledOnce(),
    );
    experience.dispose();
  });

  it("opens before a never-settling recent comparison write", async () => {
    const { experience, commandExecutor, workspaceState } =
      createLifecycleExperience(
        ["before", "before", "before"],
        createRepositoryPlan(),
      );
    workspaceState.update.mockImplementation(
      () => new Promise(() => undefined),
    );

    await openSelection(experience);

    expect(commandNames(commandExecutor)).toEqual([
      "setContext",
      "vscode.diff",
      "setContext",
    ]);
    const nativeDiffCommandIndex =
      commandExecutor.executeCommand.mock.calls.findIndex(
        ([commandIdentifier]) => commandIdentifier === "vscode.diff",
      );
    expect(nativeDiffCommandIndex).toBeGreaterThanOrEqual(0);
    const nativeDiffCommandCallOrder =
      commandExecutor.executeCommand.mock.invocationCallOrder[
        nativeDiffCommandIndex
      ];
    const recentComparisonUpdateCallOrder =
      workspaceState.update.mock.invocationCallOrder[0];
    expect(nativeDiffCommandCallOrder).toBeDefined();
    expect(recentComparisonUpdateCallOrder).toBeDefined();
    expect(nativeDiffCommandCallOrder!).toBeLessThan(
      recentComparisonUpdateCallOrder!,
    );
    expect(experience.getSession()).toBeDefined();
    experience.dispose();
  });

  it("opens before a never-settling special-file notification", async () => {
    const repositoryPlan = createRepositoryPlan() as {
      readonly files: readonly Record<string, unknown>[];
      readonly [propertyName: string]: unknown;
    };
    lifecycleMock.informationMessageCompletion = new Promise(() => undefined);
    const { experience, commandExecutor } = createLifecycleExperience(
      ["before", "before", "before"],
      {
        ...repositoryPlan,
        files: repositoryPlan.files.map((file) => ({
          ...file,
          metadata: {
            ...(file.metadata as Record<string, unknown>),
            isBinary: true,
          },
        })),
      },
    );
    lifecycleMock.informationMessageCompletion = new Promise(() => undefined);

    await openSelection(experience);

    expect(commandNames(commandExecutor)).toEqual([
      "setContext",
      "vscode.diff",
      "setContext",
    ]);
    expect(experience.getSession()).toBeDefined();
    experience.dispose();
  });
});

function createLifecycleExperience(
  fingerprints: readonly string[],
  plan: unknown,
  rejectOpen = false,
  cancelProgress = false,
): {
  readonly experience: DiffExperience;
  readonly commandExecutor: {
    readonly executeCommand: ReturnType<typeof vi.fn>;
  };
  readonly workspaceState: {
    readonly get: ReturnType<typeof vi.fn>;
    readonly update: ReturnType<typeof vi.fn>;
  };
} {
  const repositoryRoot = createTestFileUri("/repo") as never;
  const commandExecutor = {
    executeCommand: vi.fn((commandIdentifier: string) => {
      if (rejectOpen && commandIdentifier === "vscode.diff") {
        return Promise.reject(new Error("open failed"));
      }
      return Promise.resolve(undefined);
    }),
  };
  const fingerprintQueue = [...fingerprints];
  const repositoryDiscovery = {
    selectRepository: vi.fn(() => Promise.resolve({ rootUri: repositoryRoot })),
  };
  const gitDiffService = {
    createRepositoryBinding: vi.fn(() => Promise.resolve({})),
    getHeadRevision: vi.fn(() => Promise.resolve("HEAD")),
    getMutableStateFingerprint: vi.fn(() =>
      Promise.resolve(fingerprintQueue.shift() ?? fingerprints.at(-1)),
    ),
    createDiffPlan: vi.fn(() => Promise.resolve(plan)),
  };
  const gitCommandRunner = {
    run: vi.fn(() => Promise.resolve({ standardOutput: "HEAD" })),
  };
  const symlinkUriProvider = {
    provideTextDocumentContent: () => "",
    beginSession: vi.fn(),
    dispose: vi.fn(),
  } as never;
  const workspaceState = {
    get: vi.fn(() => []),
    update: vi.fn(() => Promise.resolve()),
  };
  const experience = new DiffExperience({
    repositoryDiscovery: repositoryDiscovery as never,
    gitCommandRunner: gitCommandRunner as never,
    gitDiffService: gitDiffService as never,
    workspaceState: workspaceState as never,
    symlinkUriProvider,
    commandExecutor,
  });
  lifecycleMock.cancelProgress = cancelProgress;
  lifecycleMock.informationMessageCompletion = undefined;
  return { experience, commandExecutor, workspaceState };
}

async function openSelection(experience: DiffExperience): Promise<void> {
  const privateExperience = experience as unknown as {
    openSelection: (selection: unknown) => Promise<void>;
  };
  await privateExperience.openSelection({
    repositoryRoot: createTestFileUri("/repo"),
    from: {
      kind: "revision",
      repositoryRoot: createTestFileUri("/repo"),
      revision: "HEAD",
    },
    to: {
      kind: "working-tree",
      repositoryRoot: createTestFileUri("/repo"),
    },
    view: "repository",
    options: {
      preset: "review",
      contextLines: 3,
      whitespaceMode: "default",
      presentationMode: "line",
      maxFiles: 500,
      maxOutputBytes: 1000,
      maxNavigationChanges: 100,
    },
  });
}

function createRepositoryPlan(): unknown {
  return {
    kind: "repository",
    files: [
      {
        repositoryRoot: createTestFileUri("/repo"),
        originalUri: { scheme: "git", fsPath: "/repo/old.txt" },
        modifiedUri: { scheme: "file", fsPath: "/repo/new.txt" },
        displayPath: "new.txt",
        metadata: {
          isSubmodule: false,
          changeType: "modified",
          isBinary: false,
        },
        presentation: {},
        changeRanges: [],
        navigationEntryIds: [],
      },
    ],
    navigation: { entries: [] },
    from: { kind: "revision", revision: "HEAD" },
    to: { kind: "working-tree" },
    presentation: {},
    totalFileCount: 1,
    omittedFileCount: 0,
    truncated: false,
    caps: { maxFiles: 1, maxOutputBytes: 1000, maxNavigationChanges: 100 },
  };
}

function createNavigableRepositoryPlan(): unknown {
  const repositoryPlan = createRepositoryPlan() as {
    readonly files: readonly Record<string, unknown>[];
    readonly [propertyName: string]: unknown;
  };
  const firstFile = repositoryPlan.files[0]!;
  const firstNavigationFile = {
    ...firstFile,
    navigationEntryIds: ["change-1"],
  };
  const secondNavigationFile = {
    ...firstFile,
    displayPath: "second.txt",
    navigationEntryIds: ["change-2"],
  };
  const changeRange = {
    oldStartLine: 1,
    oldLineCount: 1,
    newStartLine: 1,
    newLineCount: 1,
  };
  return {
    ...repositoryPlan,
    files: [firstNavigationFile, secondNavigationFile],
    navigation: {
      entries: [
        {
          id: "change-1",
          fileIndex: 0,
          path: "new.txt",
          rangeIndex: 0,
          range: changeRange,
        },
        {
          id: "change-2",
          fileIndex: 1,
          path: "second.txt",
          rangeIndex: 0,
          range: changeRange,
        },
      ],
      truncated: false,
    },
    totalFileCount: 2,
  };
}

function createSessionForTest(plan: unknown): unknown {
  const repositoryRoot = createTestFileUri("/repo");
  return {
    selection: {
      repositoryRoot,
      from: {
        kind: "revision",
        repositoryRoot,
        revision: "HEAD",
      },
      to: { kind: "working-tree", repositoryRoot },
      view: "repository",
      options: {
        preset: "review",
        contextLines: 3,
        whitespaceMode: "default",
        presentationMode: "line",
        maxFiles: 500,
        maxOutputBytes: 1_000,
        maxNavigationChanges: 100,
      },
    },
    plan,
    repositoryBinding: {},
    mutableStateFingerprint: "before",
    activeFileIndex: 0,
    activeChangeEntryId: "change-1",
    swapped: false,
  };
}

function commandNames(commandExecutor: {
  executeCommand: ReturnType<typeof vi.fn>;
}): readonly unknown[] {
  const commandCalls = commandExecutor.executeCommand.mock
    .calls as readonly (readonly unknown[])[];
  return commandCalls.map((commandCall) => commandCall[0]);
}

function setContextValues(commandExecutor: {
  executeCommand: ReturnType<typeof vi.fn>;
}): readonly unknown[] {
  const commandCalls = commandExecutor.executeCommand.mock
    .calls as readonly (readonly unknown[])[];
  return commandCalls
    .filter((commandCall) => commandCall[0] === "setContext")
    .map((commandCall) => commandCall[2]);
}
