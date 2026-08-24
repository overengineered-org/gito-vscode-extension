import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeGitCommandRunner } from "../../src/extension/git/gitCommandRunner.js";
import { GitHistoryService } from "../../src/extension/git/gitHistoryService.js";
import { GitRootBindingResolver } from "../../src/extension/git/gitRootBindingResolver.js";
import { getGitBranchNameValidationMessage } from "../../src/extension/git/gitRefName.js";
import { parseWorktreeList } from "../../src/extension/git/gitWorktreeParser.js";

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

describe("real local Git integration", () => {
  it("keeps ignored files out of the untracked set in mixed status output", async () => {
    const fixtureRoot = await createGitFixture();
    await writeFile(
      nodePath.join(fixtureRoot.repositoryPath, ".gitignore"),
      ".env.local\n",
    );
    await runGit(fixtureRoot.repositoryPath, ["add", ".gitignore"]);
    await runGit(fixtureRoot.repositoryPath, [
      "commit",
      "-m",
      "test: configure ignored fixture path",
    ]);
    await writeFile(
      nodePath.join(fixtureRoot.repositoryPath, ".env.local"),
      "ignored\n",
    );
    await writeFile(
      nodePath.join(fixtureRoot.repositoryPath, "visible.txt"),
      "untracked\n",
    );

    const statusLines = (
      await runGit(fixtureRoot.repositoryPath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
      ])
    ).split(/\r?\n/);
    expect(statusLines).toContain("!! .env.local");
    expect(statusLines).toContain("?? visible.txt");
    expect(statusLines).not.toContain("?? .env.local");

    await runGit(fixtureRoot.repositoryPath, ["add", "--all"]);
    expect(
      await runGit(fixtureRoot.repositoryPath, [
        "diff",
        "--cached",
        "--name-only",
      ]),
    ).toBe("visible.txt");
  });

  it("preserves tab-containing paths from real Git history output", async () => {
    const fixtureRoot = await createGitFixture();
    const tabContainingPath = "release\tnotes.md";
    await writeFile(
      nodePath.join(fixtureRoot.repositoryPath, tabContainingPath),
      "tab path\n",
    );
    await runGit(fixtureRoot.repositoryPath, ["add", "--", tabContainingPath]);
    await runGit(fixtureRoot.repositoryPath, [
      "commit",
      "-m",
      "test: commit tab-containing path",
    ]);
    const commitSha = await runGit(fixtureRoot.repositoryPath, [
      "rev-parse",
      "HEAD",
    ]);
    const historyService = new GitHistoryService(
      new NodeGitCommandRunner(),
      new GitRootBindingResolver(() => Promise.resolve("/usr/bin/git")),
    );
    const commitDetails = await historyService.getCommitDetails(
      { fsPath: fixtureRoot.repositoryPath } as never,
      commitSha,
    );
    expect(commitDetails.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: tabContainingPath }),
      ]),
    );
  });

  it("covers local mutations, remote sync, branches, history, and clean worktrees", async () => {
    const fixtureRoot = await createGitFixture();
    const gitCommandRunner = new NodeGitCommandRunner();
    const historyService = new GitHistoryService(
      gitCommandRunner,
      new GitRootBindingResolver(() => Promise.resolve("/usr/bin/git")),
    );

    await writeFile(
      nodePath.join(fixtureRoot.repositoryPath, "README.md"),
      "initial\nchanged\n",
    );
    expect(
      await runGit(fixtureRoot.repositoryPath, ["status", "--short"]),
    ).toContain("M README.md");
    await runGit(fixtureRoot.repositoryPath, ["add", "--", "README.md"]);
    expect(
      await runGit(fixtureRoot.repositoryPath, [
        "diff",
        "--cached",
        "--name-only",
      ]),
    ).toBe("README.md");
    await runGit(fixtureRoot.repositoryPath, [
      "reset",
      "HEAD",
      "--",
      "README.md",
    ]);
    expect(
      await runGit(fixtureRoot.repositoryPath, [
        "diff",
        "--cached",
        "--name-only",
      ]),
    ).toBe("");
    await runGit(fixtureRoot.repositoryPath, ["add", "--", "README.md"]);
    await runGit(fixtureRoot.repositoryPath, [
      "commit",
      "-m",
      "test: commit local change",
    ]);
    expect(
      await runGit(fixtureRoot.repositoryPath, ["log", "-1", "--format=%s"]),
    ).toBe("test: commit local change");
    await runGit(fixtureRoot.repositoryPath, ["push"]);

    await runGit(fixtureRoot.peerRepositoryPath, ["pull", "--ff-only"]);
    await writeFile(
      nodePath.join(fixtureRoot.peerRepositoryPath, "peer.txt"),
      "peer\n",
    );
    await runGit(fixtureRoot.peerRepositoryPath, ["add", "peer.txt"]);
    await runGit(fixtureRoot.peerRepositoryPath, [
      "commit",
      "-m",
      "test: peer change",
    ]);
    await runGit(fixtureRoot.peerRepositoryPath, ["push"]);
    await runGit(fixtureRoot.repositoryPath, ["fetch"]);
    await runGit(fixtureRoot.repositoryPath, ["pull", "--ff-only"]);
    expect(
      await readFile(
        nodePath.join(fixtureRoot.repositoryPath, "peer.txt"),
        "utf8",
      ),
    ).toBe("peer\n");

    await runGit(fixtureRoot.repositoryPath, ["branch", "fixture/branch"]);
    expect(
      await runGit(fixtureRoot.repositoryPath, [
        "branch",
        "--list",
        "fixture/branch",
      ]),
    ).toContain("fixture/branch");
    expect(getGitBranchNameValidationMessage("HEAD")).toContain("reserved");
    expect(getGitBranchNameValidationMessage("valid/branch")).toBeUndefined();

    const headCommitSha = await runGit(fixtureRoot.repositoryPath, [
      "rev-parse",
      "HEAD",
    ]);
    const historyPage = await historyService.listCommitHistory(
      { fsPath: fixtureRoot.repositoryPath } as never,
      0,
    );
    expect(
      historyPage.commits.some((commit) => commit.commitSha === headCommitSha),
    ).toBe(true);
    const commitDetails = await historyService.getCommitDetails(
      { fsPath: fixtureRoot.repositoryPath } as never,
      headCommitSha,
    );
    expect(commitDetails.files.length).toBeGreaterThan(0);

    const cleanWorktreePath = nodePath.join(
      fixtureRoot.rootDirectory,
      "clean-worktree",
    );
    await runGit(fixtureRoot.repositoryPath, [
      "worktree",
      "add",
      "-b",
      "fixture/clean-worktree",
      cleanWorktreePath,
      "HEAD",
    ]);
    const listedCleanWorktrees = parseWorktreeList(
      await runGit(fixtureRoot.repositoryPath, [
        "worktree",
        "list",
        "--porcelain",
      ]),
    );
    const listedCleanWorktreePaths = listedCleanWorktrees.map(
      (worktree) => worktree.path,
    );
    if (!listedCleanWorktreePaths.includes(await realpath(cleanWorktreePath))) {
      throw new Error(
        JSON.stringify({ listedCleanWorktreePaths, cleanWorktreePath }),
      );
    }
    await runGit(fixtureRoot.repositoryPath, [
      "worktree",
      "remove",
      cleanWorktreePath,
    ]);

    const dirtyWorktreePath = nodePath.join(
      fixtureRoot.rootDirectory,
      "dirty-worktree",
    );
    await runGit(fixtureRoot.repositoryPath, [
      "worktree",
      "add",
      "-b",
      "fixture/dirty-worktree",
      dirtyWorktreePath,
      "HEAD",
    ]);
    await writeFile(nodePath.join(dirtyWorktreePath, "dirty.txt"), "dirty\n");
    await expect(
      runGit(fixtureRoot.repositoryPath, [
        "worktree",
        "remove",
        dirtyWorktreePath,
      ]),
    ).rejects.toThrow(/contains modified|contains changes|is dirty/i);
    expect(
      await runGit(fixtureRoot.repositoryPath, [
        "worktree",
        "list",
        "--porcelain",
      ]),
    ).toContain(await realpath(dirtyWorktreePath));
    await rm(nodePath.join(dirtyWorktreePath, "dirty.txt"));
    await runGit(fixtureRoot.repositoryPath, [
      "worktree",
      "remove",
      dirtyWorktreePath,
    ]);
  }, 30_000);
});

