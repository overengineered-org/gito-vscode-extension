import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createIntegrationFixture() {
  const integrationFixtureRootPath = mkdtempSync(
    join(realpathSync.native(tmpdir()), "gito-integration-"),
  );
  const remoteRepositoryPath = join(integrationFixtureRootPath, "remote.git");
  const workspaceRepositoryPath = join(integrationFixtureRootPath, "workspace");

  runGit(["init", "--bare", remoteRepositoryPath]);
  runGit(["init", "--initial-branch=main", workspaceRepositoryPath]);
  runGit(["-C", workspaceRepositoryPath, "config", "user.name", "Repository Maintainer"]);
  runGit([
    "-C",
    workspaceRepositoryPath,
    "config",
    "user.email",
    "repository-maintainer@overengineered.invalid",
  ]);
  writeFileSync(join(workspaceRepositoryPath, "history.txt"), "first\n", "utf8");
  runGit(["-C", workspaceRepositoryPath, "add", "history.txt"]);
  runGit(["-C", workspaceRepositoryPath, "commit", "-m", "test: first history entry"]);
  runGit(["-C", workspaceRepositoryPath, "tag", "--annotate", "v1.0.0", "--message", "v1.0.0"]);
  writeFileSync(join(workspaceRepositoryPath, "history.txt"), "first\nsecond\n", "utf8");
  runGit(["-C", workspaceRepositoryPath, "add", "history.txt"]);
  runGit(["-C", workspaceRepositoryPath, "commit", "-m", "test: second history entry"]);
  runGit(["-C", workspaceRepositoryPath, "tag", "v1.1.0"]);
  runGit(["-C", workspaceRepositoryPath, "remote", "add", "origin", remoteRepositoryPath]);
  runGit(["-C", workspaceRepositoryPath, "push", "--set-upstream", "origin", "main"]);
  runGit(["-C", workspaceRepositoryPath, "push", "origin", "--tags"]);
  runGit(["-C", workspaceRepositoryPath, "tag", "local-only"]);
  runGit(["-C", workspaceRepositoryPath, "tag", "--delete", "v1.1.0"]);

  return {
    dispose: () =>
      rmSync(integrationFixtureRootPath, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 50,
      }),
    integrationFixtureRootPath,
    workspaceRepositoryPath,
  };
}

function runGit(gitArguments) {
  execFileSync("git", gitArguments, { stdio: "pipe" });
}
