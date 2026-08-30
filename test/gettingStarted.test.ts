import assert from "node:assert/strict";
import test from "node:test";

import { openGettingStartedOnFirstActivation } from "../src/gettingStarted.ts";

test("opens and remembers the native walkthrough on first activation", async () => {
  const onboardingEvents: string[] = [];

  await openGettingStartedOnFirstActivation(
    false,
    async () => {
      onboardingEvents.push("opened");
    },
    async () => {
      onboardingEvents.push("remembered");
    },
  );

  assert.deepEqual(onboardingEvents, ["opened", "remembered"]);
});

test("does not interrupt returning users with onboarding", async () => {
  const onboardingEvents: string[] = [];

  await openGettingStartedOnFirstActivation(
    true,
    async () => {
      onboardingEvents.push("opened");
    },
    async () => {
      onboardingEvents.push("remembered");
    },
  );

  assert.deepEqual(onboardingEvents, []);
});

test("retries onboarding when VS Code could not open it", async () => {
  let gettingStartedRemembered = false;

  await assert.rejects(
    openGettingStartedOnFirstActivation(
      false,
      async () => Promise.reject(new Error("Walkthrough unavailable")),
      async () => {
        gettingStartedRemembered = true;
      },
    ),
    /Walkthrough unavailable/u,
  );

  assert.equal(gettingStartedRemembered, false);
});
