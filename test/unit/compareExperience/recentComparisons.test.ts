import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  RecentComparisonsStore,
  resolveGitDirectoryIdentity,
  type CompareExperienceSelection,
} from "../../../src/extension/compareExperience/index.js";

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

describe("workspace-local recent compare history", () => {
  it("deduplicates exact repository/side/mode identities and caps entries", async () => {
    const workspaceState = new MemoryWorkspaceState();
    const store = new RecentComparisonsStore(workspaceState, 2);
    const repositoryRoot = {
      fsPath: "/repo",
      toString: () => "file:///repo",
    } as never;
    const selection: CompareExperienceSelection = {
      repositoryRoot,
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "direct",
    };
    await store.remember(selection, 1);
    await store.remember({ ...selection, mode: "common-base" }, 2);
    await store.remember(
      { ...selection, right: { kind: "ref", ref: "new-right" } },
      3,
    );
    expect(store.read().map((entry) => [entry.mode, entry.right])).toEqual([
      ["direct", { kind: "ref", ref: "new-right" }],
      ["common-base", { kind: "ref", ref: "right" }],
    ]);
    await store.remember(selection, 4);
    expect(store.read().map((entry) => [entry.mode, entry.savedAt])).toEqual([
      ["direct", 4],
      ["direct", 3],
    ]);
    await store.clear();
    expect(store.read()).toEqual([]);
  });

  it("purges stale path-reused entries by Git directory identity", async () => {
    const workspaceState = new MemoryWorkspaceState();
    const store = new RecentComparisonsStore(workspaceState, 10);
    const selection: CompareExperienceSelection = {
      repositoryRoot: {
        fsPath: "/reused-path",
        toString: () => "file:///reused-path",
      } as never,
      left: { kind: "ref", ref: "left" },
      right: { kind: "ref", ref: "right" },
      mode: "direct",
    };
    await store.remember(selection, 1, "/git/old");
    await store.remember(selection, 2, "/git/new");
    const retained = await store.purgeExcept("/git/new");
    expect(retained).toHaveLength(1);
    expect(retained[0]?.gitDirectoryIdentity).toBe("/git/new");
    expect(store.read()[0]?.gitDirectoryIdentity).toBe("/git/new");
  });

  it("distinguishes a recreated Git directory at the same path", async () => {
    const temporaryRepositoryRoot = await mkdtemp(
      join(tmpdir(), "gito-recreated-repository-"),
    );
    const gitDirectoryPath = join(temporaryRepositoryRoot, ".git");
    const gitCommandRunner = {
      run: () => Promise.resolve({ standardOutput: ".git\n" }),
    } as never;
    const repositoryRoot = { fsPath: temporaryRepositoryRoot } as never;
    try {
      await mkdir(gitDirectoryPath);
      const originalIdentity = await resolveGitDirectoryIdentity(
        gitCommandRunner,
        repositoryRoot,
      );
      await rm(gitDirectoryPath, { recursive: true, force: true });
      await mkdir(gitDirectoryPath);
      const recreatedIdentity = await resolveGitDirectoryIdentity(
        gitCommandRunner,
        repositoryRoot,
      );
      expect(recreatedIdentity).not.toBe(originalIdentity);
    } finally {
      await rm(temporaryRepositoryRoot, { recursive: true, force: true });
    }
  });
});
