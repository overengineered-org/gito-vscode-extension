import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadGraphComparisonPreview,
  loadGraphSyncPreview,
  parseLeftRightCommitCounts,
  parseNameStatusRecords,
  parseShortDiffStat,
} from "../src/graphPreview.ts";

test("parses ahead and behind counts without guessing malformed output", () => {
  assert.deepEqual(parseLeftRightCommitCounts("3\t7\n"), [3, 7]);
  assert.throws(() => parseLeftRightCommitCounts("3"), /invalid ahead\/behind counts/u);
  assert.throws(() => parseLeftRightCommitCounts("3 -1"), /invalid ahead\/behind counts/u);
});

test("parses NUL-safe changed paths including renames", () => {
  assert.deepEqual(
    parseNameStatusRecords("M\0src/file.ts\0R100\0old name.ts\0new name.ts\0D\0removed.ts\0"),
    [
      { path: "src/file.ts", status: "M" },
      { path: "old name.ts → new name.ts", status: "R100" },
      { path: "removed.ts", status: "D" },
    ],
  );
  assert.throws(
    () => parseNameStatusRecords("R100\0old.ts\0"),
    /incomplete renamed-path record/u,
  );
});

test("parses singular and plural diff statistics", () => {
  assert.deepEqual(
    parseShortDiffStat(" 2 files changed, 11 insertions(+), 3 deletions(-)"),
    { additions: 11, deletions: 3 },
  );
  assert.deepEqual(
    parseShortDiffStat(" 1 file changed, 1 insertion(+)"),
    { additions: 1, deletions: 0 },
  );
});

test("previews divergent commits and sync consequences from their merge base", async () => {
  const repositoryPath = mkdtempSync(join(tmpdir(), "gito-graph-preview-"));
  try {
    runGit(repositoryPath, ["init", "--initial-branch=main"]);
    runGit(repositoryPath, ["config", "user.name", "Repository Maintainer"]);
    runGit(repositoryPath, ["config", "user.email", "repository-maintainer@overengineered.invalid"]);
    writeFileSync(join(repositoryPath, "shared.txt"), "base\n", "utf8");
    runGit(repositoryPath, ["add", "shared.txt"]);
    runGit(repositoryPath, ["commit", "-m", "test: add shared base"]);
    runGit(repositoryPath, ["switch", "-c", "topic"]);
    writeFileSync(join(repositoryPath, "topic.txt"), "topic\n", "utf8");
    runGit(repositoryPath, ["add", "topic.txt"]);
    runGit(repositoryPath, ["commit", "-m", "test: add topic file"]);
    const topicCommitHash = runGit(repositoryPath, ["rev-parse", "HEAD"]);
    runGit(repositoryPath, ["switch", "main"]);
    writeFileSync(join(repositoryPath, "main.txt"), "main\n", "utf8");
    runGit(repositoryPath, ["add", "main.txt"]);
    runGit(repositoryPath, ["commit", "-m", "test: add main file"]);
    const mainCommitHash = runGit(repositoryPath, ["rev-parse", "HEAD"]);
    const gitCommandContext = {
      environment: {},
      executablePath: "git",
      repositoryPath,
    };

    const comparisonPreview = await loadGraphComparisonPreview(
      gitCommandContext,
      topicCommitHash,
      mainCommitHash,
    );
    assert.equal(comparisonPreview.commitsOnlyInSelectedCommit, 1);
    assert.equal(comparisonPreview.commitsOnlyInCurrentBranch, 1);
    assert.deepEqual(
      comparisonPreview.changedPaths.map(({ path, status }) => [path, status]),
      [["main.txt", "A"], ["topic.txt", "D"]],
    );

    const syncPreview = await loadGraphSyncPreview(gitCommandContext, mainCommitHash, "topic");
    assert.equal(syncPreview.incomingCommitCount, 1);
    assert.equal(syncPreview.outgoingCommitCount, 1);
    assert.equal(syncPreview.conflictRisk, "none");
    assert.deepEqual(syncPreview.incomingChangedPaths, [{ path: "topic.txt", status: "A" }]);
    assert.deepEqual(syncPreview.outgoingChangedPaths, [{ path: "main.txt", status: "A" }]);
  } finally {
    rmSync(repositoryPath, { force: true, recursive: true });
  }
});

function runGit(repositoryPath: string, gitArguments: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...gitArguments], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
