import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import type * as vscode from "vscode";
import { parseRawDiffMetadata } from "../diff/gitDiffParser.js";
import type { DiffFileMetadata } from "../diff/diffModels.js";
import {
  isAbortError,
  type GitCommandOutput,
  type GitCommandRunner,
  type GitRootBindingIdentity,
} from "../git/gitCommandRunner.js";
import type { GitRootBindingResolver } from "../git/gitRootBindingResolver.js";
import type {
  DiffUriFactory,
  DiffWorkingContentRootIdentity,
} from "../diff/gitDiffService.js";
import { parseCommitSummaryRecords } from "../git/gitHistoryService.js";
import { takeUtf8Prefix } from "../git/utf8.js";
import {
  countCompareFiles,
  defaultCompareOptions,
  normalizeCompareTarget,
  type CompareCommit,
  type CompareFileChange,
  type CompareFileStatus,
  type CompareMode,
  type CompareMultiDiffPlan,
  type CompareOptions,
  type CompareRequest,
  type CompareResult,
  type CompareTarget,
  type ResolvedCompareTarget,
} from "./compareModels.js";

const compareLogFormat = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%D%x01";
const mutableStateFingerprintMaxOutputBytes = 8 * 1024 * 1024;
const untrackedContentReadBufferBytes = 64 * 1024;

export class CompareRequestError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CompareRequestError";
  }
}

interface DiffCommandShape {
  readonly arguments: readonly string[];
  readonly invertResult: boolean;
  readonly hasDifference: boolean;
}

/** URI providers shared with the canonical diff URI-factory contract. */
export type CompareUriFactory = Pick<DiffUriFactory, "empty" | "symlink"> & {
  readonly beginSession: () => unknown;
  readonly workingContent: (
    filePath: string,
    repositoryRootPath: string,
    cancellationSignal?: AbortSignal,
    expectedRepositoryRootIdentity?: DiffWorkingContentRootIdentity,
    operationSession?: unknown,
  ) => Promise<vscode.Uri>;
};

interface ParsedCompareFile {
  readonly metadata: DiffFileMetadata;
}

interface ResolvedDiffOutput {
  readonly files: readonly CompareFileChange[];
  readonly truncated: boolean;
}

interface UntrackedRecordsOutput {
  readonly records: readonly ParsedCompareFile[];
  readonly truncated: boolean;
}

interface BoundedGitOutput extends GitCommandOutput {
  readonly truncated: boolean;
}

interface CommitSetPage {
  readonly commits: readonly CompareCommit[];
  readonly count: number;
  readonly truncated: boolean;
}

interface UntrackedFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly changeTimeNanoseconds: bigint;
  readonly modificationTimeNanoseconds: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly isSymbolicLink: boolean;
}

interface UntrackedParentIdentity {
  readonly path: string;
  readonly identity: UntrackedFileIdentity;
}

interface UntrackedParentBinding {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly parentIdentities: readonly UntrackedParentIdentity[];
}

export interface CompareRepositoryBinding {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly filesystemIdentity: RepositoryFilesystemIdentity;
  readonly rootBinding: GitRootBindingIdentity;
}

export interface RepositoryFilesystemIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

