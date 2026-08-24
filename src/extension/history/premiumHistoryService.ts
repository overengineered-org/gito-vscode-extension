import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  isAbortError,
  GitCommandFailure,
  type GitCommandOutput,
  type GitCommandRequest,
  type GitCommandRunner,
  type GitRootBindingIdentity,
} from "../git/gitCommandRunner.js";
import type { GitRootBindingResolver } from "../git/gitRootBindingResolver.js";
import { parseCommitFileChanges } from "../git/gitHistoryService.js";
import {
  HISTORY_METADATA_FORMAT,
  HISTORY_RECORD_SEPARATOR,
  parseBlamePorcelain,
  parseNameStatusRecords,
  parseHistoryRecord,
  parseHistoryRecords,
} from "./historyParsing.js";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  HISTORY_QUERY_SAFETY_CAP,
  type BlameLine,
  type BlameOptions,
  type ContributorSummary,
  type ContributorsSnapshot,
  type FileHistoryEntry,
  type FileHistoryPage,
  type HistoryContinuationCursor,
  type GitRevisionResource,
  type HistoryCommit,
  type HistoryFileChange,
  type HistoryPage,
  type HistoryQuery,
  type HistoryQueryField,
  type HistoryQueryMatch,
  type HistoryQueryResult,
  type HistoryRepositoryRoot,
  type HistoryScopeOptions,
  type LineHistoryEntry,
  type NativeDiffPlan,
  type RevisionNavigationPlan,
  type RevisionParent,
} from "./historyTypes.js";

interface PinnedHistoryRepositoryRoot {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly repositoryRootIdentity: string;
  readonly rootBinding: GitRootBindingIdentity;
}

type HistoryRepositoryRootBinding =
  HistoryRepositoryRoot | PinnedHistoryRepositoryRoot;

export class HistoryRepositoryRootChangedError extends Error {
  public constructor(message = "The history repository root changed.") {
    super(message);
    this.name = "HistoryRepositoryRootChangedError";
  }
}

export class HistoryOutputTruncatedError extends Error {
  public constructor(operation: string) {
    super(`Git ${operation} output exceeded the safe memory limit.`);
    this.name = "HistoryOutputTruncatedError";
  }
}

