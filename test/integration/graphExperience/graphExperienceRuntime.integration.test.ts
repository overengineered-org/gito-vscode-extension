import { describe, expect, it, vi } from "vitest";

import {
  GraphExperienceRuntimeDataSource,
  createGraphExperienceActions,
} from "../../../src/extension/graphExperience/index.js";
import { createWorkspaceTrustGuard } from "../../../src/extension/security/workspaceTrustGuard.js";
import type { GraphRepositorySnapshot } from "../../../src/extension/graph/graphModels.js";
import { graphPageSchema } from "../../../src/protocol/graphExperienceProtocol.js";

function createSnapshot(commitCount: number): GraphRepositorySnapshot {
  const commits = Array.from({ length: commitCount }, (_, commitIndex) => {
    const sha = commitIndex.toString(16).padStart(40, "0");
    const parentSha =
      commitIndex === commitCount - 1
        ? undefined
        : (commitIndex + 1).toString(16).padStart(40, "0");
    return {
      sha,
      parents: parentSha === undefined ? [] : [parentSha],
      subject: `Commit ${commitIndex}`,
      authorName: "Graph fixture",
      authorEmail: "graph@example.test",
      commitDate: `2026-08-${String((commitIndex % 28) + 1).padStart(2, "0")}T10:00:00Z`,
    };
  });
  return {
    commits,
    references: [
      {
        name: "refs/heads/main",
        targetSha: commits[0]!.sha,
        kind: "local",
      },
      {
        name: "HEAD",
        targetSha: commits[0]!.sha,
        kind: "head",
        isHead: true,
      },
    ],
  };
}

function createRuntime(
  snapshot: GraphRepositorySnapshot,
  isCurrent: () => boolean | Promise<boolean> = () => true,
) {
  return new GraphExperienceRuntimeDataSource({
    repository: {
      repositoryRoot: { fsPath: "/workspace/gito" },
      generation: "generation-1",
      isCurrent,
    },
    graphLoader: {
      load: vi.fn(() => Promise.resolve(snapshot)),
    },
    chunkSize: 32,
  });
}

const pageRequest = {
  pageSize: 500,
  filter: { scope: "all" as const },
  includeWip: false,
  includeWorktrees: false,
};

