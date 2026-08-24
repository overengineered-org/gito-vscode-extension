import type * as vscode from "vscode";
import * as nodePath from "node:path";
import {
  isAbortError,
  type GitCommandOutput,
} from "../git/gitCommandRunner.js";
import {
  parseCommitNameStatus,
  parseCommitSummaryRecords,
} from "../git/gitHistoryService.js";
import {
  filterSearchDocuments,
  parseSearchQuery,
  searchDocumentMatches,
  type SearchDocument,
  type SearchQuery,
  type SearchQueryOptions,
} from "./searchDsl.js";
import {
  CompareRequestError,
  CompareService,
  assertSafeCompareRelativePath,
  type CompareRepositoryBinding,
} from "./compareService.js";
import { takeUtf8Prefix } from "../git/utf8.js";

export interface SearchOptions extends SearchQueryOptions {
  readonly pageIndex?: number;
  readonly pageSize?: number;
  /** Hard upper bound on documents scanned for one request. */
  readonly maxResults?: number;
  /** Maximum bytes retained from each Git metadata/patch stream. */
  readonly maxOutputBytes?: number;
  readonly cancellationSignal?: AbortSignal;
}

export interface SearchPage {
  readonly query: SearchQuery;
  readonly items: readonly SearchDocument[];
  /** Alias useful to callers displaying commit search results. */
  readonly commits: readonly SearchDocument[];
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
  readonly nextPageIndex?: number;
  readonly totalMatched: number;
  readonly reachedSafetyCap: boolean;
}

export const defaultSearchOptions = {
  pageIndex: 0,
  pageSize: 100,
  maxResults: 10_000,
  maxOutputBytes: 16 * 1024 * 1024,
} as const;

/** Structured, local-only Git history search with deterministic paging. */
export class GitSearchService {
  public constructor(private readonly compareService: CompareService) {}

