// @vitest-environment node

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGitDirectoryDescriptorPaths,
  gitDirectoryResolutionMaxBufferBytes,
  NodeGitCommandRunner,
  resolveGitRootBinding,
} from "../../../src/extension/git/gitCommandRunner.js";

describe("NodeGitCommandRunner", () => {
  it("launches the exact configured Git executable path", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-executable-path-"),
    );
    let launchedCommand = "";
    try {
      const runner = new NodeGitCommandRunner({
        gitExecutablePath: "/opt/vscode/git",
        launchProcess: (command, _argumentsPassed, options) => {
          launchedCommand = command;
          return spawn(process.execPath, ["-e", "process.exit(0)"], options);
        },
      });
      await runner.run({ repositoryRoot, arguments: ["status"] });
      expect(launchedCommand).toBe("/opt/vscode/git");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("passes the configured executable into Git-root discovery", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-root-executable-path-"),
    );
    const observedExecutablePaths: string[] = [];
    try {
      await expect(
        resolveGitRootBinding(repositoryRoot, undefined, {
          gitExecutablePath: "/opt/vscode/git",
          executeGitDirectoryCommand: (_root, options) => {
            observedExecutablePaths.push(options.gitExecutablePath ?? "");
            return Promise.resolve({
              standardOutput: `${repositoryRoot}\n${repositoryRoot}\n`,
              standardError: "",
            });
          },
        }),
      ).resolves.toMatchObject({
        canonicalPath: await realpath(repositoryRoot),
      });
      expect(observedExecutablePaths).toEqual(["/opt/vscode/git"]);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("writes binary standard input once and returns Git's exact digest", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-"),
    );
    try {
      const binaryInput = Uint8Array.from([0, 1, 127, 128, 254, 255, 10]);
      // Git hashes `blob 7\0` followed by these exact seven bytes.
      const expectedBlobDigest = "0bea9aa519bd5cd88a0b5b3f3df533f45eb6ad57";

      const commandOutput = await new NodeGitCommandRunner().run({
        repositoryRoot,
        arguments: ["hash-object", "--stdin"],
        standardInput: binaryInput,
      });

      expect(commandOutput.standardOutput.trim()).toBe(expectedBlobDigest);
      expect(commandOutput.exitCode).toBe(0);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("closes empty standard input for commands that read until EOF", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-empty-input-"),
    );
    try {
      const commandOutput = await new NodeGitCommandRunner().run({
        repositoryRoot,
        arguments: ["hash-object", "--stdin"],
      });

      expect(commandOutput.standardOutput.trim()).toBe(
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("collects capped raw bytes without also retaining text", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-cap-"),
    );
    try {
      const runner = new NodeGitCommandRunner();
      await runner.run({ repositoryRoot, arguments: ["init"] });
      await writeFile(
        join(repositoryRoot, "payload.bin"),
        Buffer.alloc(64 * 1024, 0x7f),
      );
      await writeFile(join(repositoryRoot, "unicode.txt"), "ééé");
      await runner.run({
        repositoryRoot,
        arguments: ["add", "payload.bin", "unicode.txt"],
      });
      await runner.run({
        repositoryRoot,
        arguments: [
          "-c",
          "user.name=Git'o Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "payload",
        ],
      });

      const bytesOnlyOutput = await runner.run({
        repositoryRoot,
        arguments: ["show", "HEAD:payload.bin"],
        collectStandardOutput: false,
        collectStandardOutputBytes: true,
        maxStandardOutputBytes: 1_024,
      });
      expect(bytesOnlyOutput.standardOutput).toBe("");
      expect(bytesOnlyOutput.standardOutputBytes).toHaveLength(1_024);
      expect(bytesOnlyOutput.standardOutputTruncated).toBe(true);

      const textOnlyOutput = await runner.run({
        repositoryRoot,
        arguments: ["show", "HEAD:payload.bin"],
        collectStandardOutputBytes: false,
        maxStandardOutputBytes: 1_024,
      });
      expect(textOnlyOutput.standardOutput).toHaveLength(1_024);
      expect(textOnlyOutput.standardOutputBytes).toBeUndefined();

      const unicodeOutput = await runner.run({
        repositoryRoot,
        arguments: ["show", "HEAD:unicode.txt"],
        maxStandardOutputBytes: 3,
      });
      expect(unicodeOutput.standardOutput).toBe("é");
      expect(unicodeOutput.standardOutputTruncated).toBe(true);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the repository root is swapped immediately before spawn", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-root-swap-"),
    );
    const replacementRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-replacement-"),
    );
    const displacedRoot = `${repositoryRoot}-displaced`;
    try {
      await new NodeGitCommandRunner().run({
        repositoryRoot,
        arguments: ["init"],
      });
      let launchCount = 0;
      const runner = new NodeGitCommandRunner({
        launchProcess: (command, argumentsPassed, options) => {
          launchCount += 1;
          if (launchCount === 1) {
            renameSync(repositoryRoot, displacedRoot);
            renameSync(replacementRoot, repositoryRoot);
          }
          return spawn(command, argumentsPassed, options);
        },
      });

      await expect(
        runner.run({
          repositoryRoot,
          arguments: ["symbolic-ref", "HEAD", "refs/heads/main"],
        }),
      ).rejects.toThrow("Repository root changed before Git started.");
      expect(launchCount).toBe(1);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(replacementRoot, { recursive: true, force: true });
      await rm(displacedRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicit root identity changed before execution", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-pinned-root-"),
    );
    const replacementRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-pinned-replacement-"),
    );
    const displacedRoot = `${repositoryRoot}-displaced`;
    try {
      const rootBinding = await resolveGitRootBinding(repositoryRoot);
      renameSync(repositoryRoot, displacedRoot);
      renameSync(replacementRoot, repositoryRoot);
      await expect(
        new NodeGitCommandRunner().run({
          repositoryRoot,
          rootBinding,
          arguments: ["init"],
        }),
      ).rejects.toThrow("Repository root identity changed");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(replacementRoot, { recursive: true, force: true });
      await rm(displacedRoot, { recursive: true, force: true });
    }
  });

  it("rejects a gitfile retarget even when the worktree root is unchanged", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-gitfile-retarget-"),
    );
    const displacedGitDirectory = `${repositoryRoot}-git-displaced`;
    try {
      const runner = new NodeGitCommandRunner();
      await runner.run({ repositoryRoot, arguments: ["init"] });
      const rootBinding = await resolveGitRootBinding(repositoryRoot);
      renameSync(join(repositoryRoot, ".git"), displacedGitDirectory);
      await writeFile(
        join(repositoryRoot, ".git"),
        `gitdir: ${displacedGitDirectory}\n`,
      );

      await expect(
        runner.run({
          repositoryRoot,
          rootBinding,
          arguments: ["rev-parse", "--git-dir"],
        }),
      ).rejects.toThrow("Git-directory identity changed");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(displacedGitDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when a git directory is replaced after binding and before spawn", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-gitdir-race-"),
    );
    const replacementGitDirectory = await mkdtemp(
      join(tmpdir(), "gito-command-runner-gitdir-replacement-"),
    );
    const displacedGitDirectory = `${repositoryRoot}-git-displaced`;
    try {
      const setupRunner = new NodeGitCommandRunner();
      await setupRunner.run({ repositoryRoot, arguments: ["init"] });
      let launchCount = 0;
      const runner = new NodeGitCommandRunner({
        launchProcess: (command, argumentsPassed, options) => {
          launchCount += 1;
          if (launchCount === 1) {
            renameSync(join(repositoryRoot, ".git"), displacedGitDirectory);
            renameSync(replacementGitDirectory, join(repositoryRoot, ".git"));
          }
          return spawn(command, argumentsPassed, options);
        },
      });
      const rootBinding = await resolveGitRootBinding(repositoryRoot);

      await expect(
        runner.run({
          repositoryRoot,
          rootBinding,
          arguments: ["rev-parse", "--git-dir"],
        }),
      ).rejects.toThrow("Git directory changed before Git execution.");
      expect(launchCount).toBe(1);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(replacementGitDirectory, { recursive: true, force: true });
      await rm(displacedGitDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when a common Git directory is replaced after binding and before spawn", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-common-race-root-"),
    );
    const externalGitDirectory = await mkdtemp(
      join(tmpdir(), "gito-command-runner-common-race-common-"),
    );
    const replacementCommonDirectory = await mkdtemp(
      join(tmpdir(), "gito-command-runner-common-race-replacement-"),
    );
    const displacedCommonDirectory = `${externalGitDirectory}-displaced`;
    try {
      const setupRunner = new NodeGitCommandRunner();
      await setupRunner.run({
        repositoryRoot,
        arguments: ["init", "--separate-git-dir", externalGitDirectory],
      });
      const rootBinding = await resolveGitRootBinding(repositoryRoot);
      let launchCount = 0;
      const runner = new NodeGitCommandRunner({
        launchProcess: (command, argumentsPassed, options) => {
          launchCount += 1;
          if (launchCount === 1) {
            renameSync(externalGitDirectory, displacedCommonDirectory);
            renameSync(replacementCommonDirectory, externalGitDirectory);
          }
          return spawn(command, argumentsPassed, options);
        },
      });

      await expect(
        runner.run({
          repositoryRoot,
          rootBinding,
          arguments: ["rev-parse", "--git-common-dir"],
        }),
      ).rejects.toThrow("Git directory changed before Git execution.");
      expect(launchCount).toBe(1);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(externalGitDirectory, { recursive: true, force: true });
      await rm(replacementCommonDirectory, { recursive: true, force: true });
      await rm(displacedCommonDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a retargeted GIT_DIR environment binding", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-git-env-"),
    );
    const replacementGitDirectory = await mkdtemp(
      join(tmpdir(), "gito-command-runner-git-env-replacement-"),
    );
    const previousGitDirectory = process.env.GIT_DIR;
    try {
      const runner = new NodeGitCommandRunner();
      await runner.run({ repositoryRoot, arguments: ["init"] });
      await runner.run({
        repositoryRoot: replacementGitDirectory,
        arguments: ["init", "--bare"],
      });
      const rootBinding = await resolveGitRootBinding(repositoryRoot);
      process.env.GIT_DIR = replacementGitDirectory;

      await expect(
        runner.run({
          repositoryRoot,
          rootBinding,
          arguments: ["rev-parse", "--git-dir"],
        }),
      ).rejects.toThrow("Git-directory identity changed");
    } finally {
      if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDirectory;
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(replacementGitDirectory, { recursive: true, force: true });
    }
  });

  it("cancels a root-bound helper and waits for its Git child to close", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-cancel-"),
    );
    try {
      await new NodeGitCommandRunner().run({
        repositoryRoot,
        arguments: ["init"],
      });
      const cancellationController = new AbortController();
      let launchedProcess: ReturnType<typeof spawn> | undefined;
      let childClosed: Promise<void> | undefined;
      const runner = new NodeGitCommandRunner({
        launchProcess: (command, argumentsPassed, options) => {
          const childProcess = spawn(command, argumentsPassed, options);
          launchedProcess = childProcess;
          childClosed = new Promise((resolve) => {
            childProcess.once("close", () => resolve());
          });
          setTimeout(() => cancellationController.abort(), 25);
          return childProcess;
        },
      });

      await expect(
        runner.run({
          repositoryRoot,
          arguments: ["hash-object", "-w", "--stdin"],
          standardInput: Buffer.alloc(32 * 1024 * 1024, 0x61),
          cancellationSignal: cancellationController.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await childClosed;
      expect(
        launchedProcess?.killed ||
          launchedProcess?.exitCode !== null ||
          launchedProcess?.signalCode !== null,
      ).toBe(true);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }, 20000);

  it("inherits Linux directory descriptors for an external git directory", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-descriptor-root-"),
    );
    const externalGitDirectory = await mkdtemp(
      join(tmpdir(), "gito-command-runner-descriptor-git-"),
    );
    try {
      const runner = new NodeGitCommandRunner();
      await runner.run({
        repositoryRoot,
        arguments: ["init", "--separate-git-dir", externalGitDirectory],
      });
      await expect(
        runner.run({
          repositoryRoot,
          arguments: ["rev-parse", "--is-inside-work-tree"],
        }),
      ).resolves.toMatchObject({ standardOutput: "true\n" });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(externalGitDirectory, { recursive: true, force: true });
    }
  });

  it("supports mutation through a linked worktree on path-bound platforms", async () => {
    const primaryRepositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-linked-primary-"),
    );
    const worktreeParent = await mkdtemp(
      join(tmpdir(), "gito-command-runner-linked-parent-"),
    );
    const linkedWorktreeRoot = join(worktreeParent, "linked");
    try {
      const runner = new NodeGitCommandRunner();
      await runner.run({
        repositoryRoot: primaryRepositoryRoot,
        arguments: ["init"],
      });
      await writeFile(join(primaryRepositoryRoot, "seed.txt"), "seed\n");
      await runner.run({
        repositoryRoot: primaryRepositoryRoot,
        arguments: [
          "-c",
          "user.name=Git'o Test",
          "-c",
          "user.email=test@example.invalid",
          "add",
          "seed.txt",
        ],
      });
      await runner.run({
        repositoryRoot: primaryRepositoryRoot,
        arguments: [
          "-c",
          "user.name=Git'o Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "seed",
        ],
      });
      await runner.run({
        repositoryRoot: primaryRepositoryRoot,
        arguments: ["worktree", "add", "-b", "linked", linkedWorktreeRoot],
      });
      await writeFile(join(linkedWorktreeRoot, "linked.txt"), "linked\n");
      await runner.run({
        repositoryRoot: linkedWorktreeRoot,
        arguments: ["add", "linked.txt"],
      });
      await expect(
        runner.run({
          repositoryRoot: linkedWorktreeRoot,
          arguments: [
            "-c",
            "user.name=Git'o Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "linked",
          ],
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      await rm(primaryRepositoryRoot, { recursive: true, force: true });
      await rm(worktreeParent, { recursive: true, force: true });
    }
  }, 20000);

  it("bounds stderr retained from a failing Git child", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-stderr-"),
    );
    try {
      const runner = new NodeGitCommandRunner({
        launchProcess: (_command, _argumentsPassed, options) =>
          spawn(
            process.execPath,
            ["-e", "process.stderr.write('x'.repeat(10000)); process.exit(2);"],
            options,
          ),
      });
      await expect(
        runner.run({
          repositoryRoot,
          arguments: ["status"],
          maxStandardErrorBytes: 1024,
        }),
      ).rejects.toMatchObject({
        name: "GitCommandFailure",
        standardErrorTruncated: true,
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("cancels and times out Git-directory discovery", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-resolution-"),
    );
    try {
      const cancellationController = new AbortController();
      const cancellationPromise = resolveGitRootBinding(
        repositoryRoot,
        undefined,
        {
          cancellationSignal: cancellationController.signal,
          executeGitDirectoryCommand: () => new Promise(() => undefined),
        },
      );
      cancellationController.abort();
      await expect(cancellationPromise).rejects.toMatchObject({
        name: "AbortError",
      });

      await expect(
        resolveGitRootBinding(repositoryRoot, undefined, {
          timeoutMilliseconds: 5,
          executeGitDirectoryCommand: () => new Promise(() => undefined),
        }),
      ).rejects.toThrow("timed out");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("bounds injected Git-directory discovery output", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-resolution-cap-"),
    );
    try {
      await expect(
        resolveGitRootBinding(repositoryRoot, undefined, {
          executeGitDirectoryCommand: () =>
            Promise.resolve({
              standardOutput: "x".repeat(gitDirectoryResolutionMaxBufferBytes),
              standardError: "x",
            }),
        }),
      ).rejects.toThrow("bounded output");
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("exposes only the Linux descriptor path after platform probing", () => {
    expect(getGitDirectoryDescriptorPaths("linux")).toEqual({
      pathPrefix: "/proc/self/fd",
    });
    expect(getGitDirectoryDescriptorPaths("darwin")).toBeUndefined();
    expect(getGitDirectoryDescriptorPaths("win32")).toBeUndefined();
  });

  it("keeps Windows linked-worktree resolution on the path-bound fallback", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-command-runner-windows-path-binding-"),
    );
    const externalGitDirectory = await mkdtemp(
      join(tmpdir(), "gito-command-runner-windows-git-"),
    );
    try {
      const runner = new NodeGitCommandRunner();
      await runner.run({
        repositoryRoot,
        arguments: ["init", "--separate-git-dir", externalGitDirectory],
      });
      await expect(
        resolveGitRootBinding(repositoryRoot, undefined, { platform: "win32" }),
      ).resolves.toMatchObject({
        gitDirectory: { canonicalPath: await realpath(externalGitDirectory) },
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(externalGitDirectory, { recursive: true, force: true });
    }
  });
});
