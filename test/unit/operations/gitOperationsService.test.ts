import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveGitRootBinding,
  type GitCommandOutput,
  type GitCommandRequest,
  type GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import {
  GitOperationsService,
  MAX_PENDING_OPERATION_COUNT,
  PENDING_OPERATION_TTL_MILLISECONDS,
} from "../../../src/extension/operations/gitOperationsService.js";

const trustedWorkspaceGuard = {
  isWorkspaceTrusted: () => true,
  assertTrusted: () => undefined,
};
const executeFile = promisify(execFile);
const testRootBindingResolver = new GitRootBindingResolver(() =>
  Promise.resolve(
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git",
  ),
);

describe("GitOperationsService safety boundary", () => {
  beforeEach(async () => {
    await mkdir("/tmp/gito-unit-repository", { recursive: true });
    await executeFile("git", ["init", "--quiet", "/tmp/gito-unit-repository"]);
  });

  afterEach(async () => {
    await rm("/tmp/gito-unit-repository", { recursive: true, force: true });
  });

  it("propagates the configured Git executable into root binding resolution", async () => {
    const configuredGitExecutablePath =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\cmd\\git.exe"
        : "/usr/bin/git";
    const observedExecutablePaths: string[] = [];
    const configuredResolver = new GitRootBindingResolver(
      () => Promise.resolve(configuredGitExecutablePath),
      {
        resolveRootBinding: (repositoryRoot, expectedIdentity, options) => {
          observedExecutablePaths.push(options?.gitExecutablePath ?? "");
          return resolveGitRootBinding(
            repositoryRoot,
            expectedIdentity,
            options,
          );
        },
      },
    );
    const operations = new GitOperationsService({
      commandRunner: new RecordingCommandRunner(),
      gitRootBindingResolver: configuredResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });

    await operations.previewTagCreate({
      repositoryRoot: "/tmp/gito-unit-repository",
      tagName: "configured-git",
    });

    expect(observedExecutablePaths.length).toBeGreaterThan(0);
    expect(
      observedExecutablePaths.every(
        (executablePath) => executablePath === configuredGitExecutablePath,
      ),
    ).toBe(true);
  });

  it("rejects unsafe refs before invoking the command runner", async () => {
    const commandRunner = new RecordingCommandRunner();
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    await expect(
      Promise.resolve().then(() =>
        operations.previewTagCreate({
          repositoryRoot: "/tmp/gito-unit-repository",
          tagName: "unsafe ref",
        }),
      ),
    ).rejects.toThrow(/whitespace/i);
    expect(commandRunner.requests).toHaveLength(0);
  });

  it("requires the exact preview token and repository binding", async () => {
    const commandRunner = new RecordingCommandRunner();
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    const preview = await operations.previewTagCreate({
      repositoryRoot: "/tmp/gito-unit-repository",
      tagName: "fixture/unit",
    });
    await expect(
      operations.execute(preview, {
        confirmationToken: "wrong-token",
        repositoryRoot: preview.repositoryRoot,
        acknowledged: true,
      }),
    ).rejects.toThrow(/matching explicit confirmation/i);
    await expect(
      operations.execute(preview, {
        confirmationToken: preview.confirmationPlan.confirmationToken,
        repositoryRoot: "/tmp/another-repository",
        acknowledged: true,
      }),
    ).rejects.toThrow(/different repository/i);
  });

  it("rejects credentials embedded in remote URLs before Git", async () => {
    const commandRunner = new RecordingCommandRunner();
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    for (const remoteUrl of [
      "https://token@example.test/repo.git",
      "https://user:password@example.test/repo.git",
      "ssh://git:password@example.test/repo.git",
      "https://example.test/repo.git?access_token=secret",
      "https://example.test/repo.git#client_secret=secret",
      "https://example.test/repo.git?sig=secret",
      "https://example.test/repo.git?signature=secret",
      "https://example.test/repo.git?x-amz-signature=secret",
      "https://example.test/repo.git?key=secret",
    ]) {
      await expect(
        Promise.resolve().then(() =>
          operations.previewRemoteAdd({
            repositoryRoot: "/tmp/gito-unit-repository",
            remoteName: "origin",
            remoteUrl,
          }),
        ),
      ).rejects.toThrow(/must not embed credentials/i);
    }
    expect(commandRunner.requests).toHaveLength(0);
  });

  it("accepts local repository paths as remote URLs", async () => {
    const commandRunner = new RecordingCommandRunner();
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    for (const remoteUrl of [
      "/tmp/gito-local-remote.git",
      "/tmp/gito local remote.git",
      "../gito-relative-remote.git",
      "gito-sibling-remote.git",
      "gito@local#remote?.git",
      "C:\\Users\\Example User\\gito-local-remote.git",
    ]) {
      const preview = await operations.previewRemoteAdd({
        repositoryRoot: "/tmp/gito-unit-repository",
        remoteName: "origin",
        remoteUrl,
      });
      expect(preview.displayArguments).toEqual([
        "remote",
        "add",
        "origin",
        remoteUrl,
      ]);
    }
  });

  it("expires, caps, and disposes pending confirmations", async () => {
    let currentTimeMilliseconds = 1_000;
    let tokenSequence = 0;
    const operations = new GitOperationsService({
      commandRunner: new RecordingCommandRunner(),
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
      now: () => new Date(currentTimeMilliseconds),
      randomToken: () => `confirmation-${++tokenSequence}`,
    });
    const expiringPreview = await operations.previewTagCreate({
      repositoryRoot: "/tmp/gito-unit-repository",
      tagName: "expiring-preview",
    });
    currentTimeMilliseconds += PENDING_OPERATION_TTL_MILLISECONDS;
    await expect(
      operations.execute(
        expiringPreview,
        operations.createConfirmation(expiringPreview),
      ),
    ).rejects.toThrow(/expired/i);

    const templatePreview = await operations.previewTagCreate({
      repositoryRoot: "/tmp/gito-unit-repository",
      tagName: "bounded-preview-template",
    });
    const pendingOperations = (
      operations as unknown as {
        readonly pendingOperations: Map<
          string,
          { readonly expiresAtMilliseconds: number }
        >;
      }
    ).pendingOperations;
    const templatePendingOperation = pendingOperations.get(
      templatePreview.confirmationPlan.confirmationToken,
    );
    if (templatePendingOperation === undefined)
      throw new Error("template pending operation missing");
    pendingOperations.clear();
    for (
      let pendingOperationIndex = 0;
      pendingOperationIndex < MAX_PENDING_OPERATION_COUNT;
      pendingOperationIndex++
    )
      pendingOperations.set(
        `seeded-confirmation-${pendingOperationIndex}`,
        templatePendingOperation,
      );
    const newestPreview = await operations.previewTagCreate({
      repositoryRoot: "/tmp/gito-unit-repository",
      tagName: "bounded-preview-newest",
    });
    expect(pendingOperations.size).toBe(MAX_PENDING_OPERATION_COUNT);
    expect(pendingOperations.has("seeded-confirmation-0")).toBe(false);
    expect(
      pendingOperations.has(newestPreview.confirmationPlan.confirmationToken),
    ).toBe(true);
    operations.dispose();
    expect(pendingOperations.size).toBe(0);
  });

  it("honors cancellation before repository access", async () => {
    const commandRunner = new RecordingCommandRunner();
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    const cancellationController = new AbortController();
    cancellationController.abort();
    await expect(
      operations.previewTagCreate({
        repositoryRoot: "/tmp/gito-unit-repository",
        tagName: "fixture/cancelled",
        cancellationSignal: cancellationController.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(commandRunner.requests).toHaveLength(0);
  });

  it("cancels every public mutator before it can invoke Git", async () => {
    const commandRunner = new RecordingCommandRunner();
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    const cancellationController = new AbortController();
    cancellationController.abort();
    const requestBase = {
      repositoryRoot: "/tmp/gito-unit-repository",
      cancellationSignal: cancellationController.signal,
    };
    const cancelledPreviews = [
      () => operations.previewStashCreate(requestBase),
      () =>
        operations.previewStashApply({
          ...requestBase,
          stashReference: "stash@{0}",
        }),
      () =>
        operations.previewStashPop({
          ...requestBase,
          stashReference: "stash@{0}",
        }),
      () =>
        operations.previewStashDrop({
          ...requestBase,
          stashReference: "stash@{0}",
        }),
      () =>
        operations.previewStashBranch({
          ...requestBase,
          stashReference: "stash@{0}",
          branchName: "recovered",
        }),
      () =>
        operations.previewTagCreate({ ...requestBase, tagName: "fixture/tag" }),
      () =>
        operations.previewTagDelete({ ...requestBase, tagName: "fixture/tag" }),
      () =>
        operations.previewTagPush({
          ...requestBase,
          tagName: "fixture/tag",
          remoteName: "origin",
        }),
      () => operations.previewMerge({ ...requestBase, commitish: "HEAD" }),
      () => operations.previewCherryPick({ ...requestBase, commitish: "HEAD" }),
      () => operations.previewRevert({ ...requestBase, commitish: "HEAD" }),
      () =>
        operations.previewReset({
          ...requestBase,
          commitish: "HEAD",
          mode: "hard",
        }),
      () => operations.previewRebaseStart({ ...requestBase, upstream: "HEAD" }),
      () => operations.previewRebaseContinue(requestBase),
      () => operations.previewRebaseSkip(requestBase),
      () => operations.previewRebaseAbort(requestBase),
      () =>
        operations.previewBranchRename({
          ...requestBase,
          newBranchName: "renamed",
        }),
      () =>
        operations.previewBranchUpstream({
          ...requestBase,
          remoteName: "origin",
          branchName: "main",
          setUpstream: true,
        }),
      () =>
        operations.previewRemoteAdd({
          ...requestBase,
          remoteName: "origin",
          remoteUrl: "https://example.test/repo.git",
        }),
      () =>
        operations.previewRemoteRename({
          ...requestBase,
          remoteName: "origin",
          newRemoteName: "backup",
        }),
      () =>
        operations.previewRemoteRemove({
          ...requestBase,
          remoteName: "origin",
        }),
      () =>
        operations.previewRemotePrune({ ...requestBase, remoteName: "origin" }),
      () => operations.previewFetch({ ...requestBase, remoteName: "origin" }),
      () => operations.previewPull({ ...requestBase, mode: "merge" }),
      () =>
        operations.previewPush({
          ...requestBase,
          remoteName: "origin",
          branchName: "main",
        }),
      () =>
        operations.previewPatchApply({
          ...requestBase,
          patchText: "diff --git a/a b/a\n",
        }),
      () =>
        operations.previewBisectStart({
          ...requestBase,
          goodCommits: ["HEAD"],
        }),
      () => operations.previewBisectGood(requestBase),
      () => operations.previewBisectBad(requestBase),
      () => operations.previewBisectSkip(requestBase),
      () => operations.previewBisectReset(requestBase),
      () => operations.previewReflogRecover({ ...requestBase, target: "HEAD" }),
      () => operations.previewCleanExecute(requestBase),
    ];
    for (const cancelledPreview of cancelledPreviews)
      await expect(cancelledPreview()).rejects.toThrow(/cancelled/i);
    expect(commandRunner.requests).toHaveLength(0);
  });
});

class RecordingCommandRunner implements GitCommandRunner {
  public readonly requests: GitCommandRequest[] = [];

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    this.requests.push(request);
    const argumentText = request.arguments.join(" ");
    if (argumentText === "rev-parse --show-toplevel")
      return Promise.resolve(output("/tmp/gito-unit-repository\n"));
    if (argumentText === "rev-parse --git-dir")
      return Promise.resolve(output(".git\n"));
    if (argumentText === "rev-parse --verify HEAD^{commit}")
      return Promise.resolve(
        output("0123456789012345678901234567890123456789\n"),
      );
    if (argumentText === "symbolic-ref --quiet --short HEAD")
      return Promise.resolve(output("main\n"));
    if (request.arguments[0] === "status")
      return Promise.resolve(output("## main\n"));
    if (request.arguments[0] === "show-ref") return Promise.resolve(output(""));
    return Promise.resolve(output(""));
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    return this.run(request).then((commandOutput) => {
      onStandardOutputChunk(commandOutput.standardOutput);
      return commandOutput;
    });
  }
}

function output(standardOutput: string): GitCommandOutput {
  return { standardOutput, standardError: "", exitCode: 0 };
}
