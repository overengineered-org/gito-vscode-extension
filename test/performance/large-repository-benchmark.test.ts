// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("vscode", () => ({}));
import {
  GitHistoryService,
  localGitCommitActivitySafetyCap,
} from "../../src/extension/git/gitHistoryService.js";
import {
  NodeGitCommandRunner,
  resolveGitRootBinding,
  type GitCommandOutput,
  type GitCommandRequest,
  type GitCommandRunner,
} from "../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../src/extension/git/gitRootBindingResolver.js";
import { LocalGitRepositoryService } from "../../src/extension/git/localGitRepositoryService.js";
import {
  calculateP95Milliseconds,
  createCommitActivityChunks,
  createRepositoryFromUntrackedPaths,
  createSyntheticFileUri,
  createTemporaryGitRepository,
  largeRepositoryFileCount,
  localSummaryHeapBudgetBytes,
  localSummaryP95BudgetMilliseconds,
  rootBoundGraphCommandBatchP95BudgetMilliseconds,
  parseUntrackedStatusOutput,
  runGit,
  streamedChunkSizeBudgetBytes,
  type TemporaryGitRepository,
} from "./fixtures/largeRepositoryFixtures.js";

const summarySampleCount = 7;
const fixtureRepositories: TemporaryGitRepository[] = [];

afterEach(async () => {
  while (fixtureRepositories.length > 0) {
    const fixtureRepository = fixtureRepositories.pop();
    if (fixtureRepository === undefined) continue;
    await rm(fixtureRepository.rootDirectory, {
      recursive: true,
      force: true,
    });
  }
});