export class PremiumHistoryService {
  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly rootBindingResolver: GitRootBindingResolver,
  ) {}

  public async getRevisionResource(
    repositoryRoot: HistoryRepositoryRoot,
    revisionSha: string,
    filePath: string,
    cancellationSignal?: AbortSignal,
  ): Promise<GitRevisionResource | undefined> {
    try {
      assertRevisionSelector(revisionSha, "revisionSha");
      const normalizedFilePath = normalizeRelativePath(filePath);
      const pinnedRoot = await pinHistoryRepositoryRoot(
        repositoryRoot,
        this.rootBindingResolver,
        cancellationSignal,
      );
      await this.getCommit(pinnedRoot, revisionSha, cancellationSignal);
      await assertPinnedHistoryRepositoryRoot(
        pinnedRoot,
        this.rootBindingResolver,
        cancellationSignal,
      );
      return createRevisionResource(
        pinnedRoot,
        revisionSha,
        normalizedFilePath,
      );
    } catch {
      return undefined;
    }
  }

  public async hasRevision(
    repositoryRoot: HistoryRepositoryRoot,
    revisionSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      assertRevisionSelector(revisionSha, "revisionSha");
      const pinnedRoot = await pinHistoryRepositoryRoot(
        repositoryRoot,
        this.rootBindingResolver,
        cancellationSignal,
      );
      await this.getCommit(pinnedRoot, revisionSha, cancellationSignal);
      return true;
    } catch {
      return false;
    }
  }

  public async listRepositoryHistory(
    repositoryRoot: HistoryRepositoryRoot,
    options: HistoryScopeOptions = {},
  ): Promise<HistoryPage> {
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      options.cancellationSignal,
    );
    return this.listCommitHistory(pinnedRoot, {
      ...options,
      includeAllRefs: true,
    });
  }

  public async listBranchHistory(
    repositoryRoot: HistoryRepositoryRoot,
    branchName: string,
    options: HistoryScopeOptions = {},
  ): Promise<HistoryPage> {
    assertRevisionSelector(branchName, "branchName");
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      options.cancellationSignal,
    );
    return this.listCommitHistory(pinnedRoot, {
      ...options,
      revision: branchName,
    });
  }

  public async listFileHistory(
    repositoryRoot: HistoryRepositoryRoot,
    filePath: string,
    options: HistoryScopeOptions = {},
  ): Promise<FileHistoryPage> {
    const normalizedFilePath = normalizeRelativePath(filePath);
    const maxEntries = normalizeLimit(options.maxEntries);
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      options.cancellationSignal,
    );
    return this.listFileHistoryWithPinnedRoot(
      pinnedRoot,
      normalizedFilePath,
      options,
      maxEntries,
    );
  }

  private async listFileHistoryWithPinnedRoot(
    pinnedRoot: PinnedHistoryRepositoryRoot,
    normalizedFilePath: string,
    options: HistoryScopeOptions,
    maxEntries: number,
  ): Promise<FileHistoryPage> {
    const cursor = decodeHistoryContinuationCursor(
      options.cursor,
      "file-history",
      historyCursorScope(
        pinnedRoot.repositoryRootIdentity,
        "file-history",
        options.revision,
        normalizedFilePath,
      ),
    );
    const gitPath = cursor?.trackedPath ?? normalizedFilePath;
    const fileHistoryRevision = cursor?.revisionBoundary ?? options.revision;
    const commandArguments = createLogArguments(maxEntries, {
      ...(fileHistoryRevision === undefined
        ? {}
        : { revision: fileHistoryRevision }),
      includeAllRefs: false,
      includeNameStatus: true,
      followRenames: true,
      path: gitPath,
    });
    const commandOutput = await this.runGit(pinnedRoot, {
      arguments: commandArguments,
      cancellationSignal: options.cancellationSignal,
    });
    const numstatOutput = await this.runGit(pinnedRoot, {
      arguments: createLogArguments(maxEntries, {
        ...(fileHistoryRevision === undefined
          ? {}
          : { revision: fileHistoryRevision }),
        includeAllRefs: false,
        includeNumstat: true,
        followRenames: true,
        path: gitPath,
      }),
      cancellationSignal: options.cancellationSignal,
    });
    const commits = mergeHistoryCommits(
      parseHistoryRecordsWithFileChanges(
        commandOutput.standardOutput,
        parseCommitFileChangesFromNameStatus,
      ),
      parseHistoryRecordsWithFileChanges(
        numstatOutput.standardOutput,
        parseCommitFileChangesFromNumstat,
      ),
    );
    let trackedPath = gitPath;
    const entries = commits.slice(0, maxEntries).map((commit) => {
      const pathChange = findPathChange(commit.changedFiles, trackedPath);
      const entryPath = pathChange?.path ?? trackedPath;
      const entry = {
        ...commit,
        path: entryPath,
        ...(pathChange?.previousPath === undefined
          ? {}
          : { previousPath: pathChange.previousPath }),
      } satisfies FileHistoryEntry;
      trackedPath = pathChange?.previousPath ?? entryPath;
      return entry;
    });
    const outputTruncated =
      commandOutput.standardOutputTruncated === true ||
      numstatOutput.standardOutputTruncated === true;
    const hasMore = !outputTruncated && commits.length > maxEntries;
    const nextTrackedPath = trackedPath;
    const lastEntrySha = entries.at(-1)?.sha;
    const nextCursor = hasMore
      ? encodeHistoryContinuationCursor({
          kind: "file-history",
          offset: (cursor?.offset ?? 0) + entries.length,
          scope: historyCursorScope(
            pinnedRoot.repositoryRootIdentity,
            "file-history",
            options.revision,
            normalizedFilePath,
          ),
          trackedPath: nextTrackedPath,
          ...(lastEntrySha === undefined
            ? {}
            : { revisionBoundary: `${lastEntrySha}^` }),
        })
      : undefined;
    return {
      entries,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      reachedSafetyCap:
        outputTruncated || (hasMore && maxEntries >= HISTORY_QUERY_SAFETY_CAP),
      ...(outputTruncated ? { truncated: true } : {}),
    };
  }

  public async listLineHistory(
    repositoryRoot: HistoryRepositoryRoot,
    filePath: string,
    lineNumber: number,
    options: HistoryScopeOptions = {},
  ): Promise<readonly LineHistoryEntry[]> {
    assertLineNumber(lineNumber);
    const normalizedFilePath = normalizeRelativePath(filePath);
    const maxEntries = normalizeLimit(options.maxEntries);
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      options.cancellationSignal,
    );
    const lineSelector = `${lineNumber},${lineNumber}:${normalizedFilePath}`;
    const commandArguments = [
      "log",
      "--no-ext-diff",
      "--date=iso-strict",
      `--max-count=${maxEntries + 1}`,
      `--format=${HISTORY_METADATA_FORMAT}`,
      "-L",
      lineSelector,
      ...(options.revision === undefined
        ? []
        : [assertRevisionSelector(options.revision, "revision")]),
    ];
    const commandOutput = await this.runGit(pinnedRoot, {
      arguments: commandArguments,
      cancellationSignal: options.cancellationSignal,
    });
    assertCompleteHistoryOutput(commandOutput, "line history");
    const lineHistoryCommits = parseHistoryRecords(
      commandOutput.standardOutput,
      false,
    ).slice(0, maxEntries);
    if (lineHistoryCommits.length === 0) return [];
    const fileHistory = await this.listFileHistoryWithPinnedRoot(
      pinnedRoot,
      normalizedFilePath,
      options,
      maxEntries,
    );
    if (fileHistory.truncated)
      throw new HistoryOutputTruncatedError("line history metadata");
    const pathByCommitSha = new Map(
      fileHistory.entries.map((entry) => [entry.sha, entry.path]),
    );
    return lineHistoryCommits.map((commit): LineHistoryEntry => ({
      ...commit,
      path: pathByCommitSha.get(commit.sha) ?? normalizedFilePath,
      lineNumber,
    }));
  }

  public async getBlame(
    repositoryRoot: HistoryRepositoryRoot,
    filePath: string,
    options: BlameOptions = {},
  ): Promise<readonly BlameLine[]> {
    const normalizedFilePath = normalizeRelativePath(filePath);
    const blameRange = options.range;
    if (blameRange !== undefined) validateBlameRange(blameRange);
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      options.cancellationSignal,
    );
    const commandArguments = [
      "blame",
      "--line-porcelain",
      "-M1",
      "-C",
      ...(options.revision === undefined
        ? []
        : [assertRevisionSelector(options.revision, "revision")]),
      ...(blameRange === undefined
        ? []
        : ["-L", `${blameRange.startLine},${blameRange.endLine}`]),
      "--",
      normalizedFilePath,
    ];
    const commandOutput = await this.runGit(pinnedRoot, {
      arguments: commandArguments,
      cancellationSignal: options.cancellationSignal,
    });
    assertCompleteHistoryOutput(commandOutput, "blame");
    const parsedLines = parseBlamePorcelain(commandOutput.standardOutput);
    if (blameRange === undefined) return parsedLines;
    return parsedLines.filter(
      (line) =>
        line.lineNumber >= blameRange.startLine &&
        line.lineNumber <= blameRange.endLine,
    );
  }

  public async aggregateContributors(
    repositoryRoot: HistoryRepositoryRoot,
    options: HistoryScopeOptions = {},
  ): Promise<ContributorsSnapshot> {
    const maxEntries = Math.min(
      normalizeLimit(options.maxEntries ?? HISTORY_QUERY_SAFETY_CAP),
      HISTORY_QUERY_SAFETY_CAP,
    );
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      options.cancellationSignal,
    );
    const historyPage = await this.listCommitHistory(pinnedRoot, {
      ...options,
      maxEntries,
      includeAllRefs: options.revision === undefined,
    });
    const contributorByEmail = new Map<string, ContributorSummary>();
    for (const commit of historyPage.commits) {
      const identityKey = commit.authorEmail.toLowerCase();
      const currentSummary = contributorByEmail.get(identityKey);
      if (currentSummary === undefined) {
        contributorByEmail.set(identityKey, {
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          commitCount: 1,
          firstAuthorDate: commit.authorDate,
          lastAuthorDate: commit.authorDate,
        });
        continue;
      }
      contributorByEmail.set(identityKey, {
        ...currentSummary,
        commitCount: currentSummary.commitCount + 1,
        firstAuthorDate: earlierHistoryDate(
          commit.authorDate,
          currentSummary.firstAuthorDate,
        ),
        lastAuthorDate: laterHistoryDate(
          commit.authorDate,
          currentSummary.lastAuthorDate,
        ),
      });
    }
    return {
      contributors: [...contributorByEmail.values()].sort(
        compareContributorSummaries,
      ),
      examinedCommitCount: historyPage.commits.length,
      reachedSafetyCap: historyPage.reachedSafetyCap,
      ...(historyPage.truncated ? { truncated: true } : {}),
    };
  }

  public async search(
    repositoryRoot: HistoryRepositoryRoot,
    query: HistoryQuery,
    cancellationSignal?: AbortSignal,
  ): Promise<HistoryQueryResult> {
    const normalizedQuery = normalizeHistoryQuery(query);
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      cancellationSignal,
    );
    const queryScope = historyCursorScope(
      pinnedRoot.repositoryRootIdentity,
      "search",
      normalizedQuery.revision,
      normalizedQuery.filePath,
      normalizedQuery,
    );
    const cursor = decodeHistoryContinuationCursor(
      normalizedQuery.cursor,
      "search",
      queryScope,
    );
    const scanOffset = cursor?.offset ?? 0;
    const commandArguments = createQueryArguments(
      normalizedQuery,
      "nameStatus",
      scanOffset,
    );
    const queryAbortController = new AbortController();
    const abortExternalQuery = (): void => queryAbortController.abort();
    if (cancellationSignal?.aborted) queryAbortController.abort();
    else {
      cancellationSignal?.addEventListener("abort", abortExternalQuery, {
        once: true,
      });
    }
    let pendingRecord = "";
    let examinedCommitCount = 0;
    let scanLimitReached = false;
    const candidateCommits: HistoryCommit[] = [];
    const processRecord = (record: string): void => {
      if (scanLimitReached || record.length === 0) return;
      const parsedCommit = parseHistoryRecord(record);
      if (parsedCommit === undefined) return;
      examinedCommitCount += 1;
      if (examinedCommitCount > historyQueryScanCap) {
        scanLimitReached = true;
        queryAbortController.abort();
        return;
      }
      candidateCommits.push(parsedCommit);
    };
    let streamingOutputWasTruncated = false;
    try {
      const streamingResult = await this.runGitStreaming(
        pinnedRoot,
        {
          arguments: commandArguments,
          cancellationSignal: queryAbortController.signal,
          collectStandardOutput: false,
          maxStandardOutputBytes: historyQueryOutputByteCap,
        },
        (chunk) => {
          if (scanLimitReached) return;
          pendingRecord += chunk;
          const completeRecords = pendingRecord.split(HISTORY_RECORD_SEPARATOR);
          pendingRecord = completeRecords.pop() ?? "";
          for (const completeRecord of completeRecords)
            processRecord(completeRecord);
        },
      );
      streamingOutputWasTruncated =
        streamingResult.standardOutputTruncated === true;
      if (!scanLimitReached && !streamingOutputWasTruncated)
        processRecord(pendingRecord);
    } catch (error: unknown) {
      if (!scanLimitReached || !isAbortError(error)) throw error;
    } finally {
      cancellationSignal?.removeEventListener("abort", abortExternalQuery);
    }
    let historyOutputWasTruncated = streamingOutputWasTruncated;
    if (
      candidateCommits.length > 0 &&
      normalizedQuery.terms.some((term) => term.field === "file")
    ) {
      const numstatOutput = await this.runGit(pinnedRoot, {
        arguments: createQueryArguments(normalizedQuery, "numstat", scanOffset),
        cancellationSignal: cancellationSignal,
      });
      historyOutputWasTruncated ||=
        numstatOutput.standardOutputTruncated === true;
      const mergedCommits = mergeHistoryCommits(
        candidateCommits,
        parseHistoryRecordsWithFileChanges(
          numstatOutput.standardOutput,
          parseCommitFileChangesFromNumstat,
        ),
      );
      const mergedCommitBySha = new Map(
        mergedCommits.map((commit) => [commit.sha, commit]),
      );
      for (let index = 0; index < candidateCommits.length; index += 1) {
        const candidateCommit = candidateCommits[index];
        if (candidateCommit === undefined) continue;
        candidateCommits[index] =
          mergedCommitBySha.get(candidateCommit.sha) ?? candidateCommit;
      }
    }
    const patchTerms = normalizedQuery.terms.filter(
      (term) => term.field === "patch",
    );
    const matches: HistoryQueryMatch[] = [];
    let patchResultsIncomplete = false;
    let remainingPatchProbeBytes = historyPatchAggregateOutputByteCap;
    let resultLimitReached = false;
    let resultContinuationOffset: number | undefined;
    for (let index = 0; index < candidateCommits.length; index += 1) {
      const commit = candidateCommits[index];
      if (commit === undefined) continue;
      if (patchTerms.length > 0 && remainingPatchProbeBytes <= 0) {
        patchResultsIncomplete = true;
        break;
      }
      const patchResult =
        patchTerms.length === 0
          ? undefined
          : await this.readCommitPatch(
              pinnedRoot,
              commit.sha,
              normalizedQuery.filePath,
              cancellationSignal,
              Math.min(historyPatchOutputByteCap, remainingPatchProbeBytes),
            );
      const patchText = patchResult?.text;
      if (patchResult !== undefined) {
        remainingPatchProbeBytes -= patchResult.bytesRead;
        patchResultsIncomplete ||= patchResult.truncated;
      }
      const matchingFields = matchingQueryFields(
        commit,
        normalizedQuery,
        patchText,
      );
      if (matchingFields.length === 0 && normalizedQuery.terms.length > 0) {
        continue;
      }
      if (matches.length >= normalizedQuery.limit) {
        resultLimitReached = true;
        resultContinuationOffset = scanOffset + index + 1;
        break;
      }
      matches.push({
        ...commit,
        matchingFields,
        ...(patchText === undefined ? {} : { patchText }),
      });
    }
    const outputBounded = historyOutputWasTruncated || patchResultsIncomplete;
    const hasMore = !outputBounded && (resultLimitReached || scanLimitReached);
    const nextCursor = hasMore
      ? encodeHistoryContinuationCursor({
          kind: "search",
          offset: resultContinuationOffset ?? scanOffset + historyQueryScanCap,
          scope: queryScope,
        })
      : undefined;
    return {
      matches,
      examinedCommitCount,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      reachedSafetyCap:
        scanLimitReached || patchResultsIncomplete || historyOutputWasTruncated,
      ...(historyOutputWasTruncated ? { truncated: true } : {}),
      ...(patchResultsIncomplete ? { patchResultsIncomplete: true } : {}),
    };
  }

  public async getRevisionNavigation(
    repositoryRoot: HistoryRepositoryRoot,
    revisionSha: string,
    filePath: string,
    parentSha?: string,
    cancellationSignal?: AbortSignal,
  ): Promise<RevisionNavigationPlan> {
    assertRevisionSelector(revisionSha, "revisionSha");
    const normalizedFilePath = normalizeRelativePath(filePath);
    const pinnedRoot = await pinHistoryRepositoryRoot(
      repositoryRoot,
      this.rootBindingResolver,
      cancellationSignal,
    );
    const commit = await this.getCommit(
      pinnedRoot,
      revisionSha,
      cancellationSignal,
    );
    const parents = commit.parentShas.map((sha, index): RevisionParent => ({
      sha,
      index,
    }));
    const selectedParent = selectParent(parents, parentSha);
    const fileHistory = await this.listFileHistoryWithPinnedRoot(
      pinnedRoot,
      normalizedFilePath,
      {
        revision: revisionSha,
        maxEntries: HISTORY_QUERY_SAFETY_CAP,
        ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
      },
      HISTORY_QUERY_SAFETY_CAP,
    );
    if (fileHistory.truncated)
      throw new HistoryOutputTruncatedError("revision file history");
    const currentHistoryIndex = fileHistory.entries.findIndex(
      (entry) => entry.sha === commit.sha,
    );
    const currentPath =
      currentHistoryIndex < 0
        ? normalizedFilePath
        : (fileHistory.entries[currentHistoryIndex]?.path ??
          normalizedFilePath);
    const previousEntry =
      currentHistoryIndex < 0
        ? undefined
        : fileHistory.entries[currentHistoryIndex + 1];
    const nextEntry =
      currentHistoryIndex <= 0
        ? undefined
        : fileHistory.entries[currentHistoryIndex - 1];
    const selectedParentPath =
      selectedParent === undefined
        ? undefined
        : await this.resolveParentPath(
            pinnedRoot,
            commit.sha,
            selectedParent.sha,
            currentPath,
            cancellationSignal,
          );
    const current = createRevisionResource(pinnedRoot, commit.sha, currentPath);
    const previousRevision =
      selectedParent === undefined
        ? previousEntry === undefined
          ? undefined
          : createRevisionResource(
              pinnedRoot,
              previousEntry.sha,
              previousEntry.path,
            )
        : selectedParentPath === undefined
          ? undefined
          : createRevisionResource(
              pinnedRoot,
              selectedParent.sha,
              selectedParentPath,
            );
    const nextRevision =
      nextEntry === undefined ||
      !(await this.isGitAncestor(
        pinnedRoot,
        commit.sha,
        nextEntry.sha,
        cancellationSignal,
      ))
        ? undefined
        : createRevisionResource(pinnedRoot, nextEntry.sha, nextEntry.path);
    return {
      current,
      currentCommit: commit,
      parents,
      ...(selectedParent === undefined ? {} : { selectedParent }),
      ...(previousRevision === undefined ? {} : { previousRevision }),
      ...(nextRevision === undefined ? {} : { nextRevision }),
      ...(previousRevision === undefined
        ? {}
        : {
            previousDiff: createDiffPlan(
              previousRevision,
              current,
              "Previous revision",
            ),
          }),
      ...(nextRevision === undefined
        ? {}
        : {
            nextDiff: createDiffPlan(current, nextRevision, "Next revision"),
          }),
    };
  }

  private async listCommitHistory(
    repositoryRoot: PinnedHistoryRepositoryRoot,
    options: HistoryScopeOptions & {
      readonly includeAllRefs?: boolean;
      readonly includeNameStatus?: boolean;
      readonly includeNumstat?: boolean;
      readonly followRenames?: boolean;
      readonly path?: string;
    },
  ): Promise<HistoryPage> {
    const maxEntries = normalizeLimit(options.maxEntries);
    const historyScope = historyCursorScope(
      repositoryRoot.repositoryRootIdentity,
      "history",
      options.revision,
      options.path,
    );
    const cursor = decodeHistoryContinuationCursor(
      options.cursor,
      "history",
      historyScope,
    );
    const nameStatusOutput = await this.runGit(repositoryRoot, {
      arguments: createLogArguments(maxEntries, {
        ...options,
        includeNameStatus: true,
        includeNumstat: false,
        ...(cursor === undefined ? {} : { skipCount: cursor.offset }),
      }),
      cancellationSignal: options.cancellationSignal,
    });
    const numstatOutput = await this.runGit(repositoryRoot, {
      arguments: createLogArguments(maxEntries, {
        ...options,
        includeNameStatus: false,
        includeNumstat: true,
        ...(cursor === undefined ? {} : { skipCount: cursor.offset }),
      }),
      cancellationSignal: options.cancellationSignal,
    });
    const commits = mergeHistoryCommits(
      parseHistoryRecordsWithFileChanges(
        nameStatusOutput.standardOutput,
        parseCommitFileChangesFromNameStatus,
      ),
      parseHistoryRecordsWithFileChanges(
        numstatOutput.standardOutput,
        parseCommitFileChangesFromNumstat,
      ),
    );
    const outputTruncated =
      nameStatusOutput.standardOutputTruncated === true ||
      numstatOutput.standardOutputTruncated === true;
    const hasMore = !outputTruncated && commits.length > maxEntries;
    const nextCursor = hasMore
      ? encodeHistoryContinuationCursor({
          kind: "history",
          offset: (cursor?.offset ?? 0) + maxEntries,
          scope: historyScope,
        })
      : undefined;
    return {
      commits: commits.slice(0, maxEntries),
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      reachedSafetyCap:
        outputTruncated || (hasMore && maxEntries >= HISTORY_QUERY_SAFETY_CAP),
      ...(outputTruncated ? { truncated: true } : {}),
    };
  }

  private async getCommit(
    repositoryRoot: PinnedHistoryRepositoryRoot,
    revisionSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<HistoryCommit> {
    const commandOutput = await this.runGit(repositoryRoot, {
      arguments: [
        "show",
        "--no-ext-diff",
        "--no-patch",
        `--format=${HISTORY_METADATA_FORMAT}`,
        assertRevisionSelector(revisionSha, "revisionSha"),
      ],
      cancellationSignal,
    });
    assertCompleteHistoryOutput(commandOutput, "commit metadata");
    const commit = parseHistoryRecords(commandOutput.standardOutput)[0];
    if (commit === undefined)
      throw new Error("Git returned no revision metadata.");
    return commit;
  }

  private async readCommitPatch(
    repositoryRoot: PinnedHistoryRepositoryRoot,
    revisionSha: string,
    filePath: string | undefined,
    cancellationSignal?: AbortSignal,
    maxOutputBytes = historyPatchOutputByteCap,
  ): Promise<{
    readonly text: string;
    readonly bytesRead: number;
    readonly truncated: boolean;
  }> {
    const commandArguments = [
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--binary",
      "--format=",
      "--patch",
      assertRevisionSelector(revisionSha, "revisionSha"),
      ...(filePath === undefined
        ? []
        : ["--", normalizeRelativePath(filePath)]),
    ];
    const boundedController = new AbortController();
    const abortBoundedProbe = (): void => boundedController.abort();
    if (cancellationSignal?.aborted) {
      throw new DOMException("History query cancelled", "AbortError");
    }
    cancellationSignal?.addEventListener("abort", abortBoundedProbe, {
      once: true,
    });
    try {
      const commandOutput = await this.runGit(repositoryRoot, {
        arguments: commandArguments,
        cancellationSignal: boundedController.signal,
        maxStandardOutputBytes: maxOutputBytes,
      });
      const rawOutput = Buffer.from(commandOutput.standardOutput, "utf8");
      const boundedOutput = rawOutput
        .subarray(0, maxOutputBytes)
        .toString("utf8");
      const patchBytes = Buffer.byteLength(boundedOutput, "utf8");
      const truncated =
        commandOutput.standardOutputTruncated === true ||
        rawOutput.byteLength > maxOutputBytes;
      return {
        text: boundedOutput,
        bytesRead: patchBytes,
        truncated,
      };
    } finally {
      cancellationSignal?.removeEventListener("abort", abortBoundedProbe);
    }
  }

  private async resolveParentPath(
    repositoryRoot: PinnedHistoryRepositoryRoot,
    revisionSha: string,
    parentSha: string,
    currentPath: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const parentDiffOutput = await this.runGit(repositoryRoot, {
      arguments: [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "-M",
        "--name-status",
        "-z",
        assertRevisionSelector(parentSha, "parentSha"),
        assertRevisionSelector(revisionSha, "revisionSha"),
      ],
      cancellationSignal,
    });
    assertCompleteHistoryOutput(parentDiffOutput, "parent file status");
    const matchingChange = parseNameStatusRecords(
      parentDiffOutput.standardOutput,
    ).find(
      (change) =>
        change.path === currentPath || change.previousPath === currentPath,
    );
    const parentPath =
      matchingChange === undefined
        ? currentPath
        : (matchingChange.previousPath ?? matchingChange.path);
    const parentTreeOutput = await this.runGit(repositoryRoot, {
      arguments: [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        assertRevisionSelector(parentSha, "parentSha"),
        "--",
        parentPath,
      ],
      cancellationSignal,
    });
    assertCompleteHistoryOutput(parentTreeOutput, "parent file tree");
    return parentTreeOutput.standardOutput.split("\0").includes(parentPath)
      ? parentPath
      : undefined;
  }

  private async isGitAncestor(
    repositoryRoot: PinnedHistoryRepositoryRoot,
    ancestorSha: string,
    descendantSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.runGit(repositoryRoot, {
        arguments: [
          "merge-base",
          "--is-ancestor",
          assertRevisionSelector(ancestorSha, "ancestorSha"),
          assertRevisionSelector(descendantSha, "descendantSha"),
        ],
        cancellationSignal,
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof GitCommandFailure) return false;
      throw error;
    }
  }

  private async runGit(
    pinnedRoot: PinnedHistoryRepositoryRoot,
    request: Omit<GitCommandRequest, "repositoryRoot">,
  ): Promise<GitCommandOutput> {
    await assertPinnedHistoryRepositoryRoot(
      pinnedRoot,
      this.rootBindingResolver,
      request.cancellationSignal,
    );
    throwIfHistoryOperationCancelled(request.cancellationSignal);
    try {
      return await this.gitCommandRunner.run({
        ...request,
        repositoryRoot: pinnedRoot.canonicalPath,
        rootBinding: pinnedRoot.rootBinding,
        literalPathspecs: request.literalPathspecs ?? true,
        maxStandardOutputBytes:
          request.maxStandardOutputBytes ?? historyStandardOutputByteCap,
      });
    } finally {
      await assertPinnedHistoryRepositoryRoot(
        pinnedRoot,
        this.rootBindingResolver,
        request.cancellationSignal,
      );
    }
  }

  private async runGitStreaming(
    pinnedRoot: PinnedHistoryRepositoryRoot,
    request: Omit<GitCommandRequest, "repositoryRoot">,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    await assertPinnedHistoryRepositoryRoot(
      pinnedRoot,
      this.rootBindingResolver,
      request.cancellationSignal,
    );
    throwIfHistoryOperationCancelled(request.cancellationSignal);
    try {
      return await this.gitCommandRunner.runStreaming(
        {
          ...request,
          repositoryRoot: pinnedRoot.canonicalPath,
          rootBinding: pinnedRoot.rootBinding,
          literalPathspecs: request.literalPathspecs ?? true,
          maxStandardOutputBytes:
            request.maxStandardOutputBytes ?? historyStandardOutputByteCap,
        },
        onStandardOutputChunk,
      );
    } finally {
      await assertPinnedHistoryRepositoryRoot(
        pinnedRoot,
        this.rootBindingResolver,
        request.cancellationSignal,
      );
    }
  }
}

