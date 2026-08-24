import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import {
  CompareService,
  GitSearchService,
  type CompareUriFactory,
} from "../../../src/extension/compare/index.js";
import type {
  GitCommandOutput,
  GitCommandRequest,
  GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";

const testRootBindingResolver = new GitRootBindingResolver(() =>
  Promise.resolve("/usr/bin/git"),
);
const testCompareUriFactory: CompareUriFactory = {
  beginSession: () => undefined,
  empty: (filePath, side) =>
    testUri(filePath).with({ scheme: "gito-empty", query: side }),
  symlink: (filePath) => testUri(filePath).with({ scheme: "gito-symlink" }),
  workingContent: (filePath) =>
    Promise.resolve(testUri(filePath).with({ scheme: "gito-working-content" })),
};

function testUri(path: string): vscode.Uri {
  const uri: vscode.Uri = {
    scheme: "file",
    authority: "",
    path,
    query: "",
    fragment: "",
    fsPath: path,
    with(change) {
      return testUri(change.path ?? path);
    },
    toString() {
      return `file://${path}`;
    },
    toJSON() {
      return { scheme: "file", path };
    },
  };
  return uri;
}

class RepeatingSummaryPageRunner implements GitCommandRunner {
  private readonly commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  private readonly repositoryRootPath = process.cwd();
  public readonly streamingRequests: GitCommandRequest[] = [];

  public constructor(
    private readonly truncationFlags: Pick<
      GitCommandOutput,
      "standardOutputTruncated" | "standardErrorTruncated"
    > = {},
  ) {}

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--show-toplevel"
    ) {
      return Promise.resolve(this.output(`${this.repositoryRootPath}\n`));
    }
    throw new Error(`Unexpected Git command: ${request.arguments.join(" ")}`);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    this.streamingRequests.push(request);
    if (request.arguments[0] !== "log") {
      throw new Error(`Unexpected Git command: ${request.arguments.join(" ")}`);
    }
    const summaryFields = [
      this.commitSha,
      this.commitSha.slice(0, 7),
      "Search Tester",
      "search@example.test",
      "2026-08-24T00:00:00Z",
      "2026-08-24T00:00:00Z",
      "repeated page",
      "",
    ];
    const summaryRecord = `${summaryFields.join("\0")}\x01`;
    const summaryPage = summaryRecord.repeat(11);
    onStandardOutputChunk(summaryPage);
    return Promise.resolve(this.output(summaryPage));
  }

  private output(standardOutput: string): GitCommandOutput {
    return {
      standardOutput,
      standardError: "",
      exitCode: 0,
      ...this.truncationFlags,
    };
  }
}

class CallerCancellationAfterTruncationRunner implements GitCommandRunner {
  private readonly repositoryRootPath = process.cwd();

  public constructor(private readonly cancelCaller: () => void) {}

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--show-toplevel"
    ) {
      return Promise.resolve(this.output(`${this.repositoryRootPath}\n`));
    }
    throw new Error(`Unexpected Git command: ${request.arguments.join(" ")}`);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    if (request.arguments[0] !== "log") {
      throw new Error(`Unexpected Git command: ${request.arguments.join(" ")}`);
    }
    onStandardOutputChunk("truncating summary output");
    this.cancelCaller();
    return Promise.reject(new DOMException("cancelled", "AbortError"));
  }

  private output(standardOutput: string): GitCommandOutput {
    return { standardOutput, standardError: "", exitCode: 0 };
  }
}

describe("GitSearchService safety boundaries", () => {
  it("marks a repeated Git page as incomplete", async () => {
    const runner = new RepeatingSummaryPageRunner();
    const searchService = new GitSearchService(
      new CompareService(
        runner,
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );

    const page = await searchService.search(
      testUri(process.cwd()),
      "sha:aaaaaaaa",
      { maxResults: 10 },
    );

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.reachedSafetyCap).toBe(true);
    expect(runner.streamingRequests).not.toHaveLength(0);
    expect(
      runner.streamingRequests.every(
        (request) => request.rootBinding !== undefined,
      ),
    ).toBe(true);
  });

  it("reports runner truncation even when the page itself repeats", async () => {
    const runner = new RepeatingSummaryPageRunner({
      standardOutputTruncated: true,
      standardErrorTruncated: true,
    });
    const searchService = new GitSearchService(
      new CompareService(
        runner,
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );

    const page = await searchService.search(
      testUri(process.cwd()),
      "sha:aaaaaaaa",
      { maxResults: 10 },
    );

    expect(page.reachedSafetyCap).toBe(true);
  });

  it("propagates caller cancellation when a bounded stream also truncates", async () => {
    const cancellationController = new AbortController();
    const runner = new CallerCancellationAfterTruncationRunner(() =>
      cancellationController.abort(),
    );
    const searchService = new GitSearchService(
      new CompareService(
        runner,
        testCompareUriFactory,
        testRootBindingResolver,
      ),
    );

    await expect(
      searchService.search(testUri(process.cwd()), "", {
        maxOutputBytes: 1,
        cancellationSignal: cancellationController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
