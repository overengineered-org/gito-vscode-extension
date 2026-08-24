// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method, @typescript-eslint/no-unused-vars */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const historyExperienceVscodeState = vi.hoisted(() => {
  class Disposable {
    public constructor(private readonly onDispose: () => void = () => {}) {}
    public dispose(): void {
      this.onDispose();
    }
  }
  class Uri {
    public readonly scheme: string;
    public readonly fsPath: string;
    public constructor(
      value: string,
      scheme = "file",
      public readonly query = "",
    ) {
      this.scheme = scheme;
      this.fsPath = value;
    }
    public static file(filePath: string): Uri {
      return new Uri(filePath);
    }
    public static from(components: {
      readonly scheme: string;
      readonly authority: string;
      readonly path: string;
      readonly query: string;
      readonly fragment: string;
    }): Uri {
      return new Uri(components.path, components.scheme, components.query);
    }
    public static parse(value: string): Uri {
      const schemeSeparator = value.indexOf(":");
      return schemeSeparator < 0
        ? new Uri(value)
        : new Uri(
            value.slice(schemeSeparator + 1),
            value.slice(0, schemeSeparator),
          );
    }
    public with(changes: {
      readonly scheme?: string;
      readonly path?: string;
      readonly query?: string;
    }): Uri {
      return new Uri(
        changes.path ?? this.fsPath,
        changes.scheme ?? this.scheme,
        changes.query ?? this.query,
      );
    }
    public toString(): string {
      return `${this.scheme}:${this.fsPath}${this.query.length === 0 ? "" : `?${this.query}`}`;
    }
  }
  class ThemeColor {
    public constructor(public readonly id: string) {}
  }
  class ThemeIcon {
    public constructor(public readonly id: string) {}
  }
  class Range {
    public constructor(
      public readonly startLine: number,
      public readonly startCharacter: number,
      public readonly endLine: number,
      public readonly endCharacter: number,
    ) {}
  }
  class MarkdownString {
    public value = "";
    public isTrusted: unknown;
    public appendMarkdown(markdown: string): MarkdownString {
      this.value += markdown;
      return this;
    }
  }
  class Hover {
    public constructor(
      public readonly contents: unknown,
      public readonly range?: unknown,
    ) {}
  }
  class CodeLens {
    public constructor(
      public readonly range: unknown,
      public readonly command?: unknown,
    ) {}
  }
  const createEvent = () => {
    const listeners = new Set<(event: never) => void>();
    const event = (listener: (event: never) => void): Disposable => {
      listeners.add(listener);
      return new Disposable(() => listeners.delete(listener));
    };
    return {
      event,
      fire: (payload: never) => {
        for (const listener of listeners) listener(payload);
      },
    };
  };
  const activeEditorChanged = createEvent();
  const selectionChanged = createEvent();
  const documentChanged = createEvent();
  const configurationChanged = createEvent();
  const trustGranted = createEvent();
  const repositoryChanged = createEvent();
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const registeredProviders: { hover?: unknown; codeLens?: unknown } = {};
  const executeCommand = vi.fn(async () => undefined);
  const statusBar = {
    name: "",
    command: undefined as string | undefined,
    text: "",
    tooltip: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  const windowApi = {
    showQuickPick: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBarItem: vi.fn(() => statusBar),
    activeTextEditor: undefined as unknown,
    onDidChangeActiveTextEditor: activeEditorChanged.event,
    onDidChangeTextEditorSelection: selectionChanged.event,
  };
  const workspaceApi = {
    isTrusted: true,
    onDidChangeTextDocument: documentChanged.event,
    onDidChangeConfiguration: configurationChanged.event,
    onDidGrantWorkspaceTrust: trustGranted.event,
    getConfiguration: vi.fn(() => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    })),
  };
  Object.defineProperty(windowApi, "activeTextEditor", {
    get: () => historyExperienceVscodeState.activeEditor,
  });
  return {
    Disposable,
    Uri,
    ThemeColor,
    ThemeIcon,
    Range,
    MarkdownString,
    Hover,
    CodeLens,
    activeEditorChanged,
    selectionChanged,
    documentChanged,
    configurationChanged,
    trustGranted,
    repositoryChanged,
    commandHandlers,
    registeredProviders,
    executeCommand,
    statusBar,
    windowApi,
    workspaceApi,
    activeEditor: undefined as unknown,
  };
});