const historyStandardOutputByteCap = 64 * 1024 * 1024;
const historyQueryOutputByteCap = 64 * 1024 * 1024;
const historyPatchOutputByteCap = 8 * 1024 * 1024;
/** Aggregate cap across all patch probes in one history query. */
const historyPatchAggregateOutputByteCap = 64 * 1024 * 1024;
const historyQueryScanCap = HISTORY_QUERY_SAFETY_CAP;
const historyQueryResultLimitCap = HISTORY_QUERY_SAFETY_CAP;

type HistoryContinuationKind = "history" | "file-history" | "search";

interface DecodedHistoryContinuationCursor {
  readonly kind: HistoryContinuationKind;
  readonly offset: number;
  readonly scope: string;
  readonly trackedPath?: string;
  readonly revisionBoundary?: string;
}

function historyCursorScope(
  repositoryRootIdentity: string,
  kind: HistoryContinuationKind,
  revision?: string,
  filePath?: string,
  query?: HistoryQuery,
): string {
  const scopePayload = JSON.stringify({
    repositoryRootIdentity,
    kind,
    revision: revision ?? null,
    filePath: filePath ?? null,
    query:
      query === undefined
        ? null
        : {
            terms: query.terms,
            matchCase: query.matchCase ?? false,
            regex: query.regex ?? false,
            matchAll: query.matchAll ?? false,
          },
  });
  return createHash("sha256").update(scopePayload).digest("hex");
}

