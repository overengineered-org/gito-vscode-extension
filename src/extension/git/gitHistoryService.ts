import type * as vscode from "vscode";
import * as nodePath from "node:path";
import { decodeGitPath } from "../history/historyParsing.js";
import type {
  LocalGitCommitDetails,
  LocalGitCommitFileChange,
  LocalGitCommitSummary,
} from "./localGitModels.js";
import {
  GitCommandFailure,
  isAbortError,
  type GitCommandRunner,
  type GitCommandRequest,
  type GitRootBindingIdentity,
} from "./gitCommandRunner.js";
import type { GitRootBindingResolver } from "./gitRootBindingResolver.js";
import type { VscodeGitRepository } from "./vscodeGitApi.js";
import { parseGitHubRemote } from "../providers/github/githubRemote.js";

export const localGitHistoryPageSize = 100;
export const localGitCommitActivitySafetyCap = 250_000;
export const localGitHistoryOutputSafetyCapBytes = 8 * 1024 * 1024;
export const localGitCommitMetadataOutputCapBytes = 64 * 1024;
export const localGitCommitBodyOutputCapBytes = 1 * 1024 * 1024;
export const localGitCommitFilesOutputCapBytes = 8 * 1024 * 1024;
const localGitCommitActivityCacheEntryLimit = 32;

export class GitHistoryOutputTruncatedError extends Error {
  public constructor(operation: string) {
    super(`Git ${operation} output exceeded the safe memory limit.`);
    this.name = "GitHistoryOutputTruncatedError";
  }
}

export class GitHistoryRepositoryBindingError extends Error {
  public constructor() {
    super("The selected Git repository changed or became unavailable.");
    this.name = "GitHistoryRepositoryBindingError";
  }
}

export interface CommitHistoryPage {
  readonly commits: readonly LocalGitCommitSummary[];
  readonly pageIndex: number;
  readonly hasMore: boolean;
  /** True when Git output ended before a complete page could be read. */
  readonly truncated?: boolean;
}

export interface CommitActivityWindow {
  readonly startDate: string;
  readonly endDate: string;
}

export interface CommitActivitySnapshot {
  readonly days: ReadonlyMap<string, number>;
  readonly matchingCommitCount: number;
  readonly reachedSafetyCap: boolean;
  readonly outputTruncated: boolean;
}

interface GitHistoryRepositoryBinding {
  readonly requestedPath: string;
  readonly rootBinding: GitRootBindingIdentity;
}

interface CommitActivityCacheEntry {
  readonly snapshot: CommitActivitySnapshot;
}

type GitHistoryCommandRequest = Omit<GitCommandRequest, "repositoryRoot">;

