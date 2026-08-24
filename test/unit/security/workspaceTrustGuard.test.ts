import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceTrustError,
  createWorkspaceTrustGuard,
  workspaceMutationCommandClassifications,
} from "../../../src/extension/security/workspaceTrustGuard.js";

describe("WorkspaceTrustGuard", () => {
  it("fails closed and never runs a mutation in an untrusted workspace", async () => {
    const mutation = vi.fn();
    const guard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => false,
    });

    await expect(
      guard.runTrustedMutation("commit changes", mutation),
    ).rejects.to.Throw(WorkspaceTrustError);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("re-reads trust after the host grants trust before running the mutation", async () => {
    let workspaceTrusted = false;
    const requestWorkspaceTrust = vi.fn(() => {
      workspaceTrusted = true;
      return Promise.resolve();
    });
    const mutation = vi.fn(() => "committed");
    const guard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => workspaceTrusted,
      requestWorkspaceTrust,
    });

    await expect(
      guard.runTrustedMutation("commit changes", mutation),
    ).resolves.toBe("committed");
    expect(requestWorkspaceTrust).toHaveBeenCalledWith("commit changes");
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("re-checks trust after a requester returns without granting it", async () => {
    const requestWorkspaceTrust = vi.fn(() => Promise.resolve());
    const guard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => false,
      requestWorkspaceTrust,
    });

    await expect(guard.requireTrusted("create branch")).rejects.toThrow(
      "untrusted workspace",
    );
    expect(requestWorkspaceTrust).toHaveBeenCalledOnce();
  });

  it("fails closed when trust is revoked during confirmation", async () => {
    let workspaceTrusted = false;
    const requestWorkspaceTrust = vi.fn(async () => {
      workspaceTrusted = true;
      await Promise.resolve();
      workspaceTrusted = false;
    });
    const mutation = vi.fn();
    const guard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => workspaceTrusted,
      requestWorkspaceTrust,
    });

    await expect(
      guard.runTrustedMutation("push changes", mutation),
    ).rejects.toThrow(WorkspaceTrustError);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("supports a final checkpoint after async confirmation work", async () => {
    let workspaceTrusted = true;
    const mutation = vi.fn(
      async (assertTrustedImmediatelyBeforeMutation: () => void) => {
        await Promise.resolve();
        workspaceTrusted = false;
        assertTrustedImmediatelyBeforeMutation();
      },
    );
    const sideEffect = vi.fn();
    const guard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => workspaceTrusted,
    });

    await expect(
      guard.runTrustedMutation("discard changes", async (checkpoint) => {
        await mutation(checkpoint);
        sideEffect();
      }),
    ).rejects.toThrow(WorkspaceTrustError);
    expect(sideEffect).not.toHaveBeenCalled();
  });
});

describe("workspace mutation command classifications", () => {
  it("uses only explicit local or premium classes", () => {
    expect(Object.values(workspaceMutationCommandClassifications)).toEqual(
      expect.arrayContaining(["local"]),
    );
    expect(
      Object.values(workspaceMutationCommandClassifications).every(
        (mutationClass) =>
          mutationClass === "local" || mutationClass === "premium",
      ),
    ).toBe(true);
  });

  it("leaves read-only conflict inspection outside the trust mutation boundary", () => {
    expect(
      "gito.openConflicts" in workspaceMutationCommandClassifications,
    ).toBe(false);
    expect(Object.keys(workspaceMutationCommandClassifications)).toEqual(
      expect.arrayContaining([
        "gito.stageChanges",
        "gito.commit",
        "gito.push",
        "gito.createWorktree",
        "gito.removeWorktree",
      ]),
    );
  });

  it("blocks every classified mutation while allowing the unclassified inspection policy", async () => {
    const guard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => false,
    });
    const mutation = vi.fn();

    for (const commandIdentifier of Object.keys(
      workspaceMutationCommandClassifications,
    )) {
      await expect(
        guard.runTrustedMutation(commandIdentifier, mutation),
      ).rejects.toBeInstanceOf(WorkspaceTrustError);
    }
    expect(mutation).not.toHaveBeenCalled();
    expect(
      "gito.openConflicts" in workspaceMutationCommandClassifications,
    ).toBe(false);
  });
});