function encodeHistoryContinuationCursor(payload: {
  readonly kind: HistoryContinuationKind;
  readonly offset: number;
  readonly scope: string;
  readonly trackedPath?: string;
  readonly revisionBoundary?: string;
}): HistoryContinuationCursor {
  if (!Number.isSafeInteger(payload.offset) || payload.offset < 0)
    throw new RangeError("History continuation offset must be non-negative.");
  return Buffer.from(
    JSON.stringify({ version: 1, ...payload }),
    "utf8",
  ).toString("base64url");
}

function decodeHistoryContinuationCursor(
  cursor: HistoryContinuationCursor | undefined,
  expectedKind: HistoryContinuationKind,
  expectedScope: string,
): DecodedHistoryContinuationCursor | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 8192)
    throw new RangeError("History continuation cursor is too long.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RangeError("History continuation cursor is invalid.");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("version" in decoded) ||
    decoded.version !== 1 ||
    !("kind" in decoded) ||
    decoded.kind !== expectedKind ||
    !("offset" in decoded) ||
    typeof decoded.offset !== "number" ||
    !Number.isSafeInteger(decoded.offset) ||
    decoded.offset < 0 ||
    decoded.offset > 1_000_000_000 ||
    !("scope" in decoded) ||
    decoded.scope !== expectedScope
  ) {
    throw new RangeError("History continuation cursor does not match request.");
  }
  const cursorRecord = decoded as Record<string, unknown>;
  const trackedPathValue = cursorRecord.trackedPath;
  const revisionBoundaryValue = cursorRecord.revisionBoundary;
  if (trackedPathValue !== undefined && typeof trackedPathValue !== "string")
    throw new RangeError("History continuation cursor is invalid.");
  if (
    revisionBoundaryValue !== undefined &&
    (typeof revisionBoundaryValue !== "string" ||
      !isSafeHistoryRevisionSelector(revisionBoundaryValue))
  )
    throw new RangeError("History continuation cursor is invalid.");
  const canonicalCursor = Buffer.from(JSON.stringify(decoded), "utf8").toString(
    "base64url",
  );
  if (canonicalCursor !== cursor)
    throw new RangeError("History continuation cursor is invalid.");
  return {
    kind: expectedKind,
    offset: decoded.offset,
    scope: expectedScope,
    ...(trackedPathValue === undefined
      ? {}
      : { trackedPath: normalizeRelativePath(trackedPathValue) }),
    ...(revisionBoundaryValue === undefined
      ? {}
      : { revisionBoundary: revisionBoundaryValue }),
  };
}

