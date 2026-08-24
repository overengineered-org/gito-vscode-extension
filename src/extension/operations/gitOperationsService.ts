import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAbortError,
  type GitDirectoryBindingIdentity,
  type GitCommandOutput,
  type GitCommandRunner,
  type GitRootBindingIdentity,
} from "../git/gitCommandRunner.js";
import type { GitRootBindingResolver } from "../git/gitRootBindingResolver.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import { getGitBranchNameValidationMessage } from "../git/gitRefName.js";
import {
  isCredentialQueryParameterName,
  redactGitErrorMessage,
} from "../git/gitErrorFormatting.js";
import { parseGitRemoteSyntax } from "../providers/remoteSyntax.js";
import type {
  BisectCommitRequest,
  BisectStartRequest,
  BranchRenameRequest,
  BranchUpstreamRequest,
  CleanPreviewRequest,
  FetchRequest,
  GitOperationConfirmation,
  GitOperationDependencies,
  GitOperationKind,
  GitOperationPostcondition,
  GitOperationPrecondition,
  GitOperationPreview,
  GitOperationRollbackReport,
  GitOperationRequestBase,
  GitOperationResult,
  GitResetMode,
  GitStateFingerprint,
  PatchApplyRequest,
  PatchCreateRequest,
  PullRequest,
  PushRequest,
  RefRequest,
  RebaseStartRequest,
  ReflogListRequest,
  ReflogRecoverRequest,
  RemoteAddRequest,
  RemoteRenameRequest,
  RemoteRequest,
  ResetRequest,
  StashBranchRequest,
  StashCreateRequest,
  StashReferenceRequest,
  TagCreateRequest,
  TagPushRequest,
  TagRequest,
  MergeRequest,
  GitOperationContentSummary,
  GitCleanCandidateBinding,
} from "./gitOperationTypes.js";

export const DEFAULT_PATCH_SIZE_CAP_BYTES = 5 * 1024 * 1024;
export const PENDING_OPERATION_TTL_MILLISECONDS = 5 * 60 * 1000;
export const MAX_PENDING_OPERATION_COUNT = 16;

export class GitOperationError extends Error {
  public readonly finalState: GitStateFingerprint | undefined;
  public readonly rollback: GitOperationRollbackReport | undefined;

  public constructor(
    public readonly operation: GitOperationKind | "repository",
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly finalState?: GitStateFingerprint | undefined;
      readonly rollback?: GitOperationRollbackReport | undefined;
    },
  ) {
    super(redactGitErrorMessage(message), options);
    this.name = "GitOperationError";
    this.finalState = options?.finalState;
    this.rollback = options?.rollback;
  }
}

interface OperationStateCheck {
  readonly preconditions: readonly GitOperationPrecondition[];
  readonly blocking: boolean;
}

interface PendingOperation {
  readonly operation: GitOperationKind;
  readonly commandArguments: readonly string[];
  readonly repositoryRoot: string;
  readonly requestedRepositoryRoot: string;
  readonly stateAtPreview: GitStateFingerprint;
  readonly rootBinding: GitRootBindingIdentity;
  readonly displayArguments: readonly string[];
  readonly destructive: boolean;
  readonly expectedPostcondition: string;
  readonly verifyPostcondition: (state: GitStateFingerprint) => boolean;
  readonly checkState: (state: GitStateFingerprint) => OperationStateCheck;
  readonly run?: (
    repositoryRoot: string,
    cancellationSignal: AbortSignal | undefined,
  ) => Promise<GitCommandOutput>;
  readonly rollback?: () => Promise<boolean>;
  readonly verifyReadback?: (
    repositoryRoot: string,
    cancellationSignal: AbortSignal | undefined,
  ) => Promise<boolean>;
  readonly verifyPinnedState?: (
    repositoryRoot: string,
    cancellationSignal: AbortSignal | undefined,
  ) => Promise<boolean>;
  readonly maxStandardOutputBytes?: number;
  readonly snapshotContent?: string;
  readonly contentSummary?: GitOperationContentSummary;
  readonly cleanCandidateBindings?: readonly GitCleanCandidateBinding[];
  readonly expiresAtMilliseconds: number;
}

interface RepositoryStateCommandOutput {
  readonly statusOutput: string;
  readonly repositoryRoot: string;
  readonly headCommit?: string;
  readonly headRef?: string;
  readonly gitDirectory: string;
}

interface PushTargetDetails {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly sourceRef?: string;
  readonly sourceCommit?: string;
  readonly destinationRef: string;
  readonly destinationCommit?: string;
  readonly deleting: boolean;
}

interface PullTargetDetails {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly remoteRef: string;
  readonly remoteSourceRef: string;
  readonly remoteCommit: string;
}

interface LocalRemoteBinding {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly parentCanonicalPath: string;
  readonly parentDevice: string;
  readonly parentInode: string;
}

interface PatchRollbackSnapshot {
  readonly stagedPatch: string;
  readonly unstagedPatch: string;
}

interface FetchTargetDetails {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly fetchRefspecs: readonly string[];
  readonly configuredFetchRefspecs: readonly string[];
  readonly pinConfiguredFetchRefspecs: boolean;
  readonly remoteRefs: readonly {
    readonly remoteRef: string;
    readonly remoteCommit: string;
    readonly localRef: string;
    readonly forceUpdate: boolean;
    readonly localObjectId?: string;
  }[];
}

interface RemoteConfigurationSnapshot {
  readonly fetchUrls: readonly string[];
  readonly pushUrls: readonly string[];
  readonly fetchRefspecs: readonly string[];
}

interface BranchConfigurationSnapshot {
  readonly entries: readonly {
    readonly key: string;
    readonly value: string;
  }[];
}

interface StashMutationLock {
  readonly rootBinding: GitRootBindingIdentity;
  readonly refPath: string;
  readonly refLockPath: string;
  readonly reflogPath: string;
  readonly reflogLockPath: string;
  readonly transactionPath: string;
  readonly zeroObjectId: string;
  readonly ownerToken: string;
  readonly refLockHandle: StashLockLease;
  readonly reflogLockHandle: StashLockLease;
}

interface StashLockLease {
  close(): Promise<void>;
}

interface StashMutationJournal {
  readonly version: 1;
  readonly ownerPid: number;
  readonly ownerToken: string;
  readonly phase: "prepared" | "reflog-applied" | "ref-applied";
  readonly refPath: string;
  readonly reflogPath: string;
  readonly reflogContent: string;
  readonly refContent?: string;
}

interface StashLockMetadata {
  readonly ownerPid: number;
  readonly ownerToken: string;
  readonly device?: string;
  readonly inode?: string;
}

interface BoundFilesystemBase {
  readonly path: string;
  readonly identity: GitDirectoryBindingIdentity;
}

interface BoundFilesystemOperation {
  readonly kind:
    | "access"
    | "link"
    | "read"
    | "read-stat"
    | "read-stat-any"
    | "remove"
    | "rename"
    | "sync-directory"
    | "write";
  readonly targetPath?: string;
  readonly sourcePath?: string;
  readonly destinationPath?: string;
  readonly content?: string;
  readonly expectedKind?: "file" | "directory" | "symlink";
  readonly expectedDevice?: string;
  readonly expectedInode?: string;
  readonly expectedDestinationExists?: boolean;
  readonly expectedDestinationDevice?: string;
  readonly expectedDestinationInode?: string;
}

interface BoundFilesystemResult {
  readonly content?: string;
  readonly device?: string;
  readonly inode?: string;
  readonly kind?: "file" | "directory" | "symlink";
  readonly parentFingerprint?: string;
  readonly exists?: boolean;
}

const executeBoundFilesystemWorker = promisify(execFile);

async function runBoundFilesystemOperation(
  base: BoundFilesystemBase,
  operation: BoundFilesystemOperation,
): Promise<BoundFilesystemResult> {
  const workerOutput = await executeBoundFilesystemWorker(
    process.execPath,
    ["-e", BOUND_FILESYSTEM_WORKER_SOURCE, JSON.stringify({ base, operation })],
    {
      cwd: base.path,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 5_000,
      killSignal: "SIGKILL",
    },
  );
  const stdoutText: string = workerOutput.stdout;
  return JSON.parse(stdoutText) as BoundFilesystemResult;
}