/** Read-only comparison foundation. Every Git argument is passed as an argv item. */
export class CompareService {
  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly uriFactory: CompareUriFactory,
    private readonly rootBindingResolver: GitRootBindingResolver,
  ) {}

  public async compare(
    request: CompareRequest,
    expectedRepositoryBinding?: CompareRepositoryBinding,
  ): Promise<CompareResult> {
    const workingContentSession = this.uriFactory.beginSession();
    const displayRepositoryRoot = request.repositoryRoot;
    const options = normalizeCompareOptions(request.options);
    const mode = request.mode ?? "common-base";
    assertCompareMode(mode);
    const repositoryRootBinding =
      expectedRepositoryBinding ??
      (await this.pinRepositoryBinding(
        request.repositoryRoot,
        request.cancellationSignal,
      ));
    await this.assertPinnedRepositoryRoot(
      request.repositoryRoot,
      repositoryRootBinding,
    );
    // Keep the display URI as the operation key. Git/filesystem reads resolve
    // this key through its pinned canonical binding on every call.
    const repositoryRoot = request.repositoryRoot;
    const left = await this.resolveTarget(
      repositoryRoot,
      normalizeCompareTarget(request.left),
      request.cancellationSignal,
      repositoryRootBinding,
    );
    const right = await this.resolveTarget(
      repositoryRoot,
      normalizeCompareTarget(request.right),
      request.cancellationSignal,
      repositoryRootBinding,
    );

    let commonBaseSha: string | undefined;
    if (mode === "common-base") {
      commonBaseSha = await this.resolveCommonBase(
        repositoryRoot,
        left,
        right,
        request.cancellationSignal,
        repositoryRootBinding,
      );
    }

    const leftCommitRange =
      commonBaseSha === undefined ? left.commitSha : commonBaseSha;
    const rightCommitRange =
      commonBaseSha === undefined ? right.commitSha : commonBaseSha;
    const hasMutableDirectEndpoint =
      mode === "direct" &&
      (left.commitSha === undefined || right.commitSha === undefined);
    const aheadRange = hasMutableDirectEndpoint
      ? undefined
      : rangeFor(right, leftCommitRange);
    const behindRange = hasMutableDirectEndpoint
      ? undefined
      : rangeFor(left, rightCommitRange);
    const [aheadCommitSet, behindCommitSet] = await Promise.all([
      aheadRange === undefined
        ? Promise.resolve<CommitSetPage>({
            commits: [],
            count: 0,
            truncated: false,
          })
        : this.listCommits(
            repositoryRoot,
            aheadRange,
            options.maxCommits,
            options.maxOutputBytes,
            request.cancellationSignal,
            repositoryRootBinding,
          ),
      behindRange === undefined
        ? Promise.resolve<CommitSetPage>({
            commits: [],
            count: 0,
            truncated: false,
          })
        : this.listCommits(
            repositoryRoot,
            behindRange,
            options.maxCommits,
            options.maxOutputBytes,
            request.cancellationSignal,
            repositoryRootBinding,
          ),
    ]);
    const aheadCommits = aheadCommitSet.commits;
    const behindCommits = behindCommitSet.commits;

    const [diffFrom, diffTo] = createDiffTargets(
      mode,
      commonBaseSha,
      left,
      right,
    );
    const diffOutput =
      mode === "common-base" && commonBaseSha !== undefined
        ? await this.getCommonBaseDiffFiles(
            repositoryRoot,
            displayRepositoryRoot,
            commonBaseSha,
            left,
            right,
            options,
            request.cancellationSignal,
            repositoryRootBinding,
            workingContentSession,
          )
        : await this.getDiffFiles(
            repositoryRoot,
            displayRepositoryRoot,
            diffFrom,
            diffTo,
            options,
            request.cancellationSignal,
            repositoryRootBinding,
            workingContentSession,
          );
    await this.assertPinnedRepositoryRoot(
      request.repositoryRoot,
      repositoryRootBinding,
    );
    throwIfCompareCancelled(request.cancellationSignal);
    const fileCounts = countCompareFiles(diffOutput.files);
    const multiDiffPlan = createMultiDiffPlan(
      diffFrom,
      diffTo,
      diffOutput.files,
      mode,
      left.target,
      right.target,
    );
    return {
      repositoryRoot: displayRepositoryRoot,
      mode,
      left,
      right,
      ...(commonBaseSha === undefined ? {} : { commonBaseSha }),
      aheadCount: aheadCommitSet.count,
      behindCount: behindCommitSet.count,
      aheadCommits,
      behindCommits,
      files: diffOutput.files,
      fileCounts,
      multiDiffPlan,
      truncated:
        diffOutput.truncated ||
        aheadCommitSet.truncated ||
        behindCommitSet.truncated,
    };
  }

  /** Validates and resolves a target without accepting arbitrary Git options. */
  public async resolveCompareTarget(
    repositoryRoot: vscode.Uri,
    target: CompareTarget | string,
    cancellationSignal?: AbortSignal,
  ): Promise<ResolvedCompareTarget> {
    const repositoryRootBinding = await this.pinRepositoryBinding(
      repositoryRoot,
      cancellationSignal,
    );
    const resolvedTarget = await this.resolveTarget(
      repositoryRoot,
      normalizeCompareTarget(target),
      cancellationSignal,
      repositoryRootBinding,
    );
    await this.assertPinnedRepositoryRoot(
      repositoryRoot,
      repositoryRootBinding,
    );
    return resolvedTarget;
  }

  public async assertRepositoryBinding(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
    expectedRepositoryBinding?: CompareRepositoryBinding,
  ): Promise<vscode.Uri> {
    const binding =
      expectedRepositoryBinding ??
      (await this.pinRepositoryBinding(repositoryRoot, cancellationSignal));
    await this.assertPinnedRepositoryRoot(repositoryRoot, binding);
    return repositoryRoot.with({
      path: binding.canonicalPath,
      query: "",
      fragment: "",
    });
  }

  /** Captures one immutable filesystem identity for one Git operation. */
  public async pinRepositoryBinding(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
  ): Promise<CompareRepositoryBinding> {
    const requestedPath = nodePath.resolve(repositoryRoot.fsPath);
    let canonicalRequestedPath: string;
    try {
      const rootBinding = await this.rootBindingResolver.resolve(
        requestedPath,
        undefined,
        {
          cancellationSignal,
        },
      );
      canonicalRequestedPath = rootBinding.canonicalPath;
      const filesystemIdentity = await readRepositoryFilesystemIdentity(
        canonicalRequestedPath,
      );
      const repositoryRootBinding: CompareRepositoryBinding = {
        requestedPath,
        canonicalPath: canonicalRequestedPath,
        filesystemIdentity,
        rootBinding: freezeGitRootBindingIdentity(rootBinding),
      };
      return await this.finishPinnedRepositoryBinding(
        repositoryRoot,
        cancellationSignal,
        repositoryRootBinding,
      );
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof CompareRequestError)
        throw error;
      throw new CompareRequestError(
        "Compare repository root is unavailable or changed.",
        { cause: error },
      );
    }
  }

  /** Runs a bounded-output Git stream under the pinned repository binding. */
  public async runStreaming(
    repositoryRoot: vscode.Uri,
    argumentsPassed: readonly string[],
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    if (cancellationSignal?.aborted) {
      throw new DOMException("Compare request cancelled", "AbortError");
    }
    assertCompareRepositoryPathMatchesBinding(
      repositoryRoot,
      repositoryRootBinding,
    );
    const output = await this.gitCommandRunner.runStreaming(
      {
        repositoryRoot: repositoryRootBinding.canonicalPath,
        rootBinding: repositoryRootBinding.rootBinding,
        arguments: argumentsPassed,
        cancellationSignal,
        collectStandardOutput: false,
      },
      onStandardOutputChunk,
    );
    throwIfCompareCancelled(cancellationSignal);
    return output;
  }

  private async finishPinnedRepositoryBinding(
    repositoryRoot: vscode.Uri,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<CompareRepositoryBinding> {
    const canonicalRequestedPath = repositoryRootBinding.canonicalPath;
    const output = await this.runGit(
      repositoryRoot,
      ["rev-parse", "--show-toplevel"],
      cancellationSignal,
      repositoryRootBinding,
    ).catch((error: unknown) => {
      if (isAbortError(error)) throw error;
      if (error instanceof CompareRequestError) throw error;
      throw new CompareRequestError("Selected path is not a Git repository.", {
        cause: error,
      });
    });
    const discoveredPath = output.standardOutput.trim();
    if (discoveredPath.length === 0) {
      throw new CompareRequestError("Selected path is not a Git repository.");
    }
    let canonicalDiscoveredPath = nodePath.resolve(discoveredPath);
    try {
      canonicalDiscoveredPath = await realpath(canonicalDiscoveredPath);
    } catch (error: unknown) {
      throw new CompareRequestError(
        "Git repository root could not be canonicalized.",
        { cause: error },
      );
    }
    if (!sameRepositoryPath(canonicalRequestedPath, canonicalDiscoveredPath)) {
      throw new CompareRequestError(
        "Compare request is bound to a different Git repository.",
      );
    }
    await this.assertPinnedRepositoryRoot(
      repositoryRoot,
      repositoryRootBinding,
    );
    return repositoryRootBinding;
  }

  public async getMutableStateFingerprint(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
    expectedRepositoryBinding?: CompareRepositoryBinding,
  ): Promise<string> {
    const repositoryRootBinding =
      expectedRepositoryBinding ??
      (await this.pinRepositoryBinding(repositoryRoot, cancellationSignal));
    await this.assertPinnedRepositoryRoot(
      repositoryRoot,
      repositoryRootBinding,
    );
    const [workingTreeOutput, indexOutput, untrackedOutput, trackedOutput] =
      await Promise.all([
        this.runBoundedGit(
          repositoryRoot,
          ["diff", "--no-ext-diff", "--no-textconv", "--raw", "-z"],
          mutableStateFingerprintMaxOutputBytes,
          cancellationSignal,
          repositoryRootBinding,
        ),
        this.runBoundedGit(
          repositoryRoot,
          ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--raw", "-z"],
          mutableStateFingerprintMaxOutputBytes,
          cancellationSignal,
          repositoryRootBinding,
        ),
        this.runBoundedGit(
          repositoryRoot,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          mutableStateFingerprintMaxOutputBytes,
          cancellationSignal,
          repositoryRootBinding,
        ),
        this.runBoundedGit(
          repositoryRoot,
          ["ls-files", "--cached", "-z"],
          mutableStateFingerprintMaxOutputBytes,
          cancellationSignal,
          repositoryRootBinding,
        ),
      ]);
    const [headOutput, refsOutput] = await Promise.all([
      this.runBoundedGit(
        repositoryRoot,
        ["rev-parse", "--verify", "HEAD"],
        mutableStateFingerprintMaxOutputBytes,
        cancellationSignal,
        repositoryRootBinding,
      ),
      this.runBoundedGit(
        repositoryRoot,
        ["for-each-ref", "--format=%(refname)%00%(objectname)"],
        mutableStateFingerprintMaxOutputBytes,
        cancellationSignal,
        repositoryRootBinding,
      ),
    ]);
    assertCompleteMutableStateFingerprintOutputs([
      workingTreeOutput,
      indexOutput,
      untrackedOutput,
      trackedOutput,
      headOutput,
      refsOutput,
    ]);
    const untrackedContentFingerprint = await this.hashUntrackedContent(
      untrackedOutput.standardOutput,
      cancellationSignal,
      repositoryRootBinding,
    );
    const trackedContentFingerprint = await this.hashTrackedContent(
      repositoryRoot,
      trackedOutput.standardOutput,
      cancellationSignal,
      repositoryRootBinding,
    );
    const fingerprint = createHash("sha256");
    updateMutableStateFingerprintHash(
      fingerprint,
      "working",
      workingTreeOutput,
    );
    updateMutableStateFingerprintHash(fingerprint, "index", indexOutput);
    updateMutableStateFingerprintHash(
      fingerprint,
      "untracked",
      untrackedOutput,
    );
    updateMutableStateFingerprintHash(fingerprint, "head", headOutput);
    updateMutableStateFingerprintHash(fingerprint, "refs", refsOutput);
    fingerprint.update("untracked-content\0");
    fingerprint.update(untrackedContentFingerprint);
    fingerprint.update("\0");
    fingerprint.update("tracked-content\0");
    fingerprint.update(trackedContentFingerprint);
    fingerprint.update("\0");
    await this.assertPinnedRepositoryRoot(
      repositoryRoot,
      repositoryRootBinding,
    );
    throwIfCompareCancelled(cancellationSignal);
    return fingerprint.digest("hex");
  }

  private async resolveTarget(
    repositoryRoot: vscode.Uri,
    target: CompareTarget,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<ResolvedCompareTarget> {
    if (target.kind === "working" || target.kind === "index") {
      return { target };
    }
    const revision = target.kind === "upstream" ? "@{upstream}" : target.ref;
    assertSafeCompareRef(revision);
    const output = await this.runGit(
      repositoryRoot,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      cancellationSignal,
      repositoryRootBinding,
    ).catch((error: unknown) => {
      if (isAbortError(error)) throw error;
      if (error instanceof CompareRequestError) throw error;
      throw new CompareRequestError(
        `Git reference '${revision}' does not resolve to a commit.`,
        { cause: error },
      );
    });
    const commitSha = output.standardOutput.trim().split(/\s+/)[0];
    if (commitSha === undefined || !/^[0-9a-f]{4,64}$/i.test(commitSha)) {
      throw new CompareRequestError(
        `Git reference '${revision}' returned an invalid commit SHA.`,
      );
    }
    return {
      target,
      commitSha,
      revision,
    };
  }

  private async resolveCommonBase(
    repositoryRoot: vscode.Uri,
    left: ResolvedCompareTarget,
    right: ResolvedCompareTarget,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<string | undefined> {
    if (left.commitSha !== undefined && right.commitSha !== undefined) {
      const output = await this.runGit(
        repositoryRoot,
        ["merge-base", "--all", left.commitSha, right.commitSha],
        cancellationSignal,
        repositoryRootBinding,
      ).catch((error: unknown) => {
        if (isAbortError(error)) throw error;
        if (error instanceof CompareRequestError) throw error;
        throw new CompareRequestError(
          "The selected refs do not have a common base.",
          { cause: error },
        );
      });
      const baseShas = output.standardOutput
        .trim()
        .split(/\r?\n/)
        .map((sha) => sha.trim())
        .filter((sha) => sha.length > 0);
      if (baseShas.length > 1) {
        throw new CompareRequestError(
          "The selected refs have multiple merge bases; comparison is ambiguous.",
        );
      }
      return baseShas[0];
    }
    if (left.commitSha !== undefined) return left.commitSha;
    if (right.commitSha !== undefined) return right.commitSha;
    const head = await this.resolveTarget(
      repositoryRoot,
      revisionTarget("HEAD"),
      cancellationSignal,
      repositoryRootBinding,
    );
    return head.commitSha;
  }

  private async listCommits(
    repositoryRoot: vscode.Uri,
    revisionRange: string,
    maxCommits: number,
    maxOutputBytes: number,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<CommitSetPage> {
    const [countOutput, output] = await Promise.all([
      this.runGit(
        repositoryRoot,
        ["rev-list", "--count", revisionRange],
        cancellationSignal,
        repositoryRootBinding,
      ),
      this.runBoundedGit(
        repositoryRoot,
        [
          "log",
          "--date=iso-strict",
          `--max-count=${maxCommits + 1}`,
          `--format=${compareLogFormat}`,
          revisionRange,
        ],
        maxOutputBytes,
        cancellationSignal,
        repositoryRootBinding,
      ),
    ]);
    const exactCount = Number.parseInt(countOutput.standardOutput.trim(), 10);
    if (!Number.isSafeInteger(exactCount) || exactCount < 0) {
      throw new CompareRequestError("Git returned an invalid commit count.");
    }
    const parsedCommits = parseCommitSummaryRecords(output.standardOutput);
    return {
      commits: parsedCommits
        .slice(0, maxCommits)
        .map((summary) => ({ ...summary, body: "", files: [] })),
      count: exactCount,
      truncated:
        parsedCommits.length > maxCommits ||
        output.truncated ||
        exactCount > maxCommits,
    };
  }

  private async getDiffFiles(
    repositoryRoot: vscode.Uri,
    displayRepositoryRoot: vscode.Uri,
    left: CompareTarget,
    right: CompareTarget,
    options: Required<CompareOptions>,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
    workingContentSession: unknown,
  ): Promise<ResolvedDiffOutput> {
    const diffCommand = createDiffCommand(left, right, options);
    if (!diffCommand.hasDifference) return { files: [], truncated: false };
    const rawOutput = await this.runBoundedGit(
      repositoryRoot,
      diffCommand.arguments,
      options.maxOutputBytes,
      cancellationSignal,
      repositoryRootBinding,
    );
    const numstatOutput = await this.runBoundedGit(
      repositoryRoot,
      replaceRawWithNumstat(diffCommand.arguments),
      options.maxOutputBytes,
      cancellationSignal,
      repositoryRootBinding,
    );
    const parsedDiff = parseRawDiffMetadata(
      discardIncompleteNulRecord(rawOutput.standardOutput),
      discardIncompleteNulRecord(numstatOutput.standardOutput),
      options.maxFiles + 1,
      options.maxOutputBytes,
    );
    const parsedRecords: ParsedCompareFile[] = parsedDiff.records.map(
      ({ metadata }) => ({ metadata }),
    );
    const untrackedResult = await this.getUntrackedRecords(
      repositoryRoot,
      left,
      right,
      options,
      cancellationSignal,
      repositoryRootBinding,
    );
    const canonicalRecords = [...parsedRecords, ...untrackedResult.records];
    const files: CompareFileChange[] = [];
    for (const { metadata } of canonicalRecords.slice(0, options.maxFiles)) {
      const orientedMetadata = diffCommand.invertResult
        ? invertMetadata(metadata)
        : metadata;
      await assertCompareMetadataPaths(
        repositoryRootBinding.canonicalPath,
        left,
        right,
        orientedMetadata,
      );
      files.push(
        await createCompareFileChange(
          displayRepositoryRoot,
          left,
          right,
          orientedMetadata,
          this.uriFactory,
          cancellationSignal,
          createWorkingContentRootIdentity(repositoryRootBinding),
          workingContentSession,
        ),
      );
      throwIfCompareCancelled(cancellationSignal);
    }
    return {
      files,
      truncated:
        parsedDiff.truncated ||
        rawOutput.truncated ||
        numstatOutput.truncated ||
        untrackedResult.truncated ||
        canonicalRecords.length > options.maxFiles,
    };
  }

  private async getCommonBaseDiffFiles(
    repositoryRoot: vscode.Uri,
    displayRepositoryRoot: vscode.Uri,
    commonBaseSha: string,
    left: ResolvedCompareTarget,
    right: ResolvedCompareTarget,
    options: Required<CompareOptions>,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
    workingContentSession: unknown,
  ): Promise<ResolvedDiffOutput> {
    const commonBaseTarget = revisionTarget(commonBaseSha);
    const [leftOutput, rightOutput] = await Promise.all([
      this.getDiffFiles(
        repositoryRoot,
        displayRepositoryRoot,
        commonBaseTarget,
        resolvedDiffTarget(left),
        options,
        cancellationSignal,
        repositoryRootBinding,
        workingContentSession,
      ),
      this.getDiffFiles(
        repositoryRoot,
        displayRepositoryRoot,
        commonBaseTarget,
        resolvedDiffTarget(right),
        options,
        cancellationSignal,
        repositoryRootBinding,
        workingContentSession,
      ),
    ]);
    const combinedFiles = [...leftOutput.files, ...rightOutput.files];
    return {
      files: combinedFiles.slice(0, options.maxFiles),
      truncated:
        leftOutput.truncated ||
        rightOutput.truncated ||
        combinedFiles.length > options.maxFiles,
    };
  }

  private async getUntrackedRecords(
    repositoryRoot: vscode.Uri,
    left: CompareTarget,
    right: CompareTarget,
    options: Required<CompareOptions>,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<UntrackedRecordsOutput> {
    if (left.kind !== "working" && right.kind !== "working") {
      return { records: [], truncated: false };
    }
    const output = await this.runBoundedGit(
      repositoryRoot,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options.maxOutputBytes,
      cancellationSignal,
      repositoryRootBinding,
    );
    const completeOutput = discardIncompleteNulRecord(output.standardOutput);
    const paths = completeOutput
      .split("\0")
      .filter((path) => path.length > 0)
      .slice(0, options.maxFiles + 1);
    const records: ParsedCompareFile[] = [];
    for (const relativePath of paths) {
      if (cancellationSignal?.aborted) {
        throw new DOMException("Compare request cancelled", "AbortError");
      }
      const absolutePath = resolveSafeComparePath(
        repositoryRootBinding.canonicalPath,
        relativePath,
      );
      const parentBinding = await captureComparePathParentBinding(
        repositoryRootBinding.canonicalPath,
        relativePath,
      );
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
      let isSymlink = false;
      try {
        isSymlink = (await lstat(absolutePath)).isSymbolicLink();
      } catch (error: unknown) {
        if (error instanceof CompareRequestError) throw error;
        // A file may disappear while Git is enumerating the working tree.
      }
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
      records.push({
        metadata: {
          changeType: "added",
          newPath: relativePath,
          additions: 0,
          deletions: 0,
          isBinary: false,
          isSubmodule: false,
          isSymlink,
        },
      });
    }
    return {
      records,
      truncated:
        output.truncated ||
        (output.standardOutput.length > 0 &&
          !output.standardOutput.endsWith("\0")) ||
        paths.length > options.maxFiles,
    };
  }

  private async hashUntrackedContent(
    nulSeparatedPaths: string,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<string> {
    if (nulSeparatedPaths.length > 0 && !nulSeparatedPaths.endsWith("\0")) {
      throw new CompareRequestError(
        "Untracked working-tree fingerprint output was incomplete.",
      );
    }
    const contentFingerprint = createHash("sha256");
    const completePathOutput = discardIncompleteNulRecord(nulSeparatedPaths);
    const relativePaths = completePathOutput
      .split("\0")
      .filter((relativePath) => relativePath.length > 0);
    for (const relativePath of relativePaths) {
      throwIfCompareCancelled(cancellationSignal);
      const filePath = resolveSafeComparePath(
        repositoryRootBinding.canonicalPath,
        relativePath,
      );
      const canonicalParentPath = await realpath(nodePath.dirname(filePath));
      if (
        !isPathWithinRoot(
          repositoryRootBinding.canonicalPath,
          canonicalParentPath,
        )
      ) {
        throw new CompareRequestError(
          `Git returned an untracked path through a parent outside repository root: '${relativePath}'.`,
        );
      }
      const canonicalFilePath = nodePath.join(
        canonicalParentPath,
        nodePath.basename(filePath),
      );
      const parentBinding = await captureUntrackedParentBinding(
        nodePath.dirname(filePath),
        repositoryRootBinding.canonicalPath,
        canonicalParentPath,
      );
      const fileStats = await lstat(canonicalFilePath, { bigint: true });
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
      const initialIdentity = createUntrackedFileIdentity(fileStats);
      contentFingerprint.update(relativePath);
      contentFingerprint.update("\0");
      contentFingerprint.update(String(fileStats.mode));
      contentFingerprint.update(":");
      contentFingerprint.update(String(fileStats.size));
      contentFingerprint.update("\0");
      if (fileStats.isSymbolicLink()) {
        contentFingerprint.update(await readlink(canonicalFilePath));
        const finalIdentity = createUntrackedFileIdentity(
          await lstat(canonicalFilePath, { bigint: true }),
        );
        assertUntrackedFileIdentityStable(
          initialIdentity,
          finalIdentity,
          relativePath,
        );
        await assertUntrackedParentIdentitiesStable(
          parentBinding,
          relativePath,
        );
      } else if (fileStats.isFile()) {
        await this.hashUntrackedRegularFile(
          canonicalFilePath,
          relativePath,
          initialIdentity,
          parentBinding,
          contentFingerprint,
          cancellationSignal,
        );
      } else {
        throw new CompareRequestError(
          `Git returned unsupported untracked path type: '${relativePath}'.`,
        );
      }
      contentFingerprint.update("\0");
    }
    return contentFingerprint.digest("hex");
  }

  private async hashTrackedContent(
    repositoryRoot: vscode.Uri,
    nulSeparatedPaths: string,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<string> {
    if (nulSeparatedPaths.length > 0 && !nulSeparatedPaths.endsWith("\0")) {
      throw new CompareRequestError(
        "Tracked working-tree fingerprint output was incomplete.",
      );
    }
    const contentFingerprint = createHash("sha256");
    const relativePaths = nulSeparatedPaths
      .split("\0")
      .filter((relativePath) => relativePath.length > 0);
    for (const relativePath of relativePaths) {
      throwIfCompareCancelled(cancellationSignal);
      const parentBinding = await captureComparePathParentBinding(
        repositoryRootBinding.canonicalPath,
        relativePath,
      );
      const filePath = resolveSafeComparePath(
        repositoryRootBinding.canonicalPath,
        relativePath,
      );
      const canonicalFilePath = nodePath.join(
        parentBinding.canonicalPath,
        nodePath.basename(filePath),
      );
      let fileStats: Awaited<ReturnType<typeof lstat>>;
      try {
        fileStats = await lstat(canonicalFilePath, { bigint: true });
      } catch (error: unknown) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw new CompareRequestError(
            `Tracked path '${relativePath}' became unavailable while fingerprinting.`,
            { cause: error },
          );
        }
        contentFingerprint.update(relativePath);
        contentFingerprint.update("\0missing\0");
        await assertUntrackedParentIdentitiesStable(
          parentBinding,
          relativePath,
        );
        continue;
      }

      contentFingerprint.update(relativePath);
      contentFingerprint.update("\0");
      contentFingerprint.update(String(fileStats.dev));
      contentFingerprint.update(":");
      contentFingerprint.update(String(fileStats.ino));
      contentFingerprint.update(":");
      contentFingerprint.update(String(fileStats.mode));
      contentFingerprint.update(":");
      contentFingerprint.update(String(fileStats.size));
      contentFingerprint.update(":");
      contentFingerprint.update(String(fileStats.mtimeNs));
      contentFingerprint.update(":");
      contentFingerprint.update(String(fileStats.ctimeNs));
      contentFingerprint.update("\0");
      const initialIdentity = createUntrackedFileIdentity(fileStats);
      if (fileStats.isSymbolicLink()) {
        const initialTarget = await readlink(canonicalFilePath);
        const currentStats = await lstat(canonicalFilePath, { bigint: true });
        const currentTarget = await readlink(canonicalFilePath);
        if (
          !sameCompareFileIdentity(
            initialIdentity,
            createUntrackedFileIdentity(currentStats),
          ) ||
          initialTarget !== currentTarget
        ) {
          throw new CompareRequestError(
            `Tracked symlink '${relativePath}' changed while fingerprinting.`,
          );
        }
        contentFingerprint.update("symlink\0");
        contentFingerprint.update(initialTarget);
      } else if (fileStats.isFile()) {
        contentFingerprint.update("regular\0");
        await this.hashUntrackedRegularFile(
          canonicalFilePath,
          relativePath,
          initialIdentity,
          parentBinding,
          contentFingerprint,
          cancellationSignal,
        );
      } else {
        contentFingerprint.update("special\0");
      }
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
    }
    await this.assertPinnedRepositoryRoot(
      repositoryRoot,
      repositoryRootBinding,
    );
    return contentFingerprint.digest("hex");
  }

  private async hashUntrackedRegularFile(
    canonicalFilePath: string,
    relativePath: string,
    initialIdentity: UntrackedFileIdentity,
    parentBinding: UntrackedParentBinding,
    contentFingerprint: ReturnType<typeof createHash>,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<void> {
    const fileContentDigest = createHash("sha256");
    const noFollowFlag = fsConstants.O_NOFOLLOW;
    if (noFollowFlag === undefined) {
      throw new CompareRequestError(
        "Untracked regular-file fingerprinting is unavailable on this platform.",
      );
    }
    const noFollowReadOnlyFlags = fsConstants.O_RDONLY | noFollowFlag;
    await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
    const fileHandle = await open(canonicalFilePath, noFollowReadOnlyFlags);
    try {
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
      const openedIdentity = createUntrackedFileIdentity(
        await fileHandle.stat({ bigint: true }),
      );
      assertUntrackedFileIdentityStable(
        initialIdentity,
        openedIdentity,
        relativePath,
      );
      const readBuffer = Buffer.allocUnsafe(untrackedContentReadBufferBytes);
      let bytesRead = 0n;
      while (true) {
        throwIfCompareCancelled(cancellationSignal);
        const readResult = await fileHandle.read(
          readBuffer,
          0,
          readBuffer.byteLength,
          null,
        );
        if (readResult.bytesRead === 0) break;
        const chunk = readBuffer.subarray(0, readResult.bytesRead);
        fileContentDigest.update(chunk);
        bytesRead += BigInt(readResult.bytesRead);
      }
      const closedIdentity = createUntrackedFileIdentity(
        await fileHandle.stat({ bigint: true }),
      );
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
      assertUntrackedFileIdentityStable(
        openedIdentity,
        closedIdentity,
        relativePath,
      );
      if (bytesRead !== closedIdentity.size) {
        throw new CompareRequestError(
          `Untracked file changed while it was being fingerprinted: '${relativePath}'.`,
        );
      }
      contentFingerprint.update(fileContentDigest.digest("hex"));
      const finalPathIdentity = createUntrackedFileIdentity(
        await lstat(canonicalFilePath, { bigint: true }),
      );
      assertUntrackedFileIdentityStable(
        closedIdentity,
        finalPathIdentity,
        relativePath,
      );
      await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
    } finally {
      await fileHandle.close();
    }
  }

  private async runGit(
    repositoryRoot: vscode.Uri,
    argumentsPassed: readonly string[],
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<GitCommandOutput> {
    if (cancellationSignal?.aborted) {
      throw new DOMException("Compare request cancelled", "AbortError");
    }
    assertCompareRepositoryPathMatchesBinding(
      repositoryRoot,
      repositoryRootBinding,
    );
    const output = await this.gitCommandRunner.run({
      repositoryRoot: repositoryRootBinding.canonicalPath,
      rootBinding: repositoryRootBinding.rootBinding,
      arguments: argumentsPassed,
      cancellationSignal,
    });
    throwIfCompareCancelled(cancellationSignal);
    return output;
  }

  private async runBoundedGit(
    repositoryRoot: vscode.Uri,
    argumentsPassed: readonly string[],
    maxOutputBytes: number,
    cancellationSignal: AbortSignal | undefined,
    repositoryRootBinding: CompareRepositoryBinding,
  ): Promise<BoundedGitOutput> {
    if (cancellationSignal?.aborted) {
      throw new DOMException("Compare request cancelled", "AbortError");
    }
    assertCompareRepositoryPathMatchesBinding(
      repositoryRoot,
      repositoryRootBinding,
    );
    const boundedController = new AbortController();
    const abortBoundedCommand = (): void => boundedController.abort();
    if (cancellationSignal !== undefined) {
      cancellationSignal.addEventListener("abort", abortBoundedCommand, {
        once: true,
      });
    }
    const outputChunks: string[] = [];
    let outputBytes = 0;
    let truncated = false;
    try {
      const output = await this.gitCommandRunner.runStreaming(
        {
          repositoryRoot: repositoryRootBinding.canonicalPath,
          rootBinding: repositoryRootBinding.rootBinding,
          arguments: argumentsPassed,
          cancellationSignal: boundedController.signal,
          collectStandardOutput: false,
        },
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
          outputBytes += Buffer.byteLength(boundedChunk, "utf8");
          truncated = true;
          boundedController.abort();
        },
      );
      throwIfCompareCancelled(cancellationSignal);
      const runnerOutputTruncated = isGitOutputTruncated(output);
      return {
        ...output,
        standardOutput: outputChunks.join(""),
        truncated: truncated || runnerOutputTruncated,
      };
    } catch (error: unknown) {
      if (cancellationSignal?.aborted) throw error;
      if (!truncated || !isAbortError(error)) throw error;
      throwIfCompareCancelled(cancellationSignal);
      return {
        standardOutput: outputChunks.join(""),
        standardError: "",
        exitCode: 0,
        standardOutputTruncated: true,
        truncated: true,
      };
    } finally {
      cancellationSignal?.removeEventListener("abort", abortBoundedCommand);
    }
  }

  /** Re-resolve and re-stat the selected path before every read. */
  public async assertPinnedRepositoryRoot(
    repositoryRoot: vscode.Uri,
    initialBinding: CompareRepositoryBinding,
  ): Promise<string> {
    const binding = initialBinding;
    const requestedPath = nodePath.resolve(repositoryRoot.fsPath);
    if (!sameRepositoryPath(binding.requestedPath, requestedPath)) {
      throw new CompareRequestError(
        "Compare repository binding does not match the requested repository.",
      );
    }
    try {
      const currentRootBinding = await this.rootBindingResolver.assert(
        binding.requestedPath,
        binding.rootBinding,
      );
      if (
        !sameGitRootBindingIdentity(currentRootBinding, binding.rootBinding)
      ) {
        throw new CompareRequestError(
          "Compare repository binding changed before Git could run.",
        );
      }
      const currentCanonicalPath = currentRootBinding.canonicalPath;
      if (!sameRepositoryPath(binding.canonicalPath, currentCanonicalPath)) {
        throw new CompareRequestError(
          "Compare repository binding changed before Git could run.",
        );
      }
      const currentFilesystemIdentity =
        await readRepositoryFilesystemIdentity(currentCanonicalPath);
      if (
        !sameFilesystemIdentity(
          binding.filesystemIdentity,
          currentFilesystemIdentity,
        )
      ) {
        throw new CompareRequestError(
          "Compare repository binding changed before Git could run.",
        );
      }
      return binding.canonicalPath;
    } catch {
      throw new CompareRequestError(
        "Compare repository binding changed before Git could run.",
      );
    }
  }
}

async function readRepositoryFilesystemIdentity(
  canonicalPath: string,
): Promise<RepositoryFilesystemIdentity> {
  try {
    const filesystemStats = await stat(canonicalPath, { bigint: true });
    return {
      device: filesystemStats.dev,
      inode: filesystemStats.ino,
    };
  } catch (error: unknown) {
    throw new CompareRequestError(
      "Compare repository root is unavailable or changed.",
      { cause: error },
    );
  }
}

function sameFilesystemIdentity(
  left: RepositoryFilesystemIdentity,
  right: RepositoryFilesystemIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function createUntrackedFileIdentity(fileStats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isSymbolicLink(): boolean;
}): UntrackedFileIdentity {
  return {
    device: fileStats.dev,
    inode: fileStats.ino,
    changeTimeNanoseconds: fileStats.ctimeNs,
    modificationTimeNanoseconds: fileStats.mtimeNs,
    mode: fileStats.mode,
    size: fileStats.size,
    isSymbolicLink: fileStats.isSymbolicLink(),
  };
}

async function captureUntrackedParentBinding(
  lexicalParentPath: string,
  canonicalRepositoryRoot: string,
  canonicalParentPath: string,
): Promise<UntrackedParentBinding> {
  const relativeParentPath = nodePath.relative(
    canonicalRepositoryRoot,
    canonicalParentPath,
  );
  if (!isPathWithinRoot(canonicalRepositoryRoot, canonicalParentPath)) {
    throw new CompareRequestError(
      "Git returned an untracked path through a parent outside repository root.",
    );
  }
  const parentPathParts =
    relativeParentPath.length === 0
      ? []
      : relativeParentPath.split(nodePath.sep);
  const parentIdentities: UntrackedParentIdentity[] = [];
  let currentParentPath = canonicalRepositoryRoot;
  for (const parentPathPart of ["", ...parentPathParts]) {
    if (parentPathPart.length > 0) {
      currentParentPath = nodePath.join(currentParentPath, parentPathPart);
    }
    const parentStats = await lstat(currentParentPath, { bigint: true });
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new CompareRequestError(
        "Untracked file parent is not a stable directory.",
      );
    }
    parentIdentities.push({
      path: currentParentPath,
      identity: createUntrackedFileIdentity(parentStats),
    });
  }
  return {
    lexicalPath: lexicalParentPath,
    canonicalPath: canonicalParentPath,
    parentIdentities,
  };
}

async function assertUntrackedParentIdentitiesStable(
  parentBinding: UntrackedParentBinding,
  relativePath: string,
): Promise<void> {
  try {
    const currentCanonicalParentPath = await realpath(
      parentBinding.lexicalPath,
    );
    if (currentCanonicalParentPath !== parentBinding.canonicalPath) {
      throw new Error("parent canonical path changed");
    }
    for (const parent of parentBinding.parentIdentities) {
      const currentParentStats = await lstat(parent.path, { bigint: true });
      if (!currentParentStats.isDirectory()) {
        throw new Error("parent is no longer a directory");
      }
      assertUntrackedFileIdentityStable(
        parent.identity,
        createUntrackedFileIdentity(currentParentStats),
        relativePath,
      );
    }
  } catch (error: unknown) {
    throw new CompareRequestError(
      `Untracked file parent changed while it was being fingerprinted: '${relativePath}'.`,
      { cause: error },
    );
  }
}

function assertUntrackedFileIdentityStable(
  initialIdentity: UntrackedFileIdentity,
  finalIdentity: UntrackedFileIdentity,
  relativePath: string,
): void {
  if (!sameCompareFileIdentity(initialIdentity, finalIdentity)) {
    throw new CompareRequestError(
      `Untracked file changed while it was being fingerprinted: '${relativePath}'.`,
    );
  }
}

function sameCompareFileIdentity(
  left: UntrackedFileIdentity,
  right: UntrackedFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.changeTimeNanoseconds === right.changeTimeNanoseconds &&
    left.modificationTimeNanoseconds === right.modificationTimeNanoseconds &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function sameGitRootBindingIdentity(
  left: GitRootBindingIdentity,
  right: GitRootBindingIdentity,
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    sameGitDirectoryBindingIdentity(left.gitDirectory, right.gitDirectory) &&
    sameGitDirectoryBindingIdentity(left.commonDirectory, right.commonDirectory)
  );
}

function freezeGitRootBindingIdentity(
  rootBinding: GitRootBindingIdentity,
): GitRootBindingIdentity {
  return Object.freeze({
    ...rootBinding,
    gitDirectory: Object.freeze({ ...rootBinding.gitDirectory }),
    commonDirectory: Object.freeze({ ...rootBinding.commonDirectory }),
  });
}

function sameGitDirectoryBindingIdentity(
  left: GitRootBindingIdentity["gitDirectory"],
  right: GitRootBindingIdentity["gitDirectory"],
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function updateMutableStateFingerprintHash(
  fingerprint: ReturnType<typeof createHash>,
  label: string,
  output: BoundedGitOutput,
): void {
  fingerprint.update(label);
  fingerprint.update("\0");
  fingerprint.update(output.standardOutput);
  fingerprint.update("\0");
  fingerprint.update(output.truncated ? "1" : "0");
  fingerprint.update("\0");
}

function assertCompleteMutableStateFingerprintOutputs(
  outputs: readonly BoundedGitOutput[],
): void {
  if (outputs.some((output) => output.truncated)) {
    throw new CompareRequestError(
      "Mutable-state fingerprint Git output was capped or truncated.",
    );
  }
}

function isGitOutputTruncated(output: GitCommandOutput): boolean {
  return (
    output.standardOutputTruncated === true ||
    output.standardErrorTruncated === true
  );
}

function throwIfCompareCancelled(
  cancellationSignal: AbortSignal | undefined,
): void {
  if (cancellationSignal?.aborted) {
    throw new DOMException("Compare request cancelled", "AbortError");
  }
}

export function assertSafeCompareRef(ref: string): void {
  if (
    ref.length === 0 ||
    ref.length > 4096 ||
    ref.startsWith("-") ||
    [...ref].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x20 ||
        codePoint === 0x7f ||
        "~^:?*[\\".includes(character)
      );
    }) ||
    ref.includes("..") ||
    ref.includes("//") ||
    (ref.includes("@{") && ref !== "@{upstream}") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref
      .split("/")
      .some(
        (component) => component.startsWith(".") || component.endsWith(".lock"),
      )
  ) {
    throw new CompareRequestError(`Unsafe Git reference '${ref}'.`);
  }
}

function normalizeCompareOptions(
  options: CompareOptions | undefined,
): Required<CompareOptions> {
  const normalized = { ...defaultCompareOptions, ...options };
  for (const [name, numberValue] of [
    ["maxCommits", normalized.maxCommits],
    ["maxFiles", normalized.maxFiles],
    ["maxOutputBytes", normalized.maxOutputBytes],
  ] as const) {
    if (!Number.isInteger(numberValue) || numberValue < 1) {
      throw new CompareRequestError(`${name} must be a positive integer.`);
    }
  }
  if (
    !Number.isInteger(normalized.renameSimilarityPercent) ||
    normalized.renameSimilarityPercent < 0 ||
    normalized.renameSimilarityPercent > 100
  ) {
    throw new CompareRequestError(
      "renameSimilarityPercent must be an integer from 0 to 100.",
    );
  }
  return normalized;
}

function assertCompareMode(mode: unknown): asserts mode is CompareMode {
  if (mode !== "common-base" && mode !== "direct") {
    throw new CompareRequestError(
      `Unsupported compare mode '${String(mode)}'.`,
    );
  }
}

function rangeFor(
  target: ResolvedCompareTarget,
  exclusionSha: string | undefined,
): string | undefined {
  if (target.commitSha === undefined) return undefined;
  return exclusionSha === undefined
    ? target.commitSha
    : `${exclusionSha}..${target.commitSha}`;
}

function revisionTarget(revision: string): CompareTarget {
  return { kind: "ref", ref: revision };
}

function resolvedDiffTarget(target: ResolvedCompareTarget): CompareTarget {
  if (target.commitSha === undefined) return target.target;
  return revisionTarget(target.commitSha);
}

function createDiffTargets(
  mode: CompareMode,
  commonBaseSha: string | undefined,
  left: ResolvedCompareTarget,
  right: ResolvedCompareTarget,
): readonly [CompareTarget, CompareTarget] {
  if (mode !== "common-base" || commonBaseSha === undefined) {
    return [resolvedDiffTarget(left), resolvedDiffTarget(right)];
  }
  // A mutable target has no commit SHA. In a common-base comparison it must
  // remain an endpoint; otherwise reversing HEAD ↔ working/index silently
  // drops the mutable side's changes.
  if (left.commitSha === undefined) {
    return [left.target, resolvedDiffTarget(right)];
  }
  return [revisionTarget(commonBaseSha), resolvedDiffTarget(right)];
}

function createDiffCommand(
  left: CompareTarget,
  right: CompareTarget,
  options: Required<CompareOptions>,
): DiffCommandShape {
  const argumentsPassed = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--raw",
    "-z",
    `--find-renames=${options.renameSimilarityPercent}`,
    `--find-copies=${options.renameSimilarityPercent}`,
    "--find-copies-harder",
  ];
  const leftRevision = revisionOf(left);
  const rightRevision = revisionOf(right);
  let invertResult = false;
  let hasDifference = true;
  if (left.kind === "working" && right.kind === "index") {
    invertResult = true;
  } else if (left.kind === "index" && right.kind === "working") {
    // Git's default diff is index -> working tree.
  } else if (left.kind === "index" && rightRevision !== undefined) {
    argumentsPassed.push("--cached", rightRevision);
    invertResult = true;
  } else if (leftRevision !== undefined && right.kind === "index") {
    argumentsPassed.push("--cached", leftRevision);
  } else if (left.kind === "working" && rightRevision !== undefined) {
    argumentsPassed.push(rightRevision);
    invertResult = true;
  } else if (leftRevision !== undefined && right.kind === "working") {
    argumentsPassed.push(leftRevision);
  } else if (leftRevision !== undefined && rightRevision !== undefined) {
    argumentsPassed.push(leftRevision, rightRevision);
  } else {
    hasDifference = false;
  }
  return { arguments: argumentsPassed, invertResult, hasDifference };
}

function revisionOf(target: CompareTarget): string | undefined {
  return target.kind === "ref" ? target.ref : undefined;
}

function replaceRawWithNumstat(
  argumentsPassed: readonly string[],
): readonly string[] {
  return argumentsPassed.map((argument) =>
    argument === "--raw" ? "--numstat" : argument,
  );
}

function invertMetadata(metadata: DiffFileMetadata): DiffFileMetadata {
  const { oldPath, newPath, oldMode, newMode, ...metadataWithoutDirection } =
    metadata;
  const invertedStatus: Record<CompareFileStatus, CompareFileStatus> = {
    added: "deleted",
    deleted: "added",
    modified: "modified",
    renamed: "renamed",
    copied: "copied",
    "type-changed": "type-changed",
    unmerged: "unmerged",
  };
  return {
    ...metadataWithoutDirection,
    changeType: invertedStatus[metadata.changeType],
    additions: metadata.deletions,
    deletions: metadata.additions,
    ...(oldPath === undefined && newPath === undefined
      ? {}
      : {
          ...(newPath === undefined ? {} : { oldPath: newPath }),
          ...(oldPath === undefined ? {} : { newPath: oldPath }),
        }),
    ...(newMode === undefined ? {} : { oldMode: newMode }),
    ...(oldMode === undefined ? {} : { newMode: oldMode }),
  };
}

async function createCompareFileChange(
  repositoryRoot: vscode.Uri,
  left: CompareTarget,
  right: CompareTarget,
  metadata: DiffFileMetadata,
  uriFactory: CompareUriFactory,
  cancellationSignal: AbortSignal | undefined,
  expectedWorkingContentRootIdentity: DiffWorkingContentRootIdentity,
  workingContentSession: unknown,
): Promise<CompareFileChange> {
  const path = metadata.newPath ?? metadata.oldPath;
  if (path === undefined)
    throw new CompareRequestError("Git returned a file without a path.");
  assertSafeCompareRelativePath(path);
  const originalPath = metadata.oldPath;
  const modifiedPath = metadata.newPath;
  if (originalPath !== undefined) assertSafeCompareRelativePath(originalPath);
  if (modifiedPath !== undefined) assertSafeCompareRelativePath(modifiedPath);
  const previousPath =
    (metadata.changeType === "renamed" || metadata.changeType === "copied") &&
    originalPath !== undefined &&
    modifiedPath !== undefined &&
    originalPath !== modifiedPath
      ? originalPath
      : undefined;
  const originalIsSymlink =
    metadata.oldMode === "120000" ||
    (metadata.changeType === "deleted" && metadata.isSymlink === true);
  const modifiedIsSymlink =
    metadata.newMode === "120000" ||
    (metadata.changeType === "added" && metadata.isSymlink === true);
  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    status: metadata.changeType,
    additions: metadata.additions,
    deletions: metadata.deletions,
    isBinary: metadata.isBinary,
    isSubmodule: metadata.isSubmodule,
    isSymlink: metadata.isSymlink,
    ...(metadata.similarityPercent === undefined
      ? {}
      : { similarityPercent: metadata.similarityPercent }),
    ...(metadata.oldMode === undefined ? {} : { oldMode: metadata.oldMode }),
    ...(metadata.newMode === undefined ? {} : { newMode: metadata.newMode }),
    ...(originalPath === undefined
      ? { originalUri: uriFactory.empty(path, "original") }
      : {
          originalUri: await createSourceUri(
            repositoryRoot,
            left,
            originalPath,
            originalIsSymlink,
            uriFactory,
            cancellationSignal,
            expectedWorkingContentRootIdentity,
            workingContentSession,
          ),
        }),
    ...(modifiedPath === undefined
      ? { modifiedUri: uriFactory.empty(path, "modified") }
      : {
          modifiedUri: await createSourceUri(
            repositoryRoot,
            right,
            modifiedPath,
            modifiedIsSymlink,
            uriFactory,
            cancellationSignal,
            expectedWorkingContentRootIdentity,
            workingContentSession,
          ),
        }),
  };
}

