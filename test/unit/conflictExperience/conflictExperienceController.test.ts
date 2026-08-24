/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, expect, it, vi } from "vitest";
import {
  ConflictExperienceController,
  createVscodeConflictExperienceUi,
} from "../../../src/extension/conflictExperience/index.js";
import type { ConflictExperienceUi } from "../../../src/extension/conflictExperience/index.js";
import type {
  ConflictFileState,
  ConflictRepositorySnapshot,
  ConflictResolutionPlan,
} from "../../../src/extension/conflicts/index.js";
import type * as vscode from "vscode";

const conflictPreviewVscodeMocks = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  showTextDocument: vi.fn(),
  parseUri: vi.fn((value: string) => ({
    toString: () => value,
  })),
}));

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  Uri: { parse: conflictPreviewVscodeMocks.parseUri },
  workspace: {
    openTextDocument: conflictPreviewVscodeMocks.openTextDocument,
    onDidCloseTextDocument: conflictPreviewVscodeMocks.onDidCloseTextDocument,
    registerTextDocumentContentProvider:
      conflictPreviewVscodeMocks.registerTextDocumentContentProvider,
  },
  window: { showTextDocument: conflictPreviewVscodeMocks.showTextDocument },
}));

describe("conflict experience controller", () => {
  it("preserves a sanitized descriptive title in a read-only native preview tab", async () => {
    const documentUri = {
      toString: () => "gito-conflict-preview:/preview.txt",
    };
    const document = { uri: documentUri };
    conflictPreviewVscodeMocks.openTextDocument.mockResolvedValue(document);
    const ui = createVscodeConflictExperienceUi();

    await ui.showPreviewDocument({
      title: "Git'o merge / conflict\nresolution preview",
      content: "exact preview bytes",
    });

    expect(
      conflictPreviewVscodeMocks.registerTextDocumentContentProvider,
    ).toHaveBeenCalledWith(
      "gito-conflict-preview",
      expect.objectContaining({
        provideTextDocumentContent: expect.any(Function),
      }),
    );
    const [previewUri] =
      conflictPreviewVscodeMocks.parseUri.mock.calls[0] ?? [];
    expect(previewUri).toBe(
      "gito-conflict-preview:/Git'o%20merge%20-%20conflict%20resolution%20preview-1.txt",
    );
    expect(conflictPreviewVscodeMocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        toString: expect.any(Function),
      }),
    );
    expect(conflictPreviewVscodeMocks.showTextDocument).toHaveBeenCalledWith(
      document,
      { preview: false, preserveFocus: false },
    );
  });

  it("disposes preview resources once and clears retained preview content", async () => {
    const documentUri = {
      scheme: "gito-conflict-preview",
      toString: () => "gito-conflict-preview:/preview-1.txt",
    };
    conflictPreviewVscodeMocks.parseUri.mockReturnValue(documentUri);
    conflictPreviewVscodeMocks.openTextDocument.mockResolvedValue({
      uri: documentUri,
    });
    const ui = createVscodeConflictExperienceUi();

    await ui.showPreviewDocument({
      title: "Preview",
      content: "retained preview bytes",
    });

    const providerRegistration = (
      conflictPreviewVscodeMocks.registerTextDocumentContentProvider.mock
        .results as unknown as readonly {
        readonly value: { readonly dispose: ReturnType<typeof vi.fn> };
      }[]
    ).at(-1)?.value;
    const registeredProvider = (
      conflictPreviewVscodeMocks.registerTextDocumentContentProvider.mock
        .calls as unknown as ReadonlyArray<
        readonly [
          string,
          {
            readonly provideTextDocumentContent: (uri: {
              toString(): string;
            }) => string;
          },
        ]
      >
    ).at(-1)?.[1];
    const closeListener = (
      conflictPreviewVscodeMocks.onDidCloseTextDocument.mock
        .calls as unknown as ReadonlyArray<
        readonly [(document: { uri: typeof documentUri }) => void]
      >
    ).at(-1)?.[0];
    const closeListenerRegistration = (
      conflictPreviewVscodeMocks.onDidCloseTextDocument.mock
        .results as unknown as readonly {
        readonly value: { readonly dispose: ReturnType<typeof vi.fn> };
      }[]
    ).at(-1)?.value;

    if (
      providerRegistration === undefined ||
      registeredProvider === undefined ||
      closeListener === undefined ||
      closeListenerRegistration === undefined
    ) {
      throw new Error("Conflict preview mocks were not registered");
    }

    expect(registeredProvider.provideTextDocumentContent(documentUri)).toBe(
      "retained preview bytes",
    );
    const controller = new ConflictExperienceController(
      {} as never,
      createUi({ quickPickTitles: [], choices: {} }),
    );

    controller.dispose();
    controller.dispose();

    expect(providerRegistration.dispose).toHaveBeenCalledOnce();
    expect(closeListenerRegistration.dispose).toHaveBeenCalledOnce();
    expect(registeredProvider.provideTextDocumentContent(documentUri)).toBe("");
    closeListener({ uri: documentUri });
    expect(registeredProvider.provideTextDocumentContent(documentUri)).toBe("");
  });

  it("uses exact native labels, requires explicit apply, and preserves a recovery plan", async () => {
    const snapshot = createSnapshot();
    const plan = createPlan(snapshot);
    const inspect = vi.fn(() => Promise.resolve(snapshot));
    const previewResolutions = vi.fn(() => Promise.resolve(plan));
    const applyResolution = vi.fn(
      async (
        receivedPlan: ConflictResolutionPlan,
        confirmation: {
          readonly confirm: (preview: string) => Promise<boolean>;
        },
      ) => {
        if (!(await confirmation.confirm(receivedPlan.preview))) {
          throw new Error("cancelled");
        }
        return {
          appliedPaths: ["conflict.txt"],
          rollback: plan.rollback,
          snapshotAfterApply: { ...snapshot, hasUnmergedEntries: false },
        };
      },
    );
    const service = {
      inspect,
      previewResolutions,
      applyResolution,
      createMergeEditorCommand: vi.fn(),
    } as never;
    const warningMessages: string[] = [];
    const errorMessages: string[] = [];
    const quickPickTitles: string[] = [];
    const confirmationEvents: string[] = [];
    const ui = createUi({
      quickPickTitles,
      choices: {
        "Conflict Story": "Resolve selected files",
        "Select conflict files": "conflict.txt",
        "Resolve 1 selected file": "Keep Current",
      },
      onWarningMessage: (message) => {
        confirmationEvents.push("warning");
        warningMessages.push(message);
        return "Apply resolution";
      },
      onPreviewDocument: () => confirmationEvents.push("preview"),
      onErrorMessage: (message) => {
        errorMessages.push(message);
      },
    });

    await new ConflictExperienceController(service, ui).open("/repo");

    expect(quickPickTitles).toEqual([
      "Conflict Story",
      "Select conflict files",
      "Resolve 1 selected file",
    ]);
    expect(previewResolutions).toHaveBeenCalledWith(
      "/repo",
      [{ path: "conflict.txt", choice: "keep-current" }],
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    );
    expect(errorMessages).toEqual([]);
    expect(warningMessages).toHaveLength(1);
    expect(warningMessages[0]).toContain(
      "Recovery plan saved for this resolution.",
    );
    expect(warningMessages[0]).toContain(
      "Only the selected paths will change and be staged.",
    );
    expect(confirmationEvents).toEqual(["preview", "warning"]);
    expect(applyResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSnapshotFingerprint: snapshot.fingerprint,
        preview: expect.stringContaining("Recovery plan saved"),
      }),
      expect.objectContaining({ confirm: expect.any(Function) }),
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    );
  });

  it("opens native VS Code diffs and merge editor, never a custom HTML renderer", async () => {
    const snapshot = createSnapshot();
    const plan = createPlan(snapshot);
    const executeCommand = vi.fn(() => Promise.resolve(undefined));
    const errorMessages: string[] = [];
    const openTextDocument = vi
      .fn()
      .mockResolvedValueOnce({ uri: { toString: () => "untitled:base" } })
      .mockResolvedValueOnce({ uri: { toString: () => "untitled:current" } });
    const service = {
      inspect: vi.fn(() => Promise.resolve(snapshot)),
      previewResolutions: vi.fn(() => Promise.resolve(plan)),
      createMergeEditorCommand: vi.fn(() => ({
        commandIdentifier: "git.openMergeEditor",
        arguments: ["file:///repo/conflict.txt"] as const,
      })),
    } as never;
    const quickPickTitles: string[] = [];
    const ui = createUi({
      executeCommand,
      openTextDocument,
      quickPickTitles,
      choices: {
        "Conflict Story": "Resolve selected files",
        "Select conflict files": "conflict.txt",
        "Resolve 1 selected file": "Preview Base ↔ Current",
      },
      onErrorMessage: (message) => {
        errorMessages.push(message);
      },
    });

    await new ConflictExperienceController(service, ui).open("/repo");

    expect(quickPickTitles).toEqual([
      "Conflict Story",
      "Select conflict files",
      "Resolve 1 selected file",
    ]);
    expect(openTextDocument).toHaveBeenCalledTimes(2);
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      expect.stringContaining(
        "Base (common ancestor) ↔ Current (checked-out branch)",
      ),
    );
    expect(errorMessages).toEqual([]);
    expect(executeCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("html"),
      expect.anything(),
    );
  });

  it("bounds destructive conflict modal text while opening the full exact preview", async () => {
    const snapshot = createSnapshot();
    const plan = createPlan(snapshot);
    const longPlan: ConflictResolutionPlan = {
      ...plan,
      preview: `${plan.preview}\n${"exact detail ".repeat(2_000)}`,
      rollback: {
        ...plan.rollback,
        warning: "rollback warning ".repeat(500),
        commandPlan: [`git rollback ${"path ".repeat(500)}`],
      },
    };
    const warningMessages: string[] = [];
    const previewDocuments: string[] = [];
    const service = {
      inspect: vi.fn(() => Promise.resolve(snapshot)),
      previewResolutions: vi.fn(() => Promise.resolve(longPlan)),
      applyResolution: vi.fn(
        async (
          _receivedPlan: ConflictResolutionPlan,
          confirmation: {
            readonly confirm: (preview: string) => Promise<boolean>;
          },
        ) => {
          await confirmation.confirm(longPlan.preview);
          return {
            appliedPaths: ["conflict.txt"],
            rollback: longPlan.rollback,
            snapshotAfterApply: { ...snapshot, hasUnmergedEntries: false },
          };
        },
      ),
    } as never;
    const ui = createUi({
      quickPickTitles: [],
      choices: {
        "Conflict Story": "Resolve selected files",
        "Select conflict files": "conflict.txt",
        "Resolve 1 selected file": "Keep Current",
      },
      onWarningMessage: (message) => {
        warningMessages.push(message);
        return "Apply resolution";
      },
      onPreviewDocument: ({ content }) => previewDocuments.push(content),
    });

    await new ConflictExperienceController(service, ui).open("/repo");

    expect(previewDocuments[0]).toContain("exact detail");
    expect(warningMessages).toHaveLength(1);
    expect(warningMessages[0]?.split("\n").length).toBeLessThanOrEqual(12);
    expect(
      new TextEncoder().encode(warningMessages[0] ?? "").byteLength,
    ).toBeLessThanOrEqual(2048);
    expect(warningMessages[0]).toContain("Merge conflict resolution");
    expect(warningMessages[0]).toContain("Recovery plan saved");
  });

  it("aborts an in-flight inspection when the controller is disposed", async () => {
    let receivedSignal: AbortSignal | undefined;
    const service = {
      inspect: vi.fn(
        async (
          _repositoryRoot: string,
          options: { cancellationSignal?: AbortSignal },
        ) => {
          receivedSignal = options.cancellationSignal;
          await new Promise<never>((_resolve, reject) => {
            options.cancellationSignal?.addEventListener("abort", () =>
              reject(new DOMException("cancelled", "AbortError")),
            );
          });
        },
      ),
    } as never;
    const errorMessages: string[] = [];
    const controller = new ConflictExperienceController(
      service,
      createUi({
        quickPickTitles: [],
        choices: {},
        onErrorMessage: (message) => errorMessages.push(message),
      }),
    );
    const openPromise = controller.open("/repo");
    await Promise.resolve();
    controller.dispose();
    await expect(openPromise).resolves.toBeUndefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(errorMessages).toEqual([]);
  });

  it("does not show user cancellation as an error", async () => {
    const errorMessages: string[] = [];
    const service = {
      inspect: vi.fn(() =>
        Promise.reject(new DOMException("cancelled", "AbortError")),
      ),
    } as never;
    await new ConflictExperienceController(
      service,
      createUi({
        quickPickTitles: [],
        choices: {},
        onErrorMessage: (message) => errorMessages.push(message),
      }),
    ).open("/repo");
    expect(errorMessages).toEqual([]);
  });
});