interface GitFixtureDirectories {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
  readonly peerRepositoryPath: string;
}

async function createGitFixture(): Promise<GitFixtureDirectories> {
  const rootDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-git-fixture-"),
  );
  fixtureDirectories.push(rootDirectory);
  const repositoryPath = nodePath.join(rootDirectory, "repository");
  const peerRepositoryPath = nodePath.join(rootDirectory, "peer");
  const bareRemotePath = nodePath.join(rootDirectory, "remote.git");
  await runGit(rootDirectory, ["init", "--bare", bareRemotePath]);
  await runGit(rootDirectory, ["init", "-b", "main", repositoryPath]);
  await runGit(repositoryPath, ["config", "user.name", "Fixture Author"]);
  await runGit(repositoryPath, [
    "config",
    "user.email",
    "fixture@example.test",
  ]);
  await writeFile(nodePath.join(repositoryPath, "README.md"), "initial\n");
  await runGit(repositoryPath, ["add", "README.md"]);
  await runGit(repositoryPath, ["commit", "-m", "test: initial fixture"]);
  await runGit(repositoryPath, ["remote", "add", "origin", bareRemotePath]);
  await runGit(repositoryPath, ["push", "--set-upstream", "origin", "main"]);
  await runGit(rootDirectory, [
    "clone",
    "--branch",
    "main",
    bareRemotePath,
    peerRepositoryPath,
  ]);
  await runGit(peerRepositoryPath, ["config", "user.name", "Peer Author"]);
  await runGit(peerRepositoryPath, [
    "config",
    "user.email",
    "peer@example.test",
  ]);
  return { rootDirectory, repositoryPath, peerRepositoryPath };
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
