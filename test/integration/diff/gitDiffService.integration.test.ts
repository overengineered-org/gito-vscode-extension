import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class MockUri {
    public readonly scheme: string;
    public readonly fsPath: string;
    public readonly path: string;
    public readonly query: string;

    public constructor(scheme: string, fsPath: string, query = "") {
      this.scheme = scheme;
      this.fsPath = fsPath;
      this.path = fsPath.replaceAll("\\", "/");
      this.query = query;
    }

    public static file(fsPath: string): MockUri {
      return new MockUri("file", fsPath);
    }

    public static parse(uri: string): MockUri {
      const separatorIndex = uri.indexOf(":");
      const scheme = separatorIndex < 0 ? "" : uri.slice(0, separatorIndex);
      const remainder =
        separatorIndex < 0 ? uri : uri.slice(separatorIndex + 1);
      const queryIndex = remainder.indexOf("?");
      return new MockUri(
        scheme,
        queryIndex < 0 ? remainder : remainder.slice(0, queryIndex),
        queryIndex < 0 ? "" : remainder.slice(queryIndex + 1),
      );
    }

    public with(changes: {
      readonly scheme?: string;
      readonly path?: string;
      readonly query?: string;
    }): MockUri {
      return new MockUri(
        changes.scheme ?? this.scheme,
        changes.path ?? this.fsPath,
        changes.query ?? this.query,
      );
    }

    public toString(): string {
      return `${this.scheme}:${this.path}?${this.query}`;
    }
  }
  return { Uri: MockUri };
});