export class GitHistoryService {
  private readonly commitActivityCache = new Map<
    string,
    CommitActivityCacheEntry
  >();

  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly rootBindingResolver: GitRootBindingResolver,
  ) {}

  public async listCommitHistory(
    repositoryRoot: vscode.Uri,
    pageIndex: number,
    cancellationSignal?: AbortSignal,
  ): Promise<CommitHistoryPage> {
    assertNonNegativeInteger(pageIndex, "pageIndex");
    const skipCount = pageIndex * localGitHistoryPageSize;
    const repositoryRootBinding = await this.pinRepositoryRoot(
      repositoryRoot,
      cancellationSignal,
    );
    const commandOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: [
        "log",
        "--date=iso-strict",
        `--max-count=${localGitHistoryPageSize + 1}`,
        `--skip=${skipCount}`,
        "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%D%x01",
        "HEAD",
      ],
      cancellationSignal,
      maxStandardOutputBytes: localGitHistoryOutputSafetyCapBytes,
    });
    const parsedCommits = parseCommitSummaryRecords(
      commandOutput.standardOutput,
    );
    throwIfGitHistoryCancelled(cancellationSignal);
    return {
      commits: parsedCommits.slice(0, localGitHistoryPageSize),
      pageIndex,
      hasMore:
        commandOutput.standardOutputTruncated !== true &&
        parsedCommits.length > localGitHistoryPageSize,
      ...(commandOutput.standardOutputTruncated === true
        ? { truncated: true }
        : {}),
    };
  }

  public async getCommitActivity(
    repositoryRoot: vscode.Uri,
    authorEmails: readonly string[],
    activityWindow: CommitActivityWindow,
    cancellationSignal?: AbortSignal,
  ): Promise<CommitActivitySnapshot> {
    const repositoryRootBinding = await this.pinRepositoryRoot(
      repositoryRoot,
      cancellationSignal,
    );
    const headCommitSha = await this.readHeadCommitSha(
      repositoryRootBinding,
      cancellationSignal,
    );
    if (headCommitSha === undefined) {
      throwIfGitHistoryCancelled(cancellationSignal);
      return createEmptyCommitActivitySnapshot();
    }

    const isShallowRepository = await this.readShallowRepositoryState(
      repositoryRootBinding,
      cancellationSignal,
    );

    const resolvedAuthorEmails = await this.resolveCommitActivityAuthorEmails(
      repositoryRootBinding,
      authorEmails,
      cancellationSignal,
    );
    const normalizedAuthorEmails = normalizeAuthorEmails(resolvedAuthorEmails);
    const cacheKey = createCommitActivityCacheKey(
      repositoryRootBinding.rootBinding,
      headCommitSha,
      isShallowRepository,
      normalizedAuthorEmails,
      activityWindow,
    );
    const cachedActivity = this.commitActivityCache.get(cacheKey);
    if (cachedActivity !== undefined) {
      const currentHeadCommitSha = await this.readHeadCommitSha(
        repositoryRootBinding,
        cancellationSignal,
      );
      if (currentHeadCommitSha !== headCommitSha)
        throw new GitHistoryRepositoryBindingError();
      const currentIsShallowRepository = await this.readShallowRepositoryState(
        repositoryRootBinding,
        cancellationSignal,
      );
      if (currentIsShallowRepository !== isShallowRepository)
        throw new GitHistoryRepositoryBindingError();
      throwIfGitHistoryCancelled(cancellationSignal);
      this.promoteCommitActivityCacheEntry(cacheKey, cachedActivity);
      return cloneCommitActivitySnapshot(cachedActivity.snapshot);
    }
    if (normalizedAuthorEmails.size === 0) {
      throwIfGitHistoryCancelled(cancellationSignal);
      const emptySnapshot = createEmptyCommitActivitySnapshot();
      this.cacheCommitActivity(cacheKey, emptySnapshot);
      return emptySnapshot;
    }

    const dayCountByDate = new Map<string, number>();
    let matchingCommitCount = 0;
    let pendingRecord = "";
    let reachedSafetyCap = false;
    let outputTruncated = false;
    const activityAbortController = new AbortController();
    const abortExternalActivitySignal = (): void =>
      activityAbortController.abort();
    if (cancellationSignal?.aborted) activityAbortController.abort();
    else {
      cancellationSignal?.addEventListener(
        "abort",
        abortExternalActivitySignal,
        {
          once: true,
        },
      );
    }
    const processRecord = (record: string): void => {
      if (reachedSafetyCap || record.length === 0) return;
      const [commitDate, commitAuthorEmail] = record.split("\0");
      if (
        commitDate === undefined ||
        commitAuthorEmail === undefined ||
        !normalizedAuthorEmails.has(commitAuthorEmail.toLowerCase())
      ) {
        return;
      }
      if (matchingCommitCount >= localGitCommitActivitySafetyCap) {
        reachedSafetyCap = true;
        activityAbortController.abort();
        return;
      }
      matchingCommitCount += 1;
      const activityDate = commitDate.slice(0, 10);
      dayCountByDate.set(
        activityDate,
        (dayCountByDate.get(activityDate) ?? 0) + 1,
      );
    };

    const commandRequest: GitHistoryCommandRequest = {
      arguments: [
        "log",
        "--date=iso-strict",
        `--since=${activityWindow.startDate}`,
        `--until=${activityWindow.endDate}`,
        "--format=%aI%x00%ae%x01",
        "HEAD",
      ],
      cancellationSignal: activityAbortController.signal,
      collectStandardOutput: false,
      maxStandardOutputBytes: localGitHistoryOutputSafetyCapBytes,
    };
    try {
      const commandOutput = await this.runBoundStreamingCommand(
        repositoryRootBinding,
        commandRequest,
        (chunk) => {
          if (reachedSafetyCap) return;
          pendingRecord += chunk;
          const completeRecords = pendingRecord.split("\x01");
          pendingRecord = completeRecords.pop() ?? "";
          for (const completeRecord of completeRecords)
            processRecord(completeRecord);
        },
      );
      outputTruncated = commandOutput.standardOutputTruncated === true;
      if (!reachedSafetyCap && !outputTruncated) processRecord(pendingRecord);
    } catch (error: unknown) {
      if (!reachedSafetyCap || !isAbortError(error)) throw error;
    } finally {
      cancellationSignal?.removeEventListener(
        "abort",
        abortExternalActivitySignal,
      );
    }
    const currentHeadCommitSha = await this.readHeadCommitSha(
      repositoryRootBinding,
      cancellationSignal,
    );
    throwIfGitHistoryCancelled(cancellationSignal);
    if (currentHeadCommitSha !== headCommitSha)
      throw new GitHistoryRepositoryBindingError();
    const currentIsShallowRepository = await this.readShallowRepositoryState(
      repositoryRootBinding,
      cancellationSignal,
    );
    if (currentIsShallowRepository !== isShallowRepository)
      throw new GitHistoryRepositoryBindingError();
    const activitySnapshot = {
      days: dayCountByDate,
      matchingCommitCount,
      reachedSafetyCap,
      outputTruncated,
    };
    this.cacheCommitActivity(cacheKey, activitySnapshot);
    return cloneCommitActivitySnapshot(activitySnapshot);
  }

  public searchLoadedHistory(
    commits: readonly LocalGitCommitSummary[],
    searchText: string,
  ): readonly LocalGitCommitSummary[] {
    const normalizedSearchText = searchText.trim().toLowerCase();
    if (normalizedSearchText.length === 0) return commits;
    return commits.filter((commit) =>
      [
        commit.commitSha,
        commit.shortSha,
        commit.subject,
        commit.authorName,
        commit.authorEmail,
      ].some((searchableField) =>
        searchableField.toLowerCase().includes(normalizedSearchText),
      ),
    );
  }

  public async searchHistory(
    repositoryRoot: vscode.Uri,
    searchText: string,
    cancellationSignal?: AbortSignal,
  ): Promise<readonly LocalGitCommitSummary[]> {
    const repositoryRootBinding = await this.pinRepositoryRoot(
      repositoryRoot,
      cancellationSignal,
    );
    const commandOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: [
        "log",
        "--all",
        "--date=iso-strict",
        "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%D%x01",
      ],
      cancellationSignal,
      maxStandardOutputBytes: localGitHistoryOutputSafetyCapBytes,
    });
    throwIfGitHistoryCancelled(cancellationSignal);
    if (commandOutput.standardOutputTruncated === true) {
      throw new GitHistoryOutputTruncatedError("history search");
    }
    return this.searchLoadedHistory(
      parseCommitSummaryRecords(commandOutput.standardOutput),
      searchText,
    );
  }

  public async getCommitDetails(
    repositoryRoot: vscode.Uri,
    commitSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<LocalGitCommitDetails> {
    assertCommitSha(commitSha);
    const repositoryRootBinding = await this.pinRepositoryRoot(
      repositoryRoot,
      cancellationSignal,
    );
    const metadataOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: [
        "show",
        "--no-ext-diff",
        "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cI%x00%P%x00%s%x01",
        "--no-patch",
        commitSha,
      ],
      cancellationSignal,
      maxStandardOutputBytes: localGitCommitMetadataOutputCapBytes,
    });
    if (metadataOutput.standardOutputTruncated === true) {
      throw new GitHistoryOutputTruncatedError("commit metadata");
    }
    const bodyOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: [
        "show",
        "--no-ext-diff",
        "--format=%B",
        "--no-patch",
        commitSha,
      ],
      cancellationSignal,
      maxStandardOutputBytes: localGitCommitBodyOutputCapBytes,
    });
    const filesOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: [
        "show",
        "--no-ext-diff",
        "--find-renames",
        "--format=",
        "--numstat",
        "-z",
        commitSha,
      ],
      cancellationSignal,
      maxStandardOutputBytes: localGitCommitFilesOutputCapBytes,
    });
    const statusesOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: [
        "show",
        "--no-ext-diff",
        "--find-renames",
        "--format=",
        "--name-status",
        "-z",
        commitSha,
      ],
      cancellationSignal,
      maxStandardOutputBytes: localGitCommitFilesOutputCapBytes,
    });
    throwIfGitHistoryCancelled(cancellationSignal);
    const commitMetadata = parseCommitDetailsMetadata(
      metadataOutput.standardOutput,
    );
    const files = parseCommitFileChanges(
      filesOutput.standardOutput,
      statusesOutput.standardOutput,
    );
    return {
      ...commitMetadata,
      body: bodyOutput.standardOutput.trimEnd(),
      files,
      totalAdditions: files.reduce(
        (additionTotal, fileChange) => additionTotal + fileChange.additions,
        0,
      ),
      totalDeletions: files.reduce(
        (deletionTotal, fileChange) => deletionTotal + fileChange.deletions,
        0,
      ),
      ...(bodyOutput.standardOutputTruncated === true ||
      filesOutput.standardOutputTruncated === true ||
      statusesOutput.standardOutputTruncated === true
        ? { truncated: true }
        : {}),
    };
  }

  public getRemoteUrls(repository: VscodeGitRepository): readonly string[] {
    return repository.state.remotes.flatMap((remote) =>
      [remote.fetchUrl, remote.pushUrl].filter(
        (remoteUrl): remoteUrl is string => remoteUrl !== undefined,
      ),
    );
  }

  public getCanonicalCommitUrl(
    remoteUrls: readonly string[],
    commitSha: string,
  ): string | undefined {
    assertCommitSha(commitSha);
    for (const remoteUrl of remoteUrls) {
      const githubRemote = parseGitHubRemote(remoteUrl);
      if (githubRemote !== undefined) {
        return `https://github.com/${githubRemote.owner}/${githubRemote.repositoryName}/commit/${commitSha}`;
      }
      const azureRemoteBaseUrl = parseAzureRemoteBaseUrl(remoteUrl);
      if (azureRemoteBaseUrl !== undefined) {
        return `${azureRemoteBaseUrl}/commit/${commitSha}`;
      }
    }
    return undefined;
  }

  private async pinRepositoryRoot(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
  ): Promise<GitHistoryRepositoryBinding> {
    if (
      repositoryRoot.fsPath.length === 0 ||
      !nodePath.isAbsolute(repositoryRoot.fsPath)
    ) {
      throw new GitHistoryRepositoryBindingError();
    }
    const requestedPath = nodePath.resolve(repositoryRoot.fsPath);
    try {
      const rootBinding = await this.rootBindingResolver.resolve(
        requestedPath,
        undefined,
        {
          cancellationSignal,
          requireGitTopLevelMatch: true,
        },
      );
      return {
        requestedPath,
        rootBinding,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      throw new GitHistoryRepositoryBindingError();
    }
  }

  private async readHeadCommitSha(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    cancellationSignal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const commandOutput = await this.runBoundCommand(repositoryRootBinding, {
        arguments: ["rev-parse", "--verify", "HEAD^{commit}"],
        cancellationSignal,
        maxStandardOutputBytes: 128,
      });
      throwIfGitHistoryCancelled(cancellationSignal);
      const headCommitSha = commandOutput.standardOutput.trim();
      if (headCommitSha.length === 0) return undefined;
      assertCommitSha(headCommitSha);
      return headCommitSha;
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      if (isMissingHeadRevisionFailure(error)) return undefined;
      throw error;
    }
  }

  private async resolveCommitActivityAuthorEmails(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    configuredAuthorEmails: readonly string[],
    cancellationSignal?: AbortSignal,
  ): Promise<readonly string[]> {
    const repositoryAuthorEmail = await this.readGitConfigEmail(
      repositoryRootBinding,
      "--local",
      cancellationSignal,
    );
    const globalAuthorEmail =
      repositoryAuthorEmail === undefined
        ? await this.readGitConfigEmail(
            repositoryRootBinding,
            "--global",
            cancellationSignal,
          )
        : undefined;
    return [
      ...configuredAuthorEmails,
      ...(repositoryAuthorEmail === undefined
        ? globalAuthorEmail === undefined
          ? []
          : [globalAuthorEmail]
        : [repositoryAuthorEmail]),
    ];
  }

  private async readGitConfigEmail(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    configScope: "--local" | "--global",
    cancellationSignal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const commandOutput = await this.runBoundCommand(repositoryRootBinding, {
        arguments: ["config", configScope, "--get", "user.email"],
        cancellationSignal,
        maxStandardOutputBytes: 4 * 1024,
      });
      throwIfGitHistoryCancelled(cancellationSignal);
      if (commandOutput.standardOutputTruncated === true)
        throw new GitHistoryOutputTruncatedError(
          `${configScope} Git user.email`,
        );
      const configuredEmail = commandOutput.standardOutput.trim();
      return configuredEmail.length === 0 ? undefined : configuredEmail;
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      if (error instanceof GitCommandFailure && error.exitCode === 1)
        return undefined;
      throw error;
    }
  }

  private async readShallowRepositoryState(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    const commandOutput = await this.runBoundCommand(repositoryRootBinding, {
      arguments: ["rev-parse", "--is-shallow-repository"],
      cancellationSignal,
      maxStandardOutputBytes: 32,
    });
    throwIfGitHistoryCancelled(cancellationSignal);
    if (commandOutput.standardOutputTruncated === true)
      throw new GitHistoryOutputTruncatedError("shallow repository state");
    const shallowState = commandOutput.standardOutput.trim();
    if (shallowState === "true") return true;
    if (shallowState === "false") return false;
    throw new GitHistoryRepositoryBindingError();
  }

  private cacheCommitActivity(
    cacheKey: string,
    snapshot: CommitActivitySnapshot,
  ): void {
    this.commitActivityCache.delete(cacheKey);
    this.commitActivityCache.set(cacheKey, {
      snapshot: cloneCommitActivitySnapshot(snapshot),
    });
    while (
      this.commitActivityCache.size > localGitCommitActivityCacheEntryLimit
    ) {
      const oldestCacheKey = this.commitActivityCache.keys().next().value;
      if (oldestCacheKey === undefined) break;
      this.commitActivityCache.delete(oldestCacheKey);
    }
  }

  private promoteCommitActivityCacheEntry(
    cacheKey: string,
    cacheEntry: CommitActivityCacheEntry,
  ): void {
    this.commitActivityCache.delete(cacheKey);
    this.commitActivityCache.set(cacheKey, cacheEntry);
  }

  private async assertRepositoryRootBinding(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.rootBindingResolver.assert(
        repositoryRootBinding.requestedPath,
        repositoryRootBinding.rootBinding,
        {
          cancellationSignal,
          requireGitTopLevelMatch: true,
        },
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      throw new GitHistoryRepositoryBindingError();
    }
  }

  private async runBoundCommand(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    request: GitHistoryCommandRequest,
  ) {
    await this.assertRepositoryRootBinding(
      repositoryRootBinding,
      request.cancellationSignal,
    );
    const commandOutput = await this.gitCommandRunner.run({
      repositoryRoot: repositoryRootBinding.rootBinding.canonicalPath,
      ...request,
      rootBinding: repositoryRootBinding.rootBinding,
      rootBindingRequired: true,
    });
    throwIfGitHistoryCancelled(request.cancellationSignal);
    await this.assertRepositoryRootBinding(
      repositoryRootBinding,
      request.cancellationSignal,
    );
    return commandOutput;
  }

  private async runBoundStreamingCommand(
    repositoryRootBinding: GitHistoryRepositoryBinding,
    request: GitHistoryCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ) {
    await this.assertRepositoryRootBinding(
      repositoryRootBinding,
      request.cancellationSignal,
    );
    const commandOutput = await this.gitCommandRunner.runStreaming(
      {
        repositoryRoot: repositoryRootBinding.rootBinding.canonicalPath,
        ...request,
        rootBinding: repositoryRootBinding.rootBinding,
        rootBindingRequired: true,
      },
      onStandardOutputChunk,
    );
    throwIfGitHistoryCancelled(request.cancellationSignal);
    await this.assertRepositoryRootBinding(
      repositoryRootBinding,
      request.cancellationSignal,
    );
    return commandOutput;
  }
}

