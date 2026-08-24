import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import {
  GitOperationError,
  GitOperationsService,
} from "../../../src/extension/operations/gitOperationsService.js";

const executeFile = promisify(execFile);
const testRootBindingResolver = new GitRootBindingResolver(() =>
  Promise.resolve(
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git",
  ),
);
const realGitIntegrationTest = (
  testName: string,
  testBody: () => Promise<void>,
): void => {
  it(testName, testBody, 30_000);
};
const fixtureDirectories: string[] = [];

afterEach(async () => {
  while (fixtureDirectories.length > 0) {
    const fixtureDirectory = fixtureDirectories.pop();
    if (fixtureDirectory !== undefined)
      await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

describe("real safe Git operations", () => {
  realGitIntegrationTest(
    "previews, confirms, executes, and reads back stash/tag/remote operations",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "change.txt"),
        "change\n",
      );

      const stashPreview = await operations.previewStashCreate({
        repositoryRoot: fixture.repositoryPath,
        message: "safe fixture stash",
        includeUntracked: true,
      });
      expect(stashPreview.destructive).toBe(true);
      expect(stashPreview.preconditions.every((check) => check.satisfied)).toBe(
        true,
      );
      const stashResult = await executeWithExplicitConfirmation(
        operations,
        stashPreview,
      );
      expect(stashResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["stash", "list"])).toContain(
        "safe fixture stash",
      );

      const tagPreview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "fixture/v1",
      });
      await executeWithExplicitConfirmation(operations, tagPreview);
      expect(
        await runGit(fixture.repositoryPath, [
          "show-ref",
          "--tags",
          "fixture/v1",
        ]),
      ).toContain("refs/tags/fixture/v1");

      const remotePreview = await operations.previewRemoteAdd({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "backup",
        remoteUrl: "https://example.test/repo.git",
      });
      await executeWithExplicitConfirmation(operations, remotePreview);
      expect(
        await runGit(fixture.repositoryPath, ["remote", "get-url", "backup"]),
      ).toBe("https://example.test/repo.git");
    },
  );

  realGitIntegrationTest(
    "returns a blocking conflict precondition and leaves Git's conflict state inspectable",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "fixture/conflict",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "branch\n",
      );
      await commit(fixture.repositoryPath, "fixture: branch conflict");
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "main\n",
      );
      await commit(fixture.repositoryPath, "fixture: main conflict");

      const mergePreview = await operations.previewMerge({
        repositoryRoot: fixture.repositoryPath,
        commitish: "fixture/conflict",
      });
      expect(mergePreview.preconditions.every((check) => check.satisfied)).toBe(
        true,
      );
      await expect(
        executeWithExplicitConfirmation(operations, mergePreview),
      ).rejects.toBeInstanceOf(GitOperationError);
      const statusAfterConflict = await runGit(fixture.repositoryPath, [
        "status",
        "--porcelain",
      ]);
      expect(statusAfterConflict).toMatch(/UU README\.md/);
    },
  );

  realGitIntegrationTest("cancels before any Git mutation", async () => {
    const fixture = await createOperationFixture();
    const operations = createOperations();
    const cancellationController = new AbortController();
    cancellationController.abort();
    await expect(
      operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "fixture/cancelled",
        cancellationSignal: cancellationController.signal,
      }),
    ).rejects.toThrowError(/cancelled/i);
    await expect(
      runGit(fixture.repositoryPath, [
        "show-ref",
        "--tags",
        "fixture/cancelled",
      ]),
    ).rejects.toThrow();

    const executablePreview = await operations.previewTagCreate({
      repositoryRoot: fixture.repositoryPath,
      tagName: "fixture/execute-cancelled",
    });
    const executeCancellationController = new AbortController();
    executeCancellationController.abort();
    await expect(
      operations.execute(
        executablePreview,
        operations.createConfirmation(executablePreview),
        executeCancellationController.signal,
      ),
    ).rejects.toThrow(/cancelled/i);
    await expect(
      runGit(fixture.repositoryPath, [
        "show-ref",
        "--tags",
        "fixture/execute-cancelled",
      ]),
    ).rejects.toThrow();
  });

  realGitIntegrationTest(
    "rejects a stale preview after the exact repository state changes",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      const preview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "fixture/stale",
      });
      await writeFile(
        nodePath.join(fixture.repositoryPath, "stale.txt"),
        "changed after preview\n",
      );
      await expect(
        executeWithExplicitConfirmation(operations, preview),
      ).rejects.toThrow(/changed after preview/i);
      await expect(
        Promise.resolve().then(() =>
          operations.previewTagCreate({
            repositoryRoot: fixture.repositoryPath,
            expectedRepositoryRoot: nodePath.join(
              fixture.rootDirectory,
              "other",
            ),
            tagName: "fixture/wrong-repository",
          }),
        ),
      ).rejects.toThrow(/exact repository binding/i);
    },
  );

  realGitIntegrationTest(
    "rejects unsafe refs before invoking Git",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      await expect(
        Promise.resolve().then(() =>
          operations.previewBranchRename({
            repositoryRoot: fixture.repositoryPath,
            newBranchName: "bad..ref",
          }),
        ),
      ).rejects.toThrow("cannot contain ..");
      await expect(
        Promise.resolve().then(() =>
          operations.previewTagCreate({
            repositoryRoot: fixture.repositoryPath,
            tagName: "bad ref",
          }),
        ),
      ).rejects.toThrow(/unsafe|whitespace/i);
    },
  );

  realGitIntegrationTest(
    "recovers a deleted commit through the reflog with a read-back postcondition",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "recover.txt"),
        "recover\n",
      );
      await commit(fixture.repositoryPath, "fixture: recovery target");
      const recoveryCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["reset", "--hard", "HEAD~1"]);
      const reflogPreview = await operations.previewReflogRecover({
        repositoryRoot: fixture.repositoryPath,
        target: recoveryCommit,
        mode: "hard",
      });
      const recoveryResult = await executeWithExplicitConfirmation(
        operations,
        reflogPreview,
      );
      expect(recoveryResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        recoveryCommit,
      );
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "recover.txt"),
          "utf8",
        ),
      ).toBe("recover\n");
    },
  );

  realGitIntegrationTest(
    "creates and applies a real patch, then previews and executes clean",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      const trackedFilePath = nodePath.join(
        fixture.repositoryPath,
        "README.md",
      );
      await writeFile(trackedFilePath, "patched\n");
      const patchPreview = await operations.previewPatchCreate({
        repositoryRoot: fixture.repositoryPath,
        scope: "working-tree",
      });
      const patchResult = await executeWithExplicitConfirmation(
        operations,
        patchPreview,
      );
      expect(patchResult.standardOutput).toContain("-initial");
      await runGit(fixture.repositoryPath, ["restore", "--", "README.md"]);
      const checkOnlyResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPatchApply({
          repositoryRoot: fixture.repositoryPath,
          patchText: patchResult.standardOutput,
          checkOnly: true,
        }),
      );
      expect(checkOnlyResult.postcondition.verified).toBe(true);
      expect(await readFile(trackedFilePath, "utf8")).toBe("initial\n");
      const applyPreview = await operations.previewPatchApply({
        repositoryRoot: fixture.repositoryPath,
        patchText: patchResult.standardOutput,
      });
      expect(
        (await executeWithExplicitConfirmation(operations, applyPreview))
          .postcondition.verified,
      ).toBe(true);
      expect(await readFile(trackedFilePath, "utf8")).toBe("patched\n");
      await runGit(fixture.repositoryPath, ["restore", "--", "README.md"]);
      const removableFilePath = nodePath.join(
        fixture.repositoryPath,
        "remove-me.txt",
      );
      await writeFile(removableFilePath, "untracked\n");
      const cleanCandidatePreview = await operations.previewClean({
        repositoryRoot: fixture.repositoryPath,
      });
      expect(cleanCandidatePreview.displayArguments).toContain("-n");
      const cleanPreview = await operations.previewCleanExecute({
        repositoryRoot: fixture.repositoryPath,
      });
      const cleanResult = await executeWithExplicitConfirmation(
        operations,
        cleanPreview,
      );
      expect(cleanResult.postcondition.verified).toBe(true);
      await expect(readFile(removableFilePath)).rejects.toThrow();

      await writeFile(
        nodePath.join(fixture.repositoryPath, ".gitignore"),
        "ignored-dir/\n",
      );
      await commit(fixture.repositoryPath, "fixture: ignore clean candidate");
      const ignoredDirectoryPath = nodePath.join(
        fixture.repositoryPath,
        "ignored-dir",
      );
      const untrackedDirectoryPath = nodePath.join(
        fixture.repositoryPath,
        "untracked-dir",
      );
      await mkdir(ignoredDirectoryPath);
      await writeFile(
        nodePath.join(ignoredDirectoryPath, "ignored.txt"),
        "ignored\n",
      );
      await mkdir(untrackedDirectoryPath);
      await writeFile(
        nodePath.join(untrackedDirectoryPath, "untracked.txt"),
        "untracked\n",
      );
      const directoryClean = await executeWithExplicitConfirmation(
        operations,
        await operations.previewCleanExecute({
          repositoryRoot: fixture.repositoryPath,
          includeDirectories: true,
          includeIgnored: true,
        }),
      );
      expect(directoryClean.postcondition.verified).toBe(true);
      await expect(
        readFile(nodePath.join(ignoredDirectoryPath, "ignored.txt")),
      ).rejects.toThrow();
      await expect(
        readFile(nodePath.join(untrackedDirectoryPath, "untracked.txt")),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "covers stash create, list, inspect, and apply with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      const trackedFilePath = nodePath.join(
        fixture.repositoryPath,
        "README.md",
      );
      const untrackedFilePath = nodePath.join(
        fixture.repositoryPath,
        "untracked.txt",
      );

      await writeFile(trackedFilePath, "stashed change\n");
      await writeFile(untrackedFilePath, "untracked change\n");
      const createPreview = await operations.previewStashCreate({
        repositoryRoot: fixture.repositoryPath,
        message: "lifecycle stash",
        includeUntracked: true,
      });
      const createResult = await executeWithExplicitConfirmation(
        operations,
        createPreview,
      );
      expect(createResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
      expect(await runGit(fixture.repositoryPath, ["stash", "list"])).toContain(
        "lifecycle stash",
      );

      const listResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashList({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(listResult.postcondition.verified).toBe(true);
      expect(listResult.standardOutput).toContain("stash@{0}");
      expect(listResult.standardOutput).toContain("lifecycle stash");
      const inspectResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashInspect({
          repositoryRoot: fixture.repositoryPath,
          stashReference: "stash@{0}",
        }),
      );
      expect(inspectResult.postcondition.verified).toBe(true);
      expect(inspectResult.standardOutput).toContain("stashed change");

      const applyResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashApply({
          repositoryRoot: fixture.repositoryPath,
          stashReference: "stash@{0}",
        }),
      );
      expect(applyResult.postcondition.verified).toBe(true);
      expect(await readFile(trackedFilePath, "utf8")).toBe("stashed change\n");
      expect(await readFile(untrackedFilePath, "utf8")).toBe(
        "untracked change\n",
      );
      expect(await runGit(fixture.repositoryPath, ["stash", "list"])).toContain(
        "lifecycle stash",
      );
    },
  );

  realGitIntegrationTest(
    "covers stash pop and drop with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      const trackedFilePath = nodePath.join(
        fixture.repositoryPath,
        "README.md",
      );
      await writeFile(trackedFilePath, "stashed change\n");
      const popCreateResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashCreate({
          repositoryRoot: fixture.repositoryPath,
          message: "pop stash",
        }),
      );
      expect(popCreateResult.postcondition.verified).toBe(true);
      const popResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashPop({
          repositoryRoot: fixture.repositoryPath,
          stashReference: "stash@{0}",
        }),
      );
      expect(popResult.postcondition.verified).toBe(true);
      expect(await readFile(trackedFilePath, "utf8")).toBe("stashed change\n");
      expect(
        await runGit(fixture.repositoryPath, ["stash", "list"]),
      ).not.toContain("pop stash");

      await writeFile(trackedFilePath, "second stash\n");
      const dropCreateResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashCreate({
          repositoryRoot: fixture.repositoryPath,
          message: "drop stash",
        }),
      );
      expect(dropCreateResult.postcondition.verified).toBe(true);
      const dropResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashDrop({
          repositoryRoot: fixture.repositoryPath,
          stashReference: "stash@{0}",
        }),
      );
      expect(dropResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["stash", "list"]),
      ).not.toContain("drop stash");
    },
  );

  realGitIntegrationTest(
    "covers stash branch recovery with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      const trackedFilePath = nodePath.join(
        fixture.repositoryPath,
        "README.md",
      );
      await writeFile(trackedFilePath, "branch stash\n");
      const createResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashCreate({
          repositoryRoot: fixture.repositoryPath,
          message: "branch stash",
        }),
      );
      expect(createResult.postcondition.verified).toBe(true);
      const branchResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewStashBranch({
          repositoryRoot: fixture.repositoryPath,
          stashReference: "stash@{0}",
          branchName: "recovered-stash",
        }),
      );
      expect(branchResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
      ).toBe("recovered-stash");
      expect(await readFile(trackedFilePath, "utf8")).toBe("branch stash\n");
    },
  );

  realGitIntegrationTest(
    "covers tags and branch upstream with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const remotePath = nodePath.join(fixture.rootDirectory, "remote.git");
      await runGit(fixture.rootDirectory, ["init", "--bare", remotePath]);
      const operations = createOperations();

      const remoteUrl = `file://${remotePath}`;
      const remoteAddPreview = await operations.previewRemoteAdd({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        remoteUrl,
      });
      await executeWithExplicitConfirmation(operations, remoteAddPreview);
      expect(
        await runGit(fixture.repositoryPath, ["remote", "get-url", "origin"]),
      ).toBe(remoteUrl);

      const branchPushPreview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
        mode: "set-upstream",
      });
      await executeWithExplicitConfirmation(operations, branchPushPreview);
      expect(
        await runGit(fixture.repositoryPath, ["rev-parse", "origin/main"]),
      ).toBe(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"]));
      expect(
        await runGit(fixture.repositoryPath, [
          "config",
          "--get",
          "branch.main.remote",
        ]),
      ).toBe("origin");

      const tagPreview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "fixture/v1",
        annotatedMessage: "fixture release",
      });
      await executeWithExplicitConfirmation(operations, tagPreview);
      expect(
        await runGit(fixture.repositoryPath, ["cat-file", "-t", "fixture/v1"]),
      ).toBe("tag");
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewTagPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          tagName: "fixture/v1",
        }),
      );
      expect(
        await runGit(fixture.rootDirectory, [
          "--git-dir",
          remotePath,
          "show-ref",
          "refs/tags/fixture/v1",
        ]),
      ).toContain("refs/tags/fixture/v1");
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewTagDelete({
          repositoryRoot: fixture.repositoryPath,
          tagName: "fixture/v1",
        }),
      );
      await expect(
        runGit(fixture.repositoryPath, [
          "show-ref",
          "--verify",
          "refs/tags/fixture/v1",
        ]),
      ).rejects.toThrow();

      await runGit(fixture.repositoryPath, ["checkout", "-b", "feature"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "feature.txt"),
        "feature\n",
      );
      await commit(fixture.repositoryPath, "fixture: feature");
      const featurePushResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "feature",
          mode: "normal",
        }),
      );
      expect(featurePushResult.postcondition.verified).toBe(true);
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewBranchUpstream({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "feature",
          setUpstream: true,
        }),
      );
      expect(
        await runGit(fixture.repositoryPath, [
          "config",
          "--get",
          "branch.feature.merge",
        ]),
      ).toBe("refs/heads/feature");
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewBranchUpstream({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "feature",
          setUpstream: false,
        }),
      );
      await expect(
        runGit(fixture.repositoryPath, [
          "config",
          "--get",
          "branch.feature.merge",
        ]),
      ).rejects.toThrow();

      await executeWithExplicitConfirmation(
        operations,
        await operations.previewBranchRename({
          repositoryRoot: fixture.repositoryPath,
          oldBranchName: "feature",
          newBranchName: "renamed-feature",
        }),
      );
      expect(
        await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
      ).toBe("renamed-feature");
    },
  );

  realGitIntegrationTest(
    "covers fetch and remote prune with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const remotePath = nodePath.join(fixture.rootDirectory, "remote.git");
      await runGit(fixture.rootDirectory, ["init", "--bare", remotePath]);
      const operations = createOperations();
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemoteAdd({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          remoteUrl: `file://${remotePath}`,
        }),
      );
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "main",
          mode: "set-upstream",
        }),
      );
      await runGit(fixture.repositoryPath, ["checkout", "-b", "feature"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "feature.txt"),
        "feature\n",
      );
      await commit(fixture.repositoryPath, "fixture: feature");
      const featurePushResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "feature",
          mode: "normal",
        }),
      );
      expect(featurePushResult.postcondition.verified).toBe(true);
      const fetchResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewFetch({
          repositoryRoot: fixture.repositoryPath,
          all: true,
          prune: true,
        }),
      );
      expect(fetchResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["rev-parse", "origin/main"]),
      ).toBe(
        await runGit(fixture.rootDirectory, [
          "--git-dir",
          remotePath,
          "rev-parse",
          "refs/heads/main",
        ]),
      );
      await runGit(fixture.rootDirectory, [
        "--git-dir",
        remotePath,
        "update-ref",
        "-d",
        "refs/heads/feature",
      ]);
      const pruneResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemotePrune({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
        }),
      );
      expect(pruneResult.postcondition.verified).toBe(true);
      await expect(
        runGit(fixture.repositoryPath, [
          "show-ref",
          "--verify",
          "refs/remotes/origin/feature",
        ]),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "covers remote rename and remove with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const remotePath = nodePath.join(fixture.rootDirectory, "remote.git");
      await runGit(fixture.rootDirectory, ["init", "--bare", remotePath]);
      const operations = createOperations();
      const remoteUrl = `file://${remotePath}`;
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemoteAdd({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          remoteUrl,
        }),
      );
      const renameResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemoteRename({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          newRemoteName: "backup",
        }),
      );
      expect(renameResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["remote"])).toBe("backup");
      expect(
        await runGit(fixture.repositoryPath, ["remote", "get-url", "backup"]),
      ).toBe(remoteUrl);
      const removeResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemoteRemove({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "backup",
        }),
      );
      expect(removeResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["remote"])).toBe("");
    },
  );

  realGitIntegrationTest(
    "covers pull ff-only, rebase, and merge modes with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const remotePath = nodePath.join(
        fixture.rootDirectory,
        "pull-remote.git",
      );
      const clonePath = nodePath.join(fixture.rootDirectory, "remote-writer");
      await runGit(fixture.rootDirectory, ["init", "--bare", remotePath]);
      const operations = createOperations();
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemoteAdd({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          remoteUrl: remotePath,
        }),
      );
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "main",
          mode: "set-upstream",
        }),
      );
      await runGit(fixture.rootDirectory, ["clone", remotePath, clonePath]);
      await runGit(clonePath, ["checkout", "-B", "main", "origin/main"]);
      await runGit(clonePath, ["config", "user.name", "Remote Writer"]);
      await runGit(clonePath, ["config", "user.email", "remote@example.test"]);

      await writeFile(nodePath.join(clonePath, "ff-only.txt"), "ff-only\n");
      await commit(clonePath, "fixture: ff-only remote");
      await runGit(clonePath, ["push", "origin", "main"]);
      const ffOnlyPullResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPull({
          repositoryRoot: fixture.repositoryPath,
          mode: "ff-only",
          remoteName: "origin",
          branchName: "main",
        }),
      );
      expect(ffOnlyPullResult.postcondition.verified).toBe(true);
      expect(ffOnlyPullResult.standardOutput).toContain("ff-only.txt");
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        await runGit(clonePath, ["rev-parse", "HEAD"]),
      );
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "ff-only.txt"),
          "utf8",
        ),
      ).toBe("ff-only\n");

      await writeFile(
        nodePath.join(fixture.repositoryPath, "local-rebase.txt"),
        "local\n",
      );
      await commit(fixture.repositoryPath, "fixture: local rebase");
      await writeFile(
        nodePath.join(clonePath, "remote-rebase.txt"),
        "remote\n",
      );
      await commit(clonePath, "fixture: remote rebase");
      await runGit(clonePath, ["push", "origin", "main"]);
      const rebasePullResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPull({
          repositoryRoot: fixture.repositoryPath,
          mode: "rebase",
          remoteName: "origin",
          branchName: "main",
        }),
      );
      expect(rebasePullResult.postcondition.verified).toBe(true);
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "remote-rebase.txt"),
          "utf8",
        ),
      ).toBe("remote\n");
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "local-rebase.txt"),
          "utf8",
        ),
      ).toBe("local\n");

      await writeFile(
        nodePath.join(fixture.repositoryPath, "local-merge.txt"),
        "local merge\n",
      );
      await commit(fixture.repositoryPath, "fixture: local merge");
      await writeFile(
        nodePath.join(clonePath, "remote-merge.txt"),
        "remote merge\n",
      );
      await commit(clonePath, "fixture: remote merge");
      await runGit(clonePath, ["push", "origin", "main"]);
      const mergePullResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPull({
          repositoryRoot: fixture.repositoryPath,
          mode: "merge",
          remoteName: "origin",
          branchName: "main",
        }),
      );
      expect(mergePullResult.postcondition.verified).toBe(true);
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "remote-merge.txt"),
          "utf8",
        ),
      ).toBe("remote merge\n");
    },
  );

  realGitIntegrationTest(
    "covers push force, force-with-lease, and delete modes with exact readback",
    async () => {
      const fixture = await createOperationFixture();
      const remotePath = nodePath.join(
        fixture.rootDirectory,
        "push-remote.git",
      );
      await runGit(fixture.rootDirectory, ["init", "--bare", remotePath]);
      const operations = createOperations();
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewRemoteAdd({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          remoteUrl: remotePath,
        }),
      );
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "main",
          mode: "set-upstream",
        }),
      );
      await writeFile(
        nodePath.join(fixture.repositoryPath, "force-lease.txt"),
        "lease\n",
      );
      await commit(fixture.repositoryPath, "fixture: force lease");
      const leaseResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "main",
          mode: "force-with-lease",
        }),
      );
      expect(leaseResult.postcondition.verified).toBe(true);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "force-lease.txt"),
        "lease amended\n",
      );
      await runGit(fixture.repositoryPath, ["add", "force-lease.txt"]);
      await runGit(fixture.repositoryPath, ["commit", "--amend", "--no-edit"]);
      const forceResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "main",
          mode: "force",
        }),
      );
      expect(forceResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        await runGit(fixture.rootDirectory, [
          "--git-dir",
          remotePath,
          "rev-parse",
          "refs/heads/main",
        ]),
      );

      await runGit(fixture.repositoryPath, ["checkout", "-b", "delete-me"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "delete-me.txt"),
        "delete\n",
      );
      await commit(fixture.repositoryPath, "fixture: delete remote branch");
      const branchPushResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "delete-me",
          mode: "normal",
        }),
      );
      expect(branchPushResult.postcondition.verified).toBe(true);
      const deleteResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "delete-me",
          deleteRemoteBranch: true,
        }),
      );
      expect(deleteResult.postcondition.verified).toBe(true);
      await expect(
        runGit(fixture.rootDirectory, [
          "--git-dir",
          remotePath,
          "show-ref",
          "--verify",
          "refs/heads/delete-me",
        ]),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "covers merge, ordered cherry-picks, revert, and conflict abort state",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, ["checkout", "-b", "merge-source"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "merge.txt"),
        "source\n",
      );
      await commit(fixture.repositoryPath, "fixture: source");
      const sourceCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewMerge({
          repositoryRoot: fixture.repositoryPath,
          commitish: sourceCommit,
        }),
      );
      expect(
        await runGit(fixture.repositoryPath, [
          "merge-base",
          "--is-ancestor",
          sourceCommit,
          "HEAD",
        ]).catch(() => ""),
      ).toBe("");
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "merge.txt"),
          "utf8",
        ),
      ).toBe("source\n");

      await runGit(fixture.repositoryPath, ["checkout", "-b", "cherry-source"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "ordered.txt"),
        "one\n",
      );
      await commit(fixture.repositoryPath, "fixture: cherry one");
      const cherryOne = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "ordered.txt"),
        "one\ntwo\n",
      );
      await commit(fixture.repositoryPath, "fixture: cherry two");
      const cherryTwo = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewCherryPick({
          repositoryRoot: fixture.repositoryPath,
          commitish: cherryOne,
        }),
      );
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewCherryPick({
          repositoryRoot: fixture.repositoryPath,
          commitish: cherryTwo,
        }),
      );
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "ordered.txt"),
          "utf8",
        ),
      ).toBe("one\ntwo\n");

      await writeFile(
        nodePath.join(fixture.repositoryPath, "revert.txt"),
        "before\n",
      );
      await commit(fixture.repositoryPath, "fixture: revert base");
      await writeFile(
        nodePath.join(fixture.repositoryPath, "revert.txt"),
        "after\n",
      );
      await commit(fixture.repositoryPath, "fixture: revert target");
      const revertTarget = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewRevert({
          repositoryRoot: fixture.repositoryPath,
          commitish: revertTarget,
        }),
      );
      expect(
        await runGit(fixture.repositoryPath, ["log", "-1", "--format=%s"]),
      ).toBe('Revert "fixture: revert target"');
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "revert.txt"),
          "utf8",
        ),
      ).toBe("before\n");

      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "conflict-source",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "source conflict\n",
      );
      await commit(fixture.repositoryPath, "fixture: source conflict");
      const conflictSource = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "main conflict\n",
      );
      await commit(fixture.repositoryPath, "fixture: main conflict");
      await expect(
        executeWithExplicitConfirmation(
          operations,
          await operations.previewMerge({
            repositoryRoot: fixture.repositoryPath,
            commitish: conflictSource,
          }),
        ),
      ).rejects.toBeInstanceOf(GitOperationError);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toMatch(/UU README\.md/);
      await runGit(fixture.repositoryPath, ["merge", "--abort"]);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");

      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "cherry-conflict-source",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "cherry source conflict\n",
      );
      await commit(fixture.repositoryPath, "fixture: cherry conflict source");
      const cherryConflictSource = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "cherry main conflict\n",
      );
      await commit(fixture.repositoryPath, "fixture: cherry conflict main");
      await expect(
        executeWithExplicitConfirmation(
          operations,
          await operations.previewCherryPick({
            repositoryRoot: fixture.repositoryPath,
            commitish: cherryConflictSource,
          }),
        ),
      ).rejects.toBeInstanceOf(GitOperationError);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toMatch(/UU README\.md/);
      await runGit(fixture.repositoryPath, ["cherry-pick", "--abort"]);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
    },
  );

  realGitIntegrationTest(
    "covers soft, mixed, and hard reset plus reflog recovery",
    async () => {
      for (const resetMode of ["soft", "mixed", "hard"] as const) {
        const fixture = await createOperationFixture();
        const operations = createOperations();
        await writeFile(
          nodePath.join(fixture.repositoryPath, `${resetMode}.txt`),
          resetMode,
        );
        await commit(fixture.repositoryPath, `fixture: ${resetMode}`);
        const targetCommit = await runGit(fixture.repositoryPath, [
          "rev-parse",
          "HEAD~1",
        ]);
        await executeWithExplicitConfirmation(
          operations,
          await operations.previewReset({
            repositoryRoot: fixture.repositoryPath,
            commitish: targetCommit,
            mode: resetMode,
          }),
        );
        expect(
          await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"]),
        ).toBe(targetCommit);
        const status = await runGit(fixture.repositoryPath, [
          "status",
          "--porcelain",
        ]);
        if (resetMode === "soft") expect(status).toMatch(/A {2}/);
        if (resetMode === "mixed") expect(status).toMatch(/^\?\? /m);
        if (resetMode === "hard") expect(status).toBe("");
      }

      const fixture = await createOperationFixture();
      const operations = createOperations();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "recover.txt"),
        "recover me\n",
      );
      await commit(fixture.repositoryPath, "fixture: reflog target");
      const recoveryTarget = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["reset", "--hard", "HEAD~1"]);
      const reflogList = await executeWithExplicitConfirmation(
        operations,
        await operations.previewReflogList({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(reflogList.standardOutput).toContain(recoveryTarget);
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewReflogRecover({
          repositoryRoot: fixture.repositoryPath,
          target: recoveryTarget,
          mode: "hard",
        }),
      );
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        recoveryTarget,
      );
      expect(
        await readFile(
          nodePath.join(fixture.repositoryPath, "recover.txt"),
          "utf8",
        ),
      ).toBe("recover me\n");
    },
  );

  realGitIntegrationTest(
    "covers rebase start, continue, skip, and abort with explicit conflict state",
    async () => {
      const fixture = await createOperationFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, ["config", "core.editor", "true"]);
      await runGit(fixture.repositoryPath, ["checkout", "-b", "rebased"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "rebase.txt"),
        "topic\n",
      );
      await commit(fixture.repositoryPath, "fixture: rebase topic");
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "base.txt"),
        "base\n",
      );
      await commit(fixture.repositoryPath, "fixture: rebase base");
      await runGit(fixture.repositoryPath, ["checkout", "rebased"]);
      const rebaseStart = await operations.previewRebaseStart({
        repositoryRoot: fixture.repositoryPath,
        upstream: "main",
      });
      await executeWithExplicitConfirmation(operations, rebaseStart);
      expect(
        await runGit(fixture.repositoryPath, [
          "merge-base",
          "--is-ancestor",
          "main",
          "HEAD",
        ]).catch(() => ""),
      ).toBe("");
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");

      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "rebase-conflict",
        "main",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "rebase main\n",
      );
      await commit(fixture.repositoryPath, "fixture: rebase main conflict");
      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "rebase-topic",
        "HEAD~1",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "rebase topic\n",
      );
      await commit(fixture.repositoryPath, "fixture: rebase topic conflict");
      await expect(
        executeWithExplicitConfirmation(
          operations,
          await operations.previewRebaseStart({
            repositoryRoot: fixture.repositoryPath,
            upstream: "rebase-conflict",
          }),
        ),
      ).rejects.toBeInstanceOf(GitOperationError);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toMatch(/UU README\.md/);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "resolved rebase\n",
      );
      await runGit(fixture.repositoryPath, ["add", "README.md"]);
      await executeWithExplicitConfirmation(
        operations,
        await operations.previewRebaseContinue({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");

      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "rebase-abort-topic",
        "main",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "abort topic\n",
      );
      await commit(fixture.repositoryPath, "fixture: abort topic");
      await expect(
        executeWithExplicitConfirmation(
          operations,
          await operations.previewRebaseStart({
            repositoryRoot: fixture.repositoryPath,
            upstream: "rebase-conflict",
          }),
        ),
      ).rejects.toBeInstanceOf(GitOperationError);
      const abortPreview = await operations.previewRebaseAbort({
        repositoryRoot: fixture.repositoryPath,
      });
      await executeWithExplicitConfirmation(operations, abortPreview);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
      expect(
        await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
      ).toBe("rebase-abort-topic");

      await runGit(fixture.repositoryPath, [
        "checkout",
        "-b",
        "rebase-skip-topic",
        "main",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "skip topic\n",
      );
      await commit(fixture.repositoryPath, "fixture: skip topic");
      try {
        await runGit(fixture.repositoryPath, ["rebase", "rebase-conflict"]);
      } catch {
        // Expected conflict leaves the rebase state for the service skip operation.
      }
      await runGit(fixture.repositoryPath, ["rebase", "--skip"]);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
    },
  );

  realGitIntegrationTest(
    "covers bisect good and bad progression with exact reset readback",
    async () => {
      const { fixture, initialCommit, finalBadCommit } =
        await createBisectFixture();
      const operations = createOperations();
      const startResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectStart({
          repositoryRoot: fixture.repositoryPath,
          badCommit: finalBadCommit,
          goodCommits: [initialCommit],
        }),
      );
      expect(startResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["show", "HEAD:bisect.txt"]),
      ).toBe("bad one");

      const badResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectBad({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(badResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["show", "HEAD:bisect.txt"]),
      ).toBe("good one");

      const goodResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectGood({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(goodResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["bisect", "log"])).toContain(
        "git bisect good",
      );

      const resetResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectReset({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(resetResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
      ).toBe("main");
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        finalBadCommit,
      );
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
    },
  );

  realGitIntegrationTest(
    "covers bisect skip and reset with exact readback",
    async () => {
      const { fixture, initialCommit, finalBadCommit } =
        await createBisectFixture();
      const operations = createOperations();
      const startResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectStart({
          repositoryRoot: fixture.repositoryPath,
          badCommit: finalBadCommit,
          goodCommits: [initialCommit],
        }),
      );
      expect(startResult.postcondition.verified).toBe(true);
      const skipResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectSkip({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(skipResult.postcondition.verified).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["bisect", "log"])).toContain(
        "git bisect skip",
      );

      const resetResult = await executeWithExplicitConfirmation(
        operations,
        await operations.previewBisectReset({
          repositoryRoot: fixture.repositoryPath,
        }),
      );
      expect(resetResult.postcondition.verified).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
      ).toBe("main");
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        finalBadCommit,
      );
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
    },
  );
});

