import { describe, expect, it, vi } from "vitest";
import type {
  GitOperationPreview,
  GitOperationResult,
} from "../../../src/extension/operations/index.js";
import { OperationsExperienceController } from "../../../src/extension/operationsExperience/operationsExperienceController.js";
import type {
  OperationsExperienceUi,
  OperationsServiceApi,
} from "../../../src/extension/operationsExperience/operationsExperienceModels.js";

const repositoryRoot = "/tmp/gito-operations-experience";
const trustedWorkspaceGuard = {
  runTrustedMutation: async <Result>(
    _operationName: string,
    mutation: () => Promise<Result> | Result,
  ): Promise<Result> => mutation(),
};

describe("OperationsExperienceController", () => {
  it("previews, confirms, rereads selection, then executes in that order", async () => {
    const eventLog: string[] = [];
    const preview = createPreview();
    const result = createResult(preview);
    const operations = createOperations({
      previewTagCreate: vi.fn(() => {
        eventLog.push("preview");
        return Promise.resolve(preview);
      }),
      createConfirmation: vi.fn(() => {
        eventLog.push("confirmation-token");
        return {
          confirmationToken: preview.confirmationPlan.confirmationToken,
          repositoryRoot,
          acknowledged: true as const,
        };
      }),
      execute: vi.fn(() => {
        eventLog.push("execute");
        return Promise.resolve(result);
      }),
    });
    const ui = createUi({
      quickPickSelections: ["tags", "create"],
      inputValues: ["release/1", "HEAD", "release notes"],
      warningResult: "Confirm operation",
      eventLog,
    });
    const repositoryProvider = {
      getRepositoryRoot: vi.fn(() => {
        eventLog.push("read-selected-repository");
        return Promise.resolve(repositoryRoot);
      }),
    };
    const controller = new OperationsExperienceController({
      operations,
      repositoryProvider,
      ui,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });

    await controller.open();

    expect(eventLog).toEqual([
      "read-selected-repository",
      "preview",
      "read-selected-repository",
      "confirmation-token",
      "execute",
    ]);
    expect(operations.previewTagCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryRoot,
        expectedRepositoryRoot: repositoryRoot,
        tagName: "release/1",
        target: "HEAD",
        annotatedMessage: "release notes",
      }),
    );
    expect(ui.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Readback: verified"),
    );
    expect(ui.cancellationListenerDisposals()).toBe(2);
  });

  it("never executes after an explicit confirmation cancel", async () => {
    const preview = createPreview();
    const execute = vi.fn(() => Promise.resolve(createResult(preview)));
    const operations = createOperations({
      previewTagCreate: vi.fn(() => Promise.resolve(preview)),
      execute,
    });
    const ui = createUi({
      quickPickSelections: ["tags", "delete"],
      inputValues: ["release/old"],
      warningResult: "Cancel",
    });
    const controller = new OperationsExperienceController({
      operations,
      repositoryProvider: {
        getRepositoryRoot: vi.fn(() => Promise.resolve(repositoryRoot)),
      },
      ui,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });

    await controller.open();

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects stale repository selection after preview without executing", async () => {
    const preview = createPreview();
    const execute = vi.fn(() => Promise.resolve(createResult(preview)));
    const operations = createOperations({
      previewTagCreate: vi.fn(() => Promise.resolve(preview)),
      execute,
    });
    const ui = createUi({
      quickPickSelections: ["tags", "delete"],
      inputValues: ["release/old"],
      warningResult: "Confirm operation",
    });
    const getRepositoryRoot = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(repositoryRoot)
      .mockResolvedValueOnce("/tmp/another-repository");
    const controller = new OperationsExperienceController({
      operations,
      repositoryProvider: { getRepositoryRoot },
      ui,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });

    await controller.open();

    expect(execute).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("selection became stale"),
    );
  });

  it("blocks the entire center in an untrusted workspace", async () => {
    const ui = createUi({ trusted: false });
    const getRepositoryRoot = vi.fn(() => Promise.resolve(repositoryRoot));
    const controller = new OperationsExperienceController({
      operations: createOperations(),
      repositoryProvider: { getRepositoryRoot },
      ui,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });

    await controller.open();

    expect(getRepositoryRoot).not.toHaveBeenCalled();
    expect(ui.showQuickPick).not.toHaveBeenCalled();
    expect(ui.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("untrusted workspace"),
      { modal: true },
      "Manage Workspace Trust",
      "Cancel",
    );
  });

  it("names the active merge, cherry-pick, revert, and rebase action in progress", async () => {
    for (const operation of [
      "merge",
      "cherry-pick",
      "revert",
      "rebase",
    ] as const) {
      const progressTitles: string[] = [];
      const ui = createUi({
        quickPickSelections: ["continue"],
        warningResult: "Confirm operation",
        progressTitles,
      });
      const controller = new OperationsExperienceController({
        operations: createOperations(),
        repositoryProvider: {
          getRepositoryRoot: vi.fn(() => Promise.resolve(repositoryRoot)),
        },
        stateReader: {
          read: vi.fn(() =>
            Promise.resolve({
              repositoryRoot,
              operation,
              summary: `${operation} in progress`,
            }),
          ),
        },
        ui,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });

      await controller.open();

      expect(progressTitles).toContain(
        `Preparing ${capitalize(operation)} continue preview`,
      );
    }
  });
});