function selectBoundFilesystemBase(
  rootBinding: GitRootBindingIdentity,
  targetPath: string,
): BoundFilesystemBase {
  const candidateDirectories: readonly BoundFilesystemBase[] = [
    { path: rootBinding.canonicalPath, identity: rootBinding },
    {
      path: rootBinding.gitDirectory.canonicalPath,
      identity: rootBinding.gitDirectory,
    },
    {
      path: rootBinding.commonDirectory.canonicalPath,
      identity: rootBinding.commonDirectory,
    },
  ];
  const matchingDirectory = candidateDirectories
    .filter((candidate) => {
      const relativePath = nodePath.relative(candidate.path, targetPath);
      return (
        relativePath.length === 0 ||
        (!nodePath.isAbsolute(relativePath) &&
          relativePath !== ".." &&
          !relativePath.startsWith(`..${nodePath.sep}`))
      );
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (matchingDirectory === undefined)
    throw new Error("Bound filesystem path escaped captured directories.");
  return matchingDirectory;
}

async function boundFilesystemPathExists(
  rootBinding: GitRootBindingIdentity,
  filePath: string,
): Promise<boolean> {
  return (
    (
      await runBoundFilesystemOperation(
        selectBoundFilesystemBase(rootBinding, filePath),
        { kind: "access", targetPath: filePath },
      )
    ).exists === true
  );
}

const BOUND_FILESYSTEM_WORKER_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const payload = JSON.parse(process.argv[1]);
const base = payload.base;
const operation = payload.operation;
const basePath = process.cwd();
const expectedBaseIdentity = {
  device: base.identity.device,
  inode: base.identity.inode,
};
const identityOfPath = (filePath) => {
  const stats = fs.statSync(filePath, { bigint: true });
  return { device: String(stats.dev), inode: String(stats.ino) };
};
const sameIdentity = (actual, expected) =>
  actual.device === expected.device && actual.inode === expected.inode;
if (!sameIdentity(identityOfPath("."), expectedBaseIdentity))
  throw new Error("Bound filesystem base directory changed before access.");
const relativePath = (targetPath) => {
  const resolvedTarget = path.resolve(targetPath);
  const relativeTarget = path.relative(base.path, resolvedTarget);
  if (!relativeTarget || path.isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(".." + path.sep))
    throw new Error("Bound filesystem path escaped its directory binding.");
  return relativeTarget;
};
const openParent = (targetPath) => {
  const components = relativePath(targetPath).split(path.sep);
  const leaf = components.pop();
  if (!leaf) throw new Error("Bound filesystem leaf is missing.");
  process.chdir(basePath);
  if (!sameIdentity(identityOfPath("."), expectedBaseIdentity))
    throw new Error("Bound filesystem base directory changed during access.");
  for (const component of components) {
    const parentStats = fs.lstatSync(component, { bigint: true });
    if ((parentStats.mode & 0o170000n) !== 0o040000n || parentStats.isSymbolicLink())
      throw new Error("Bound filesystem parent is not a stable directory.");
    process.chdir(component);
    if (!sameIdentity(identityOfPath("."), {
      device: String(parentStats.dev),
      inode: String(parentStats.ino),
    }))
      throw new Error("Bound filesystem parent changed during traversal.");
  }
  return leaf;
};
const openDirectoryLeaf = (targetPath) => {
  const leaf = openParent(targetPath);
  const directoryStats = fs.lstatSync(leaf, { bigint: true });
  if ((directoryStats.mode & 0o170000n) !== 0o040000n || directoryStats.isSymbolicLink())
    throw new Error("Bound filesystem directory leaf is not a stable directory.");
  const directoryFlag = fs.constants.O_DIRECTORY;
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  if (directoryFlag === undefined || noFollowFlag === undefined)
    throw new Error("Bound filesystem directory access flags are unavailable.");
  const directoryHandle = fs.openSync(
    leaf,
    fs.constants.O_RDONLY | directoryFlag | noFollowFlag,
  );
  try {
    const openedDirectoryStats = fs.fstatSync(directoryHandle, { bigint: true });
    if (String(openedDirectoryStats.dev) !== String(directoryStats.dev) ||
        String(openedDirectoryStats.ino) !== String(directoryStats.ino))
      throw new Error("Bound filesystem directory leaf changed during access.");
    return directoryHandle;
  } catch (error) {
    fs.closeSync(directoryHandle);
    throw error;
  }
};
const openParentWithFingerprint = (targetPath) => {
  const components = relativePath(targetPath).split(path.sep);
  const leaf = components.pop();
  if (!leaf) throw new Error("Bound filesystem leaf is missing.");
  process.chdir(basePath);
  const parentParts = [
    "root:" + String(identityOfPath(".").device) + ":" + String(identityOfPath(".").inode),
  ];
  for (const component of components) {
    const parentStats = fs.lstatSync(component, { bigint: true });
    if ((parentStats.mode & 0o170000n) !== 0o040000n || parentStats.isSymbolicLink())
      throw new Error("Bound filesystem parent is not a stable directory.");
    process.chdir(component);
    const enteredStats = fs.statSync(".", { bigint: true });
    if (!sameIdentity({ device: String(enteredStats.dev), inode: String(enteredStats.ino) }, {
      device: String(parentStats.dev), inode: String(parentStats.ino),
    })) throw new Error("Bound filesystem parent changed during traversal.");
    parentParts.push(component + ":" + String(parentStats.dev) + ":" + String(parentStats.ino));
  }
  return { leaf, parentFingerprint: parentParts.join("/") };
};
const checkExpectedLeaf = (leafStats) => {
  if (operation.expectedDevice !== undefined && String(leafStats.dev) !== operation.expectedDevice)
    throw new Error("Bound filesystem leaf identity changed.");
  if (operation.expectedInode !== undefined && String(leafStats.ino) !== operation.expectedInode)
    throw new Error("Bound filesystem leaf identity changed.");
};
const regularLeafPath = (leafPath) => {
  const leafStats = fs.lstatSync(leafPath, { bigint: true });
  if ((leafStats.mode & 0o170000n) !== 0o100000n || leafStats.isSymbolicLink())
    throw new Error("Bound filesystem leaf is not a regular non-symlink file.");
  return leafStats;
};
const checkExpectedDestination = (destinationPath) => {
  let destinationStats;
  try { destinationStats = regularLeafPath(destinationPath); }
  catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    if (operation.expectedDestinationExists === true)
      throw new Error("Bound filesystem destination identity changed.");
    return;
  }
  if (operation.expectedDestinationExists === false)
    throw new Error("Bound filesystem destination identity changed.");
  if (operation.expectedDestinationExists === true &&
      (String(destinationStats.dev) !== operation.expectedDestinationDevice ||
       String(destinationStats.ino) !== operation.expectedDestinationInode))
    throw new Error("Bound filesystem destination identity changed.");
};
let result = {};
if (operation.kind === "link" || operation.kind === "rename") {
    if (path.dirname(relativePath(operation.sourcePath)) !== path.dirname(relativePath(operation.destinationPath)))
      throw new Error("Bound filesystem rename/link parents differ.");
    const source = openParent(operation.sourcePath);
    const destination = openParent(operation.destinationPath);
    regularLeafPath(source);
    if (operation.kind === "link") {
      try { regularLeafPath(destination); }
      catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
      fs.linkSync(source, destination);
    } else {
      checkExpectedDestination(destination);
      fs.renameSync(source, destination);
    }
  } else if (operation.kind === "sync-directory") {
    const directoryHandle = openDirectoryLeaf(operation.targetPath);
    try {
      fs.fsyncSync(directoryHandle);
    } catch (error) {
      if (process.platform !== "win32" || !error || !["EINVAL", "EBADF", "EPERM"].includes(error.code))
        throw error;
    } finally {
      fs.closeSync(directoryHandle);
    }
  } else if (operation.kind === "read-stat-any") {
    const parent = openParentWithFingerprint(operation.targetPath);
    const targetStats = fs.lstatSync(parent.leaf, { bigint: true });
    const mode = targetStats.mode & 0o170000n;
    const kind = targetStats.isSymbolicLink()
      ? "symlink"
      : mode === 0o040000n
        ? "directory"
        : mode === 0o100000n
          ? "file"
          : "special";
    if (kind === "special") throw new Error("Bound filesystem candidate is special.");
    result.device = String(targetStats.dev);
    result.inode = String(targetStats.ino);
    result.kind = kind;
    result.parentFingerprint = parent.parentFingerprint;
  } else {
    const target = openParent(operation.targetPath);
    if (operation.kind === "access") {
      try { fs.accessSync(target); result.exists = true; }
      catch (error) {
        if (error && error.code === "ENOENT") result.exists = false;
        else throw error;
      }
    } else if (operation.kind === "read") {
      regularLeafPath(target);
      const targetHandle = fs.openSync(
        target,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      try { result.content = fs.readFileSync(targetHandle, "utf8"); }
      finally { fs.closeSync(targetHandle); }
    } else if (operation.kind === "read-stat") {
      regularLeafPath(target);
      const targetHandle = fs.openSync(
        target,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        const targetStats = fs.fstatSync(targetHandle, { bigint: true });
        result.device = String(targetStats.dev);
        result.inode = String(targetStats.ino);
        result.content = fs.readFileSync(targetHandle, "utf8");
      } finally { fs.closeSync(targetHandle); }
    } else if (operation.kind === "write") {
      try { regularLeafPath(target); }
      catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
      const targetHandle = fs.openSync(
        target,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      try { fs.writeFileSync(targetHandle, operation.content || "", "utf8"); fs.fsyncSync(targetHandle); }
      finally { fs.closeSync(targetHandle); }
    } else if (operation.kind === "remove") {
      const targetStats = regularLeafPath(target);
      checkExpectedLeaf(targetStats);
      fs.unlinkSync(target);
    }
  }
  if (!sameIdentity(identityOfPath(basePath), expectedBaseIdentity))
    throw new Error("Bound filesystem base directory changed after access.");
process.stdout.write(JSON.stringify(result));
`;

/**
 * Safe, UI-independent local Git operation boundary.
 *
 * Every mutating call is two-phase: create a typed preview, then execute it
 * with that preview's confirmation token. Execution re-reads the repository
 * root and state fingerprint before invoking the fixed argument array.
 */
export class GitOperationsService {
  private readonly pendingOperations = new Map<string, PendingOperation>();
  private readonly rootBindingContext =
    new AsyncLocalStorage<GitRootBindingIdentity>();
  private readonly commandRunner: GitCommandRunner;
  private readonly gitRootBindingResolver: GitRootBindingResolver;
  private readonly beforeBoundFilesystemRename:
    ((destinationPath: string) => Promise<void>) | undefined;
  private readonly beforeBoundFilesystemSyncDirectory:
    ((directoryPath: string) => Promise<void>) | undefined;
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly workspaceTrustGuard: {
    isWorkspaceTrusted(): boolean;
    assertTrusted(operationName: string): void;
  };

  public constructor(dependencies: GitOperationDependencies) {
    this.commandRunner = dependencies.commandRunner;
    this.gitRootBindingResolver = dependencies.gitRootBindingResolver;
    this.beforeBoundFilesystemRename = dependencies.beforeBoundFilesystemRename;
    this.beforeBoundFilesystemSyncDirectory =
      dependencies.beforeBoundFilesystemSyncDirectory;
    this.now = dependencies.now ?? (() => new Date());
    this.randomToken = dependencies.randomToken ?? (() => cryptoRandomToken());
    this.workspaceTrustGuard = dependencies.workspaceTrustGuard;
  }

  public async previewStashCreate(
    request: StashCreateRequest,
  ): Promise<GitOperationPreview> {
    if (request.partial === true)
      throw new GitOperationError(
        "stash.create",
        "Partial stash requires an interactive hunk selector; provide exact pathspecs instead.",
      );
    const stashArguments = ["stash", "push"];
    if (request.includeUntracked) stashArguments.push("--include-untracked");
    if (request.keepIndex) stashArguments.push("--keep-index");
    if (request.message !== undefined) {
      assertSafeText(request.message, "stash message");
      stashArguments.push("--message", request.message);
    }
    appendPathspecs(stashArguments, request.pathspecs);
    return this.prepareOperation(
      "stash.create",
      request,
      stashArguments,
      true,
      "Create a stash entry from the current worktree.",
      "A new stash entry exists or Git reports that there was nothing to stash.",
      (state) => this.checkNoConflicts(state),
      (state) => !state.hasConflicts,
    );
  }

  public previewStashList(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.prepareOperation(
      "stash.list",
      request,
      ["stash", "list", "--format=%gd%x00%H%x00%gs"],
      false,
      "List stash entries.",
      "The returned output is the current stash list.",
      () => satisfiedChecks(),
      () => true,
    );
  }

  public async previewStashInspect(
    request: StashReferenceRequest,
  ): Promise<GitOperationPreview> {
    assertStashReference(request.stashReference);
    const stashCommit = await this.resolveStashCommit(request);
    return this.prepareOperation(
      "stash.inspect",
      request,
      ["stash", "show", "--stat", "--patch", stashCommit],
      false,
      `Inspect ${request.stashReference}.`,
      "The stash remains unchanged and its contents are returned.",
      () => satisfiedChecks(),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.stashReferenceStillPinned(
          repositoryRoot,
          request.stashReference,
          stashCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewStashApply(
    request: StashReferenceRequest,
  ): Promise<GitOperationPreview> {
    assertStashReference(request.stashReference);
    const stashCommit = await this.resolveStashCommit(request);
    return this.prepareOperation(
      "stash.apply",
      request,
      ["stash", "apply", stashCommit],
      true,
      `Apply ${request.stashReference} without deleting it.`,
      "The worktree contains the stash changes and the stash entry remains.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.stashEntryExistsByCommit(
          repositoryRoot,
          stashCommit,
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        this.stashReferenceStillPinned(
          repositoryRoot,
          request.stashReference,
          stashCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewStashPop(
    request: StashReferenceRequest,
  ): Promise<GitOperationPreview> {
    assertStashReference(request.stashReference);
    const stashCommit = await this.resolveStashCommit(request);
    return this.prepareOperation(
      "stash.pop",
      request,
      ["stash", "pop", stashCommit],
      true,
      `Apply and remove ${request.stashReference}.`,
      "The worktree contains the stash changes and the selected stash entry is removed.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.popStashEntryByCommit(
          repositoryRoot,
          stashCommit,
          cancellationSignal,
        ),
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        !(await this.stashEntryExistsByCommit(
          repositoryRoot,
          stashCommit,
          cancellationSignal,
        )),
      async (repositoryRoot, cancellationSignal) =>
        this.stashReferenceStillPinned(
          repositoryRoot,
          request.stashReference,
          stashCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewStashDrop(
    request: StashReferenceRequest,
  ): Promise<GitOperationPreview> {
    assertStashReference(request.stashReference);
    const stashCommit = await this.resolveStashCommit(request);
    return this.prepareOperation(
      "stash.drop",
      request,
      ["stash", "drop", stashCommit],
      true,
      `Delete ${request.stashReference}.`,
      "The selected stash entry no longer exists.",
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.dropStashEntryByCommit(
          repositoryRoot,
          stashCommit,
          cancellationSignal,
        ),
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        !(await this.stashEntryExistsByCommit(
          repositoryRoot,
          stashCommit,
          cancellationSignal,
        )),
      async (repositoryRoot, cancellationSignal) =>
        this.stashReferenceStillPinned(
          repositoryRoot,
          request.stashReference,
          stashCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewStashBranch(
    request: StashBranchRequest,
  ): Promise<GitOperationPreview> {
    assertStashReference(request.stashReference);
    assertBranchName(request.branchName);
    const stashCommit = await this.resolveStashCommit(request);
    return this.prepareOperation(
      "stash.branch",
      request,
      ["stash", "branch", request.branchName, stashCommit],
      true,
      `Create ${request.branchName} from ${request.stashReference}.`,
      `Branch ${request.branchName} exists with the stash changes applied.`,
      (state) => this.checkCleanAndNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.commandExists(
          repositoryRoot,
          [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${request.branchName}`,
          ],
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        this.stashReferenceStillPinned(
          repositoryRoot,
          request.stashReference,
          stashCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewTagCreate(
    request: TagCreateRequest,
  ): Promise<GitOperationPreview> {
    assertTagName(request.tagName);
    if (request.signed === true)
      throw new GitOperationError(
        "tag.create",
        "Signed tag intent is unsupported; no signed tag will be created or reported as verified.",
      );
    if (request.target !== undefined) assertCommitish(request.target);
    const targetCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.target ?? "HEAD",
      request.cancellationSignal,
    );
    const tagArguments = ["tag"];
    if (request.force) tagArguments.push("--force");
    if (request.annotatedMessage !== undefined) {
      assertSafeText(request.annotatedMessage, "tag message");
      tagArguments.push(
        "--annotate",
        request.tagName,
        "--message",
        request.annotatedMessage,
      );
    } else {
      tagArguments.push(request.tagName);
    }
    tagArguments.push(targetCommit);
    return this.prepareOperation(
      "tag.create",
      request,
      tagArguments,
      true,
      `Create tag ${request.tagName}.`,
      `Tag ${request.tagName} resolves to the requested commit.`,
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyTagPostcondition(
          repositoryRoot,
          request.tagName,
          targetCommit,
          request.annotatedMessage !== undefined,
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        this.isCommitishPinned(
          repositoryRoot,
          request.target ?? "HEAD",
          targetCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewTagDelete(
    request: TagRequest,
  ): Promise<GitOperationPreview> {
    assertTagName(request.tagName);
    const tagObject = await this.resolveRefObject(
      request.repositoryRoot,
      `refs/tags/${request.tagName}`,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "tag.delete",
      request,
      ["update-ref", "-d", `refs/tags/${request.tagName}`, tagObject],
      true,
      `Delete tag ${request.tagName}.`,
      `Tag ${request.tagName} does not exist locally.`,
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        !(await this.commandExists(
          repositoryRoot,
          ["show-ref", "--verify", "--quiet", `refs/tags/${request.tagName}`],
          cancellationSignal,
        )),
      async (repositoryRoot, cancellationSignal) =>
        this.isRefObjectPinned(
          repositoryRoot,
          `refs/tags/${request.tagName}`,
          tagObject,
          cancellationSignal,
        ),
    );
  }

  public async previewTagPush(
    request: TagPushRequest,
  ): Promise<GitOperationPreview> {
    assertTagName(request.tagName);
    assertRemoteName(request.remoteName);
    const localTagObject = await this.resolveRefObject(
      request.repositoryRoot,
      `refs/tags/${request.tagName}`,
      request.cancellationSignal,
    );
    const remoteUrl = await this.readRemoteUrl(
      request.repositoryRoot,
      request.remoteName,
      true,
      request.cancellationSignal,
    );
    const remoteTagObject = await this.resolveRemoteUrlRefCommit(
      request.repositoryRoot,
      remoteUrl,
      `refs/tags/${request.tagName}`,
      request.cancellationSignal,
    );
    const localRemoteBinding = await captureLocalRemoteBinding(
      request.repositoryRoot,
      remoteUrl,
    );
    return this.prepareOperation(
      "tag.push",
      request,
      ["push", remoteUrl, `${localTagObject}:refs/tags/${request.tagName}`],
      true,
      `Push tag ${request.tagName} to ${request.remoteName}.`,
      `Remote ${request.remoteName} has tag ${request.tagName} at the same commit.`,
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        await this.assertLocalRemoteBindings(
          localRemoteBinding === undefined ? [] : [localRemoteBinding],
          cancellationSignal,
        );
        return this.runGit(
          repositoryRoot,
          ["push", remoteUrl, `${localTagObject}:refs/tags/${request.tagName}`],
          cancellationSignal,
        );
      },
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        try {
          const remoteTagOutput = (
            await this.runGit(
              repositoryRoot,
              [
                "ls-remote",
                remoteUrl,
                `refs/tags/${request.tagName}`,
                `refs/tags/${request.tagName}^{}`,
              ],
              cancellationSignal,
            )
          ).standardOutput;
          return (
            remoteTagOutput
              .split(/\r?\n/)
              .some((line) =>
                new RegExp(
                  `^${localTagObject}\\s+refs/tags/${escapeRegExp(request.tagName)}(?:\\^\\{\\})?$`,
                ).test(line.trim()),
              ) &&
            (await this.commandOutputMatches(
              repositoryRoot,
              ["remote", "get-url", "--push", "--all", request.remoteName],
              remoteUrl,
              cancellationSignal,
            ))
          );
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          return false;
        }
      },
      async (repositoryRoot, cancellationSignal) =>
        (await this.isRefObjectPinned(
          repositoryRoot,
          `refs/tags/${request.tagName}`,
          localTagObject,
          cancellationSignal,
        )) &&
        (await this.commandOutputMatches(
          repositoryRoot,
          ["remote", "get-url", "--push", "--all", request.remoteName],
          remoteUrl,
          cancellationSignal,
        )) &&
        (await this.resolveRemoteUrlRefCommit(
          repositoryRoot,
          remoteUrl,
          `refs/tags/${request.tagName}`,
          cancellationSignal,
        )) === remoteTagObject,
    );
  }

  public async previewMerge(
    request: MergeRequest,
  ): Promise<GitOperationPreview> {
    assertCommitish(request.commitish);
    const targetCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.commitish,
      request.cancellationSignal,
    );
    const mergeArguments = ["merge", "--no-edit"];
    if (request.mode === "ff") mergeArguments.push("--ff");
    if (request.mode === "no-ff") mergeArguments.push("--no-ff");
    if (request.mode === "ff-only") mergeArguments.push("--ff-only");
    mergeArguments.push("--", targetCommit);
    return this.prepareOperation(
      "merge",
      request,
      mergeArguments,
      true,
      `Merge ${request.commitish} into the current branch.`,
      "HEAD contains the merged commit and no unresolved conflict remains.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts && state.inProgressOperation === undefined,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.isAncestorOfHead(repositoryRoot, targetCommit, cancellationSignal),
      async (repositoryRoot, cancellationSignal) =>
        this.isCommitishPinned(
          repositoryRoot,
          request.commitish,
          targetCommit,
          cancellationSignal,
        ),
      undefined,
    );
  }

  public async previewCherryPick(
    request: RefRequest,
  ): Promise<GitOperationPreview> {
    assertCommitish(request.commitish);
    const targetCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.commitish,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "cherry-pick",
      request,
      ["cherry-pick", "--no-edit", "--", targetCommit],
      true,
      `Cherry-pick ${request.commitish}.`,
      "HEAD contains the cherry-picked change and no unresolved conflict remains.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts && state.inProgressOperation === undefined,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.isCommitishPinned(
          repositoryRoot,
          request.commitish,
          targetCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewRevert(
    request: RefRequest,
  ): Promise<GitOperationPreview> {
    assertCommitish(request.commitish);
    const targetCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.commitish,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "revert",
      request,
      ["revert", "--no-edit", "--", targetCommit],
      true,
      `Revert ${request.commitish}.`,
      "HEAD contains the revert commit and no unresolved conflict remains.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts && state.inProgressOperation === undefined,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.isCommitishPinned(
          repositoryRoot,
          request.commitish,
          targetCommit,
          cancellationSignal,
        ),
    );
  }

  public previewMergeContinue(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.previewConflictContinuation(request, "merge", "continue");
  }

  public previewMergeAbort(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.previewConflictContinuation(request, "merge", "abort");
  }

  public previewCherryPickContinue(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.previewConflictContinuation(request, "cherry-pick", "continue");
  }

  public previewCherryPickAbort(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.previewConflictContinuation(request, "cherry-pick", "abort");
  }

  public previewRevertContinue(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.previewConflictContinuation(request, "revert", "continue");
  }

  public previewRevertAbort(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    return this.previewConflictContinuation(request, "revert", "abort");
  }

  public async previewReset(
    request: ResetRequest,
  ): Promise<GitOperationPreview> {
    assertCommitish(request.commitish);
    const resetFlag = resetModeFlag(request.mode);
    const resolvedTargetCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.commitish,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "reset",
      request,
      ["reset", resetFlag, resolvedTargetCommit],
      true,
      `Reset ${request.mode} to ${request.commitish}.`,
      `HEAD resolves to ${request.commitish}; the selected reset mode is applied.`,
      (state) => this.checkCleanAndNoConflicts(state),
      (state) =>
        state.headCommit === resolvedTargetCommit && !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.isCommitishPinned(
          repositoryRoot,
          request.commitish,
          resolvedTargetCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewRebaseStart(
    request: RebaseStartRequest,
  ): Promise<GitOperationPreview> {
    assertCommitish(request.upstream);
    const upstreamCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.upstream,
      request.cancellationSignal,
    );
    if (request.onto !== undefined) assertCommitish(request.onto);
    const ontoCommit =
      request.onto === undefined
        ? undefined
        : await this.resolveCommitish(
            request.repositoryRoot,
            request.onto,
            request.cancellationSignal,
          );
    const originalBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    const rebaseArguments = ["rebase"];
    if (ontoCommit !== undefined) {
      rebaseArguments.push("--onto", ontoCommit);
    }
    rebaseArguments.push(upstreamCommit);
    if (request.branchName !== undefined) {
      assertBranchName(request.branchName);
      rebaseArguments.push(request.branchName);
    }
    return this.prepareOperation(
      "rebase.start",
      request,
      rebaseArguments,
      true,
      `Rebase onto ${request.onto ?? request.upstream}.`,
      "The rebase completes or leaves an explicit rebase-in-progress state for continue, skip, or abort.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) =>
        !state.hasConflicts &&
        (state.inProgressOperation === undefined ||
          state.inProgressOperation === "rebase"),
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyRebaseReadback(
          repositoryRoot,
          originalBranch,
          ontoCommit ?? upstreamCommit,
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        this.verifyRebaseRefs(
          repositoryRoot,
          request.upstream,
          upstreamCommit,
          request.onto,
          ontoCommit,
          cancellationSignal,
        ),
      undefined,
    );
  }

  public async previewRebaseContinue(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    const expectedBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "rebase.continue",
      request,
      ["rebase", "--continue"],
      true,
      "Continue the in-progress rebase.",
      "The rebase advances or completes without unresolved conflicts.",
      (state) => this.checkRebaseInProgress(state, false),
      (state) => !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyRebaseActionReadback(
          repositoryRoot,
          expectedBranch,
          "continue",
          cancellationSignal,
        ),
    );
  }

  public async previewRebaseSkip(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    const expectedBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "rebase.skip",
      request,
      ["rebase", "--skip"],
      true,
      "Skip the current rebase commit.",
      "The rebase advances or completes without unresolved conflicts.",
      (state) => this.checkRebaseInProgress(state, true),
      (state) => !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyRebaseActionReadback(
          repositoryRoot,
          expectedBranch,
          "skip",
          cancellationSignal,
        ),
    );
  }

  public async previewRebaseAbort(
    request: GitOperationRequestBase,
  ): Promise<GitOperationPreview> {
    const expectedBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "rebase.abort",
      request,
      ["rebase", "--abort"],
      true,
      "Abort the in-progress rebase.",
      "The repository returns to the pre-rebase branch state.",
      (state) => this.checkRebaseInProgress(state, true),
      (state) => !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyRebaseActionReadback(
          repositoryRoot,
          expectedBranch,
          "abort",
          cancellationSignal,
        ),
    );
  }

  public async previewBranchRename(
    request: BranchRenameRequest,
  ): Promise<GitOperationPreview> {
    assertBranchName(request.newBranchName);
    if (request.oldBranchName !== undefined)
      assertBranchName(request.oldBranchName);
    const oldBranchName =
      request.oldBranchName ??
      (await this.resolveCurrentBranch(
        request.repositoryRoot,
        request.cancellationSignal,
      ));
    if (oldBranchName === undefined)
      throw new GitOperationError(
        "branch.rename",
        "A branch rename requires an attached source branch.",
      );
    if (oldBranchName === request.newBranchName)
      throw new GitOperationError(
        "branch.rename",
        "The old and new branch names must differ.",
      );
    const oldBranchCommit = await this.resolveCommitish(
      request.repositoryRoot,
      `refs/heads/${oldBranchName}`,
      request.cancellationSignal,
    );
    const zeroObjectId = await this.resolveZeroObjectId(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    const oldBranchRef = `refs/heads/${oldBranchName}`;
    const newBranchRef = `refs/heads/${request.newBranchName}`;
    if (
      (await this.resolveOptionalRefObject(
        request.repositoryRoot,
        newBranchRef,
        request.cancellationSignal,
      )) !== undefined
    )
      throw new GitOperationError(
        "branch.rename",
        `Branch ${request.newBranchName} already exists; refusing to overwrite it.`,
      );
    const currentHeadRef = await this.tryRunGit(
      request.repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      request.cancellationSignal,
    );
    const originalHeadRef = currentHeadRef?.standardOutput.trim() || undefined;
    const originalHeadCommit = await this.resolveCommitish(
      request.repositoryRoot,
      "HEAD",
      request.cancellationSignal,
    );
    const oldBranchWasCurrent = originalHeadRef === oldBranchName;
    const oldBranchConfiguration = await this.readBranchConfiguration(
      request.repositoryRoot,
      oldBranchName,
      request.cancellationSignal,
    );
    const branchRenameMessage = `branch: renamed ${oldBranchName} to ${request.newBranchName}`;
    const branchRenameArguments = [
      "update-ref",
      "--stdin",
      "-m",
      branchRenameMessage,
    ];
    return this.prepareOperation(
      "branch.rename",
      request,
      branchRenameArguments,
      true,
      `Rename branch to ${request.newBranchName}.`,
      `The branch is named ${request.newBranchName}.`,
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        const transactionInput = [
          "start",
          `update ${newBranchRef} ${oldBranchCommit} ${zeroObjectId}`,
          `delete ${oldBranchRef} ${oldBranchCommit}`,
          "prepare",
          "commit",
          "",
        ].join("\n");
        const refOutput = await this.runGitWithStandardInput(
          repositoryRoot,
          branchRenameArguments,
          transactionInput,
          cancellationSignal,
        );
        let standardOutput = refOutput.standardOutput;
        let standardError = refOutput.standardError;
        if (oldBranchConfiguration.entries.length > 0) {
          const configOutput = await this.runGit(
            repositoryRoot,
            [
              "config",
              "--local",
              "--rename-section",
              `branch.${oldBranchName}`,
              `branch.${request.newBranchName}`,
            ],
            cancellationSignal,
          );
          standardOutput += configOutput.standardOutput;
          standardError += configOutput.standardError;
        }
        if (oldBranchWasCurrent) {
          const headOutput = await this.runGit(
            repositoryRoot,
            ["symbolic-ref", "HEAD", newBranchRef],
            cancellationSignal,
          );
          standardOutput += headOutput.standardOutput;
          standardError += headOutput.standardError;
        }
        return {
          standardOutput,
          standardError,
          exitCode: 0,
        };
      },
      async () =>
        this.rollbackBranchRename(
          request.repositoryRoot,
          oldBranchName,
          request.newBranchName,
          oldBranchCommit,
          zeroObjectId,
          originalHeadRef,
          originalHeadCommit,
          oldBranchConfiguration,
        ),
      async (repositoryRoot, cancellationSignal) =>
        (await this.isCommitishPinned(
          repositoryRoot,
          newBranchRef,
          oldBranchCommit,
          cancellationSignal,
        )) &&
        !(await this.commandExists(
          repositoryRoot,
          ["show-ref", "--verify", "--quiet", oldBranchRef],
          cancellationSignal,
        )) &&
        (!oldBranchWasCurrent ||
          (await this.commandOutputMatches(
            repositoryRoot,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            request.newBranchName,
            cancellationSignal,
          ))) &&
        (await this.branchConfigurationMatches(
          repositoryRoot,
          request.newBranchName,
          renameBranchConfiguration(
            oldBranchConfiguration,
            oldBranchName,
            request.newBranchName,
          ),
          cancellationSignal,
        )),
      async (repositoryRoot, cancellationSignal) =>
        (await this.isCommitishPinned(
          repositoryRoot,
          oldBranchRef,
          oldBranchCommit,
          cancellationSignal,
        )) &&
        (await this.branchConfigurationMatches(
          repositoryRoot,
          oldBranchName,
          oldBranchConfiguration,
          cancellationSignal,
        )) &&
        (await this.branchConfigurationMatches(
          repositoryRoot,
          request.newBranchName,
          { entries: [] },
          cancellationSignal,
        )),
    );
  }

  public previewBranchUpstream(
    request: BranchUpstreamRequest,
  ): Promise<GitOperationPreview> {
    assertRemoteName(request.remoteName);
    assertBranchName(request.branchName);
    const upstreamArguments = request.setUpstream
      ? [
          "branch",
          `--set-upstream-to=${request.remoteName}/${request.branchName}`,
          request.branchName,
        ]
      : ["branch", "--unset-upstream", request.branchName];
    return this.prepareOperation(
      "branch.upstream",
      request,
      upstreamArguments,
      true,
      request.setUpstream
        ? `Set ${request.branchName} upstream to ${request.remoteName}/${request.branchName}.`
        : `Unset ${request.branchName} upstream.`,
      "The branch upstream configuration matches the requested value.",
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.branchUpstreamConfigurationMatches(
          repositoryRoot,
          request.branchName,
          request.setUpstream
            ? {
                remote: request.remoteName,
                merge: `refs/heads/${request.branchName}`,
              }
            : undefined,
          cancellationSignal,
        ),
    );
  }

  public previewRemoteAdd(
    request: RemoteAddRequest,
  ): Promise<GitOperationPreview> {
    assertRemoteName(request.remoteName);
    assertRemoteUrl(request.remoteUrl);
    const remoteArguments = ["remote", "add"];
    if (request.fetchOnly) remoteArguments.push("--no-tags");
    remoteArguments.push(request.remoteName, request.remoteUrl);
    return this.prepareOperation(
      "remote.add",
      request,
      remoteArguments,
      true,
      `Add remote ${request.remoteName}.`,
      `Remote ${request.remoteName} exists with the supplied URL (credentials redacted in diagnostics).`,
      (state) => this.checkNoConflicts(state),
      () => true,
      [
        "remote",
        "add",
        ...(request.fetchOnly ? ["--no-tags"] : []),
        request.remoteName,
        redactGitErrorMessage(request.remoteUrl),
      ],
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.commandOutputMatches(
          repositoryRoot,
          ["remote", "get-url", request.remoteName],
          request.remoteUrl,
          cancellationSignal,
        ),
    );
  }

  public async previewRemoteRename(
    request: RemoteRenameRequest,
  ): Promise<GitOperationPreview> {
    assertRemoteName(request.remoteName);
    assertRemoteName(request.newRemoteName);
    const remoteConfiguration = await this.readRemoteConfiguration(
      request.repositoryRoot,
      request.remoteName,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "remote.rename",
      request,
      ["remote", "rename", request.remoteName, request.newRemoteName],
      true,
      `Rename remote ${request.remoteName} to ${request.newRemoteName}.`,
      `Remote ${request.newRemoteName} exists with its URLs and refspecs preserved.`,
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        (await this.commandExists(
          repositoryRoot,
          ["remote", "get-url", request.newRemoteName],
          cancellationSignal,
        )) &&
        !(await this.commandExists(
          repositoryRoot,
          ["remote", "get-url", request.remoteName],
          cancellationSignal,
        )) &&
        (await this.remoteConfigurationMatches(
          repositoryRoot,
          request.newRemoteName,
          renameRemoteConfiguration(
            remoteConfiguration,
            request.remoteName,
            request.newRemoteName,
          ),
          cancellationSignal,
        )),
      async (repositoryRoot, cancellationSignal) =>
        this.remoteConfigurationMatches(
          repositoryRoot,
          request.remoteName,
          remoteConfiguration,
          cancellationSignal,
        ),
    );
  }

  public async previewRemoteRemove(
    request: RemoteRequest,
  ): Promise<GitOperationPreview> {
    assertRemoteName(request.remoteName);
    const remoteConfiguration = await this.readRemoteConfiguration(
      request.repositoryRoot,
      request.remoteName,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "remote.remove",
      request,
      ["remote", "remove", request.remoteName],
      true,
      `Remove remote ${request.remoteName} and its local remote-tracking refs.`,
      `Remote ${request.remoteName} no longer exists locally.`,
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        !(await this.commandExists(
          repositoryRoot,
          ["remote", "get-url", request.remoteName],
          cancellationSignal,
        )),
      async (repositoryRoot, cancellationSignal) =>
        this.remoteConfigurationMatches(
          repositoryRoot,
          request.remoteName,
          remoteConfiguration,
          cancellationSignal,
        ),
    );
  }

  public async previewRemotePrune(
    request: RemoteRequest,
  ): Promise<GitOperationPreview> {
    assertRemoteName(request.remoteName);
    const remoteConfiguration = await this.readRemoteConfiguration(
      request.repositoryRoot,
      request.remoteName,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "remote.prune",
      request,
      ["remote", "prune", request.remoteName],
      true,
      `Prune stale refs for ${request.remoteName}.`,
      "No stale remote-tracking refs remain for the remote.",
      (state) => this.checkNoConflicts(state),
      () => true,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        try {
          const dryRunOutput = await this.runGit(
            repositoryRoot,
            ["remote", "prune", "--dry-run", request.remoteName],
            cancellationSignal,
          );
          return !/\[would prune\]/i.test(dryRunOutput.standardOutput);
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          return false;
        }
      },
      async (repositoryRoot, cancellationSignal) =>
        this.remoteConfigurationMatches(
          repositoryRoot,
          request.remoteName,
          remoteConfiguration,
          cancellationSignal,
        ),
    );
  }

  public async previewFetch(
    request: FetchRequest,
  ): Promise<GitOperationPreview> {
    if (request.remoteName !== undefined) assertRemoteName(request.remoteName);
    if (request.refspec !== undefined) {
      assertSafeText(request.refspec, "fetch refspec");
      assertNotOption(request.refspec, "fetch refspec");
    }
    if (request.all && request.remoteName !== undefined)
      throw new GitOperationError(
        "fetch",
        "Choose all remotes or one remote, not both.",
      );
    if (request.all && request.refspec !== undefined)
      throw new GitOperationError(
        "fetch",
        "A fetch refspec cannot be combined with --all.",
      );
    const fetchTargets = await this.resolveFetchTargets(request);
    const firstFetchTarget = fetchTargets[0];
    if (firstFetchTarget === undefined)
      throw new GitOperationError("fetch", "No fetch target was resolved.");
    const fetchCommandSequences = fetchTargets.map((fetchTarget) =>
      this.buildExactFetchArguments(fetchTarget, request.prune === true),
    );
    const fetchArguments = fetchCommandSequences[0];
    if (fetchArguments === undefined)
      throw new GitOperationError("fetch", "No fetch command was resolved.");
    const localRemoteBindings = await captureLocalRemoteBindings(
      request.repositoryRoot,
      fetchTargets.map((fetchTarget) => fetchTarget.remoteUrl),
    );
    return this.prepareOperation(
      "fetch",
      request,
      fetchArguments,
      true,
      request.all
        ? "Fetch all remotes."
        : `Fetch ${request.remoteName ?? "the default remote"}.`,
      "Local remote-tracking refs reflect the requested fetch.",
      (state) => this.checkNoConflicts(state),
      (state) => !state.hasConflicts,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        const commandOutputs: GitCommandOutput[] = [];
        for (const commandArguments of fetchCommandSequences) {
          await this.assertLocalRemoteBindings(
            localRemoteBindings,
            cancellationSignal,
          );
          commandOutputs.push(
            await this.runGit(
              repositoryRoot,
              commandArguments,
              cancellationSignal,
            ),
          );
        }
        return {
          standardOutput: commandOutputs
            .map((commandOutput) => commandOutput.standardOutput)
            .join(""),
          standardError: commandOutputs
            .map((commandOutput) => commandOutput.standardError)
            .join(""),
          exitCode: commandOutputs.at(-1)?.exitCode ?? 0,
        };
      },
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyFetchReadback(
          repositoryRoot,
          fetchTargets,
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        this.verifyFetchPinnedSources(
          repositoryRoot,
          fetchTargets,
          cancellationSignal,
        ),
      undefined,
      undefined,
      undefined,
      undefined,
      fetchCommandSequences,
    );
  }

  public async previewPull(request: PullRequest): Promise<GitOperationPreview> {
    if (request.remoteName !== undefined) assertRemoteName(request.remoteName);
    if (request.branchName !== undefined) assertBranchName(request.branchName);
    if (request.remoteName === undefined && request.branchName !== undefined)
      throw new GitOperationError(
        "pull",
        "A pull branch requires an explicit remote name.",
      );
    const pullTarget = await this.resolvePullTarget(request);
    const integrationMode = request.mode ?? "merge";
    const pullArguments = [
      "fetch",
      "--no-tags",
      pullTarget.remoteUrl,
      `${pullTarget.remoteCommit}:${pullTarget.remoteRef}`,
    ];
    const integrationArguments =
      integrationMode === "rebase"
        ? ["rebase", pullTarget.remoteCommit]
        : [
            "merge",
            "--no-edit",
            ...(integrationMode === "ff-only" ? ["--ff-only"] : []),
            pullTarget.remoteCommit,
          ];
    const localRemoteBinding = await captureLocalRemoteBinding(
      request.repositoryRoot,
      pullTarget.remoteUrl,
    );
    return this.prepareOperation(
      "pull",
      request,
      pullArguments,
      true,
      `Pull with ${request.mode ?? "configured"} integration.`,
      "The local branch incorporates the requested upstream and has no unresolved conflict.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        await this.assertLocalRemoteBindings(
          localRemoteBinding === undefined ? [] : [localRemoteBinding],
          cancellationSignal,
        );
        const fetchOutput = await this.runGit(
          repositoryRoot,
          [
            "fetch",
            "--no-tags",
            pullTarget.remoteUrl,
            `${pullTarget.remoteCommit}:${pullTarget.remoteRef}`,
          ],
          cancellationSignal,
        );
        const fetchedHead = await this.resolveOptionalRefObject(
          repositoryRoot,
          "FETCH_HEAD",
          cancellationSignal,
        );
        if (fetchedHead !== pullTarget.remoteCommit)
          throw new GitOperationError(
            "pull",
            "FETCH_HEAD did not match the pinned remote object; integration was not started.",
          );
        const integrationOutput = await this.runGit(
          repositoryRoot,
          integrationArguments,
          cancellationSignal,
        );
        return {
          standardOutput: `${fetchOutput.standardOutput}${integrationOutput.standardOutput}`,
          standardError: `${fetchOutput.standardError}${integrationOutput.standardError}`,
          exitCode: integrationOutput.exitCode,
        };
      },
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        try {
          const headCommit = (
            await this.runGit(
              repositoryRoot,
              ["rev-parse", "HEAD"],
              cancellationSignal,
            )
          ).standardOutput.trim();
          const fetchHead = await this.resolveOptionalRefObject(
            repositoryRoot,
            "FETCH_HEAD",
            cancellationSignal,
          );
          return (
            fetchHead === pullTarget.remoteCommit &&
            (await this.commandExists(
              repositoryRoot,
              [
                "merge-base",
                "--is-ancestor",
                pullTarget.remoteCommit,
                headCommit,
              ],
              cancellationSignal,
            ))
          );
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          return false;
        }
      },
      async (repositoryRoot, cancellationSignal) =>
        this.verifyPullPinnedSource(
          repositoryRoot,
          pullTarget,
          cancellationSignal,
        ),
      undefined,
      undefined,
      undefined,
      undefined,
      [pullArguments, integrationArguments],
    );
  }

  public async previewPush(request: PushRequest): Promise<GitOperationPreview> {
    if (request.remoteName !== undefined) assertRemoteName(request.remoteName);
    if (request.branchName !== undefined) assertBranchName(request.branchName);
    if (request.refspec !== undefined) {
      assertSafeText(request.refspec, "push refspec");
      assertNotOption(request.refspec, "push refspec");
    }
    if (request.branchName !== undefined && request.refspec !== undefined)
      throw new GitOperationError(
        "push",
        "Choose branchName or refspec, not both.",
      );
    if (request.deleteRemoteBranch && request.mode === "set-upstream")
      throw new GitOperationError(
        "push",
        "Deleting a remote branch cannot set an upstream.",
      );
    const pushDetails = await this.resolvePushDetails(request);
    const localRemoteBinding = await captureLocalRemoteBinding(
      request.repositoryRoot,
      pushDetails.remoteUrl,
    );
    const pushArguments = ["push"];
    const pushMode = request.mode ?? "normal";
    if (pushMode === "set-upstream") {
      if (
        pushDetails.deleting ||
        pushDetails.sourceRef === undefined ||
        !pushDetails.sourceRef.startsWith("refs/heads/") ||
        !pushDetails.destinationRef.startsWith("refs/heads/")
      )
        throw new GitOperationError(
          "push",
          "Set-upstream requires a local branch source and branch destination.",
        );
      if (pushDetails.sourceCommit === undefined)
        throw new GitOperationError(
          "push",
          "Set-upstream requires a pinned local source object.",
        );
    }
    if (
      pushMode === "force" ||
      pushMode === "force-with-lease" ||
      pushDetails.deleting
    )
      pushArguments.push(
        `--force-with-lease=${pushDetails.destinationRef}:${pushDetails.destinationCommit ?? ""}`,
      );
    pushArguments.push(
      pushDetails.remoteUrl,
      `${pushDetails.sourceCommit ?? ""}:${pushDetails.destinationRef}`,
    );
    const pushExecutionArguments = [...pushArguments];
    const destinationBranchName = pushDetails.destinationRef.startsWith(
      "refs/heads/",
    )
      ? pushDetails.destinationRef.slice("refs/heads/".length)
      : undefined;
    const sourceBranchName = pushDetails.sourceRef?.startsWith("refs/heads/")
      ? pushDetails.sourceRef.slice("refs/heads/".length)
      : undefined;
    let setUpstreamCommandSequence: readonly (readonly string[])[] | undefined;
    if (pushMode === "set-upstream") {
      if (
        destinationBranchName === undefined ||
        sourceBranchName === undefined ||
        pushDetails.sourceCommit === undefined
      )
        throw new GitOperationError(
          "push",
          "Set-upstream requires pinned branch source and destination objects.",
        );
      const sourceCommit = pushDetails.sourceCommit;
      setUpstreamCommandSequence = [
        pushExecutionArguments,
        [
          "update-ref",
          `refs/remotes/${pushDetails.remoteName}/${destinationBranchName}`,
          sourceCommit,
        ],
        [
          "branch",
          `--set-upstream-to=${pushDetails.remoteName}/${destinationBranchName}`,
          sourceBranchName,
        ],
      ];
    }
    const runPushWithLocalTracking = async (
      repositoryRoot: string,
      cancellationSignal: AbortSignal | undefined,
    ): Promise<GitCommandOutput> => {
      await this.assertLocalRemoteBindings(
        localRemoteBinding === undefined ? [] : [localRemoteBinding],
        cancellationSignal,
      );
      const pushOutput = await this.runGit(
        repositoryRoot,
        pushExecutionArguments,
        cancellationSignal,
      );
      const isBranchDestination =
        pushDetails.destinationRef.startsWith("refs/heads/");
      if (!isBranchDestination) return pushOutput;
      if (destinationBranchName === undefined)
        throw new GitOperationError("push", "Branch destination is missing.");
      const trackingRef = `refs/remotes/${pushDetails.remoteName}/${destinationBranchName}`;
      const trackingArguments = pushDetails.deleting
        ? ["update-ref", "-d", trackingRef]
        : pushDetails.sourceCommit === undefined
          ? undefined
          : ["update-ref", trackingRef, pushDetails.sourceCommit];
      if (trackingArguments === undefined)
        throw new GitOperationError(
          "push",
          "A branch push must have a pinned source object.",
        );
      await this.runGit(repositoryRoot, trackingArguments, cancellationSignal);
      if (pushMode !== "set-upstream") return pushOutput;
      if (pushDetails.sourceRef === undefined)
        throw new GitOperationError("push", "Set-upstream source is missing.");
      if (sourceBranchName === undefined)
        throw new GitOperationError("push", "Source branch is missing.");
      const upstreamOutput = await this.runGit(
        repositoryRoot,
        [
          "branch",
          `--set-upstream-to=${pushDetails.remoteName}/${destinationBranchName}`,
          sourceBranchName,
        ],
        cancellationSignal,
      );
      return {
        standardOutput: `${pushOutput.standardOutput}${upstreamOutput.standardOutput}`,
        standardError: `${pushOutput.standardError}${upstreamOutput.standardError}`,
        exitCode: upstreamOutput.exitCode,
      };
    };
    return this.prepareOperation(
      "push",
      request,
      pushArguments,
      true,
      `Push ${request.branchName ?? "the current branch"}.`,
      "The requested remote ref matches the local pushed ref.",
      (state) => this.checkNoConflicts(state),
      (state) => !state.hasConflicts,
      undefined,
      runPushWithLocalTracking,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        const remoteReadbackVerified = await this.verifyPushReadback(
          repositoryRoot,
          pushDetails,
          cancellationSignal,
        );
        if (!remoteReadbackVerified || pushMode !== "set-upstream")
          return remoteReadbackVerified;
        const sourceBranchName = pushDetails.sourceRef?.slice(
          "refs/heads/".length,
        );
        return (
          sourceBranchName !== undefined &&
          (await this.branchUpstreamConfigurationMatches(
            repositoryRoot,
            sourceBranchName,
            {
              remote: pushDetails.remoteName,
              merge: pushDetails.destinationRef,
            },
            cancellationSignal,
          ))
        );
      },
      async (repositoryRoot, cancellationSignal) =>
        this.verifyPushPinnedSource(
          repositoryRoot,
          pushDetails,
          cancellationSignal,
        ),
      undefined,
      undefined,
      undefined,
      undefined,
      setUpstreamCommandSequence,
    );
  }

  public previewPatchCreate(
    request: PatchCreateRequest,
  ): Promise<GitOperationPreview> {
    const patchArguments = ["diff", "--no-ext-diff"];
    if (request.scope === "staged") patchArguments.push("--cached");
    if (request.scope === "both") patchArguments.push("HEAD");
    appendPathspecs(patchArguments, request.pathspecs);
    return this.prepareOperation(
      "patch.create",
      request,
      patchArguments,
      false,
      `Create a ${request.scope ?? "working-tree"} patch.`,
      "The generated patch text is returned and the repository is unchanged.",
      () => satisfiedChecks(),
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      DEFAULT_PATCH_SIZE_CAP_BYTES,
    );
  }

  public async previewPatchApply(
    request: PatchApplyRequest,
  ): Promise<GitOperationPreview> {
    assertSafeText(request.patchText, "patch text", true, true);
    const patchByteLength = Buffer.byteLength(request.patchText, "utf8");
    const patchSizeCap = request.maxPatchBytes ?? DEFAULT_PATCH_SIZE_CAP_BYTES;
    if (
      !Number.isSafeInteger(patchSizeCap) ||
      patchSizeCap < 1 ||
      patchSizeCap > DEFAULT_PATCH_SIZE_CAP_BYTES
    )
      throw new GitOperationError(
        "patch.apply",
        `Patch size cap must be between 1 and ${DEFAULT_PATCH_SIZE_CAP_BYTES} bytes.`,
      );
    if (patchByteLength > patchSizeCap)
      throw new GitOperationError(
        "patch.apply",
        `Patch is ${patchByteLength} bytes; the ${patchSizeCap}-byte safety cap was exceeded.`,
      );
    const contentSummary = summarizeContent(request.patchText, "Patch content");
    const patchTextSnapshot = request.patchText;
    const patchRollbackSnapshot =
      request.checkOnly === true || request.threeWay !== true
        ? undefined
        : await this.capturePatchRollbackSnapshot(
            request.repositoryRoot,
            request.cancellationSignal,
          );
    const patchArguments = ["apply"];
    if (request.checkOnly) patchArguments.push("--check");
    if (request.threeWay) patchArguments.push("--3way");
    return this.prepareOperation(
      "patch.apply",
      request,
      patchArguments,
      !request.checkOnly,
      request.checkOnly
        ? `Check patch (${contentSummary.bytes} bytes, sha256 ${contentSummary.sha256}).`
        : `Apply patch (${contentSummary.bytes} bytes, sha256 ${contentSummary.sha256}).`,
      request.checkOnly
        ? "Git confirms whether the patch applies; the worktree is unchanged."
        : "The patch applies and the worktree has no unresolved conflict.",
      request.checkOnly
        ? (state) => this.checkNoConflicts(state)
        : (state) => this.checkCleanAndNoConflicts(state),
      (state) => request.checkOnly === true || !state.hasConflicts,
      undefined,
      async (repositoryRoot, cancellationSignal) => {
        const temporaryDirectory = await mkdtemp(
          nodePath.join("/tmp", "gito-patch-"),
        );
        const patchPath = nodePath.join(temporaryDirectory, "change.patch");
        try {
          await writeFile(patchPath, patchTextSnapshot, "utf8");
          return await this.runGit(
            repositoryRoot,
            [...patchArguments, "--", patchPath],
            cancellationSignal,
          );
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true });
        }
      },
      patchRollbackSnapshot === undefined
        ? undefined
        : () =>
            this.rollbackPatchApply(
              request.repositoryRoot,
              patchRollbackSnapshot,
            ),
      undefined,
      undefined,
      undefined,
      contentSummary,
      undefined,
      patchTextSnapshot,
    );
  }

  public async previewBisectStart(
    request: BisectStartRequest,
  ): Promise<GitOperationPreview> {
    const bisectArguments = ["bisect", "start"];
    if (request.terms !== undefined) {
      assertBisectTerm(request.terms[0], "new term");
      assertBisectTerm(request.terms[1], "old term");
      bisectArguments.push(
        `--term-new=${request.terms[0]}`,
        `--term-old=${request.terms[1]}`,
      );
    }
    const originalBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    let resolvedBadCommit: string | undefined;
    if (request.badCommit !== undefined) {
      assertCommitish(request.badCommit);
      resolvedBadCommit = await this.resolveCommitish(
        request.repositoryRoot,
        request.badCommit,
        request.cancellationSignal,
      );
      bisectArguments.push(resolvedBadCommit);
    }
    const resolvedGoodCommits: string[] = [];
    for (const goodCommit of request.goodCommits) {
      assertCommitish(goodCommit);
      const resolvedGoodCommit = await this.resolveCommitish(
        request.repositoryRoot,
        goodCommit,
        request.cancellationSignal,
      );
      resolvedGoodCommits.push(resolvedGoodCommit);
      bisectArguments.push(resolvedGoodCommit);
    }
    return this.prepareOperation(
      "bisect.start",
      request,
      bisectArguments,
      true,
      "Start a bisect session.",
      "Git records the bisect state and checks out the next candidate commit.",
      (state) => this.checkCleanAndNoConflicts(state),
      (state) => !state.hasConflicts && state.inProgressOperation === "bisect",
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyBisectReadback(
          repositoryRoot,
          originalBranch,
          "start",
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        this.verifyBisectRefs(
          repositoryRoot,
          request.badCommit,
          resolvedBadCommit,
          request.goodCommits,
          resolvedGoodCommits,
          cancellationSignal,
        ),
      undefined,
    );
  }

  public previewBisectGood(
    request: BisectCommitRequest,
  ): Promise<GitOperationPreview> {
    return this.previewBisectMark("good", request);
  }

  public previewBisectBad(
    request: BisectCommitRequest,
  ): Promise<GitOperationPreview> {
    return this.previewBisectMark("bad", request);
  }

  public previewBisectSkip(
    request: BisectCommitRequest,
  ): Promise<GitOperationPreview> {
    return this.previewBisectMark("skip", request);
  }

  public async previewBisectReset(
    request: BisectCommitRequest,
  ): Promise<GitOperationPreview> {
    if (request.commitish !== undefined) assertCommitish(request.commitish);
    const originalBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    const resolvedCommit =
      request.commitish === undefined
        ? undefined
        : await this.resolveCommitish(
            request.repositoryRoot,
            request.commitish,
            request.cancellationSignal,
          );
    return this.prepareOperation(
      "bisect.reset",
      request,
      [
        "bisect",
        "reset",
        ...(resolvedCommit === undefined ? [] : [resolvedCommit]),
      ],
      true,
      "End the bisect session and restore the starting branch.",
      "The bisect state is removed and HEAD is restored.",
      (state) => this.checkBisectInProgress(state),
      (state) => state.inProgressOperation !== "bisect" && !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyBisectReadback(
          repositoryRoot,
          originalBranch,
          "reset",
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        resolvedCommit === undefined
          ? true
          : this.isCommitishPinned(
              repositoryRoot,
              request.commitish as string,
              resolvedCommit,
              cancellationSignal,
            ),
      undefined,
    );
  }

  public previewReflogList(
    request: ReflogListRequest,
  ): Promise<GitOperationPreview> {
    if (request.refName !== undefined)
      assertSafeRef(request.refName, "reflog ref");
    const limit = request.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new GitOperationError(
        "reflog.list",
        "Reflog limit must be 1-10000.",
      );
    return this.prepareOperation(
      "reflog.list",
      request,
      [
        "reflog",
        "show",
        `--max-count=${limit}`,
        "--format=%gd%x00%H%x00%gs",
        request.refName ?? "HEAD",
      ],
      false,
      `List the ${request.refName ?? "HEAD"} reflog.`,
      "The current reflog entries are returned.",
      () => satisfiedChecks(),
      () => true,
    );
  }

  public async previewReflogRecover(
    request: ReflogRecoverRequest,
  ): Promise<GitOperationPreview> {
    assertCommitish(request.target);
    const resetMode = request.mode ?? "mixed";
    const resolvedTargetCommit = await this.resolveCommitish(
      request.repositoryRoot,
      request.target,
      request.cancellationSignal,
    );
    return this.prepareOperation(
      "reflog.recover",
      request,
      ["reset", resetModeFlag(resetMode), resolvedTargetCommit],
      true,
      `Recover HEAD to ${request.target} with a ${resetMode} reset.`,
      `HEAD resolves to ${request.target} and no conflict remains.`,
      (state) => this.checkCleanAndNoConflicts(state),
      (state) =>
        state.headCommit === resolvedTargetCommit && !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.isCommitishPinned(
          repositoryRoot,
          request.target,
          resolvedTargetCommit,
          cancellationSignal,
        ),
    );
  }

  public async previewClean(
    request: CleanPreviewRequest,
  ): Promise<GitOperationPreview> {
    const repositoryRoot = await this.assertRepositoryBinding(
      request.repositoryRoot,
      request.expectedRepositoryRoot,
      request.cancellationSignal,
    );
    const rootBinding = await this.gitRootBindingResolver.resolve(
      repositoryRoot,
      this.rootBindingContext.getStore(),
    );
    return this.rootBindingContext.run(rootBinding, async () => {
      const cleanSelection = await this.captureCleanCandidates(
        repositoryRoot,
        request,
        request.cancellationSignal,
      );
      const cleanArguments = buildCleanArguments(
        request,
        false,
        cleanSelection.paths,
      );
      return this.prepareOperation(
        "clean.preview",
        request,
        cleanArguments,
        false,
        "Preview untracked files and directories that Git can remove.",
        "The clean candidate list is returned and no files are removed.",
        () => satisfiedChecks(),
        () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        cleanSelection.paths,
        undefined,
        undefined,
        cleanSelection.bindings,
      );
    });
  }

  public async previewCleanExecute(
    request: CleanPreviewRequest,
  ): Promise<GitOperationPreview> {
    const repositoryRoot = await this.assertRepositoryBinding(
      request.repositoryRoot,
      request.expectedRepositoryRoot,
      request.cancellationSignal,
    );
    const rootBinding = await this.gitRootBindingResolver.resolve(
      repositoryRoot,
      this.rootBindingContext.getStore(),
    );
    return this.rootBindingContext.run(rootBinding, async () => {
      const cleanSelection =
        request.candidatePaths === undefined
          ? await this.captureCleanCandidates(
              repositoryRoot,
              request,
              request.cancellationSignal,
            )
          : {
              paths: validateCleanCandidates(request.candidatePaths),
              bindings: await this.captureCleanCandidateBindings(
                repositoryRoot,
                validateCleanCandidates(request.candidatePaths),
              ),
            };
      if (cleanSelection.paths.length === 0)
        throw new GitOperationError(
          "clean.execute",
          "Clean execution requires at least one exact candidate; refusing to broaden to the repository root.",
        );
      return this.prepareOperation(
        "clean.execute",
        request,
        buildCleanArguments(request, true, cleanSelection.paths),
        true,
        "Remove the exact untracked candidates shown by clean preview.",
        "The requested clean candidates no longer exist.",
        () => satisfiedChecks(),
        (state) => !state.hasConflicts,
        undefined,
        undefined,
        undefined,
        async (repositoryRoot, cancellationSignal) =>
          this.verifyCleanCandidatesAbsent(
            repositoryRoot,
            cleanSelection.paths,
            cancellationSignal,
          ),
        async (repositoryRoot, cancellationSignal) =>
          this.verifyCleanCandidatesPinned(
            repositoryRoot,
            cleanSelection.bindings,
            cancellationSignal,
          ),
        undefined,
        undefined,
        cleanSelection.paths,
        undefined,
        undefined,
        cleanSelection.bindings,
      );
    });
  }

  public createConfirmation(
    preview: GitOperationPreview,
  ): GitOperationConfirmation {
    return {
      confirmationToken: preview.confirmationPlan.confirmationToken,
      repositoryRoot: preview.repositoryRoot,
      acknowledged: true,
    };
  }

  public async execute(
    preview: GitOperationPreview,
    confirmation: GitOperationConfirmation,
    cancellationSignal?: AbortSignal,
  ): Promise<GitOperationResult> {
    throwIfCancelled(cancellationSignal);
    this.removeExpiredPendingOperations(this.now().getTime());
    const pendingOperation = this.pendingOperations.get(
      preview.confirmationPlan.confirmationToken,
    );
    if (pendingOperation === undefined)
      throw new GitOperationError(
        preview.operation,
        "Preview expired or was already executed.",
      );
    if (
      preview.operation !== pendingOperation.operation ||
      preview.repositoryRoot !== pendingOperation.repositoryRoot
    ) {
      throw new GitOperationError(
        preview.operation,
        "Preview identity does not match the prepared operation.",
      );
    }
    if (
      confirmation.acknowledged !== true ||
      confirmation.confirmationToken !==
        preview.confirmationPlan.confirmationToken
    ) {
      throw new GitOperationError(
        preview.operation,
        "A matching explicit confirmation is required.",
      );
    }
    if (
      pendingOperation.contentSummary !== undefined &&
      (preview.contentSummary === undefined ||
        preview.contentSummary.bytes !==
          pendingOperation.contentSummary.bytes ||
        preview.contentSummary.sha256 !==
          pendingOperation.contentSummary.sha256)
    ) {
      throw new GitOperationError(
        preview.operation,
        "Preview content snapshot changed; create a fresh preview.",
      );
    }
    if (
      pendingOperation.snapshotContent !== undefined &&
      !contentMatchesSummary(
        pendingOperation.snapshotContent,
        pendingOperation.contentSummary,
      )
    ) {
      throw new GitOperationError(
        preview.operation,
        "Preview content snapshot failed integrity verification.",
      );
    }
    // Claim the token before entering any async boundary. A confirmation is
    // single-use: concurrent callers cannot both pass the pending-operation
    // lookup and reach the mutation.
    if (
      !this.pendingOperations.delete(preview.confirmationPlan.confirmationToken)
    )
      throw new GitOperationError(
        preview.operation,
        "Preview expired or was already executed.",
      );
    return this.rootBindingContext.run(
      pendingOperation.rootBinding,
      async () => {
        const boundRepositoryRoot = await this.assertRepositoryBinding(
          pendingOperation.requestedRepositoryRoot,
          preview.repositoryRoot,
          cancellationSignal,
        );
        if (confirmation.repositoryRoot !== boundRepositoryRoot)
          throw new GitOperationError(
            preview.operation,
            "Confirmation targets a different repository.",
          );
        const currentState = await this.readRepositoryState(
          boundRepositoryRoot,
          cancellationSignal,
        );
        if (
          !sameStateFingerprint(currentState, pendingOperation.stateAtPreview)
        )
          throw new GitOperationError(
            preview.operation,
            "Repository changed after preview; create a fresh preview.",
          );
        const currentChecks = pendingOperation.checkState(currentState);
        if (currentChecks.blocking)
          throw new GitOperationError(
            preview.operation,
            formatBlockingChecks(currentChecks.preconditions),
          );
        if (
          pendingOperation.verifyPinnedState !== undefined &&
          !(await pendingOperation.verifyPinnedState(
            boundRepositoryRoot,
            cancellationSignal,
          ))
        )
          throw new GitOperationError(
            preview.operation,
            "A pinned ref, stash identity, or remote changed after preview; create a fresh preview.",
          );
        if (this.workspaceTrustGuard.isWorkspaceTrusted() !== true)
          throw new GitOperationError(
            preview.operation,
            "Cannot mutate an untrusted workspace; trust the workspace and retry.",
          );
        this.workspaceTrustGuard.assertTrusted(`execute ${preview.operation}`);
        let rolledBack = false;
        let rollbackReport: GitOperationRollbackReport = {
          status: "not-attempted",
        };
        try {
          const commandOutput =
            pendingOperation.run === undefined
              ? await this.runGit(
                  boundRepositoryRoot,
                  pendingOperation.commandArguments,
                  cancellationSignal,
                  pendingOperation.maxStandardOutputBytes,
                )
              : await pendingOperation.run(
                  boundRepositoryRoot,
                  cancellationSignal,
                );
          throwIfCancelled(cancellationSignal);
          const postconditionState = await this.readRepositoryState(
            boundRepositoryRoot,
            cancellationSignal,
          );
          const readbackVerified =
            pendingOperation.verifyReadback === undefined
              ? true
              : await pendingOperation.verifyReadback(
                  boundRepositoryRoot,
                  cancellationSignal,
                );
          const postcondition = this.buildPostcondition(
            pendingOperation.expectedPostcondition,
            postconditionState,
            pendingOperation.verifyPostcondition,
            readbackVerified,
          );
          if (!postcondition.verified)
            throw new GitOperationError(
              preview.operation,
              `Postcondition failed: ${postcondition.description}`,
            );
          return {
            operation: preview.operation,
            repositoryRoot: boundRepositoryRoot,
            standardOutput: redactGitErrorMessage(commandOutput.standardOutput),
            standardError: redactGitErrorMessage(commandOutput.standardError),
            postcondition,
            rolledBack,
            rollback: rollbackReport,
          };
        } catch (error: unknown) {
          if (pendingOperation.rollback !== undefined) {
            try {
              rolledBack = await pendingOperation.rollback();
              rollbackReport = {
                status: rolledBack ? "succeeded" : "failed",
              };
            } catch (rollbackError: unknown) {
              rollbackReport = {
                status: "failed",
                error: redactGitErrorMessage(
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError),
                ),
              };
            }
          }
          let finalState: GitStateFingerprint | undefined;
          try {
            finalState = await this.readRepositoryState(boundRepositoryRoot);
            rollbackReport = { ...rollbackReport, finalState };
          } catch {
            // The mutation outcome could not be read back; preserve the original error.
          }
          const baseMessage = isAbortError(error)
            ? `Git operation cancelled; mutation outcome read back as ${
                finalState?.isClean ? "clean" : "changed or unavailable"
              } worktree, HEAD ${finalState?.headCommit ?? "unavailable"}.`
            : error instanceof Error
              ? error.message
              : String(error);
          const patchOutcomePrefix =
            preview.operation === "patch.apply" &&
            pendingOperation.commandArguments.includes("--3way")
              ? "Patch --3way ended with an explicit conflict/partial outcome. "
              : "";
          throw new GitOperationError(
            preview.operation,
            `${patchOutcomePrefix}${baseMessage} Final state: ${formatFinalState(finalState)} Rollback: ${formatRollbackReport(rollbackReport)}.`,
            { cause: error, finalState, rollback: rollbackReport },
          );
        }
      },
    );
  }

  private async prepareOperation(
    operation: GitOperationKind,
    request: GitOperationRequestBase,
    commandArguments: readonly string[],
    destructive: boolean,
    summary: string,
    expectedPostcondition: string,
    checkState: (state: GitStateFingerprint) => OperationStateCheck,
    verifyPostcondition: (state: GitStateFingerprint) => boolean,
    displayArguments?: readonly string[],
    run?: (
      repositoryRoot: string,
      cancellationSignal: AbortSignal | undefined,
    ) => Promise<GitCommandOutput>,
    rollback?: () => Promise<boolean>,
    verifyReadback?: (
      repositoryRoot: string,
      cancellationSignal: AbortSignal | undefined,
    ) => Promise<boolean>,
    verifyPinnedState?: (
      repositoryRoot: string,
      cancellationSignal: AbortSignal | undefined,
    ) => Promise<boolean>,
    maxStandardOutputBytes?: number,
    contentSummary?: GitOperationContentSummary,
    cleanCandidates?: readonly string[],
    snapshotContent?: string,
    commandSequence?: readonly (readonly string[])[],
    cleanCandidateBindings?: readonly GitCleanCandidateBinding[],
  ): Promise<GitOperationPreview> {
    throwIfCancelled(request.cancellationSignal);
    const repositoryRoot = await this.assertRepositoryBinding(
      request.repositoryRoot,
      request.expectedRepositoryRoot,
      request.cancellationSignal,
    );
    const rootBinding = await this.gitRootBindingResolver.resolve(
      repositoryRoot,
      this.rootBindingContext.getStore(),
    );
    return this.rootBindingContext.run(rootBinding, async () => {
      const state = await this.readRepositoryState(
        repositoryRoot,
        request.cancellationSignal,
      );
      const stateChecks = checkState(state);
      const generatedAt = this.now();
      this.reservePendingOperationCapacity(generatedAt.getTime());
      const confirmationToken = this.createUniqueToken();
      const preview: GitOperationPreview = {
        operation,
        repositoryRoot,
        displayArguments: displayArguments ?? redactArguments(commandArguments),
        ...(commandSequence === undefined
          ? {}
          : { commandSequence: commandSequence.map(redactArguments) }),
        destructive,
        state,
        preconditions: stateChecks.preconditions,
        confirmationPlan: {
          confirmationToken,
          operation,
          repositoryRoot,
          summary:
            contentSummary === undefined
              ? summary
              : `${summary} ${contentSummary.description}: ${contentSummary.bytes} bytes, sha256 ${contentSummary.sha256}.`,
          consequences: [expectedPostcondition],
          cancellationSupported: true,
        },
        expectedPostcondition,
        generatedAt: generatedAt.toISOString(),
        ...(cleanCandidates === undefined ? {} : { cleanCandidates }),
        ...(cleanCandidateBindings === undefined
          ? {}
          : { cleanCandidateBindings }),
        ...(contentSummary === undefined ? {} : { contentSummary }),
      };
      this.pendingOperations.set(confirmationToken, {
        operation,
        commandArguments,
        repositoryRoot,
        requestedRepositoryRoot: request.repositoryRoot,
        stateAtPreview: state,
        rootBinding,
        displayArguments: preview.displayArguments,
        destructive,
        expectedPostcondition,
        verifyPostcondition,
        checkState,
        ...(run === undefined ? {} : { run }),
        ...(rollback === undefined ? {} : { rollback }),
        ...(verifyReadback === undefined ? {} : { verifyReadback }),
        ...(verifyPinnedState === undefined ? {} : { verifyPinnedState }),
        ...(maxStandardOutputBytes === undefined
          ? {}
          : { maxStandardOutputBytes }),
        ...(snapshotContent === undefined ? {} : { snapshotContent }),
        ...(contentSummary === undefined ? {} : { contentSummary }),
        ...(cleanCandidateBindings === undefined
          ? {}
          : { cleanCandidateBindings }),
        expiresAtMilliseconds:
          generatedAt.getTime() + PENDING_OPERATION_TTL_MILLISECONDS,
      });
      return preview;
    });
  }

  private async previewBisectMark(
    mark: "good" | "bad" | "skip",
    request: BisectCommitRequest,
  ): Promise<GitOperationPreview> {
    if (request.commitish !== undefined) assertCommitish(request.commitish);
    const originalBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    const resolvedCommit =
      request.commitish === undefined
        ? undefined
        : await this.resolveCommitish(
            request.repositoryRoot,
            request.commitish,
            request.cancellationSignal,
          );
    return this.prepareOperation(
      `bisect.${mark}`,
      request,
      [
        "bisect",
        mark,
        ...(resolvedCommit === undefined ? [] : [resolvedCommit]),
      ],
      true,
      `Mark ${request.commitish ?? "the current commit"} as ${mark}.`,
      "The bisect session advances or completes.",
      (state) => this.checkBisectInProgress(state),
      (state) => !state.hasConflicts,
      undefined,
      undefined,
      undefined,
      async (repositoryRoot, cancellationSignal) =>
        this.verifyBisectReadback(
          repositoryRoot,
          originalBranch,
          mark,
          cancellationSignal,
        ),
      async (repositoryRoot, cancellationSignal) =>
        resolvedCommit === undefined
          ? true
          : this.isCommitishPinned(
              repositoryRoot,
              request.commitish as string,
              resolvedCommit,
              cancellationSignal,
            ),
      undefined,
    );
  }

  private previewConflictContinuation(
    request: GitOperationRequestBase,
    operation: "merge" | "cherry-pick" | "revert",
    action: "continue" | "abort",
  ): Promise<GitOperationPreview> {
    const operationKind = `${operation}.${action}` as GitOperationKind;
    const commandName = operation === "merge" ? "merge" : operation;
    return this.prepareOperation(
      operationKind,
      request,
      [commandName, `--${action}`],
      true,
      `${action === "continue" ? "Continue" : "Abort"} ${operation}.`,
      action === "abort"
        ? `The ${operation} state is cleared and no unresolved conflict remains.`
        : `The ${operation} advances or completes with no unresolved conflict.`,
      (state) =>
        this.checkConflictOperation(state, operation, action === "abort"),
      (state) =>
        !state.hasConflicts &&
        (action === "abort"
          ? state.inProgressOperation === undefined
          : state.inProgressOperation === undefined ||
            state.inProgressOperation === operation),
    );
  }

  private checkConflictOperation(
    state: GitStateFingerprint,
    operation: "merge" | "cherry-pick" | "revert",
    allowConflicts: boolean,
  ): OperationStateCheck {
    return checks(
      precondition(
        `${operation}-in-progress`,
        `A ${operation} is currently in progress.`,
        state.inProgressOperation === operation,
        true,
      ),
      precondition(
        "no-conflicts",
        allowConflicts
          ? "Git may contain conflicts while aborting."
          : "Conflicts are resolved before continuing.",
        allowConflicts || !state.hasConflicts,
        true,
      ),
    );
  }

  private checkNoConflicts(state: GitStateFingerprint): OperationStateCheck {
    return checks(
      precondition(
        "no-conflicts",
        "Repository has no unresolved merge conflicts.",
        !state.hasConflicts,
        true,
      ),
      precondition(
        "no-in-progress-operation",
        "Repository has no unfinished merge, rebase, cherry-pick, revert, or bisect operation.",
        state.inProgressOperation === undefined,
        true,
      ),
    );
  }

  private checkCleanAndNoConflicts(
    state: GitStateFingerprint,
  ): OperationStateCheck {
    return checks(
      precondition(
        "clean-working-tree",
        "Working tree and index are clean.",
        state.isClean,
        true,
      ),
      precondition(
        "no-conflicts",
        "Repository has no unresolved merge conflicts.",
        !state.hasConflicts,
        true,
      ),
      precondition(
        "no-in-progress-operation",
        "Repository has no unfinished merge, rebase, cherry-pick, revert, or bisect operation.",
        state.inProgressOperation === undefined,
        true,
      ),
    );
  }

  private checkRebaseInProgress(
    state: GitStateFingerprint,
    allowConflicts: boolean,
  ): OperationStateCheck {
    return checks(
      precondition(
        "rebase-in-progress",
        "A rebase is currently in progress.",
        state.inProgressOperation === "rebase",
        true,
      ),
      precondition(
        "no-conflicts",
        "Repository has no unresolved merge conflicts unless aborting.",
        allowConflicts || !state.hasConflicts,
        true,
      ),
    );
  }

  private checkBisectInProgress(
    state: GitStateFingerprint,
  ): OperationStateCheck {
    return checks(
      precondition(
        "bisect-in-progress",
        "A bisect session is currently in progress.",
        state.inProgressOperation === "bisect",
        true,
      ),
      precondition(
        "no-conflicts",
        "Repository has no unresolved merge conflicts.",
        !state.hasConflicts,
        true,
      ),
    );
  }

  private buildPostcondition(
    description: string,
    state: GitStateFingerprint,
    verifyPostcondition: (state: GitStateFingerprint) => boolean,
    readbackVerified: boolean,
  ): GitOperationPostcondition {
    return {
      verified: verifyPostcondition(state) && readbackVerified,
      description,
      state,
    };
  }

  private async assertRepositoryBinding(
    requestedRepositoryRoot: string,
    expectedRepositoryRoot?: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string> {
    assertSafeRepositoryPath(requestedRepositoryRoot);
    if (expectedRepositoryRoot !== undefined) {
      const normalizedExpectedRoot = await normalizeRepositoryPath(
        expectedRepositoryRoot,
      );
      const normalizedRequestedRoot = await normalizeRepositoryPath(
        requestedRepositoryRoot,
      );
      if (normalizedExpectedRoot !== normalizedRequestedRoot)
        throw new GitOperationError(
          "repository",
          "Repository selection is stale; exact repository binding failed.",
        );
    }
    const commandOutput = await this.runGit(
      requestedRepositoryRoot,
      ["rev-parse", "--show-toplevel"],
      cancellationSignal,
    );
    const gitRepositoryRoot = await normalizeRepositoryPath(
      commandOutput.standardOutput.trim(),
    );
    const requestedRoot = await normalizeRepositoryPath(
      requestedRepositoryRoot,
    );
    if (gitRepositoryRoot !== requestedRoot)
      throw new GitOperationError(
        "repository",
        "Git resolved a different repository root than the selected repository.",
      );
    return requestedRoot;
  }

  private async readRepositoryState(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<GitStateFingerprint> {
    const [statusOutput, ignoredStatusOutput] = await Promise.all([
      this.runGit(
        repositoryRoot,
        ["status", "--porcelain=v1", "--branch"],
        cancellationSignal,
      ),
      this.runGit(
        repositoryRoot,
        ["status", "--porcelain=v1", "--ignored", "--untracked-files=all"],
        cancellationSignal,
      ),
    ]);
    const commandOutput = await this.readRepositoryStateCommandOutput(
      repositoryRoot,
      cancellationSignal,
    );
    const statusLines = statusOutput.standardOutput
      .split(/\r?\n/)
      .filter(Boolean);
    const statusPorcelain = statusLines
      .filter((line) => !line.startsWith("## "))
      .join("\n");
    const statusEntries = statusLines.filter((line) => !line.startsWith("## "));
    const hasConflicts = statusEntries.some(
      (line) =>
        /^(?:[ MARCUD?!]{2})\s/.test(line) &&
        /^(?:AA|DD|AU|UA|UD|DU|UU)\s/.test(line),
    );
    const inProgressOperation = await detectInProgressOperation(
      commandOutput.gitDirectory,
      this.rootBindingContext.getStore() ??
        (await this.gitRootBindingResolver.resolve(repositoryRoot)),
    );
    return {
      repositoryRoot: commandOutput.repositoryRoot,
      ...(commandOutput.headCommit === undefined
        ? {}
        : { headCommit: commandOutput.headCommit }),
      ...(commandOutput.headRef === undefined
        ? {}
        : { headRef: commandOutput.headRef }),
      isClean: statusEntries.length === 0,
      hasConflicts,
      ...(inProgressOperation === undefined ? {} : { inProgressOperation }),
      statusPorcelain,
      ignoredStatusPorcelain: ignoredStatusOutput.standardOutput.trim(),
    };
  }

  private async resolveCommitish(
    repositoryRoot: string,
    commitish: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string> {
    const commandOutput = await this.runGit(
      repositoryRoot,
      ["rev-parse", "--verify", `${commitish}^{commit}`],
      cancellationSignal,
    );
    const resolvedCommit = commandOutput.standardOutput.trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(resolvedCommit))
      throw new GitOperationError(
        "repository",
        `Git returned an invalid commit for ${commitish}.`,
      );
    return resolvedCommit;
  }

  private async resolveRefObject(
    repositoryRoot: string,
    refName: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string> {
    const objectId = (
      await this.runGit(
        repositoryRoot,
        ["rev-parse", "--verify", refName],
        cancellationSignal,
      )
    ).standardOutput.trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(objectId))
      throw new GitOperationError(
        "repository",
        `Git returned an invalid object for ${refName}.`,
      );
    return objectId;
  }

  private async resolveStashCommit(
    request: StashReferenceRequest,
  ): Promise<string> {
    const repositoryRoot = await this.assertRepositoryBinding(
      request.repositoryRoot,
      request.expectedRepositoryRoot,
      request.cancellationSignal,
    );
    return this.resolveCommitish(
      repositoryRoot,
      request.stashReference,
      request.cancellationSignal,
    );
  }

  private async stashEntryExistsByCommit(
    repositoryRoot: string,
    expectedCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const stashList = await this.runGit(
        repositoryRoot,
        ["stash", "list", "--format=%H"],
        cancellationSignal,
      );
      return stashList.standardOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .includes(expectedCommit);
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async stashReferenceStillPinned(
    repositoryRoot: string,
    stashReference: string,
    expectedCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return (
        (await this.resolveCommitish(
          repositoryRoot,
          stashReference,
          cancellationSignal,
        )) === expectedCommit
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  /** Git's stash drop/pop porcelain only accepts a mutable stash index. Hold
   * Git's stash ref and reflog locks while applying a journaled exact-OID
   * transaction; never pass the caller's mutable stash@{N} through a
   * check-then-drop window. */
  private async dropStashEntryByCommit(
    repositoryRoot: string,
    expectedCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<GitCommandOutput> {
    const stashMutationLock = await this.acquireStashMutationLock(
      repositoryRoot,
      cancellationSignal,
    );
    try {
      return await this.dropStashEntryByCommitLocked(
        repositoryRoot,
        expectedCommit,
        stashMutationLock,
        cancellationSignal,
      );
    } finally {
      await this.releaseStashMutationLock(stashMutationLock);
    }
  }

  private async dropStashEntryByCommitLocked(
    repositoryRoot: string,
    expectedCommit: string,
    stashMutationLock: StashMutationLock,
    cancellationSignal?: AbortSignal,
  ): Promise<GitCommandOutput> {
    const stashList = await this.runGit(
      repositoryRoot,
      ["stash", "list", "--format=%gd%x00%H"],
      cancellationSignal,
    );
    const matchingSelector = stashList.standardOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => line.split("\0"))
      .find((parts) => parts[1] === expectedCommit)?.[0];
    if (matchingSelector === undefined)
      throw new GitOperationError(
        "stash.drop",
        "Pinned stash entry changed after preview; create a fresh preview.",
      );
    const mutationBoundaryCommit = await this.resolveCommitish(
      repositoryRoot,
      matchingSelector,
      cancellationSignal,
    );
    if (mutationBoundaryCommit !== expectedCommit)
      throw new GitOperationError(
        "stash.drop",
        "Pinned stash identity changed at the mutation boundary; refusing to drop a mutable selector.",
      );
    const reflogText = (
      await this.runBoundFilesystem(stashMutationLock.rootBinding, {
        kind: "read",
        targetPath: stashMutationLock.reflogPath,
      })
    ).content;
    if (reflogText === undefined)
      throw new GitOperationError(
        "stash.drop",
        "Stash reflog could not be read safely; refusing mutation.",
      );
    const reflogLines = reflogText
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    const targetReflogIndex = reflogLines.findIndex(
      (reflogLine) => reflogLine.split(" ")[1] === expectedCommit,
    );
    if (targetReflogIndex < 0)
      throw new GitOperationError(
        "stash.drop",
        "Pinned stash has no readable reflog entry; refusing an unsafe mutation.",
      );
    const previousObjectId =
      targetReflogIndex === 0
        ? stashMutationLock.zeroObjectId
        : (reflogLines[targetReflogIndex - 1]?.split(" ")[1] ??
          stashMutationLock.zeroObjectId);
    const rewrittenReflogLines = reflogLines.filter(
      (_, index) => index !== targetReflogIndex,
    );
    const followingReflogIndex = targetReflogIndex + 1;
    if (followingReflogIndex < reflogLines.length) {
      const followingLineIndex = targetReflogIndex;
      const followingLine = rewrittenReflogLines[followingLineIndex];
      if (followingLine !== undefined) {
        const followingFields = followingLine.split(" ");
        followingFields[0] = previousObjectId;
        rewrittenReflogLines[followingLineIndex] = followingFields.join(" ");
      }
    }
    const rewrittenReflogContent =
      rewrittenReflogLines.length === 0
        ? ""
        : `${rewrittenReflogLines.join("\n")}\n`;
    const remainingHeadObjectId =
      rewrittenReflogLines.length === 0
        ? undefined
        : rewrittenReflogLines[rewrittenReflogLines.length - 1]?.split(" ")[1];
    await this.commitStashMutationTransaction(
      stashMutationLock,
      rewrittenReflogContent,
      remainingHeadObjectId === undefined ||
        remainingHeadObjectId === stashMutationLock.zeroObjectId
        ? undefined
        : `${remainingHeadObjectId}\n`,
    );
    if (
      await this.stashEntryExistsByCommit(
        repositoryRoot,
        expectedCommit,
        cancellationSignal,
      )
    )
      throw new GitOperationError(
        "stash.drop",
        "Atomic stash mutation did not remove the pinned entry.",
      );
    return {
      standardOutput: `Dropped ${expectedCommit}.\n`,
      standardError: "",
      exitCode: 0,
    };
  }

  private async popStashEntryByCommit(
    repositoryRoot: string,
    expectedCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<GitCommandOutput> {
    const stashMutationLock = await this.acquireStashMutationLock(
      repositoryRoot,
      cancellationSignal,
    );
    try {
      const applyOutput = await this.runGit(
        repositoryRoot,
        ["stash", "apply", expectedCommit],
        cancellationSignal,
      );
      const dropOutput = await this.dropStashEntryByCommitLocked(
        repositoryRoot,
        expectedCommit,
        stashMutationLock,
        cancellationSignal,
      );
      return {
        standardOutput: `${applyOutput.standardOutput}${dropOutput.standardOutput}`,
        standardError: `${applyOutput.standardError}${dropOutput.standardError}`,
        exitCode: dropOutput.exitCode,
      };
    } finally {
      await this.releaseStashMutationLock(stashMutationLock);
    }
  }

  private async commitStashMutationTransaction(
    stashMutationLock: StashMutationLock,
    reflogContent: string,
    refContent: string | undefined,
  ): Promise<void> {
    const journal: StashMutationJournal = {
      version: 1,
      ownerPid: process.pid,
      ownerToken: stashMutationLock.ownerToken,
      phase: "prepared",
      refPath: stashMutationLock.refPath,
      reflogPath: stashMutationLock.reflogPath,
      reflogContent,
      ...(refContent === undefined ? {} : { refContent }),
    };
    await this.writeStashMutationJournal(stashMutationLock, journal);
    const temporaryReflogPath = `${stashMutationLock.reflogPath}.gito-${cryptoRandomToken()}`;
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      await this.writeAndSyncFile(
        stashMutationLock.rootBinding,
        temporaryReflogPath,
        reflogContent,
      );
    });
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      await this.renameBoundFileWithTargetCas(
        stashMutationLock.rootBinding,
        temporaryReflogPath,
        stashMutationLock.reflogPath,
      );
      await this.syncBoundDirectory(
        stashMutationLock.rootBinding,
        nodePath.dirname(stashMutationLock.reflogPath),
      );
    });
    await this.writeStashMutationJournal(stashMutationLock, {
      ...journal,
      phase: "reflog-applied",
    });
    if (refContent === undefined) {
      await this.withStashMutationFilesystem(stashMutationLock, async () =>
        this.removeBoundFileIfPresent(
          stashMutationLock.rootBinding,
          stashMutationLock.refPath,
        ),
      );
    } else {
      await this.withStashMutationFilesystem(stashMutationLock, async () => {
        await this.writeAndSyncFile(
          stashMutationLock.rootBinding,
          stashMutationLock.refPath,
          refContent,
        );
        await this.syncBoundDirectory(
          stashMutationLock.rootBinding,
          nodePath.dirname(stashMutationLock.refPath),
        );
      });
    }
    await this.writeStashMutationJournal(stashMutationLock, {
      ...journal,
      phase: "ref-applied",
    });
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      await this.removeBoundFileIfPresent(
        stashMutationLock.rootBinding,
        stashMutationLock.transactionPath,
      );
      await this.syncBoundDirectory(
        stashMutationLock.rootBinding,
        nodePath.dirname(stashMutationLock.transactionPath),
      );
    });
  }

  private async writeStashMutationJournal(
    stashMutationLock: StashMutationLock,
    journal: StashMutationJournal,
  ): Promise<void> {
    const temporaryJournalPath = `${stashMutationLock.transactionPath}.gito-${cryptoRandomToken()}`;
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      await this.writeAndSyncFile(
        stashMutationLock.rootBinding,
        temporaryJournalPath,
        `${JSON.stringify(journal)}\n`,
      );
      await this.renameBoundFileWithTargetCas(
        stashMutationLock.rootBinding,
        temporaryJournalPath,
        stashMutationLock.transactionPath,
      );
      await this.syncBoundDirectory(
        stashMutationLock.rootBinding,
        nodePath.dirname(stashMutationLock.transactionPath),
      );
    });
  }

  private async writeAndSyncFile(
    rootBinding: GitRootBindingIdentity,
    filePath: string,
    fileContent: string,
  ): Promise<void> {
    const temporaryFilePath = `${filePath}.gito-write-${cryptoRandomToken()}`;
    try {
      await this.runBoundFilesystem(rootBinding, {
        kind: "write",
        targetPath: temporaryFilePath,
        content: fileContent,
      });
      await this.renameBoundFileWithTargetCas(
        rootBinding,
        temporaryFilePath,
        filePath,
      );
      await this.syncBoundDirectory(rootBinding, nodePath.dirname(filePath));
    } finally {
      if (await this.boundPathExists(rootBinding, temporaryFilePath))
        await this.runBoundFilesystem(rootBinding, {
          kind: "remove",
          targetPath: temporaryFilePath,
        });
    }
  }

  private async renameBoundFileWithTargetCas(
    rootBinding: GitRootBindingIdentity,
    sourcePath: string,
    destinationPath: string,
  ): Promise<void> {
    let expectedDestinationExists = false;
    let expectedDestinationDevice: string | undefined;
    let expectedDestinationInode: string | undefined;
    if (await this.boundPathExists(rootBinding, destinationPath)) {
      const destinationStat = await this.runBoundFilesystem(rootBinding, {
        kind: "read-stat",
        targetPath: destinationPath,
      });
      if (
        destinationStat.device === undefined ||
        destinationStat.inode === undefined
      )
        throw new GitOperationError(
          "stash.drop",
          "Bound filesystem destination identity is unavailable; refusing replacement.",
        );
      expectedDestinationExists = true;
      expectedDestinationDevice = destinationStat.device;
      expectedDestinationInode = destinationStat.inode;
    }
    await this.runBoundFilesystem(rootBinding, {
      kind: "rename",
      sourcePath,
      destinationPath,
      expectedDestinationExists,
      ...(expectedDestinationDevice === undefined
        ? {}
        : { expectedDestinationDevice }),
      ...(expectedDestinationInode === undefined
        ? {}
        : { expectedDestinationInode }),
    });
  }

  private async createAtomicStashLock(
    lockPath: string,
    ownerMetadata: string,
    rootBinding: GitRootBindingIdentity,
  ): Promise<StashLockLease> {
    const temporaryLockPath = `${lockPath}.gito-owner-${cryptoRandomToken()}`;
    try {
      return await this.gitRootBindingResolver.withBinding(
        rootBinding.canonicalPath,
        rootBinding,
        async () => {
          await this.writeAndSyncFile(
            rootBinding,
            temporaryLockPath,
            ownerMetadata,
          );
          await this.runBoundFilesystem(rootBinding, {
            kind: "link",
            sourcePath: temporaryLockPath,
            destinationPath: lockPath,
          });
          await this.removeBoundFileIfPresent(rootBinding, temporaryLockPath);
          const lockResult = await this.runBoundFilesystem(rootBinding, {
            kind: "read-stat",
            targetPath: lockPath,
          });
          const lockText = lockResult.content;
          if (lockText !== ownerMetadata)
            throw new GitOperationError(
              "stash.drop",
              "Stash lock metadata changed during acquisition; refusing mutation.",
            );
          return { close: (): Promise<void> => Promise.resolve() };
        },
      );
    } catch (error: unknown) {
      await this.removeBoundFileIfPresent(rootBinding, temporaryLockPath);
      throw error;
    }
  }

  private async acquireStashMutationLock(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<StashMutationLock> {
    const rootBinding = await this.gitRootBindingResolver.resolve(
      repositoryRoot,
      this.rootBindingContext.getStore(),
    );
    const [refPathOutput, reflogPathOutput] = await Promise.all([
      this.runGit(
        repositoryRoot,
        ["rev-parse", "--git-path", "refs/stash"],
        cancellationSignal,
      ),
      this.runGit(
        repositoryRoot,
        ["rev-parse", "--git-path", "logs/refs/stash"],
        cancellationSignal,
      ),
    ]);
    const refPath = resolveGitPath(
      repositoryRoot,
      refPathOutput.standardOutput.trim(),
    );
    const reflogPath = resolveGitPath(
      repositoryRoot,
      reflogPathOutput.standardOutput.trim(),
    );
    const zeroObjectId = await this.resolveZeroObjectId(
      repositoryRoot,
      cancellationSignal,
    );
    const refLockPath = `${refPath}.lock`;
    const reflogLockPath = `${reflogPath}.lock`;
    const transactionPath = `${refPath}.gito-transaction`;
    await this.gitRootBindingResolver.assert(
      rootBinding.canonicalPath,
      rootBinding,
    );
    const pendingJournal = await this.gitRootBindingResolver.withBinding(
      rootBinding.canonicalPath,
      rootBinding,
      () =>
        this.readStashMutationJournal(
          transactionPath,
          refPath,
          reflogPath,
          rootBinding,
        ),
    );
    await this.gitRootBindingResolver.assert(
      rootBinding.canonicalPath,
      rootBinding,
    );
    await this.removeStaleStashLocks(
      refLockPath,
      reflogLockPath,
      pendingJournal,
      rootBinding,
    );
    const ownerToken = cryptoRandomToken();
    const ownerMetadata = `${JSON.stringify({
      ownerPid: process.pid,
      ownerToken,
    })}\n`;
    let refLockHandle: StashLockLease;
    try {
      refLockHandle = await this.createAtomicStashLock(
        refLockPath,
        ownerMetadata,
        rootBinding,
      );
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "EEXIST"))
        throw new GitOperationError(
          "stash.drop",
          "Stash is changing in another process; refusing a non-atomic mutation.",
        );
      throw error;
    }
    let reflogLockHandle: StashLockLease;
    try {
      reflogLockHandle = await this.createAtomicStashLock(
        reflogLockPath,
        ownerMetadata,
        rootBinding,
      );
    } catch (error: unknown) {
      await refLockHandle.close();
      try {
        await this.removeOwnedStashLock(
          refLockPath,
          { ownerPid: process.pid, ownerToken },
          rootBinding,
        );
      } catch (cleanupError: unknown) {
        throw new GitOperationError(
          "stash.drop",
          `Stash lock cleanup failed after acquisition error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: error },
        );
      }
      if (isNodeErrorWithCode(error, "EEXIST"))
        throw new GitOperationError(
          "stash.drop",
          "Stash reflog is changing in another process; refusing a non-atomic mutation.",
        );
      throw error;
    }
    const stashMutationLock = {
      rootBinding,
      refPath,
      refLockPath,
      reflogPath,
      reflogLockPath,
      transactionPath,
      zeroObjectId,
      ownerToken,
      refLockHandle,
      reflogLockHandle,
    };
    if (pendingJournal !== undefined) {
      try {
        await this.recoverStashMutationJournal(
          stashMutationLock,
          pendingJournal,
        );
      } catch (error: unknown) {
        await this.releaseStashMutationLock(stashMutationLock);
        throw error;
      }
    }
    try {
      await this.gitRootBindingResolver.withBinding(
        rootBinding.canonicalPath,
        rootBinding,
        async () => {
          if (
            pendingJournal?.refContent !== undefined ||
            pendingJournal === undefined
          )
            if (!(await this.boundPathExists(rootBinding, refPath)))
              throw new Error("Stash ref is absent.");
          if (!(await this.boundPathExists(rootBinding, reflogPath)))
            throw new Error("Stash reflog is absent.");
        },
      );
    } catch (error: unknown) {
      await this.releaseStashMutationLock(stashMutationLock);
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      throw new GitOperationError(
        "stash.drop",
        "Stash mutation requires a loose stash ref and reflog; refusing an unsupported repository layout.",
      );
    }
    return stashMutationLock;
  }

  private async removeStaleStashLocks(
    refLockPath: string,
    reflogLockPath: string,
    pendingJournal: StashMutationJournal | undefined,
    rootBinding: GitRootBindingIdentity,
  ): Promise<void> {
    await this.gitRootBindingResolver.assert(
      rootBinding.canonicalPath,
      rootBinding,
    );
    const lockPaths = [refLockPath, reflogLockPath];
    const lockMetadata = await this.gitRootBindingResolver.withBinding(
      rootBinding.canonicalPath,
      rootBinding,
      () =>
        Promise.all(
          lockPaths.map((lockPath) =>
            this.readStashLockMetadata(lockPath, rootBinding),
          ),
        ),
    );
    const existingMetadata = lockMetadata.filter(
      (metadata): metadata is StashLockMetadata => metadata !== undefined,
    );
    if (existingMetadata.length === 0) {
      if (
        pendingJournal !== undefined &&
        isProcessAlive(pendingJournal.ownerPid)
      )
        throw new GitOperationError(
          "stash.drop",
          "A stash transaction journal is active; refusing a concurrent mutation.",
        );
      return;
    }
    const firstMetadata = existingMetadata[0];
    if (firstMetadata === undefined) return;
    const expectedOwner =
      pendingJournal === undefined
        ? undefined
        : {
            ownerPid: pendingJournal.ownerPid,
            ownerToken: pendingJournal.ownerToken,
          };
    if (
      existingMetadata.some(
        (metadata) =>
          expectedOwner !== undefined &&
          (metadata.ownerPid !== expectedOwner.ownerPid ||
            metadata.ownerToken !== expectedOwner.ownerToken),
      )
    )
      throw new GitOperationError(
        "stash.drop",
        "Stash lock ownership changed; refusing stale-lock recovery.",
      );
    if (
      existingMetadata.some(
        (metadata) =>
          metadata.ownerPid !== firstMetadata.ownerPid ||
          metadata.ownerToken !== firstMetadata.ownerToken,
      )
    )
      throw new GitOperationError(
        "stash.drop",
        "Stash lock owners do not match; refusing stale-lock recovery.",
      );
    if (isProcessAlive(firstMetadata.ownerPid))
      throw new GitOperationError(
        "stash.drop",
        "A stash transaction is active; refusing a concurrent mutation.",
      );
    for (const [lockIndex, lockPath] of lockPaths.entries())
      if (
        await this.gitRootBindingResolver.withBinding(
          rootBinding.canonicalPath,
          rootBinding,
          () => this.boundPathExists(rootBinding, lockPath),
        )
      ) {
        await this.gitRootBindingResolver.assert(
          rootBinding.canonicalPath,
          rootBinding,
        );
        const lockMetadataForPath = lockMetadata[lockIndex];
        if (lockMetadataForPath === undefined) {
          throw new GitOperationError(
            "stash.drop",
            "Stash lock ownership changed before recovery; refusing mutation.",
          );
        }
        await this.removeOwnedStashLock(
          lockPath,
          lockMetadataForPath,
          rootBinding,
        );
      }
  }

  private async readStashLockMetadata(
    lockPath: string,
    rootBinding: GitRootBindingIdentity,
  ): Promise<StashLockMetadata | undefined> {
    if (!(await this.boundPathExists(rootBinding, lockPath))) return undefined;
    const lockResult = await this.runBoundFilesystem(rootBinding, {
      kind: "read-stat",
      targetPath: lockPath,
    });
    const lockText = lockResult.content;
    const lockDevice = lockResult.device;
    const lockInode = lockResult.inode;
    if (
      lockText === undefined ||
      lockDevice === undefined ||
      lockInode === undefined
    )
      throw new GitOperationError(
        "stash.drop",
        "Stash lock metadata is unreadable; refusing mutation.",
      );
    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(lockText) as unknown;
    } catch {
      throw new GitOperationError(
        "stash.drop",
        "Stash lock metadata is unreadable; refusing mutation.",
      );
    }
    if (
      typeof parsedMetadata !== "object" ||
      parsedMetadata === null ||
      !("ownerPid" in parsedMetadata) ||
      !("ownerToken" in parsedMetadata)
    )
      throw new GitOperationError(
        "stash.drop",
        "Stash lock metadata is invalid; refusing mutation.",
      );
    const ownerPid = parsedMetadata.ownerPid;
    const ownerToken = parsedMetadata.ownerToken;
    if (!isPositiveInteger(ownerPid))
      throw new GitOperationError(
        "stash.drop",
        "Stash lock metadata is invalid; refusing mutation.",
      );
    if (typeof ownerToken !== "string" || ownerToken.length === 0)
      throw new GitOperationError(
        "stash.drop",
        "Stash lock metadata is invalid; refusing mutation.",
      );
    return {
      ownerPid,
      ownerToken,
      device: lockDevice,
      inode: lockInode,
    };
  }

  private async removeOwnedStashLock(
    lockPath: string,
    expectedMetadata: StashLockMetadata,
    rootBinding: GitRootBindingIdentity,
  ): Promise<void> {
    const quarantinePath = `${lockPath}.gito-recover-${cryptoRandomToken()}`;
    try {
      await this.gitRootBindingResolver.withBinding(
        rootBinding.canonicalPath,
        rootBinding,
        async () => {
          const currentMetadata = await this.readStashLockMetadata(
            lockPath,
            rootBinding,
          );
          if (
            currentMetadata === undefined ||
            currentMetadata.ownerPid !== expectedMetadata.ownerPid ||
            currentMetadata.ownerToken !== expectedMetadata.ownerToken ||
            (expectedMetadata.device !== undefined &&
              currentMetadata.device !== expectedMetadata.device) ||
            (expectedMetadata.inode !== undefined &&
              currentMetadata.inode !== expectedMetadata.inode)
          )
            throw new GitOperationError(
              "stash.drop",
              "Stash lock ownership changed before recovery; refusing deletion.",
            );
          await this.renameBoundFileWithTargetCas(
            rootBinding,
            lockPath,
            quarantinePath,
          );
          const quarantineMetadata = await this.readStashLockMetadata(
            quarantinePath,
            rootBinding,
          );
          if (
            quarantineMetadata === undefined ||
            quarantineMetadata.ownerPid !== expectedMetadata.ownerPid ||
            quarantineMetadata.ownerToken !== expectedMetadata.ownerToken ||
            quarantineMetadata.device !== currentMetadata.device ||
            quarantineMetadata.inode !== currentMetadata.inode
          )
            throw new GitOperationError(
              "stash.drop",
              "Stash lock ownership changed during recovery; refusing deletion.",
            );
          await this.runBoundFilesystem(rootBinding, {
            kind: "remove",
            targetPath: quarantinePath,
            ...(currentMetadata.device === undefined
              ? {}
              : { expectedDevice: currentMetadata.device }),
            ...(currentMetadata.inode === undefined
              ? {}
              : { expectedInode: currentMetadata.inode }),
          });
        },
      );
    } catch (error: unknown) {
      throw new GitOperationError(
        "stash.drop",
        `Stash lock changed before ownership recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readStashMutationJournal(
    transactionPath: string,
    refPath: string,
    reflogPath: string,
    rootBinding: GitRootBindingIdentity,
  ): Promise<StashMutationJournal | undefined> {
    if (!(await this.boundPathExists(rootBinding, transactionPath)))
      return undefined;
    const journalText = (
      await this.runBoundFilesystem(rootBinding, {
        kind: "read",
        targetPath: transactionPath,
      })
    ).content;
    if (journalText === undefined)
      throw new GitOperationError(
        "stash.drop",
        "Stash transaction journal is unreadable; refusing mutation.",
      );
    let parsedJournal: unknown;
    try {
      parsedJournal = JSON.parse(journalText) as unknown;
    } catch {
      throw new GitOperationError(
        "stash.drop",
        "Stash transaction journal is unreadable; refusing mutation.",
      );
    }
    if (
      typeof parsedJournal !== "object" ||
      parsedJournal === null ||
      !("version" in parsedJournal) ||
      !("ownerPid" in parsedJournal) ||
      !("ownerToken" in parsedJournal) ||
      !("phase" in parsedJournal) ||
      !("refPath" in parsedJournal) ||
      !("reflogPath" in parsedJournal) ||
      !("reflogContent" in parsedJournal)
    )
      throw new GitOperationError(
        "stash.drop",
        "Stash transaction journal is invalid; refusing mutation.",
      );
    const version = parsedJournal.version;
    const ownerPid = parsedJournal.ownerPid;
    const ownerToken = parsedJournal.ownerToken;
    const phase = parsedJournal.phase;
    const journalRefPath = parsedJournal.refPath;
    const journalReflogPath = parsedJournal.reflogPath;
    const reflogContent = parsedJournal.reflogContent;
    const refContent =
      "refContent" in parsedJournal ? parsedJournal.refContent : undefined;
    if (
      version !== 1 ||
      journalRefPath !== refPath ||
      journalReflogPath !== reflogPath ||
      (phase !== "prepared" &&
        phase !== "reflog-applied" &&
        phase !== "ref-applied") ||
      typeof reflogContent !== "string" ||
      (refContent !== undefined && typeof refContent !== "string")
    )
      throw new GitOperationError(
        "stash.drop",
        "Stash transaction journal is invalid; refusing mutation.",
      );
    if (!isPositiveInteger(ownerPid) || typeof ownerToken !== "string")
      throw new GitOperationError(
        "stash.drop",
        "Stash transaction journal is invalid; refusing mutation.",
      );
    return {
      version: 1,
      ownerPid,
      ownerToken,
      phase,
      refPath,
      reflogPath,
      reflogContent,
      ...(refContent === undefined ? {} : { refContent }),
    };
  }

  private async recoverStashMutationJournal(
    stashMutationLock: StashMutationLock,
    journal: StashMutationJournal,
  ): Promise<void> {
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      await this.writeAndSyncFile(
        stashMutationLock.rootBinding,
        stashMutationLock.reflogPath,
        journal.reflogContent,
      );
      await this.syncBoundDirectory(
        stashMutationLock.rootBinding,
        nodePath.dirname(stashMutationLock.reflogPath),
      );
    });
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      if (journal.refContent === undefined) {
        await this.removeBoundFileIfPresent(
          stashMutationLock.rootBinding,
          stashMutationLock.refPath,
        );
        if (
          await this.boundPathExists(
            stashMutationLock.rootBinding,
            stashMutationLock.refPath,
          )
        )
          throw new GitOperationError(
            "stash.drop",
            "Stash ref recovery expected the ref to be absent, but it still exists.",
          );
      } else {
        await this.writeAndSyncFile(
          stashMutationLock.rootBinding,
          stashMutationLock.refPath,
          journal.refContent,
        );
      }
    });
    await this.withStashMutationFilesystem(stashMutationLock, () =>
      this.syncBoundDirectory(
        stashMutationLock.rootBinding,
        nodePath.dirname(stashMutationLock.refPath),
      ),
    );
    await this.withStashMutationFilesystem(stashMutationLock, async () => {
      await this.removeBoundFileIfPresent(
        stashMutationLock.rootBinding,
        stashMutationLock.transactionPath,
      );
      await this.syncBoundDirectory(
        stashMutationLock.rootBinding,
        nodePath.dirname(stashMutationLock.transactionPath),
      );
    });
  }

  private async withStashMutationFilesystem<T>(
    stashMutationLock: StashMutationLock,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.gitRootBindingResolver.withBinding(
      stashMutationLock.rootBinding.canonicalPath,
      stashMutationLock.rootBinding,
      operation,
    );
  }

  private boundFilesystemBase(
    rootBinding: GitRootBindingIdentity,
    targetPath: string,
  ): BoundFilesystemBase {
    return selectBoundFilesystemBase(rootBinding, targetPath);
  }

  private async runBoundFilesystem(
    rootBinding: GitRootBindingIdentity,
    operation: BoundFilesystemOperation,
  ): Promise<BoundFilesystemResult> {
    const operationPath =
      operation.targetPath ?? operation.sourcePath ?? operation.destinationPath;
    if (operationPath === undefined)
      throw new GitOperationError(
        "repository",
        "Bound filesystem operation has no target path.",
      );
    if (
      operation.kind === "rename" &&
      operation.destinationPath !== undefined &&
      this.beforeBoundFilesystemRename !== undefined
    )
      await this.beforeBoundFilesystemRename(operation.destinationPath);
    if (
      operation.kind === "sync-directory" &&
      operation.targetPath !== undefined &&
      this.beforeBoundFilesystemSyncDirectory !== undefined
    )
      await this.beforeBoundFilesystemSyncDirectory(operation.targetPath);
    const base = this.boundFilesystemBase(rootBinding, operationPath);
    return runBoundFilesystemOperation(base, operation);
  }

  private async boundPathExists(
    rootBinding: GitRootBindingIdentity,
    filePath: string,
  ): Promise<boolean> {
    return boundFilesystemPathExists(rootBinding, filePath);
  }

  private async removeBoundFileIfPresent(
    rootBinding: GitRootBindingIdentity,
    filePath: string,
  ): Promise<void> {
    if (await this.boundPathExists(rootBinding, filePath))
      await this.runBoundFilesystem(rootBinding, {
        kind: "remove",
        targetPath: filePath,
      });
  }

  private async syncBoundDirectory(
    rootBinding: GitRootBindingIdentity,
    directoryPath: string,
  ): Promise<void> {
    await this.runBoundFilesystem(rootBinding, {
      kind: "sync-directory",
      targetPath: directoryPath,
    });
  }

  private async releaseStashMutationLock(
    stashMutationLock: StashMutationLock,
  ): Promise<void> {
    let firstCleanupError: unknown;
    try {
      await stashMutationLock.reflogLockHandle.close();
    } catch (error: unknown) {
      firstCleanupError ??= error;
    }
    try {
      await stashMutationLock.refLockHandle.close();
    } catch (error: unknown) {
      firstCleanupError ??= error;
    }
    try {
      await this.gitRootBindingResolver.withBinding(
        stashMutationLock.rootBinding.canonicalPath,
        stashMutationLock.rootBinding,
        async () => {
          const ownerMetadata = {
            ownerPid: process.pid,
            ownerToken: stashMutationLock.ownerToken,
          };
          for (const lockPath of [
            stashMutationLock.reflogLockPath,
            stashMutationLock.refLockPath,
          ]) {
            if (
              await this.boundPathExists(
                stashMutationLock.rootBinding,
                lockPath,
              )
            )
              await this.removeOwnedStashLock(
                lockPath,
                ownerMetadata,
                stashMutationLock.rootBinding,
              );
          }
        },
      );
    } catch (error: unknown) {
      firstCleanupError ??= error;
    }
    if (firstCleanupError !== undefined) {
      const cleanupError =
        firstCleanupError instanceof Error
          ? firstCleanupError
          : new Error("Stash lock cleanup failed.");
      throw cleanupError;
    }
  }

  private async isCommitishPinned(
    repositoryRoot: string,
    commitish: string,
    expectedCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return (
        (await this.resolveCommitish(
          repositoryRoot,
          commitish,
          cancellationSignal,
        )) === expectedCommit
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async isRefObjectPinned(
    repositoryRoot: string,
    refName: string,
    expectedObjectId: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return (
        (await this.resolveRefObject(
          repositoryRoot,
          refName,
          cancellationSignal,
        )) === expectedObjectId
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async verifyTagPostcondition(
    repositoryRoot: string,
    tagName: string,
    targetCommit: string,
    annotated: boolean,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const objectType = (
        await this.runGit(
          repositoryRoot,
          ["cat-file", "-t", `refs/tags/${tagName}`],
          cancellationSignal,
        )
      ).standardOutput.trim();
      const resolvedCommit = (
        await this.runGit(
          repositoryRoot,
          ["rev-parse", "--verify", `refs/tags/${tagName}^{commit}`],
          cancellationSignal,
        )
      ).standardOutput.trim();
      return (
        objectType === (annotated ? "tag" : "commit") &&
        resolvedCommit === targetCommit
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async isAncestorOfHead(
    repositoryRoot: string,
    targetCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    return this.commandExists(
      repositoryRoot,
      ["merge-base", "--is-ancestor", targetCommit, "HEAD"],
      cancellationSignal,
    );
  }

  private async resolveCurrentBranch(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const branchOutput = await this.tryRunGit(
      repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cancellationSignal,
    );
    const branchName = branchOutput?.standardOutput.trim();
    return branchName === undefined || branchName.length === 0
      ? undefined
      : branchName;
  }

  private async resolveZeroObjectId(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string> {
    const objectFormat = (
      await this.runGit(
        repositoryRoot,
        ["rev-parse", "--show-object-format=storage"],
        cancellationSignal,
      )
    ).standardOutput.trim();
    if (objectFormat === "sha1") return "0".repeat(40);
    if (objectFormat === "sha256") return "0".repeat(64);
    throw new GitOperationError(
      "repository",
      `Unsupported Git object format ${objectFormat}; refusing a width-ambiguous CAS mutation.`,
    );
  }

  private async verifyRebaseRefs(
    repositoryRoot: string,
    upstreamRef: string,
    upstreamCommit: string,
    ontoRef: string | undefined,
    ontoCommit: string | undefined,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !(await this.isCommitishPinned(
        repositoryRoot,
        upstreamRef,
        upstreamCommit,
        cancellationSignal,
      ))
    )
      return false;
    return ontoRef === undefined || ontoCommit === undefined
      ? true
      : this.isCommitishPinned(
          repositoryRoot,
          ontoRef,
          ontoCommit,
          cancellationSignal,
        );
  }

  private async verifyRebaseReadback(
    repositoryRoot: string,
    expectedBranch: string | undefined,
    ontoCommit: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    const state = await this.readRepositoryState(
      repositoryRoot,
      cancellationSignal,
    );
    if (state.inProgressOperation !== undefined || state.hasConflicts)
      return false;
    if (expectedBranch !== undefined && state.headRef !== expectedBranch)
      return false;
    return this.isAncestorOfHead(
      repositoryRoot,
      ontoCommit,
      cancellationSignal,
    );
  }

  private async verifyRebaseActionReadback(
    repositoryRoot: string,
    expectedBranch: string | undefined,
    action: "continue" | "skip" | "abort",
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    const state = await this.readRepositoryState(
      repositoryRoot,
      cancellationSignal,
    );
    if (state.hasConflicts && action !== "abort") return false;
    if (expectedBranch !== undefined && state.headRef !== expectedBranch)
      return false;
    return action === "abort"
      ? state.inProgressOperation === undefined
      : state.inProgressOperation === undefined ||
          state.inProgressOperation === "rebase";
  }

  private async verifyBisectRefs(
    repositoryRoot: string,
    badRef: string | undefined,
    badCommit: string | undefined,
    goodRefs: readonly string[],
    goodCommits: readonly string[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (badRef !== undefined && badCommit !== undefined) {
      if (
        !(await this.isCommitishPinned(
          repositoryRoot,
          badRef,
          badCommit,
          cancellationSignal,
        ))
      )
        return false;
    }
    for (let commitIndex = 0; commitIndex < goodRefs.length; commitIndex += 1) {
      const goodRef = goodRefs[commitIndex];
      const goodCommit = goodCommits[commitIndex];
      if (
        goodRef === undefined ||
        goodCommit === undefined ||
        !(await this.isCommitishPinned(
          repositoryRoot,
          goodRef,
          goodCommit,
          cancellationSignal,
        ))
      )
        return false;
    }
    return true;
  }

  private async verifyBisectReadback(
    repositoryRoot: string,
    expectedBranch: string | undefined,
    action: "start" | "good" | "bad" | "skip" | "reset",
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    const state = await this.readRepositoryState(
      repositoryRoot,
      cancellationSignal,
    );
    if (state.hasConflicts) return false;
    if (action === "reset") {
      return (
        state.inProgressOperation === undefined &&
        (expectedBranch === undefined || state.headRef === expectedBranch)
      );
    }
    if (action === "start") return state.inProgressOperation === "bisect";
    // Git may finish the search on the last mark; otherwise the marker must remain.
    return (
      state.inProgressOperation === "bisect" ||
      (state.inProgressOperation === undefined && expectedBranch !== undefined)
    );
  }

  private async readRepositoryStateCommandOutput(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<RepositoryStateCommandOutput> {
    const topLevelOutput = await this.runGit(
      repositoryRoot,
      ["rev-parse", "--show-toplevel"],
      cancellationSignal,
    );
    const gitDirectoryOutput = await this.runGit(
      repositoryRoot,
      ["rev-parse", "--git-dir"],
      cancellationSignal,
    );
    const headCommitOutput = await this.tryRunGit(
      repositoryRoot,
      ["rev-parse", "--verify", "HEAD"],
      cancellationSignal,
    );
    const headRefOutput = await this.tryRunGit(
      repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cancellationSignal,
    );
    const normalizedRepositoryRoot = await normalizeRepositoryPath(
      topLevelOutput.standardOutput.trim(),
    );
    const gitDirectory = nodePath.isAbsolute(
      gitDirectoryOutput.standardOutput.trim(),
    )
      ? gitDirectoryOutput.standardOutput.trim()
      : nodePath.resolve(
          normalizedRepositoryRoot,
          gitDirectoryOutput.standardOutput.trim(),
        );
    return {
      statusOutput: "",
      repositoryRoot: normalizedRepositoryRoot,
      ...(headCommitOutput === undefined
        ? {}
        : { headCommit: headCommitOutput.standardOutput.trim() }),
      ...(headRefOutput === undefined
        ? {}
        : { headRef: headRefOutput.standardOutput.trim() }),
      gitDirectory,
    };
  }

  private async runGit(
    repositoryRoot: string,
    commandArguments: readonly string[],
    cancellationSignal?: AbortSignal,
    maxStandardOutputBytes?: number,
  ): Promise<GitCommandOutput> {
    throwIfCancelled(cancellationSignal);
    const rootBinding =
      this.rootBindingContext.getStore() ??
      (await this.gitRootBindingResolver.resolve(repositoryRoot));
    try {
      const commandOutput = await this.commandRunner.run({
        repositoryRoot,
        arguments: commandArguments,
        cancellationSignal,
        ...(rootBinding === undefined ? {} : { rootBinding }),
        ...(maxStandardOutputBytes === undefined
          ? {}
          : { maxStandardOutputBytes }),
      });
      if (commandOutput.standardOutputTruncated)
        throw new GitOperationError(
          "repository",
          `Git output exceeded the ${maxStandardOutputBytes ?? 0}-byte safety cap.`,
        );
      return commandOutput;
    } catch (error: unknown) {
      if (error instanceof GitOperationError || isAbortError(error))
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GitOperationError("repository", redactGitErrorMessage(message));
    }
  }

  private async runGitWithStandardInput(
    repositoryRoot: string,
    commandArguments: readonly string[],
    standardInput: string,
    cancellationSignal?: AbortSignal,
  ): Promise<GitCommandOutput> {
    throwIfCancelled(cancellationSignal);
    const rootBinding =
      this.rootBindingContext.getStore() ??
      (await this.gitRootBindingResolver.resolve(repositoryRoot));
    try {
      return await this.commandRunner.run({
        repositoryRoot,
        arguments: commandArguments,
        cancellationSignal,
        standardInput,
        ...(rootBinding === undefined ? {} : { rootBinding }),
      });
    } catch (error: unknown) {
      if (error instanceof GitOperationError || isAbortError(error))
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GitOperationError("repository", redactGitErrorMessage(message));
    }
  }

  private async assertLocalRemoteBindings(
    localRemoteBindings: readonly LocalRemoteBinding[],
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(cancellationSignal);
    for (const localRemoteBinding of localRemoteBindings) {
      throwIfCancelled(cancellationSignal);
      try {
        const currentBinding = await readLocalRemoteBinding(
          localRemoteBinding.requestedPath,
        );
        if (!sameLocalRemoteBinding(currentBinding, localRemoteBinding))
          throw new Error("Local remote target identity changed.");
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        throw new Error(
          "Local remote target binding changed after preview; create a fresh preview.",
          { cause: error },
        );
      }
    }
  }

  private async tryRunGit(
    repositoryRoot: string,
    commandArguments: readonly string[],
    cancellationSignal?: AbortSignal,
  ): Promise<GitCommandOutput | undefined> {
    const commandText = commandArguments.join(" ");
    const readsOptionalConfiguration =
      commandArguments[0] === "config" &&
      (commandArguments.includes("--get-all") ||
        commandArguments.includes("--get-regexp"));
    try {
      return await this.runGit(
        repositoryRoot,
        commandArguments,
        cancellationSignal,
      );
    } catch (error: unknown) {
      if (
        error instanceof GitOperationError &&
        (/verify|symbolic-ref/.test(commandText) || readsOptionalConfiguration)
      )
        return undefined;
      throw error;
    }
  }

  private async commandExists(
    repositoryRoot: string,
    commandArguments: readonly string[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.runGit(repositoryRoot, commandArguments, cancellationSignal);
      return true;
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async commandOutputMatches(
    repositoryRoot: string,
    commandArguments: readonly string[],
    expectedOutput: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const commandOutput = await this.runGit(
        repositoryRoot,
        commandArguments,
        cancellationSignal,
      );
      return commandOutput.standardOutput.trim() === expectedOutput;
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async captureCleanCandidates(
    repositoryRoot: string,
    request: CleanPreviewRequest,
    cancellationSignal?: AbortSignal,
  ): Promise<{
    readonly paths: readonly string[];
    readonly bindings: readonly GitCleanCandidateBinding[];
  }> {
    const output = await this.runGit(
      repositoryRoot,
      buildCleanCandidateListingArguments(request),
      cancellationSignal,
    );
    const candidates = output.standardOutput
      .split("\0")
      .filter(
        (statusEntry) =>
          statusEntry.startsWith("?? ") || statusEntry.startsWith("!! "),
      )
      .filter(
        (statusEntry) =>
          request.includeIgnored === true || statusEntry.startsWith("?? "),
      )
      .map((statusEntry) => validateCleanCandidatePath(statusEntry.slice(3)))
      .filter((candidatePath) => candidatePath !== undefined);
    const paths = [...new Set(candidates)];
    return {
      paths,
      bindings: await this.captureCleanCandidateBindings(repositoryRoot, paths),
    };
  }

  private async captureCleanCandidateBindings(
    repositoryRoot: string,
    candidatePaths: readonly string[],
  ): Promise<readonly GitCleanCandidateBinding[]> {
    const rootBinding =
      this.rootBindingContext.getStore() ??
      (await this.gitRootBindingResolver.resolve(repositoryRoot));
    const bindings: GitCleanCandidateBinding[] = [];
    for (const candidatePath of candidatePaths) {
      const stat = await this.runBoundFilesystem(rootBinding, {
        kind: "read-stat-any",
        targetPath: nodePath.join(repositoryRoot, candidatePath),
      });
      if (
        stat.kind === undefined ||
        stat.device === undefined ||
        stat.inode === undefined ||
        stat.parentFingerprint === undefined
      )
        throw new GitOperationError(
          "clean.execute",
          `Clean candidate ${candidatePath} could not be pinned safely; refresh the preview.`,
        );
      bindings.push({
        path: candidatePath,
        kind: stat.kind,
        device: stat.device,
        inode: stat.inode,
        parentFingerprint: stat.parentFingerprint,
      });
    }
    return bindings;
  }

  private async resolvePushDetails(
    request: PushRequest,
  ): Promise<PushTargetDetails> {
    const remoteName = await this.resolveRemoteName(
      request.repositoryRoot,
      request.remoteName,
      request.cancellationSignal,
    );
    const remoteUrl = await this.readRemoteUrl(
      request.repositoryRoot,
      remoteName,
      true,
      request.cancellationSignal,
    );
    const rawRefspec = request.refspec;
    const refspecParts = rawRefspec?.split(":");
    if (refspecParts !== undefined && refspecParts.length > 2)
      throw new GitOperationError("push", "Push refspec has too many colons.");
    const explicitSource = refspecParts?.[0]?.trim();
    const explicitDestination = refspecParts?.[1]?.trim();
    const deleting =
      request.deleteRemoteBranch === true || explicitSource === "";
    if (deleting && explicitSource !== undefined && explicitSource.length > 0)
      throw new GitOperationError(
        "push",
        "A delete push must use an empty source ref.",
      );
    const currentBranch = await this.resolveCurrentBranch(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    const sourceRef = deleting
      ? undefined
      : normalizeLocalPushSourceRef(
          explicitSource ?? request.branchName ?? currentBranch,
        );
    const destinationRef = normalizeRemoteDestinationRef(
      explicitDestination ??
        request.branchName ??
        (sourceRef === undefined ? undefined : sourceRef),
    );
    const sourceCommit =
      sourceRef === undefined
        ? undefined
        : await this.resolveCommitish(
            request.repositoryRoot,
            sourceRef,
            request.cancellationSignal,
          );
    const destinationCommit = await this.resolveRemoteUrlRefCommit(
      request.repositoryRoot,
      remoteUrl,
      destinationRef,
      request.cancellationSignal,
    );
    return {
      remoteName,
      remoteUrl,
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      destinationRef,
      ...(destinationCommit === undefined ? {} : { destinationCommit }),
      deleting,
    };
  }

  private async resolvePullTarget(
    request: PullRequest,
  ): Promise<PullTargetDetails> {
    let remoteName = request.remoteName;
    let remoteBranch = request.branchName;
    if (remoteName === undefined || remoteBranch === undefined) {
      const upstreamOutput = await this.tryRunGit(
        request.repositoryRoot,
        ["symbolic-ref", "--quiet", "--short", "@{upstream}"],
        request.cancellationSignal,
      );
      const upstreamName = upstreamOutput?.standardOutput.trim();
      if (upstreamName === undefined || upstreamName.length === 0)
        throw new GitOperationError(
          "pull",
          "No upstream remote is configured; choose a remote and branch.",
        );
      const upstreamParts = upstreamName
        .replace(/^refs\/remotes\//, "")
        .split("/");
      remoteName ??= upstreamParts.shift();
      remoteBranch ??= upstreamParts.join("/");
    }
    if (
      remoteName === undefined ||
      remoteBranch === undefined ||
      remoteBranch.length === 0
    )
      throw new GitOperationError(
        "pull",
        "Pull remote and branch are required.",
      );
    assertRemoteName(remoteName);
    assertBranchName(remoteBranch);
    const remoteRef = `refs/remotes/${remoteName}/${remoteBranch}`;
    const remoteSourceRef = `refs/heads/${remoteBranch}`;
    const remoteUrl = await this.readRemoteUrl(
      request.repositoryRoot,
      remoteName,
      false,
      request.cancellationSignal,
    );
    const remoteCommit = await this.resolveRemoteUrlRefCommit(
      request.repositoryRoot,
      remoteUrl,
      remoteSourceRef,
      request.cancellationSignal,
    );
    if (remoteCommit === undefined)
      throw new GitOperationError(
        "pull",
        `Remote ${remoteName} has no branch ${remoteBranch}.`,
      );
    return { remoteName, remoteUrl, remoteRef, remoteSourceRef, remoteCommit };
  }

  private async resolveRemoteName(
    repositoryRoot: string,
    requestedRemoteName: string | undefined,
    cancellationSignal?: AbortSignal,
  ): Promise<string> {
    if (requestedRemoteName !== undefined) return requestedRemoteName;
    const upstreamOutput = await this.tryRunGit(
      repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "@{upstream}"],
      cancellationSignal,
    );
    const upstreamName = upstreamOutput?.standardOutput.trim();
    const upstreamRemote = upstreamName?.split("/", 1)[0];
    if (upstreamRemote !== undefined && upstreamRemote.length > 0)
      return upstreamRemote;
    const remoteOutput = await this.runGit(
      repositoryRoot,
      ["remote"],
      cancellationSignal,
    );
    const remoteNames = remoteOutput.standardOutput
      .split(/\r?\n/)
      .map((remoteName) => remoteName.trim())
      .filter(Boolean);
    if (remoteNames.length === 1) {
      const [remoteName] = remoteNames;
      if (remoteName !== undefined) return remoteName;
    }
    throw new GitOperationError(
      "push",
      remoteNames.length === 0
        ? "No remote is configured; add a remote before pushing."
        : "Multiple remotes are configured; choose the push remote explicitly.",
    );
  }

  private async readRemoteUrl(
    repositoryRoot: string,
    remoteName: string,
    forPush: boolean,
    cancellationSignal?: AbortSignal,
  ): Promise<string> {
    const remoteUrlOutput = (
      await this.runGit(
        repositoryRoot,
        [
          "remote",
          "get-url",
          ...(forPush ? ["--push"] : []),
          "--all",
          remoteName,
        ],
        cancellationSignal,
      )
    ).standardOutput;
    const remoteUrls = remoteUrlOutput
      .split(/\r?\n/)
      .map((remoteUrl) => remoteUrl.trim())
      .filter((remoteUrl) => remoteUrl.length > 0);
    if (remoteUrls.length === 0)
      throw new GitOperationError(
        "repository",
        `Remote ${remoteName} has no URL.`,
      );
    if (remoteUrls.length > 1)
      throw new GitOperationError(
        "repository",
        `Remote ${remoteName} has multiple ${forPush ? "push" : "fetch"} URLs; refusing an ambiguous destination.`,
      );
    const [remoteUrl] = remoteUrls;
    if (remoteUrl === undefined)
      throw new GitOperationError(
        "repository",
        `Remote ${remoteName} has no URL.`,
      );
    assertRemoteUrl(remoteUrl);
    return remoteUrl;
  }

  private async readRemoteConfiguration(
    repositoryRoot: string,
    remoteName: string,
    cancellationSignal?: AbortSignal,
  ): Promise<RemoteConfigurationSnapshot> {
    const [fetchUrl, pushUrl, fetchRefspecs] = await Promise.all([
      this.readRemoteUrl(repositoryRoot, remoteName, false, cancellationSignal),
      this.readRemoteUrl(repositoryRoot, remoteName, true, cancellationSignal),
      this.readRemoteFetchRefspecs(
        repositoryRoot,
        remoteName,
        cancellationSignal,
      ),
    ]);
    return {
      fetchUrls: [fetchUrl],
      pushUrls: [pushUrl],
      fetchRefspecs,
    };
  }

  private async readBranchConfiguration(
    repositoryRoot: string,
    branchName: string,
    cancellationSignal?: AbortSignal,
  ): Promise<BranchConfigurationSnapshot> {
    const configurationOutput = await this.tryRunGit(
      repositoryRoot,
      [
        "config",
        "--local",
        "--null",
        "--get-regexp",
        `^branch\\.${escapeRegExp(branchName)}\\.`,
      ],
      cancellationSignal,
    );
    if (configurationOutput === undefined) return { entries: [] };
    const entries = configurationOutput.standardOutput
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separatorIndex = entry.indexOf("\n");
        if (separatorIndex <= 0)
          throw new GitOperationError(
            "branch.rename",
            "Git returned malformed branch configuration; refusing a non-atomic rename.",
          );
        return {
          key: entry.slice(0, separatorIndex),
          value: entry.slice(separatorIndex + 1),
        };
      });
    return { entries };
  }

  private async branchConfigurationMatches(
    repositoryRoot: string,
    branchName: string,
    expectedConfiguration: BranchConfigurationSnapshot,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const actualConfiguration = await this.readBranchConfiguration(
        repositoryRoot,
        branchName,
        cancellationSignal,
      );
      return sameBranchConfiguration(
        actualConfiguration,
        expectedConfiguration,
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async branchUpstreamConfigurationMatches(
    repositoryRoot: string,
    branchName: string,
    expected: { readonly remote: string; readonly merge: string } | undefined,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const [remoteValues, mergeValues] = await Promise.all([
        this.readConfigValues(
          repositoryRoot,
          `branch.${branchName}.remote`,
          cancellationSignal,
        ),
        this.readConfigValues(
          repositoryRoot,
          `branch.${branchName}.merge`,
          cancellationSignal,
        ),
      ]);
      if (expected === undefined)
        return remoteValues.length === 0 && mergeValues.length === 0;
      return (
        remoteValues.length === 1 &&
        remoteValues[0] === expected.remote &&
        mergeValues.length === 1 &&
        mergeValues[0] === expected.merge
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async readConfigValues(
    repositoryRoot: string,
    configurationKey: string,
    cancellationSignal?: AbortSignal,
  ): Promise<readonly string[]> {
    const output = await this.tryRunGit(
      repositoryRoot,
      ["config", "--local", "--null", "--get-all", configurationKey],
      cancellationSignal,
    );
    return (output?.standardOutput ?? "")
      .split("\0")
      .filter((configurationValue) => configurationValue.length > 0);
  }

  private async rollbackBranchRename(
    repositoryRoot: string,
    oldBranchName: string,
    newBranchName: string,
    oldBranchCommit: string,
    zeroObjectId: string,
    originalHeadRef: string | undefined,
    originalHeadCommit: string,
    oldBranchConfiguration: BranchConfigurationSnapshot,
  ): Promise<boolean> {
    const oldBranchRef = `refs/heads/${oldBranchName}`;
    const newBranchRef = `refs/heads/${newBranchName}`;
    const currentOldCommit = await this.resolveOptionalRefObject(
      repositoryRoot,
      oldBranchRef,
    );
    const currentNewCommit = await this.resolveOptionalRefObject(
      repositoryRoot,
      newBranchRef,
    );
    if (
      currentOldCommit === undefined &&
      currentNewCommit === oldBranchCommit
    ) {
      await this.runGitWithStandardInput(
        repositoryRoot,
        ["update-ref", "--stdin", "-m", "rollback branch rename"],
        [
          "start",
          `update ${oldBranchRef} ${oldBranchCommit} ${zeroObjectId}`,
          `delete ${newBranchRef} ${oldBranchCommit}`,
          "prepare",
          "commit",
          "",
        ].join("\n"),
      );
    } else if (
      currentOldCommit !== oldBranchCommit ||
      currentNewCommit !== undefined
    ) {
      throw new GitOperationError(
        "branch.rename",
        "Branch rename rollback found an unexpected ref state; refusing to overwrite concurrent changes.",
      );
    }

    const oldConfiguration = await this.readBranchConfiguration(
      repositoryRoot,
      oldBranchName,
    );
    const newConfiguration = await this.readBranchConfiguration(
      repositoryRoot,
      newBranchName,
    );
    const renamedConfiguration = renameBranchConfiguration(
      oldBranchConfiguration,
      oldBranchName,
      newBranchName,
    );
    if (
      oldBranchConfiguration.entries.length > 0 &&
      sameBranchConfiguration(oldConfiguration, { entries: [] }) &&
      sameBranchConfiguration(newConfiguration, renamedConfiguration)
    ) {
      await this.runGit(repositoryRoot, [
        "config",
        "--local",
        "--rename-section",
        `branch.${newBranchName}`,
        `branch.${oldBranchName}`,
      ]);
    } else if (
      !sameBranchConfiguration(oldConfiguration, oldBranchConfiguration) ||
      !sameBranchConfiguration(newConfiguration, { entries: [] })
    ) {
      throw new GitOperationError(
        "branch.rename",
        "Branch rename rollback found unexpected branch configuration; refusing to overwrite concurrent changes.",
      );
    }

    const currentHeadOutput = await this.tryRunGit(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const currentHeadRef =
      currentHeadOutput?.standardOutput.trim() || undefined;
    const expectedHeadRefAfterRename =
      originalHeadRef === oldBranchName ? newBranchName : originalHeadRef;
    if (
      currentHeadRef !== originalHeadRef &&
      currentHeadRef !== expectedHeadRefAfterRename
    )
      throw new GitOperationError(
        "branch.rename",
        "Branch rename rollback found an unexpected HEAD; refusing to overwrite concurrent changes.",
      );
    if (
      currentHeadRef === expectedHeadRefAfterRename &&
      currentHeadRef !== originalHeadRef &&
      originalHeadRef !== undefined
    ) {
      await this.runGit(repositoryRoot, [
        "symbolic-ref",
        "HEAD",
        `refs/heads/${originalHeadRef}`,
      ]);
    }
    const currentHeadCommit = await this.resolveCommitish(
      repositoryRoot,
      "HEAD",
    );
    if (currentHeadCommit !== originalHeadCommit)
      throw new GitOperationError(
        "branch.rename",
        "Branch rename rollback found an unexpected HEAD commit.",
      );

    return (
      (await this.resolveOptionalRefObject(repositoryRoot, oldBranchRef)) ===
        oldBranchCommit &&
      (await this.resolveOptionalRefObject(repositoryRoot, newBranchRef)) ===
        undefined &&
      (await this.branchConfigurationMatches(
        repositoryRoot,
        oldBranchName,
        oldBranchConfiguration,
      )) &&
      (await this.branchConfigurationMatches(repositoryRoot, newBranchName, {
        entries: [],
      })) &&
      ((
        await this.tryRunGit(repositoryRoot, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])
      )?.standardOutput.trim() || undefined) === originalHeadRef &&
      (await this.resolveCommitish(repositoryRoot, "HEAD")) ===
        originalHeadCommit
    );
  }

  private async readRemoteFetchRefspecs(
    repositoryRoot: string,
    remoteName: string,
    cancellationSignal?: AbortSignal,
  ): Promise<readonly string[]> {
    const fetchRefspecOutput = await this.tryRunGit(
      repositoryRoot,
      ["config", "--get-all", `remote.${remoteName}.fetch`],
      cancellationSignal,
    );
    return (fetchRefspecOutput?.standardOutput ?? "")
      .split(/\r?\n/)
      .map((refspec) => refspec.trim())
      .filter((refspec) => refspec.length > 0);
  }

  private async remoteConfigurationMatches(
    repositoryRoot: string,
    remoteName: string,
    expectedConfiguration: RemoteConfigurationSnapshot,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const currentConfiguration = await this.readRemoteConfiguration(
        repositoryRoot,
        remoteName,
        cancellationSignal,
      );
      return (
        sameStringList(
          currentConfiguration.fetchUrls,
          expectedConfiguration.fetchUrls,
        ) &&
        sameStringList(
          currentConfiguration.pushUrls,
          expectedConfiguration.pushUrls,
        ) &&
        sameStringList(
          currentConfiguration.fetchRefspecs,
          expectedConfiguration.fetchRefspecs,
        )
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  private async resolveRemoteUrlRefCommit(
    repositoryRoot: string,
    remoteUrl: string,
    remoteRef: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const output = (
      await this.runGit(
        repositoryRoot,
        ["ls-remote", remoteUrl, remoteRef],
        cancellationSignal,
      )
    ).standardOutput.trim();
    const remoteObjectId = output.split(/\s+/, 1)[0];
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(remoteObjectId ?? "")
      ? remoteObjectId
      : undefined;
  }

  private async resolveOptionalRefObject(
    repositoryRoot: string,
    refName: string,
    cancellationSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const output = await this.tryRunGit(
      repositoryRoot,
      ["rev-parse", "--verify", refName],
      cancellationSignal,
    );
    const objectId = output?.standardOutput.trim();
    return objectId === undefined || objectId.length === 0
      ? undefined
      : objectId;
  }

  private async resolveFetchTargets(
    request: FetchRequest,
  ): Promise<readonly FetchTargetDetails[]> {
    let remoteNames: readonly string[];
    if (request.all) {
      const remoteOutput = await this.runGit(
        request.repositoryRoot,
        ["remote"],
        request.cancellationSignal,
      );
      remoteNames = remoteOutput.standardOutput
        .split(/\r?\n/)
        .map((remoteName) => remoteName.trim())
        .filter(Boolean);
    } else {
      remoteNames = [
        await this.resolveRemoteName(
          request.repositoryRoot,
          request.remoteName,
          request.cancellationSignal,
        ),
      ];
    }
    if (remoteNames.length === 0)
      throw new GitOperationError(
        "fetch",
        "No remote is configured; fetch cannot run.",
      );
    const fetchTargets: FetchTargetDetails[] = [];
    for (const remoteName of remoteNames) {
      const remoteUrl = await this.readRemoteUrl(
        request.repositoryRoot,
        remoteName,
        false,
        request.cancellationSignal,
      );
      const configuredRefspecOutput =
        request.refspec === undefined
          ? await this.tryRunGit(
              request.repositoryRoot,
              ["config", "--get-all", `remote.${remoteName}.fetch`],
              request.cancellationSignal,
            )
          : undefined;
      const configuredRefspecs = (configuredRefspecOutput?.standardOutput ?? "")
        .split(/\r?\n/)
        .map((refspec) => refspec.trim())
        .filter((refspec) => refspec.length > 0);
      const fetchRefspecs =
        request.refspec === undefined
          ? configuredRefspecs.length > 0
            ? configuredRefspecs
            : [`+refs/heads/*:refs/remotes/${remoteName}/*`]
          : [request.refspec];
      const remoteRefs = await this.readRemoteRefs(
        request.repositoryRoot,
        remoteName,
        remoteUrl,
        fetchRefspecs,
        request.cancellationSignal,
      );
      fetchTargets.push({
        remoteName,
        remoteUrl,
        fetchRefspecs,
        configuredFetchRefspecs: configuredRefspecs,
        pinConfiguredFetchRefspecs: request.refspec === undefined,
        remoteRefs,
      });
    }
    return fetchTargets;
  }

  private buildExactFetchArguments(
    fetchTarget: FetchTargetDetails,
    prune: boolean,
  ): string[] {
    return [
      "fetch",
      "--no-tags",
      ...(prune ? ["--prune"] : []),
      fetchTarget.remoteUrl,
      ...fetchTarget.remoteRefs.map(
        (remoteRef) =>
          `${remoteRef.forceUpdate ? "+" : ""}${remoteRef.remoteCommit}:${remoteRef.localRef}`,
      ),
    ];
  }

  private async readRemoteRefs(
    repositoryRoot: string,
    remoteName: string,
    remoteUrl: string,
    effectiveRefspecs: readonly string[],
    cancellationSignal?: AbortSignal,
  ): Promise<
    readonly {
      readonly remoteRef: string;
      readonly remoteCommit: string;
      readonly localRef: string;
      readonly forceUpdate: boolean;
      readonly localObjectId?: string;
    }[]
  > {
    const remoteOutput = await this.runGit(
      repositoryRoot,
      ["ls-remote", remoteUrl],
      cancellationSignal,
    );
    const remoteRefs: {
      remoteRef: string;
      remoteCommit: string;
      localRef: string;
      forceUpdate: boolean;
      localObjectId?: string;
    }[] = [];
    for (const line of remoteOutput.standardOutput.split(/\r?\n/)) {
      const [remoteCommit, remoteRef] = line.trim().split(/\s+/, 2);
      if (
        remoteRef === undefined ||
        remoteRef === "HEAD" ||
        remoteRef.endsWith("^{}") ||
        remoteCommit === undefined ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(remoteCommit)
      )
        continue;
      if (isFetchRefspecExcluded(remoteRef, effectiveRefspecs)) continue;
      const matchingLocalRefs = new Map<string, boolean>();
      for (const refspec of effectiveRefspecs) {
        const localRef = mapFetchRefspec(remoteRef, refspec, remoteName);
        if (localRef !== undefined)
          matchingLocalRefs.set(
            localRef,
            (matchingLocalRefs.get(localRef) ?? false) ||
              refspec.startsWith("+"),
          );
      }
      for (const [localRef, forceUpdate] of matchingLocalRefs) {
        const localObjectOutput = await this.tryRunGit(
          repositoryRoot,
          ["rev-parse", "--verify", localRef],
          cancellationSignal,
        );
        const localObjectId = localObjectOutput?.standardOutput.trim();
        remoteRefs.push({
          remoteRef,
          remoteCommit,
          localRef,
          forceUpdate,
          ...(localObjectId === undefined || localObjectId.length === 0
            ? {}
            : { localObjectId }),
        });
      }
    }
    if (remoteRefs.length === 0)
      throw new GitOperationError(
        "fetch",
        `No exact remote refs matched the requested fetch target for ${remoteName}.`,
      );
    return remoteRefs;
  }

  private async verifyFetchPinnedSources(
    repositoryRoot: string,
    fetchTargets: readonly FetchTargetDetails[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !(await this.verifyFetchRemoteSources(
        repositoryRoot,
        fetchTargets,
        cancellationSignal,
      ))
    )
      return false;
    for (const fetchTarget of fetchTargets) {
      for (const remoteRef of fetchTarget.remoteRefs) {
        const currentLocalObjectId = await this.resolveOptionalRefObject(
          repositoryRoot,
          remoteRef.localRef,
          cancellationSignal,
        );
        if (currentLocalObjectId !== remoteRef.localObjectId) return false;
      }
    }
    return true;
  }

  private async verifyFetchRemoteSources(
    repositoryRoot: string,
    fetchTargets: readonly FetchTargetDetails[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    for (const fetchTarget of fetchTargets) {
      if (
        !(await this.commandOutputMatches(
          repositoryRoot,
          ["remote", "get-url", "--all", fetchTarget.remoteName],
          fetchTarget.remoteUrl,
          cancellationSignal,
        ))
      )
        return false;
      if (
        fetchTarget.pinConfiguredFetchRefspecs &&
        !sameStringList(
          await this.readRemoteFetchRefspecs(
            repositoryRoot,
            fetchTarget.remoteName,
            cancellationSignal,
          ),
          fetchTarget.configuredFetchRefspecs,
        )
      )
        return false;
      for (const remoteRef of fetchTarget.remoteRefs) {
        if (
          (await this.resolveRemoteUrlRefCommit(
            repositoryRoot,
            fetchTarget.remoteUrl,
            remoteRef.remoteRef,
            cancellationSignal,
          )) !== remoteRef.remoteCommit
        )
          return false;
      }
    }
    return true;
  }

  private async verifyFetchReadback(
    repositoryRoot: string,
    fetchTargets: readonly FetchTargetDetails[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !(await this.verifyFetchRemoteSources(
        repositoryRoot,
        fetchTargets,
        cancellationSignal,
      ))
    )
      return false;
    for (const fetchTarget of fetchTargets) {
      for (const remoteRef of fetchTarget.remoteRefs) {
        if (
          !(await this.isRefObjectPinned(
            repositoryRoot,
            remoteRef.localRef,
            remoteRef.remoteCommit,
            cancellationSignal,
          ))
        )
          return false;
      }
    }
    return true;
  }

  private async verifyPullPinnedSource(
    repositoryRoot: string,
    pullTarget: PullTargetDetails,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    return (
      (await this.commandOutputMatches(
        repositoryRoot,
        ["remote", "get-url", "--all", pullTarget.remoteName],
        pullTarget.remoteUrl,
        cancellationSignal,
      )) &&
      (await this.resolveRemoteUrlRefCommit(
        repositoryRoot,
        pullTarget.remoteUrl,
        pullTarget.remoteSourceRef,
        cancellationSignal,
      )) === pullTarget.remoteCommit
    );
  }

  private async verifyPushPinnedSource(
    repositoryRoot: string,
    pushDetails: PushTargetDetails,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !(await this.commandOutputMatches(
        repositoryRoot,
        ["remote", "get-url", "--push", "--all", pushDetails.remoteName],
        pushDetails.remoteUrl,
        cancellationSignal,
      ))
    )
      return false;
    if (
      pushDetails.sourceRef !== undefined &&
      pushDetails.sourceCommit !== undefined &&
      !(await this.isCommitishPinned(
        repositoryRoot,
        pushDetails.sourceRef,
        pushDetails.sourceCommit,
        cancellationSignal,
      ))
    )
      return false;
    return (
      (await this.resolveRemoteUrlRefCommit(
        repositoryRoot,
        pushDetails.remoteUrl,
        pushDetails.destinationRef,
        cancellationSignal,
      )) === pushDetails.destinationCommit
    );
  }

  private async verifyPushReadback(
    repositoryRoot: string,
    pushDetails: PushTargetDetails,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !(await this.commandOutputMatches(
        repositoryRoot,
        ["remote", "get-url", "--push", "--all", pushDetails.remoteName],
        pushDetails.remoteUrl,
        cancellationSignal,
      ))
    )
      return false;
    const remoteCommit = await this.resolveRemoteUrlRefCommit(
      repositoryRoot,
      pushDetails.remoteUrl,
      pushDetails.destinationRef,
      cancellationSignal,
    );
    return pushDetails.deleting
      ? remoteCommit === undefined
      : remoteCommit === pushDetails.sourceCommit;
  }

  private async verifyCleanCandidatesAbsent(
    repositoryRoot: string,
    candidatePaths: readonly string[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    throwIfCancelled(cancellationSignal);
    const rootBinding =
      this.rootBindingContext.getStore() ??
      (await this.gitRootBindingResolver.resolve(repositoryRoot));
    for (const candidatePath of candidatePaths) {
      if (
        await this.boundPathExists(
          rootBinding,
          nodePath.join(repositoryRoot, candidatePath),
        )
      )
        return false;
    }
    return true;
  }

  private async verifyCleanCandidatesPinned(
    repositoryRoot: string,
    candidateBindings: readonly GitCleanCandidateBinding[],
    cancellationSignal?: AbortSignal,
  ): Promise<boolean> {
    throwIfCancelled(cancellationSignal);
    const rootBinding =
      this.rootBindingContext.getStore() ??
      (await this.gitRootBindingResolver.resolve(repositoryRoot));
    for (const candidateBinding of candidateBindings) {
      throwIfCancelled(cancellationSignal);
      let stat: BoundFilesystemResult;
      try {
        stat = await this.runBoundFilesystem(rootBinding, {
          kind: "read-stat-any",
          targetPath: nodePath.join(repositoryRoot, candidateBinding.path),
        });
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        return false;
      }
      if (
        stat.kind !== candidateBinding.kind ||
        stat.device !== candidateBinding.device ||
        stat.inode !== candidateBinding.inode ||
        stat.parentFingerprint !== candidateBinding.parentFingerprint
      )
        return false;
    }
    return true;
  }

  private async capturePatchRollbackSnapshot(
    repositoryRoot: string,
    cancellationSignal?: AbortSignal,
  ): Promise<PatchRollbackSnapshot> {
    const [stagedOutput, unstagedOutput] = await Promise.all([
      this.runGit(
        repositoryRoot,
        ["diff", "--binary", "--cached"],
        cancellationSignal,
        DEFAULT_PATCH_SIZE_CAP_BYTES,
      ),
      this.runGit(
        repositoryRoot,
        ["diff", "--binary"],
        cancellationSignal,
        DEFAULT_PATCH_SIZE_CAP_BYTES,
      ),
    ]);
    return {
      stagedPatch: stagedOutput.standardOutput,
      unstagedPatch: unstagedOutput.standardOutput,
    };
  }

  private async rollbackPatchApply(
    repositoryRoot: string,
    snapshot: PatchRollbackSnapshot,
  ): Promise<boolean> {
    const temporaryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-patch-rollback-"),
    );
    const stagedPatchPath = nodePath.join(temporaryDirectory, "staged.patch");
    const unstagedPatchPath = nodePath.join(
      temporaryDirectory,
      "unstaged.patch",
    );
    try {
      await writeFile(stagedPatchPath, snapshot.stagedPatch, "utf8");
      await writeFile(unstagedPatchPath, snapshot.unstagedPatch, "utf8");
      await this.runGit(repositoryRoot, ["reset", "--hard", "HEAD"]);
      if (snapshot.stagedPatch.length > 0)
        await this.runGit(repositoryRoot, [
          "apply",
          "--cached",
          "--binary",
          "--",
          stagedPatchPath,
        ]);
      if (snapshot.unstagedPatch.length > 0)
        await this.runGit(repositoryRoot, [
          "apply",
          "--binary",
          "--",
          unstagedPatchPath,
        ]);
      return true;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private createUniqueToken(): string {
    let token = this.randomToken();
    while (this.pendingOperations.has(token))
      token = `${token}-${cryptoRandomToken()}`;
    return token;
  }

  private reservePendingOperationCapacity(
    currentTimeMilliseconds: number,
  ): void {
    this.removeExpiredPendingOperations(currentTimeMilliseconds);
    while (this.pendingOperations.size >= MAX_PENDING_OPERATION_COUNT) {
      const oldestConfirmationToken = this.pendingOperations
        .keys()
        .next().value;
      if (oldestConfirmationToken === undefined) return;
      this.pendingOperations.delete(oldestConfirmationToken);
    }
  }

  private removeExpiredPendingOperations(
    currentTimeMilliseconds: number,
  ): void {
    for (const [confirmationToken, pendingOperation] of this
      .pendingOperations) {
      if (pendingOperation.expiresAtMilliseconds <= currentTimeMilliseconds)
        this.pendingOperations.delete(confirmationToken);
    }
  }

  public dispose(): void {
    this.pendingOperations.clear();
  }
}

function precondition(
  id: string,
  description: string,
  satisfied: boolean,
  blocking: boolean,
): GitOperationPrecondition {
  return { id, description, satisfied, blocking };
}

function checks(
  ...preconditions: GitOperationPrecondition[]
): OperationStateCheck {
  return {
    preconditions,
    blocking: preconditions.some((check) => check.blocking && !check.satisfied),
  };
}

function satisfiedChecks(): OperationStateCheck {
  return checks();
}

function formatBlockingChecks(
  preconditions: readonly GitOperationPrecondition[],
): string {
  return preconditions
    .filter((check) => check.blocking && !check.satisfied)
    .map((check) => check.description)
    .join(" ");
}

function sameStateFingerprint(
  leftState: GitStateFingerprint,
  rightState: GitStateFingerprint,
): boolean {
  return (
    leftState.repositoryRoot === rightState.repositoryRoot &&
    leftState.headCommit === rightState.headCommit &&
    leftState.headRef === rightState.headRef &&
    leftState.statusPorcelain === rightState.statusPorcelain &&
    leftState.ignoredStatusPorcelain === rightState.ignoredStatusPorcelain &&
    leftState.hasConflicts === rightState.hasConflicts &&
    leftState.inProgressOperation === rightState.inProgressOperation
  );
}

function resetModeFlag(
  resetMode: GitResetMode | "soft" | "mixed" | "hard",
): string {
  return `--${resetMode}`;
}

function buildCleanArguments(
  request: CleanPreviewRequest,
  force: boolean,
  exactCandidates?: readonly string[],
): string[] {
  const cleanArguments = ["clean"];
  if (force) cleanArguments.push("-f");
  else cleanArguments.push("-n");
  if (request.includeDirectories) cleanArguments.push("-d");
  if (request.includeIgnored) cleanArguments.push("-x");
  cleanArguments.push(
    "--",
    ...(exactCandidates === undefined
      ? (request.pathspecs ?? [])
      : exactCandidates.map((candidatePath) => `:(literal)${candidatePath}`)),
  );
  return cleanArguments;
}

function buildCleanCandidateListingArguments(
  request: CleanPreviewRequest,
): string[] {
  const statusArguments = [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ];
  if (request.includeIgnored) statusArguments.push("--ignored");
  statusArguments.push("--");
  if (request.pathspecs !== undefined && request.pathspecs.length > 0) {
    for (const pathspec of request.pathspecs)
      assertSafeText(pathspec, "pathspec");
    statusArguments.push(
      ...request.pathspecs.map((pathspec) => `:(literal)${pathspec}`),
    );
  }
  return statusArguments;
}

function validateCleanCandidates(
  candidatePaths: readonly string[],
): readonly string[] {
  const validatedCandidates: string[] = [];
  for (const candidatePath of candidatePaths) {
    const validatedCandidate = validateCleanCandidatePath(candidatePath);
    if (validatedCandidate !== undefined)
      validatedCandidates.push(validatedCandidate);
  }
  if (validatedCandidates.length === 0)
    throw new GitOperationError(
      "clean.execute",
      "Clean execution requires at least one exact candidate; refusing to broaden to the repository root.",
    );
  return [...new Set(validatedCandidates)];
}

function validateCleanCandidatePath(candidatePath: string): string | undefined {
  const normalizedCandidatePath = candidatePath.replace(/\/$/, "");
  if (
    normalizedCandidatePath.length === 0 ||
    nodePath.isAbsolute(normalizedCandidatePath) ||
    normalizedCandidatePath === "." ||
    normalizedCandidatePath.split(/[\\/]/).includes("..")
  )
    throw new GitOperationError(
      "clean.execute",
      "Git returned an unsafe clean candidate path.",
    );
  return normalizedCandidatePath;
}

function appendPathspecs(
  commandArguments: string[],
  pathspecs: readonly string[] | undefined,
): void {
  if (pathspecs === undefined || pathspecs.length === 0) return;
  for (const pathspec of pathspecs) assertSafeText(pathspec, "pathspec");
  commandArguments.push("--", ...pathspecs);
}

function normalizeRemoteDestinationRef(
  destination: string | undefined,
): string {
  if (destination === undefined || destination.length === 0)
    throw new GitOperationError(
      "push",
      "A push destination ref is required; refusing to broaden the target.",
    );
  assertSafeRef(destination, "push destination ref");
  if (destination.startsWith("refs/")) return destination;
  return `refs/heads/${destination}`;
}

function normalizeLocalPushSourceRef(source: string | undefined): string {
  if (source === undefined || source.length === 0)
    throw new GitOperationError("push", "A push source ref is required.");
  assertCommitish(source);
  if (source.startsWith("refs/")) return source;
  if (source === "HEAD" || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(source))
    return source;
  if (/^[A-Za-z0-9._/-]+$/.test(source)) return `refs/heads/${source}`;
  return source;
}

function assertSafeRepositoryPath(repositoryRoot: string): void {
  if (repositoryRoot.length === 0 || repositoryRoot.includes("\0"))
    throw new GitOperationError("repository", "Repository root is required.");
}

function assertSafeText(
  value: string,
  fieldName: string,
  allowEmpty = false,
  allowLineBreaks = false,
): void {
  if (
    (!allowEmpty && value.length === 0) ||
    value.includes("\0") ||
    [...value].some((character) => {
      const characterCode = character.codePointAt(0) ?? 0;
      return (
        characterCode < 0x20 &&
        !(allowLineBreaks && [0x09, 0x0a, 0x0d].includes(characterCode))
      );
    })
  )
    throw new GitOperationError(
      "repository",
      `${fieldName} contains unsafe control characters.`,
    );
}

function assertSafeRef(refName: string, fieldName: string): void {
  assertSafeText(refName, fieldName);
  if (
    refName.startsWith("-") ||
    refName.includes("..") ||
    refName.includes("@{")
  )
    throw new GitOperationError(
      "repository",
      `${fieldName} is not a safe Git ref.`,
    );
}

function assertBranchName(branchName: string): void {
  const validationMessage = getGitBranchNameValidationMessage(branchName);
  if (validationMessage !== undefined)
    throw new GitOperationError("repository", validationMessage);
}

function assertTagName(tagName: string): void {
  assertSafeRef(tagName, "Tag name");
  if (tagName.trim() !== tagName || /\s/.test(tagName))
    throw new GitOperationError(
      "repository",
      "Tag name cannot contain whitespace.",
    );
  if (
    tagName.includes("~") ||
    tagName.includes("^") ||
    tagName.includes(":") ||
    tagName.includes("?") ||
    tagName.includes("*") ||
    tagName.includes("[")
  )
    throw new GitOperationError(
      "repository",
      "Tag name contains unsafe Git ref characters.",
    );
}

function assertStashReference(stashReference: string): void {
  if (!/^stash(?:@\{[0-9]+\})?$/.test(stashReference))
    throw new GitOperationError(
      "repository",
      "Stash reference must be stash or stash@{N}.",
    );
}

function assertCommitish(commitish: string): void {
  assertSafeText(commitish, "Commit reference");
  assertNotOption(commitish, "Commit reference");
}

function assertNotOption(value: string, fieldName: string): void {
  if (value.startsWith("-"))
    throw new GitOperationError(
      "repository",
      `${fieldName} cannot start with '-'.`,
    );
}

function assertRemoteName(remoteName: string): void {
  assertSafeText(remoteName, "Remote name");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName) ||
    remoteName.endsWith(".")
  )
    throw new GitOperationError("repository", "Remote name is unsafe.");
}

function assertRemoteUrl(remoteUrl: string): void {
  assertSafeText(remoteUrl, "Remote URL");
  if (remoteUrl.startsWith("-"))
    throw new GitOperationError("repository", "Remote URL is unsafe.");
  if (nodePath.isAbsolute(remoteUrl) || nodePath.win32.isAbsolute(remoteUrl))
    return;
  const parsedRemote = parseGitRemoteSyntax(remoteUrl);
  if (parsedRemote === undefined) return;
  const permitsUsername =
    parsedRemote.kind === "scp" ||
    parsedRemote.protocol === "ssh:" ||
    parsedRemote.protocol === "git+ssh:";
  const embedsUserInfoCredential =
    parsedRemote.password.length > 0 ||
    (!permitsUsername && parsedRemote.username.length > 0);
  const embedsNamedCredential = [parsedRemote.search, parsedRemote.hash].some(
    (parameterText) =>
      [...new URLSearchParams(parameterText.replace(/^[?#]/u, ""))].some(
        ([parameterName]) => isCredentialQueryParameterName(parameterName),
      ),
  );
  if (embedsUserInfoCredential || embedsNamedCredential)
    throw new GitOperationError(
      "repository",
      "Remote URL must not embed credentials.",
    );
  if (parsedRemote.protocol !== "file:" && /\s/.test(remoteUrl))
    throw new GitOperationError("repository", "Remote URL is unsafe.");
}

function assertBisectTerm(term: string, fieldName: string): void {
  assertSafeText(term, fieldName);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(term))
    throw new GitOperationError("repository", `${fieldName} is unsafe.`);
}

function redactArguments(
  commandArguments: readonly string[],
): readonly string[] {
  return commandArguments.map((commandArgument) =>
    redactGitErrorMessage(commandArgument),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeContent(
  content: string,
  description: string,
): GitOperationContentSummary {
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    description,
  };
}

function contentMatchesSummary(
  content: string,
  summary: GitOperationContentSummary | undefined,
): boolean {
  if (summary === undefined) return false;
  const actualSummary = summarizeContent(content, summary.description);
  return (
    actualSummary.bytes === summary.bytes &&
    actualSummary.sha256 === summary.sha256
  );
}

function sameStringList(
  leftValues: readonly string[],
  rightValues: readonly string[],
): boolean {
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((leftValue, index) => leftValue === rightValues[index])
  );
}

function renameRemoteConfiguration(
  configuration: RemoteConfigurationSnapshot,
  oldRemoteName: string,
  newRemoteName: string,
): RemoteConfigurationSnapshot {
  return {
    fetchUrls: configuration.fetchUrls,
    pushUrls: configuration.pushUrls,
    fetchRefspecs: configuration.fetchRefspecs.map((refspec) =>
      refspec.replaceAll(
        `refs/remotes/${oldRemoteName}/`,
        `refs/remotes/${newRemoteName}/`,
      ),
    ),
  };
}

function renameBranchConfiguration(
  configuration: BranchConfigurationSnapshot,
  oldBranchName: string,
  newBranchName: string,
): BranchConfigurationSnapshot {
  return {
    entries: configuration.entries.map(({ key, value }) => ({
      key: key.replace(`branch.${oldBranchName}.`, `branch.${newBranchName}.`),
      value,
    })),
  };
}

function sameBranchConfiguration(
  leftConfiguration: BranchConfigurationSnapshot,
  rightConfiguration: BranchConfigurationSnapshot,
): boolean {
  return (
    leftConfiguration.entries.length === rightConfiguration.entries.length &&
    leftConfiguration.entries.every(
      (leftEntry, index) =>
        leftEntry.key === rightConfiguration.entries[index]?.key &&
        leftEntry.value === rightConfiguration.entries[index]?.value,
    )
  );
}

function mapFetchRefspec(
  remoteRef: string,
  rawRefspec: string,
  remoteName: string,
): string | undefined {
  const refspec = rawRefspec.replace(/^\+/, "");
  if (refspec.startsWith("^")) return undefined;
  const refspecParts = refspec.split(":");
  if (refspecParts.length > 2) return undefined;
  const sourceRef = normalizeFetchSourceRef(refspecParts[0] ?? "");
  if (!matchesFetchPattern(remoteRef, sourceRef)) return undefined;
  const destinationRef = refspecParts[1];
  if (destinationRef === "") return undefined;
  const wildcardValue = fetchPatternWildcardValue(remoteRef, sourceRef);
  const resolvedDestination =
    destinationRef === undefined
      ? defaultFetchDestination(remoteRef, remoteName)
      : destinationRef.replaceAll("*", wildcardValue ?? "");
  return resolvedDestination.startsWith("refs/")
    ? resolvedDestination
    : `refs/remotes/${remoteName}/${resolvedDestination}`;
}

function isFetchRefspecExcluded(
  remoteRef: string,
  refspecs: readonly string[],
): boolean {
  return refspecs.some((rawRefspec) => {
    const refspec = rawRefspec.replace(/^\+/, "");
    if (!refspec.startsWith("^")) return false;
    return matchesFetchPattern(
      remoteRef,
      normalizeFetchSourceRef(refspec.slice(1).split(":", 1)[0] ?? ""),
    );
  });
}

function normalizeFetchSourceRef(sourceRef: string): string {
  if (sourceRef.startsWith("refs/")) return sourceRef;
  if (sourceRef.startsWith("tags/")) return `refs/${sourceRef}`;
  if (sourceRef.startsWith("heads/")) return `refs/${sourceRef}`;
  return `refs/heads/${sourceRef}`;
}

function matchesFetchPattern(
  remoteRef: string,
  sourcePattern: string,
): boolean {
  const wildcardIndex = sourcePattern.indexOf("*");
  if (wildcardIndex < 0) return remoteRef === sourcePattern;
  const prefix = sourcePattern.slice(0, wildcardIndex);
  const suffix = sourcePattern.slice(wildcardIndex + 1);
  return (
    remoteRef.startsWith(prefix) &&
    remoteRef.endsWith(suffix) &&
    remoteRef.length >= prefix.length + suffix.length
  );
}

function fetchPatternWildcardValue(
  remoteRef: string,
  sourcePattern: string,
): string | undefined {
  const wildcardIndex = sourcePattern.indexOf("*");
  if (wildcardIndex < 0 || !matchesFetchPattern(remoteRef, sourcePattern))
    return undefined;
  const prefix = sourcePattern.slice(0, wildcardIndex);
  const suffix = sourcePattern.slice(wildcardIndex + 1);
  return remoteRef.slice(prefix.length, remoteRef.length - suffix.length);
}

function defaultFetchDestination(
  remoteRef: string,
  remoteName: string,
): string {
  if (remoteRef.startsWith("refs/tags/")) return remoteRef;
  return `refs/remotes/${remoteName}/${remoteRef.replace(/^refs\/heads\//, "")}`;
}

function resolveGitPath(repositoryRoot: string, gitPath: string): string {
  return nodePath.isAbsolute(gitPath)
    ? gitPath
    : nodePath.resolve(repositoryRoot, gitPath);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function formatFinalState(state: GitStateFingerprint | undefined): string {
  if (state === undefined) return "unavailable";
  return `${state.isClean ? "clean" : "changed"} worktree, HEAD ${state.headCommit ?? "unavailable"}`;
}

function formatRollbackReport(report: GitOperationRollbackReport): string {
  return report.error === undefined
    ? report.status
    : `${report.status} (${report.error})`;
}

async function normalizeRepositoryPath(
  repositoryPath: string,
): Promise<string> {
  try {
    return await realpath(repositoryPath);
  } catch {
    return nodePath.resolve(repositoryPath);
  }
}

async function captureLocalRemoteBinding(
  repositoryRoot: string,
  remoteUrl: string,
): Promise<LocalRemoteBinding | undefined> {
  const requestedPath = localRemotePath(repositoryRoot, remoteUrl);
  if (requestedPath === undefined) return undefined;
  return readLocalRemoteBinding(requestedPath);
}

async function captureLocalRemoteBindings(
  repositoryRoot: string,
  remoteUrls: readonly string[],
): Promise<readonly LocalRemoteBinding[]> {
  const bindings: LocalRemoteBinding[] = [];
  const capturedPaths = new Set<string>();
  for (const remoteUrl of remoteUrls) {
    const requestedPath = localRemotePath(repositoryRoot, remoteUrl);
    if (requestedPath === undefined || capturedPaths.has(requestedPath))
      continue;
    capturedPaths.add(requestedPath);
    bindings.push(await readLocalRemoteBinding(requestedPath));
  }
  return bindings;
}

async function readLocalRemoteBinding(
  requestedPath: string,
): Promise<LocalRemoteBinding> {
  const canonicalPath = await realpath(requestedPath);
  const targetStats = await stat(canonicalPath, { bigint: true });
  if (!targetStats.isDirectory())
    throw new Error("Local remote target is not a directory.");
  const parentPath = nodePath.dirname(requestedPath);
  const parentCanonicalPath = await realpath(parentPath);
  const parentStats = await stat(parentCanonicalPath, { bigint: true });
  if (!parentStats.isDirectory())
    throw new Error("Local remote target parent is not a directory.");
  return {
    requestedPath,
    canonicalPath,
    device: String(targetStats.dev),
    inode: String(targetStats.ino),
    parentCanonicalPath,
    parentDevice: String(parentStats.dev),
    parentInode: String(parentStats.ino),
  };
}

function sameLocalRemoteBinding(
  currentBinding: LocalRemoteBinding,
  expectedBinding: LocalRemoteBinding,
): boolean {
  return (
    currentBinding.requestedPath === expectedBinding.requestedPath &&
    currentBinding.canonicalPath === expectedBinding.canonicalPath &&
    currentBinding.device === expectedBinding.device &&
    currentBinding.inode === expectedBinding.inode &&
    currentBinding.parentCanonicalPath ===
      expectedBinding.parentCanonicalPath &&
    currentBinding.parentDevice === expectedBinding.parentDevice &&
    currentBinding.parentInode === expectedBinding.parentInode
  );
}

function localRemotePath(
  repositoryRoot: string,
  remoteUrl: string,
): string | undefined {
  if (nodePath.isAbsolute(remoteUrl) || nodePath.win32.isAbsolute(remoteUrl))
    return remoteUrl;
  const parsedRemote = parseGitRemoteSyntax(remoteUrl);
  if (parsedRemote?.kind === "scp") return undefined;
  if (parsedRemote?.kind === "url") {
    if (parsedRemote.protocol !== "file:") return undefined;
    try {
      const parsedFileUrl = new URL(remoteUrl);
      if (
        parsedFileUrl.hostname.length > 0 &&
        parsedFileUrl.hostname !== "localhost"
      )
        return undefined;
      return fileURLToPath(parsedFileUrl);
    } catch {
      return undefined;
    }
  }
  return nodePath.resolve(repositoryRoot, remoteUrl);
}

async function detectInProgressOperation(
  gitDirectory: string,
  rootBinding: GitRootBindingIdentity,
): Promise<GitStateFingerprint["inProgressOperation"]> {
  const markers: readonly [
    string,
    NonNullable<GitStateFingerprint["inProgressOperation"]>,
  ][] = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["BISECT_LOG", "bisect"],
  ];
  for (const [marker, operation] of markers) {
    if (
      await boundFilesystemPathExists(
        rootBinding,
        nodePath.join(gitDirectory, marker),
      )
    )
      return operation;
  }
  return undefined;
}

function cryptoRandomToken(): string {
  return randomBytes(18).toString("hex");
}

function throwIfCancelled(cancellationSignal: AbortSignal | undefined): void {
  if (cancellationSignal?.aborted)
    throw new DOMException("Git operation cancelled", "AbortError");
}
