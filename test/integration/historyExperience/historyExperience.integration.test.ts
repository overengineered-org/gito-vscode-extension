// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const integrationVscodeState = vi.hoisted(() => {
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
      fsPath: string,
      scheme = "file",
      public readonly query = "",
    ) {
      this.fsPath = fsPath;
      this.scheme = scheme;
    }
    public static file(fsPath: string): Uri {
      return new Uri(fsPath);
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
      const separatorIndex = value.indexOf(":");
      return separatorIndex < 0
        ? new Uri(value)
        : new Uri(
            value.slice(separatorIndex + 1),
            value.slice(0, separatorIndex),
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
  class MarkdownString {
    public value = "";
    public isTrusted: unknown;
    public appendMarkdown(markdown: string): MarkdownString {
      this.value += markdown;
      return this;
    }
  }
  class Range {
    public constructor(
      public readonly startLine: number,
      public readonly startCharacter: number,
      public readonly endLine: number,
      public readonly endCharacter: number,
    ) {}
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
  const makeEvent = () => {
    const listeners = new Set<(event: never) => void>();
    return {
      event: (listener: (event: never) => void) => {
        listeners.add(listener);
        return new Disposable(() => listeners.delete(listener));
      },
      fire: (event: never) => {
        for (const listener of listeners) listener(event);
      },
    };
  };
  const activeEditorChanged = makeEvent();
  const selectionChanged = makeEvent();
  const documentChanged = makeEvent();
  const configurationChanged = makeEvent();
  const trustGranted = makeEvent();
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const providers: { hover?: unknown } = {};
  const executeCommand = vi.fn(async () => undefined);
  const windowApi = {
    activeTextEditor: undefined as unknown,
    onDidChangeActiveTextEditor: activeEditorChanged.event,
    onDidChangeTextEditorSelection: selectionChanged.event,
    showQuickPick: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBarItem: vi.fn(() => ({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
  };
  const workspaceApi = {
    isTrusted: true,
    onDidChangeTextDocument: documentChanged.event,
    onDidChangeConfiguration: configurationChanged.event,
    onDidGrantWorkspaceTrust: trustGranted.event,
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    }),
  };
  Object.defineProperty(windowApi, "activeTextEditor", {
    get: () => integrationVscodeState.activeEditor,
  });
  return {
    Disposable,
    Uri,
    ThemeColor,
    MarkdownString,
    Range,
    Hover,
    CodeLens,
    activeEditorChanged,
    commandHandlers,
    providers,
    executeCommand,
    windowApi,
    workspaceApi,
    activeEditor: undefined as unknown,
  };
});

vi.mock("vscode", () => ({
  Disposable: integrationVscodeState.Disposable,
  Uri: integrationVscodeState.Uri,
  ThemeColor: integrationVscodeState.ThemeColor,
  ThemeIcon: class ThemeIcon {
    public constructor(public readonly id: string) {}
  },
  MarkdownString: integrationVscodeState.MarkdownString,
  Range: integrationVscodeState.Range,
  Hover: integrationVscodeState.Hover,
  CodeLens: integrationVscodeState.CodeLens,
  StatusBarAlignment: { Right: 2 },
  commands: {
    executeCommand: integrationVscodeState.executeCommand,
    registerCommand: (
      identifier: string,
      handler: (...args: unknown[]) => unknown,
    ) => {
      integrationVscodeState.commandHandlers.set(identifier, handler);
      return new integrationVscodeState.Disposable();
    },
  },
  env: { clipboard: { writeText: vi.fn(async () => undefined) } },
  languages: {
    registerHoverProvider: (_selector: unknown, provider: unknown) => {
      integrationVscodeState.providers.hover = provider;
      return new integrationVscodeState.Disposable();
    },
    registerCodeLensProvider: (_selector: unknown, _provider: unknown) =>
      new integrationVscodeState.Disposable(),
  },
  window: integrationVscodeState.windowApi,
  workspace: integrationVscodeState.workspaceApi,
}));

import * as vscode from "vscode";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import { PremiumHistoryService } from "../../../src/extension/history/index.js";
import { HistoryExperienceController } from "../../../src/extension/historyExperience/index.js";
import { createRealHistoryRootBindingResolver } from "../../unit/history/historyRootBindingTestSupport.js";

const executeFile = promisify(execFile);
const disposableRoots: string[] = [];

afterEach(async () => {
  while (disposableRoots.length > 0) {
    const root = disposableRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("history experience real Git integration", () => {
  it("renders exact blame identity and navigates across a rename with native diff URI", async () => {
    const fixture = await createFixture();
    const document = createDocument(
      nodePath.join(fixture.repositoryPath, "renamed.txt"),
      await readFile(
        nodePath.join(fixture.repositoryPath, "renamed.txt"),
        "utf8",
      ),
    );
    integrationVscodeState.activeEditor = createEditor(document);
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );
    const directBlame = await historyService.getBlame(
      fixture.repositoryPath,
      "renamed.txt",
      { range: { startLine: 2, endLine: 2 } },
    );
    expect(directBlame[0]?.commitSha).toBe(fixture.initialSha);
    const controller = new HistoryExperienceController({
      historyService,
      repositoryProvider: {
        resolveRepositoryRoot: async () => fixture.repositoryPath,
        isRepositoryRootAuthorized: async (selectedRoot) =>
          selectedRoot === fixture.repositoryPath,
      },
      readSettings: () => ({
        enabled: true,
        blameEnabled: true,
        codeLensEnabled: false,
      }),
    });
    controller.register();
    await flushPromises();

    const hoverProvider = integrationVscodeState.providers.hover as {
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
    const hoverText = readMarkdownValue(hover);
    expect(hoverText).toContain(fixture.initialSha);
    expect(hoverText).toContain("story.txt:2");
    expect(controller.getState().cacheEntryCount).toBeGreaterThan(0);

    const previousRevisionHandler = integrationVscodeState.commandHandlers.get(
      "gito.history.previousRevision",
    );
    expect(previousRevisionHandler).toBeDefined();
    await previousRevisionHandler?.({
      repositoryRoot: fixture.repositoryPath,
      revisionSha: fixture.renameSha,
      filePath: "renamed.txt",
    });
    expect(integrationVscodeState.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.objectContaining({ scheme: "git" }),
      expect.objectContaining({ scheme: "git" }),
      "Previous revision",
    );
    const diffCall = (
      integrationVscodeState.executeCommand.mock
        .calls as readonly (readonly unknown[])[]
    ).find((call) => call[0] === "vscode.diff");
    const leftRevisionUri = diffCall?.[1];
    if (
      typeof leftRevisionUri !== "object" ||
      leftRevisionUri === null ||
      typeof (leftRevisionUri as { toString?: unknown }).toString !== "function"
    )
      throw new Error("Expected native Git revision URI.");
    const leftRevisionUriWithString = leftRevisionUri as { toString(): string };
    expect(leftRevisionUriWithString.toString()).toContain(fixture.initialSha);
    expect(leftRevisionUriWithString.toString()).toContain("story.txt");
    controller.dispose();
  }, 30_000);
});

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

function createEditor(document: vscode.TextDocument): vscode.TextEditor {
  return {
    document,
    selection: { active: { line: 1, character: 0 } },
    setDecorations: vi.fn(),
  } as never;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

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

interface Fixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly initialSha: string;
  readonly renameSha: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(nodePath.join("/tmp", "gito-history-experience-"));
  disposableRoots.push(root);
  const repositoryPath = nodePath.join(root, "repository");
  await runGit(root, ["init", "-b", "main", repositoryPath]);
  await runGit(repositoryPath, ["config", "user.name", "Ada Author"]);
  await runGit(repositoryPath, ["config", "user.email", "ada@example.test"]);
  await writeFile(
    nodePath.join(repositoryPath, "story.txt"),
    "alpha\nshared\n",
  );
  await runGit(repositoryPath, ["add", "story.txt"]);
  const initialSha = await commit(repositoryPath, "initial story");
  await runGit(repositoryPath, ["mv", "story.txt", "renamed.txt"]);
  const renameSha = await commit(repositoryPath, "rename story");
  return { root, repositoryPath, initialSha, renameSha };
}

async function commit(
  repositoryPath: string,
  subject: string,
): Promise<string> {
  await runGit(repositoryPath, ["commit", "-m", subject]);
  return (await runGit(repositoryPath, ["rev-parse", "HEAD"])).trim();
}

async function runGit(
  repositoryPath: string,
  argumentsPassed: readonly string[],
): Promise<string> {
  const result = await executeFile("git", argumentsPassed, {
    cwd: repositoryPath,
  });
  return result.stdout;
}