function createUi(overrides: {
  readonly quickPickTitles: string[];
  readonly choices: Readonly<Record<string, string>>;
  readonly onWarningMessage?: (message: string) => string | undefined;
  readonly onErrorMessage?: (message: string) => void;
  readonly onPreviewDocument?: (options: {
    readonly title: string;
    readonly content: string;
  }) => void;
  readonly executeCommand?: (
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ) => Promise<unknown>;
  readonly openTextDocument?: (options: {
    readonly content: string;
    readonly language: string;
  }) => Promise<{ readonly uri: vscode.Uri }>;
}): ConflictExperienceUi {
  const showQuickPick = <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ): Promise<T | readonly T[] | undefined> => {
    const title = options.title ?? "";
    overrides.quickPickTitles.push(title);
    const selectedLabel = overrides.choices[title];
    const selectedItem = items.find((item) => item.label === selectedLabel);
    if (options.canPickMany === true) {
      return Promise.resolve(selectedItem === undefined ? [] : [selectedItem]);
    }
    return Promise.resolve(selectedItem);
  };
  return {
    showQuickPick,
    showInputBox: vi.fn(() => Promise.resolve(undefined)),
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn((message: string) =>
      Promise.resolve(overrides.onWarningMessage?.(message)),
    ),
    showErrorMessage: vi.fn((message: string) => {
      overrides.onErrorMessage?.(message);
      return Promise.resolve(undefined);
    }),
    showPreviewDocument: vi.fn(
      (options: { readonly title: string; readonly content: string }) => {
        overrides.onPreviewDocument?.(options);
        return Promise.resolve();
      },
    ),
    withProgress: vi.fn((_options, task) =>
      Promise.resolve(
        task(
          { report: vi.fn() },
          {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
          },
        ),
      ),
    ),
    executeCommand:
      overrides.executeCommand ?? vi.fn(() => Promise.resolve(undefined)),
    openTextDocument:
      overrides.openTextDocument ??
      vi.fn(() => Promise.resolve({ uri: {} as vscode.Uri })),
  };
}