  public async search(
    repositoryRoot: vscode.Uri,
    source: string | SearchQuery,
    options: SearchOptions = {},
  ): Promise<SearchPage> {
    const query =
      typeof source === "string" ? parseSearchQuery(source, options) : source;
    const pageIndex = options.pageIndex ?? defaultSearchOptions.pageIndex;
    const pageSize = options.pageSize ?? defaultSearchOptions.pageSize;
    const maxResults = options.maxResults ?? defaultSearchOptions.maxResults;
    const maxOutputBytes =
      options.maxOutputBytes ?? defaultSearchOptions.maxOutputBytes;
    assertPageOptions(pageIndex, pageSize, maxResults, maxOutputBytes);
    const repositoryRootBinding =
      await this.compareService.pinRepositoryBinding(
        repositoryRoot,
        options.cancellationSignal,
      );
    const candidateSummaries: SearchDocument[] = [];
    const seenCommitShas = new Set<string>();
    const scanPageSize = 100;
    let skipCount = 0;
    let scannedCount = 0;
    let historyHasMore = false;
    let metadataOutputTruncated = false;
    let repeatedPageDetected = false;
    const needsFiles = query.clauses.some((clause) => clause.field === "file");
    const needsPatch = query.clauses.some((clause) => clause.field === "patch");
    const nativeMessageFilterArguments =
      createNativeMessageFilterArguments(query);
    while (scannedCount < maxResults) {
      if (options.cancellationSignal?.aborted) throw cancelledSearchError();
      const requestedCount =
        Math.min(scanPageSize, maxResults - scannedCount) + 1;
      const summaryOutput = await this.runBoundedGit(
        repositoryRoot,
        [
          "log",
          "--all",
          "--date-order",
          "--date=iso-strict",
          ...nativeMessageFilterArguments,
          `--max-count=${requestedCount}`,
          `--skip=${skipCount}`,
          `--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%D%x01`,
        ],
        // A tiny patch cap must not truncate the commit-summary delimiter
        // before one candidate can be parsed. Patch/body streams are capped
        // independently below.
        Math.max(maxOutputBytes, 4 * 1024),
        options.cancellationSignal,
        repositoryRootBinding,
      );
      metadataOutputTruncated ||= summaryOutput.truncated;
      const pageSummaries = parseCommitSummaryRecords(
        discardIncompleteRecord(summaryOutput.standardOutput, "\x01"),
      );
      if (pageSummaries.length === 0) break;
      const unseenSummaries = pageSummaries.filter((summary) => {
        if (seenCommitShas.has(summary.commitSha)) return false;
        seenCommitShas.add(summary.commitSha);
        return true;
      });
      // Never retry the same Git page forever when a provider returns a stale
      // or repeated page. A real Git log always advances with --skip.
      if (unseenSummaries.length === 0) {
        repeatedPageDetected = true;
        historyHasMore = true;
        break;
      }
      for (const summary of unseenSummaries) {
        if (scannedCount >= maxResults) break;
        if (options.cancellationSignal?.aborted) throw cancelledSearchError();
        const filesResult = needsFiles
          ? await this.getCommitFiles(
              repositoryRoot,
              summary.commitSha,
              maxOutputBytes,
              options.cancellationSignal,
              repositoryRootBinding,
            )
          : { files: [], truncated: false };
        const patchResult = needsPatch
          ? await this.getCommitPatch(
              repositoryRoot,
              summary.commitSha,
              maxOutputBytes,
              options.cancellationSignal,
              repositoryRootBinding,
            )
          : { patch: undefined, truncated: false };
        const bodyResult = query.clauses.some(
          (clause) => clause.field === "message",
        )
          ? await this.getCommitBody(
              repositoryRoot,
              summary.commitSha,
              maxOutputBytes,
              options.cancellationSignal,
              repositoryRootBinding,
            )
          : { body: undefined, truncated: false };
        candidateSummaries.push({
          ...summary,
          files: filesResult.files,
          ...(bodyResult.body === undefined ? {} : { body: bodyResult.body }),
          ...(patchResult.patch === undefined
            ? {}
            : { patch: patchResult.patch }),
        });
        if (
          filesResult.truncated ||
          patchResult.truncated ||
          bodyResult.truncated
        )
          metadataOutputTruncated = true;
        scannedCount += 1;
      }
      skipCount += pageSummaries.length;
      historyHasMore = pageSummaries.length >= requestedCount;
      if (summaryOutput.truncated || pageSummaries.length < requestedCount) {
        historyHasMore = summaryOutput.truncated;
        break;
      }
    }
    await this.compareService.assertPinnedRepositoryRoot(
      repositoryRoot,
      repositoryRootBinding,
    );
    const sortedDocuments = [...candidateSummaries].sort(
      compareDocumentsByStableOrder,
    );
    const matchingDocuments = filterSearchDocuments(
      sortedDocuments,
      query,
      options.cancellationSignal,
    );
    const reachedSafetyCap =
      metadataOutputTruncated ||
      repeatedPageDetected ||
      (scannedCount >= maxResults &&
        (historyHasMore || seenCommitShas.size > scannedCount));
    const start = pageIndex * pageSize;
    const pageItems = matchingDocuments.slice(start, start + pageSize);
    // A continuation exists only when this page is full. This prevents a
    // safety cap from manufacturing an empty "next page" after a partial
    // final page (or after a caller asks beyond the end).
    // A safety cap is a truthful stop: this request has no resumable cursor
    // or immutable snapshot, so advertising another page would repeat data or
    // manufacture an empty continuation.
    const hasMore =
      !reachedSafetyCap &&
      pageItems.length === pageSize &&
      start + pageItems.length < matchingDocuments.length;
    return {
      query,
      items: pageItems,
      commits: pageItems,
      pageIndex,
      pageSize,
      hasMore,
      ...(hasMore ? { nextPageIndex: pageIndex + 1 } : {}),
      totalMatched: matchingDocuments.length,
      reachedSafetyCap,
    };
  }

  /** Pure evaluator entry point for callers that already loaded commit records. */
  public filterLoadedDocuments(
    documents: readonly SearchDocument[],
    source: string | SearchQuery,
    options: SearchQueryOptions = {},
  ): readonly SearchDocument[] {
    const query =
      typeof source === "string" ? parseSearchQuery(source, options) : source;
    return documents.filter((document) =>
      searchDocumentMatches(document, query, options.cancellationSignal),
    );
  }