vi.mock("vscode", () => ({
  Disposable: historyExperienceVscodeState.Disposable,
  Hover: historyExperienceVscodeState.Hover,
  MarkdownString: historyExperienceVscodeState.MarkdownString,
  Range: historyExperienceVscodeState.Range,
  ThemeColor: historyExperienceVscodeState.ThemeColor,
  ThemeIcon: historyExperienceVscodeState.ThemeIcon,
  CodeLens: historyExperienceVscodeState.CodeLens,
  StatusBarAlignment: { Right: 2 },
  Uri: historyExperienceVscodeState.Uri,
  commands: {
    executeCommand: historyExperienceVscodeState.executeCommand,
    registerCommand: (
      identifier: string,
      handler: (...args: unknown[]) => unknown,
    ) => {
      historyExperienceVscodeState.commandHandlers.set(identifier, handler);
      return new historyExperienceVscodeState.Disposable();
    },
  },
  env: { clipboard: { writeText: vi.fn(async () => undefined) } },
  languages: {
    registerHoverProvider: (_selector: unknown, provider: unknown) => {
      historyExperienceVscodeState.registeredProviders.hover = provider;
      return new historyExperienceVscodeState.Disposable();
    },
    registerCodeLensProvider: (_selector: unknown, provider: unknown) => {
      historyExperienceVscodeState.registeredProviders.codeLens = provider;
      return new historyExperienceVscodeState.Disposable();
    },
  },
  window: historyExperienceVscodeState.windowApi,
  workspace: historyExperienceVscodeState.workspaceApi,
}));

import * as vscode from "vscode";
import {
  createHistoryCommandUri,
  HistoryExperienceController,
  historyExperienceCommandIds,
} from "../../../src/extension/historyExperience/index.js";
import type { FileHistoryPage } from "../../../src/extension/history/index.js";
import type { HistoryExperienceDependencies } from "../../../src/extension/historyExperience/index.js";

const repositoryRoot = vscode.Uri.file("/repo");
const blameLine = {
  lineNumber: 2,
  content: "shared",
  commitSha: "0123456789012345678901234567890123456789",
  originalLineNumber: 4,
  authorName: "Ada Author",
  authorEmail: "ada@example.test",
  authorDate: "2026-08-23T00:00:00+00:00",
  summary: "move shared line",
  pathAtRevision: "story.txt",
} as const;
const historyCommit = {
  sha: blameLine.commitSha,
  shortSha: blameLine.commitSha.slice(0, 7),
  subject: blameLine.summary,
  authorName: blameLine.authorName,
  authorEmail: blameLine.authorEmail,
  authorDate: blameLine.authorDate,
  committerDate: blameLine.authorDate,
  parentShas: [],
  changedFiles: [],
} as const;

function createDocument(filePath: string, text: string): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    uri: vscode.Uri.file(filePath),
    lineCount: lines.length,
    getText: () => text,
    lineAt: (lineIndex: number) => ({
      text: lines[lineIndex] ?? "",
      range: new vscode.Range(
        lineIndex,
        0,
        lineIndex,
        lines[lineIndex]?.length ?? 0,
      ),
    }),
  } as never;
}

function createEditor(
  document: vscode.TextDocument,
  line = 1,
): vscode.TextEditor {
  return {
    document,
    selection: { active: { line, character: 0 } },
    setDecorations: vi.fn(),
  } as never;
}

