import assert from "node:assert/strict";
import test from "node:test";

import { CoalescedAsyncRunner } from "../src/coalescedAsyncRunner.ts";

test("finishes the active refresh before running one coalesced follow-up", async () => {
  const forceRefreshValues: boolean[] = [];
  let finishActiveRefresh: (() => void) | undefined;
  const activeRefreshGate = new Promise<void>((resolve) => {
    finishActiveRefresh = resolve;
  });
  const refreshRunner = new CoalescedAsyncRunner(async (forceRefresh) => {
    forceRefreshValues.push(forceRefresh);
    if (forceRefreshValues.length === 1) {
      await activeRefreshGate;
    }
  });

  const activeRefresh = refreshRunner.requestRefresh();
  refreshRunner.requestRefresh();
  refreshRunner.requestRefresh(true);
  finishActiveRefresh?.();
  await activeRefresh;

  assert.deepEqual(forceRefreshValues, [false, true]);
});

test("can refresh again after the queue drains", async () => {
  let refreshCount = 0;
  const refreshRunner = new CoalescedAsyncRunner(async () => {
    refreshCount += 1;
  });

  await refreshRunner.requestRefresh();
  await refreshRunner.requestRefresh();

  assert.equal(refreshCount, 2);
});

test("runs a queued refresh even when the active refresh fails", async () => {
  let refreshCount = 0;
  let finishActiveRefresh: (() => void) | undefined;
  const activeRefreshGate = new Promise<void>((resolve) => {
    finishActiveRefresh = resolve;
  });
  const refreshRunner = new CoalescedAsyncRunner(async () => {
    refreshCount += 1;
    if (refreshCount === 1) {
      await activeRefreshGate;
      throw new Error("First refresh failed");
    }
  });

  const activeRefresh = refreshRunner.requestRefresh();
  refreshRunner.requestRefresh();
  finishActiveRefresh?.();

  await assert.rejects(activeRefresh, /First refresh failed/u);
  assert.equal(refreshCount, 2);
});
