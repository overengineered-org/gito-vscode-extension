import { execFile as executeFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import {
  CompareService,
  GitSearchService,
  type CompareUriFactory,
} from "../../../src/extension/compare/index.js";
import {
  createCompareOpenPlan,
  createCompareSummary,
} from "../../../src/extension/compareExperience/index.js";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";

const executeFile = promisify(executeFileCallback);
const disposableRepositories: string[] = [];
const testCompareUriFactory: CompareUriFactory = {
  beginSession: () => undefined,
  empty: (filePath, side) =>
    testUri(filePath).with({ scheme: "gito-empty", query: side }),
  symlink: (filePath) => testUri(filePath).with({ scheme: "gito-symlink" }),
  workingContent: (filePath) =>
    Promise.resolve(testUri(filePath).with({ scheme: "gito-working-content" })),
};
const testRootBindingResolver = new GitRootBindingResolver(() =>
  Promise.resolve("/usr/bin/git"),
);

function testUri(path: string): vscode.Uri {
  const uri: vscode.Uri = {
    scheme: "file",
    authority: "",
    path,
    query: "",
    fragment: "",
    fsPath: path,
    with(change) {
      return testUri(change.path ?? path);
    },
    toString() {
      return `file://${path}`;
    },
    toJSON() {
      return { scheme: "file", path };
    },
  };
  return uri;
}

afterEach(async () => {
  while (disposableRepositories.length > 0) {
    const repositoryDirectory = disposableRepositories.pop();
    if (repositoryDirectory !== undefined) {
      await rm(repositoryDirectory, { recursive: true, force: true });
    }
  }
});

describe("real Git compare experience foundation", () => {
  it("builds merge-base summary/native plan and searches patches", async () => {
    const fixture = await createDivergedFixture();
    const repositoryRoot = testUri(fixture.repositoryPath);
    const gitCommandRunner = new NodeGitCommandRunner();
    const compareService = new CompareService(
      gitCommandRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );
    const comparison = await compareService.compare({
      repositoryRoot,
      left: "left",
      right: "right",
      mode: "common-base",
    });
    expect(comparison.commonBaseSha).toBe(fixture.baseSha);
    expect(comparison.aheadCommits.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);
    expect(comparison.behindCommits.map((commit) => commit.commitSha)).toEqual([
      fixture.leftSha,
    ]);
    const summary = createCompareSummary(comparison);
    expect(summary.explanation).toBe(
      "Common base: changes since the shared ancestor",
    );
    expect(summary.metrics.find((metric) => metric.id === "ahead")?.value).toBe(
      1,
    );
    expect(
      summary.metrics.find((metric) => metric.id === "behind")?.value,
    ).toBe(1);
    expect(createCompareOpenPlan(comparison).command).toBe("vscode.changes");

    const searchService = new GitSearchService(compareService);
    const patchSearch = await searchService.search(
      repositoryRoot,
      "patch:right-change",
    );
    expect(patchSearch.items.map((commit) => commit.commitSha)).toEqual([
      fixture.rightSha,
    ]);
  });

  it("cancels real Git search and rejects an out-of-repository request", async () => {
    const fixture = await createDivergedFixture();
    const gitCommandRunner = new NodeGitCommandRunner();
    const searchService = new GitSearchService(
      new CompareService(
        gitCommandRunner,
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );
    const cancelledController = new AbortController();
    cancelledController.abort();
    await expect(
      searchService.search(testUri(fixture.repositoryPath), "", {
        cancellationSignal: cancelledController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const compareService = new CompareService(
      gitCommandRunner,
      testCompareUriFactory,
      testRootBindingResolver,
    );
    await expect(
      compareService.compare({
        repositoryRoot: testUri(fixture.parentDirectory),
        left: "left",
        right: "right",
        mode: "common-base",
      }),
    ).rejects.toThrow(/not a Git repository|different Git repository/);
  });
});

interface DivergedFixture {
  readonly parentDirectory: string;
  readonly repositoryPath: string;
  readonly baseSha: string;
  readonly leftSha: string;
  readonly rightSha: string;
}

async function createDivergedFixture(): Promise<DivergedFixture> {
  const parentDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-compare-experience-"),
  );
  disposableRepositories.push(parentDirectory);
  const repositoryPath = nodePath.join(parentDirectory, "repo");
  await executeFile("git", ["init", "-b", "main", repositoryPath]);
  await runGit(repositoryPath, ["config", "user.name", "Compare Tester"]);
  await runGit(repositoryPath, [
    "config",
    "user.email",
    "compare@example.test",
  ]);
  await writeFile(nodePath.join(repositoryPath, "common.txt"), "base\n");
  await runGit(repositoryPath, ["add", "common.txt"]);
  await runGit(repositoryPath, ["commit", "-m", "base commit"]);
  const baseSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  await runGit(repositoryPath, ["branch", "left"]);
  await runGit(repositoryPath, ["checkout", "-b", "right"]);
  await writeFile(nodePath.join(repositoryPath, "right.txt"), "right-change\n");
  await runGit(repositoryPath, ["add", "right.txt"]);
  await runGit(repositoryPath, ["commit", "-m", "right change"]);
  const rightSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  await runGit(repositoryPath, ["checkout", "left"]);
  await writeFile(nodePath.join(repositoryPath, "left.txt"), "left-change\n");
  await runGit(repositoryPath, ["add", "left.txt"]);
  await runGit(repositoryPath, ["commit", "-m", "left change"]);
  const leftSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  return { parentDirectory, repositoryPath, baseSha, leftSha, rightSha };
}

async function runGit(
  repositoryPath: string,
  argumentsPassed: readonly string[],
): Promise<string> {
  const result = await executeFile("git", [...argumentsPassed], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