function createMultiDiffPlan(
  left: CompareTarget,
  right: CompareTarget,
  files: readonly CompareFileChange[],
  mode: CompareMode,
  displayLeft: CompareTarget = left,
  displayRight: CompareTarget = right,
): CompareMultiDiffPlan {
  const leftText = describeTarget(displayLeft);
  const rightText = describeTarget(displayRight);
  return {
    command: "vscode.changes",
    title: `Compare ${leftText} to ${rightText} (${mode})`,
    resources: files.map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.isSubmodule === true ? { isSubmodule: true } : {}),
      ...(file.isSymlink === true ? { isSymlink: true } : {}),
      ...(file.originalUri === undefined
        ? {}
        : { originalUri: file.originalUri }),
      ...(file.modifiedUri === undefined
        ? {}
        : { modifiedUri: file.modifiedUri }),
    })),
  };
}

function describeTarget(target: CompareTarget): string {
  switch (target.kind) {
    case "ref":
      return target.ref;
    case "upstream":
      return "upstream";
    case "working":
      return "working tree";
    case "index":
      return "index";
  }
}

async function createSourceUri(
  repositoryRoot: vscode.Uri,
  target: CompareTarget,
  relativePath: string,
  isSymlink = false,
  uriFactory: CompareUriFactory,
  cancellationSignal: AbortSignal | undefined,
  expectedWorkingContentRootIdentity: DiffWorkingContentRootIdentity,
  workingContentSession: unknown,
): Promise<vscode.Uri> {
  const fileUri = createFileUri(repositoryRoot, relativePath);
  if (target.kind === "working") {
    if (isSymlink)
      return uriFactory.symlink(fileUri.fsPath, repositoryRoot.fsPath);
    const canonicalWorkingFilePath = nodePath.join(
      expectedWorkingContentRootIdentity.canonicalPath,
      relativePath,
    );
    const workingContentUri = await uriFactory.workingContent(
      canonicalWorkingFilePath,
      expectedWorkingContentRootIdentity.canonicalPath,
      cancellationSignal,
      expectedWorkingContentRootIdentity,
      workingContentSession,
    );
    throwIfCompareCancelled(cancellationSignal);
    return workingContentUri;
  }
  const ref =
    target.kind === "index"
      ? ""
      : target.kind === "upstream"
        ? "@{upstream}"
        : target.ref;
  return fileUri.with({
    scheme: "git",
    query: JSON.stringify({ path: fileUri.fsPath, ref }),
  });
}