function createOperations(
  overrides: Partial<OperationsServiceApi> = {},
): OperationsServiceApi {
  const operationNames = [
    "previewStashCreate",
    "previewStashList",
    "previewStashInspect",
    "previewStashApply",
    "previewStashPop",
    "previewStashDrop",
    "previewStashBranch",
    "previewTagCreate",
    "previewTagDelete",
    "previewTagPush",
    "previewMerge",
    "previewMergeContinue",
    "previewMergeAbort",
    "previewCherryPick",
    "previewCherryPickContinue",
    "previewCherryPickAbort",
    "previewRevert",
    "previewRevertContinue",
    "previewRevertAbort",
    "previewReset",
    "previewRebaseStart",
    "previewRebaseContinue",
    "previewRebaseSkip",
    "previewRebaseAbort",
    "previewBranchRename",
    "previewBranchUpstream",
    "previewRemoteAdd",
    "previewRemoteRename",
    "previewRemoteRemove",
    "previewRemotePrune",
    "previewFetch",
    "previewPull",
    "previewPush",
    "previewPatchCreate",
    "previewPatchApply",
    "previewBisectStart",
    "previewBisectGood",
    "previewBisectBad",
    "previewBisectSkip",
    "previewBisectReset",
    "previewReflogList",
    "previewReflogRecover",
    "previewClean",
    "previewCleanExecute",
  ] as const;
  const fallbackPreview = vi.fn(() => Promise.resolve(createPreview()));
  const operationMethods = Object.fromEntries(
    operationNames.map((operationName) => [operationName, fallbackPreview]),
  ) as Partial<OperationsServiceApi>;
  return {
    ...(operationMethods as OperationsServiceApi),
    createConfirmation: vi.fn((preview: GitOperationPreview) => ({
      confirmationToken: preview.confirmationPlan.confirmationToken,
      repositoryRoot: preview.repositoryRoot,
      acknowledged: true as const,
    })),
    execute: vi.fn((preview: GitOperationPreview) =>
      Promise.resolve(createResult(preview)),
    ),
    ...overrides,
  };
}

function createPreview(): GitOperationPreview {
  return {
    operation: "tag.create",
    repositoryRoot,
    displayArguments: ["tag", "release/1", "HEAD"],
    destructive: true,
    state: {
      repositoryRoot,
      headCommit: "0123456789012345678901234567890123456789",
      headRef: "main",
      isClean: true,
      hasConflicts: false,
      statusPorcelain: "",
    },
    preconditions: [],
    confirmationPlan: {
      confirmationToken: "unit-confirmation-token",
      operation: "tag.create",
      repositoryRoot,
      summary: "Create tag release/1.",
      consequences: ["Tag release/1 resolves to HEAD."],
      cancellationSupported: true,
    },
    expectedPostcondition: "Tag release/1 resolves to HEAD.",
    generatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function createResult(preview: GitOperationPreview): GitOperationResult {
  return {
    operation: preview.operation,
    repositoryRoot,
    standardOutput: "",
    standardError: "",
    postcondition: {
      verified: true,
      description: preview.expectedPostcondition,
      state: preview.state,
    },
    rolledBack: false,
  };
}

function createUi(
  options: {
    readonly quickPickSelections?: readonly string[];
    readonly inputValues?: readonly string[];
    readonly warningResult?: string;
    readonly trusted?: boolean;
    readonly eventLog?: string[];
    readonly progressTitles?: string[];
  } = {},
): OperationsExperienceUi & {
  readonly showErrorMessage: ReturnType<typeof vi.fn>;
  readonly showWarningMessage: ReturnType<typeof vi.fn>;
  readonly cancellationListenerDisposals: () => number;
} {
  const quickPickSelections = [...(options.quickPickSelections ?? [])];
  const inputValues = [...(options.inputValues ?? [])];
  const eventLog = options.eventLog;
  const progressTitles = options.progressTitles;
  let cancellationListenerDisposalCount = 0;
  const showQuickPick = vi.fn(
    (items: readonly { readonly id?: string; readonly action?: string }[]) => {
      const nextSelection = quickPickSelections.shift();
      if (nextSelection === undefined) return Promise.resolve(undefined);
      return Promise.resolve(
        items.find(
          (item) => item.action === nextSelection || item.id === nextSelection,
        ),
      );
    },
  );
  const showWarningMessage = vi.fn(() =>
    Promise.resolve(options.warningResult),
  );
  const showInputBox = vi.fn(() => Promise.resolve(inputValues.shift()));
  const showInformationMessage = vi.fn(() => Promise.resolve(undefined));
  const showErrorMessage = vi.fn((message: string) => {
    eventLog?.push(`error:${message}`);
    return Promise.resolve(undefined);
  });
  const showPreviewDocument = vi.fn(() => Promise.resolve());
  const withProgress = vi.fn(
    (
      progressOptions: { readonly title?: string },
      task: (
        progress: { readonly report: () => void },
        cancellationToken: ReturnType<typeof createCancellationToken>,
      ) => Promise<unknown>,
    ) => {
      if (progressOptions.title !== undefined)
        progressTitles?.push(progressOptions.title);
      return task(
        { report: () => undefined },
        createCancellationToken(() => {
          cancellationListenerDisposalCount += 1;
        }),
      );
    },
  );
  const executeCommand = vi.fn(() => Promise.resolve(undefined));
  return {
    isWorkspaceTrusted: () => options.trusted ?? true,
    showQuickPick: showQuickPick as OperationsExperienceUi["showQuickPick"],
    showInputBox,
    showWarningMessage,
    showInformationMessage,
    showErrorMessage,
    showPreviewDocument,
    withProgress: withProgress as OperationsExperienceUi["withProgress"],
    executeCommand,
    cancellationListenerDisposals: () => cancellationListenerDisposalCount,
  };
}

function capitalize(operation: string): string {
  return operation === "cherry-pick"
    ? "Cherry-pick"
    : operation.charAt(0).toUpperCase() + operation.slice(1);
}

function createCancellationToken(onDispose: () => void = () => undefined): {
  readonly isCancellationRequested: false;
  readonly onCancellationRequested: () => { dispose: () => void };
} {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: onDispose }),
  };
}