export function parseCommitSummaryRecords(
  gitLogOutput: string,
): readonly LocalGitCommitSummary[] {
  return gitLogOutput
    .split("\x01")
    .map((commitRecord) => commitRecord.trim())
    .filter((commitRecord) => commitRecord.length > 0)
    .map(parseCommitSummaryRecord)
    .filter(
      (commitSummary): commitSummary is LocalGitCommitSummary =>
        commitSummary !== undefined,
    );
}

export function parseCommitSummaryRecord(
  commitRecord: string,
): LocalGitCommitSummary | undefined {
  const [
    commitSha,
    shortSha,
    authorName,
    authorEmail,
    authorDate,
    commitDate,
    subject,
    refs,
  ] = commitRecord.split("\0");
  if (
    commitSha === undefined ||
    shortSha === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authorDate === undefined ||
    commitDate === undefined ||
    subject === undefined ||
    refs === undefined
  ) {
    return undefined;
  }
  return {
    commitSha,
    shortSha,
    subject,
    authorName,
    authorEmail,
    authorDate,
    commitDate,
    refs: refs.length === 0 ? [] : refs.split(", "),
  };
}

export function parseCommitDetailsMetadata(
  metadataOutput: string,
): LocalGitCommitSummary & { readonly parentShas: readonly string[] } {
  const metadataRecord = metadataOutput
    .split("\x01")
    .map((record) => record.trim())
    .find((record) => record.length > 0);
  if (metadataRecord === undefined) {
    throw new Error("Git returned no commit metadata.");
  }
  const [
    commitSha,
    shortSha,
    authorName,
    authorEmail,
    authorDate,
    commitDate,
    parentShas,
    subject,
  ] = metadataRecord.split("\0");
  if (
    commitSha === undefined ||
    shortSha === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authorDate === undefined ||
    commitDate === undefined ||
    parentShas === undefined ||
    subject === undefined
  ) {
    throw new Error("Git returned incomplete commit metadata.");
  }
  return {
    commitSha,
    shortSha,
    subject,
    authorName,
    authorEmail,
    authorDate,
    commitDate,
    refs: [],
    parentShas: parentShas.length === 0 ? [] : parentShas.split(" "),
  };
}

