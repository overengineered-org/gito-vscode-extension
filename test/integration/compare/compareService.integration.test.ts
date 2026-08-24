import { execFile as executeFileCallback } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { createDiffSymlinkUriProvider } from "../../../src/extension/diff/gitDiffService.js";
import {
  NodeGitCommandRunner,
  type GitCommandOutput,
  type GitCommandRequest,
  type GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import {
  CompareService,
  GitSearchService,
  parseSearchQuery,
  type CompareUriFactory,
} from "../../../src/extension/compare/index.js";

vi.mock("vscode", () => {
  class SnapshotUri {
    public constructor(
      public readonly scheme: string,
      public readonly query: string,
      public readonly path = "",
    ) {}

    public static file(filePath: string): SnapshotUri {
      return new SnapshotUri("file", "", filePath);
    }

    public get fsPath(): string {
      return this.path;
    }

    public static parse(uriText: string): SnapshotUri {
      const separatorIndex = uriText.indexOf(":");
      const querySeparatorIndex = uriText.indexOf("?", separatorIndex + 1);
      return new SnapshotUri(
        separatorIndex < 0 ? uriText : uriText.slice(0, separatorIndex),
        querySeparatorIndex < 0 ? "" : uriText.slice(querySeparatorIndex + 1),
      );
    }
  }
  return { Uri: SnapshotUri };
});

const executeFile = promisify(executeFileCallback);
const disposableRepositories: string[] = [];
const testCompareUriFactory: CompareUriFactory = {
  beginSession: () => undefined,
  empty: (filePath, side) =>
    createTestUri(filePath).with({ scheme: "gito-empty", query: side }),
  symlink: (filePath) =>
    createTestUri(filePath).with({ scheme: "gito-symlink" }),
  workingContent: (filePath) =>
    Promise.resolve(
      createTestUri(filePath).with({ scheme: "gito-working-content" }),
    ),
};
const testRootBindingResolver = new GitRootBindingResolver(() =>
  Promise.resolve("/usr/bin/git"),
);

function createTestUri(
  path: string,
  scheme = "file",
  authority = "",
  query = "",
  fragment = "",
): vscode.Uri {
  const uri: vscode.Uri = {
    scheme,
    authority,
    path,
    query,
    fragment,
    fsPath: path,
    with(changes) {
      return createTestUri(
        changes.path ?? path,
        changes.scheme ?? scheme,
        changes.authority ?? authority,
        changes.query ?? query,
        changes.fragment ?? fragment,
      );
    },
    toString() {
      return `${scheme}://${authority}${path}${query.length === 0 ? "" : `?${query}`}`;
    },
    toJSON() {
      return { scheme, authority, path, query, fragment };
    },
  };
  return uri;
}

afterEach(async () => {
  while (disposableRepositories.length > 0) {
    const directory = disposableRepositories.pop();
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }
});

describe("real local compare and search", () => {
  it("uses the configured Git executable for every root binding", async () => {
    const fixture = await createCompareFixture();
    const observedExecutablePaths: string[] = [];
    const configuredRootBindingResolver = new GitRootBindingResolver(() => {
      observedExecutablePaths.push("/usr/bin/git");
      return Promise.resolve("/usr/bin/git");
    });
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      configuredRootBindingResolver,
    );

    await compareService.resolveCompareTarget(
      createTestUri(fixture.repositoryPath),
      "HEAD",
    );
    expect(observedExecutablePaths.length).toBeGreaterThan(0);
    expect(new Set(observedExecutablePaths)).toEqual(new Set(["/usr/bin/git"]));

    const missingExecutableResolver = new GitRootBindingResolver();
    await expect(
      new CompareService(
        new NodeGitCommandRunner(),
        testCompareUriFactory,
        missingExecutableResolver,
      ).resolveCompareTarget(createTestUri(fixture.repositoryPath), "HEAD"),
    ).rejects.toThrow("Compare repository root is unavailable or changed.");
  }, 15_000);

  it("compares diverged refs from their merge-base and preserves diff URIs", async () => {
    const fixture = await createCompareFixture();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);

    const comparison = await compareService.compare({
      repositoryRoot,
      left: "left",
      right: "right",
      mode: "common-base",
    });
    expect(comparison.commonBaseSha).toBe(fixture.baseSha);
    expect(comparison.multiDiffPlan.command).toBe("vscode.changes");
    expect(comparison.aheadCommits.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);
    expect(comparison.behindCommits.map((commit) => commit.commitSha)).toEqual([
      fixture.leftSha,
    ]);
    expect(comparison.fileCounts).toEqual({
      total: 5,
      added: 2,
      deleted: 0,
      modified: 2,
      renamed: 1,
      copied: 0,
      typeChanged: 0,
      unmerged: 0,
      binary: 1,
      additions: 3,
      deletions: 0,
    });
    expect(
      comparison.files.map((file) => ({
        path: file.path,
        ...(file.previousPath === undefined
          ? {}
          : { previousPath: file.previousPath }),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        isBinary: file.isBinary,
      })),
    ).toEqual([
      {
        path: "app.txt",
        status: "modified",
        additions: 1,
        deletions: 0,
        isBinary: false,
      },
      {
        path: "left.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        isBinary: false,
      },
      {
        path: "binary.bin",
        status: "modified",
        additions: 0,
        deletions: 0,
        isBinary: true,
      },
      {
        path: "renamed.txt",
        previousPath: "rename.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        isBinary: false,
      },
      {
        path: "right.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        isBinary: false,
      },
    ]);
    expect(
      comparison.multiDiffPlan.resources.map((resource) => resource.path),
    ).toEqual([
      "app.txt",
      "left.txt",
      "binary.bin",
      "renamed.txt",
      "right.txt",
    ]);
    const renamedResource = comparison.multiDiffPlan.resources[3];
    expect(renamedResource?.originalUri?.scheme).toBe("git");
    expect(
      JSON.parse(renamedResource?.originalUri?.query ?? "{}"),
    ).toMatchObject({
      path: nodePath.join(fixture.repositoryPath, "rename.txt"),
      ref: fixture.baseSha,
    });
    expect(
      JSON.parse(renamedResource?.modifiedUri?.query ?? "{}"),
    ).toMatchObject({
      path: nodePath.join(fixture.repositoryPath, "renamed.txt"),
      ref: fixture.rightSha,
    });

    const directComparison = await compareService.compare({
      repositoryRoot,
      left: "left",
      right: "right",
      mode: "direct",
    });
    expect(directComparison.commonBaseSha).toBeUndefined();
    expect(
      directComparison.files.map((file) => [file.path, file.status]),
    ).toEqual([
      ["app.txt", "modified"],
      ["binary.bin", "modified"],
      ["left.txt", "deleted"],
      ["renamed.txt", "renamed"],
      ["right.txt", "added"],
    ]);
  });

  it("unions common-base changes when both refs modify one path", async () => {
    const fixture = await createCompareFixture();
    await runGit(fixture.repositoryPath, ["checkout", "right"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "app.txt"),
      "base\nright\n",
    );
    await commit(
      fixture.repositoryPath,
      "right app change",
      "Bob Right",
      "bob@example.com",
      "2024-01-04T10:00:00+00:00",
    );
    await runGit(fixture.repositoryPath, ["checkout", "left"]);

    const comparison = await new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    ).compare({
      repositoryRoot: createTestUri(fixture.repositoryPath),
      left: "left",
      right: "right",
      mode: "common-base",
    });

    expect(comparison.files.map((file) => file.path)).toEqual([
      "app.txt",
      "left.txt",
      "app.txt",
      "binary.bin",
      "renamed.txt",
      "right.txt",
    ]);
    const appFiles = comparison.files.filter((file) => file.path === "app.txt");
    expect(appFiles).toHaveLength(2);
    expect(appFiles[0]?.originalUri?.query).toContain(fixture.baseSha);
    expect(appFiles[0]?.modifiedUri?.query).toContain(fixture.leftSha);
    expect(appFiles[1]?.originalUri?.query).toContain(fixture.baseSha);
    expect(appFiles[1]?.modifiedUri?.query).toContain(
      comparison.right.commitSha,
    );
  });

  it("preserves divergent renames from a common base", async () => {
    const fixture = await createCompareFixture();
    await runGit(fixture.repositoryPath, ["checkout", "left"]);
    await runGit(fixture.repositoryPath, [
      "mv",
      "rename.txt",
      "left-renamed.txt",
    ]);
    await commit(
      fixture.repositoryPath,
      "left rename",
      "Alice Left",
      "alice@example.com",
      "2024-01-04T10:00:00+00:00",
    );

    const comparison = await new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    ).compare({
      repositoryRoot: createTestUri(fixture.repositoryPath),
      left: "left",
      right: "right",
      mode: "common-base",
    });

    expect(
      comparison.files
        .filter((file) => file.status === "renamed")
        .map((file) => [file.previousPath, file.path]),
    ).toEqual([
      ["rename.txt", "left-renamed.txt"],
      ["rename.txt", "renamed.txt"],
    ]);
  });

  it("compares tags, HEAD, index, and working tree with exact staged/unstaged files", async () => {
    const fixture = await createCompareFixture();
    await writeFile(
      nodePath.join(fixture.repositoryPath, "staged.txt"),
      "staged\n",
    );
    await runGit(fixture.repositoryPath, ["add", "staged.txt"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "staged.txt"),
      "staged\nunstaged\n",
    );
    await writeFile(
      nodePath.join(fixture.repositoryPath, "untracked.txt"),
      "new\n",
    );
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);

    const working = await compareService.compare({
      repositoryRoot,
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    expect(working.files.map((file) => [file.path, file.status])).toEqual([
      ["staged.txt", "added"],
      ["untracked.txt", "added"],
    ]);
    expect(working.fileCounts).toMatchObject({
      total: 2,
      added: 2,
      additions: 2,
    });

    const symlinkPath = nodePath.join(fixture.repositoryPath, "untracked-link");
    await symlink("missing-target", symlinkPath);
    const symlinkComparison = await compareService.compare({
      repositoryRoot,
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    expect(symlinkComparison.files).toContainEqual(
      expect.objectContaining({ path: "untracked-link", isSymlink: true }),
    );
    expect(symlinkComparison.fileCounts.symlinks).toBe(1);

    const index = await compareService.compare({
      repositoryRoot,
      left: "HEAD",
      right: "index",
      mode: "direct",
    });
    expect(index.files.map((file) => [file.path, file.status])).toEqual([
      ["staged.txt", "added"],
    ]);
    expect(index.files[0]?.modifiedUri?.scheme).toBe("git");
    expect(
      JSON.parse(index.files[0]?.modifiedUri?.query ?? "{}"),
    ).toMatchObject({
      ref: "",
      path: nodePath.join(fixture.repositoryPath, "staged.txt"),
    });
  });

  it("changes the mutable fingerprint for working and staged mutations", async () => {
    const fixture = await createCompareFixture();
    const readmePath = nodePath.join(fixture.repositoryPath, "app.txt");
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);
    const cleanFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);

    await writeFile(readmePath, "working mutation\n");
    const workingFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    expect(workingFingerprint).not.toBe(cleanFingerprint);

    const untrackedPath = nodePath.join(
      fixture.repositoryPath,
      "fingerprint-untracked.txt",
    );
    await writeFile(untrackedPath, "untracked one\n");
    const firstUntrackedFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    await writeFile(untrackedPath, "untracked two\n");
    const secondUntrackedFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    expect(secondUntrackedFingerprint).not.toBe(firstUntrackedFingerprint);

    await runGit(fixture.repositoryPath, ["add", "app.txt"]);
    const stagedFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    expect(stagedFingerprint).not.toBe(workingFingerprint);
    await runGit(fixture.repositoryPath, ["add", "fingerprint-untracked.txt"]);
    await runGit(fixture.repositoryPath, [
      "commit",
      "-m",
      "fingerprint mutation",
    ]);
    const headMovedFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    expect(headMovedFingerprint).not.toBe(stagedFingerprint);

    const cancellationController = new AbortController();
    cancellationController.abort();
    await expect(
      compareService.getMutableStateFingerprint(
        repositoryRoot,
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed on truncated Git output and hashes tracked working content", async () => {
    const fixture = await createCompareFixture();
    const repositoryRoot = createTestUri(fixture.repositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    const truncatingRunner = {
      run: baseRunner.run.bind(baseRunner),
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        const output = await baseRunner.runStreaming(
          request,
          onStandardOutputChunk,
        );
        if (
          request.arguments[0] === "ls-files" &&
          request.arguments.includes("--cached")
        ) {
          return { ...output, standardOutputTruncated: true };
        }
        return output;
      },
    };
    const truncationService = new CompareService(
      truncatingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      truncationService.getMutableStateFingerprint(repositoryRoot),
    ).rejects.toThrow("capped or truncated");

    const compareService = new CompareService(
      baseRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const cleanFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    await runGit(fixture.repositoryPath, [
      "update-index",
      "--assume-unchanged",
      "app.txt",
    ]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "app.txt"),
      "changed\n",
    );

    expect(
      await compareService.getMutableStateFingerprint(repositoryRoot),
    ).not.toBe(cleanFingerprint);
  });

  it("hashes untracked content beyond the historical prefix limit", async () => {
    const fixture = await createCompareFixture();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);
    const untrackedPath = nodePath.join(
      fixture.repositoryPath,
      "large-untracked.bin",
    );
    const content = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    await writeFile(untrackedPath, content);
    const firstFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);

    content[content.length - 1] = 0x62;
    await writeFile(untrackedPath, content);
    const secondFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);

    expect(secondFingerprint).not.toBe(firstFingerprint);
  }, 15_000);

  it("fingerprints many untracked files within one pinned operation", async () => {
    const fixture = await createCompareFixture();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);
    const untrackedPaths = Array.from({ length: 128 }, (_, fileIndex) =>
      nodePath.join(fixture.repositoryPath, `many-untracked-${fileIndex}.txt`),
    );
    await Promise.all(
      untrackedPaths.map((untrackedPath, fileIndex) =>
        writeFile(untrackedPath, `untracked ${fileIndex}\n`),
      ),
    );
    const firstFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);
    await writeFile(untrackedPaths[64]!, "changed after initial fingerprint\n");
    const secondFingerprint =
      await compareService.getMutableStateFingerprint(repositoryRoot);

    expect(secondFingerprint).not.toBe(firstFingerprint);
  }, 15_000);

  it("rejects a mutable-state read after the pinned root is replaced", async () => {
    const fixture = await createCompareFixture();
    const replacementFixture = await createCompareFixture();
    const movedOriginalPath = `${fixture.repositoryPath}-pinned-moved`;
    disposableRepositories.push(movedOriginalPath);
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);
    const repositoryBinding =
      await compareService.pinRepositoryBinding(repositoryRoot);

    await rename(fixture.repositoryPath, movedOriginalPath);
    await rename(replacementFixture.repositoryPath, fixture.repositoryPath);

    await expect(
      compareService.getMutableStateFingerprint(
        repositoryRoot,
        undefined,
        repositoryBinding,
      ),
    ).rejects.toThrow("Compare repository binding changed");
  });

  it("rejects an untracked path whose parent resolves outside the repository", async () => {
    const fixture = await createCompareFixture();
    const outsideDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-compare-outside-"),
    );
    disposableRepositories.push(outsideDirectory);
    await writeFile(nodePath.join(outsideDirectory, "escape.txt"), "escape\n");
    const symlinkedParent = nodePath.join(fixture.repositoryPath, "nested");
    await symlink(outsideDirectory, symlinkedParent);
    const baseRunner = new NodeGitCommandRunner();
    const adversarialRunner = {
      run: baseRunner.run.bind(baseRunner),
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        if (request.arguments[0] === "ls-files") {
          onStandardOutputChunk("nested/escape.txt\0");
          return {
            standardOutput: "nested/escape.txt\0",
            standardError: "",
            exitCode: 0,
          };
        }
        return baseRunner.runStreaming(request, onStandardOutputChunk);
      },
    };
    const compareService = new CompareService(
      adversarialRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(fixture.repositoryPath),
        left: "HEAD",
        right: "working",
        mode: "direct",
      }),
    ).rejects.toThrow("parent outside repository root");
    await expect(
      compareService.getMutableStateFingerprint(
        createTestUri(fixture.repositoryPath),
      ),
    ).rejects.toThrow("outside repository root");
  });

  it("rejects traversal paths returned by ls-files before URI creation", async () => {
    const fixture = await createCompareFixture();
    const baseRunner = new NodeGitCommandRunner();
    const adversarialRunner = {
      run: baseRunner.run.bind(baseRunner),
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        if (request.arguments[0] === "ls-files") {
          onStandardOutputChunk("../../escape.txt\0");
          return {
            standardOutput: "../../escape.txt\0",
            standardError: "",
            exitCode: 0,
          };
        }
        return baseRunner.runStreaming(request, onStandardOutputChunk);
      },
    };
    const compareService = new CompareService(
      adversarialRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(fixture.repositoryPath),
        left: "HEAD",
        right: "working",
        mode: "direct",
      }),
    ).rejects.toThrow("unsafe compare path");
  });

  it("rejects traversal paths parsed from raw Git diff output", async () => {
    const fixture = await createCompareFixture();
    const baseRunner = new NodeGitCommandRunner();
    const unsafePath = "../../escape.txt";
    const adversarialRunner = {
      run: baseRunner.run.bind(baseRunner),
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        if (
          request.arguments[0] === "diff" &&
          request.arguments.includes("--raw")
        ) {
          const standardOutput = `:100644 100644 aaaaaaaa bbbbbbbb M\0${unsafePath}\0`;
          onStandardOutputChunk(standardOutput);
          return { standardOutput, standardError: "", exitCode: 0 };
        }
        if (
          request.arguments[0] === "diff" &&
          request.arguments.includes("--numstat")
        ) {
          const standardOutput = `1\t1\t${unsafePath}\0`;
          onStandardOutputChunk(standardOutput);
          return { standardOutput, standardError: "", exitCode: 0 };
        }
        return baseRunner.runStreaming(request, onStandardOutputChunk);
      },
    };
    const compareService = new CompareService(
      adversarialRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(fixture.repositoryPath),
        left: "HEAD",
        right: "right",
        mode: "direct",
      }),
    ).rejects.toThrow("unsafe compare path");
  });

  it("uses symlink URIs only for the side whose mode is symlink", async () => {
    const fixture = await createCompareFixture();
    const linkPath = nodePath.join(fixture.repositoryPath, "mode-link");
    await writeFile(
      nodePath.join(fixture.repositoryPath, "mode-target"),
      "target\n",
    );
    await symlink("mode-target", linkPath);
    await commit(
      fixture.repositoryPath,
      "left symlink",
      "Left Author",
      "left@example.com",
      "2024-01-04T10:00:00+00:00",
    );
    await rm(linkPath);
    await writeFile(linkPath, "regular\n");
    const symlinkCalls: string[] = [];
    const uriFactory: CompareUriFactory = {
      beginSession: () => undefined,
      empty: (filePath, side) =>
        createTestUri(filePath).with({ scheme: "gito-empty", query: side }),
      symlink: (filePath) => {
        symlinkCalls.push(filePath);
        return {
          scheme: "gito-symlink",
          fsPath: filePath,
          query: "opaque",
        } as never;
      },
      workingContent: (filePath) => Promise.resolve(createTestUri(filePath)),
    };
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      uriFactory,
      testRootBindingResolver,
    );

    const comparison = await compareService.compare({
      repositoryRoot: createTestUri(fixture.repositoryPath),
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    const modeChange = comparison.files.find(
      (file) => file.path === "mode-link",
    );

    expect(modeChange?.isSymlink).toBe(true);
    expect(modeChange?.originalUri?.scheme).toBe("git");
    expect(modeChange?.modifiedUri?.scheme).toBe("file");
    expect(symlinkCalls).toEqual([]);
  });

  it("keeps a normal working snapshot immutable after its leaf is retargeted", async () => {
    const fixture = await createCompareFixture();
    const outsideDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-compare-snapshot-leaf-outside-"),
    );
    disposableRepositories.push(outsideDirectory);
    const workingFilePath = nodePath.join(fixture.repositoryPath, "app.txt");
    const originalWorkingBytes = Buffer.from("snapshot before leaf retarget\n");
    await writeFile(workingFilePath, originalWorkingBytes);
    const provider = createDiffSymlinkUriProvider();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      provider,
      testRootBindingResolver,
    );

    const comparison = await compareService.compare({
      repositoryRoot: createTestUri(fixture.repositoryPath),
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    const snapshotUri = comparison.files.find(
      (file) => file.path === "app.txt",
    )?.modifiedUri;
    expect(snapshotUri).toBeDefined();
    if (snapshotUri === undefined) throw new Error("working snapshot missing");

    await rm(workingFilePath);
    const outsideFilePath = nodePath.join(outsideDirectory, "app.txt");
    await writeFile(outsideFilePath, "outside after leaf retarget\n");
    await symlink(outsideFilePath, workingFilePath);

    expect(Buffer.from(provider.readSnapshotBytes(snapshotUri))).toEqual(
      originalWorkingBytes,
    );
    provider.dispose();
  });

  it("keeps a normal working snapshot immutable after its parent is retargeted", async () => {
    const fixture = await createCompareFixture();
    const outsideDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-compare-snapshot-parent-outside-"),
    );
    disposableRepositories.push(outsideDirectory);
    const workingParentPath = nodePath.join(fixture.repositoryPath, "nested");
    const workingFilePath = nodePath.join(workingParentPath, "app.txt");
    await mkdir(workingParentPath);
    const originalWorkingBytes = Buffer.from(
      "snapshot before parent retarget\n",
    );
    await writeFile(workingFilePath, originalWorkingBytes);
    const provider = createDiffSymlinkUriProvider();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      provider,
      testRootBindingResolver,
    );

    const comparison = await compareService.compare({
      repositoryRoot: createTestUri(fixture.repositoryPath),
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    const snapshotUri = comparison.files.find(
      (file) => file.path === "nested/app.txt",
    )?.modifiedUri;
    expect(snapshotUri).toBeDefined();
    if (snapshotUri === undefined) throw new Error("working snapshot missing");

    const movedParentPath = `${workingParentPath}-original`;
    await rename(workingParentPath, movedParentPath);
    await symlink(outsideDirectory, workingParentPath);

    expect(Buffer.from(provider.readSnapshotBytes(snapshotUri))).toEqual(
      originalWorkingBytes,
    );
    provider.dispose();
  });

  it("searches message, author, SHA, file, patch, date, refs, and caps pages", async () => {
    const fixture = await createCompareFixture();
    const searchService = new GitSearchService(
      new CompareService(
        new NodeGitCommandRunner(),
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);

    const fileResults = await searchService.search(
      repositoryRoot,
      "file:renamed",
    );
    expect(fileResults.items.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);
    const patchResults = await searchService.search(
      repositoryRoot,
      "patch:right-branch",
    );
    expect(patchResults.items.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);
    const refResults = await searchService.search(repositoryRoot, "ref:left");
    expect(refResults.items.map((commit) => commit.commitSha)).toEqual([
      fixture.leftSha,
    ]);
    const dateResults = await searchService.search(
      repositoryRoot,
      "date:2024-01-02",
    );
    expect(dateResults.items.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);
    const shaResults = await searchService.search(
      repositoryRoot,
      `sha:${fixture.rightSha.slice(0, 8)}`,
    );
    expect(shaResults.items.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);

    const capped = await searchService.search(repositoryRoot, "", {
      pageIndex: 0,
      pageSize: 1,
      maxResults: 1,
    });
    expect(capped.items).toHaveLength(1);
    expect(capped.reachedSafetyCap).toBe(true);
    // A safety-capped scan has no resumable cursor/snapshot. Do not advertise
    // a continuation page that can only repeat an empty result.
    expect(capped.hasMore).toBe(false);
    expect(capped.nextPageIndex).toBeUndefined();
    const emptyContinuation = await searchService.search(repositoryRoot, "", {
      pageIndex: 1,
      pageSize: 1,
      maxResults: 1,
    });
    expect(emptyContinuation.items).toHaveLength(0);
    expect(emptyContinuation.hasMore).toBe(false);
    expect(emptyContinuation.nextPageIndex).toBeUndefined();

    const cancelledController = new AbortController();
    cancelledController.abort();
    await expect(
      searchService.search(repositoryRoot, "", {
        cancellationSignal: cancelledController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(parseSearchQuery("author:right").clauses[0]?.field).toBe("author");
  }, 20_000);

  it("reports incomplete commit-body scans instead of claiming complete search", async () => {
    const fixture = await createCompareFixture();
    await writeFile(
      nodePath.join(fixture.repositoryPath, "body-cap.txt"),
      "body-cap\n",
    );
    await commit(
      fixture.repositoryPath,
      `body cap subject\n\n${"x".repeat(3_000)}needle-at-the-end`,
      "Body Author",
      "body@example.com",
      "2024-01-05T10:00:00+00:00",
    );
    const searchService = new GitSearchService(
      new CompareService(
        new NodeGitCommandRunner(),
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );
    const result = await searchService.search(
      createTestUri(fixture.repositoryPath),
      "message:needle-at-the-end",
      { maxOutputBytes: 1_024 },
    );
    expect(result.items).toHaveLength(0);
    expect(result.reachedSafetyCap).toBe(true);
  });

  it("rejects unsafe refs and repository binding mismatches", async () => {
    const fixture = await createCompareFixture();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(fixture.repositoryPath),
        left: "--upload-pack=evil",
        right: "HEAD",
      }),
    ).rejects.toThrow("Unsafe Git reference");
    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(fixture.parentDirectory),
        left: "HEAD",
        right: "HEAD",
      }),
    ).rejects.toThrow(/not a Git repository|different Git repository/);
  });

  it("revalidates a pinned canonical root after a symlink retarget", async () => {
    const fixture = await createCompareFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.parentDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    let hasRetargetedLink = false;
    const retargetingRunner = {
      run: async (request: Parameters<typeof baseRunner.run>[0]) => {
        const output = await baseRunner.run(request);
        if (!hasRetargetedLink) {
          hasRetargetedLink = true;
          await rm(linkedRepositoryPath, { force: true });
          await symlink(fixture.parentDirectory, linkedRepositoryPath);
        }
        return output;
      },
      runStreaming: baseRunner.runStreaming.bind(baseRunner),
    };
    const compareService = new CompareService(
      retargetingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(linkedRepositoryPath),
        left: "HEAD",
        right: "HEAD",
      }),
    ).rejects.toThrow("Compare repository binding changed");
  });

  it("rejects a symlink retarget after the final normal Git command", async () => {
    const fixture = await createCompareFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.parentDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    const retargetingRunner = {
      run: async (request: Parameters<typeof baseRunner.run>[0]) => {
        const output = await baseRunner.run(request);
        if (
          request.arguments[0] === "rev-parse" &&
          request.arguments[1] === "--verify"
        ) {
          await rm(linkedRepositoryPath, { force: true });
          await symlink(fixture.parentDirectory, linkedRepositoryPath);
        }
        return output;
      },
      runStreaming: baseRunner.runStreaming.bind(baseRunner),
    };
    const compareService = new CompareService(
      retargetingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.resolveCompareTarget(
        createTestUri(linkedRepositoryPath),
        "HEAD",
      ),
    ).rejects.toThrow("Compare repository binding changed");
  });

  it("rejects a symlink retarget after the final bounded Git stream", async () => {
    const fixture = await createCompareFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.parentDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    const retargetingRunner = {
      run: baseRunner.run.bind(baseRunner),
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        const output = await baseRunner.runStreaming(
          request,
          onStandardOutputChunk,
        );
        if (request.arguments[0] === "ls-files") {
          await rm(linkedRepositoryPath, { force: true });
          await symlink(fixture.parentDirectory, linkedRepositoryPath);
        }
        return output;
      },
    };
    const compareService = new CompareService(
      retargetingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(linkedRepositoryPath),
        left: "HEAD",
        right: "working",
        mode: "direct",
      }),
    ).rejects.toThrow("Compare repository binding changed");
  });

  it("rejects a symlink retarget after a truncated bounded Git stream", async () => {
    const fixture = await createCompareFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.parentDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    const retargetingRunner = {
      run: baseRunner.run.bind(baseRunner),
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        if (request.arguments[0] !== "ls-files") {
          return baseRunner.runStreaming(request, onStandardOutputChunk);
        }
        onStandardOutputChunk("untracked.txt\0");
        await rm(linkedRepositoryPath, { force: true });
        await symlink(fixture.parentDirectory, linkedRepositoryPath);
        return {
          standardOutput: "untracked.txt\0",
          standardError: "",
          exitCode: 0,
        };
      },
    };
    const compareService = new CompareService(
      retargetingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(linkedRepositoryPath),
        left: "HEAD",
        right: "working",
        mode: "direct",
        options: { maxOutputBytes: 1 },
      }),
    ).rejects.toThrow("Compare repository binding changed");
  });

  it("rejects replacement of the pinned repository at the same canonical path", async () => {
    const fixture = await createCompareFixture();
    const replacementFixture = await createCompareFixture();
    const originalRepositoryPath = nodePath.join(
      fixture.parentDirectory,
      "repository-original",
    );
    const baseRunner = new NodeGitCommandRunner();
    let hasReplacedRepository = false;
    const replacingRunner = {
      run: async (request: Parameters<typeof baseRunner.run>[0]) => {
        const output = await baseRunner.run(request);
        if (
          !hasReplacedRepository &&
          request.arguments[0] === "rev-parse" &&
          request.arguments[1] === "--show-toplevel"
        ) {
          hasReplacedRepository = true;
          await rename(fixture.repositoryPath, originalRepositoryPath);
          await rename(
            replacementFixture.repositoryPath,
            fixture.repositoryPath,
          );
        }
        return output;
      },
      runStreaming: baseRunner.runStreaming.bind(baseRunner),
    };
    const compareService = new CompareService(
      replacingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );

    await expect(
      compareService.compare({
        repositoryRoot: createTestUri(fixture.repositoryPath),
        left: "HEAD",
        right: "HEAD",
      }),
    ).rejects.toThrow("Compare repository binding changed");
  });

  it("uses the canonical root for Git while preserving the display URI", async () => {
    const fixture = await createCompareFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.parentDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    const gitWorkingDirectories: string[] = [];
    const capturingRunner = {
      run: async (request: Parameters<typeof baseRunner.run>[0]) => {
        gitWorkingDirectories.push(request.repositoryRoot);
        return baseRunner.run(request);
      },
      runStreaming: async (
        request: Parameters<typeof baseRunner.runStreaming>[0],
        onStandardOutputChunk: Parameters<typeof baseRunner.runStreaming>[1],
      ) => {
        gitWorkingDirectories.push(request.repositoryRoot);
        return baseRunner.runStreaming(request, onStandardOutputChunk);
      },
    };
    const compareService = new CompareService(
      capturingRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const comparison = await compareService.compare({
      repositoryRoot: createTestUri(linkedRepositoryPath),
      left: "HEAD",
      right: "HEAD",
    });

    expect(comparison.repositoryRoot.fsPath).toBe(linkedRepositoryPath);
    expect(new Set(gitWorkingDirectories)).toEqual(
      new Set([await realpath(fixture.repositoryPath)]),
    );
  });

  it("finds sparse older author/date matches past the first log page", async () => {
    const { repositoryRoot, searchService, targetCommitSha } =
      await createSparseSearchFixture();
    for (const query of ["author:Sparse", "date:2024-01-04"]) {
      const result = await searchService.search(repositoryRoot, query);
      expect(result.items.map((item) => item.commitSha)).toContain(
        targetCommitSha,
      );
    }
  }, 15_000);

  it("finds sparse older ref/body matches past the first log page", async () => {
    const gitCommandRunner = new CountingGitCommandRunner();
    const { repositoryRoot, searchService, targetCommitSha } =
      await createSparseSearchFixture(gitCommandRunner);
    for (const query of ["ref:sparse-target", "message:needle"]) {
      const result = await searchService.search(repositoryRoot, query);
      expect(result.items.map((item) => item.commitSha)).toContain(
        targetCommitSha,
      );
    }
    const nativeMessageLogCommands = gitCommandRunner.requests.filter(
      (request) =>
        request.arguments[0] === "log" &&
        request.arguments.includes("--grep=needle"),
    );
    expect(nativeMessageLogCommands).toHaveLength(1);
    expect(nativeMessageLogCommands[0]?.arguments).toEqual(
      expect.arrayContaining(["--fixed-strings", "--regexp-ignore-case"]),
    );
    expect(
      gitCommandRunner.requests.filter((request) =>
        request.arguments.includes("--format=%B"),
      ),
    ).toHaveLength(1);
  }, 20_000);

  it("keeps reverse mutable diffs symmetric and preserves copies/submodules", async () => {
    const fixture = await createCompareFixture();
    const compareService = new CompareService(
      new NodeGitCommandRunner(),
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const repositoryRoot = createTestUri(fixture.repositoryPath);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "reverse.txt"),
      "one\n",
    );
    await runGit(fixture.repositoryPath, ["add", "reverse.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "reverse source"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "reverse.txt"),
      "one\ntwo\n",
    );
    const forward = await compareService.compare({
      repositoryRoot,
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    const reverse = await compareService.compare({
      repositoryRoot,
      left: "working",
      right: "HEAD",
      mode: "direct",
    });
    const forwardFile = forward.files.find(
      (file) => file.path === "reverse.txt",
    );
    const reverseFile = reverse.files.find(
      (file) => file.path === "reverse.txt",
    );
    expect(forwardFile).toMatchObject({
      status: "modified",
      additions: 1,
      deletions: 0,
    });
    expect(reverseFile).toMatchObject({
      status: "modified",
      additions: 0,
      deletions: 1,
    });
    expect(reverse.behindCount).toBe(0);

    await writeFile(
      nodePath.join(fixture.repositoryPath, "reverse-added.txt"),
      "added\n",
    );
    const forwardAdded = await compareService.compare({
      repositoryRoot,
      left: "HEAD",
      right: "working",
      mode: "direct",
    });
    const reverseDeleted = await compareService.compare({
      repositoryRoot,
      left: "working",
      right: "HEAD",
      mode: "direct",
    });
    const forwardAddedFile = forwardAdded.files.find(
      (file) => file.path === "reverse-added.txt",
    );
    const reverseDeletedFile = reverseDeleted.files.find(
      (file) => file.path === "reverse-added.txt",
    );
    expect(forwardAddedFile).toMatchObject({ status: "added" });
    expect(forwardAddedFile?.originalUri?.scheme).toBe("gito-empty");
    expect(forwardAddedFile?.modifiedUri).toBeDefined();
    expect(reverseDeletedFile).toMatchObject({ status: "deleted" });
    expect(reverseDeletedFile?.originalUri).toBeDefined();
    expect(reverseDeletedFile?.modifiedUri?.scheme).toBe("gito-empty");

    await runGit(fixture.repositoryPath, ["add", "reverse.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "copy source"]);
    const copyBaseSha = await runGit(fixture.repositoryPath, [
      "rev-parse",
      "HEAD",
    ]);
    await copyFile(
      nodePath.join(fixture.repositoryPath, "reverse.txt"),
      nodePath.join(fixture.repositoryPath, "copied.txt"),
    );
    await runGit(fixture.repositoryPath, ["add", "copied.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "copy file"]);
    const copyComparison = await compareService.compare({
      repositoryRoot,
      left: copyBaseSha,
      right: "HEAD",
      mode: "direct",
    });
    expect(
      copyComparison.files.find((file) => file.path === "copied.txt"),
    ).toMatchObject({ status: "copied", previousPath: "reverse.txt" });

    const nestedRepository = nodePath.join(fixture.parentDirectory, "nested");
    await runGit(fixture.parentDirectory, ["init", nestedRepository]);
    await runGit(nestedRepository, ["config", "user.name", "Nested User"]);
    await runGit(nestedRepository, [
      "config",
      "user.email",
      "nested@example.com",
    ]);
    await writeFile(nodePath.join(nestedRepository, "nested.txt"), "nested\n");
    await runGit(nestedRepository, ["add", "nested.txt"]);
    await runGit(nestedRepository, ["commit", "-m", "nested"]);
    await runGit(fixture.repositoryPath, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      nestedRepository,
      "nested-module",
    ]);
    const submoduleBaseSha = await runGit(fixture.repositoryPath, [
      "rev-parse",
      "HEAD",
    ]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "submodule"]);
    const submoduleComparison = await compareService.compare({
      repositoryRoot,
      left: submoduleBaseSha,
      right: "HEAD",
      mode: "direct",
    });
    expect(
      submoduleComparison.files.find((file) => file.path === "nested-module"),
    ).toMatchObject({ isSubmodule: true });
  }, 15_000);

  it("enforces streamed patch caps", async () => {
    const fixture = await createCompareFixture();
    await writeFile(
      nodePath.join(fixture.repositoryPath, "large.txt"),
      "x".repeat(20_000),
    );
    await runGit(fixture.repositoryPath, ["add", "large.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "large patch"]);
    const searchService = new GitSearchService(
      new CompareService(
        new NodeGitCommandRunner(),
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );
    const result = await searchService.search(
      createTestUri(fixture.repositoryPath),
      "patch:diff",
      { maxOutputBytes: 64 },
    );
    expect(result.items[0]?.patch).toBeDefined();
    expect(
      Buffer.byteLength(result.items[0]?.patch ?? "", "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(result.reachedSafetyCap).toBe(true);
  });
});

interface CompareFixture {
  readonly parentDirectory: string;
  readonly repositoryPath: string;
  readonly baseSha: string;
  readonly leftSha: string;
  readonly rightSha: string;
}

interface SparseSearchFixture {
  readonly repositoryRoot: vscode.Uri;
  readonly searchService: GitSearchService;
  readonly targetCommitSha: string;
}

async function createCompareFixture(): Promise<CompareFixture> {
  const parentDirectory = await mkdtemp(nodePath.join("/tmp", "gito-compare-"));
  disposableRepositories.push(parentDirectory);
  const repositoryPath = nodePath.join(parentDirectory, "repository");
  await runGit(parentDirectory, ["init", "-b", "main", repositoryPath]);
  await runGit(repositoryPath, ["config", "user.name", "Fixture User"]);
  await runGit(repositoryPath, ["config", "user.email", "fixture@example.com"]);
  await writeFile(nodePath.join(repositoryPath, "app.txt"), "base\n");
  await writeFile(nodePath.join(repositoryPath, "rename.txt"), "rename me\n");
  await writeFile(
    nodePath.join(repositoryPath, "binary.bin"),
    Buffer.from([0, 1, 2]),
  );
  await commit(
    repositoryPath,
    "base commit",
    "Base Author",
    "base@example.com",
    "2024-01-01T10:00:00+00:00",
  );
  const baseSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  await runGit(repositoryPath, ["tag", "v1.0"]);
  await runGit(repositoryPath, ["branch", "left"]);
  await runGit(repositoryPath, ["checkout", "-b", "right"]);
  await runGit(repositoryPath, ["mv", "rename.txt", "renamed.txt"]);
  await writeFile(nodePath.join(repositoryPath, "right.txt"), "right-branch\n");
  await writeFile(
    nodePath.join(repositoryPath, "binary.bin"),
    Buffer.from([0, 3, 4]),
  );
  await commit(
    repositoryPath,
    "right branch rename",
    "Bob Right",
    "bob@example.com",
    "2024-01-02T10:00:00+00:00",
  );
  const rightSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  await runGit(repositoryPath, ["checkout", "left"]);
  await writeFile(nodePath.join(repositoryPath, "left.txt"), "left branch\n");
  await writeFile(nodePath.join(repositoryPath, "app.txt"), "base\nleft\n");
  await commit(
    repositoryPath,
    "left branch change",
    "Alice Left",
    "alice@example.com",
    "2024-01-03T10:00:00+00:00",
  );
  const leftSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  return { parentDirectory, repositoryPath, baseSha, leftSha, rightSha };
}

async function createSparseSearchFixture(
  gitCommandRunner: GitCommandRunner = new NodeGitCommandRunner(),
): Promise<SparseSearchFixture> {
  const fixture = await createCompareFixture();
  await runGit(fixture.repositoryPath, ["checkout", "left"]);
  await writeFile(
    nodePath.join(fixture.repositoryPath, "sparse-target.txt"),
    "target\n",
  );
  await commit(
    fixture.repositoryPath,
    "sparse subject\n\nneedle body text",
    "Sparse Author",
    "sparse@example.com",
    "2024-01-04T10:00:00+00:00",
  );
  const targetCommitSha = await runGit(fixture.repositoryPath, [
    "rev-parse",
    "HEAD",
  ]);
  await runGit(fixture.repositoryPath, ["tag", "sparse-target"]);
  for (let commitIndex = 0; commitIndex < 110; commitIndex += 1) {
    await writeFile(
      nodePath.join(fixture.repositoryPath, "history.txt"),
      `${commitIndex}\n`,
    );
    await commit(
      fixture.repositoryPath,
      `newer history ${commitIndex}`,
      "Newer Author",
      "newer@example.com",
      `2024-02-${String((commitIndex % 28) + 1).padStart(2, "0")}T10:00:00+00:00`,
    );
  }
  const searchService = new GitSearchService(
    new CompareService(
      gitCommandRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    ),
  );
  return {
    repositoryRoot: createTestUri(fixture.repositoryPath),
    searchService,
    targetCommitSha,
  };
}

class CountingGitCommandRunner implements GitCommandRunner {
  public readonly requests: GitCommandRequest[] = [];

  private readonly delegate = new NodeGitCommandRunner();

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    this.requests.push(request);
    return this.delegate.run(request);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    this.requests.push(request);
    return this.delegate.runStreaming(request, onStandardOutputChunk);
  }
}

async function commit(
  repositoryPath: string,
  message: string,
  authorName: string,
  authorEmail: string,
  date: string,
): Promise<void> {
  await runGit(repositoryPath, ["add", "--all"]);
  await executeFile("git", ["commit", "-m", message], {
    cwd: repositoryPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
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
