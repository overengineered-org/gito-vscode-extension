import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
}));

import {
  ConflictExperienceController,
  type ConflictExperienceUi,
} from "../../../src/extension/conflictExperience/index.js";
import { ConflictService } from "../../../src/extension/conflicts/index.js";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import type * as vscode from "vscode";

function createConflictService(
  gitCommandRunner: NodeGitCommandRunner,
): ConflictService {
  return new ConflictService(gitCommandRunner, {
    isWorkspaceTrusted: () => true,
    assertTrusted: () => undefined,
  });
}

const executeFile = promisify(execFile);
const fixtureDirectories: string[] = [];

afterEach(async () => {
  while (fixtureDirectories.length > 0) {
    const fixtureDirectory = fixtureDirectories.pop();
    if (fixtureDirectory !== undefined) {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }
});

describe("real Git conflict experience", () => {
  it("rejects a stale Keep Current choice and leaves unrelated staged work intact", async () => {
    const repository = await createConflictRepository();
    await writeFile(path.join(repository, "unrelated.txt"), "leave staged\n");
    await runGit(repository, ["add", "unrelated.txt"]);
    const errors: string[] = [];
    const ui = createWorkflowUi({
      resolutionLabel: "Keep Current",
      beforeApply: async () => {
        await writeFile(
          path.join(repository, "conflict.txt"),
          "changed after preview\n",
        );
      },
      onError: (message) => errors.push(message),
    });
    const service = createConflictService(new NodeGitCommandRunner());
    await new ConflictExperienceController(service, ui).open(repository);

    expect(errors.join("\n")).toContain("repository changed after the preview");
    expect(
      await runGit(repository, ["diff", "--cached", "--name-only"]),
    ).toContain("unrelated.txt");
    expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
  });

  it("applies only selected paths and preserves unrelated staged work", async () => {
    const repository = await createConflictRepository();
    await writeFile(path.join(repository, "unrelated.txt"), "leave staged\n");
    await runGit(repository, ["add", "unrelated.txt"]);
    const ui = createWorkflowUi({ resolutionLabel: "Keep Current" });
    const service = createConflictService(new NodeGitCommandRunner());
    await new ConflictExperienceController(service, ui).open(repository);

    expect(await readFile(path.join(repository, "conflict.txt"), "utf8")).toBe(
      "current\n",
    );
    expect(await runGit(repository, ["ls-files", "-u"])).toBe("");
    expect(await runGit(repository, ["diff", "--cached", "--name-only"])).toBe(
      "unrelated.txt\n",
    );
  }, 10_000);

  it("aborts through the native operation banner and restores the pre-merge tree", async () => {
    const repository = await createConflictRepository();
    const ui = createWorkflowUi({
      operationLabel: "Abort Operation",
      operationConfirmation: "Abort operation",
    });
    const service = createConflictService(new NodeGitCommandRunner());
    await new ConflictExperienceController(service, ui).open(repository);

    expect(await runGit(repository, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(repository, "conflict.txt"), "utf8")).toBe(
      "current\n",
    );
    expect((await service.inspect(repository)).operation).toBeUndefined();
  });
});

function createWorkflowUi(options: {
  readonly resolutionLabel?: "Keep Current";
  readonly operationLabel?: "Abort Operation";
  readonly operationConfirmation?: "Abort operation";
  readonly beforeApply?: () => Promise<void>;
  readonly onError?: (message: string) => void;
}): ConflictExperienceUi {
  const quickPickSelection = <T extends vscode.QuickPickItem>(
    items: readonly T[],
    pickerOptions: vscode.QuickPickOptions,
  ): T | readonly T[] | undefined => {
    if (pickerOptions.title === "Conflict Story") {
      const wantedLabel = options.operationLabel ?? "Resolve selected files";
      return items.find((item) => item.label === wantedLabel);
    }
    if (pickerOptions.title === "Select conflict files") {
      const fileItem = items.find((item) => item.label === "conflict.txt");
      return fileItem === undefined ? [] : [fileItem];
    }
    const wantedLabel = options.resolutionLabel ?? "Keep Current";
    return items.find((item) => item.label === wantedLabel);
  };
  return {
    showQuickPick: <T extends vscode.QuickPickItem>(
      items: readonly T[],
      pickerOptions: vscode.QuickPickOptions,
    ) => {
      const selected = quickPickSelection(items, pickerOptions);
      return Promise.resolve(selected);
    },
    showInputBox: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: async (message, _messageOptions, ...items) => {
      if (
        message.startsWith("Merge conflict") &&
        options.beforeApply !== undefined
      ) {
        await options.beforeApply();
      }
      if (options.operationConfirmation !== undefined) {
        return items.find((item) => item === options.operationConfirmation);
      }
      return items.find((item) => item === "Apply resolution");
    },
    showErrorMessage: (message) => {
      options.onError?.(message);
      return Promise.resolve(undefined);
    },
    showPreviewDocument: () => Promise.resolve(),
    withProgress: (_progressOptions, task) =>
      Promise.resolve(
        task(
          { report: () => undefined },
          {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined }),
          },
        ),
      ),
    executeCommand: () => Promise.resolve(undefined),
    openTextDocument: () => Promise.resolve({ uri: {} as vscode.Uri }),
  };
}

async function createConflictRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "conflict.txt"), "base\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "add conflict base"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, "conflict.txt"), "incoming\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "incoming change"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "conflict.txt"), "current\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "current change"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(
    path.join("/tmp", "gito-conflict-experience-"),
  );
  fixtureDirectories.push(repository);
  await runGit(repository, ["init", "-b", "main"]);
  await runGit(repository, [
    "config",
    "user.name",
    "Conflict Experience Fixture",
  ]);
  await runGit(repository, [
    "config",
    "user.email",
    "conflict-experience@example.test",
  ]);
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await runGit(repository, ["add", "README.md"]);
  await runGit(repository, ["commit", "-m", "initial fixture"]);
  return repository;
}

async function runGit(
  repository: string,
  gitArguments: readonly string[],
): Promise<string> {
  const result = await executeFile("git", [...gitArguments], {
    cwd: repository,
    shell: false,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function runGitAllowFailure(
  repository: string,
  gitArguments: readonly string[],
): Promise<void> {
  try {
    await runGit(repository, gitArguments);
  } catch {
    // Expected for the deliberately interrupted merge.
  }
}
