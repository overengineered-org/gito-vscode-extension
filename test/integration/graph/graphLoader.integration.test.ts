import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import {
  CommitGraphQueryEngine,
  GitCommitGraphLoader,
  type GraphCommitRow,
} from "../../../src/extension/graph/index.js";
import {
  createDisposableGraphGitFixture,
  runFixtureGit,
  type DisposableGraphGitFixture,
} from "./graphGitFixture.js";
import { createGraphExperienceActions } from "../../../src/extension/graphExperience/graphExperienceActions.js";
import { GraphExperienceRuntimeDataSource } from "../../../src/extension/graphExperience/graphExperienceRuntime.js";

describe("GitCommitGraphLoader disposable real-Git fixture", () => {
  let fixture: DisposableGraphGitFixture | undefined;
  let emptyRepositoryPath: string | undefined;

  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
    if (emptyRepositoryPath !== undefined)
      await rm(emptyRepositoryPath, { recursive: true, force: true });
    emptyRepositoryPath = undefined;
  });

  it("loads an unborn repository without requiring a missing HEAD", async () => {
    emptyRepositoryPath = await mkdtemp(
      path.join("/tmp", "gito-empty-graph-fixture-"),
    );
    await runFixtureGit(emptyRepositoryPath, ["init", "-b", "main"]);
    const snapshot = await new GitCommitGraphLoader(
      new NodeGitCommandRunner(),
    ).load(emptyRepositoryPath);

    expect(snapshot.commits).toEqual([]);
    expect(snapshot.references).toEqual([]);
    expect(snapshot.worktrees).toHaveLength(1);
    expect(snapshot.worktrees?.[0]?.headSha).toBe("0".repeat(40));
  }, 20_000);

  it("loads branches, octopus merge, tags, stash, remotes, worktrees, and rewrite", async () => {
    const createdFixture = await createDisposableGraphGitFixture();
    fixture = createdFixture;
    const loader = new GitCommitGraphLoader(new NodeGitCommandRunner());
    const snapshot = await loader.load(createdFixture.repositoryPath);
    const references = snapshot.references ?? [];
    const commitRows = new CommitGraphQueryEngine(snapshot)
      .query({ pageSize: 500 })
      .rows.filter((row): row is GraphCommitRow => row.kind === "commit");

    expect(
      references.some(
        (reference) => reference.name === "HEAD" && reference.isHead,
      ),
    ).toBe(true);
    expect(
      references.some(
        (reference) => reference.name === "refs/remotes/origin/main",
      ),
    ).toBe(true);
    expect(
      references.some((reference) => reference.name === "refs/tags/v1.0.0"),
    ).toBe(true);
    const mainReference = references.find(
      (reference) => reference.name === "refs/heads/main",
    );
    expect(
      references.some(
        (reference) =>
          reference.name === "refs/tags/v2.0.0" &&
          reference.targetSha === mainReference?.targetSha,
      ),
    ).toBe(true);
    expect(
      references.some((reference) => reference.name === "refs/stash"),
    ).toBe(true);
    expect(snapshot.worktrees).toHaveLength(3);
    expect(snapshot.workingTree?.unstagedChangeCount).toBe(1);
    expect(
      snapshot.worktrees?.map((worktree) => path.basename(worktree.path)),
    ).toEqual(
      createdFixture.worktreePaths.map((worktreePath) =>
        path.basename(worktreePath),
      ),
    );
    expect(snapshot.commits.some((commit) => commit.parents.length >= 3)).toBe(
      true,
    );
    expect(
      references.some(
        (reference) =>
          reference.targetSha !== createdFixture.preRewriteHeadSha &&
          reference.name === "refs/heads/rewritten",
      ),
    ).toBe(true);
    expect(
      commitRows.some((row) =>
        row.references.some((reference) => reference.name === "refs/stash"),
      ),
    ).toBe(true);

    const pagedCommitShas: string[] = [];
    let cursor: string | undefined;
    do {
      const page = new CommitGraphQueryEngine(snapshot).query({
        pageSize: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const row of page.rows)
        if (row.kind === "commit") pagedCommitShas.push(row.commitSha);
      cursor =
        page.nextCursor === undefined
          ? undefined
          : `${encodeURIComponent(page.nextCursor.snapshotKey)}:${page.nextCursor.rowOffset}`;
    } while (cursor !== undefined);
    expect(pagedCommitShas).toEqual(
      snapshot.commits.map((commit) => commit.sha),
    );
  }, 20_000);

  it("matches Git merge-base for a real criss-cross history", async () => {
    const repositoryPath = await mkdtemp(
      path.join("/tmp", "gito-criss-cross-graph-fixture-"),
    );
    try {
      await runFixtureGit(repositoryPath, ["init", "-b", "main"]);
      await runFixtureGit(repositoryPath, [
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ]);
      await runFixtureGit(repositoryPath, ["switch", "-c", "side"]);
      await runFixtureGit(repositoryPath, [
        "commit",
        "--allow-empty",
        "-m",
        "side-1",
      ]);
      await runFixtureGit(repositoryPath, ["switch", "main"]);
      await runFixtureGit(repositoryPath, [
        "commit",
        "--allow-empty",
        "-m",
        "main-1",
      ]);
      await runFixtureGit(repositoryPath, [
        "merge",
        "--no-ff",
        "side",
        "-m",
        "main-2",
      ]);
      await runFixtureGit(repositoryPath, ["switch", "side"]);
      await runFixtureGit(repositoryPath, [
        "merge",
        "--no-ff",
        "main~1",
        "-m",
        "side-2",
      ]);

      const snapshot = await new GitCommitGraphLoader(
        new NodeGitCommandRunner(),
      ).load(repositoryPath);
      const mainSha = (
        await runFixtureGit(repositoryPath, ["rev-parse", "refs/heads/main"])
      ).trim();
      const sideSha = (
        await runFixtureGit(repositoryPath, ["rev-parse", "refs/heads/side"])
      ).trim();
      const gitMergeBases = (
        await runFixtureGit(repositoryPath, [
          "merge-base",
          "--all",
          mainSha,
          sideSha,
        ])
      )
        .trim()
        .split(/\r?\n/u);
      const graphMergeBase = new CommitGraphQueryEngine(snapshot).findMergeBase(
        mainSha,
        sideSha,
      );
      expect(gitMergeBases).toHaveLength(2);
      expect(gitMergeBases).toContain(graphMergeBase);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps commits reachable only from detached HEAD", async () => {
    const createdFixture = await createDisposableGraphGitFixture();
    fixture = createdFixture;
    await runFixtureGit(createdFixture.repositoryPath, [
      "switch",
      "--detach",
      "refs/heads/rewritten",
    ]);
    await runFixtureGit(createdFixture.repositoryPath, [
      "commit",
      "--allow-empty",
      "-m",
      "detached-only",
    ]);
    const detachedOnlySha = (
      await runFixtureGit(createdFixture.repositoryPath, ["rev-parse", "HEAD"])
    ).trim();
    const loader = new GitCommitGraphLoader(new NodeGitCommandRunner());
    const snapshot = await loader.load(createdFixture.repositoryPath);

    expect(detachedOnlySha).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      snapshot.commits.some((commit) => commit.sha === detachedOnlySha),
    ).toBe(true);
    expect(
      snapshot.commits.some((commit) => commit.subject === "detached-only"),
    ).toBe(true);
    const detachedHeadReference = snapshot.references?.find(
      (reference) => reference.name === "HEAD",
    );
    expect(detachedHeadReference).toMatchObject({
      targetSha: detachedOnlySha,
      kind: "head",
      isHead: true,
    });
    const currentScopePage = new CommitGraphQueryEngine(snapshot).query({
      pageSize: 100,
      filter: { scope: "current" },
    });
    expect(
      currentScopePage.rows.some(
        (row) => row.kind === "commit" && row.commitSha === detachedOnlySha,
      ),
    ).toBe(true);
  }, 20_000);

  it("rejects HEAD checkout and mutates only to a loaded branch target", async () => {
    const createdFixture = await createDisposableGraphGitFixture();
    fixture = createdFixture;
    await runFixtureGit(createdFixture.repositoryPath, [
      "restore",
      "--",
      "rewrite.txt",
    ]);
    const graphCommandRunner = new NodeGitCommandRunner();
    const runtime = new GraphExperienceRuntimeDataSource({
      repository: {
        repositoryRoot: createdFixture.repositoryPath,
        generation: "fixture-generation",
        isCurrent: () => true,
      },
      graphLoader: new GitCommitGraphLoader(graphCommandRunner),
    });
    const cancellationSignal = new AbortController().signal;
    const actions = createGraphExperienceActions({
      contextProvider: {
        getContext: () => ({
          repositoryRoot: {
            scheme: "file",
            fsPath: createdFixture.repositoryPath,
          } as never,
          repositoryGeneration: "fixture-generation",
          cancellationSignal,
        }),
      },
      typedActions: {
        openCommit: () => Promise.resolve(),
        openDiff: () => Promise.resolve(),
        compareWithParent: () => Promise.resolve(),
        checkoutReference: async (context, referenceName) => {
          const checkoutTarget = await runtime.getLoadedCheckoutTarget(
            referenceName,
            context.cancellationSignal,
          );
          if (checkoutTarget === undefined)
            throw new Error("Selected target is not a loaded checkout target.");
          if (checkoutTarget.kind === "branch") {
            await graphCommandRunner.run({
              repositoryRoot: createdFixture.repositoryPath,
              arguments: ["switch", "--", checkoutTarget.target],
              cancellationSignal: context.cancellationSignal,
            });
            return;
          }
          await graphCommandRunner.run({
            repositoryRoot: createdFixture.repositoryPath,
            arguments: ["switch", "--detach", "--", checkoutTarget.target],
            cancellationSignal: context.cancellationSignal,
          });
        },
        showBranchStatus: () => Promise.resolve(),
      },
    });

    await expect(
      actions.checkoutReference("HEAD", cancellationSignal),
    ).rejects.toThrow(/loaded checkout target/iu);
    await expect(
      runFixtureGit(createdFixture.repositoryPath, [
        "symbolic-ref",
        "--short",
        "HEAD",
      ]),
    ).resolves.toBe("rewritten\n");
    await actions.checkoutReference("refs/heads/main", cancellationSignal);
    await expect(
      runFixtureGit(createdFixture.repositoryPath, [
        "symbolic-ref",
        "--short",
        "HEAD",
      ]),
    ).resolves.toBe("main\n");
    await expect(
      runtime.getLoadedBranchStatus("refs/heads/main", cancellationSignal),
    ).resolves.toEqual({
      localRefName: "refs/heads/main",
      aheadCount: 0,
      behindCount: 0,
    });
    runtime.dispose();
  }, 20_000);
});
