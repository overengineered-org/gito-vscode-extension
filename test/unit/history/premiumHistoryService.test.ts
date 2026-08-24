import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  HISTORY_METADATA_FORMAT,
  decodeGitPath,
  parseBlamePorcelain,
  parseNameStatusRecords,
  parseHistoryRecords,
} from "../../../src/extension/history/historyParsing.js";
import {
  HISTORY_QUERY_SAFETY_CAP,
  PremiumHistoryService,
  type HistoryQuery,
} from "../../../src/extension/history/index.js";
import type {
  GitCommandOutput,
  GitCommandRequest,
  GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { createHistoryRootBindingResolver } from "./historyRootBindingTestSupport.js";

const emptyCommandOutput: GitCommandOutput = {
  standardOutput: "",
  standardError: "",
  exitCode: 0,
};

function createHistoryService(runner: GitCommandRunner): PremiumHistoryService {
  return new PremiumHistoryService(runner, createHistoryRootBindingResolver());
}
const testRepositoryRoot = process.cwd();

class FixtureGitCommandRunner implements GitCommandRunner {
  public readonly requests: GitCommandRequest[] = [];
  public readonly queuedOutputs: GitCommandOutput[] = [];
  public streamingOutput = "";
  public numstatOutput: GitCommandOutput | undefined;
  public onRun:
    | ((
        request: GitCommandRequest,
        requestIndex: number,
      ) => void | Promise<void>)
    | undefined;

  public async run(request: GitCommandRequest): Promise<GitCommandOutput> {
    const requestIndex = this.requests.push(request) - 1;
    await this.onRun?.(request, requestIndex);
    if (request.arguments.includes("--numstat"))
      return this.numstatOutput ?? emptyCommandOutput;
    return this.queuedOutputs.shift() ?? emptyCommandOutput;
  }

  public async runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    const requestIndex = this.requests.push(request) - 1;
    await this.onRun?.(request, requestIndex);
    const output = this.streamingOutput;
    for (let index = 0; index < output.length; index += 791) {
      onStandardOutputChunk(output.slice(index, index + 791));
      if (request.cancellationSignal?.aborted) {
        throw new DOMException("cancelled", "AbortError");
      }
    }
    return emptyCommandOutput;
  }
}

function metadataRecord(
  sha: string,
  subject: string,
  parentShas = "",
  changedFiles = "",
): string {
  return `\x1e${sha}\u0000${sha.slice(0, 7)}\u0000Ada Author\u0000ada@example.test\u00002026-08-23T00:00:00+00:00\u00002026-08-23T00:00:00+00:00\u0000${parentShas}\u0000${subject}${changedFiles}`;
}