import {
  createDiffSymlinkUriProvider,
  type DiffUriFactory,
  GitDiffRequestError,
  GitDiffService,
} from "../../../src/extension/diff/gitDiffService.js";
import {
  NodeGitCommandRunner,
  type GitRootBindingIdentity,
  type GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";

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

describe("real Git diff service", () => {
  it("rejects remote repository roots before running Git", async () => {
    const service = createService();
    const remoteRepositoryRoot = {
      ...createTestUri("/workspace/repository"),
      scheme: "vscode-remote",
      authority: "ssh-remote+host",
    };

    await expect(
      service.createDiffPlan({
        repositoryRoot: remoteRepositoryRoot,
        from: { kind: "working-tree", repositoryRoot: remoteRepositoryRoot },
        to: { kind: "index", repositoryRoot: remoteRepositoryRoot },
      }),
    ).rejects.toThrow("remote workspaces are not supported");
  });

  it("separates staged and unstaged content for the same file", async () => {
    const fixture = await createFixture();
    const filePath = nodePath.join(fixture.repositoryPath, "README.md");
    await writeFile(filePath, "initial\nstaged\n");
    await runGit(fixture.repositoryPath, ["add", "README.md"]);
    await writeFile(filePath, "initial\nstaged\nunstaged\n");
    const service = createService();

    const stagedPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "index-vs-head",
    );
    const unstagedPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "working-vs-index",
    );

    expect(stagedPlan.files.map((file) => file.displayPath)).toEqual([
      "README.md",
    ]);
    expect(stagedPlan.files[0]?.metadata.additions).toBe(1);
    expect(unstagedPlan.files[0]?.metadata.additions).toBe(1);
    expect(unstagedPlan.files[0]?.originalUri?.scheme).toBe("git");
    expect(
      JSON.parse(unstagedPlan.files[0]?.originalUri?.query ?? "{}"),
    ).toMatchObject({
      path: filePath,
      ref: "",
    });
    expect(unstagedPlan.files[0]?.modifiedUri?.scheme).toBe("file");
  });

  it("uses an immutable provider snapshot for working-tree content", async () => {
    const fixture = await createFixture();
    const filePath = nodePath.join(fixture.repositoryPath, "README.md");
    await writeFile(filePath, "before\n");
    const provider = createDiffSymlinkUriProvider();
    const service = new GitDiffService(
      new NodeGitCommandRunner(),
      {
        file: (path) => createTestUri(path),
        empty: provider.empty,
        symlink: provider.symlink,
        workingContent: provider.workingContent,
      },
      createRootBindingResolver(),
    );

    try {
      const plan = await service.createPresetDiffPlan(
        fixture.repositoryUri,
        "working-vs-head",
      );
      const workingUri = plan.files[0]?.modifiedUri;
      expect(workingUri?.scheme).toBe("file");
      expect(
        Buffer.from(provider.readSnapshotBytes(workingUri!)).toString("utf8"),
      ).toBe("before\n");

      await writeFile(filePath, "after\n");
      expect(
        Buffer.from(provider.readSnapshotBytes(workingUri!)).toString("utf8"),
      ).toBe("before\n");
    } finally {
      provider.dispose();
    }
  });

  it("returns an empty plan for a working-tree compared with itself", async () => {
    const fixture = await createFixture();
    await writeFile(
      nodePath.join(fixture.repositoryPath, "untracked.txt"),
      "untracked\n",
    );
    const service = createService();

    const plan = await service.createRepositoryDiffPlan({
      repositoryRoot: fixture.repositoryUri,
      from: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
      to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
    });

    expect(plan.files).toEqual([]);
    expect(plan.totalFileCount).toBe(0);
    expect(plan.truncated).toBe(false);
  });

  it("reports rename, binary, and symlink metadata", async () => {
    const fixture = await createFixture();
    await writeFile(
      nodePath.join(fixture.repositoryPath, "rename-me.txt"),
      "rename content\n",
    );
    await writeFile(
      nodePath.join(fixture.repositoryPath, "image.bin"),
      Buffer.from([0, 1, 2, 3]),
    );
    if (process.platform !== "win32") {
      await writeFile(
        nodePath.join(fixture.repositoryPath, "symlink-target"),
        "target\n",
      );
      await symlink(
        "symlink-target",
        nodePath.join(fixture.repositoryPath, "link"),
      );
    }
    await runGit(fixture.repositoryPath, ["add", "."]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "test: metadata"]);
    await runGit(fixture.repositoryPath, [
      "mv",
      "rename-me.txt",
      "renamed.txt",
    ]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "image.bin"),
      Buffer.from([9, 8, 7, 6]),
    );
    if (process.platform !== "win32") {
      await writeFile(
        nodePath.join(fixture.repositoryPath, "symlink-target-2"),
        "target two\n",
      );
      await rm(nodePath.join(fixture.repositoryPath, "link"));
      await symlink(
        "symlink-target-2",
        nodePath.join(fixture.repositoryPath, "link"),
      );
    }
    const service = createService();
    const plan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "working-vs-head",
    );
    const rename = plan.files.find(
      (file) => file.displayPath === "renamed.txt",
    );
    const binary = plan.files.find((file) => file.displayPath === "image.bin");
    expect(rename?.metadata.changeType).toBe("renamed");
    expect(rename?.metadata.oldPath).toBe("rename-me.txt");
    expect(binary?.metadata.isBinary).toBe(true);
    if (process.platform !== "win32") {
      const symlinkPlan = plan.files.find(
        (file) => file.displayPath === "link",
      );
      expect(symlinkPlan?.metadata.isSymlink).toBe(true);
    }
    const commitPlan = await service.createCommitVsParentPlan({
      repositoryRoot: fixture.repositoryUri,
      commitRevision: "HEAD",
      options: {
        contextLines: 0,
        whitespaceMode: "ignore-all",
        presentationMode: "intraline",
      },
    });
    expect(commitPlan.kind).toBe("repository");
    expect(commitPlan.presentation).toMatchObject({
      contextLines: 0,
      whitespaceMode: "ignore-all",
      mode: "intraline",
      wordComparison: true,
      intralineComparison: true,
    });
    const changesPlan = service.createMultiDiffEditorPlan(plan);
    expect(changesPlan.command).toBe("vscode.changes");
    expect(changesPlan.resources).toHaveLength(plan.files.length);
  });

  it("resolves merge-base comparisons and caps large plans", async () => {
    const fixture = await createFixture();
    await runGit(fixture.repositoryPath, ["checkout", "-b", "feature"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "feature.txt"),
      "feature\n",
    );
    await runGit(fixture.repositoryPath, ["add", "feature.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "test: feature"]);
    await runGit(fixture.repositoryPath, ["checkout", "main"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "main.txt"),
      "main\n",
    );
    await runGit(fixture.repositoryPath, ["add", "main.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "test: main"]);
    const service = createService();

    const mergeBasePlan = await service.createMergeBaseDiffPlan(
      fixture.repositoryUri,
      "feature",
      "main",
    );
    expect(mergeBasePlan.files.map((file) => file.displayPath)).toEqual([
      "main.txt",
    ]);

    await writeFile(nodePath.join(fixture.repositoryPath, "one.txt"), "1\n");
    await writeFile(nodePath.join(fixture.repositoryPath, "two.txt"), "2\n");
    await writeFile(nodePath.join(fixture.repositoryPath, "three.txt"), "3\n");
    const cappedPlan = await service.createRepositoryDiffPlan({
      repositoryRoot: fixture.repositoryUri,
      from: {
        kind: "revision",
        repositoryRoot: fixture.repositoryUri,
        revision: "HEAD",
      },
      to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
      options: { maxFiles: 2 },
    });
    expect(cappedPlan.files).toHaveLength(2);
    expect(cappedPlan.truncated).toBe(true);
    expect(cappedPlan.omittedFileCount).toBeGreaterThan(0);
  });

  it("caps working-tree plans before URI registration capacity is exhausted", async () => {
    const fixture = await createFixture();
    await writeFile(nodePath.join(fixture.repositoryPath, "one.txt"), "1\n");
    await writeFile(nodePath.join(fixture.repositoryPath, "two.txt"), "2\n");
    await writeFile(nodePath.join(fixture.repositoryPath, "three.txt"), "3\n");
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 2,
      maxWorkingContentBytes: 4,
      maxTotalWorkingContentBytes: 4,
    });
    const service = new GitDiffService(
      new NodeGitCommandRunner(),
      {
        registrationLimits: provider.registrationLimits,
        file: (filePath) => createTestUri(filePath),
        empty: provider.empty,
        symlink: provider.symlink,
        workingContent: provider.workingContent,
      },
      createRootBindingResolver(),
    );

    const cappedPlan = await service.createRepositoryDiffPlan({
      repositoryRoot: fixture.repositoryUri,
      from: {
        kind: "revision",
        repositoryRoot: fixture.repositoryUri,
        revision: "HEAD",
      },
      to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
    });

    expect(cappedPlan.files).toHaveLength(1);
    expect(cappedPlan.caps.maxFiles).toBe(1);
    expect(cappedPlan.truncated).toBe(true);
    expect(cappedPlan.omittedFileCount).toBeGreaterThan(0);
    provider.dispose();
  });

  it("drops an incomplete final untracked path at the output cap", async () => {
    const fixture = await createFixture();
    await writeFile(nodePath.join(fixture.repositoryPath, "a.txt"), "a\n");
    await writeFile(
      nodePath.join(fixture.repositoryPath, "partial-name.txt"),
      "partial\n",
    );
    const service = createService();
    const completeFirstPathOutput = Buffer.byteLength("a.txt\0", "utf8");
    const cappedPlan = await service.createRepositoryDiffPlan({
      repositoryRoot: fixture.repositoryUri,
      from: {
        kind: "revision",
        repositoryRoot: fixture.repositoryUri,
        revision: "HEAD",
      },
      to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
      options: { maxOutputBytes: completeFirstPathOutput + 1 },
    });

    expect(cappedPlan.files.map((file) => file.displayPath)).toEqual(["a.txt"]);
    expect(cappedPlan.truncated).toBe(true);
  });

  it("marks tracked-plus-untracked results truncated at the file cap", async () => {
    const fixture = await createFixture();
    await writeFile(
      nodePath.join(fixture.repositoryPath, "README.md"),
      "tracked mutation\n",
    );
    await writeFile(
      nodePath.join(fixture.repositoryPath, "untracked.txt"),
      "untracked\n",
    );
    const service = createService();

    const cappedPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "working-vs-head",
      { maxFiles: 1 },
    );

    expect(cappedPlan.files.map((file) => file.displayPath)).toEqual([
      "README.md",
    ]);
    expect(cappedPlan.truncated).toBe(true);
    expect(cappedPlan.totalFileCount).toBe(2);
    expect(cappedPlan.omittedFileCount).toBe(1);
  });

  it("rejects unsafe parsed Git paths before creating file URIs", async () => {
    const fixture = await createFixture();
    const baseRunner = new NodeGitCommandRunner();
    const runner: GitCommandRunner = {
      run: async (request) => {
        const output = await baseRunner.run(request);
        return request.arguments.includes("--raw")
          ? {
              ...output,
              standardOutput:
                ":100644 100644 abcdef1 abcdef2 M\0../../escape.txt\0",
            }
          : output;
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const service = createService(runner);

    await expect(
      service.createPresetDiffPlan(fixture.repositoryUri, "working-vs-head"),
    ).rejects.toThrow(/unsafe file path/);
  });

  it("changes the mutable fingerprint for working and staged mutations", async () => {
    const fixture = await createFixture();
    const readmePath = nodePath.join(fixture.repositoryPath, "README.md");
    const service = createService();
    const cleanFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );

    await writeFile(readmePath, "working A\n");
    const firstWorkingFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    await writeFile(readmePath, "working B\n");
    const secondWorkingFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(firstWorkingFingerprint).not.toBe(cleanFingerprint);
    expect(secondWorkingFingerprint).not.toBe(firstWorkingFingerprint);
    const workingFingerprint = secondWorkingFingerprint;

    const untrackedPath = nodePath.join(
      fixture.repositoryPath,
      "fingerprint-untracked.txt",
    );
    await writeFile(untrackedPath, "untracked one\n");
    const firstUntrackedFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    await writeFile(untrackedPath, "untracked two\n");
    const secondUntrackedFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(secondUntrackedFingerprint).not.toBe(firstUntrackedFingerprint);

    await runGit(fixture.repositoryPath, ["add", "README.md"]);
    const stagedFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(stagedFingerprint).not.toBe(workingFingerprint);
    await runGit(fixture.repositoryPath, ["add", "fingerprint-untracked.txt"]);
    await runGit(fixture.repositoryPath, [
      "commit",
      "-m",
      "fingerprint mutation",
    ]);
    const headMovedFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(headMovedFingerprint).not.toBe(stagedFingerprint);

    const cancellationController = new AbortController();
    cancellationController.abort();
    await expect(
      service.getMutableStateFingerprint(
        fixture.repositoryUri,
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  }, 15_000);

  it("rejects every capped mutable-state fingerprint output", async () => {
    const fixture = await createFixture();
    const baseRunner = new NodeGitCommandRunner();
    const truncatedOutputCases = [
      {
        label: "working-tree raw diff",
        matches: (argumentsPassed: readonly string[]) =>
          argumentsPassed.includes("--raw") &&
          !argumentsPassed.includes("--cached"),
      },
      {
        label: "index raw diff",
        matches: (argumentsPassed: readonly string[]) =>
          argumentsPassed.includes("--raw") &&
          argumentsPassed.includes("--cached"),
      },
      {
        label: "untracked paths",
        matches: (argumentsPassed: readonly string[]) =>
          argumentsPassed[0] === "ls-files" &&
          argumentsPassed.includes("--others"),
      },
      {
        label: "tracked paths",
        matches: (argumentsPassed: readonly string[]) =>
          argumentsPassed[0] === "ls-files" &&
          argumentsPassed.includes("--cached"),
      },
      {
        label: "HEAD revision",
        matches: (argumentsPassed: readonly string[]) =>
          argumentsPassed[0] === "rev-parse",
      },
      {
        label: "reference list",
        matches: (argumentsPassed: readonly string[]) =>
          argumentsPassed[0] === "for-each-ref",
      },
    ] as const;

    for (const truncatedOutputCase of truncatedOutputCases) {
      const runner: GitCommandRunner = {
        run: async (request) => {
          const output = await baseRunner.run(request);
          return truncatedOutputCase.matches(request.arguments)
            ? { ...output, standardOutputTruncated: true }
            : output;
        },
        runStreaming: (request, onStandardOutputChunk) =>
          baseRunner.runStreaming(request, onStandardOutputChunk),
      };
      const service = createService(runner);

      await expect(
        service.getMutableStateFingerprint(fixture.repositoryUri),
      ).rejects.toThrow(
        `Mutable-state fingerprint ${truncatedOutputCase.label} output exceeded the safety cap.`,
      );
    }
  }, 15_000);

  it("rejects a mutable-state read after the pinned root is replaced", async () => {
    const fixture = await createFixture();
    const replacementFixture = await createFixture();
    const movedOriginalPath = `${fixture.repositoryPath}-pinned-moved`;
    fixtureDirectories.push(movedOriginalPath);
    const service = createService();
    const repositoryBinding = await service.createRepositoryBinding(
      fixture.repositoryUri,
    );

    await rename(fixture.repositoryPath, movedOriginalPath);
    await rename(replacementFixture.repositoryPath, fixture.repositoryPath);

    await expect(
      service.getMutableStateFingerprint(
        fixture.repositoryUri,
        undefined,
        repositoryBinding,
      ),
    ).rejects.toThrow(/changed or became unavailable/);
  });

  it("hashes complete large untracked files and never follows symlink targets", async () => {
    const fixture = await createFixture();
    const service = createService();
    const largePath = nodePath.join(fixture.repositoryPath, "large.txt");
    await writeFile(largePath, Buffer.alloc(8 * 1024 * 1024 + 1024, 0x61));
    const largeFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    const largeHandle = await open(largePath, "r+");
    try {
      await largeHandle.write(Buffer.from([0x62]), 0, 1, 8 * 1024 * 1024);
    } finally {
      await largeHandle.close();
    }
    const changedLargeFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(changedLargeFingerprint).not.toBe(largeFingerprint);

    if (process.platform === "win32") return;
    const externalPath = nodePath.join(fixture.rootDirectory, "outside.txt");
    const externalReplacementPath = nodePath.join(
      fixture.rootDirectory,
      "outside-replacement.txt",
    );
    const linkPath = nodePath.join(fixture.repositoryPath, "external-link");
    await writeFile(externalPath, "outside one\n");
    await writeFile(externalReplacementPath, "outside replacement\n");
    await symlink(externalPath, linkPath);
    const symlinkFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    await writeFile(externalPath, "outside two\n");
    const externalContentFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(externalContentFingerprint).toBe(symlinkFingerprint);
    await rm(linkPath);
    await symlink(externalReplacementPath, linkPath);
    const swappedSymlinkFingerprint = await service.getMutableStateFingerprint(
      fixture.repositoryUri,
    );
    expect(swappedSymlinkFingerprint).not.toBe(externalContentFingerprint);
  }, 15_000);

  it("rejects an untracked path whose parent symlink escapes the repository", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const externalDirectory = await mkdtemp(
      nodePath.join(fixture.rootDirectory, "external-"),
    );
    await writeFile(nodePath.join(externalDirectory, "secret.txt"), "secret\n");
    await symlink(
      externalDirectory,
      nodePath.join(fixture.repositoryPath, "parent-link"),
    );
    const baseRunner = new NodeGitCommandRunner();
    const runner: GitCommandRunner = {
      run: async (request) => {
        const output = await baseRunner.run(request);
        return request.arguments[0] === "ls-files"
          ? {
              ...output,
              standardOutput: `${output.standardOutput}parent-link/secret.txt\0`,
            }
          : output;
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const service = createService(runner);

    await expect(
      service.getMutableStateFingerprint(fixture.repositoryUri),
    ).rejects.toThrow(/outside repository root/);
  });

  it("uses an empty provider side for additions and decodes quoted patch paths", async () => {
    const fixture = await createFixture();
    const unusualPath = 'quoted name "tab\tfile.txt';
    await writeFile(
      nodePath.join(fixture.repositoryPath, unusualPath),
      "one\ntwo\n",
    );
    const service = createService();
    const addedPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "working-vs-head",
    );
    const addedFile = addedPlan.files.find(
      (file) => file.displayPath === unusualPath,
    );
    expect(addedFile?.metadata.changeType).toBe("added");
    expect(addedFile?.originalUri?.scheme).toBe("gito-empty");
    expect(addedFile?.modifiedUri?.scheme).toBe("file");
    expect(addedFile?.changeRanges).toEqual([
      { oldStartLine: 1, oldLineCount: 0, newStartLine: 1, newLineCount: 0 },
    ]);
  });

  it("rejects cancellation, invalid revisions, and cross-repository sources", async () => {
    const fixture = await createFixture();
    const service = createService();
    const cancellationController = new AbortController();
    cancellationController.abort();
    await expect(
      service.createRepositoryDiffPlan({
        repositoryRoot: fixture.repositoryUri,
        from: {
          kind: "revision",
          repositoryRoot: fixture.repositoryUri,
          revision: "HEAD",
        },
        to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
        cancellationSignal: cancellationController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      service.createRevisionDiffPlan(
        fixture.repositoryUri,
        "does-not-exist",
        "HEAD",
      ),
    ).rejects.toBeInstanceOf(GitDiffRequestError);
    const otherRepository = createTestUri(
      nodePath.join(fixture.rootDirectory, "other"),
    );
    await expect(
      service.createRepositoryDiffPlan({
        repositoryRoot: fixture.repositoryUri,
        from: {
          kind: "revision",
          repositoryRoot: otherRepository,
          revision: "HEAD",
        },
        to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
      }),
    ).rejects.toThrow(/Cross-repository/);
  });

  it("executes Git through the pinned canonical root", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.rootDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const requests: string[] = [];
    const baseRunner = new NodeGitCommandRunner();
    const runner: GitCommandRunner = {
      run: async (request) => {
        requests.push(request.repositoryRoot);
        return baseRunner.run(request);
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const service = createService(runner);

    await service.createPresetDiffPlan(
      createTestUri(linkedRepositoryPath),
      "working-vs-head",
    );

    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests)).toEqual(
      new Set([realpathSync.native(fixture.repositoryPath)]),
    );
  });

  it("passes the full root binding through commit diffs", async () => {
    const fixture = await createFixture();
    const rootBindings: GitRootBindingIdentity[] = [];
    const baseRunner = new NodeGitCommandRunner();
    const runner: GitCommandRunner = {
      run: async (request) => {
        if (request.rootBinding !== undefined) {
          rootBindings.push(request.rootBinding);
        }
        return baseRunner.run(request);
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const service = createService(runner);

    await service.createCommitVsParentPlan({
      repositoryRoot: fixture.repositoryUri,
      commitRevision: "HEAD",
    });

    expect(rootBindings.length).toBeGreaterThan(0);
    const rootBinding = rootBindings[0];
    expect(rootBinding).toBeDefined();
    if (rootBinding === undefined) return;
    expect(rootBinding.canonicalPath).toBe(
      realpathSync.native(fixture.repositoryPath),
    );
    expect(rootBinding.gitDirectory.canonicalPath).toEqual(expect.any(String));
    expect(rootBinding.commonDirectory.canonicalPath).toEqual(
      expect.any(String),
    );
  });

  it("rejects a repository symlink retargeted during Git execution", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const replacementFixture = await createFixture();
    const linkedRepositoryPath = nodePath.join(
      fixture.rootDirectory,
      "repository-link",
    );
    await symlink(fixture.repositoryPath, linkedRepositoryPath);
    const baseRunner = new NodeGitCommandRunner();
    let retargeted = false;
    const runner: GitCommandRunner = {
      run: async (request) => {
        if (!retargeted) {
          retargeted = true;
          await rm(linkedRepositoryPath, { force: true });
          await symlink(
            replacementFixture.repositoryPath,
            linkedRepositoryPath,
          );
        }
        return baseRunner.run(request);
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const service = createService(runner);

    await expect(
      service.createPresetDiffPlan(
        createTestUri(linkedRepositoryPath),
        "working-vs-head",
      ),
    ).rejects.toThrow(/changed or became unavailable/);
  });

  it("rejects a repository directory replaced with another inode", async () => {
    const fixture = await createFixture();
    const replacementFixture = await createFixture();
    const movedOriginalPath = `${fixture.repositoryPath}-moved`;
    fixtureDirectories.push(movedOriginalPath);
    const baseRunner = new NodeGitCommandRunner();
    let replaced = false;
    const runner: GitCommandRunner = {
      run: async (request) => {
        if (!replaced) {
          replaced = true;
          await rename(fixture.repositoryPath, movedOriginalPath);
          await rename(
            replacementFixture.repositoryPath,
            fixture.repositoryPath,
          );
        }
        return baseRunner.run(request);
      },
      runStreaming: (request, onStandardOutputChunk) =>
        baseRunner.runStreaming(request, onStandardOutputChunk),
    };
    const service = createService(runner);

    await expect(
      service.createPresetDiffPlan(fixture.repositoryUri, "working-vs-head"),
    ).rejects.toThrow(/changed or became unavailable/);
  });

  it("rejects a nested selected directory before diff execution", async () => {
    const fixture = await createFixture();
    const nestedDirectory = nodePath.join(fixture.repositoryPath, "nested");
    await mkdir(nestedDirectory);
    const service = createService();

    await expect(
      service.createPresetDiffPlan(
        createTestUri(nestedDirectory),
        "working-vs-head",
      ),
    ).rejects.toThrow(/Git top-level repository/);
  });
});

interface GitFixture {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
  readonly repositoryUri: TestUri;
}

interface TestUri {
  readonly scheme: string;
  readonly authority: string;
  readonly fsPath: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  with(changes: {
    readonly scheme?: string;
    readonly authority?: string;
    readonly path?: string;
    readonly query?: string;
    readonly fragment?: string;
  }): TestUri;
  toString(skipEncoding?: boolean): string;
  toJSON(): unknown;
}

function createService(gitCommandRunner?: GitCommandRunner): GitDiffService {
  const uriFactory: DiffUriFactory = {
    file: (filePath) => createTestUri(filePath),
    empty: (filePath, side) =>
      createTestUri(filePath).with({
        scheme: "gito-empty",
        query: side,
      }),
    symlink: (filePath) =>
      createTestUri(filePath).with({ scheme: "gito-symlink" }),
    workingContent: (filePath) => Promise.resolve(createTestUri(filePath)),
  };
  return new GitDiffService(
    gitCommandRunner ?? new NodeGitCommandRunner(),
    uriFactory,
    createRootBindingResolver(),
  );
}

function createRootBindingResolver(): GitRootBindingResolver {
  return new GitRootBindingResolver(() =>
    Promise.resolve(
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\cmd\\git.exe"
        : "/usr/bin/git",
    ),
  );
}

async function createFixture(): Promise<GitFixture> {
  const rootDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-diff-fixture-"),
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
  await runGit(repositoryPath, ["add", "README.md"]);
  await runGit(repositoryPath, ["commit", "-m", "test: initial"]);
  return {
    rootDirectory,
    repositoryPath,
    repositoryUri: createTestUri(repositoryPath),
  };
}

function createTestUri(fsPath: string): TestUri {
  return {
    scheme: "file",
    authority: "",
    fsPath,
    path: fsPath,
    query: "",
    fragment: "",
    with(changes) {
      return {
        ...createTestUri(fsPath),
        scheme: changes.scheme ?? "file",
        authority: changes.authority ?? "",
        path: changes.path ?? fsPath,
        query: changes.query ?? "",
        fragment: changes.fragment ?? "",
      };
    },
    toString() {
      return `file:${fsPath}`;
    },
    toJSON() {
      return { scheme: "file", path: fsPath };
    },
  };
}

async function runGit(
  repositoryPath: string,
  argumentsPassed: readonly string[],
): Promise<string> {
  const result = await executeFile("git", argumentsPassed, {
    cwd: repositoryPath,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}