function assertCompleteHistoryOutput(
  commandOutput: GitCommandOutput,
  operation: string,
): void {
  if (commandOutput.standardOutputTruncated === true)
    throw new HistoryOutputTruncatedError(operation);
}

function createLogArguments(
  maxEntries: number,
  options: HistoryScopeOptions & {
    readonly includeAllRefs?: boolean;
    readonly includeNameStatus?: boolean;
    readonly includeNumstat?: boolean;
    readonly followRenames?: boolean;
    readonly skipCount?: number;
    readonly path?: string;
  },
): string[] {
  const commandArguments = [
    "log",
    "--no-ext-diff",
    "--date=iso-strict",
    `--max-count=${maxEntries + 1}`,
    `--format=${HISTORY_METADATA_FORMAT}`,
    ...(options.includeAllRefs === true ? ["--all", "HEAD"] : []),
    ...(options.skipCount === undefined || options.skipCount === 0
      ? []
      : [`--skip=${options.skipCount}`]),
    ...(options.followRenames === true ? ["--follow"] : []),
    ...(options.includeNameStatus === true
      ? ["--find-renames", "--name-status", "-z"]
      : options.includeNumstat === true
        ? ["--find-renames", "--numstat", "-z"]
        : []),
    ...(options.revision === undefined
      ? []
      : [assertRevisionSelector(options.revision, "revision")]),
  ];
  return options.path === undefined
    ? commandArguments
    : [...commandArguments, "--", normalizeRelativePath(options.path)];
}