function createDependencies(
  overrides: Partial<HistoryExperienceDependencies["historyService"]> = {},
): HistoryExperienceDependencies {
  return {
    historyService: {
      getBlame: vi.fn(async () => [blameLine]),
      listFileHistory: vi.fn(async () => ({
        entries: [],
        hasMore: false,
        reachedSafetyCap: false,
      })),
      listLineHistory: vi.fn(async () => []),
      aggregateContributors: vi.fn(async () => ({
        contributors: [],
        examinedCommitCount: 0,
        reachedSafetyCap: false,
      })),
      search: vi.fn(async () => ({
        matches: [],
        examinedCommitCount: 0,
        hasMore: false,
        reachedSafetyCap: false,
      })),
      getRevisionNavigation: vi.fn(),
      ...overrides,
    },
    repositoryProvider: {
      resolveRepositoryRoot: vi.fn(async () => repositoryRoot),
      watchRepositoryChanges: (listener) =>
        historyExperienceVscodeState.repositoryChanged.event(listener as never),
    },
    readSettings: () => ({
      enabled: true,
      blameEnabled: true,
      codeLensEnabled: true,
    }),
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("history experience controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyExperienceVscodeState.commandHandlers.clear();
    historyExperienceVscodeState.registeredProviders.hover = undefined;
    historyExperienceVscodeState.registeredProviders.codeLens = undefined;
    historyExperienceVscodeState.workspaceApi.isTrusted = true;
    historyExperienceVscodeState.activeEditor = undefined;
  });

  afterEach(() => {
    historyExperienceVscodeState.activeEditorChanged.fire(undefined as never);
  });

  it("renders exact blame SHA/path/line and trusted command URIs", async () => {
    const document = createDocument("/repo/src/story.txt", "alpha\nshared\n");
    const editor = createEditor(document);
    historyExperienceVscodeState.activeEditor = editor;
    const dependencies = createDependencies();
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();

    expect(dependencies.historyService.getBlame).toHaveBeenCalledWith(
      repositoryRoot,
      "src/story.txt",
      expect.objectContaining({ range: { startLine: 2, endLine: 2 } }),
    );
    expect(controller.getState()).toMatchObject({
      repositoryRoot: "/repo",
      relativePath: "src/story.txt",
      lineNumber: 2,
      blameCommitSha: blameLine.commitSha,
      blameVisible: true,
    });
    expect(historyExperienceVscodeState.statusBar.text).toContain("Ada Author");
    expect(historyExperienceVscodeState.statusBar.text).toContain(
      "move shared line",
    );
    expect(historyExperienceVscodeState.statusBar.command).toMatchObject({
      command: historyExperienceCommandIds.openCommit,
      arguments: [
        expect.objectContaining({
          repositoryRoot,
          filePath: "src/story.txt",
          commit: expect.objectContaining({ sha: blameLine.commitSha }),
        }),
      ],
    });

    const hoverProvider = historyExperienceVscodeState.registeredProviders
      .hover as {
      provideHover: (
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
      ) => Promise<vscode.Hover | undefined>;
    };
    const hover = await hoverProvider.provideHover(
      document,
      { line: 1, character: 0 } as vscode.Position,
      createCancellationToken(),
    );
    const markdown = readMarkdownValue(hover);
    expect(markdown).toContain(blameLine.commitSha);
    expect(markdown).toContain("story.txt:4");
    expect(markdown).toContain(
      `command:${historyExperienceCommandIds.openCommit}`,
    );
    expect(markdown).toContain(
      `command:${historyExperienceCommandIds.openLineHistory}`,
    );
    expect(
      createHistoryCommandUri(historyExperienceCommandIds.openCommit, [
        { sha: blameLine.commitSha },
      ]).toString(),
    ).toContain("command:gito.history.openCommit?");
    controller.dispose();
  });

  it("invalidates bounded cache on document/repository state changes", async () => {
    const document = createDocument("/repo/story.txt", "alpha\nshared\n");
    historyExperienceVscodeState.activeEditor = createEditor(document);
    const dependencies = createDependencies();
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();
    expect(dependencies.historyService.getBlame).toHaveBeenCalledTimes(1);

    historyExperienceVscodeState.documentChanged.fire({ document } as never);
    await flushPromises();
    expect(dependencies.historyService.getBlame).toHaveBeenCalledTimes(2);
    const generationAfterDocumentChange = controller.getState().generation;

    historyExperienceVscodeState.repositoryChanged.fire(undefined as never);
    await flushPromises();
    expect(controller.getState().generation).toBeGreaterThan(
      generationAfterDocumentChange,
    );
    expect(dependencies.historyService.getBlame).toHaveBeenCalledTimes(3);
    expect(controller.getState().cacheEntryCount).toBeLessThanOrEqual(64);
    controller.dispose();
  });

  it("clears stale blame presentation before refreshing a changed document", async () => {
    const pendingBlameResolvers: Array<
      (lines: readonly (typeof blameLine)[]) => void
    > = [];
    const dependencies = createDependencies({
      getBlame: vi.fn(
        async (): Promise<readonly (typeof blameLine)[]> =>
          new Promise((resolve) => pendingBlameResolvers.push(resolve)),
      ),
    });
    const document = createDocument("/repo/story.txt", "alpha\nshared\n");
    const editor = createEditor(document);
    historyExperienceVscodeState.activeEditor = editor;
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();
    pendingBlameResolvers[0]?.([blameLine]);
    await flushPromises();
    expect(controller.getState().blameVisible).toBe(true);

    historyExperienceVscodeState.documentChanged.fire({ document } as never);
    expect(controller.getState().blameVisible).toBe(false);
    expect(historyExperienceVscodeState.statusBar.command).toBeUndefined();
    expect(historyExperienceVscodeState.statusBar.hide).toHaveBeenCalled();
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), []);

    pendingBlameResolvers[1]?.([]);
    await flushPromises();
    controller.dispose();
  });

  it("uses the revision path for rename-aware blame actions", async () => {
    const renamedBlameLine = {
      ...blameLine,
      pathAtRevision: "old-story.txt",
    } as const;
    const document = createDocument("/repo/new-story.txt", "alpha\nshared\n");
    historyExperienceVscodeState.activeEditor = createEditor(document);
    const dependencies = createDependencies({
      getBlame: vi.fn(async () => [renamedBlameLine]),
      hasRevision: vi.fn(async () => true),
    });
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();

    const statusBarCommand = historyExperienceVscodeState.statusBar.command as {
      readonly arguments?: readonly [
        { readonly filePath?: string; readonly revisionFilePath?: string },
      ];
    };
    expect(statusBarCommand.arguments?.[0]?.filePath).toBe("new-story.txt");
    expect(statusBarCommand.arguments?.[0]?.revisionFilePath).toBe(
      "old-story.txt",
    );

    historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce({
      action: "openRevision",
    } as never);
    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openCommit,
    )?.(statusBarCommand.arguments?.[0]);
    expect(historyExperienceVscodeState.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({
        scheme: "git",
        fsPath: "/repo/old-story.txt",
      }),
    );

    const hoverProvider = historyExperienceVscodeState.registeredProviders
      .hover as {
      provideHover: (
        hoverDocument: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
      ) => Promise<vscode.Hover | undefined>;
    };
    const markdown = readMarkdownValue(
      await hoverProvider.provideHover(
        document,
        { line: 1, character: 0 } as vscode.Position,
        createCancellationToken(),
      ),
    );
    const previousRevisionStart = markdown.indexOf(
      `command:${historyExperienceCommandIds.previousRevision}`,
    );
    const nextRevisionStart = markdown.indexOf(
      `command:${historyExperienceCommandIds.nextRevision}`,
    );
    expect(previousRevisionStart).toBeGreaterThanOrEqual(0);
    expect(nextRevisionStart).toBeGreaterThan(previousRevisionStart);
    expect(
      decodeURIComponent(
        markdown.slice(previousRevisionStart, nextRevisionStart),
      ),
    ).toContain('"filePath":"old-story.txt"');
    expect(decodeURIComponent(markdown.slice(nextRevisionStart))).toContain(
      '"filePath":"old-story.txt"',
    );
    controller.dispose();
  });

  it.each(["previousRevision", "nextRevision"] as const)(
    "uses the revision path for renamed commit menu %s",
    async (action) => {
      const currentResource = {
        repositoryRoot: "/repo",
        repositoryRootIdentity: "file:/repo",
        revisionSha: historyCommit.sha,
        relativePath: "old-story.txt",
      } as const;
      const previousResource = {
        ...currentResource,
        revisionSha: "previous-revision",
      } as const;
      const nextResource = {
        ...currentResource,
        revisionSha: "next-revision",
      } as const;
      const dependencies = createDependencies({
        getRevisionNavigation: vi.fn(async () => ({
          current: currentResource,
          currentCommit: historyCommit,
          parents: [],
          previousDiff: {
            left: previousResource,
            right: currentResource,
            title: "Previous revision",
          },
          nextDiff: {
            left: currentResource,
            right: nextResource,
            title: "Next revision",
          },
        })),
      });
      dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
        async () => true,
      );
      const controller = new HistoryExperienceController(dependencies);
      controller.register();
      historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce(
        { action } as never,
      );

      await historyExperienceVscodeState.commandHandlers.get(
        historyExperienceCommandIds.openCommit,
      )?.({
        repositoryRoot,
        commit: historyCommit,
        filePath: "new-story.txt",
        revisionFilePath: "old-story.txt",
      });

      expect(
        dependencies.historyService.getRevisionNavigation,
      ).toHaveBeenCalledWith(
        repositoryRoot,
        historyCommit.sha,
        "old-story.txt",
        undefined,
        expect.any(AbortSignal),
      );
      controller.dispose();
    },
  );

  it("cancels stale blame when the editor changes and skips untrusted/large files", async () => {
    let resolveBlame:
      ((lines: readonly (typeof blameLine)[]) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const pendingBlame = new Promise<readonly (typeof blameLine)[]>(
      (resolve) => {
        resolveBlame = resolve;
      },
    );
    const dependencies = createDependencies({
      getBlame: vi.fn(async (_root, _path, options) => {
        observedSignal = options?.cancellationSignal;
        return pendingBlame;
      }),
    });
    const document = createDocument("/repo/story.txt", "alpha\nshared\n");
    historyExperienceVscodeState.activeEditor = createEditor(document);
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();
    historyExperienceVscodeState.activeEditorChanged.fire(undefined as never);
    expect(observedSignal?.aborted).toBe(true);
    resolveBlame?.([]);
    await flushPromises();
    expect(controller.getState().blameVisible).toBe(false);
    controller.dispose();

    historyExperienceVscodeState.workspaceApi.isTrusted = false;
    historyExperienceVscodeState.activeEditor = createEditor(document);
    const untrustedService = createDependencies();
    const untrustedController = new HistoryExperienceController(
      untrustedService,
    );
    untrustedController.register();
    await flushPromises();
    expect(untrustedService.historyService.getBlame).not.toHaveBeenCalled();
    untrustedController.dispose();
  });

  it("debounces two-line cursor blame refresh and cancels it on disposal", async () => {
    const pendingBlameResolvers: Array<
      (lines: readonly (typeof blameLine)[]) => void
    > = [];
    const observedSignals: AbortSignal[] = [];
    const document = createDocument("/repo/story.txt", "alpha\nshared\n");
    const editor = createEditor(document, 0);
    historyExperienceVscodeState.activeEditor = editor;
    const dependencies = createDependencies({
      getBlame: vi.fn(
        async (
          _repositoryRoot: unknown,
          _filePath: string,
          options?: { readonly cancellationSignal?: AbortSignal },
        ): Promise<readonly (typeof blameLine)[]> => {
          if (options?.cancellationSignal !== undefined)
            observedSignals.push(options.cancellationSignal);
          return new Promise((resolve) => pendingBlameResolvers.push(resolve));
        },
      ),
    });
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();
    expect(dependencies.historyService.getBlame).toHaveBeenCalledTimes(1);

    const editableSelection = editor as unknown as {
      selection: { active: { line: number; character: number } };
    };
    editableSelection.selection = { active: { line: 1, character: 0 } };
    historyExperienceVscodeState.selectionChanged.fire({
      textEditor: editor,
    } as never);
    historyExperienceVscodeState.selectionChanged.fire({
      textEditor: editor,
    } as never);
    expect(observedSignals[0]?.aborted).toBe(true);

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await flushPromises();
    expect(dependencies.historyService.getBlame).toHaveBeenCalledTimes(2);
    expect(dependencies.historyService.getBlame).toHaveBeenLastCalledWith(
      repositoryRoot,
      "story.txt",
      expect.objectContaining({ range: { startLine: 2, endLine: 2 } }),
    );
    pendingBlameResolvers[0]?.([]);
    pendingBlameResolvers[1]?.([blameLine]);
    await flushPromises();
    expect(controller.getState()).toMatchObject({
      relativePath: "story.txt",
      lineNumber: 2,
      blameCommitSha: blameLine.commitSha,
      blameVisible: true,
    });

    editableSelection.selection = { active: { line: 0, character: 0 } };
    historyExperienceVscodeState.selectionChanged.fire({
      textEditor: editor,
    } as never);
    controller.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(dependencies.historyService.getBlame).toHaveBeenCalledTimes(2);
  });

  it("authorizes an exact canonical root without requiring an active editor", async () => {
    const dependencies = createDependencies();
    const authorizeRepositoryRoot = vi.fn(
      async (selectedRoot: unknown, documentUri?: vscode.Uri) =>
        selectedRoot === repositoryRoot && documentUri === undefined,
    );
    dependencies.repositoryProvider.isRepositoryRootAuthorized =
      authorizeRepositoryRoot;
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openFileHistory,
    )?.({ repositoryRoot, filePath: "story.txt" });
    expect(authorizeRepositoryRoot).toHaveBeenCalledWith(
      repositoryRoot,
      undefined,
    );
    expect(dependencies.historyService.listFileHistory).toHaveBeenCalledWith(
      repositoryRoot,
      "story.txt",
      expect.anything(),
    );
    controller.dispose();
  });

  it("reconstructs JSON-decoded URI command arguments before history access", async () => {
    const dependencies = createDependencies();
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    const commandUri = createHistoryCommandUri(
      historyExperienceCommandIds.openFileHistory,
      [{ repositoryRoot, filePath: "story.txt" }],
    );
    const encodedArguments = commandUri.toString().split("?")[1];
    if (encodedArguments === undefined)
      throw new Error("Missing command args.");
    const decodedArguments = JSON.parse(
      decodeURIComponent(encodedArguments),
    ) as readonly [unknown];

    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openFileHistory,
    )?.(decodedArguments[0]);

    const requestedRoot = vi.mocked(dependencies.historyService.listFileHistory)
      .mock.calls[0]?.[0];
    expect(requestedRoot).toMatchObject({
      fsPath: "/repo",
      scheme: "file",
    });
    expect(String(requestedRoot)).not.toContain("[object Object]");
    controller.dispose();
  });

  it("uses a line-history entry path when opening a renamed revision", async () => {
    const renamedEntry = {
      ...historyCommit,
      path: "old-story.txt",
      lineNumber: 2,
    } as const;
    const dependencies = createDependencies({
      listLineHistory: vi.fn(async () => [renamedEntry]),
      hasRevision: vi.fn(async () => true),
    });
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    historyExperienceVscodeState.windowApi.showQuickPick
      .mockResolvedValueOnce({
        commit: renamedEntry,
        lineHistoryEntry: renamedEntry,
      } as never)
      .mockResolvedValueOnce({ action: "openRevision" } as never);

    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openLineHistory,
    )?.({
      repositoryRoot,
      filePath: "new-story.txt",
      lineNumber: 2,
    });

    expect(dependencies.historyService.hasRevision).toHaveBeenCalledWith(
      repositoryRoot,
      historyCommit.sha,
      expect.any(AbortSignal),
    );
    expect(historyExperienceVscodeState.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({
        scheme: "git",
        fsPath: "/repo/old-story.txt",
      }),
    );
    controller.dispose();
  });

  it("keeps a graph commit action bound to its root beside another editor", async () => {
    const dependencies = createDependencies({
      hasRevision: vi.fn(async () => true),
    });
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async (_selectedRoot, documentUri) => documentUri === undefined,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    historyExperienceVscodeState.activeEditor = createEditor(
      createDocument("/other-repository/other.txt", "other\n"),
    );
    historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce({
      action: "openRevision",
    } as never);

    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openCommit,
    )?.({
      repositoryRoot,
      commit: historyCommit,
      filePath: "story.txt",
    });

    expect(
      dependencies.repositoryProvider.isRepositoryRootAuthorized,
    ).toHaveBeenCalledWith(repositoryRoot, undefined);
    expect(historyExperienceVscodeState.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ scheme: "git" }),
    );
    controller.dispose();
  });

  it("opens contributors from file history without an active editor", async () => {
    const dependencies = createDependencies({
      aggregateContributors: vi.fn(async () => ({
        contributors: [],
        examinedCommitCount: 0,
        reachedSafetyCap: false,
      })),
    });
    const authorizeRepositoryRoot = vi.fn(async () => true);
    dependencies.repositoryProvider.isRepositoryRootAuthorized =
      authorizeRepositoryRoot;
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce({
      action: "openContributors",
    } as never);
    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openFileHistory,
    )?.({ repositoryRoot, filePath: "story.txt" });
    expect(
      dependencies.historyService.aggregateContributors,
    ).toHaveBeenCalledWith(repositoryRoot, expect.anything());
    expect(authorizeRepositoryRoot).toHaveBeenCalledWith(
      repositoryRoot,
      undefined,
    );
    controller.dispose();
  });

  it("does not open a revision after the repository instance is replaced", async () => {
    const dependencies = createDependencies({
      hasRevision: vi.fn(async () => true),
    });
    let identityReadCount = 0;
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    dependencies.repositoryProvider.getRepositoryIdentity = vi.fn(async () =>
      identityReadCount++ === 0
        ? "repository-generation-1"
        : "repository-generation-2",
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce({
      action: "openRevision",
    } as never);
    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openCommit,
    )?.({
      repositoryRoot,
      commit: historyCommit,
      filePath: "story.txt",
    });
    expect(dependencies.historyService.hasRevision).toHaveBeenCalledWith(
      repositoryRoot,
      blameLine.commitSha,
      expect.any(AbortSignal),
    );
    expect(
      historyExperienceVscodeState.executeCommand,
    ).not.toHaveBeenCalledWith("vscode.open", expect.anything());
    controller.dispose();
  });

  it("cancels a pending revision open when its generation changes", async () => {
    let resolveHasRevision: ((hasRevision: boolean) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const dependencies = createDependencies({
      hasRevision: vi.fn(
        async (
          _repositoryRoot: unknown,
          _revisionSha: string,
          cancellationSignal?: AbortSignal,
        ) => {
          observedSignal = cancellationSignal;
          return new Promise<boolean>((resolve) => {
            resolveHasRevision = resolve;
          });
        },
      ),
    });
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce({
      action: "openRevision",
    } as never);
    const openRevisionPromise = Promise.resolve(
      historyExperienceVscodeState.commandHandlers.get(
        historyExperienceCommandIds.openCommit,
      )?.({
        repositoryRoot,
        commit: historyCommit,
        filePath: "story.txt",
      }),
    );
    await flushPromises();
    controller.invalidateCache(repositoryRoot);
    expect(observedSignal?.aborted).toBe(true);
    resolveHasRevision?.(true);
    await openRevisionPromise;
    expect(
      historyExperienceVscodeState.executeCommand,
    ).not.toHaveBeenCalledWith("vscode.open", expect.anything());
    controller.dispose();
  });

  it("drops a late file-history result after generation changes", async () => {
    let resolveHistory: ((page: FileHistoryPage) => void) | undefined;
    const dependencies = createDependencies({
      listFileHistory: vi.fn(
        () =>
          new Promise<FileHistoryPage>((resolve) => {
            resolveHistory = resolve;
          }),
      ),
    });
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    const openFileHistoryPromise = Promise.resolve(
      historyExperienceVscodeState.commandHandlers.get(
        historyExperienceCommandIds.openFileHistory,
      )?.({ repositoryRoot, filePath: "story.txt" }),
    );
    await flushPromises();
    controller.invalidateCache(repositoryRoot);
    resolveHistory?.({ entries: [], hasMore: false, reachedSafetyCap: false });
    await openFileHistoryPromise;
    expect(
      historyExperienceVscodeState.windowApi.showQuickPick,
    ).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("opens the canonical revision resource returned by history", async () => {
    const pinnedRevisionResource = {
      repositoryRoot: "/canonical/repository",
      repositoryRootIdentity:
        "vscode-remote://ssh-remote+origin/workspace/repo",
      revisionSha: blameLine.commitSha,
      relativePath: "story.txt",
    } as const;
    const dependencies = createDependencies({
      getRevisionResource: vi.fn(async () => pinnedRevisionResource),
      hasRevision: vi.fn(async () => false),
    });
    dependencies.repositoryProvider.isRepositoryRootAuthorized = vi.fn(
      async () => true,
    );
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    historyExperienceVscodeState.windowApi.showQuickPick.mockResolvedValueOnce({
      action: "openRevision",
    } as never);
    await historyExperienceVscodeState.commandHandlers.get(
      historyExperienceCommandIds.openCommit,
    )?.({
      repositoryRoot,
      commit: historyCommit,
      filePath: "story.txt",
    });
    expect(dependencies.historyService.getRevisionResource).toHaveBeenCalled();
    expect(dependencies.historyService.hasRevision).not.toHaveBeenCalled();
    expect(historyExperienceVscodeState.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({
        fsPath: "/canonical/repository/story.txt",
        scheme: "git",
      }),
    );
    controller.dispose();
  });

  it("provides recent-change CodeLens with exact commit action arguments", async () => {
    const document = createDocument("/repo/story.txt", "alpha\nshared\n");
    historyExperienceVscodeState.activeEditor = createEditor(document);
    const dependencies = createDependencies({
      listFileHistory: vi.fn(async () => ({
        entries: [
          {
            ...blameLine,
            sha: blameLine.commitSha,
            subject: blameLine.summary,
            path: "story.txt",
            previousPath: "old-story.txt",
            changedFiles: [],
            shortSha: blameLine.commitSha.slice(0, 7),
            committerDate: blameLine.authorDate,
            parentShas: [],
          },
        ],
        hasMore: false,
        reachedSafetyCap: false,
      })),
    });
    const controller = new HistoryExperienceController(dependencies);
    controller.register();
    await flushPromises();
    const provider = historyExperienceVscodeState.registeredProviders
      .codeLens as {
      provideCodeLenses: (
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
      ) => Promise<readonly vscode.CodeLens[]>;
    };
    const lenses = await provider.provideCodeLenses(
      document,
      createCancellationToken(),
    );
    expect(lenses).toHaveLength(1);
    const firstLens = lenses[0];
    expect(firstLens).toBeDefined();
    const firstCommand = firstLens?.command;
    expect(firstCommand?.title).toContain("Ada Author");
    const firstCommandArgument = firstCommand?.arguments?.[0];
    expect(firstCommandArgument).toMatchObject({
      commit: { sha: blameLine.commitSha },
      filePath: "story.txt",
    });
    controller.dispose();
  });
});

function createCancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: (_listener) =>
      new vscode.Disposable(() => undefined),
  };
}

function readMarkdownValue(hover: vscode.Hover | undefined): string {
  if (hover === undefined) throw new Error("Expected hover result.");
  const contents = hover.contents;
  if (Array.isArray(contents)) throw new Error("Expected one MarkdownString.");
  if (typeof contents === "string") return contents;
  return (contents as vscode.MarkdownString).value;
}