function createOperations(): GitOperationsService {
  return new GitOperationsService({
    commandRunner: new NodeGitCommandRunner(),
    gitRootBindingResolver: testRootBindingResolver,
    workspaceTrustGuard: trustedWorkspaceGuard,
  });
}

const trustedWorkspaceGuard = {
  isWorkspaceTrusted: () => true,
  assertTrusted: () => undefined,
};

function executeWithExplicitConfirmation(
  operations: GitOperationsService,
  preview: Awaited<ReturnType<GitOperationsService["previewTagCreate"]>>,
): ReturnType<GitOperationsService["execute"]> {
  return operations.execute(preview, operations.createConfirmation(preview));
}

interface OperationFixture {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
}

async function createOperationFixture(): Promise<OperationFixture> {
  const rootDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-operations-"),
  );
  fixtureDirectories.push(rootDirectory);
  const repositoryPath = nodePath.join(rootDirectory, "repository");
  await runGit(rootDirectory, ["init", "-b", "main", repositoryPath]);
  await runGit(repositoryPath, ["config", "user.name", "Fixture Author"]);
  await runGit(repositoryPath, [
    "config",
    "user.email",
    "fixture@example.test",
  ]);
  await writeFile(nodePath.join(repositoryPath, "README.md"), "initial\n");
  await commit(repositoryPath, "fixture: initial");
  return { rootDirectory, repositoryPath };
}