function parseHistoryRecordsWithFileChanges(
  gitLogOutput: string,
  parseFileChanges: (fileChangesText: string) => readonly HistoryFileChange[],
): readonly HistoryCommit[] {
  return gitLogOutput.split(HISTORY_RECORD_SEPARATOR).flatMap((record) => {
    const parsedCommit = parseHistoryRecord(record, false);
    if (parsedCommit === undefined) return [];
    const shaStart = record.search(/(?:[0-9a-f]{40}|[0-9a-f]{64})\0/i);
    if (shaStart < 0) return [];
    const newlineIndex = record.indexOf("\n", shaStart);
    const fileChangesText =
      newlineIndex < 0 ? "" : record.slice(newlineIndex + 1);
    return [
      {
        ...parsedCommit,
        changedFiles: parseFileChanges(fileChangesText),
      },
    ];
  });
}

function parseCommitFileChangesFromNameStatus(
  fileChangesText: string,
): readonly HistoryFileChange[] {
  return parseCommitFileChanges("", fileChangesText);
}

function parseCommitFileChangesFromNumstat(
  fileChangesText: string,
): readonly HistoryFileChange[] {
  return parseCommitFileChanges(fileChangesText);
}

function mergeHistoryCommits(
  nameStatusCommits: readonly HistoryCommit[],
  numstatCommits: readonly HistoryCommit[],
): readonly HistoryCommit[] {
  const numstatBySha = new Map(
    numstatCommits.map((commit) => [commit.sha, commit.changedFiles]),
  );
  const mergedCommits = nameStatusCommits.map((commit) => {
    const numstatChanges = numstatBySha.get(commit.sha);
    if (numstatChanges === undefined) return commit;
    numstatBySha.delete(commit.sha);
    return {
      ...commit,
      changedFiles: mergeHistoryFileChanges(
        commit.changedFiles,
        numstatChanges,
      ),
    };
  });
  for (const commit of numstatCommits) {
    if (!numstatBySha.has(commit.sha)) continue;
    numstatBySha.delete(commit.sha);
    mergedCommits.push(commit);
  }
  return mergedCommits;
}

function mergeHistoryFileChanges(
  nameStatusChanges: readonly HistoryFileChange[],
  numstatChanges: readonly HistoryFileChange[],
): readonly HistoryFileChange[] {
  const statusByPath = new Map(
    nameStatusChanges.map((change) => [change.path, change]),
  );
  const mergedChanges = numstatChanges.map((numstatChange) => {
    const statusChange =
      statusByPath.get(numstatChange.path) ??
      (numstatChange.previousPath === undefined
        ? undefined
        : statusByPath.get(numstatChange.previousPath));
    if (statusChange === undefined) return numstatChange;
    statusByPath.delete(statusChange.path);
    return {
      ...numstatChange,
      changeType:
        numstatChange.changeType === "binary"
          ? "binary"
          : statusChange.changeType,
      ...(statusChange.previousPath === undefined
        ? {}
        : { previousPath: statusChange.previousPath }),
    };
  });
  return [...mergedChanges, ...statusByPath.values()];
}

function createQueryArguments(
  query: HistoryQuery & { readonly limit: number },
  fileStatsMode: "nameStatus" | "numstat" = "nameStatus",
  skipCount = 0,
): string[] {
  const patchTerms = query.terms.filter((term) => term.field === "patch");
  const canNarrowWithPatch =
    patchTerms.length > 0 &&
    query.matchAll === true &&
    query.regex !== true &&
    isGitCompatibleLiteral(patchTerms[0]?.value ?? "");
  const commandArguments = [
    "log",
    "--no-ext-diff",
    "--date=iso-strict",
    `--max-count=${historyQueryScanCap + 1}`,
    `--format=${HISTORY_METADATA_FORMAT}`,
    ...(query.revision === undefined
      ? ["--all", "HEAD"]
      : [assertRevisionSelector(query.revision, "revision")]),
    ...(skipCount === 0 ? [] : [`--skip=${skipCount}`]),
    "--find-renames",
    ...(fileStatsMode === "numstat"
      ? ["--numstat", "-z"]
      : ["--name-status", "-z"]),
    ...(canNarrowWithPatch
      ? [
          `-G${queryPattern(patchTerms[0]?.value ?? "", query.regex ?? false)}`,
          ...(query.matchCase === false ? ["--regexp-ignore-case"] : []),
        ]
      : []),
  ];
  return query.filePath === undefined
    ? commandArguments
    : [...commandArguments, "--", normalizeRelativePath(query.filePath)];
}

function normalizeHistoryQuery(
  query: HistoryQuery,
): HistoryQuery & { readonly limit: number } {
  if (!Array.isArray(query.terms))
    throw new TypeError("History query terms must be an array.");
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit > historyQueryResultLimitCap)
  ) {
    throw new RangeError(
      `History query limit cannot exceed ${historyQueryResultLimitCap}.`,
    );
  }
  const limit = normalizeLimit(query.limit ?? DEFAULT_HISTORY_PAGE_SIZE);
  const normalizedTerms: HistoryQuery["terms"] = query.terms.map(
    (term: HistoryQuery["terms"][number]) => {
      if (
        term.value.length === 0 ||
        term.value.length > 4096 ||
        term.value.includes("\0")
      )
        throw new RangeError("History query terms cannot be empty.");
      if (query.regex === true) {
        assertSafeHistoryRegex(term.value);
        try {
          new RegExp(term.value, query.matchCase === false ? "i" : "");
        } catch {
          throw new Error(
            `Invalid history query regular expression: ${term.value}`,
          );
        }
      }
      return { field: term.field, value: term.value };
    },
  );
  return {
    ...query,
    terms: normalizedTerms,
    limit,
    matchCase: query.matchCase ?? false,
    regex: query.regex ?? false,
    matchAll: query.matchAll ?? false,
    ...(query.filePath === undefined
      ? {}
      : { filePath: normalizeRelativePath(query.filePath) }),
  };
}

function matchingQueryFields(
  commit: HistoryCommit,
  query: HistoryQuery,
  patchText: string | undefined,
): readonly HistoryQueryField[] {
  const matchingFields = new Set<HistoryQueryField>();
  const termMatches = query.terms.map((term) => {
    const matches = matchesTerm(
      commit,
      term.field,
      term.value,
      query,
      patchText,
    );
    if (matches) matchingFields.add(term.field);
    return matches;
  });
  const queryMatches =
    query.terms.length === 0
      ? true
      : query.matchAll === true
        ? termMatches.every(Boolean)
        : termMatches.some(Boolean);
  return queryMatches ? [...matchingFields] : [];
}