  private async getCommitFiles(
    repositoryRoot: vscode.Uri,
    commitSha: string,
    maxOutputBytes: number,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<{
    readonly files: readonly {
      readonly path: string;
      readonly previousPath?: string;
      readonly status: string;
    }[];
    readonly truncated: boolean;
  }> {
    const output = await this.runBoundedGit(
      repositoryRoot,
      [
        "show",
        "--no-ext-diff",
        "--find-renames",
        "--find-copies",
        "--format=",
        "--name-status",
        "-z",
        commitSha,
      ],
      maxOutputBytes,
      cancellationSignal,
      repositoryRootBinding,
    );
    return {
      files: parseCommitNameStatus(output.standardOutput).map((file) => {
        assertSafeCompareRelativePath(file.path);
        if (file.previousPath !== undefined) {
          assertSafeCompareRelativePath(file.previousPath);
        }
        return {
          path: file.path,
          ...(file.previousPath === undefined
            ? {}
            : { previousPath: file.previousPath }),
          status: file.changeType === "binary" ? "modified" : file.changeType,
        };
      }),
      truncated: output.truncated,
    };
  }

  private async getCommitBody(
    repositoryRoot: vscode.Uri,
    commitSha: string,
    maxOutputBytes: number,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<{ readonly body: string; readonly truncated: boolean }> {
    const output = await this.runBoundedGit(
      repositoryRoot,
      ["show", "--format=%B", "--no-patch", commitSha],
      maxOutputBytes,
      cancellationSignal,
      repositoryRootBinding,
    );
    return {
      body: output.standardOutput.trimEnd(),
      truncated: output.truncated,
    };
  }

  private async getCommitPatch(
    repositoryRoot: vscode.Uri,
    commitSha: string,
    maxOutputBytes: number,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<{ readonly patch: string; readonly truncated: boolean }> {
    assertSearchRepositoryPathMatchesBinding(
      repositoryRoot,
      repositoryRootBinding,
    );
    const boundedController = new AbortController();
    const abortBoundedPatch = (): void => boundedController.abort();
    if (cancellationSignal?.aborted) throw cancelledSearchError();
    cancellationSignal?.addEventListener("abort", abortBoundedPatch, {
      once: true,
    });
    let patchBytes = 0;
    let truncated = false;
    const patchChunks: string[] = [];
    try {
      const output = await this.compareService.runStreaming(
        repositoryRoot,
        [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--format=",
          "--patch",
          "--binary",
          commitSha,
        ],
        boundedController.signal,
        repositoryRootBinding,
        (chunk) => {
          if (truncated) return;
          const remainingBytes = maxOutputBytes - patchBytes;
          const chunkBytes = Buffer.byteLength(chunk, "utf8");
          if (chunkBytes <= remainingBytes) {
            patchChunks.push(chunk);
            patchBytes += chunkBytes;
            return;
          }
          const boundedChunk = takeUtf8Prefix(chunk, remainingBytes);
          if (boundedChunk.length > 0) patchChunks.push(boundedChunk);
          truncated = true;
          boundedController.abort();
        },
      );
      truncated ||= isGitOutputTruncated(output);
      return {
        patch: patchChunks.join(""),
        truncated,
      };
    } catch (error: unknown) {
      if (cancellationSignal?.aborted) throw cancelledSearchError();
      if (!truncated || !isAbortError(error)) throw error;
      return { patch: patchChunks.join(""), truncated: true };
    } finally {
      cancellationSignal?.removeEventListener("abort", abortBoundedPatch);
    }
  }

  private async runBoundedGit(
    repositoryRoot: vscode.Uri,
    argumentsPassed: readonly string[],
    maxOutputBytes: number,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<{ readonly standardOutput: string; readonly truncated: boolean }> {
    assertSearchRepositoryPathMatchesBinding(
      repositoryRoot,
      repositoryRootBinding,
    );
    const boundedController = new AbortController();
    const abortBoundedCommand = (): void => boundedController.abort();
    if (cancellationSignal?.aborted) throw cancelledSearchError();
    cancellationSignal?.addEventListener("abort", abortBoundedCommand, {
      once: true,
    });
    const outputChunks: string[] = [];
    let outputBytes = 0;
    let truncated = false;
    try {
      const output = await this.compareService.runStreaming(
        repositoryRoot,
        argumentsPassed,
        boundedController.signal,
        repositoryRootBinding,
        (chunk) => {
          if (truncated) return;
          const remainingBytes = maxOutputBytes - outputBytes;
          const chunkBytes = Buffer.byteLength(chunk, "utf8");
          if (chunkBytes <= remainingBytes) {
            outputChunks.push(chunk);
            outputBytes += chunkBytes;
            return;
          }
          const boundedChunk = takeUtf8Prefix(chunk, remainingBytes);
          if (boundedChunk.length > 0) outputChunks.push(boundedChunk);
          truncated = true;
          boundedController.abort();
        },
      );
      truncated ||= isGitOutputTruncated(output);
      return {
        standardOutput: outputChunks.join(""),
        truncated,
      };
    } catch (error: unknown) {
      if (cancellationSignal?.aborted) throw cancelledSearchError();
      if (!truncated || !isAbortError(error)) throw error;
      return { standardOutput: outputChunks.join(""), truncated: true };
    } finally {
      cancellationSignal?.removeEventListener("abort", abortBoundedCommand);
    }
  }
}

function compareDocumentsByStableOrder(
  left: { readonly commitDate?: string; readonly commitSha: string },
  right: { readonly commitDate?: string; readonly commitSha: string },
): number {
  const leftDate = left.commitDate ?? "";
  const rightDate = right.commitDate ?? "";
  const leftTimestamp = Date.parse(leftDate);
  const rightTimestamp = Date.parse(rightDate);
  const dateOrder =
    Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)
      ? rightTimestamp - leftTimestamp
      : rightDate.localeCompare(leftDate);
  return dateOrder !== 0
    ? dateOrder
    : left.commitSha.localeCompare(right.commitSha);
}

function isGitOutputTruncated(output: GitCommandOutput): boolean {
  return (
    output.standardOutputTruncated === true ||
    output.standardErrorTruncated === true
  );
}

function assertSearchRepositoryPathMatchesBinding(
  repositoryRoot: vscode.Uri,
  repositoryRootBinding: CompareRepositoryBinding,
): void {
  if (
    nodePath.resolve(repositoryRoot.fsPath) !==
    repositoryRootBinding.requestedPath
  ) {
    throw new CompareRequestError(
      "Compare repository binding does not match the requested repository.",
    );
  }
}

function assertPageOptions(
  pageIndex: number,
  pageSize: number,
  maxResults: number,
  maxOutputBytes: number,
): void {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new CompareRequestError("pageIndex must be a non-negative integer.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new CompareRequestError("pageSize must be a positive integer.");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new CompareRequestError("maxResults must be a positive integer.");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new CompareRequestError("maxOutputBytes must be a positive integer.");
  }
}

function cancelledSearchError(): DOMException {
  return new DOMException("Search request cancelled", "AbortError");
}

function discardIncompleteRecord(output: string, separator: string): string {
  if (output.length === 0 || output.endsWith(separator)) return output;
  const finalSeparator = output.lastIndexOf(separator);
  return finalSeparator < 0 ? "" : output.slice(0, finalSeparator + 1);
}

/**
 * Let Git discard non-matching commit messages before the per-commit body
 * fetch. This is safe only for one literal contains clause: other query
 * shapes have DSL semantics Git cannot reproduce exactly.
 */
function createNativeMessageFilterArguments(
  query: SearchQuery,
): readonly string[] {
  if (query.regex || query.clauses.length !== 1) return [];
  const clause = query.clauses[0];
  if (
    clause === undefined ||
    clause.field !== "message" ||
    clause.operator !== "contains" ||
    clause.value.length === 0 ||
    clause.value.includes("\0")
  ) {
    return [];
  }
  return [
    `--grep=${clause.value}`,
    "--fixed-strings",
    ...(query.matchCase ? [] : ["--regexp-ignore-case"]),
  ];
}

export { parseSearchQuery, searchDocumentMatches };
