import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalizePath, pathsIdentifySameLocation } from "../src/pathIdentity.ts";

test("treats symlink aliases as one repository location", () => {
  const pathIdentityFixture = mkdtempSync(join(tmpdir(), "gito-path-identity-"));
  const pathAlias = `${pathIdentityFixture}-alias`;
  try {
    symlinkSync(pathIdentityFixture, pathAlias);
    assert.equal(pathsIdentifySameLocation(pathIdentityFixture, pathAlias), true);
    assert.equal(canonicalizePath(pathAlias), canonicalizePath(pathIdentityFixture));
  } finally {
    rmSync(pathAlias, { force: true });
    rmSync(pathIdentityFixture, { force: true, recursive: true });
  }
});