function matchesTerm(
  commit: HistoryCommit,
  field: HistoryQueryField,
  pattern: string,
  query: HistoryQuery,
  patchText: string | undefined,
): boolean {
  const searchableText =
    field === "message"
      ? commit.subject
      : field === "author"
        ? `${commit.authorName}\n${commit.authorEmail}`
        : field === "sha"
          ? `${commit.sha}\n${commit.shortSha}`
          : field === "file"
            ? commit.changedFiles
                .flatMap((fileChange) => [
                  fileChange.path,
                  fileChange.previousPath ?? "",
                ])
                .join("\n")
            : (patchText ?? "");
  if (query.regex === true) {
    return new RegExp(pattern, query.matchCase === false ? "i" : "").test(
      searchableText,
    );
  }
  if (query.matchCase === false) {
    return searchableText
      .toLocaleLowerCase()
      .includes(pattern.toLocaleLowerCase());
  }
  return searchableText.includes(pattern);
}

function queryPattern(pattern: string, regex: boolean): string {
  return regex ? pattern : pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isGitCompatibleLiteral(pattern: string): boolean {
  for (const character of pattern) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return false;
  }
  return true;
}

/**
 * JavaScript regexes backtrack. Keep the public regex mode deliberately
 * small so an accepted query cannot express nested or branching repetition.
 * The input is also bounded by normalizeHistoryQuery before this check.
 */
function assertSafeHistoryRegex(pattern: string): void {
  const maxSafeRegexLength = 512;
  if (pattern.length > maxSafeRegexLength) {
    throw new RangeError(
      `History regular expressions cannot exceed ${maxSafeRegexLength} characters.`,
    );
  }
  let characterClassOpen = false;
  let quantifierCount = 0;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      if (character !== undefined && /[0-9]/u.test(character)) {
        throw new Error(
          "History regular expressions do not support backreferences.",
        );
      }
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      if (characterClassOpen) {
        throw new Error(
          "History regular expressions do not support nested character classes.",
        );
      }
      characterClassOpen = true;
      continue;
    }
    if (character === "]") {
      characterClassOpen = false;
      continue;
    }
    if (characterClassOpen) continue;
    if (character === "(" || character === ")" || character === "|") {
      throw new Error(
        "History regular expressions allow no groups or alternation.",
      );
    }
    if (character === "{") {
      throw new Error(
        "History regular expressions do not support bounded repetition.",
      );
    }
    if (character === "*" || character === "+" || character === "?") {
      quantifierCount += 1;
      if (quantifierCount > 1) {
        throw new Error(
          "History regular expressions allow at most one repetition operator.",
        );
      }
    }
  }
  if (escaped || characterClassOpen) {
    throw new Error("Invalid history query regular expression.");
  }
}

function findPathChange(
  changedFiles: readonly HistoryFileChange[],
  requestedPath: string,
): HistoryFileChange | undefined {
  return changedFiles.find(
    (change) =>
      change.path === requestedPath || change.previousPath === requestedPath,
  );
}

function createRevisionResource(
  repositoryRoot: HistoryRepositoryRootBinding,
  revisionSha: string,
  relativePath: string,
): GitRevisionResource {
  return {
    repositoryRoot: repositoryRootPath(repositoryRoot),
    repositoryRootIdentity: historyRepositoryIdentity(repositoryRoot),
    revisionSha,
    relativePath,
  };
}

function createDiffPlan(
  left: GitRevisionResource,
  right: GitRevisionResource,
  title: string,
): NativeDiffPlan {
  return { left, right, title };
}

function selectParent(
  parents: readonly RevisionParent[],
  selectedParentSha: string | undefined,
): RevisionParent | undefined {
  if (selectedParentSha === undefined) return parents[0];
  assertRevisionSelector(selectedParentSha, "parentSha");
  const selectedParent = parents.find(
    (parent) => parent.sha === selectedParentSha,
  );
  if (selectedParent === undefined) {
    throw new Error(
      `Revision parent ${selectedParentSha} is not a parent of the selected revision.`,
    );
  }
  return selectedParent;
}

function compareContributorSummaries(
  left: ContributorSummary,
  right: ContributorSummary,
): number {
  return (
    right.commitCount - left.commitCount ||
    left.authorName.localeCompare(right.authorName) ||
    left.authorEmail.localeCompare(right.authorEmail)
  );
}

function repositoryRootPath(
  repositoryRoot: HistoryRepositoryRootBinding,
): string {
  if (isPinnedHistoryRepositoryRoot(repositoryRoot))
    return repositoryRoot.canonicalPath;
  const rootPath =
    typeof repositoryRoot === "string" ? repositoryRoot : repositoryRoot.fsPath;
  if (
    rootPath.length === 0 ||
    rootPath.includes("\0") ||
    (!nodePath.isAbsolute(rootPath) && !nodePath.win32.isAbsolute(rootPath))
  )
    throw new Error("Repository root must be an absolute path.");
  return rootPath;
}

function historyRepositoryIdentity(
  repositoryRoot: HistoryRepositoryRootBinding,
): string {
  if (isPinnedHistoryRepositoryRoot(repositoryRoot))
    return repositoryRoot.repositoryRootIdentity;
  if (typeof repositoryRoot === "string")
    return `file:${repositoryRootPath(repositoryRoot)}`;
  return normalizeDecodedRepositoryUriIdentity(repositoryRoot);
}

function normalizeDecodedRepositoryUriIdentity(
  repositoryRoot: HistoryRepositoryRoot,
): string {
  if (typeof repositoryRoot === "string")
    return `file:${repositoryRootPath(repositoryRoot)}`;
  const uriRecord = repositoryRoot as unknown as Record<string, unknown>;
  const scheme =
    typeof uriRecord.scheme === "string" ? uriRecord.scheme : "file";
  const authority =
    typeof uriRecord.authority === "string" ? uriRecord.authority : "";
  const decodedPath =
    typeof uriRecord.path === "string"
      ? uriRecord.path.replaceAll("\\", "/")
      : typeof uriRecord.fsPath === "string"
        ? uriRecord.fsPath.replaceAll("\\", "/")
        : "/";
  const path = decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`;
  const query =
    typeof uriRecord.query === "string" && uriRecord.query.length > 0
      ? `?${uriRecord.query}`
      : "";
  const fragment =
    typeof uriRecord.fragment === "string" && uriRecord.fragment.length > 0
      ? `#${uriRecord.fragment}`
      : "";
  return `${scheme}://${authority}${path}${query}${fragment}`;
}

function isPinnedHistoryRepositoryRoot(
  repositoryRoot: HistoryRepositoryRootBinding,
): repositoryRoot is PinnedHistoryRepositoryRoot {
  return (
    typeof repositoryRoot === "object" &&
    repositoryRoot !== null &&
    "canonicalPath" in repositoryRoot &&
    "requestedPath" in repositoryRoot &&
    "device" in repositoryRoot &&
    "inode" in repositoryRoot
  );
}