describe("premium history parsing", () => {
  it("decodes Git C-style quoted paths and preserves type changes", () => {
    expect(decodeGitPath('"docs/release\\tnot\\303\\251s.md"')).toBe(
      "docs/release\tnotés.md",
    );
    expect(
      parseNameStatusRecords('T\0"docs/release\\tnot\\303\\251s.md"\0'),
    ).toEqual([
      {
        path: "docs/release\tnotés.md",
        changeType: "type-changed",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("does not interpret -L patch lines as changed-file statuses", () => {
    const commitSha = "0123456789012345678901234567890123456789";
    const parsedCommits = parseHistoryRecords(
      `${metadataRecord(commitSha, "line history")}\nM\0patch.txt\0`,
      false,
    );
    expect(parsedCommits[0]?.changedFiles).toEqual([]);
  });

  it("parses exact commit identity and rename paths from NUL records", () => {
    const commitSha = "0123456789012345678901234567890123456789";
    const parsedCommits = parseHistoryRecords(
      metadataRecord(commitSha, "rename story", "parent") +
        "\nR100\0old/story.txt\0new/story.txt\0",
    );
    expect(parsedCommits).toEqual([
      {
        sha: commitSha,
        shortSha: commitSha.slice(0, 7),
        subject: "rename story",
        authorName: "Ada Author",
        authorEmail: "ada@example.test",
        authorDate: "2026-08-23T00:00:00+00:00",
        committerDate: "2026-08-23T00:00:00+00:00",
        parentShas: ["parent"],
        changedFiles: [
          {
            path: "new/story.txt",
            previousPath: "old/story.txt",
            changeType: "renamed",
            additions: 0,
            deletions: 0,
          },
        ],
      },
    ]);
  });

  it("maps every blame line to exact SHA, author, date, summary, and path", () => {
    const commitSha = "0123456789012345678901234567890123456789";
    const blameOutput = [
      `${commitSha} 4 1 2`,
      "author Ada Author",
      "author-mail <ada@example.test>",
      "author-time 1776902400",
      "summary move shared line",
      "filename renamed.txt",
      "\tshared",
      "\tmoved",
    ].join("\n");
    expect(parseBlamePorcelain(blameOutput)).toEqual([
      {
        lineNumber: 1,
        content: "shared",
        commitSha,
        originalLineNumber: 4,
        authorName: "Ada Author",
        authorEmail: "ada@example.test",
        authorDate: "2026-04-23T00:00:00.000Z",
        summary: "move shared line",
        pathAtRevision: "renamed.txt",
      },
      {
        lineNumber: 2,
        content: "moved",
        commitSha,
        originalLineNumber: 5,
        authorName: "Ada Author",
        authorEmail: "ada@example.test",
        authorDate: "2026-04-23T00:00:00.000Z",
        summary: "move shared line",
        pathAtRevision: "renamed.txt",
      },
    ]);
  });
});

describe("PremiumHistoryService", () => {
  it("returns exact file history and follows a rename", async () => {
    const runner = new FixtureGitCommandRunner();
    const oldSha = "1111111111111111111111111111111111111111";
    const renameSha = "2222222222222222222222222222222222222222";
    runner.queuedOutputs.push({
      ...emptyCommandOutput,
      standardOutput:
        metadataRecord(
          renameSha,
          "rename",
          oldSha,
          "\nR100\0old.txt\0new.txt\0",
        ) + metadataRecord(oldSha, "initial", "", "\nA\0old.txt\0"),
    });
    runner.numstatOutput = {
      ...emptyCommandOutput,
      standardOutput:
        metadataRecord(
          renameSha,
          "rename",
          oldSha,
          "\n0\t0\t\0old.txt\0new.txt\0",
        ) + metadataRecord(oldSha, "initial", "", "\n1\t0\told.txt\0"),
    };
    const history = await createHistoryService(runner).listFileHistory(
      testRepositoryRoot,
      "new.txt",
      { maxEntries: 10 },
    );
    expect(
      history.entries.map((entry) => [
        entry.sha,
        entry.path,
        entry.previousPath,
        entry.changedFiles[0]?.additions,
        entry.changedFiles[0]?.deletions,
      ]),
    ).toEqual([
      [renameSha, "new.txt", "old.txt", 0, 0],
      [oldSha, "old.txt", undefined, 1, 0],
    ]);
    expect(runner.requests[0]?.arguments).toEqual([
      "log",
      "--no-ext-diff",
      "--date=iso-strict",
      "--max-count=11",
      `--format=${HISTORY_METADATA_FORMAT}`,
      "--follow",
      "--find-renames",
      "--name-status",
      "-z",
      "--",
      "new.txt",
    ]);
  });

  it("passes blame ranges to Git instead of scanning the whole file", async () => {
    const runner = new FixtureGitCommandRunner();
    await createHistoryService(runner).getBlame(
      testRepositoryRoot,
      "src/file.ts",
      {
        range: { startLine: 2, endLine: 4 },
      },
    );
    expect(runner.requests[0]?.arguments).toEqual([
      "blame",
      "--line-porcelain",
      "-M1",
      "-C",
      "-L",
      "2,4",
      "--",
      "src/file.ts",
    ]);
  });

  it("matches message, author, SHA, file, and patch terms with match-all", async () => {
    const runner = new FixtureGitCommandRunner();
    const matchingSha = "3333333333333333333333333333333333333333";
    runner.streamingOutput =
      metadataRecord(
        matchingSha,
        "needle message",
        "",
        "\nM\0src/needle.ts\0",
      ) + "\n";
    runner.queuedOutputs.push({
      ...emptyCommandOutput,
      standardOutput: "diff -- src/needle.ts\n+needle patch text\n",
    });
    const query: HistoryQuery = {
      terms: [
        { field: "message", value: "needle" },
        { field: "file", value: "src/needle.ts" },
        { field: "patch", value: "patch text" },
      ],
      matchAll: true,
      matchCase: false,
      limit: 10,
    };
    const result = await createHistoryService(runner).search(
      testRepositoryRoot,
      query,
    );
    expect(
      result.matches.map((match) => [match.sha, match.matchingFields]),
    ).toEqual([[matchingSha, ["message", "file", "patch"]]]);
    expect(result.matches[0]?.patchText).toContain("needle patch text");
    expect(runner.requests[0]?.arguments).toContain("--regexp-ignore-case");
    expect(runner.requests[0]?.arguments).toContain("-Gpatch text");
  });

  it("does not use Git patch narrowing for OR or JavaScript regex queries", async () => {
    const runner = new FixtureGitCommandRunner();
    runner.streamingOutput = metadataRecord(
      "5555555555555555555555555555555555555555",
      "regex candidate",
    );
    await createHistoryService(runner).search(testRepositoryRoot, {
      terms: [
        { field: "patch", value: "needle.?" },
        { field: "message", value: "candidate" },
      ],
      matchAll: false,
      regex: true,
      limit: 10,
    });
    expect(runner.requests[0]?.arguments).not.toContain(
      expect.stringMatching(/^-G/),
    );
  });

  it("compares contributor dates by instant, not offset text", async () => {
    const runner = new FixtureGitCommandRunner();
    const firstSha = "6666666666666666666666666666666666666666";
    const secondSha = "7777777777777777777777777777777777777777";
    runner.queuedOutputs.push({
      ...emptyCommandOutput,
      standardOutput:
        metadataRecord(secondSha, "newer", "", "").replaceAll(
          "2026-08-23T00:00:00+00:00",
          "2026-08-23T00:30:00+00:00",
        ) + metadataRecord(firstSha, "older"),
    });
    const snapshot = await createHistoryService(runner).aggregateContributors(
      testRepositoryRoot,
      { maxEntries: 10 },
    );
    expect(snapshot.contributors[0]).toMatchObject({
      firstAuthorDate: "2026-08-23T00:00:00+00:00",
      lastAuthorDate: "2026-08-23T00:30:00+00:00",
    });
  });

  it("separates the result limit from the bounded history scan", async () => {
    const runner = new FixtureGitCommandRunner();
    runner.streamingOutput = `${metadataRecord(
      "8888888888888888888888888888888888888888",
      "ordinary commit",
    )}\x1e${metadataRecord(
      "9999999999999999999999999999999999999999",
      "needle commit one",
    )}\x1e${metadataRecord(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "needle commit two",
    )}\x1e`;
    const result = await createHistoryService(runner).search(
      testRepositoryRoot,
      {
        terms: [{ field: "message", value: "needle" }],
        limit: 1,
      },
    );
    expect(result.matches.map((match) => match.subject)).toEqual([
      "needle commit one",
    ]);
    expect(result.examinedCommitCount).toBe(3);
    expect(result.reachedSafetyCap).toBe(false);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(runner.requests[0]?.arguments).toContain("--max-count=100001");
    expect(runner.requests[0]?.arguments).not.toContain("--max-count=2");
  });

  it("cancels streaming search and enforces the 100k scan cap", async () => {
    const runner = new FixtureGitCommandRunner();
    const record = metadataRecord(
      "4444444444444444444444444444444444444444",
      "cap",
    );
    runner.streamingOutput = `${record}\x1e`.repeat(
      HISTORY_QUERY_SAFETY_CAP + 1,
    );
    const result = await createHistoryService(runner).search(
      testRepositoryRoot,
      {
        terms: [],
        limit: HISTORY_QUERY_SAFETY_CAP,
      },
    );
    expect(result.matches).toHaveLength(HISTORY_QUERY_SAFETY_CAP);
    expect(result.examinedCommitCount).toBe(HISTORY_QUERY_SAFETY_CAP + 1);
    expect(result.reachedSafetyCap).toBe(true);
  });

  it("rejects unsafe paths, revisions, and invalid regex before Git runs", async () => {
    const runner = new FixtureGitCommandRunner();
    const service = createHistoryService(runner);
    await expect(service.getBlame("/repo", "../secret.txt")).rejects.toThrow(
      "inside the repository",
    );
    await expect(
      service.listBranchHistory("/repo", "--upload-pack=evil"),
    ).rejects.toThrow("safe Git revision");
    await expect(
      service.search("/repo", {
        terms: [{ field: "message", value: "[" }],
        regex: true,
      }),
    ).rejects.toThrow("regular expression");
    expect(runner.requests).toHaveLength(0);
  });

  it("pins Git to the canonical root behind a repository symlink", async () => {
    const temporaryParent = await mkdtemp(
      nodePath.join(tmpdir(), "gito-history-"),
    );
    const canonicalRoot = nodePath.join(temporaryParent, "canonical");
    const linkedRoot = nodePath.join(temporaryParent, "linked");
    await mkdir(canonicalRoot);
    await symlink(canonicalRoot, linkedRoot);
    try {
      const runner = new FixtureGitCommandRunner();
      await createHistoryService(runner).listRepositoryHistory(linkedRoot);
      expect(runner.requests[0]?.repositoryRoot).toBe(
        await realpath(canonicalRoot),
      );
      expect(runner.requests[0]?.rootBinding?.gitDirectory.canonicalPath).toBe(
        await realpath(canonicalRoot),
      );
      expect(runner.requests[0]?.literalPathspecs).toBe(true);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("rejects a symlink retarget between history commands", async () => {
    const temporaryParent = await mkdtemp(
      nodePath.join(tmpdir(), "gito-history-"),
    );
    const firstRoot = nodePath.join(temporaryParent, "first");
    const secondRoot = nodePath.join(temporaryParent, "second");
    const linkedRoot = nodePath.join(temporaryParent, "linked");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await symlink(firstRoot, linkedRoot);
    try {
      const runner = new FixtureGitCommandRunner();
      const commitSha = "8888888888888888888888888888888888888888";
      runner.queuedOutputs.push({
        ...emptyCommandOutput,
        standardOutput: metadataRecord(commitSha, "line") + "\n",
      });
      runner.onRun = async (_request, requestIndex) => {
        if (requestIndex !== 0) return;
        await rm(linkedRoot);
        await symlink(secondRoot, linkedRoot);
      };
      await expect(
        createHistoryService(runner).listLineHistory(
          linkedRoot,
          "story.txt",
          1,
        ),
      ).rejects.toThrow("history repository root");
      expect(runner.requests).toHaveLength(1);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("rejects a repository directory replacement between history commands", async () => {
    const temporaryParent = await mkdtemp(
      nodePath.join(tmpdir(), "gito-history-"),
    );
    const repositoryRoot = nodePath.join(temporaryParent, "repository");
    const movedRoot = nodePath.join(temporaryParent, "moved");
    await mkdir(repositoryRoot);
    try {
      const runner = new FixtureGitCommandRunner();
      const commitSha = "9999999999999999999999999999999999999999";
      runner.queuedOutputs.push({
        ...emptyCommandOutput,
        standardOutput: metadataRecord(commitSha, "line") + "\n",
      });
      runner.onRun = async (_request, requestIndex) => {
        if (requestIndex !== 0) return;
        await rename(repositoryRoot, movedRoot);
        await mkdir(repositoryRoot);
      };
      await expect(
        createHistoryService(runner).listLineHistory(
          repositoryRoot,
          "story.txt",
          1,
        ),
      ).rejects.toThrow("history repository root");
      expect(runner.requests).toHaveLength(1);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("revalidates the root after the final Git command returns", async () => {
    const temporaryParent = await mkdtemp(
      nodePath.join(tmpdir(), "gito-history-"),
    );
    const repositoryRoot = nodePath.join(temporaryParent, "repository");
    const movedRoot = nodePath.join(temporaryParent, "moved");
    await mkdir(repositoryRoot);
    try {
      const runner = new FixtureGitCommandRunner();
      const commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const output = {
        ...emptyCommandOutput,
        standardOutput: metadataRecord(commitSha, "history"),
      };
      runner.queuedOutputs.push(output);
      runner.numstatOutput = output;
      runner.onRun = async (_request, requestIndex) => {
        if (requestIndex !== 1) return;
        await rename(repositoryRoot, movedRoot);
        await mkdir(repositoryRoot);
      };
      await expect(
        createHistoryService(runner).listRepositoryHistory(repositoryRoot, {
          maxEntries: 1,
        }),
      ).rejects.toThrow("history repository root");
      expect(runner.requests).toHaveLength(2);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("revalidates the root after a streaming history command returns", async () => {
    const temporaryParent = await mkdtemp(
      nodePath.join(tmpdir(), "gito-history-"),
    );
    const repositoryRoot = nodePath.join(temporaryParent, "repository");
    const movedRoot = nodePath.join(temporaryParent, "moved");
    await mkdir(repositoryRoot);
    try {
      const runner = new FixtureGitCommandRunner();
      runner.streamingOutput = metadataRecord(
        "cccccccccccccccccccccccccccccccccccccccc",
        "streaming history",
      );
      runner.onRun = async (_request, requestIndex) => {
        if (requestIndex !== 0) return;
        await rename(repositoryRoot, movedRoot);
        await mkdir(repositoryRoot);
      };
      await expect(
        createHistoryService(runner).search(repositoryRoot, {
          terms: [],
          limit: 1,
        }),
      ).rejects.toThrow("history repository root");
      expect(runner.requests).toHaveLength(1);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("marks ordinary history pages truncated at the stdout byte cap", async () => {
    const runner = new FixtureGitCommandRunner();
    const commitSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    runner.queuedOutputs.push({
      ...emptyCommandOutput,
      standardOutput: metadataRecord(commitSha, "partial"),
      standardOutputTruncated: true,
    });
    runner.numstatOutput = {
      ...emptyCommandOutput,
      standardOutput: metadataRecord(commitSha, "partial"),
      standardOutputTruncated: true,
    };
    const history = await createHistoryService(runner).listRepositoryHistory(
      testRepositoryRoot,
      { maxEntries: 1 },
    );
    expect(history.truncated).toBe(true);
    expect(history.reachedSafetyCap).toBe(true);
    expect(history.hasMore).toBe(false);
  });
});
