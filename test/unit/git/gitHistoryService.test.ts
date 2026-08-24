import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitHistoryOutputTruncatedError,
  GitHistoryService,
  parseCommitDetailsMetadata,
  parseCommitFileChanges,
  parseCommitNameStatus,
  parseCommitSummaryRecords,
} from "../../../src/extension/git/gitHistoryService.js";
import type {
  GitCommandOutput,
  GitCommandRequest,
  GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { createHistoryRootBindingResolver } from "../history/historyRootBindingTestSupport.js";

class RecordingGitCommandRunner implements GitCommandRunner {
  public readonly requests: GitCommandRequest[] = [];
  public readonly commandOutputs: GitCommandOutput[] = [];
  public streamingChunks: readonly string[] = [];
  public onRun:
    | ((request: GitCommandRequest, requestIndex: number) => Promise<void>)
    | undefined;

  public async run(request: GitCommandRequest): Promise<GitCommandOutput> {
    this.requests.push(request);
    await this.onRun?.(request, this.requests.length - 1);
    if (
      request.arguments.length === 2 &&
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--is-shallow-repository"
    ) {
      return {
        standardOutput: "false\n",
        standardError: "",
        exitCode: 0,
      };
    }
    return (
      this.commandOutputs.shift() ?? {
        standardOutput: "",
        standardError: "",
        exitCode: 0,
      }
    );
  }

  public async runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    this.requests.push(request);
    await this.onRun?.(request, this.requests.length - 1);
    for (const chunk of this.streamingChunks) onStandardOutputChunk(chunk);
    return Promise.resolve({
      standardOutput: "",
      standardError: "",
      exitCode: 0,
    });
  }
}

let testRepositoryPath: string;

beforeEach(async () => {
  testRepositoryPath = await mkdtemp(
    nodePath.join(tmpdir(), "gito-history-unit-"),
  );
});

afterEach(async () => {
  await rm(testRepositoryPath, { recursive: true, force: true });
});

function testRepositoryUri(): { fsPath: string; scheme: "file" } {
  return { fsPath: testRepositoryPath, scheme: "file" };
}

function createHistoryService(
  commandRunner: GitCommandRunner,
): GitHistoryService {
  return new GitHistoryService(
    commandRunner,
    createHistoryRootBindingResolver(),
  );
}