function createFileUri(
  repositoryRoot: vscode.Uri,
  relativePath: string,
): vscode.Uri {
  assertSafeCompareRelativePath(relativePath);
  const filePath = nodePath.join(repositoryRoot.fsPath, relativePath);
  return repositoryRoot.with({
    scheme: "file",
    path: filePath,
    query: "",
    fragment: "",
  });
}

function sameRepositoryPath(leftPath: string, rightPath: string): boolean {
  return (
    nodePath.normalize(leftPath).replace(/[\\/]$/, "") ===
    nodePath.normalize(rightPath).replace(/[\\/]$/, "")
  );
}

function createWorkingContentRootIdentity(
  repositoryRootBinding: CompareRepositoryBinding,
): DiffWorkingContentRootIdentity {
  return {
    canonicalPath: repositoryRootBinding.canonicalPath,
    device: repositoryRootBinding.filesystemIdentity.device,
    inode: repositoryRootBinding.filesystemIdentity.inode,
  };
}

export function assertSafeCompareRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    nodePath.posix.isAbsolute(relativePath) ||
    nodePath.win32.isAbsolute(relativePath) ||
    relativePath.split("/").some((pathComponent) => pathComponent === "..")
  ) {
    throw new CompareRequestError(
      `Git returned an unsafe compare path: '${relativePath}'.`,
    );
  }
}

