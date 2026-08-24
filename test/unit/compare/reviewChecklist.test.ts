import { describe, expect, it } from "vitest";
import {
  WorkspaceReviewChecklistStore,
  createReviewChecklistStorageKey,
} from "../../../src/extension/compare/reviewChecklist.js";

class MemoryWorkspaceState {
  public readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

describe("workspace-local compare review checklist", () => {
  it("persists checked state and notes only through workspace state", async () => {
    const workspaceState = new MemoryWorkspaceState();
    const identity = {
      repositoryRootPath: "/repo",
      mode: "common-base" as const,
      left: { kind: "ref" as const, ref: "left" },
      right: { kind: "ref" as const, ref: "right" },
    };
    const store = new WorkspaceReviewChecklistStore(workspaceState, identity);
    expect(store.key).toBe(createReviewChecklistStorageKey(identity));
    expect(store.read()).toEqual({ checkedItemIds: [], notes: "" });
    await store.setChecked("files-reviewed", true);
    await store.setNotes("Binary change checked.");
    expect(store.read()).toEqual({
      checkedItemIds: ["files-reviewed"],
      notes: "Binary change checked.",
    });
    expect([...workspaceState.values.keys()]).toEqual([store.key]);
    await store.clear();
    expect(workspaceState.values.size).toBe(0);
  });

  it("rejects unknown checklist items", async () => {
    const store = new WorkspaceReviewChecklistStore(
      new MemoryWorkspaceState(),
      {
        repositoryRootPath: "/repo",
        mode: "direct",
        left: { kind: "ref", ref: "HEAD" },
        right: { kind: "working" },
      },
    );
    await expect(store.setChecked("provider-sync", true)).rejects.toThrow(
      "Unknown review checklist item",
    );
  });
});
