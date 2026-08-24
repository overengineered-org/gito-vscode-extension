import { describe, expect, it } from "vitest";
import { realpath, stat } from "node:fs/promises";
import {
  parseBlamePorcelain,
  parseHistoryRecords,
} from "../../../src/extension/history/historyParsing.js";
import {
  PremiumHistoryService,
  type HistoryQuery,
} from "../../../src/extension/history/index.js";
import { parseCommitFileChanges } from "../../../src/extension/git/gitHistoryService.js";
import type {
  GitCommandOutput,
  GitCommandRequest,
  GitCommandRunner,
  GitRootBindingIdentity,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import type { HistoryRepositoryRoot } from "../../../src/extension/history/historyTypes.js";
import { createHistoryRootBindingResolver } from "./historyRootBindingTestSupport.js";

const emptyOutput: GitCommandOutput = {
  standardOutput: "",
  standardError: "",
  exitCode: 0,
};
const testRepositoryRoot = process.cwd();

function createHistoryService(runner: GitCommandRunner): PremiumHistoryService {
  return new PremiumHistoryService(runner, createHistoryRootBindingResolver());
}

function createHistoryServiceWithResolver(
  runner: GitCommandRunner,
  rootBindingResolver: GitRootBindingResolver,
): PremiumHistoryService {
  return new PremiumHistoryService(runner, rootBindingResolver);
}

class HistoryRemediationRunner implements GitCommandRunner {
  public readonly requests: GitCommandRequest[] = [];
  public readonly outputs: GitCommandOutput[] = [];
  public streamingOutput = "";
  public numstatOutput: GitCommandOutput | undefined;

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    this.requests.push(request);
    if (request.arguments.includes("--numstat"))
      return Promise.resolve(this.numstatOutput ?? emptyOutput);
    return Promise.resolve(this.outputs.shift() ?? emptyOutput);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    this.requests.push(request);
    onStandardOutputChunk(this.streamingOutput);
    return Promise.resolve(emptyOutput);
  }
}

function metadataRecord(sha: string, subject: string, parentShas = ""): string {
  return `\x1e${sha}\u0000${sha.slice(0, 7)}\u0000Ada\u0000ada@example.test\u00002026-08-23T00:00:00+00:00\u00002026-08-23T00:00:00+00:00\u0000${parentShas}\u0000${subject}`;
}

async function createHistoryRootIdentity(): Promise<GitRootBindingIdentity> {
  const canonicalPath = await realpath(testRepositoryRoot);
  const rootStats = await stat(canonicalPath, { bigint: true });
  const directoryIdentity = {
    canonicalPath,
    device: rootStats.dev.toString(),
    inode: rootStats.ino.toString(),
  };
  return {
    ...directoryIdentity,
    gitDirectory: directoryIdentity,
    commonDirectory: directoryIdentity,
  };
}

function abortWhenSignalled(cancellationSignal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectAsCancelled = (): void =>
      reject(new DOMException("History operation cancelled", "AbortError"));
    if (cancellationSignal.aborted) rejectAsCancelled();
    else
      cancellationSignal.addEventListener("abort", rejectAsCancelled, {
        once: true,
      });
  });
}

