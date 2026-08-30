import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  calculateNextReleaseVersion,
  findLatestReleaseTagVersion,
} from "../scripts/resolve-release-version.mjs";

test("increments the greater package or release-tag baseline", () => {
  assert.equal(calculateNextReleaseVersion("0.8.10", undefined, "patch"), "0.8.11");
  assert.equal(calculateNextReleaseVersion("0.8.10", "0.8.11", "patch"), "0.8.12");
  assert.equal(calculateNextReleaseVersion("0.8.10", "0.8.9", "minor"), "0.9.0");
  assert.equal(calculateNextReleaseVersion("0.8.10", "0.9.4", "major"), "1.0.0");
});

test("rejects unstable versions and unsupported increments", () => {
  assert.throws(
    () => calculateNextReleaseVersion("0.8.10-beta.1", undefined, "patch"),
    /stable semantic versioning/u,
  );
  assert.throws(
    () => calculateNextReleaseVersion("0.8.10", undefined, "automatic"),
    /Unsupported release increment/u,
  );
});

test("finds the greatest stable release tag independent of tag order", (testContext) => {
  const releaseTagRepositoryPath = mkdtempSync(join(tmpdir(), "gito-release-tags-"));
  testContext.after(() => rmSync(releaseTagRepositoryPath, { recursive: true, force: true }));
  const runRepositoryGit = (gitArguments) =>
    execFileSync("git", ["-C", releaseTagRepositoryPath, ...gitArguments], { stdio: "ignore" });

  runRepositoryGit(["init"]);
  runRepositoryGit(["config", "user.name", "Repository Maintainer"]);
  runRepositoryGit(["config", "user.email", "repository-maintainer@overengineered.invalid"]);
  runRepositoryGit(["commit", "--allow-empty", "-m", "test: release baseline"]);
  for (const releaseTagName of ["v0.9.0", "v1.2.0", "v1.0.0", "v2.0.0-beta.1"]) {
    runRepositoryGit(["tag", releaseTagName]);
  }

  assert.equal(findLatestReleaseTagVersion(releaseTagRepositoryPath), "1.2.0");
});
