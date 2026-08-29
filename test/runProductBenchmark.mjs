import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { searchCommitHistory } from "../src/graphSearch.ts";
import { loadWorktreeWipSummary } from "../src/worktreeStatus.ts";

const benchmarkRepositoryPath = mkdtempSync(join(tmpdir(), "gito-product-benchmark-"));
const benchmarkFilePath = join(benchmarkRepositoryPath, "history.txt");
const benchmarkCommitCount = 100;

try {
  runGit(["init", "--initial-branch=main", benchmarkRepositoryPath]);
  runGit(["-C", benchmarkRepositoryPath, "config", "user.name", "Benchmark User"]);
  runGit(["-C", benchmarkRepositoryPath, "config", "user.email", "benchmark@example.invalid"]);
  for (let commitIndex = 1; commitIndex <= benchmarkCommitCount; commitIndex += 1) {
    writeFileSync(benchmarkFilePath, `${"line\n".repeat(commitIndex)}`, "utf8");
    runGit(["-C", benchmarkRepositoryPath, "add", "history.txt"]);
    runGit([
      "-C",
      benchmarkRepositoryPath,
      "commit",
      "-m",
      commitIndex === 73 ? "benchmark: needle commit" : `benchmark: commit ${commitIndex}`,
    ]);
  }

  const gitCommandContext = {
    environment: {},
    executablePath: "git",
    repositoryPath: benchmarkRepositoryPath,
  };
  const searchStartedAt = performance.now();
  const searchPage = await searchCommitHistory(
    gitCommandContext,
    [],
    "message:needle author:Benchmark",
    undefined,
    50,
  );
  const searchMilliseconds = performance.now() - searchStartedAt;
  assert.equal(searchPage.commits.length, 1);

  const fileHistoryStartedAt = performance.now();
  const fileHistoryPage = await searchCommitHistory(
    gitCommandContext,
    [],
    "",
    "history.txt",
    benchmarkCommitCount,
  );
  const fileHistoryMilliseconds = performance.now() - fileHistoryStartedAt;
  assert.equal(fileHistoryPage.commits.length, benchmarkCommitCount);
  assert.deepEqual(
    fileHistoryPage.changeStatsByCommitHash.get(fileHistoryPage.commits[0].hash),
    { additions: 1, deletions: 0 },
  );

  writeFileSync(join(benchmarkRepositoryPath, "untracked.txt"), "WIP\n", "utf8");
  const worktreeStatusStartedAt = performance.now();
  const worktreeWipSummary = await loadWorktreeWipSummary(gitCommandContext);
  const worktreeStatusMilliseconds = performance.now() - worktreeStatusStartedAt;
  assert.equal(worktreeWipSummary.untrackedCount, 1);

  const benchmarkMeasurements = {
    commits: benchmarkCommitCount,
    fileHistoryMilliseconds: Math.round(fileHistoryMilliseconds),
    historySearchMilliseconds: Math.round(searchMilliseconds),
    worktreeStatusMilliseconds: Math.round(worktreeStatusMilliseconds),
  };
  assert.ok(searchMilliseconds < 2_000, "History search exceeded the 2 second product budget.");
  assert.ok(fileHistoryMilliseconds < 2_000, "File history exceeded the 2 second product budget.");
  assert.ok(worktreeStatusMilliseconds < 1_000, "Worktree status exceeded the 1 second product budget.");
  process.stdout.write(`${JSON.stringify(benchmarkMeasurements)}\n`);
} finally {
  rmSync(benchmarkRepositoryPath, { force: true, recursive: true });
}

function runGit(gitArguments) {
  execFileSync("git", gitArguments, { stdio: "pipe" });
}