describe("large local repository performance", () => {
  it("summarizes 10,000 real untracked files with a measured p95", async () => {
    const fixtureRepository = await createTemporaryGitRepository();
    fixtureRepositories.push(fixtureRepository);
    const gitCommandRunner = new NodeGitCommandRunner();
    const elapsedMilliseconds: number[] = [];
    let maximumObservedHeapDeltaBytes = 0;
    let latestSnapshot:
      | Awaited<ReturnType<LocalGitRepositoryService["getChangesSnapshot"]>>
      | undefined;

    for (let sampleIndex = 0; sampleIndex < summarySampleCount; sampleIndex++) {
      const heapBeforeSampleBytes = process.memoryUsage().heapUsed;
      const sampleStartTime = performance.now();
      const statusOutput = await gitCommandRunner.run({
        repositoryRoot: fixtureRepository.repositoryPath,
        arguments: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      });
      const untrackedRelativePaths = parseUntrackedStatusOutput(
        statusOutput.standardOutput,
      );
      const repository = createRepositoryFromUntrackedPaths(
        fixtureRepository.repositoryPath,
        untrackedRelativePaths,
      );
      const repositoryService = new LocalGitRepositoryService(
        { selectRepository: () => Promise.resolve(repository) },
        { isWorkspaceTrusted: () => true, assertTrusted: () => undefined },
        { execute: () => Promise.resolve(undefined) },
        {
          confirm: () => Promise.resolve(false),
          confirmSmartCommit: () => Promise.resolve(false),
        },
      );
      latestSnapshot = await repositoryService.getChangesSnapshot();
      elapsedMilliseconds.push(performance.now() - sampleStartTime);
      maximumObservedHeapDeltaBytes = Math.max(
        maximumObservedHeapDeltaBytes,
        Math.max(0, process.memoryUsage().heapUsed - heapBeforeSampleBytes),
      );
    }

    expect(latestSnapshot?.repositoryRoot.fsPath).toBe(
      fixtureRepository.repositoryPath,
    );
    expect(latestSnapshot?.untracked).toHaveLength(largeRepositoryFileCount);
    expect(latestSnapshot?.totalChangeCount).toBe(largeRepositoryFileCount);
    expect(latestSnapshot?.untracked[0]?.relativePath).toBe(
      "files/file-00000.txt",
    );
    expect(
      latestSnapshot?.untracked[largeRepositoryFileCount - 1]?.relativePath,
    ).toBe("files/file-09999.txt");
    expect(calculateP95Milliseconds(elapsedMilliseconds)).toBeLessThanOrEqual(
      localSummaryP95BudgetMilliseconds,
    );
    expect(maximumObservedHeapDeltaBytes).toBeLessThan(
      localSummaryHeapBudgetBytes,
    );
  }, 30_000);

  it("keeps repeated root-bound graph metadata batches within the p95 budget", async () => {
    const fixtureRepository = await createTemporaryGitRepository(0);
    fixtureRepositories.push(fixtureRepository);
    await writeFile(
      join(fixtureRepository.repositoryPath, "graph-fixture.txt"),
      "graph fixture\n",
    );
    await runGit(fixtureRepository.repositoryPath, [
      "add",
      "graph-fixture.txt",
    ]);
    await runGit(fixtureRepository.repositoryPath, [
      "-c",
      "user.name=Git'o Performance",
      "-c",
      "user.email=performance@example.invalid",
      "commit",
      "-m",
      "graph fixture",
    ]);

    const rootBinding = await resolveGitRootBinding(
      fixtureRepository.repositoryPath,
    );
    expect(rootBinding.gitDirectory.canonicalPath.length).toBeGreaterThan(0);
    expect(rootBinding.commonDirectory.canonicalPath.length).toBeGreaterThan(0);
    const graphMetadataCommandArguments: readonly (readonly string[])[] = [
      [
        "log",
        "--all",
        "--topo-order",
        "--date-order",
        "--max-count=20",
        "--format=%H%x00%P%x00%s%x01",
      ],
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(upstream)%01",
        "refs/heads/*",
      ],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["worktree", "list", "--porcelain"],
      ["status", "--porcelain=v1", "--untracked-files=normal"],
    ];
    const boundGraphCommandBatchElapsedMilliseconds: number[] = [];
    const gitCommandRunner = new NodeGitCommandRunner();
    for (let sampleIndex = 0; sampleIndex < 7; sampleIndex += 1) {
      const batchStartTime = performance.now();
      for (const commandArguments of graphMetadataCommandArguments) {
        const commandOutput = await gitCommandRunner.run({
          repositoryRoot: fixtureRepository.repositoryPath,
          rootBinding,
          arguments: commandArguments,
        });
        expect(commandOutput.exitCode).toBe(0);
      }
      boundGraphCommandBatchElapsedMilliseconds.push(
        performance.now() - batchStartTime,
      );
    }

    expect(
      calculateP95Milliseconds(boundGraphCommandBatchElapsedMilliseconds),
    ).toBeLessThanOrEqual(rootBoundGraphCommandBatchP95BudgetMilliseconds);
  }, 30_000);

  it("streams real Git output without retaining the 10,000-file payload", async () => {
    const fixtureRepository = await createTemporaryGitRepository();
    fixtureRepositories.push(fixtureRepository);
    const gitCommandRunner = new NodeGitCommandRunner();
    const cancellationController = new AbortController();
    let streamedFileCount = 0;
    let streamedByteCount = 0;
    let pendingFilePath = "";
    let maximumChunkLength = 0;
    let activeChunkCallbacks = 0;
    let maximumActiveChunkCallbacks = 0;
    const heapBeforeSampleBytes = process.memoryUsage().heapUsed;
    const streamStartTime = performance.now();

    const commandOutput = await gitCommandRunner.runStreaming(
      {
        repositoryRoot: fixtureRepository.repositoryPath,
        arguments: ["ls-files", "--others", "--exclude-standard", "-z"],
        cancellationSignal: cancellationController.signal,
        collectStandardOutput: false,
      },
      (chunk) => {
        activeChunkCallbacks += 1;
        maximumActiveChunkCallbacks = Math.max(
          maximumActiveChunkCallbacks,
          activeChunkCallbacks,
        );
        maximumChunkLength = Math.max(maximumChunkLength, chunk.length);
        streamedByteCount += chunk.length;
        const filePathRecords = `${pendingFilePath}${chunk}`.split("\0");
        pendingFilePath = filePathRecords.pop() ?? "";
        streamedFileCount += filePathRecords.filter(Boolean).length;
        activeChunkCallbacks -= 1;
      },
    );

    const streamElapsedMilliseconds = performance.now() - streamStartTime;
    const heapDeltaBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBeforeSampleBytes,
    );
    expect(commandOutput.standardOutput).toBe("");
    expect(pendingFilePath).toBe("");
    expect(streamedFileCount).toBe(largeRepositoryFileCount);
    expect(streamedByteCount).toBeGreaterThan(largeRepositoryFileCount);
    expect(maximumChunkLength).toBeLessThanOrEqual(
      streamedChunkSizeBudgetBytes,
    );
    expect(maximumActiveChunkCallbacks).toBe(1);
    expect(streamElapsedMilliseconds).toBeLessThanOrEqual(2_000);
    expect(heapDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);

  it("keeps a capped 64 MiB text result within heap and RSS budgets", async () => {
    const fixtureRepository = await createTemporaryGitRepository(0);
    fixtureRepositories.push(fixtureRepository);
    const payloadBytes = 64 * 1024 * 1024 + 1;
    await writeFile(
      join(fixtureRepository.repositoryPath, "bounded-output.txt"),
      Buffer.alloc(payloadBytes, 0x61),
    );
    await runGit(fixtureRepository.repositoryPath, [
      "add",
      "bounded-output.txt",
    ]);
    await runGit(fixtureRepository.repositoryPath, [
      "-c",
      "user.name=Git'o Performance",
      "-c",
      "user.email=performance@example.invalid",
      "commit",
      "-m",
      "bounded output",
    ]);

    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const rssBeforeBytes = process.memoryUsage().rss;
    const commandStartTime = performance.now();
    const commandOutput = await new NodeGitCommandRunner().run({
      repositoryRoot: fixtureRepository.repositoryPath,
      arguments: ["show", "HEAD:bounded-output.txt"],
      maxStandardOutputBytes: 64 * 1024 * 1024,
    });
    const commandElapsedMilliseconds = performance.now() - commandStartTime;
    const heapDeltaBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBeforeBytes,
    );
    const rssDeltaBytes = Math.max(
      0,
      process.memoryUsage().rss - rssBeforeBytes,
    );

    expect(commandOutput.standardOutput).toHaveLength(64 * 1024 * 1024);
    expect(commandOutput.standardOutputTruncated).toBe(true);
    expect(commandElapsedMilliseconds).toBeLessThanOrEqual(10_000);
    expect(heapDeltaBytes).toBeLessThan(128 * 1024 * 1024);
    expect(rssDeltaBytes).toBeLessThan(256 * 1024 * 1024);
  }, 30_000);

  it("settles exactly once when real Git output is cancelled during a stream", async () => {
    const fixtureRepository = await createTemporaryGitRepository();
    fixtureRepositories.push(fixtureRepository);
    const gitCommandRunner = new NodeGitCommandRunner();
    const cancellationController = new AbortController();
    let observedChunkCount = 0;
    const streamPromise = gitCommandRunner.runStreaming(
      {
        repositoryRoot: fixtureRepository.repositoryPath,
        arguments: ["ls-files", "--others", "--exclude-standard", "-z"],
        cancellationSignal: cancellationController.signal,
        collectStandardOutput: false,
      },
      () => {
        observedChunkCount += 1;
        cancellationController.abort();
      },
    );

    const cancellationStartTime = performance.now();
    await expect(streamPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - cancellationStartTime).toBeLessThanOrEqual(
      1_000,
    );
    expect(observedChunkCount).toBeGreaterThanOrEqual(1);
    expect(cancellationController.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }, 30_000);

  it("stops a >250,000-record activity stream at the safety cap", async () => {
    const fixtureRepository = await createTemporaryGitRepository();
    fixtureRepositories.push(fixtureRepository);
    const commandRunner = new SafetyCapStreamingRunner();
    const historyService = new GitHistoryService(
      commandRunner,
      new GitRootBindingResolver(() => Promise.resolve("/usr/bin/git")),
    );
    const heapBeforeSampleBytes = process.memoryUsage().heapUsed;
    const streamStartTime = performance.now();

    const activitySnapshot = await historyService.getCommitActivity(
      createSyntheticFileUri(fixtureRepository.repositoryPath) as never,
      ["performance@example.test"],
      { startDate: "2026-08-01", endDate: "2026-08-31" },
    );

    const streamElapsedMilliseconds = performance.now() - streamStartTime;
    const heapDeltaBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBeforeSampleBytes,
    );
    expect(activitySnapshot.matchingCommitCount).toBe(
      localGitCommitActivitySafetyCap,
    );
    expect(activitySnapshot.reachedSafetyCap).toBe(true);
    expect(commandRunner.emittedRecordCount).toBeLessThanOrEqual(
      localGitCommitActivitySafetyCap + 1,
    );
    expect(commandRunner.maximumChunkLength).toBeLessThanOrEqual(
      streamedChunkSizeBudgetBytes,
    );
    expect(streamElapsedMilliseconds).toBeLessThanOrEqual(5_000);
    expect(heapDeltaBytes).toBeLessThan(128 * 1024 * 1024);
  }, 30_000);
});

