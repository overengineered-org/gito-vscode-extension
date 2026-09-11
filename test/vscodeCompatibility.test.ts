import assert from "node:assert/strict";
import test from "node:test";

import { gitViewCommitRequiresHistoryItem } from "../src/vscodeCompatibility.ts";

test("uses the commit argument required by each supported VS Code generation", () => {
  assert.equal(gitViewCommitRequiresHistoryItem("1.95.3"), true);
  assert.equal(gitViewCommitRequiresHistoryItem("1.96.2"), true);
  assert.equal(gitViewCommitRequiresHistoryItem("1.97.0"), false);
  assert.equal(gitViewCommitRequiresHistoryItem("2.0.0"), false);
});

test("rejects an invalid VS Code version", () => {
  assert.throws(
    () => gitViewCommitRequiresHistoryItem("invalid"),
    /Unsupported VS Code version/u,
  );
});