export function parseCommitFileChanges(
  numstatOutput: string,
  nameStatusOutput = "",
): readonly LocalGitCommitFileChange[] {
  const parsedFileChanges = numstatOutput.includes("\0")
    ? parseNulDelimitedNumstat(numstatOutput)
    : parseLineDelimitedNumstat(numstatOutput);
  if (nameStatusOutput.length === 0) return parsedFileChanges;
  const statusByPath = new Map(
    parseCommitNameStatus(nameStatusOutput).map((fileChange) => [
      fileChange.path,
      fileChange,
    ]),
  );
  const mergedFileChanges = parsedFileChanges.map((fileChange) => {
    const status = statusByPath.get(fileChange.path);
    if (status === undefined) return fileChange;
    statusByPath.delete(fileChange.path);
    return {
      ...fileChange,
      changeType:
        fileChange.changeType === "binary" ? "binary" : status.changeType,
      ...(status.previousPath === undefined
        ? {}
        : { previousPath: status.previousPath }),
    };
  });
  return [...mergedFileChanges, ...statusByPath.values()];
}

export function parseCommitNameStatus(
  nameStatusOutput: string,
): readonly LocalGitCommitFileChange[] {
  // This parser intentionally remains distinct from historyParsing's
  // history-only parser: commit details support both NUL and line-delimited
  // Git output and later merge these paths with numstat additions/deletions.
  if (nameStatusOutput.includes("\0")) {
    const records = nameStatusOutput.split("\0");
    const parsedChanges: LocalGitCommitFileChange[] = [];
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const statusRecord = records[recordIndex] ?? "";
      if (statusRecord.length === 0) continue;
      const statusSeparatorIndex = statusRecord.indexOf("\t");
      const statusCode =
        statusSeparatorIndex < 0
          ? statusRecord
          : statusRecord.slice(0, statusSeparatorIndex);
      if (statusCode[0] === "R" || statusCode[0] === "C") {
        const attachedPath =
          statusSeparatorIndex < 0
            ? undefined
            : statusRecord.slice(statusSeparatorIndex + 1);
        let previousPath =
          attachedPath === undefined ? records[++recordIndex] : attachedPath;
        let path = records[++recordIndex];
        if (attachedPath !== undefined && path === undefined) {
          const attachedPathSeparator = attachedPath.indexOf("\t");
          previousPath =
            attachedPathSeparator < 0
              ? attachedPath
              : attachedPath.slice(0, attachedPathSeparator);
          path =
            attachedPathSeparator < 0
              ? undefined
              : attachedPath.slice(attachedPathSeparator + 1);
        }
        if (previousPath !== undefined && path !== undefined) {
          parsedChanges.push({
            path: decodeGitPath(path),
            previousPath: decodeGitPath(previousPath),
            additions: 0,
            deletions: 0,
            changeType: statusCode[0] === "C" ? "copied" : "renamed",
          });
        }
        continue;
      }
      const path =
        statusSeparatorIndex < 0
          ? records[++recordIndex]
          : statusRecord.slice(statusSeparatorIndex + 1);
      if (path === undefined) continue;
      parsedChanges.push({
        path: decodeGitPath(path),
        additions: 0,
        deletions: 0,
        changeType:
          statusCode[0] === "A"
            ? "added"
            : statusCode[0] === "D"
              ? "deleted"
              : statusCode[0] === "T"
                ? "type-changed"
                : "modified",
      });
    }
    return parsedChanges;
  }
  return nameStatusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line): LocalGitCommitFileChange[] => {
      const statusSeparatorIndex = line.indexOf("\t");
      if (statusSeparatorIndex < 0) return [];
      const statusCode = line.slice(0, statusSeparatorIndex);
      const pathPayload = line.slice(statusSeparatorIndex + 1);
      const renamePathSeparator = pathPayload.indexOf("\t");
      const previousPath =
        renamePathSeparator < 0
          ? undefined
          : pathPayload.slice(0, renamePathSeparator);
      const currentPath =
        renamePathSeparator < 0
          ? undefined
          : pathPayload.slice(renamePathSeparator + 1);
      if (
        (statusCode[0] === "R" || statusCode[0] === "C") &&
        currentPath !== undefined
      ) {
        return [
          {
            path: decodeGitPath(currentPath),
            additions: 0,
            deletions: 0,
            changeType:
              statusCode[0] === "C"
                ? ("copied" as const)
                : ("renamed" as const),
            ...(previousPath === undefined
              ? {}
              : { previousPath: decodeGitPath(previousPath) }),
          },
        ];
      }
      return [
        {
          path: decodeGitPath(pathPayload),
          additions: 0,
          deletions: 0,
          changeType:
            statusCode[0] === "A"
              ? ("added" as const)
              : statusCode[0] === "D"
                ? ("deleted" as const)
                : statusCode[0] === "T"
                  ? ("type-changed" as const)
                  : ("modified" as const),
        },
      ];
    });
}