function createSnapshot(): ConflictRepositorySnapshot {
  return {
    repositoryRoot: "/repo",
    fingerprint: "fingerprint",
    headCommit: "head",
    currentBranchName: "main",
    operation: {
      kind: "merge",
      label: "Merge conflict",
      sourceDescription:
        "The branch or commit being merged into the checked-out branch.",
      sourceCommit: "incoming",
      metadataPath: "/repo/.git/MERGE_HEAD",
      canAbort: true,
    },
    files: [createFile()],
    hasUnmergedEntries: true,
    canContinue: false,
    continueReason: "Resolve and stage every conflict before continuing.",
    canAbort: true,
    abortReason: undefined,
  };
}

function createFile(): ConflictFileState {
  return {
    path: "conflict.txt",
    originalPath: undefined,
    statusCode: "UU",
    kind: "content",
    stages: {
      base: {
        side: "base",
        objectId: "base",
        mode: "100644",
        exists: true,
        kind: "text",
        content: Buffer.from("base\n"),
      },
      current: {
        side: "current",
        objectId: "current",
        mode: "100644",
        exists: true,
        kind: "text",
        content: Buffer.from("current\n"),
      },
      incoming: {
        side: "incoming",
        objectId: "incoming",
        mode: "100644",
        exists: true,
        kind: "text",
        content: Buffer.from("incoming\n"),
      },
    },
    workingTreeContent: Buffer.from("markers\n"),
    isResolved: false,
  };
}

function createPlan(
  snapshot: ConflictRepositorySnapshot,
): ConflictResolutionPlan {
  return {
    repositoryRoot: snapshot.repositoryRoot,
    expectedSnapshotFingerprint: snapshot.fingerprint,
    operation: "merge",
    requests: [{ path: "conflict.txt", choice: "keep-current" }],
    actions: [
      {
        type: "checkout-side",
        side: "current",
        path: "conflict.txt",
        explanation: "Use Current",
      },
    ],
    stagedPaths: ["conflict.txt"],
    preview: "Merge conflict\n- conflict.txt: Current",
    requiresManualEditing: false,
    rollback: {
      repositoryRoot: snapshot.repositoryRoot,
      sourceSnapshotFingerprint: snapshot.fingerprint,
      files: [],
      commandPlan: ["git reset -- conflict.txt"],
      warning: "Review the repository before rollback.",
    },
  };
}