describe("history remediation", () => {
  it("parses SHA-256 history and blame records", () => {
    const sha = "a".repeat(64);
    expect(parseHistoryRecords(metadataRecord(sha, "sha256"))[0]?.sha).toBe(
      sha,
    );
    expect(
      parseBlamePorcelain(
        [
          `${sha} 1 1`,
          "author Ada",
          "author-mail <ada@example.test>",
          "author-time 1776902400",
          "summary sha256",
          "filename story.txt",
          "\tline",
        ].join("\n"),
      )[0]?.commitSha,
    ).toBe(sha);
  });

  it("merges binary, addition, deletion, and copy status metadata", () => {
    expect(
      parseCommitFileChanges(
        "-\t-\tassets/logo.bin\u00001\t0\tnew.txt\u0000",
        "M\0assets/logo.bin\0A\0new.txt\0D\0deleted.txt\0C100\0old.txt\0copy.txt\0",
      ),
    ).toEqual([
      {
        path: "assets/logo.bin",
        additions: 0,
        deletions: 0,
        changeType: "binary",
      },
      {
        path: "new.txt",
        additions: 1,
        deletions: 0,
        changeType: "added",
      },
      {
        path: "deleted.txt",
        additions: 0,
        deletions: 0,
        changeType: "deleted",
      },
      {
        path: "copy.txt",
        additions: 0,
        deletions: 0,
        changeType: "copied",
        previousPath: "old.txt",
      },
    ]);
  });

  it("rejects adversarial regex syntax before any Git probe", async () => {
    const runner = new HistoryRemediationRunner();
    const query: HistoryQuery = {
      terms: [{ field: "patch", value: "^(a+)+$" }],
      regex: true,
    };
    await expect(
      createHistoryService(runner).search(testRepositoryRoot, query),
    ).rejects.toThrow("no groups or alternation");
    expect(runner.requests).toHaveLength(0);
  });

  it("reports a bounded patch probe as incomplete and stops at the aggregate budget", async () => {
    const runner = new HistoryRemediationRunner();
    const sha = "b".repeat(40);
    runner.streamingOutput = metadataRecord(sha, "candidate");
    runner.outputs.push({
      ...emptyOutput,
      standardOutput: "x".repeat(8 * 1024 * 1024 + 1),
    });
    const result = await createHistoryService(runner).search(
      testRepositoryRoot,
      {
        terms: [{ field: "patch", value: "needle" }],
        matchAll: true,
        limit: 1,
      },
    );
    expect(result.patchResultsIncomplete).toBe(true);
    expect(result.reachedSafetyCap).toBe(true);
    expect(runner.requests[1]?.maxStandardOutputBytes).toBe(8 * 1024 * 1024);
  });

  it("cancels deferred root discovery before any Git read", async () => {
    const runner = new HistoryRemediationRunner();
    const cancellationController = new AbortController();
    let signalObserved!: () => void;
    const rootDiscoveryStarted = new Promise<void>(
      (resolve) => (signalObserved = resolve),
    );
    const rootBindingResolver = new GitRootBindingResolver(
      () => Promise.resolve("/usr/bin/git"),
      {
        resolveRootBinding: async (
          _repositoryRoot,
          _expectedIdentity,
          options,
        ) => {
          signalObserved();
          if (options?.cancellationSignal === undefined)
            throw new Error("Cancellation signal was not forwarded.");
          return abortWhenSignalled(options.cancellationSignal);
        },
      },
    );
    const operation = createHistoryServiceWithResolver(
      runner,
      rootBindingResolver,
    ).listRepositoryHistory(testRepositoryRoot, {
      cancellationSignal: cancellationController.signal,
    });
    await rootDiscoveryStarted;
    cancellationController.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.requests).toHaveLength(0);
  });

  it("cancels deferred root reassertion before any Git read", async () => {
    const runner = new HistoryRemediationRunner();
    const cancellationController = new AbortController();
    const rootIdentity = await createHistoryRootIdentity();
    let rootBindingCallCount = 0;
    let reassertionStarted!: () => void;
    const rootReassertionStarted = new Promise<void>(
      (resolve) => (reassertionStarted = resolve),
    );
    const rootBindingResolver = new GitRootBindingResolver(
      () => Promise.resolve("/usr/bin/git"),
      {
        resolveRootBinding: async (
          _repositoryRoot,
          expectedIdentity,
          options,
        ) => {
          rootBindingCallCount += 1;
          if (expectedIdentity === undefined) return rootIdentity;
          reassertionStarted();
          if (options?.cancellationSignal === undefined)
            throw new Error("Cancellation signal was not forwarded.");
          return abortWhenSignalled(options.cancellationSignal);
        },
      },
    );
    const operation = createHistoryServiceWithResolver(
      runner,
      rootBindingResolver,
    ).listRepositoryHistory(testRepositoryRoot, {
      cancellationSignal: cancellationController.signal,
    });
    await rootReassertionStarted;
    cancellationController.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(rootBindingCallCount).toBe(2);
    expect(runner.requests).toHaveLength(0);
  });

  it("does not create a merge-parent resource when that parent has no file diff", async () => {
    const runner = new HistoryRemediationRunner();
    const parentSha = "c".repeat(40);
    const mergeSha = "d".repeat(40);
    runner.outputs.push(
      {
        ...emptyOutput,
        standardOutput: metadataRecord(mergeSha, "merge", parentSha),
      },
      {
        ...emptyOutput,
        standardOutput: metadataRecord(mergeSha, "merge", parentSha),
      },
      { ...emptyOutput, standardOutput: "" },
    );
    const navigation = await createHistoryService(runner).getRevisionNavigation(
      testRepositoryRoot,
      mergeSha,
      "story.txt",
    );
    expect(navigation.selectedParent?.sha).toBe(parentSha);
    expect(navigation.previousRevision).toBeUndefined();
    expect(navigation.previousDiff).toBeUndefined();
  });

  it("keeps the current path when a merge parent has no diff-tree status", async () => {
    const runner = new HistoryRemediationRunner();
    const parentSha = "1".repeat(40);
    const mergeSha = "2".repeat(40);
    runner.outputs.push(
      {
        ...emptyOutput,
        standardOutput: metadataRecord(mergeSha, "merge", parentSha),
      },
      {
        ...emptyOutput,
        standardOutput: metadataRecord(mergeSha, "merge", parentSha),
      },
      { ...emptyOutput, standardOutput: "" },
      { ...emptyOutput, standardOutput: "story.txt\0" },
    );
    const navigation = await createHistoryService(runner).getRevisionNavigation(
      testRepositoryRoot,
      mergeSha,
      "story.txt",
    );
    expect(navigation.previousRevision).toMatchObject({
      revisionSha: parentSha,
      relativePath: "story.txt",
    });
  });

  it("retains remote repository identity in revision resources", async () => {
    const runner = new HistoryRemediationRunner();
    const revisionSha = "e".repeat(40);
    const remoteRoot = {
      scheme: "vscode-remote",
      authority: "ssh-remote+origin",
      path: "/workspace/repo",
      fsPath: testRepositoryRoot,
      toString: () => "vscode-remote://ssh-remote+origin/workspace/repo",
    } as unknown as HistoryRepositoryRoot;
    runner.outputs.push(
      { ...emptyOutput, standardOutput: metadataRecord(revisionSha, "remote") },
      { ...emptyOutput, standardOutput: metadataRecord(revisionSha, "remote") },
    );

    const navigation = await createHistoryService(runner).getRevisionNavigation(
      remoteRoot,
      revisionSha,
      "story.txt",
    );

    expect(navigation.current.repositoryRoot).toBe(testRepositoryRoot);
    expect(navigation.current.repositoryRootIdentity).toBe(
      "vscode-remote://ssh-remote+origin/workspace/repo",
    );
  });
});