function parseNulDelimitedNumstat(
  numstatOutput: string,
): readonly LocalGitCommitFileChange[] {
  const records = numstatOutput.split("\0");
  const parsedChanges: LocalGitCommitFileChange[] = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const statRecord = records[recordIndex] ?? "";
    if (statRecord.length === 0) continue;
    const firstSeparatorIndex = statRecord.indexOf("\t");
    const secondSeparatorIndex = statRecord.indexOf(
      "\t",
      firstSeparatorIndex + 1,
    );
    if (firstSeparatorIndex < 0 || secondSeparatorIndex < 0) continue;
    const additionText = statRecord.slice(0, firstSeparatorIndex);
    const deletionText = statRecord.slice(
      firstSeparatorIndex + 1,
      secondSeparatorIndex,
    );
    const pathText = statRecord.slice(secondSeparatorIndex + 1);
    const isBinary = additionText === "-" || deletionText === "-";
    const additions = isBinary ? 0 : Number.parseInt(additionText, 10);
    const deletions = isBinary ? 0 : Number.parseInt(deletionText, 10);
    if (!isBinary && (Number.isNaN(additions) || Number.isNaN(deletions)))
      continue;
    if (pathText !== undefined && pathText.length > 0) {
      parsedChanges.push({
        path: decodeGitPath(pathText),
        additions,
        deletions,
        changeType: isBinary ? "binary" : "modified",
      });
      continue;
    }
    const previousPath = records[++recordIndex];
    const path = records[++recordIndex];
    if (previousPath === undefined || path === undefined) continue;
    parsedChanges.push({
      path: decodeGitPath(path),
      previousPath: decodeGitPath(previousPath),
      additions,
      deletions,
      changeType: "renamed",
    });
  }
  return parsedChanges;
}