describe("GraphExperienceRuntimeDataSource", () => {
  it("aborts the initial loader when its only consumer cancels", async () => {
    let observedLoaderSignal: AbortSignal | undefined;
    let loadCount = 0;
    const graphLoader = {
      load: vi.fn(
        (
          _repositoryRoot: unknown,
          loadOptions?: { cancellationSignal?: AbortSignal },
        ) => {
          loadCount += 1;
          if (loadCount > 1) return Promise.resolve(createSnapshot(2));
          return new Promise<GraphRepositorySnapshot>((_resolve, reject) => {
            observedLoaderSignal = loadOptions?.cancellationSignal;
            loadOptions?.cancellationSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          });
        },
      ),
    };
    const runtime = new GraphExperienceRuntimeDataSource({
      repository: {
        repositoryRoot: { fsPath: "/workspace/gito" },
        generation: "generation-1",
        isCurrent: () => true,
      },
      graphLoader,
      chunkSize: 32,
    });
    const cancellationController = new AbortController();
    const pendingSummary = runtime.getSummary(cancellationController.signal);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(observedLoaderSignal).toBeDefined();
    cancellationController.abort();
    await expect(pendingSummary).rejects.toMatchObject({ name: "AbortError" });
    expect(observedLoaderSignal?.aborted).toBe(true);

    await expect(
      runtime.getSummary(new AbortController().signal),
    ).resolves.toMatchObject({ totalCommits: 2 });
    expect(graphLoader.load).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("does not let one cancelled consumer abort another shared load", async () => {
    let resolveSnapshot:
      ((snapshot: GraphRepositorySnapshot) => void) | undefined;
    let observedLoaderSignal: AbortSignal | undefined;
    const graphLoader = {
      load: vi.fn(
        (
          _repositoryRoot: unknown,
          loadOptions?: { cancellationSignal?: AbortSignal },
        ) => {
          observedLoaderSignal = loadOptions?.cancellationSignal;
          return new Promise<GraphRepositorySnapshot>((resolve, reject) => {
            resolveSnapshot = resolve;
            loadOptions?.cancellationSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          });
        },
      ),
    };
    const runtime = new GraphExperienceRuntimeDataSource({
      repository: {
        repositoryRoot: { fsPath: "/workspace/gito" },
        generation: "generation-1",
        isCurrent: () => true,
      },
      graphLoader,
      chunkSize: 32,
    });
    const cancelledController = new AbortController();
    const successfulController = new AbortController();
    const cancelledQuery = runtime.queryPage(
      pageRequest,
      cancelledController.signal,
    );
    const successfulQuery = runtime.queryPage(
      pageRequest,
      successfulController.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(observedLoaderSignal).toBeDefined();
    const loaderSignal = observedLoaderSignal;
    cancelledController.abort();
    expect(loaderSignal?.aborted).toBe(false);
    resolveSnapshot?.(createSnapshot(4));
    await expect(cancelledQuery).rejects.toMatchObject({ name: "AbortError" });
    await expect(successfulQuery).resolves.toMatchObject({ totalCommits: 4 });
    expect(graphLoader.load).toHaveBeenCalledTimes(1);
    expect(loaderSignal?.aborted).toBe(false);
    runtime.dispose();
  });

  it("invalidates cached graph state when a repository mutation changes its token", async () => {
    let stateKey = "before";
    const graphLoader = {
      load: vi.fn(() => Promise.resolve(createSnapshot(3))),
    };
    const runtime = new GraphExperienceRuntimeDataSource({
      repository: {
        repositoryRoot: { fsPath: "/workspace/gito" },
        generation: "generation-1",
        isCurrent: () => true,
        currentStateKey: () => stateKey,
      },
      graphLoader,
    });
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).resolves.toMatchObject({
      totalCommits: 3,
    });
    stateKey = "after";
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).rejects.toThrow(/repository changed/iu);
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).resolves.toMatchObject({
      totalCommits: 3,
    });
    expect(graphLoader.load).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("refreshes the current branch label from each repository snapshot", async () => {
    const mainSha = "1".repeat(40);
    const featureSha = "2".repeat(40);
    const createBranchSnapshot = (
      branchName: string,
      headSha: string,
    ): GraphRepositorySnapshot => ({
      commits: [{ sha: headSha, parents: [] }],
      references: [
        {
          name: `refs/heads/${branchName}`,
          targetSha: headSha,
          kind: "local",
        },
        { name: "HEAD", targetSha: headSha, kind: "head", isHead: true },
      ],
      worktrees: [
        {
          path: "/workspace/gito",
          headSha,
          branchRefName: `refs/heads/${branchName}`,
          isPrimary: true,
        },
      ],
    });
    let stateKey = "main";
    let loadCount = 0;
    const graphLoader = {
      load: vi.fn(() => {
        loadCount += 1;
        return Promise.resolve(
          loadCount === 1
            ? createBranchSnapshot("main", mainSha)
            : createBranchSnapshot("feature", featureSha),
        );
      }),
    };
    const runtime = new GraphExperienceRuntimeDataSource({
      repository: {
        repositoryRoot: { fsPath: "/workspace/gito" },
        generation: "generation-1",
        isCurrent: () => true,
        currentStateKey: () => stateKey,
      },
      graphLoader,
    });
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).resolves.toMatchObject({ currentBranchName: "main" });
    stateKey = "feature";
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).rejects.toThrow(/repository changed/iu);
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).resolves.toMatchObject({ currentBranchName: "feature" });
    expect(graphLoader.load).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("loads bounded pages without patch bodies and yields during large layout", async () => {
    const runtime = createRuntime(createSnapshot(2_000));
    const page = await runtime.queryPage(
      { ...pageRequest, pageSize: 100_000 },
      new AbortController().signal,
    );
    expect(page.rows).toHaveLength(500);
    expect(page.totalCommits).toBe(2_000);
    expect(page.hasMore).toBe(true);
    expect(graphPageSchema.safeParse(page).success).toBe(true);
    expect(JSON.stringify(page)).not.toContain("patch");
    runtime.dispose();
  });

  it("honours cancellation after cooperative work has started", async () => {
    const cancellationController = new AbortController();
    let currentChecks = 0;
    const runtime = createRuntime(createSnapshot(4_000), () => {
      currentChecks += 1;
      if (currentChecks === 3) cancellationController.abort();
      return true;
    });
    await expect(
      runtime.queryPage(pageRequest, cancellationController.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(currentChecks).toBeGreaterThanOrEqual(3);
    runtime.dispose();
  });

  it("rejects stale repository generations and aborts after disposal", async () => {
    const runtime = createRuntime(createSnapshot(10), () => false);
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).rejects.toThrow(/repository changed/iu);
    runtime.dispose();
    await expect(
      runtime.getSummary(new AbortController().signal),
    ).rejects.toThrow(/disposed/iu);
  });

  it("binds checkout targets to the loaded graph and rejects option injection", async () => {
    const snapshot = createSnapshot(3);
    const runtime = createRuntime(snapshot);
    const cancellationSignal = new AbortController().signal;

    await expect(
      runtime.getLoadedCheckoutTarget("refs/heads/main", cancellationSignal),
    ).resolves.toEqual({ kind: "branch", target: "main" });
    await expect(
      runtime.getLoadedCheckoutTarget("HEAD", cancellationSignal),
    ).resolves.toBeUndefined();
    await expect(
      runtime.getLoadedCheckoutTarget(
        snapshot.commits[0]!.sha,
        cancellationSignal,
      ),
    ).resolves.toEqual({
      kind: "detached",
      target: snapshot.commits[0]!.sha,
    });
    await expect(
      runtime.getLoadedCheckoutTarget("--upload-pack=evil", cancellationSignal),
    ).resolves.toBeUndefined();
    await expect(
      runtime.getLoadedCheckoutTarget(
        "refs/heads/not-loaded",
        cancellationSignal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      runtime.getLoadedCheckoutTarget("a".repeat(7), cancellationSignal),
    ).resolves.toBeUndefined();
    runtime.dispose();
  });

  it("fails closed for commit actions outside the current snapshot", async () => {
    const snapshot = createSnapshot(3);
    const runtime = createRuntime(snapshot);
    const cancellationSignal = new AbortController().signal;
    const commit = snapshot.commits[0]!;
    const directParent = commit.parents[0]!;

    await expect(
      runtime.getLoadedCommitActionTarget(
        commit.sha,
        undefined,
        cancellationSignal,
      ),
    ).resolves.toEqual(commit);
    await expect(
      runtime.getLoadedCommitActionTarget(
        commit.sha,
        directParent,
        cancellationSignal,
      ),
    ).resolves.toEqual(commit);
    await expect(
      runtime.getLoadedCommitActionTarget(
        "f".repeat(40),
        undefined,
        cancellationSignal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      runtime.getLoadedCommitActionTarget(
        commit.sha,
        snapshot.commits[2]!.sha,
        cancellationSignal,
      ),
    ).resolves.toBeUndefined();
    runtime.dispose();
  });

  it("computes selected local branch status and rejects non-local references", async () => {
    const runtime = createRuntime(createSnapshot(3));
    const cancellationSignal = new AbortController().signal;
    await expect(
      runtime.getLoadedBranchStatus("refs/heads/main", cancellationSignal),
    ).resolves.toEqual({
      localRefName: "refs/heads/main",
      aheadCount: 0,
      behindCount: 0,
    });
    await expect(
      runtime.getLoadedBranchStatus(
        "refs/remotes/origin/main",
        cancellationSignal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      runtime.getLoadedBranchStatus("HEAD", cancellationSignal),
    ).resolves.toBeUndefined();
    runtime.dispose();
  });

  it("uses exact Git status when the graph snapshot is truncated", async () => {
    const branchStatusLoader = vi.fn(() =>
      Promise.resolve({
        localRefName: "refs/heads/main",
        upstreamRefName: "refs/remotes/origin/main",
        mergeBaseSha: "exact-merge-base",
        aheadCount: 3,
        behindCount: 2,
      }),
    );
    const snapshot = createSnapshot(3);
    const runtime = new GraphExperienceRuntimeDataSource({
      repository: {
        repositoryRoot: { fsPath: "/workspace/gito" },
        generation: "generation-1",
        isCurrent: () => true,
      },
      graphLoader: {
        load: vi.fn(() =>
          Promise.resolve({
            ...snapshot,
            truncated: true,
            references: [
              ...(snapshot.references ?? []),
              {
                name: "refs/remotes/origin/main",
                targetSha: snapshot.commits[1]!.sha,
                kind: "remote" as const,
              },
            ].map((reference) =>
              reference.name === "refs/heads/main"
                ? {
                    ...reference,
                    upstreamRefName: "refs/remotes/origin/main",
                  }
                : reference,
            ),
          }),
        ),
      },
      branchStatusLoader,
    });
    await expect(
      runtime.getLoadedBranchStatus(
        "refs/heads/main",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      localRefName: "refs/heads/main",
      upstreamRefName: "refs/remotes/origin/main",
      mergeBaseSha: "exact-merge-base",
      aheadCount: 3,
      behindCount: 2,
    });
    expect(branchStatusLoader).toHaveBeenCalledWith(
      "refs/heads/main",
      expect.any(AbortSignal),
    );
    runtime.dispose();
  });

  it("stops an active page when the runtime is disposed", async () => {
    const runtimeHolder: { runtime?: GraphExperienceRuntimeDataSource } = {};
    let currentChecks = 0;
    const runtime = createRuntime(createSnapshot(4_000), () => {
      currentChecks += 1;
      if (currentChecks === 2) runtimeHolder.runtime?.dispose();
      return true;
    });
    runtimeHolder.runtime = runtime;
    await expect(
      runtime.queryPage(pageRequest, new AbortController().signal),
    ).rejects.toThrow(/disposed|cancelled/iu);
    expect(currentChecks).toBeGreaterThanOrEqual(2);
  });

  it("passes exact repository identity into typed service adapters", async () => {
    const calls: string[] = [];
    const actions = createGraphExperienceActions({
      contextProvider: {
        getContext: () => ({
          repositoryRoot: {
            scheme: "file",
            fsPath: "/workspace/gito",
          } as never,
          repositoryGeneration: "generation-1",
          cancellationSignal: new AbortController().signal,
        }),
      },
      typedActions: {
        openCommit: (context, commitSha) => {
          calls.push(
            `${context.repositoryGeneration}:${context.repositoryRoot.fsPath}:${commitSha}`,
          );
          return Promise.resolve();
        },
        openDiff: () => Promise.resolve(),
        compareWithParent: () => Promise.resolve(),
        checkoutReference: () => Promise.resolve(),
        showBranchStatus: () => Promise.resolve(),
      },
    });
    await actions.openCommit("a".repeat(40), new AbortController().signal);
    expect(calls).toEqual([`generation-1:/workspace/gito:${"a".repeat(40)}`]);
  });

  it("forwards the graph-provided parent SHA through the action adapter", async () => {
    const compareWithParent = vi.fn(() => Promise.resolve());
    const actions = createGraphExperienceActions({
      contextProvider: {
        getContext: () => ({
          repositoryRoot: {
            scheme: "file",
            fsPath: "/workspace/gito",
          } as never,
          repositoryGeneration: "generation-1",
          cancellationSignal: new AbortController().signal,
        }),
      },
      typedActions: {
        openCommit: () => Promise.resolve(),
        openDiff: () => Promise.resolve(),
        compareWithParent,
        checkoutReference: () => Promise.resolve(),
        showBranchStatus: () => Promise.resolve(),
      },
    });

    await actions.compareWithParent(
      "a".repeat(40),
      new AbortController().signal,
      "b".repeat(40),
    );

    expect(compareWithParent).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryGeneration: "generation-1" }),
      "a".repeat(40),
      "b".repeat(40),
    );
  });

  it("rejects an action whose repository changes during async work", async () => {
    let repositoryIsCurrent = true;
    const assertCurrent = vi.fn(() => {
      if (!repositoryIsCurrent)
        throw new Error("The selected Git repository changed.");
    });
    const actions = createGraphExperienceActions({
      contextProvider: {
        getContext: () => ({
          repositoryRoot: {
            scheme: "file",
            fsPath: "/workspace/gito",
          } as never,
          repositoryGeneration: "generation-1",
          cancellationSignal: new AbortController().signal,
          assertCurrent,
        }),
      },
      typedActions: {
        openCommit: () => {
          repositoryIsCurrent = false;
          return Promise.resolve();
        },
        openDiff: () => Promise.resolve(),
        compareWithParent: () => Promise.resolve(),
        checkoutReference: () => Promise.resolve(),
        showBranchStatus: () => Promise.resolve(),
      },
    });

    await expect(
      actions.openCommit("a".repeat(40), new AbortController().signal),
    ).rejects.toThrow("repository changed");
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("blocks graph checkout when trust is revoked during async work", async () => {
    let workspaceTrusted = true;
    const workspaceTrustGuard = createWorkspaceTrustGuard({
      isWorkspaceTrusted: () => workspaceTrusted,
    });
    const checkoutSideEffect = vi.fn();
    const actions = createGraphExperienceActions({
      contextProvider: {
        getContext: () => ({
          repositoryRoot: {
            scheme: "file",
            fsPath: "/workspace/gito",
          } as never,
          repositoryGeneration: "generation-1",
          cancellationSignal: new AbortController().signal,
        }),
      },
      typedActions: {
        openCommit: () => Promise.resolve(),
        openDiff: () => Promise.resolve(),
        compareWithParent: () => Promise.resolve(),
        checkoutReference: (_context, referenceName) =>
          workspaceTrustGuard.runTrustedMutation(
            `checkout ${referenceName}`,
            async (assertTrustedImmediatelyBeforeMutation) => {
              await Promise.resolve();
              workspaceTrusted = false;
              assertTrustedImmediatelyBeforeMutation();
              checkoutSideEffect(referenceName);
            },
          ),
        showBranchStatus: () => Promise.resolve(),
      },
    });

    await expect(
      actions.checkoutReference(
        "refs/heads/main",
        new AbortController().signal,
      ),
    ).rejects.toThrow("untrusted workspace");
    expect(checkoutSideEffect).not.toHaveBeenCalled();
  });
});
