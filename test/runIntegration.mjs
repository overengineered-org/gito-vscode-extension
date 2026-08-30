import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

const integrationFixtureRoot = mkdtempSync(join(tmpdir(), "gito-integration-"));
const remoteRepositoryPath = join(integrationFixtureRoot, "remote.git");
const workspaceRepositoryPath = join(integrationFixtureRoot, "workspace");

try {
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

  await runTests({
    extensionDevelopmentPath: resolve("."),
    extensionTestsPath: resolve(".integration-test/suite.cjs"),
    launchArgs: [
      workspaceRepositoryPath,
      `--extensions-dir=${join(integrationFixtureRoot, "extensions")}`,
      `--user-data-dir=${join(integrationFixtureRoot, "user-data")}`,
      "--disable-extensions",
      "--disable-telemetry",
      "--disable-workspace-trust",
      "--skip-welcome",
    ],
  });
} finally {
  rmSync(integrationFixtureRoot, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 50,
  });
}

function runGit(gitArguments) {
  execFileSync("git", gitArguments, { stdio: "pipe" });
}
