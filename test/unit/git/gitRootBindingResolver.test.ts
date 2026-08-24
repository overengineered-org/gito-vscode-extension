// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GitRootBindingResolver,
  validateGitExecutablePath,
} from "../../../src/extension/git/index.js";
import type {
  GitDirectoryCommandExecutionOptions,
  GitRootBindingIdentity,
} from "../../../src/extension/git/gitCommandRunner.js";

const rootIdentity: GitRootBindingIdentity = {
  canonicalPath: "/repository",
  device: "1",
  inode: "2",
  gitDirectory: {
    canonicalPath: "/repository/.git",
    device: "1",
    inode: "3",
  },
  commonDirectory: {
    canonicalPath: "/repository/.git",
    device: "1",
    inode: "3",
  },
};

describe("GitRootBindingResolver", () => {
  it("passes the configured custom executable to root discovery", async () => {
    const observedExecutablePaths: string[] = [];
    const resolver = new GitRootBindingResolver(
      () => Promise.resolve("/opt/vscode/git"),
      {
        resolveRootBinding: (repositoryRoot, expectedIdentity, options) => {
          void repositoryRoot;
          void expectedIdentity;
          observedExecutablePaths.push(options?.gitExecutablePath ?? "");
          return Promise.resolve(rootIdentity);
        },
      },
    );

    await expect(resolver.resolve("/repository")).resolves.toBe(rootIdentity);
    expect(observedExecutablePaths).toEqual(["/opt/vscode/git"]);
  });

  it("validates Windows executable paths on every host", () => {
    expect(
      validateGitExecutablePath("C:\\Program Files\\Git\\cmd\\git.exe"),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(validateGitExecutablePath("\\\\server\\share\\git.exe")).toBe(
      "\\\\server\\share\\git.exe",
    );
    expect(() => validateGitExecutablePath("git")).toThrow(
      "Git executable path must be absolute",
    );
  });

  it("reuses one validated executable for binding and post-check", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-root-binding-resolver-"),
    );
    const customWindowsGitPath = "C:\\Program Files\\Git\\cmd\\git.exe";
    const gitExecutablePathResolver = vi.fn(() =>
      Promise.resolve(customWindowsGitPath),
    );
    const executeGitDirectoryCommand = vi.fn(
      (root: string, options: GitDirectoryCommandExecutionOptions) => {
        void root;
        void options;
        return Promise.resolve({
          standardOutput: `${repositoryRoot}\n${repositoryRoot}\n`,
          standardError: "",
        });
      },
    );
    const resolver = new GitRootBindingResolver(gitExecutablePathResolver);

    try {
      const identity = await resolver.resolve(repositoryRoot, undefined, {
        executeGitDirectoryCommand,
      });
      await expect(
        resolver.withBinding(
          repositoryRoot,
          identity,
          () => Promise.resolve("complete"),
          { executeGitDirectoryCommand },
        ),
      ).resolves.toBe("complete");
      expect(gitExecutablePathResolver).toHaveBeenCalledTimes(2);
      expect(executeGitDirectoryCommand).toHaveBeenCalledTimes(3);
      expect(
        executeGitDirectoryCommand.mock.calls.map(
          ([, options]) => options.gitExecutablePath,
        ),
      ).toEqual([
        customWindowsGitPath,
        customWindowsGitPath,
        customWindowsGitPath,
      ]);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when no executable resolver is configured", async () => {
    const resolver = new GitRootBindingResolver();

    await expect(resolver.resolve("/repository")).rejects.toThrow(
      "Configured Git executable resolver is required",
    );
    await expect(resolver.assert("/repository", rootIdentity)).rejects.toThrow(
      "Configured Git executable resolver is required",
    );
    await expect(
      resolver.withBinding("/repository", rootIdentity, () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toThrow("Configured Git executable resolver is required");
  });
});
