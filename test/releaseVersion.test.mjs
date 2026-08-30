import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateNextReleaseVersion,
  selectReleaseBaselineVersion,
} from "../scripts/resolve-release-version.mjs";

test("increments the established release baseline by conventional change type", () => {
  assert.equal(calculateNextReleaseVersion("0.8.10", "patch"), "0.8.11");
  assert.equal(calculateNextReleaseVersion("0.8.10", "minor"), "0.9.0");
  assert.equal(calculateNextReleaseVersion("0.8.10", "major"), "1.0.0");
});

test("rejects ambiguous version baselines and release types", () => {
  assert.throws(
    () => calculateNextReleaseVersion("development", "minor"),
    /stable semantic versioning/,
  );
  assert.throws(
    () => calculateNextReleaseVersion("0.8.10", "prerelease"),
    /Unsupported conventional release type/,
  );
});

test("never regresses below either the manifest or latest release tag", () => {
  assert.equal(selectReleaseBaselineVersion("0.8.10", "0.1.0"), "0.8.10");
  assert.equal(selectReleaseBaselineVersion("0.8.10", "0.9.0"), "0.9.0");
  assert.equal(selectReleaseBaselineVersion("1.0.0", "0.99.0"), "1.0.0");
  assert.throws(
    () => selectReleaseBaselineVersion("development", "0.9.0"),
    /stable semantic versioning/,
  );
});
