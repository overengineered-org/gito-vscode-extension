import assert from "node:assert/strict";
import test from "node:test";

import { completeGitOperationBeforeTimeout } from "../src/gitOperationTimeout.ts";

test("returns a Git operation that finishes before its deadline", async () => {
  await assert.doesNotReject(
    completeGitOperationBeforeTimeout(Promise.resolve("done"), 50, "Git history"),
  );
});

test("rejects a stalled Git operation at its deadline", async () => {
  await assert.rejects(
    completeGitOperationBeforeTimeout(new Promise(() => undefined), 5, "Git history"),
    /Git history timed out after 5 ms\./u,
  );
});
