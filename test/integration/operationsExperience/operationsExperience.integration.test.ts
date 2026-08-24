import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import {
  GitOperationError,
  GitOperationsService,
} from "../../../src/extension/operations/index.js";

const executeFile = promisify(execFile);
const testRootBindingResolver = new GitRootBindingResolver(() =>
  Promise.resolve(
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git",
  ),
);
const fixtureDirectories: string[] = [];
const realGitIntegrationTest = (
  testName: string,
  testBody: () => Promise<void>,
  timeoutMilliseconds = 15_000,
): void => {
  it(testName, testBody, timeoutMilliseconds);
};

afterEach(async () => {
  while (fixtureDirectories.length > 0) {
    const fixtureDirectory = fixtureDirectories.pop();
    if (fixtureDirectory !== undefined)
      await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

describe("real Git Operations Center lanes", () => {
  realGitIntegrationTest(
    "runs stash preview and reads back the stash entry",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "change.txt"),
        "stash me\n",
      );

      const stashPreview = await operations.previewStashCreate({
        repositoryRoot: fixture.repositoryPath,
        message: "operations center stash",
        includeUntracked: true,
      });
      expect(stashPreview.destructive).toBe(true);
      expect(
        (await executePreview(operations, stashPreview)).postcondition.verified,
      ).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["stash", "list"])).toContain(
        "operations center stash",
      );
    },
  );

  realGitIntegrationTest(
    "runs tag preview and reads back the annotated tag",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      const tagPreview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "operations/v1",
        target: "HEAD",
      });
      expect(
        (await executePreview(operations, tagPreview)).postcondition.verified,
      ).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, [
          "show-ref",
          "--verify",
          "refs/tags/operations/v1",
        ]),
      ).toContain("refs/tags/operations/v1");
    },
  );

  realGitIntegrationTest(
    "runs bisect preview and reads back the active session",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      const goodCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "bisect.txt"),
        "bad candidate\n",
      );
      await commit(fixture.repositoryPath, "fixture: candidate");
      const badCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      const bisectPreview = await operations.previewBisectStart({
        repositoryRoot: fixture.repositoryPath,
        badCommit,
        goodCommits: [goodCommit],
      });
      expect(
        (await executePreview(operations, bisectPreview)).postcondition
          .verified,
      ).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, [
          "rev-parse",
          "--git-path",
          "BISECT_LOG",
        ]),
      ).toBeTruthy();
    },
  );

  realGitIntegrationTest(
    "runs clean preview and reads back candidate removal",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();

      const cleanCandidatePath = nodePath.join(
        fixture.repositoryPath,
        "remove-me.txt",
      );
      await writeFile(cleanCandidatePath, "untracked\n");
      const cleanPreview = await operations.previewClean({
        repositoryRoot: fixture.repositoryPath,
        includeDirectories: true,
      });
      expect(cleanPreview.displayArguments).toContain("-n");
      const cleanReadback = await executePreview(operations, cleanPreview);
      expect(cleanReadback.standardOutput).toContain("remove-me.txt");
      const cleanExecutePreview = await operations.previewCleanExecute({
        repositoryRoot: fixture.repositoryPath,
        includeDirectories: true,
      });
      expect(
        (await executePreview(operations, cleanExecutePreview)).postcondition
          .verified,
      ).toBe(true);
      await expect(readFile(cleanCandidatePath)).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "leaves a real cherry-pick conflict inspectable and recovers via reflog",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, ["checkout", "-b", "incoming"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "incoming\n",
      );
      await commit(fixture.repositoryPath, "fixture: incoming conflict");
      const incomingCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "current\n",
      );
      await commit(fixture.repositoryPath, "fixture: current conflict");
      const recoveryCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);

      const cherryPickPreview = await operations.previewCherryPick({
        repositoryRoot: fixture.repositoryPath,
        commitish: incomingCommit,
      });
      await expect(
        executePreview(operations, cherryPickPreview),
      ).rejects.toBeInstanceOf(GitOperationError);
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toMatch(/UU README\.md/);
      await runGit(fixture.repositoryPath, ["cherry-pick", "--abort"]);

      await runGit(fixture.repositoryPath, ["reset", "--hard", "HEAD~1"]);
      const reflogPreview = await operations.previewReflogRecover({
        repositoryRoot: fixture.repositoryPath,
        target: recoveryCommit,
        mode: "hard",
      });
      expect(
        (await executePreview(operations, reflogPreview)).postcondition
          .verified,
      ).toBe(true);
      expect(await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(
        recoveryCommit,
      );
    },
    30_000,
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

async function executePreview(
  operations: GitOperationsService,
  preview: Awaited<ReturnType<GitOperationsService["previewTagCreate"]>>,
) {
  return operations.execute(preview, operations.createConfirmation(preview));
}

async function createFixture(): Promise<{ readonly repositoryPath: string }> {
  const fixtureDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-operations-experience-"),
  );
  fixtureDirectories.push(fixtureDirectory);
  await runGit(fixtureDirectory, ["init", "-b", "main"]);
  await runGit(fixtureDirectory, [
    "config",
    "user.email",
    "operations@example.test",
  ]);
  await runGit(fixtureDirectory, ["config", "user.name", "Operations Fixture"]);
  await writeFile(nodePath.join(fixtureDirectory, "README.md"), "base\n");
  await commit(fixtureDirectory, "fixture: base");
  return { repositoryPath: fixtureDirectory };
}

async function commit(repositoryPath: string, message: string): Promise<void> {
  await runGit(repositoryPath, ["add", "--all"]);
  await runGit(repositoryPath, ["commit", "-m", message]);
}

async function runGit(
  repositoryPath: string,
  argumentsPassed: readonly string[],
): Promise<string> {
  const result = await executeFile("git", [...argumentsPassed], {
    cwd: repositoryPath,
  });
  return result.stdout.trim();
}
