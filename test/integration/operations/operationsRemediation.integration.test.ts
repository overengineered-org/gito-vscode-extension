import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  NodeGitCommandRunner,
  type GitCommandRequest,
  type GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import {
  GitOperationError,
  GitOperationsService,
} from "../../../src/extension/operations/gitOperationsService.js";
import { WorkspaceTrustError } from "../../../src/extension/security/workspaceTrustGuard.js";

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

describe("Operations Center remediation invariants", () => {
  realGitIntegrationTest(
    "claims a confirmation token once across concurrent non-CAS executions",
    async () => {
      const fixture = await createFixture();
      const baseRunner = new NodeGitCommandRunner();
      let mutationCalls = 0;
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          if (request.arguments[0] === "tag") mutationCalls += 1;
          return baseRunner.run(request);
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "single-use-confirmation",
      });
      const confirmation = operations.createConfirmation(preview);
      const outcomes = await Promise.allSettled([
        operations.execute(preview, confirmation),
        operations.execute(preview, confirmation),
      ]);
      const fulfilledOutcomes = outcomes.filter(
        (outcome) => outcome.status === "fulfilled",
      );
      const rejectedOutcomes = outcomes.filter(
        (outcome) => outcome.status === "rejected",
      );
      expect(fulfilledOutcomes).toHaveLength(1);
      expect(rejectedOutcomes).toHaveLength(1);
      const rejectionReason: unknown = rejectedOutcomes[0]?.reason;
      const rejectionMessage =
        rejectionReason instanceof Error
          ? rejectionReason.message
          : String(rejectionReason);
      expect(rejectionMessage).toMatch(/expired|already executed/i);
      expect(mutationCalls).toBe(1);
      expect(
        await runGit(fixture.repositoryPath, [
          "show-ref",
          "refs/tags/single-use-confirmation",
        ]),
      ).toMatch(/[0-9a-f]{40,64}/);
    },
  );

  realGitIntegrationTest(
    "rejects a symlink retarget between preview and execute",
    async () => {
      const fixture = await createFixture();
      const alternate = await createFixture();
      const linkPath = nodePath.join(fixture.rootPath, "selected-repository");
      await symlink(fixture.repositoryPath, linkPath);
      const operations = createOperations();
      const preview = await operations.previewTagCreate({
        repositoryRoot: linkPath,
        tagName: "retargeted",
      });
      await rm(linkPath);
      await symlink(alternate.repositoryPath, linkPath);
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/exact repository binding|stale/i);
      await expect(
        runGit(fixture.repositoryPath, ["show-ref", "retargeted"]),
      ).rejects.toThrow();
      await expect(
        runGit(alternate.repositoryPath, ["show-ref", "retargeted"]),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "passes the captured root identity to every execute-time Git call",
    async () => {
      const fixture = await createFixture();
      const baseRunner = new NodeGitCommandRunner();
      const executeRequests: GitCommandRequest[] = [];
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          executeRequests.push(request);
          return baseRunner.run(request);
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "root-bound",
      });
      const canonicalRepositoryPath = await realpath(fixture.repositoryPath);
      executeRequests.length = 0;
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(executeRequests.length).toBeGreaterThan(0);
      expect(
        executeRequests.every(
          (request) =>
            request.rootBinding?.canonicalPath === canonicalRepositoryPath &&
            request.rootBinding.device.length > 0 &&
            request.rootBinding.inode.length > 0,
        ),
      ).toBe(true);
    },
  );

  realGitIntegrationTest(
    "rejects a .git common-directory swap during preview state reads",
    async () => {
      const fixture = await createFixture();
      const displacedGitDirectory = nodePath.join(
        fixture.rootPath,
        "displaced-preview-git",
      );
      const replacementGitDirectory = await mkdtemp(
        nodePath.join(fixture.rootPath, "replacement-preview-git-"),
      );
      let swapped = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          if (!swapped && request.arguments[0] === "status") {
            swapped = true;
            await rename(
              nodePath.join(fixture.repositoryPath, ".git"),
              displacedGitDirectory,
            );
            await rename(
              replacementGitDirectory,
              nodePath.join(fixture.repositoryPath, ".git"),
            );
          }
          return baseRunner.run(request);
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });

      await expect(
        operations.previewTagCreate({
          repositoryRoot: fixture.repositoryPath,
          tagName: "preview-common-directory-race",
        }),
      ).rejects.toThrow(/Git-directory identity changed|binding|changed/i);
      expect(swapped).toBe(true);
      await expect(lstat(displacedGitDirectory)).resolves.toBeDefined();
      await expect(
        lstat(nodePath.join(fixture.repositoryPath, ".git")),
      ).resolves.toBeDefined();
    },
  );

  realGitIntegrationTest(
    "rejects a stash index race while preserving the original entry",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "first\n",
      );
      await runGit(fixture.repositoryPath, ["stash", "push", "-m", "original"]);
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "second\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "replacement",
      ]);
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/pinned ref|changed after preview/i);
      expect(await runGit(fixture.repositoryPath, ["stash", "list"])).toContain(
        "original",
      );
    },
  );

  realGitIntegrationTest(
    "holds the stash ref lock against an external mutation during drop",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "stash\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "locked-entry",
      ]);
      let externalAttemptExitCode: number | undefined;
      let externalAttempted = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          const output = await baseRunner.run(request);
          if (
            !externalAttempted &&
            request.arguments[0] === "stash" &&
            request.arguments[1] === "list"
          ) {
            externalAttempted = true;
            const externalPath = nodePath.join(
              fixture.repositoryPath,
              "README.md",
            );
            await writeFile(externalPath, "external\n");
            try {
              await executeFile(
                "git",
                ["stash", "push", "-m", "external-race"],
                {
                  cwd: fixture.repositoryPath,
                },
              );
              externalAttemptExitCode = 0;
            } catch (error: unknown) {
              externalAttemptExitCode =
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "number"
                  ? error.code
                  : 1;
            } finally {
              await writeFile(externalPath, "base\n");
            }
          }
          return output;
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(externalAttempted).toBe(true);
      expect(externalAttemptExitCode).not.toBe(0);
      expect(
        await runGit(fixture.repositoryPath, ["stash", "list"]),
      ).not.toContain("locked-entry");
    },
  );

  realGitIntegrationTest(
    "recovers stale orphan stash locks by verified owner metadata",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "stale-lock\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "stale-lock",
      ]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      const reflogPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "logs/refs/stash",
          ]),
        ),
      );
      const ownerMetadata = JSON.stringify({
        ownerPid: 2_147_483_647,
        ownerToken: "stale-owner",
      });
      await writeFile(`${refPath}.lock`, `${ownerMetadata}\n`);
      await writeFile(`${reflogPath}.lock`, `${ownerMetadata}\n`);
      const operations = createOperations();
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(
        await runGit(fixture.repositoryPath, ["stash", "list"]),
      ).not.toContain("stale-lock");
    },
  );

  realGitIntegrationTest(
    "does not delete a replacement lock during stale-lock recovery",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "replacement-lock\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "replacement-lock",
      ]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      const reflogPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "logs/refs/stash",
          ]),
        ),
      );
      const staleOwnerMetadata = `${JSON.stringify({
        ownerPid: 2_147_483_647,
        ownerToken: "stale-replacement-owner",
      })}\n`;
      const replacementOwnerMetadata = `${JSON.stringify({
        ownerPid: process.pid,
        ownerToken: "replacement-owner",
      })}\n`;
      const refLockPath = `${refPath}.lock`;
      await writeFile(refLockPath, staleOwnerMetadata);
      await writeFile(`${reflogPath}.lock`, staleOwnerMetadata);
      let replacementWritten = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          const output = await baseRunner.run(request);
          if (
            !replacementWritten &&
            request.arguments[0] === "rev-parse" &&
            request.arguments[1] === "--show-object-format=storage"
          ) {
            replacementWritten = true;
            await writeFile(refLockPath, replacementOwnerMetadata);
          }
          return output;
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      try {
        const operations = new GitOperationsService({
          commandRunner,
          gitRootBindingResolver: testRootBindingResolver,
          workspaceTrustGuard: trustedWorkspaceGuard,
        });
        const preview = await operations.previewStashDrop({
          repositoryRoot: fixture.repositoryPath,
          stashReference: "stash@{0}",
        });
        await expect(
          operations.execute(preview, operations.createConfirmation(preview)),
        ).rejects.toThrow(/stash|lock|changing/i);
        expect(replacementWritten).toBe(true);
        await expect(readFile(refLockPath, "utf8")).resolves.toBe(
          replacementOwnerMetadata,
        );
      } finally {
        await rm(refLockPath, { force: true });
        await rm(`${reflogPath}.lock`, { force: true });
      }
    },
  );

  realGitIntegrationTest(
    "recovers after a crash before an atomic lock link",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "atomic-lock\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "atomic-lock",
      ]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      const reflogPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "logs/refs/stash",
          ]),
        ),
      );
      const orphanTemporaryLock = `${refPath}.lock.gito-owner-crashed`;
      await writeFile(orphanTemporaryLock, "");
      const operations = createOperations();
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(
        await runGit(fixture.repositoryPath, ["stash", "list"]),
      ).not.toContain("atomic-lock");
      await expect(readFile(`${refPath}.lock`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(`${reflogPath}.lock`, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(orphanTemporaryLock, "utf8")).resolves.toBe("");
      await rm(orphanTemporaryLock, { force: true });
    },
  );

  realGitIntegrationTest(
    "rejects a stash ref symlink without changing the external target",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "symlink-ref\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "symlink-ref",
      ]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      const originalRefContent = await readFile(refPath, "utf8");
      const externalDirectory = await mkdtemp(
        nodePath.join(fixture.rootPath, "external-ref-"),
      );
      const externalRefPath = nodePath.join(externalDirectory, "stash-ref");
      await writeFile(externalRefPath, originalRefContent);
      const baseRunner = new NodeGitCommandRunner();
      let retargeted = false;
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          const output = await baseRunner.run(request);
          if (
            !retargeted &&
            request.arguments[0] === "rev-parse" &&
            request.arguments[1] === "--show-object-format=storage"
          ) {
            retargeted = true;
            await rm(refPath, { force: true });
            await symlink(externalRefPath, refPath);
          }
          return output;
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/symlink|regular|bound|stash/i);
      expect(retargeted).toBe(true);
      await expect(readFile(externalRefPath, "utf8")).resolves.toBe(
        originalRefContent,
      );
    },
  );

  realGitIntegrationTest(
    "recovers a journal before requiring stash refs to exist",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "journal\n",
      );
      await runGit(fixture.repositoryPath, ["stash", "push", "-m", "journal"]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      const reflogPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "logs/refs/stash",
          ]),
        ),
      );
      const refContent = await readFile(refPath, "utf8");
      const reflogContent = await readFile(reflogPath, "utf8");
      const ownerMetadata = JSON.stringify({
        ownerPid: 2_147_483_647,
        ownerToken: "journal-owner",
      });
      await writeFile(`${refPath}.lock`, `${ownerMetadata}\n`);
      await writeFile(`${reflogPath}.lock`, `${ownerMetadata}\n`);
      await writeFile(
        `${refPath}.gito-transaction`,
        `${JSON.stringify({
          version: 1,
          ownerPid: 2_147_483_647,
          ownerToken: "journal-owner",
          phase: "prepared",
          refPath,
          reflogPath,
          refContent,
          reflogContent,
        })}\n`,
      );
      let removedBeforeRecovery = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          if (
            !removedBeforeRecovery &&
            request.arguments[0] === "rev-parse" &&
            request.arguments[1] === "--git-path" &&
            request.arguments[2] === "refs/stash"
          ) {
            removedBeforeRecovery = true;
            await rm(refPath, { force: true });
            await rm(reflogPath, { force: true });
          }
          return baseRunner.run(request);
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const recoveringOperations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await recoveringOperations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await recoveringOperations.execute(
        preview,
        recoveringOperations.createConfirmation(preview),
      );
      expect(removedBeforeRecovery).toBe(true);
      expect(
        await runGit(fixture.repositoryPath, ["stash", "list"]),
      ).not.toContain("journal");
    },
  );

  realGitIntegrationTest(
    "recovers a journal with an intentionally absent last-stash ref",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "missing-ref\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "missing-ref",
      ]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      const reflogPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "logs/refs/stash",
          ]),
        ),
      );
      const reflogContent = await readFile(reflogPath, "utf8");
      const ownerMetadata = `${JSON.stringify({
        ownerPid: 2_147_483_647,
        ownerToken: "missing-ref-owner",
      })}\n`;
      await writeFile(`${refPath}.lock`, ownerMetadata);
      await writeFile(`${reflogPath}.lock`, ownerMetadata);
      await writeFile(
        `${refPath}.gito-transaction`,
        `${JSON.stringify({
          version: 1,
          ownerPid: 2_147_483_647,
          ownerToken: "missing-ref-owner",
          phase: "prepared",
          refPath,
          reflogPath,
          reflogContent,
        })}\n`,
      );
      let removedBeforeRecovery = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          if (
            !removedBeforeRecovery &&
            request.arguments[0] === "rev-parse" &&
            request.arguments[1] === "--git-path" &&
            request.arguments[2] === "refs/stash"
          ) {
            removedBeforeRecovery = true;
            await rm(refPath, { force: true });
            await rm(reflogPath, { force: true });
          }
          return baseRunner.run(request);
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/pinned|stash|changed/i);
      expect(removedBeforeRecovery).toBe(true);
      await expect(readFile(refPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(`${refPath}.gito-transaction`, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  realGitIntegrationTest(
    "rejects ignored clean races and never removes a new ignored file",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await writeFile(
        nodePath.join(fixture.repositoryPath, ".gitignore"),
        "ignored/\n",
      );
      await commit(fixture.repositoryPath, "fixture: ignored policy");
      const ignoredDirectory = nodePath.join(fixture.repositoryPath, "ignored");
      await mkdir(ignoredDirectory);
      const firstIgnoredFile = nodePath.join(ignoredDirectory, "first.txt");
      const secondIgnoredFile = nodePath.join(ignoredDirectory, "second.txt");
      await writeFile(firstIgnoredFile, "first\n");
      const preview = await operations.previewCleanExecute({
        repositoryRoot: fixture.repositoryPath,
        includeDirectories: true,
        includeIgnored: true,
      });
      await writeFile(secondIgnoredFile, "second\n");
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/changed after preview/i);
      await expect(lstat(secondIgnoredFile)).resolves.toBeDefined();
    },
  );

  realGitIntegrationTest(
    "refuses a FIFO stash ref during transaction removal",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "fifo-stash\n",
      );
      await runGit(fixture.repositoryPath, ["stash", "push", "-m", "fifo"]);
      const refPath = await realpath(
        nodePath.resolve(
          fixture.repositoryPath,
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "--git-path",
            "refs/stash",
          ]),
        ),
      );
      let matchingCommitLookups = 0;
      let specialFileInjected = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          const output = await baseRunner.run(request);
          if (
            request.arguments[0] === "rev-parse" &&
            request.arguments[1] === "--verify" &&
            request.arguments[2] === "stash@{0}^{commit}"
          ) {
            matchingCommitLookups += 1;
            if (matchingCommitLookups === 3 && !specialFileInjected) {
              specialFileInjected = true;
              await rm(refPath, { force: true });
              await executeFile("mkfifo", [refPath]);
            }
          }
          return output;
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const guardedOperations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const guardedPreview = await guardedOperations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await expect(
        guardedOperations.execute(
          guardedPreview,
          guardedOperations.createConfirmation(guardedPreview),
        ),
      ).rejects.toThrow(/regular|special|stash|bound/i);
      expect(specialFileInjected).toBe(true);
      expect((await lstat(refPath)).isFIFO()).toBe(true);
    },
  );

  realGitIntegrationTest(
    "rejects a replacement at the bound reflog rename target",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "journal-cas\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "journal-cas",
      ]);
      let replacementInjected = false;
      let replacementDestinationPath: string | undefined;
      const operations = new GitOperationsService({
        commandRunner: new NodeGitCommandRunner(),
        gitRootBindingResolver: testRootBindingResolver,
        beforeBoundFilesystemRename: async (destinationPath) => {
          if (
            replacementInjected ||
            !destinationPath.endsWith(nodePath.join("logs", "refs", "stash"))
          )
            return;
          replacementInjected = true;
          replacementDestinationPath = destinationPath;
          const replacementSourcePath = `${destinationPath}.replacement`;
          await writeFile(replacementSourcePath, "replacement-journal\n");
          await rm(destinationPath, { force: true });
          await rename(replacementSourcePath, destinationPath);
        },
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/destination identity|changed|stash/i);
      expect(replacementInjected).toBe(true);
      expect(replacementDestinationPath).toBeDefined();
      await expect(readFile(replacementDestinationPath!, "utf8")).resolves.toBe(
        "replacement-journal\n",
      );
    },
  );

  realGitIntegrationTest(
    "rejects a symlink replacement at the bound sync directory leaf",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "directory-symlink\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "directory-symlink",
      ]);
      const syncDirectoryPath = nodePath.dirname(
        await realpath(
          nodePath.resolve(
            fixture.repositoryPath,
            await runGit(fixture.repositoryPath, [
              "rev-parse",
              "--git-path",
              "logs/refs/stash",
            ]),
          ),
        ),
      );
      const replacementDirectory = await mkdtemp(
        nodePath.join(fixture.rootPath, "replacement-sync-directory-"),
      );
      const protectedPath = nodePath.join(replacementDirectory, "protected");
      await writeFile(protectedPath, "protected\n");
      let replacementInjected = false;
      const operations = new GitOperationsService({
        commandRunner: new NodeGitCommandRunner(),
        gitRootBindingResolver: testRootBindingResolver,
        beforeBoundFilesystemSyncDirectory: async (directoryPath) => {
          if (replacementInjected || directoryPath !== syncDirectoryPath)
            return;
          replacementInjected = true;
          await rm(directoryPath, { recursive: true, force: true });
          await symlink(replacementDirectory, directoryPath);
        },
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/stable directory|directory|bound/i);
      expect(replacementInjected).toBe(true);
      await expect(readFile(protectedPath, "utf8")).resolves.toBe(
        "protected\n",
      );
      expect((await lstat(syncDirectoryPath)).isSymbolicLink()).toBe(true);
    },
  );

  realGitIntegrationTest(
    "rejects a FIFO at the bound sync directory leaf",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "directory-fifo\n",
      );
      await runGit(fixture.repositoryPath, [
        "stash",
        "push",
        "-m",
        "directory-fifo",
      ]);
      const syncDirectoryPath = nodePath.dirname(
        await realpath(
          nodePath.resolve(
            fixture.repositoryPath,
            await runGit(fixture.repositoryPath, [
              "rev-parse",
              "--git-path",
              "logs/refs/stash",
            ]),
          ),
        ),
      );
      let replacementInjected = false;
      const operations = new GitOperationsService({
        commandRunner: new NodeGitCommandRunner(),
        gitRootBindingResolver: testRootBindingResolver,
        beforeBoundFilesystemSyncDirectory: async (directoryPath) => {
          if (replacementInjected || directoryPath !== syncDirectoryPath)
            return;
          replacementInjected = true;
          await rm(directoryPath, { recursive: true, force: true });
          await executeFile("mkfifo", [directoryPath]);
        },
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewStashDrop({
        repositoryRoot: fixture.repositoryPath,
        stashReference: "stash@{0}",
      });
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/stable directory|directory|bound/i);
      expect(replacementInjected).toBe(true);
      expect((await lstat(syncDirectoryPath)).isFIFO()).toBe(true);
    },
  );

  realGitIntegrationTest(
    "fails closed before clean leaf access when a parent is retargeted",
    async () => {
      const fixture = await createFixture();
      const replacementDirectory = await mkdtemp(
        nodePath.join(fixture.rootPath, "clean-replacement-"),
      );
      const nestedDirectory = nodePath.join(fixture.repositoryPath, "nested");
      const candidatePath = "nested/target.txt";
      const replacementTarget = nodePath.join(
        replacementDirectory,
        "target.txt",
      );
      await mkdir(nestedDirectory);
      await writeFile(
        nodePath.join(fixture.repositoryPath, candidatePath),
        "local\n",
      );
      await writeFile(replacementTarget, "protected\n");
      const operations = createOperations();
      const preview = await operations.previewCleanExecute({
        repositoryRoot: fixture.repositoryPath,
        candidatePaths: [candidatePath],
      });
      await rm(nestedDirectory, { recursive: true, force: true });
      await symlink(replacementDirectory, nestedDirectory);
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/bound|candidate|changed/i);
      await expect(readFile(replacementTarget, "utf8")).resolves.toBe(
        "protected\n",
      );
    },
  );

  realGitIntegrationTest(
    "supports paused merge continue and abort actions",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, ["config", "core.editor", "true"]);
      await runGit(fixture.repositoryPath, ["checkout", "-b", "source"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "source\n",
      );
      await commit(fixture.repositoryPath, "fixture: source");
      const sourceCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "main\n",
      );
      await commit(fixture.repositoryPath, "fixture: main");
      const conflictPreview = await operations.previewMerge({
        repositoryRoot: fixture.repositoryPath,
        commitish: sourceCommit,
      });
      await expect(
        operations.execute(
          conflictPreview,
          operations.createConfirmation(conflictPreview),
        ),
      ).rejects.toBeInstanceOf(GitOperationError);
      const abortPreview = await operations.previewMergeAbort({
        repositoryRoot: fixture.repositoryPath,
      });
      await operations.execute(
        abortPreview,
        operations.createConfirmation(abortPreview),
      );
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");

      const continuePreview = await operations.previewMerge({
        repositoryRoot: fixture.repositoryPath,
        commitish: sourceCommit,
      });
      await expect(
        operations.execute(
          continuePreview,
          operations.createConfirmation(continuePreview),
        ),
      ).rejects.toBeInstanceOf(GitOperationError);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "README.md"),
        "resolved\n",
      );
      await runGit(fixture.repositoryPath, ["add", "README.md"]);
      const mergeContinue = await operations.previewMergeContinue({
        repositoryRoot: fixture.repositoryPath,
      });
      await operations.execute(
        mergeContinue,
        operations.createConfirmation(mergeContinue),
      );
      expect(
        await runGit(fixture.repositoryPath, ["status", "--porcelain"]),
      ).toBe("");
    },
  );

  realGitIntegrationTest(
    "pins merge variants and reads back a custom push destination",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, ["checkout", "-b", "source"]);
      await writeFile(
        nodePath.join(fixture.repositoryPath, "source.txt"),
        "source\n",
      );
      await commit(fixture.repositoryPath, "fixture: source");
      const sourceCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      await runGit(fixture.repositoryPath, ["checkout", "main"]);
      const fastForward = await operations.previewMerge({
        repositoryRoot: fixture.repositoryPath,
        commitish: sourceCommit,
        mode: "ff-only",
      });
      await operations.execute(
        fastForward,
        operations.createConfirmation(fastForward),
      );
      const remotePath = nodePath.join(fixture.rootPath, "remote.git");
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      const remoteAdd = await operations.previewRemoteAdd({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        remoteUrl: remotePath,
      });
      await operations.execute(
        remoteAdd,
        operations.createConfirmation(remoteAdd),
      );
      const customPush = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        refspec: "HEAD:refs/heads/custom-target",
      });
      await operations.execute(
        customPush,
        operations.createConfirmation(customPush),
      );
      expect(
        await runGit(fixture.rootPath, [
          "--git-dir",
          remotePath,
          "rev-parse",
          "refs/heads/custom-target",
        ]),
      ).toBe(sourceCommit);
    },
  );

  realGitIntegrationTest("rejects a remote OID race before push", async () => {
    const fixture = await createFixture();
    const operations = createOperations();
    const remotePath = nodePath.join(fixture.rootPath, "remote-race.git");
    const writerPath = nodePath.join(fixture.rootPath, "remote-writer");
    await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
    await runGit(fixture.repositoryPath, [
      "remote",
      "add",
      "origin",
      remotePath,
    ]);
    await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
    await runGit(fixture.rootPath, ["clone", remotePath, writerPath]);
    await runGit(writerPath, ["checkout", "-b", "main", "origin/main"]);
    await runGit(writerPath, ["config", "user.name", "Writer"]);
    await runGit(writerPath, ["config", "user.email", "writer@example.test"]);
    await writeFile(nodePath.join(writerPath, "remote.txt"), "remote\n");
    await commit(writerPath, "fixture: remote race");
    const preview = await operations.previewPush({
      repositoryRoot: fixture.repositoryPath,
      remoteName: "origin",
      branchName: "main",
    });
    await runGit(writerPath, ["push", "origin", "main"]);
    await expect(
      operations.execute(preview, operations.createConfirmation(preview)),
    ).rejects.toThrow(/pinned ref|remote changed/i);
  });

  realGitIntegrationTest(
    "rejects local remote directory replacement before fetch, pull, push, and tag push",
    async () => {
      const operations = createOperations();
      const scenarios: readonly {
        readonly operationName: string;
        readonly createPreview: (
          repositoryPath: string,
        ) => Promise<Awaited<ReturnType<GitOperationsService["previewPush"]>>>;
      }[] = [
        {
          operationName: "fetch",
          createPreview: (repositoryPath) =>
            operations.previewFetch({
              repositoryRoot: repositoryPath,
              remoteName: "origin",
            }),
        },
        {
          operationName: "pull",
          createPreview: (repositoryPath) =>
            operations.previewPull({
              repositoryRoot: repositoryPath,
              remoteName: "origin",
              branchName: "main",
              mode: "ff-only",
            }),
        },
        {
          operationName: "push",
          createPreview: (repositoryPath) =>
            operations.previewPush({
              repositoryRoot: repositoryPath,
              remoteName: "origin",
              branchName: "main",
            }),
        },
        {
          operationName: "tag.push",
          createPreview: (repositoryPath) =>
            operations.previewTagPush({
              repositoryRoot: repositoryPath,
              remoteName: "origin",
              tagName: "fixture/local-remote-tag",
            }),
        },
      ];

      for (const { operationName, createPreview } of scenarios) {
        const fixture = await createFixture();
        const remotePath = nodePath.join(
          fixture.rootPath,
          `${operationName.replace(".", "-")}-local-remote.git`,
        );
        const replacementPath = nodePath.join(
          fixture.rootPath,
          `${operationName.replace(".", "-")}-replacement.git`,
        );
        await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
        await runGit(fixture.repositoryPath, [
          "remote",
          "add",
          "origin",
          remotePath,
        ]);
        await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
        if (operationName === "tag.push")
          await runGit(fixture.repositoryPath, [
            "tag",
            "fixture/local-remote-tag",
          ]);
        const preview = await createPreview(fixture.repositoryPath);
        await runGit(fixture.rootPath, ["init", "--bare", replacementPath]);
        const displacedPath = `${remotePath}.original`;
        await rename(remotePath, displacedPath);
        await rename(replacementPath, remotePath);
        await expect(
          operations.execute(preview, operations.createConfirmation(preview)),
        ).rejects.toThrow(/local remote target binding|changed|fresh preview/i);
        await expect(
          runGit(fixture.rootPath, [
            "--git-dir",
            remotePath,
            "show-ref",
            "refs/heads/main",
          ]),
        ).rejects.toThrow();
        await rm(remotePath, { recursive: true, force: true });
        await rename(displacedPath, remotePath);
      }
    },
  );

  realGitIntegrationTest(
    "rejects a file URL remote retargeted to a symlink before push",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      const remotePath = nodePath.join(fixture.rootPath, "file-url-remote.git");
      const replacementPath = nodePath.join(
        fixture.rootPath,
        "file-url-replacement.git",
      );
      const remoteLinkPath = nodePath.join(fixture.rootPath, "file-url-link");
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.rootPath, ["init", "--bare", replacementPath]);
      await symlink(remotePath, remoteLinkPath);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        `file://${remoteLinkPath}`,
      ]);
      await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
      const preview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
      });
      await rm(remoteLinkPath, { force: true });
      await symlink(replacementPath, remoteLinkPath);
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/local remote target binding|changed|fresh preview/i);
      await expect(
        runGit(fixture.rootPath, [
          "--git-dir",
          replacementPath,
          "show-ref",
          "refs/heads/main",
        ]),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "pushes to the pinned pushurl and rejects multiple push destinations",
    async () => {
      const fixture = await createFixture();
      const fetchRemotePath = nodePath.join(fixture.rootPath, "fetch-only.git");
      const pushRemotePath = nodePath.join(fixture.rootPath, "push-only.git");
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", fetchRemotePath]);
      await runGit(fixture.rootPath, ["init", "--bare", pushRemotePath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        fetchRemotePath,
      ]);
      await runGit(fixture.repositoryPath, [
        "config",
        "remote.origin.pushurl",
        pushRemotePath,
      ]);
      const preview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
      });
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(
        await runGit(fixture.rootPath, [
          "--git-dir",
          pushRemotePath,
          "show-ref",
          "refs/heads/main",
        ]),
      ).toContain("refs/heads/main");
      await expect(
        runGit(fixture.rootPath, [
          "--git-dir",
          fetchRemotePath,
          "show-ref",
          "refs/heads/main",
        ]),
      ).rejects.toThrow();
      const replacementPushPath = nodePath.join(
        fixture.rootPath,
        "replacement-push.git",
      );
      await runGit(fixture.rootPath, ["init", "--bare", replacementPushPath]);
      await runGit(fixture.repositoryPath, [
        "config",
        "remote.origin.pushurl",
        pushRemotePath,
      ]);
      const pushUrlRacePreview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
      });
      await runGit(fixture.repositoryPath, [
        "config",
        "remote.origin.pushurl",
        replacementPushPath,
      ]);
      await expect(
        operations.execute(
          pushUrlRacePreview,
          operations.createConfirmation(pushUrlRacePreview),
        ),
      ).rejects.toThrow(/remote changed|pinned/i);
      await runGit(fixture.repositoryPath, [
        "config",
        "--add",
        "remote.origin.pushurl",
        fetchRemotePath,
      ]);
      await expect(
        operations.previewPush({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
          branchName: "main",
        }),
      ).rejects.toThrow(/multiple.*push.*url|ambiguous/i);
    },
  );

  realGitIntegrationTest(
    "rejects a tag push when the pinned remote URL changes",
    async () => {
      const fixture = await createFixture();
      const remotePath = nodePath.join(fixture.rootPath, "tag-push.git");
      const replacementPath = nodePath.join(
        fixture.rootPath,
        "tag-push-replacement.git",
      );
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.rootPath, ["init", "--bare", replacementPath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        remotePath,
      ]);
      await runGit(fixture.repositoryPath, [
        "tag",
        "-a",
        "pinned-tag",
        "-m",
        "pinned tag",
      ]);
      const preview = await operations.previewTagPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        tagName: "pinned-tag",
      });
      await runGit(fixture.repositoryPath, [
        "remote",
        "set-url",
        "origin",
        replacementPath,
      ]);
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/remote changed|pinned/i);
      await runGit(fixture.repositoryPath, [
        "remote",
        "set-url",
        "origin",
        remotePath,
      ]);
      const freshPreview = await operations.previewTagPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        tagName: "pinned-tag",
      });
      await operations.execute(
        freshPreview,
        operations.createConfirmation(freshPreview),
      );
      expect(
        await runGit(fixture.rootPath, [
          "--git-dir",
          remotePath,
          "rev-parse",
          "refs/tags/pinned-tag",
        ]),
      ).toBe(
        await runGit(fixture.repositoryPath, [
          "rev-parse",
          "refs/tags/pinned-tag",
        ]),
      );
    },
  );

  realGitIntegrationTest(
    "rejects a pull when the pinned remote branch advances",
    async () => {
      const fixture = await createFixture();
      const remotePath = nodePath.join(fixture.rootPath, "pull-race.git");
      const writerPath = nodePath.join(fixture.rootPath, "pull-race-writer");
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        remotePath,
      ]);
      await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
      await runGit(fixture.rootPath, ["clone", remotePath, writerPath]);
      await runGit(writerPath, ["checkout", "-b", "main", "origin/main"]);
      await runGit(writerPath, ["config", "user.name", "Pull Writer"]);
      await runGit(writerPath, [
        "config",
        "user.email",
        "pull-writer@example.test",
      ]);
      const preview = await operations.previewPull({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
        mode: "ff-only",
      });
      const pinnedRemoteCommit = await runGit(fixture.rootPath, [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ]);
      expect(preview.displayArguments).not.toContain("then");
      expect(preview.commandSequence).toEqual([
        [
          "fetch",
          "--no-tags",
          remotePath,
          `${pinnedRemoteCommit}:refs/remotes/origin/main`,
        ],
        ["merge", "--no-edit", "--ff-only", pinnedRemoteCommit],
      ]);
      await writeFile(nodePath.join(writerPath, "advanced.txt"), "advanced\n");
      await commit(writerPath, "fixture: advance pull remote");
      await runGit(writerPath, ["push", "origin", "main"]);
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/pinned ref|remote changed/i);
    },
  );

  realGitIntegrationTest(
    "uses an OID lease for force and delete pushes",
    async () => {
      const fixture = await createFixture();
      const remotePath = nodePath.join(fixture.rootPath, "lease.git");
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        remotePath,
      ]);
      await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
      const remoteCommit = await runGit(fixture.rootPath, [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ]);
      const forcePreview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
        mode: "force",
      });
      expect(forcePreview.displayArguments).toContain(
        `--force-with-lease=refs/heads/main:${remoteCommit}`,
      );
      const deletePreview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
        deleteRemoteBranch: true,
      });
      expect(deletePreview.displayArguments).toContain(
        `--force-with-lease=refs/heads/main:${remoteCommit}`,
      );
    },
  );

  realGitIntegrationTest(
    "previews set-upstream as the exact push and config sequence",
    async () => {
      const fixture = await createFixture();
      const remotePath = nodePath.join(fixture.rootPath, "set-upstream.git");
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        remotePath,
      ]);
      const sourceCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "HEAD",
      ]);
      const preview = await operations.previewPush({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
        branchName: "main",
        mode: "set-upstream",
      });
      expect(preview.displayArguments).toEqual([
        "push",
        remotePath,
        `${sourceCommit}:refs/heads/main`,
      ]);
      expect(preview.commandSequence).toEqual([
        ["push", remotePath, `${sourceCommit}:refs/heads/main`],
        ["update-ref", "refs/remotes/origin/main", sourceCommit],
        ["branch", "--set-upstream-to=origin/main", "main"],
      ]);
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(
        await runGit(fixture.repositoryPath, [
          "config",
          "--get",
          "branch.main.remote",
        ]),
      ).toBe("origin");
      expect(
        await runGit(fixture.repositoryPath, [
          "config",
          "--get",
          "branch.main.merge",
        ]),
      ).toBe("refs/heads/main");
    },
  );

  realGitIntegrationTest("uses OID-CAS for tag deletion", async () => {
    const fixture = await createFixture();
    const replacementCommit = await createReplacementCommit(
      fixture.repositoryPath,
    );
    await runGit(fixture.repositoryPath, ["tag", "cas-tag"]);
    let mutated = false;
    const baseRunner = new NodeGitCommandRunner();
    const commandRunner: GitCommandRunner = {
      run: async (request: GitCommandRequest) => {
        if (!mutated && request.arguments[0] === "update-ref") {
          mutated = true;
          await runGit(fixture.repositoryPath, [
            "tag",
            "--force",
            "cas-tag",
            replacementCommit,
          ]);
        }
        return baseRunner.run(request);
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const operations = new GitOperationsService({
      commandRunner,
      gitRootBindingResolver: testRootBindingResolver,
      workspaceTrustGuard: trustedWorkspaceGuard,
    });
    const preview = await operations.previewTagDelete({
      repositoryRoot: fixture.repositoryPath,
      tagName: "cas-tag",
    });
    await expect(
      operations.execute(preview, operations.createConfirmation(preview)),
    ).rejects.toThrow(/cannot lock ref|changed|expected/i);
    expect(
      await runGit(fixture.repositoryPath, ["rev-parse", "refs/tags/cas-tag"]),
    ).toBe(replacementCommit);
  });

  realGitIntegrationTest(
    "uses an OID-CAS transaction for branch rename",
    async () => {
      const fixture = await createFixture();
      const replacementCommit = await createReplacementCommit(
        fixture.repositoryPath,
      );
      const baseCommit = await runGit(fixture.repositoryPath, [
        "rev-parse",
        "refs/heads/main",
      ]);
      let mutated = false;
      const baseRunner = new NodeGitCommandRunner();
      const commandRunner: GitCommandRunner = {
        run: async (request: GitCommandRequest) => {
          if (!mutated && request.arguments[0] === "update-ref") {
            mutated = true;
            await runGit(fixture.repositoryPath, [
              "update-ref",
              "refs/heads/main",
              replacementCommit,
            ]);
          }
          return baseRunner.run(request);
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const operations = new GitOperationsService({
        commandRunner,
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: trustedWorkspaceGuard,
      });
      const preview = await operations.previewBranchRename({
        repositoryRoot: fixture.repositoryPath,
        oldBranchName: "main",
        newBranchName: "renamed-main",
      });
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/transaction|cannot lock ref|changed|expected/i);
      expect(
        await runGit(fixture.repositoryPath, ["rev-parse", "refs/heads/main"]),
      ).toBe(replacementCommit);
      await expect(
        runGit(fixture.repositoryPath, ["show-ref", "refs/heads/renamed-main"]),
      ).rejects.toThrow();
      expect(baseCommit).not.toBe(replacementCommit);
    },
  );

  realGitIntegrationTest(
    "derives CAS zero width from a SHA-256 repository",
    async () => {
      const fixture = await createSha256Fixture();
      const operations = createOperations();
      const preview = await operations.previewBranchRename({
        repositoryRoot: fixture.repositoryPath,
        oldBranchName: "main",
        newBranchName: "sha256-renamed",
      });
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(
        await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
      ).toBe("sha256-renamed");
      expect(
        (await runGit(fixture.repositoryPath, ["rev-parse", "HEAD"])).length,
      ).toBe(64);
    },
  );

  realGitIntegrationTest(
    "rolls branch rename back after each mutation phase fails",
    async () => {
      const failurePhases: readonly ((
        request: GitCommandRequest,
      ) => boolean)[] = [
        (request) => request.arguments[0] === "update-ref",
        (request) =>
          request.arguments[0] === "config" &&
          request.arguments.includes("--rename-section"),
        (request) =>
          request.arguments[0] === "symbolic-ref" &&
          request.arguments[1] === "HEAD" &&
          request.arguments[2] === "refs/heads/renamed-main",
      ];
      for (const shouldFail of failurePhases) {
        const fixture = await createFixture();
        await runGit(fixture.repositoryPath, [
          "config",
          "branch.main.remote",
          "origin",
        ]);
        await runGit(fixture.repositoryPath, [
          "config",
          "branch.main.merge",
          "refs/heads/main",
        ]);
        const baseRunner = new NodeGitCommandRunner();
        let injected = false;
        const commandRunner: GitCommandRunner = {
          run: async (request: GitCommandRequest) => {
            const output = await baseRunner.run(request);
            if (!injected && shouldFail(request)) {
              injected = true;
              throw new Error("injected branch rename phase failure");
            }
            return output;
          },
          runStreaming: (request, onStandardOutputChunk) =>
            baseRunner.runStreaming(request, onStandardOutputChunk),
        };
        const operations = new GitOperationsService({
          commandRunner,
          gitRootBindingResolver: testRootBindingResolver,
          workspaceTrustGuard: trustedWorkspaceGuard,
        });
        const preview = await operations.previewBranchRename({
          repositoryRoot: fixture.repositoryPath,
          oldBranchName: "main",
          newBranchName: "renamed-main",
        });
        let phaseFailure: unknown;
        try {
          await operations.execute(
            preview,
            operations.createConfirmation(preview),
          );
          throw new Error("expected branch rename phase failure");
        } catch (error: unknown) {
          phaseFailure = error;
        }
        expect(phaseFailure).toBeInstanceOf(GitOperationError);
        expect((phaseFailure as GitOperationError).rollback?.status).toBe(
          "succeeded",
        );
        expect(injected).toBe(true);
        expect(
          await runGit(fixture.repositoryPath, [
            "rev-parse",
            "refs/heads/main",
          ]),
        ).toMatch(/^[0-9a-f]{40}$/);
        await expect(
          runGit(fixture.repositoryPath, [
            "show-ref",
            "--verify",
            "refs/heads/renamed-main",
          ]),
        ).rejects.toThrow();
        expect(
          await runGit(fixture.repositoryPath, [
            "config",
            "--get",
            "branch.main.remote",
          ]),
        ).toBe("origin");
        expect(
          await runGit(fixture.repositoryPath, [
            "config",
            "--get",
            "branch.main.merge",
          ]),
        ).toBe("refs/heads/main");
        expect(
          await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
        ).toBe("main");
      }
    },
  );

  realGitIntegrationTest(
    "rolls branch rename back when cancellation arrives after a phase",
    async () => {
      const cancellationPhases: readonly ((
        request: GitCommandRequest,
      ) => boolean)[] = [
        (request) => request.arguments[0] === "update-ref",
        (request) =>
          request.arguments[0] === "config" &&
          request.arguments.includes("--rename-section"),
        (request) =>
          request.arguments[0] === "symbolic-ref" &&
          request.arguments[1] === "HEAD" &&
          request.arguments[2] === "refs/heads/renamed-main",
      ];
      for (const shouldCancel of cancellationPhases) {
        const fixture = await createFixture();
        await runGit(fixture.repositoryPath, [
          "config",
          "branch.main.remote",
          "origin",
        ]);
        await runGit(fixture.repositoryPath, [
          "config",
          "branch.main.merge",
          "refs/heads/main",
        ]);
        const cancellationController = new AbortController();
        const baseRunner = new NodeGitCommandRunner();
        let injected = false;
        const commandRunner: GitCommandRunner = {
          run: async (request: GitCommandRequest) => {
            const output = await baseRunner.run(request);
            if (!injected && shouldCancel(request)) {
              injected = true;
              cancellationController.abort();
            }
            return output;
          },
          runStreaming: (request, onStandardOutputChunk) =>
            baseRunner.runStreaming(request, onStandardOutputChunk),
        };
        const operations = new GitOperationsService({
          commandRunner,
          gitRootBindingResolver: testRootBindingResolver,
          workspaceTrustGuard: trustedWorkspaceGuard,
        });
        const preview = await operations.previewBranchRename({
          repositoryRoot: fixture.repositoryPath,
          oldBranchName: "main",
          newBranchName: "renamed-main",
        });
        let cancellationFailure: unknown;
        try {
          await operations.execute(
            preview,
            operations.createConfirmation(preview),
            cancellationController.signal,
          );
          throw new Error("expected branch rename cancellation");
        } catch (error: unknown) {
          cancellationFailure = error;
        }
        expect(cancellationFailure).toBeInstanceOf(GitOperationError);
        expect(
          (cancellationFailure as GitOperationError).rollback?.status,
        ).toBe("succeeded");
        expect(injected).toBe(true);
        expect(
          await runGit(fixture.repositoryPath, ["branch", "--show-current"]),
        ).toBe("main");
        await expect(
          runGit(fixture.repositoryPath, [
            "show-ref",
            "--verify",
            "refs/heads/renamed-main",
          ]),
        ).rejects.toThrow();
      }
    },
  );

  realGitIntegrationTest("pins remote config before prune", async () => {
    const fixture = await createFixture();
    const remotePath = nodePath.join(fixture.rootPath, "config-race.git");
    const operations = createOperations();
    await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
    await runGit(fixture.repositoryPath, [
      "remote",
      "add",
      "origin",
      remotePath,
    ]);
    const preview = await operations.previewRemotePrune({
      repositoryRoot: fixture.repositoryPath,
      remoteName: "origin",
    });
    await runGit(fixture.repositoryPath, [
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/changed/*",
    ]);
    await expect(
      operations.execute(preview, operations.createConfirmation(preview)),
    ).rejects.toThrow(/pinned ref|remote changed/i);
  });

  realGitIntegrationTest(
    "fetches configured wildcard tag refspecs with exact object readback",
    async () => {
      const fixture = await createFixture();
      const remotePath = nodePath.join(fixture.rootPath, "tag-fetch.git");
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        remotePath,
      ]);
      await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
      await runGit(fixture.repositoryPath, [
        "tag",
        "-a",
        "v1",
        "-m",
        "version one",
      ]);
      await runGit(fixture.repositoryPath, ["push", "origin", "refs/tags/v1"]);
      const remoteTagObject = (
        await runGit(fixture.repositoryPath, [
          "ls-remote",
          "origin",
          "refs/tags/v1",
        ])
      ).split(/\s+/, 1)[0];
      await runGit(fixture.repositoryPath, ["tag", "-d", "v1"]);
      await runGit(fixture.repositoryPath, [
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/tags/*:refs/tags/*",
      ]);
      await runGit(fixture.repositoryPath, [
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/*:refs/custom/origin/*",
      ]);
      const fetchUrlRacePath = nodePath.join(
        fixture.rootPath,
        "fetch-race.git",
      );
      await runGit(fixture.rootPath, ["init", "--bare", fetchUrlRacePath]);
      const fetchUrlRacePreview = await operations.previewFetch({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
      });
      await runGit(fixture.repositoryPath, [
        "remote",
        "set-url",
        "origin",
        fetchUrlRacePath,
      ]);
      await expect(
        operations.execute(
          fetchUrlRacePreview,
          operations.createConfirmation(fetchUrlRacePreview),
        ),
      ).rejects.toThrow(/remote changed|pinned/i);
      await runGit(fixture.repositoryPath, [
        "remote",
        "set-url",
        "origin",
        remotePath,
      ]);
      const preview = await operations.previewFetch({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
      });
      expect(preview.displayArguments).toContain(
        `+${remoteTagObject}:refs/tags/v1`,
      );
      await operations.execute(preview, operations.createConfirmation(preview));
      expect(
        await runGit(fixture.repositoryPath, ["rev-parse", "refs/tags/v1"]),
      ).toBe(remoteTagObject);
      const remoteMainObject = await runGit(fixture.rootPath, [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ]);
      expect(
        await runGit(fixture.repositoryPath, [
          "rev-parse",
          "refs/remotes/origin/main",
        ]),
      ).toBe(remoteMainObject);
      expect(
        await runGit(fixture.repositoryPath, [
          "rev-parse",
          "refs/custom/origin/main",
        ]),
      ).toBe(remoteMainObject);
    },
  );

  realGitIntegrationTest(
    "suppresses automatic tags unless a tag refspec is configured",
    async () => {
      const fixture = await createFixture();
      const remotePath = nodePath.join(fixture.rootPath, "auto-tag.git");
      const operations = createOperations();
      await runGit(fixture.rootPath, ["init", "--bare", remotePath]);
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        remotePath,
      ]);
      await runGit(fixture.repositoryPath, ["push", "origin", "main"]);
      await runGit(fixture.repositoryPath, ["tag", "auto-follow"]);
      await runGit(fixture.repositoryPath, [
        "push",
        "origin",
        "refs/tags/auto-follow",
      ]);
      await runGit(fixture.repositoryPath, ["tag", "-d", "auto-follow"]);
      const preview = await operations.previewFetch({
        repositoryRoot: fixture.repositoryPath,
        remoteName: "origin",
      });
      expect(preview.displayArguments).toContain("--no-tags");
      await operations.execute(preview, operations.createConfirmation(preview));
      await expect(
        runGit(fixture.repositoryPath, [
          "show-ref",
          "--verify",
          "refs/tags/auto-follow",
        ]),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "rejects push without a resolvable remote",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await expect(
        operations.previewPush({ repositoryRoot: fixture.repositoryPath }),
      ).rejects.toThrow(/no remote|remote.*configured/i);
    },
  );

  realGitIntegrationTest(
    "rejects an unsafe configured remote URL before network resolution",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        nodePath.join(fixture.rootPath, "valid-remote.git"),
      ]);
      await runGit(fixture.repositoryPath, [
        "config",
        "remote.origin.url",
        "-unsafe-remote",
      ]);
      await expect(
        operations.previewFetch({
          repositoryRoot: fixture.repositoryPath,
          remoteName: "origin",
        }),
      ).rejects.toThrow(/remote URL is unsafe/i);
    },
  );

  realGitIntegrationTest(
    "rejects configured remote credentials before network resolution",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, [
        "remote",
        "add",
        "origin",
        nodePath.join(fixture.rootPath, "valid-remote.git"),
      ]);
      for (const credentialBearingRemoteUrl of [
        "https://token@example.test/repository.git",
        "ssh://git:password@example.test/repository.git",
        "https://example.test/repository.git?access_token=secret",
      ]) {
        await runGit(fixture.repositoryPath, [
          "config",
          "remote.origin.url",
          credentialBearingRemoteUrl,
        ]);
        await expect(
          operations.previewFetch({
            repositoryRoot: fixture.repositoryPath,
            remoteName: "origin",
          }),
        ).rejects.toThrow(/must not embed credentials/i);
      }
    },
  );

  realGitIntegrationTest(
    "rejects empty clean execution instead of broadening to the repository",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await expect(
        operations.previewCleanExecute({
          repositoryRoot: fixture.repositoryPath,
        }),
      ).rejects.toThrow(/at least one exact candidate|broaden/i);
    },
  );

  realGitIntegrationTest(
    "rechecks trust immediately before the final Git mutation",
    async () => {
      const fixture = await createFixture();
      let workspaceTrusted = true;
      const operations = new GitOperationsService({
        commandRunner: new NodeGitCommandRunner(),
        gitRootBindingResolver: testRootBindingResolver,
        workspaceTrustGuard: {
          isWorkspaceTrusted: () => workspaceTrusted,
          assertTrusted: () => {
            if (!workspaceTrusted)
              throw new WorkspaceTrustError("execute tag.create");
          },
        },
      });
      const preview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "trust-revoked",
      });
      workspaceTrusted = false;
      await expect(
        operations.execute(preview, operations.createConfirmation(preview)),
      ).rejects.toThrow(/untrusted workspace/i);
      await expect(
        runGit(fixture.repositoryPath, ["show-ref", "trust-revoked"]),
      ).rejects.toThrow();
    },
  );

  realGitIntegrationTest(
    "rejects a mutable patch preview snapshot",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      const preview = await operations.previewPatchApply({
        repositoryRoot: fixture.repositoryPath,
        patchText: "",
        checkOnly: true,
      });
      const mutablePreview = {
        ...preview,
        contentSummary: {
          ...preview.contentSummary!,
          sha256: "0".repeat(64),
        },
      };
      await expect(
        operations.execute(
          mutablePreview,
          operations.createConfirmation(mutablePreview),
        ),
      ).rejects.toThrow(/content snapshot changed/i);
    },
  );

  realGitIntegrationTest(
    "rejects signed-tag intent instead of claiming unsigned success",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await expect(
        operations.previewTagCreate({
          repositoryRoot: fixture.repositoryPath,
          tagName: "signed-intent",
          signed: true,
        }),
      ).rejects.toThrow(/signed tag.*unsupported/i);
    },
  );

  realGitIntegrationTest(
    "reports final state when rollback itself fails",
    async () => {
      const fixture = await createFixture();
      const operations = createOperations();
      await runGit(fixture.repositoryPath, ["tag", "rollback-fault"]);
      const preview = await operations.previewTagCreate({
        repositoryRoot: fixture.repositoryPath,
        tagName: "rollback-fault",
      });
      const pendingOperationRegistry = (
        operations as unknown as {
          readonly pendingOperations: Map<
            string,
            { rollback?: () => Promise<boolean> }
          >;
        }
      ).pendingOperations;
      const pendingOperation = pendingOperationRegistry.get(
        preview.confirmationPlan.confirmationToken,
      );
      if (pendingOperation === undefined)
        throw new Error("pending operation missing");
      pendingOperation.rollback = () =>
        Promise.reject(new Error("rollback fault"));
      try {
        await operations.execute(
          preview,
          operations.createConfirmation(preview),
        );
        throw new Error("expected execute to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(GitOperationError);
        const operationError = error as GitOperationError;
        expect(operationError.rollback?.status).toBe("failed");
        expect(operationError.finalState?.repositoryRoot).toBeDefined();
        expect(operationError.message).toMatch(/rollback fault|Final state/i);
      }
    },
  );

  realGitIntegrationTest(
    "cancels a waiting Git child and rejects with a mutation outcome readback",
    async () => {
      const fixture = await createFixture();
      const cancellationController = new AbortController();
      const commandPromise = new NodeGitCommandRunner().run({
        repositoryRoot: fixture.repositoryPath,
        arguments: ["cat-file", "--batch"],
        cancellationSignal: cancellationController.signal,
      });
      setTimeout(() => cancellationController.abort(), 40);
      await expect(commandPromise).rejects.toThrow(/cancelled/i);
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

interface Fixture {
  readonly rootPath: string;
  readonly repositoryPath: string;
}

async function createFixture(): Promise<Fixture> {
  const rootPath = await mkdtemp(nodePath.join("/tmp", "gito-remediation-"));
  fixtureDirectories.push(rootPath);
  const repositoryPath = nodePath.join(rootPath, "repository");
  await runGit(rootPath, ["init", "-b", "main", repositoryPath]);
  await runGit(repositoryPath, ["config", "user.name", "Fixture"]);
  await runGit(repositoryPath, [
    "config",
    "user.email",
    "fixture@example.test",
  ]);
  await writeFile(nodePath.join(repositoryPath, "README.md"), "base\n");
  await commit(repositoryPath, "fixture: base");
  return { rootPath, repositoryPath };
}

async function createSha256Fixture(): Promise<Fixture> {
  const rootPath = await mkdtemp(nodePath.join("/tmp", "gito-sha256-"));
  fixtureDirectories.push(rootPath);
  const repositoryPath = nodePath.join(rootPath, "repository");
  await runGit(rootPath, [
    "init",
    "--object-format=sha256",
    "-b",
    "main",
    repositoryPath,
  ]);
  await runGit(repositoryPath, ["config", "user.name", "Fixture"]);
  await runGit(repositoryPath, [
    "config",
    "user.email",
    "fixture@example.test",
  ]);
  await writeFile(nodePath.join(repositoryPath, "README.md"), "base\n");
  await commit(repositoryPath, "fixture: sha256 base");
  return { rootPath, repositoryPath };
}

async function commit(repositoryPath: string, message: string): Promise<void> {
  await runGit(repositoryPath, ["add", "--all"]);
  await runGit(repositoryPath, ["commit", "-m", message]);
}

async function createReplacementCommit(
  repositoryPath: string,
): Promise<string> {
  const treeObject = await runGit(repositoryPath, ["rev-parse", "HEAD^{tree}"]);
  const parentCommit = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  return runGit(repositoryPath, [
    "commit-tree",
    treeObject,
    "-p",
    parentCommit,
    "-m",
    "fixture: replacement object",
  ]);
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