function parseLineDelimitedNumstat(
  numstatOutput: string,
): readonly LocalGitCommitFileChange[] {
  return numstatOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [additionText, deletionText, ...pathParts] = line.split("\t");
      if (
        additionText === undefined ||
        deletionText === undefined ||
        pathParts.length === 0
      ) {
        return [];
      }
      const pathText = pathParts.join("\t");
      const renameSeparatorIndex = pathText.indexOf(" => ");
      const isRename = renameSeparatorIndex >= 0;
      const previousPath = isRename
        ? pathText.slice(0, renameSeparatorIndex)
        : undefined;
      const path = isRename
        ? pathText.slice(renameSeparatorIndex + " => ".length)
        : pathText;
      const isBinary = additionText === "-" || deletionText === "-";
      const additions = isBinary ? 0 : Number.parseInt(additionText, 10);
      const deletions = isBinary ? 0 : Number.parseInt(deletionText, 10);
      if (!isBinary && (Number.isNaN(additions) || Number.isNaN(deletions))) {
        return [];
      }
      return [
        {
          path: decodeGitPath(path),
          additions,
          deletions,
          changeType: isRename
            ? ("renamed" as const)
            : isBinary
              ? ("binary" as const)
              : ("modified" as const),
          ...(previousPath === undefined ? {} : { previousPath }),
        },
      ];
    });
}