async function pinHistoryRepositoryRoot(
  repositoryRoot: HistoryRepositoryRoot,
  rootBindingResolver: GitRootBindingResolver,
  cancellationSignal?: AbortSignal,
): Promise<PinnedHistoryRepositoryRoot> {
  throwIfHistoryOperationCancelled(cancellationSignal);
  const requestedPath = repositoryRootPath(repositoryRoot);
  let rootBinding: GitRootBindingIdentity;
  try {
    rootBinding = await rootBindingResolver.resolve(
      requestedPath,
      undefined,
      cancellationSignal === undefined ? {} : { cancellationSignal },
    );
  } catch (error: unknown) {
    throwIfHistoryOperationCancelled(cancellationSignal);
    if (isAbortError(error)) throw error;
    throw new HistoryRepositoryRootChangedError(
      "The history repository root could not be bound to configured Git.",
    );
  }
  throwIfHistoryOperationCancelled(cancellationSignal);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    throwIfHistoryOperationCancelled(cancellationSignal);
    throw new HistoryRepositoryRootChangedError(
      "The history repository root is unavailable.",
    );
  }
  throwIfHistoryOperationCancelled(cancellationSignal);
  if (canonicalPath !== rootBinding.canonicalPath) {
    throw new HistoryRepositoryRootChangedError(
      "The configured Git root binding does not match the requested root.",
    );
  }
  let rootStats: Awaited<ReturnType<typeof stat>>;
  try {
    rootStats = await stat(canonicalPath, { bigint: true });
  } catch {
    throwIfHistoryOperationCancelled(cancellationSignal);
    throw new HistoryRepositoryRootChangedError(
      "The history repository root is unavailable.",
    );
  }
  throwIfHistoryOperationCancelled(cancellationSignal);
  if (!rootStats.isDirectory()) {
    throw new HistoryRepositoryRootChangedError(
      "The history repository root is not a directory.",
    );
  }
  return {
    requestedPath,
    canonicalPath,
    device: rootStats.dev.toString(),
    inode: rootStats.ino.toString(),
    repositoryRootIdentity: historyRepositoryIdentity(repositoryRoot),
    rootBinding,
  };
}

async function assertPinnedHistoryRepositoryRoot(
  pinnedRoot: PinnedHistoryRepositoryRoot,
  rootBindingResolver: GitRootBindingResolver,
  cancellationSignal?: AbortSignal,
): Promise<void> {
  throwIfHistoryOperationCancelled(cancellationSignal);
  let currentRootBinding: GitRootBindingIdentity;
  try {
    currentRootBinding = await rootBindingResolver.assert(
      pinnedRoot.requestedPath,
      pinnedRoot.rootBinding,
      cancellationSignal === undefined ? {} : { cancellationSignal },
    );
  } catch (error: unknown) {
    throwIfHistoryOperationCancelled(cancellationSignal);
    if (isAbortError(error)) throw error;
    throw new HistoryRepositoryRootChangedError(
      "The history repository root or configured Git root binding changed.",
    );
  }
  throwIfHistoryOperationCancelled(cancellationSignal);
  if (!sameGitRootBindingIdentity(currentRootBinding, pinnedRoot.rootBinding)) {
    throw new HistoryRepositoryRootChangedError(
      "The history repository root or configured Git root binding changed.",
    );
  }
  let currentCanonicalPath: string;
  try {
    currentCanonicalPath = await realpath(pinnedRoot.requestedPath);
  } catch {
    throwIfHistoryOperationCancelled(cancellationSignal);
    throw new HistoryRepositoryRootChangedError();
  }
  throwIfHistoryOperationCancelled(cancellationSignal);
  if (currentCanonicalPath !== pinnedRoot.canonicalPath) {
    throw new HistoryRepositoryRootChangedError(
      "The history repository root symlink target changed.",
    );
  }
  let currentRootStats: Awaited<ReturnType<typeof stat>>;
  try {
    currentRootStats = await stat(currentCanonicalPath, { bigint: true });
  } catch {
    throwIfHistoryOperationCancelled(cancellationSignal);
    throw new HistoryRepositoryRootChangedError();
  }
  throwIfHistoryOperationCancelled(cancellationSignal);
  if (
    !currentRootStats.isDirectory() ||
    currentRootStats.dev.toString() !== pinnedRoot.device ||
    currentRootStats.ino.toString() !== pinnedRoot.inode
  ) {
    throw new HistoryRepositoryRootChangedError(
      "The history repository root was replaced.",
    );
  }
}

function throwIfHistoryOperationCancelled(
  cancellationSignal?: AbortSignal,
): void {
  if (cancellationSignal?.aborted === true)
    throw new DOMException("History operation cancelled", "AbortError");
}

function sameGitRootBindingIdentity(
  left: GitRootBindingIdentity,
  right: GitRootBindingIdentity,
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.gitDirectory.canonicalPath === right.gitDirectory.canonicalPath &&
    left.gitDirectory.device === right.gitDirectory.device &&
    left.gitDirectory.inode === right.gitDirectory.inode &&
    left.commonDirectory.canonicalPath ===
      right.commonDirectory.canonicalPath &&
    left.commonDirectory.device === right.commonDirectory.device &&
    left.commonDirectory.inode === right.commonDirectory.inode
  );
}

function normalizeRelativePath(filePath: string): string {
  if (filePath.length === 0 || filePath.includes("\0")) {
    throw new Error("History file path cannot be empty or contain NUL.");
  }
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (
    normalizedPath.startsWith("/") ||
    nodePath.win32.isAbsolute(normalizedPath) ||
    normalizedPath.startsWith("../") ||
    normalizedPath === ".." ||
    nodePath.posix.normalize(normalizedPath).startsWith("../")
  ) {
    throw new Error("History file path must stay inside the repository.");
  }
  const canonicalPath = nodePath.posix.normalize(normalizedPath);
  if (canonicalPath === ".")
    throw new Error("History file path cannot be the repository root.");
  return canonicalPath;
}

function assertRevisionSelector(value: string, fieldName: string): string {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`${fieldName} is not a safe Git revision selector.`);
  }
  return value;
}

function isSafeHistoryRevisionSelector(value: string): boolean {
  try {
    assertRevisionSelector(value, "history continuation revision");
    return true;
  } catch {
    return false;
  }
}

function normalizeLimit(limit: number | undefined): number {
  const normalizedLimit = limit ?? DEFAULT_HISTORY_PAGE_SIZE;
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new RangeError("History limit must be a positive integer.");
  }
  return Math.min(normalizedLimit, HISTORY_QUERY_SAFETY_CAP);
}

function assertLineNumber(lineNumber: number): void {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new RangeError("Line number must be a positive integer.");
  }
}

function validateBlameRange(range: {
  readonly startLine: number;
  readonly endLine: number;
}): void {
  assertLineNumber(range.startLine);
  assertLineNumber(range.endLine);
  if (range.endLine < range.startLine) {
    throw new RangeError("Blame range endLine must not precede startLine.");
  }
}

function historyDateTime(dateText: string): number {
  const parsedDateTime = Date.parse(dateText);
  return Number.isNaN(parsedDateTime) ? Number.NaN : parsedDateTime;
}

function earlierHistoryDate(leftDate: string, rightDate: string): string {
  const leftTimestamp = historyDateTime(leftDate);
  const rightTimestamp = historyDateTime(rightDate);
  if (Number.isNaN(leftTimestamp) || Number.isNaN(rightTimestamp)) {
    return leftDate < rightDate ? leftDate : rightDate;
  }
  return leftTimestamp < rightTimestamp ? leftDate : rightDate;
}

function laterHistoryDate(leftDate: string, rightDate: string): string {
  const leftTimestamp = historyDateTime(leftDate);
  const rightTimestamp = historyDateTime(rightDate);
  if (Number.isNaN(leftTimestamp) || Number.isNaN(rightTimestamp)) {
    return leftDate > rightDate ? leftDate : rightDate;
  }
  return leftTimestamp > rightTimestamp ? leftDate : rightDate;
}
