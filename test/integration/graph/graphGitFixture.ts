import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface DisposableGraphGitFixture {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
  readonly remotePath: string;
  readonly worktreePaths: readonly string[];
  readonly preRewriteHeadSha: string;
  dispose(): Promise<void>;
}

async function runGit(
  repositoryPath: string,
  gitArguments: readonly string[],
): Promise<string> {
  const result = await executeFile("git", [...gitArguments], {
    cwd: repositoryPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Graph Fixture",
      GIT_AUTHOR_EMAIL: "graph-fixture@example.test",
      GIT_COMMITTER_NAME: "Graph Fixture",
      GIT_COMMITTER_EMAIL: "graph-fixture@example.test",
    },
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

async function commitFixtureFile(
  repositoryPath: string,
  relativePath: string,
  content: string,
  subject: string,
): Promise<string> {
  await writeFile(path.join(repositoryPath, relativePath), content);
  await runGit(repositoryPath, ["add", relativePath]);
  await runGit(repositoryPath, ["commit", "-m", subject]);
  return (await runGit(repositoryPath, ["rev-parse", "HEAD"])).trim();
}

export async function createDisposableGraphGitFixture(): Promise<DisposableGraphGitFixture> {
  const rootDirectory = await mkdtemp(path.join("/tmp", "gito-graph-fixture-"));
  const repositoryPath = path.join(rootDirectory, "repository");
  const remotePath = path.join(rootDirectory, "remote.git");
  const featureWorktreePath = path.join(rootDirectory, "feature-worktree");
  const octopusWorktreePath = path.join(rootDirectory, "octopus-worktree");
  try {
    await runGit(rootDirectory, ["init", "-b", "main", repositoryPath]);
    const baseSha = await commitFixtureFile(
      repositoryPath,
      "base.txt",
      "base\n",
      "base",
    );
    await runGit(repositoryPath, ["switch", "-c", "feature"]);
    await commitFixtureFile(
      repositoryPath,
      "feature.txt",
      "feature\n",
      "feature",
    );
    await runGit(repositoryPath, ["switch", "main"]);
    await commitFixtureFile(repositoryPath, "main.txt", "main\n", "main line");
    await runGit(repositoryPath, [
      "merge",
      "--no-ff",
      "feature",
      "-m",
      "merge feature",
    ]);
    await runGit(repositoryPath, ["tag", "v1.0.0"]);

    for (const octopusBranch of ["octo-a", "octo-b", "octo-c"]) {
      await runGit(repositoryPath, ["switch", "-c", octopusBranch, baseSha]);
      await commitFixtureFile(
        repositoryPath,
        `${octopusBranch}.txt`,
        `${octopusBranch}\n`,
        octopusBranch,
      );
    }
    await runGit(repositoryPath, ["switch", "main"]);
    await runGit(repositoryPath, [
      "merge",
      "--no-ff",
      "octo-a",
      "octo-b",
      "octo-c",
      "-m",
      "octopus merge",
    ]);
    await runGit(repositoryPath, [
      "tag",
      "-a",
      "v2.0.0",
      "-m",
      "annotated release",
    ]);

    await runGit(rootDirectory, ["init", "--bare", remotePath]);
    await runGit(repositoryPath, ["remote", "add", "origin", remotePath]);
    await runGit(repositoryPath, ["push", "--all", "origin"]);
    await runGit(repositoryPath, ["push", "--tags", "origin"]);
    await runGit(repositoryPath, ["fetch", "origin"]);

    await writeFile(path.join(repositoryPath, "base.txt"), "unstashed\n");
    await runGit(repositoryPath, ["stash", "push", "-m", "fixture stash"]);
    await runGit(repositoryPath, [
      "worktree",
      "add",
      featureWorktreePath,
      "feature",
    ]);
    await runGit(repositoryPath, [
      "worktree",
      "add",
      octopusWorktreePath,
      "octo-a",
    ]);

    await runGit(repositoryPath, ["switch", "-c", "rewritten", baseSha]);
    const preRewriteHeadSha = await commitFixtureFile(
      repositoryPath,
      "rewrite.txt",
      "before rewrite\n",
      "before rewrite",
    );
    await commitFixtureFile(
      repositoryPath,
      "rewrite.txt",
      "after rewrite\n",
      "rewritten history",
    );
    await runGit(repositoryPath, [
      "commit",
      "--amend",
      "-m",
      "rewritten history amended",
    ]);
    await writeFile(
      path.join(repositoryPath, "rewrite.txt"),
      "working tree edit\n",
    );
    return {
      rootDirectory,
      repositoryPath,
      remotePath,
      worktreePaths: [repositoryPath, featureWorktreePath, octopusWorktreePath],
      preRewriteHeadSha,
      dispose: () => rm(rootDirectory, { recursive: true, force: true }),
    };
  } catch (error: unknown) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function runFixtureGit(
  repositoryPath: string,
  gitArguments: readonly string[],
): Promise<string> {
  return runGit(repositoryPath, gitArguments);
}
