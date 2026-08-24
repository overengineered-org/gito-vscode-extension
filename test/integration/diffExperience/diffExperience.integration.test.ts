import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiffRepositoryOpenPlan,
  optionsForDiffPreset,
} from "../../../src/extension/diffExperience/diffExperiencePlans.js";
import {
  GitDiffRequestError,
  GitDiffService,
} from "../../../src/extension/diff/gitDiffService.js";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";

const executeFile = promisify(execFile);
const fixtureDirectories: string[] = [];

afterEach(async () => {
  while (fixtureDirectories.length > 0) {
    const fixtureDirectory = fixtureDirectories.pop();
    if (fixtureDirectory !== undefined)
      await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

describe("native diff experience with real Git", () => {
  it("keeps staged and unstaged snapshots separate for one file", async () => {
    const fixture = await createFixture();
    const readmePath = nodePath.join(fixture.repositoryPath, "README.md");
    await writeFile(readmePath, "initial\nstaged\n");
    await runGit(fixture.repositoryPath, ["add", "README.md"]);
    await writeFile(readmePath, "initial\nstaged\nunstaged\n");
    const service = createService();
    const stagedPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "index-vs-head",
      optionsForDiffPreset("review"),
    );
    const unstagedPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "working-vs-index",
      optionsForDiffPreset("review"),
    );
    expect(stagedPlan.files[0]?.displayPath).toBe("README.md");
    expect(unstagedPlan.files[0]?.displayPath).toBe("README.md");
    expect(stagedPlan.files[0]?.originalUri?.query).not.toBe(
      unstagedPlan.files[0]?.originalUri?.query,
    );
    const openPlan = createDiffRepositoryOpenPlan(
      unstagedPlan,
      "Staged ↔ Working Tree · review",
    );
    expect(openPlan.command).toBe("vscode.diff");
    expect(openPlan.arguments).toEqual([
      unstagedPlan.files[0]?.originalUri,
      unstagedPlan.files[0]?.modifiedUri,
      "Staged ↔ Working Tree · review",
      { preview: false, preserveFocus: false },
    ]);
  });

  it("resolves branch common base and preserves rename and binary metadata", async () => {
    const fixture = await createFixture();
    await runGit(fixture.repositoryPath, ["checkout", "-b", "feature"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "feature.txt"),
      "feature\n",
    );
    await runGit(fixture.repositoryPath, ["add", "feature.txt"]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "feature"]);
    await runGit(fixture.repositoryPath, ["checkout", "main"]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "rename-me.txt"),
      "rename\n",
    );
    await writeFile(
      nodePath.join(fixture.repositoryPath, "binary.bin"),
      Buffer.from([0, 1, 2]),
    );
    await runGit(fixture.repositoryPath, ["add", "."]);
    await runGit(fixture.repositoryPath, ["commit", "-m", "main"]);
    await runGit(fixture.repositoryPath, [
      "mv",
      "rename-me.txt",
      "renamed.txt",
    ]);
    await writeFile(
      nodePath.join(fixture.repositoryPath, "binary.bin"),
      Buffer.from([3, 4, 5]),
    );
    const service = createService();
    const plan = await service.createMergeBaseDiffPlan(
      fixture.repositoryUri,
      "feature",
      "main",
    );
    expect(plan.from.kind).toBe("merge-base");
    expect(plan.files.map((file) => file.displayPath)).toEqual([
      "binary.bin",
      "rename-me.txt",
    ]);
    const workingPlan = await service.createPresetDiffPlan(
      fixture.repositoryUri,
      "working-vs-head",
    );
    expect(
      workingPlan.files.some((file) => file.metadata.changeType === "renamed"),
    ).toBe(true);
    expect(workingPlan.files.some((file) => file.metadata.isBinary)).toBe(true);
  });

  it("cancels before Git work and rejects stale repository binding", async () => {
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
    const staleRoot = createTestUri(
      nodePath.join(fixture.rootDirectory, "stale"),
    );
    await expect(
      service.createRepositoryDiffPlan({
        repositoryRoot: fixture.repositoryUri,
        from: { kind: "revision", repositoryRoot: staleRoot, revision: "HEAD" },
        to: { kind: "working-tree", repositoryRoot: fixture.repositoryUri },
      }),
    ).rejects.toBeInstanceOf(GitDiffRequestError);
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

function createService(): GitDiffService {
  return new GitDiffService(
    new NodeGitCommandRunner(),
    {
      file: (filePath) => createTestUri(filePath),
      empty: (filePath, side) =>
        createTestUri(filePath).with({
          scheme: "gito-empty",
          query: side,
        }),
      symlink: (filePath) =>
        createTestUri(filePath).with({ scheme: "gito-symlink" }),
      workingContent: (filePath) =>
        Promise.resolve(
          createTestUri(filePath).with({ scheme: "gito-working-content" }),
        ),
    },
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
    nodePath.join("/tmp", "gito-diff-experience-"),
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
  await runGit(repositoryPath, ["commit", "-m", "initial"]);
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
      const nextPath = changes.path ?? fsPath;
      return {
        ...createTestUri(nextPath),
        scheme: changes.scheme ?? "file",
        authority: changes.authority ?? "",
        path: nextPath,
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