class SafetyCapStreamingRunner implements GitCommandRunner {
  public emittedRecordCount = 0;
  public maximumChunkLength = 0;

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--verify"
    ) {
      return Promise.resolve({
        standardOutput: `${"f".repeat(40)}\n`,
        standardError: "",
        exitCode: 0,
      });
    }
    if (
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--is-shallow-repository"
    ) {
      return Promise.resolve({
        standardOutput: "false\n",
        standardError: "",
        exitCode: 0,
      });
    }
    if (request.arguments[0] === "config") {
      return Promise.resolve({
        standardOutput: "performance@example.test\n",
        standardError: "",
        exitCode: 0,
      });
    }
    throw new Error("The safety-cap check must use the streaming Git path.");
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    for (const chunk of createCommitActivityChunks(
      localGitCommitActivitySafetyCap + 1,
    )) {
      if (request.cancellationSignal?.aborted) {
        return Promise.reject(
          new DOMException("Git command cancelled", "AbortError"),
        );
      }
      this.maximumChunkLength = Math.max(this.maximumChunkLength, chunk.length);
      this.emittedRecordCount += chunk.split("\x01").filter(Boolean).length;
      onStandardOutputChunk(chunk);
    }
    return Promise.resolve({
      standardOutput: "",
      standardError: "",
      exitCode: 0,
    });
  }
}