export function normalizeAuthorEmails(
  authorEmails: readonly string[],
): ReadonlySet<string> {
  return new Set(
    authorEmails
      .map((authorEmail) => authorEmail.trim().toLowerCase())
      .filter((authorEmail) => authorEmail.length > 0),
  );
}

function createEmptyCommitActivitySnapshot(): CommitActivitySnapshot {
  return {
    days: new Map(),
    matchingCommitCount: 0,
    reachedSafetyCap: false,
    outputTruncated: false,
  };
}

function cloneCommitActivitySnapshot(
  snapshot: CommitActivitySnapshot,
): CommitActivitySnapshot {
  return {
    days: new Map(snapshot.days),
    matchingCommitCount: snapshot.matchingCommitCount,
    reachedSafetyCap: snapshot.reachedSafetyCap,
    outputTruncated: snapshot.outputTruncated,
  };
}

function throwIfGitHistoryCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new DOMException("Git history request cancelled", "AbortError");
}

function createCommitActivityCacheKey(
  rootBinding: GitRootBindingIdentity,
  headCommitSha: string,
  isShallowRepository: boolean,
  normalizedAuthorEmails: ReadonlySet<string>,
  activityWindow: CommitActivityWindow,
): string {
  return JSON.stringify([
    serializeGitRootBindingIdentity(rootBinding),
    headCommitSha,
    isShallowRepository,
    [...normalizedAuthorEmails].sort(),
    activityWindow.startDate,
    activityWindow.endDate,
  ]);
}