interface BisectFixture {
  readonly fixture: OperationFixture;
  readonly initialCommit: string;
  readonly finalBadCommit: string;
}

async function createBisectFixture(): Promise<BisectFixture> {
  const fixture = await createOperationFixture();
  const initialCommit = await runGit(fixture.repositoryPath, [
    "rev-parse",
    "HEAD",
  ]);
  await writeFile(
    nodePath.join(fixture.repositoryPath, "bisect.txt"),
    "good one\n",
  );
  await commit(fixture.repositoryPath, "fixture: bisect good");
  await writeFile(
    nodePath.join(fixture.repositoryPath, "bisect.txt"),
    "bad one\n",
  );
  await commit(fixture.repositoryPath, "fixture: bisect bad one");
  await writeFile(
    nodePath.join(fixture.repositoryPath, "bisect.txt"),
    "bad two\n",
  );
  await commit(fixture.repositoryPath, "fixture: bisect bad two");
  const finalBadCommit = await runGit(fixture.repositoryPath, [
    "rev-parse",
    "HEAD",
  ]);
  return { fixture, initialCommit, finalBadCommit };
}

async function commit(repositoryPath: string, message: string): Promise<void> {
  await runGit(repositoryPath, ["add", "--all"]);
  await runGit(repositoryPath, ["commit", "-m", message]);
}

async function runGit(
  repositoryPath: string,
  gitArguments: readonly string[],
): Promise<string> {
  const commandResult = await executeFile("git", [...gitArguments], {
    cwd: repositoryPath,
    shell: false,
    encoding: "utf8",
  });
  return commandResult.stdout.trim();
}
