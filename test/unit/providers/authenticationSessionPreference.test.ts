import { describe, expect, it } from "vitest";
import { AuthenticationSessionPreferenceTracker } from "../../../src/extension/providers/authenticationSessionPreference.js";

function createSession(sessionId: string, accountId: string) {
  return {
    id: sessionId,
    account: { id: accountId, label: accountId },
  } as never;
}

describe("AuthenticationSessionPreferenceTracker", () => {
  it("does not let a stale discard clear a newer same-session preference", () => {
    const tracker = new AuthenticationSessionPreferenceTracker();
    const firstAcquisition = tracker.beginAcquisition(true);
    tracker.observeSession(
      firstAcquisition.generation,
      createSession("same-session", "first-account"),
    );
    tracker.cancelAcquisition(firstAcquisition.generation);

    const secondAcquisition = tracker.beginAcquisition(true);
    tracker.observeSession(
      secondAcquisition.generation,
      createSession("same-session", "second-account"),
    );
    tracker.discardSession("same-session", firstAcquisition.generation);

    tracker.commitSession("same-session", secondAcquisition.generation);
    expect(tracker.committedSessionId).toBe("same-session");
    expect(tracker.beginAcquisition(false).preferredAccount?.id).toBe(
      "second-account",
    );
  });

  it("does not let a stale commit consume a newer pending preference", () => {
    const tracker = new AuthenticationSessionPreferenceTracker();
    const firstAcquisition = tracker.beginAcquisition(true);
    tracker.observeSession(
      firstAcquisition.generation,
      createSession("same-session", "first-account"),
    );
    const secondAcquisition = tracker.beginAcquisition(true);
    tracker.observeSession(
      secondAcquisition.generation,
      createSession("same-session", "second-account"),
    );

    tracker.commitSession("same-session", firstAcquisition.generation);
    tracker.commitSession("same-session", secondAcquisition.generation);
    expect(tracker.beginAcquisition(false).preferredAccount?.id).toBe(
      "second-account",
    );
  });
});
