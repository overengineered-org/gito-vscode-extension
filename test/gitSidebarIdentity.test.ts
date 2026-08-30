import assert from "node:assert/strict";
import test from "node:test";

import { createGitSidebarTreeItemId } from "../src/gitSidebarIdentity.ts";

test("creates stable collision-safe tree item IDs", () => {
  assert.equal(
    createGitSidebarTreeItemId("/repository", "tag", "release/v1.0"),
    "%2Frepository:tag:release%2Fv1.0",
  );
  assert.notEqual(
    createGitSidebarTreeItemId("/repository", "branch", "main"),
    createGitSidebarTreeItemId("/other-repository", "branch", "main"),
  );
});