describe("Git history parsing", () => {
  it("parses paged commit records without losing refs or author fields", () => {
    const parsedCommits = parseCommitSummaryRecords(
      "abc123\u0000abc1234\u0000A. Author\u0000a@example.com\u00002026-08-23T10:00:00+10:00\u00002026-08-23T10:01:00+10:00\u0000Fix parser\u0000HEAD -> main, origin/main\x01",
    );

    expect(parsedCommits).toEqual([
      {
        commitSha: "abc123",
        shortSha: "abc1234",
        authorName: "A. Author",
        authorEmail: "a@example.com",
        authorDate: "2026-08-23T10:00:00+10:00",
        commitDate: "2026-08-23T10:01:00+10:00",
        subject: "Fix parser",
        refs: ["HEAD -> main", "origin/main"],
      },
    ]);
  });

  it("streams activity records across arbitrary chunk boundaries and filters aliases", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "a".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "local@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
    );
    commandRunner.streamingChunks = [
      "2026-08-20T10:00:00+10:00\0alias@example.com\x012026-08-21T10:00:",
      "00+10:00\0other@example.com\x012026-08-21T12:00:00+10:00\0A",
      "LIAS@example.com\x01",
    ];
    const historyService = createHistoryService(commandRunner);

    const activitySnapshot = await historyService.getCommitActivity(
      testRepositoryUri() as never,
      ["alias@example.com"],
      { startDate: "2025-08-23", endDate: "2026-08-23" },
    );

    expect([...activitySnapshot.days.entries()]).toEqual([
      ["2026-08-20", 1],
      ["2026-08-21", 1],
    ]);
    expect(activitySnapshot.matchingCommitCount).toBe(2);
    expect(commandRunner.requests[0]?.arguments).toContain("rev-parse");
    expect(commandRunner.requests[0]?.rootBinding).toBeDefined();
    expect(commandRunner.requests[0]?.rootBindingRequired).toBe(true);
    expect(commandRunner.requests[2]?.arguments).toEqual([
      "config",
      "--local",
      "--get",
      "user.email",
    ]);
    expect(commandRunner.requests[3]?.arguments).toContain(
      "--format=%aI%x00%ae%x01",
    );
  });

  it("reports output truncation separately from the matching-commit cap", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "f".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "author@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
    );
    commandRunner.streamingChunks = [
      "2026-08-20T10:00:00+10:00\0author@example.com\x01",
    ];
    commandRunner.runStreaming = (
      request,
      onStandardOutputChunk,
    ): Promise<GitCommandOutput> => {
      commandRunner.requests.push(request);
      onStandardOutputChunk(commandRunner.streamingChunks[0] ?? "");
      return Promise.resolve({
        standardOutput: "",
        standardError: "",
        exitCode: 0,
        standardOutputTruncated: true,
      });
    };

    const activitySnapshot = await createHistoryService(
      commandRunner,
    ).getCommitActivity(testRepositoryUri() as never, [], {
      startDate: "2025-08-23",
      endDate: "2026-08-23",
    });

    expect(activitySnapshot.matchingCommitCount).toBe(1);
    expect(activitySnapshot.reachedSafetyCap).toBe(false);
    expect(activitySnapshot.outputTruncated).toBe(true);
  });

  it("rejects cancellation after the final HEAD read before caching", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "1".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "author@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
    );
    commandRunner.streamingChunks = [
      "2026-08-20T10:00:00+10:00\0author@example.com\x01",
    ];
    const cancellationController = new AbortController();
    let headReadCount = 0;
    commandRunner.onRun = (request) => {
      if (
        request.arguments[0] === "rev-parse" &&
        request.arguments.includes("--verify") &&
        ++headReadCount === 2
      ) {
        cancellationController.abort();
      }
      return Promise.resolve();
    };

    await expect(
      createHistoryService(commandRunner).getCommitActivity(
        testRepositoryUri() as never,
        [],
        { startDate: "2025-08-23", endDate: "2026-08-23" },
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a truncated configured author email", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "2".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "partial-author",
        standardError: "",
        exitCode: 0,
        standardOutputTruncated: true,
      },
    );

    await expect(
      createHistoryService(commandRunner).getCommitActivity(
        testRepositoryUri() as never,
        [],
        { startDate: "2025-08-23", endDate: "2026-08-23" },
      ),
    ).rejects.toMatchObject({ name: "GitHistoryOutputTruncatedError" });
  });

  it("uses repository email before global email and keeps aliases additive", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "b".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "LOCAL@EXAMPLE.COM\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
    );
    commandRunner.streamingChunks = [
      "2026-08-20T10:00:00+10:00\0local@example.com\x01",
      "2026-08-21T10:00:00+10:00\0alias@example.com\x01",
    ];

    const activitySnapshot = await createHistoryService(
      commandRunner,
    ).getCommitActivity(testRepositoryUri() as never, [" Alias@Example.com "], {
      startDate: "2025-08-23",
      endDate: "2026-08-23",
    });

    expect(activitySnapshot.matchingCommitCount).toBe(2);
    expect(commandRunner.requests[2]?.arguments).toEqual([
      "config",
      "--local",
      "--get",
      "user.email",
    ]);
    expect(
      commandRunner.requests.some((request) =>
        request.arguments.includes("--global"),
      ),
    ).toBe(false);
  });

  it("falls back to global email when repository email is absent", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "c".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      { standardOutput: "", standardError: "", exitCode: 0 },
      {
        standardOutput: "GLOBAL@EXAMPLE.COM\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${headCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
    );
    commandRunner.streamingChunks = [
      "2026-08-20T10:00:00+10:00\0global@example.com\x01",
    ];

    const activitySnapshot = await createHistoryService(
      commandRunner,
    ).getCommitActivity(testRepositoryUri() as never, [], {
      startDate: "2025-08-23",
      endDate: "2026-08-23",
    });

    expect(activitySnapshot.matchingCommitCount).toBe(1);
    expect(commandRunner.requests[3]?.arguments).toEqual([
      "config",
      "--global",
      "--get",
      "user.email",
    ]);
  });

  it("caches by canonical root, HEAD, normalized emails, and date window", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const firstHeadCommitSha = "d".repeat(40);
    const secondHeadCommitSha = "e".repeat(40);
    commandRunner.commandOutputs.push(
      {
        standardOutput: `${firstHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "author@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${firstHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${firstHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "author@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${firstHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${firstHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "author@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${firstHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${secondHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "author@example.com\n",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: `${secondHeadCommitSha}\n`,
        standardError: "",
        exitCode: 0,
      },
    );
    commandRunner.streamingChunks = [
      "2026-08-20T10:00:00+10:00\0author@example.com\x01",
    ];
    const historyService = createHistoryService(commandRunner);
    const firstWindow = {
      startDate: "2025-08-23",
      endDate: "2026-08-23",
    };

    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      firstWindow,
    );
    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      firstWindow,
    );
    await historyService.getCommitActivity(testRepositoryUri() as never, [], {
      startDate: "2025-08-24",
      endDate: "2026-08-24",
    });
    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      firstWindow,
    );

    expect(
      commandRunner.requests.filter(
        (request) => request.arguments[0] === "log",
      ),
    ).toHaveLength(3);
  });

  it("does not reuse activity after same-path repository retarget with same HEAD", async () => {
    const firstRepositoryPath = nodePath.join(testRepositoryPath, "repository");
    const replacementRepositoryPath = nodePath.join(
      testRepositoryPath,
      "replacement",
    );
    const displacedRepositoryPath = nodePath.join(
      testRepositoryPath,
      "repository-displaced",
    );
    await Promise.all([
      mkdir(firstRepositoryPath),
      mkdir(replacementRepositoryPath),
    ]);

    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "a".repeat(40);
    commandRunner.commandOutputs.push(
      ...[firstRepositoryPath, replacementRepositoryPath].flatMap(() => [
        {
          standardOutput: `${headCommitSha}\n`,
          standardError: "",
          exitCode: 0,
        },
        {
          standardOutput: "author@example.com\n",
          standardError: "",
          exitCode: 0,
        },
        {
          standardOutput: `${headCommitSha}\n`,
          standardError: "",
          exitCode: 0,
        },
      ]),
    );
    let streamInvocationCount = 0;
    commandRunner.runStreaming = (
      request,
      onStandardOutputChunk,
    ): Promise<GitCommandOutput> => {
      commandRunner.requests.push(request);
      streamInvocationCount += 1;
      const activityRecords =
        streamInvocationCount === 1
          ? ["2026-08-20T10:00:00+10:00\0author@example.com\x01"]
          : [
              "2026-08-20T10:00:00+10:00\0author@example.com\x01",
              "2026-08-21T10:00:00+10:00\0author@example.com\x01",
            ];
      for (const activityRecord of activityRecords)
        onStandardOutputChunk(activityRecord);
      return Promise.resolve({
        standardOutput: "",
        standardError: "",
        exitCode: 0,
      });
    };
    const historyService = createHistoryService(commandRunner);
    const repositoryUri = {
      fsPath: firstRepositoryPath,
      scheme: "file",
    } as never;

    const firstActivitySnapshot = await historyService.getCommitActivity(
      repositoryUri,
      [],
      { startDate: "2025-08-23", endDate: "2026-08-23" },
    );
    await rename(firstRepositoryPath, displacedRepositoryPath);
    await rename(replacementRepositoryPath, firstRepositoryPath);
    const secondActivitySnapshot = await historyService.getCommitActivity(
      repositoryUri,
      [],
      { startDate: "2025-08-23", endDate: "2026-08-23" },
    );

    expect(firstActivitySnapshot.matchingCommitCount).toBe(1);
    expect(secondActivitySnapshot.matchingCommitCount).toBe(2);
    expect(streamInvocationCount).toBe(2);
  });

  it("promotes activity cache hits so the least recently used entry is evicted", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    const headCommitSha = "b".repeat(40);
    commandRunner.onRun = (request) => {
      if (
        request.arguments[0] === "rev-parse" &&
        request.arguments.includes("--verify")
      ) {
        commandRunner.commandOutputs.push({
          standardOutput: `${headCommitSha}\n`,
          standardError: "",
          exitCode: 0,
        });
      } else if (request.arguments[0] === "config") {
        commandRunner.commandOutputs.push({
          standardOutput: "author@example.com\n",
          standardError: "",
          exitCode: 0,
        });
      }
      return Promise.resolve();
    };
    let streamInvocationCount = 0;
    commandRunner.runStreaming = (
      request,
      onStandardOutputChunk,
    ): Promise<GitCommandOutput> => {
      commandRunner.requests.push(request);
      streamInvocationCount += 1;
      onStandardOutputChunk(
        "2026-08-20T10:00:00+10:00\0author@example.com\x01",
      );
      return Promise.resolve({
        standardOutput: "",
        standardError: "",
        exitCode: 0,
      });
    };
    const historyService = createHistoryService(commandRunner);
    const getWindow = (windowIndex: number) => ({
      startDate: `window-${windowIndex}-start`,
      endDate: `window-${windowIndex}-end`,
    });

    for (let windowIndex = 0; windowIndex < 32; windowIndex += 1) {
      await historyService.getCommitActivity(
        testRepositoryUri() as never,
        [],
        getWindow(windowIndex),
      );
    }
    expect(streamInvocationCount).toBe(32);

    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      getWindow(0),
    );
    expect(streamInvocationCount).toBe(32);

    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      getWindow(32),
    );
    expect(streamInvocationCount).toBe(33);

    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      getWindow(0),
    );
    expect(streamInvocationCount).toBe(33);

    await historyService.getCommitActivity(
      testRepositoryUri() as never,
      [],
      getWindow(1),
    );
    expect(streamInvocationCount).toBe(34);
  });

  it("parses commit metadata and numstat totals", () => {
    expect(
      parseCommitDetailsMetadata(
        "abc123\u0000abc1234\u0000A. Author\u0000a@example.com\u00002026-08-23T10:00:00+10:00\u00002026-08-23T10:01:00+10:00\u0000parent1 parent2\u0000Merge parser\x01",
      ),
    ).toMatchObject({
      commitSha: "abc123",
      parentShas: ["parent1", "parent2"],
      subject: "Merge parser",
    });
    expect(
      parseCommitFileChanges("2\t1\tsrc/parser.ts\n-\t-\tassets/logo.png\n"),
    ).toEqual([
      {
        path: "src/parser.ts",
        additions: 2,
        deletions: 1,
        changeType: "modified",
      },
      {
        path: "assets/logo.png",
        additions: 0,
        deletions: 0,
        changeType: "binary",
      },
    ]);
  });

  it("maps supported GitHub and Azure DevOps remotes to commit URLs", () => {
    const historyService = createHistoryService(
      new RecordingGitCommandRunner(),
    );
    expect(
      historyService.getCanonicalCommitUrl(
        ["git@github.com:owner/repository.git"],
        "abc1234",
      ),
    ).toBe("https://github.com/owner/repository/commit/abc1234");
    expect(
      historyService.getCanonicalCommitUrl(
        ["https://dev.azure.com/org/project/_git/repository"],
        "abc1234",
      ),
    ).toBe("https://dev.azure.com/org/project/_git/repository/commit/abc1234");
    expect(
      historyService.getCanonicalCommitUrl(
        ["https://example.com/org/repository.git"],
        "abc1234",
      ),
    ).toBeUndefined();
  });

  it("searches the full repository, including commits beyond page one", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    commandRunner.commandOutputs.push({
      standardOutput:
        "older1234567\u0000older12\u0000A. Author\u0000a@example.com\u00002026-08-20T10:00:00+10:00\u00002026-08-20T10:00:00+10:00\u0000Target beyond page one\u0000\x01",
      standardError: "",
      exitCode: 0,
    });
    const historyService = createHistoryService(commandRunner);

    await expect(
      historyService.searchHistory(
        testRepositoryUri() as never,
        "beyond page one",
      ),
    ).resolves.toEqual([
      expect.objectContaining({ subject: "Target beyond page one" }),
    ]);
    expect(commandRunner.requests[0]?.arguments).toContain("--all");
  });

  it("marks capped history pages instead of pretending they have a cursor", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    commandRunner.commandOutputs.push({
      standardOutput:
        "abc123\u0000abc1234\u0000A. Author\u0000a@example.com\u00002026-08-20T10:00:00+10:00\u00002026-08-20T10:00:00+10:00\u0000partial\u0000\x01",
      standardError: "",
      exitCode: 0,
      standardOutputTruncated: true,
    });
    const page = await createHistoryService(commandRunner).listCommitHistory(
      testRepositoryUri() as never,
      0,
    );

    expect(page).toMatchObject({ truncated: true, hasMore: false });
    expect(commandRunner.requests[0]?.maxStandardOutputBytes).toBeGreaterThan(
      0,
    );
  });

  it("rejects a capped full-history search rather than returning an unknown partial result", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    commandRunner.commandOutputs.push({
      standardOutput: "partial",
      standardError: "",
      exitCode: 0,
      standardOutputTruncated: true,
    });

    await expect(
      createHistoryService(commandRunner).searchHistory(
        testRepositoryUri() as never,
        "partial",
      ),
    ).rejects.toBeInstanceOf(GitHistoryOutputTruncatedError);
  });

  it("marks partial commit bodies and file lists when a detail cap is reached", async () => {
    const commandRunner = new RecordingGitCommandRunner();
    commandRunner.commandOutputs.push(
      {
        standardOutput:
          "abc1234\u0000abc1234\u0000A. Author\u0000a@example.com\u00002026-08-20T10:00:00+10:00\u00002026-08-20T10:00:00+10:00\u0000parent\u0000subject\u0001",
        standardError: "",
        exitCode: 0,
      },
      {
        standardOutput: "partial body",
        standardError: "",
        exitCode: 0,
        standardOutputTruncated: true,
      },
      { standardOutput: "", standardError: "", exitCode: 0 },
      { standardOutput: "", standardError: "", exitCode: 0 },
    );

    await expect(
      createHistoryService(commandRunner).getCommitDetails(
        testRepositoryUri() as never,
        "abc1234",
      ),
    ).resolves.toMatchObject({ truncated: true, body: "partial body" });
  });

  it("rejects a repository symlink retargeted during a history request", async () => {
    const firstRepositoryPath = nodePath.join(testRepositoryPath, "first");
    const secondRepositoryPath = nodePath.join(testRepositoryPath, "second");
    const linkedRepositoryPath = nodePath.join(testRepositoryPath, "linked");
    await Promise.all([
      mkdir(firstRepositoryPath),
      mkdir(secondRepositoryPath),
    ]);
    await symlink(firstRepositoryPath, linkedRepositoryPath);
    const commandRunner = new RecordingGitCommandRunner();
    commandRunner.onRun = async (_request, requestIndex) => {
      if (requestIndex !== 0) return;
      await rm(linkedRepositoryPath);
      await symlink(secondRepositoryPath, linkedRepositoryPath);
    };

    await expect(
      createHistoryService(commandRunner).listCommitHistory(
        { fsPath: linkedRepositoryPath, scheme: "file" } as never,
        0,
      ),
    ).rejects.toMatchObject({ name: "GitHistoryRepositoryBindingError" });
    expect(commandRunner.requests[0]?.repositoryRoot).toBe(
      await realpath(firstRepositoryPath),
    );
  });

  it("keeps concurrent history requests bound to their own canonical roots", async () => {
    const firstRepositoryPath = nodePath.join(testRepositoryPath, "first");
    const secondRepositoryPath = nodePath.join(testRepositoryPath, "second");
    await Promise.all([
      mkdir(firstRepositoryPath),
      mkdir(secondRepositoryPath),
    ]);
    const commandRunner = new RecordingGitCommandRunner();
    const historyService = createHistoryService(commandRunner);

    await Promise.all([
      historyService.listCommitHistory(
        { fsPath: firstRepositoryPath, scheme: "file" } as never,
        0,
      ),
      historyService.listCommitHistory(
        { fsPath: secondRepositoryPath, scheme: "file" } as never,
        0,
      ),
    ]);

    expect(
      new Set(commandRunner.requests.map((request) => request.repositoryRoot)),
    ).toEqual(
      new Set([
        await realpath(firstRepositoryPath),
        await realpath(secondRepositoryPath),
      ]),
    );
  });

  it("preserves rename previous/current paths and add/delete metadata", () => {
    expect(
      parseCommitFileChanges(
        "1\t0\t\0src/old.ts\0src/new.ts\0",
        "R100\0src/old.ts\0src/new.ts\0",
      ),
    ).toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        additions: 1,
        deletions: 0,
        changeType: "renamed",
      },
    ]);
    expect(
      parseCommitFileChanges("1\t0\tsrc/new.ts\n", "A\0src/new.ts\0"),
    ).toEqual([
      {
        path: "src/new.ts",
        additions: 1,
        deletions: 0,
        changeType: "added",
      },
    ]);
  });

  it("preserves the complete remainder of tab-containing paths", () => {
    const tabContainingPath = "docs/release\tnotes.md";
    expect(parseCommitNameStatus(`M\t${tabContainingPath}\0`)).toEqual([
      {
        path: tabContainingPath,
        additions: 0,
        deletions: 0,
        changeType: "modified",
      },
    ]);
    expect(
      parseCommitFileChanges(
        `2\t1\t${tabContainingPath}\0`,
        `M\t${tabContainingPath}\0`,
      ),
    ).toEqual([
      {
        path: tabContainingPath,
        additions: 2,
        deletions: 1,
        changeType: "modified",
      },
    ]);
  });

  it("preserves binary/type-change status and decodes quoted paths", () => {
    expect(
      parseCommitFileChanges(
        '-\t-\t"docs/release\\tnot\\303\\251s.md"\0',
        'T\0"docs/release\\tnot\\303\\251s.md"\0',
      ),
    ).toEqual([
      {
        path: "docs/release\tnotés.md",
        additions: 0,
        deletions: 0,
        changeType: "binary",
      },
    ]);
  });
});