function resolveSafeComparePath(
  canonicalRepositoryRoot: string,
  relativePath: string,
): string {
  assertSafeCompareRelativePath(relativePath);
  const absolutePath = nodePath.resolve(canonicalRepositoryRoot, relativePath);
  if (
    absolutePath === canonicalRepositoryRoot ||
    !isPathWithinRoot(canonicalRepositoryRoot, absolutePath)
  ) {
    throw new CompareRequestError(
      `Git returned an unsafe compare path outside repository root: '${relativePath}'.`,
    );
  }
  return absolutePath;
}

function isPathWithinRoot(
  canonicalRepositoryRoot: string,
  candidatePath: string,
): boolean {
  const relativePath = nodePath.relative(
    canonicalRepositoryRoot,
    candidatePath,
  );
  return (
    (relativePath.length === 0 || relativePath !== "..") &&
    !relativePath.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relativePath)
  );
}

async function captureComparePathParentBinding(
  canonicalRepositoryRoot: string,
  relativePath: string,
): Promise<UntrackedParentBinding> {
  const filePath = resolveSafeComparePath(
    canonicalRepositoryRoot,
    relativePath,
  );
  let canonicalParentPath: string;
  try {
    canonicalParentPath = await realpath(nodePath.dirname(filePath));
  } catch (error: unknown) {
    throw new CompareRequestError(
      `Git returned an untracked path with an unavailable parent: '${relativePath}'.`,
      { cause: error },
    );
  }
  if (!isPathWithinRoot(canonicalRepositoryRoot, canonicalParentPath)) {
    throw new CompareRequestError(
      `Git returned an unsafe compare path through a parent outside repository root: '${relativePath}'.`,
    );
  }
  return captureUntrackedParentBinding(
    nodePath.dirname(filePath),
    canonicalRepositoryRoot,
    canonicalParentPath,
  );
}