function serializeGitRootBindingIdentity(
  rootBinding: GitRootBindingIdentity,
): GitRootBindingIdentity {
  return {
    canonicalPath: rootBinding.canonicalPath,
    device: rootBinding.device,
    inode: rootBinding.inode,
    gitDirectory: {
      canonicalPath: rootBinding.gitDirectory.canonicalPath,
      device: rootBinding.gitDirectory.device,
      inode: rootBinding.gitDirectory.inode,
    },
    commonDirectory: {
      canonicalPath: rootBinding.commonDirectory.canonicalPath,
      device: rootBinding.commonDirectory.device,
      inode: rootBinding.commonDirectory.inode,
    },
  };
}

function isMissingHeadRevisionFailure(error: unknown): boolean {
  return (
    error instanceof GitCommandFailure &&
    error.exitCode === 128 &&
    /(?:ambiguous argument|unknown revision|bad revision).*HEAD/iu.test(
      error.standardError,
    )
  );
}

function assertNonNegativeInteger(
  numberValue: number,
  fieldName: string,
): void {
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new RangeError(`${fieldName} must be a non-negative integer.`);
  }
}

function assertCommitSha(commitSha: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) {
    throw new Error("Commit SHA must contain 7 to 64 hexadecimal characters.");
  }
}

function parseAzureRemoteBaseUrl(remoteUrl: string): string | undefined {
  const normalizedRemoteUrl = remoteUrl.trim().replace(/\/+$/u, "");
  const httpsRemoteMatch = normalizedRemoteUrl.match(
    /^https:\/\/dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+(?:\.git)?$/u,
  );
  if (httpsRemoteMatch !== null)
    return normalizedRemoteUrl.replace(/\.git$/u, "");

  const sshRemoteMatch = normalizedRemoteUrl.match(
    /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/u,
  );
  if (sshRemoteMatch === null) return undefined;
  const [, organizationName, projectName, repositoryName] = sshRemoteMatch;
  if (
    organizationName === undefined ||
    projectName === undefined ||
    repositoryName === undefined
  ) {
    return undefined;
  }
  return `https://dev.azure.com/${organizationName}/${projectName}/_git/${repositoryName}`;
}