async function assertCompareMetadataPaths(
  canonicalRepositoryRoot: string,
  left: CompareTarget,
  right: CompareTarget,
  metadata: DiffFileMetadata,
): Promise<void> {
  for (const relativePath of [metadata.oldPath, metadata.newPath]) {
    if (relativePath !== undefined) {
      assertSafeCompareRelativePath(relativePath);
    }
  }
  if (left.kind === "working" && metadata.oldPath !== undefined) {
    await assertCompareWorkingPath(canonicalRepositoryRoot, metadata.oldPath);
  }
  if (right.kind === "working" && metadata.newPath !== undefined) {
    await assertCompareWorkingPath(canonicalRepositoryRoot, metadata.newPath);
  }
}

async function assertCompareWorkingPath(
  canonicalRepositoryRoot: string,
  relativePath: string,
): Promise<void> {
  const parentBinding = await captureComparePathParentBinding(
    canonicalRepositoryRoot,
    relativePath,
  );
  await assertUntrackedParentIdentitiesStable(parentBinding, relativePath);
}

function assertCompareRepositoryPathMatchesBinding(
  repositoryRoot: vscode.Uri,
  repositoryRootBinding: CompareRepositoryBinding,
): void {
  if (
    !sameRepositoryPath(
      nodePath.resolve(repositoryRoot.fsPath),
      repositoryRootBinding.requestedPath,
    )
  ) {
    throw new CompareRequestError(
      "Compare repository binding does not match the requested repository.",
    );
  }
}

/** Do not turn a byte-capped partial pathname into a fake changed file. */
function discardIncompleteNulRecord(output: string): string {
  if (output.length === 0 || output.endsWith("\0")) return output;
  const finalSeparator = output.lastIndexOf("\0");
  return finalSeparator < 0 ? "" : output.slice(0, finalSeparator + 1);
}
