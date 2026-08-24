import * as nodePath from "node:path";
import {
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  isAbortError,
  type GitCommandOutput,
  type GitCommandRunner,
  type GitRootBindingIdentity,
} from "../git/gitCommandRunner.js";
import { GitRootBindingResolver } from "../git/gitRootBindingResolver.js";
import {
  createIndexSource,
  createMergeBaseSource,
  createRevisionSource,
  createWorkingTreeSource,
  defaultDiffPlanOptions,
  gitEmptyTreeSha,
  type CommitParentDiffRequest,
  type DiffChangeRange,
  type DiffFileMetadata,
  type DiffFileOnlyPlan,
  type DiffFilePlan,
  type DiffMultiEditorPlan,
  type DiffNavigationEntry,
  type DiffNavigationModel,
  type DiffPlan,
  type DiffPlanOptions,
  type DiffPlanRequest,
  type DiffPresentationDescriptor,
  type DiffRepositoryPlan,
  type DiffRepositorySource,
  type DiffComparisonPreset,
  type DiffWhitespaceMode,
} from "./diffModels.js";
import { parseDiffHunks, parseRawDiffMetadata } from "./gitDiffParser.js";

export class GitDiffRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitDiffRequestError";
  }
}

export interface DiffUriFactory {
  readonly registrationLimits?: DiffUriRegistrationLimits;
  readonly file: (filePath: string) => vscode.Uri;
  /** Creates an empty, provider-backed URI for an added/deleted side. */
  readonly empty: (
    filePath: string,
    side: "original" | "modified",
  ) => vscode.Uri;
  /** Creates a URI whose provider returns a symlink's target text. */
  readonly symlink: (
    filePath: string,
    repositoryRootPath?: string,
  ) => vscode.Uri;
  /** Creates an immutable, provider-backed working-tree snapshot URI. */
  readonly workingContent: (
    filePath: string,
    repositoryRootPath: string,
    cancellationSignal?: AbortSignal,
    expectedRepositoryRootIdentity?: DiffWorkingContentRootIdentity,
  ) => Promise<vscode.Uri>;
}

export interface DiffUriRegistrationLimits {
  readonly maxRegistrationsPerSession: number;
  readonly workingContentReservationBytes: number;
  readonly maxTotalWorkingContentBytes: number;
}

export interface DiffWorkingContentRootIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/**
 * Safe provider for working-tree symlink text. URIs contain only an opaque
 * registration token; paths are kept in this in-memory, session-scoped map.
 */
export interface DiffSymlinkUriProvider
  extends vscode.TextDocumentContentProvider, vscode.FileSystemProvider {
  readonly registrationLimits: DiffUriRegistrationLimits;
  readonly empty: DiffUriFactory["empty"];
  readonly symlink: DiffUriFactory["symlink"];
  readonly workingContent: DiffUriFactory["workingContent"];
  readonly beginSession: () => void;
  readonly readSnapshotBytes: (uri: vscode.Uri) => Uint8Array;
  readonly dispose: () => void;
}

interface DiffSymlinkRegistration {
  readonly kind: "symlink";
  readonly filePath: string;
  readonly repositoryRootPath: string;
  readonly canonicalRepositoryRootPath: string;
  readonly repositoryRootIdentity: FileSystemIdentity;
  readonly canonicalParentPath: string;
  readonly canonicalParentIdentity: FileSystemIdentity;
  readonly symlinkIdentity: FileSystemIdentity;
}

interface DiffEmptyRegistration {
  readonly kind: "empty";
}

interface DiffWorkingContentRegistration {
  readonly kind: "working-content";
  readonly content: Uint8Array;
}

type DiffContentRegistration =
  | DiffSymlinkRegistration
  | DiffEmptyRegistration
  | DiffWorkingContentRegistration;

interface FileSystemIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface CanonicalPathIdentity {
  readonly path: string;
  readonly identity: FileSystemIdentity;
}

export interface DiffSymlinkUriProviderOptions {
  readonly maxRegistrationsPerSession?: number;
  readonly maxRetainedSessions?: number;
  readonly maxWorkingContentBytes?: number;
  readonly maxTotalWorkingContentBytes?: number;
  readonly onWorkingContentRequested?: () => void;
}

interface DiffRegistrationSession {
  readonly token: string;
  readonly registrations: Map<string, DiffContentRegistration>;
  readonly nativeSnapshotPaths: Set<string>;
  reservedRegistrationCount: number;
}

const defaultMaxRegistrationsPerSession = 256;
const defaultMaxRetainedSessions = 16;
const defaultMaxWorkingContentBytes = 8 * 1024 * 1024;
const defaultMaxTotalWorkingContentBytes = 32 * 1024 * 1024;

export function createDiffSymlinkUriProvider(
  options: DiffSymlinkUriProviderOptions = {},
): DiffSymlinkUriProvider {
  const maxRegistrationsPerSession = normalizeProviderLimit(
    options.maxRegistrationsPerSession,
    defaultMaxRegistrationsPerSession,
  );
  const maxRetainedSessions = normalizeProviderLimit(
    options.maxRetainedSessions,
    defaultMaxRetainedSessions,
  );
  const maxWorkingContentBytes = normalizeProviderLimit(
    options.maxWorkingContentBytes,
    defaultMaxWorkingContentBytes,
  );
  const maxTotalWorkingContentBytes = normalizeProviderLimit(
    options.maxTotalWorkingContentBytes,
    defaultMaxTotalWorkingContentBytes,
  );
  const workingContentReservationBytes = Math.min(
    maxWorkingContentBytes,
    maxTotalWorkingContentBytes,
  );
  const registrationLimits: DiffUriRegistrationLimits = {
    maxRegistrationsPerSession,
    workingContentReservationBytes,
    maxTotalWorkingContentBytes,
  };
  const sessions = new Map<string, DiffRegistrationSession>();
  const nativeWorkingContentByPath = new Map<string, Uint8Array>();
  const nativeSnapshotDirectoryPath = mkdtempSync(
    nodePath.join(tmpdir(), "gito-diff-snapshots-"),
  );
  chmodSync(nativeSnapshotDirectoryPath, 0o700);
  let retainedWorkingContentBytes = 0;
  let reservedWorkingContentBytes = 0;
  let disposed = false;
  let activeSession = createSession();

  function createSession(): DiffRegistrationSession {
    const sessionToken = randomUUID();
    const session: DiffRegistrationSession = {
      token: sessionToken,
      registrations: new Map(),
      nativeSnapshotPaths: new Set(),
      reservedRegistrationCount: 0,
    };
    sessions.set(sessionToken, session);
    while (sessions.size > maxRetainedSessions) {
      const oldestSessionToken = sessions.keys().next().value;
      if (oldestSessionToken === undefined) break;
      const oldestSession = sessions.get(oldestSessionToken);
      if (oldestSession !== undefined) {
        for (const registration of oldestSession.registrations.values()) {
          if (registration.kind === "working-content")
            retainedWorkingContentBytes -= registration.content.byteLength;
        }
        for (const nativeSnapshotPath of oldestSession.nativeSnapshotPaths) {
          const nativeSnapshotContent =
            nativeWorkingContentByPath.get(nativeSnapshotPath);
          if (nativeSnapshotContent !== undefined)
            retainedWorkingContentBytes -= nativeSnapshotContent.byteLength;
          nativeWorkingContentByPath.delete(nativeSnapshotPath);
          rmSync(nativeSnapshotPath, { force: true });
        }
      }
      sessions.delete(oldestSessionToken);
    }
    return session;
  }

  function registrationSessionHasCapacity(
    session: DiffRegistrationSession,
  ): boolean {
    return (
      session.registrations.size + session.reservedRegistrationCount <
      maxRegistrationsPerSession
    );
  }

  const createOpaqueUri = (
    scheme: string,
    registration: DiffContentRegistration,
  ): vscode.Uri => {
    if (disposed)
      throw new GitDiffRequestError(
        "Diff content provider is disposed; registration is unavailable.",
      );
    const registrationSession = activeSession;
    if (
      sessions.get(registrationSession.token) !== registrationSession ||
      !registrationSessionHasCapacity(registrationSession)
    )
      throw new GitDiffRequestError(
        "Diff content registration session capacity exhausted.",
      );
    const registrationToken = `${registrationSession.token}:${randomUUID()}`;
    registrationSession.registrations.set(registrationToken, registration);
    return vscode.Uri.parse(
      `${scheme}:/snapshot?${encodeURIComponent(registrationToken)}`,
    );
  };

  const registerEmpty: DiffUriFactory["empty"] = () =>
    createOpaqueUri("gito-empty", { kind: "empty" });

  const registerWorkingContent: DiffUriFactory["workingContent"] = async (
    filePath,
    repositoryRootPath,
    cancellationSignal,
    expectedRepositoryRootIdentity,
  ) => {
    throwIfDiffCancelled(cancellationSignal);
    if (disposed)
      throw new GitDiffRequestError(
        "Working content snapshot provider is disposed.",
      );
    const registrationSession = activeSession;
    if (
      sessions.get(registrationSession.token) !== registrationSession ||
      !registrationSessionHasCapacity(registrationSession) ||
      retainedWorkingContentBytes +
        reservedWorkingContentBytes +
        workingContentReservationBytes >
        maxTotalWorkingContentBytes
    )
      throw new GitDiffRequestError(
        "Working content snapshot session capacity exhausted.",
      );
    throwIfDiffCancelled(cancellationSignal);
    registrationSession.reservedRegistrationCount += 1;
    reservedWorkingContentBytes += workingContentReservationBytes;
    try {
      const snapshotContent = await readWorkingContentSnapshot(
        filePath,
        repositoryRootPath,
        cancellationSignal,
        workingContentReservationBytes,
        expectedRepositoryRootIdentity,
      );
      throwIfDiffCancelled(cancellationSignal);
      if (snapshotContent === undefined)
        throw new GitDiffRequestError(
          "Working content snapshot is unavailable.",
        );
      if (sessions.get(registrationSession.token) !== registrationSession)
        throw new GitDiffRequestError(
          "Working content snapshot session is no longer available.",
        );
      throwIfDiffCancelled(cancellationSignal);
      const sourceExtension = nodePath.extname(filePath);
      const safeSourceExtension = /^\.[A-Za-z0-9]{1,16}$/u.test(sourceExtension)
        ? sourceExtension
        : ".txt";
      const nativeSnapshotPath = nodePath.join(
        nativeSnapshotDirectoryPath,
        `${randomUUID()}${safeSourceExtension}`,
      );
      writeFileSync(nativeSnapshotPath, snapshotContent, {
        flag: "wx",
        mode: 0o600,
      });
      registrationSession.nativeSnapshotPaths.add(nativeSnapshotPath);
      nativeWorkingContentByPath.set(nativeSnapshotPath, snapshotContent);
      retainedWorkingContentBytes += snapshotContent.byteLength;
      try {
        throwIfDiffCancelled(cancellationSignal);
      } catch (error: unknown) {
        registrationSession.nativeSnapshotPaths.delete(nativeSnapshotPath);
        nativeWorkingContentByPath.delete(nativeSnapshotPath);
        rmSync(nativeSnapshotPath, { force: true });
        retainedWorkingContentBytes -= snapshotContent.byteLength;
        throw error;
      }
      return vscode.Uri.file(nativeSnapshotPath);
    } finally {
      registrationSession.reservedRegistrationCount -= 1;
      reservedWorkingContentBytes -= workingContentReservationBytes;
    }
  };

  const registerSymlink: DiffUriFactory["symlink"] = (
    filePath: string,
    repositoryRootPath?: string,
  ): vscode.Uri => {
    if (disposed)
      throw new GitDiffRequestError(
        "Diff content provider is disposed; registration is unavailable.",
      );
    const registrationSession = activeSession;
    if (
      sessions.get(registrationSession.token) !== registrationSession ||
      !registrationSessionHasCapacity(registrationSession)
    )
      throw new GitDiffRequestError(
        "Diff content registration session capacity exhausted.",
      );
    if (
      repositoryRootPath === undefined ||
      !isPathWithinRepository(repositoryRootPath, filePath)
    ) {
      return vscode.Uri.parse("gito-symlink:/snapshot?unavailable");
    }
    const canonicalRepositoryRoot =
      resolveCanonicalPathWithIdentity(repositoryRootPath);
    const canonicalParent = resolveCanonicalPathWithIdentity(
      nodePath.dirname(filePath),
    );
    const symlinkIdentity = readSymlinkIdentity(filePath);
    if (
      canonicalRepositoryRoot === undefined ||
      canonicalParent === undefined ||
      symlinkIdentity === undefined ||
      !isPathWithinOrEqual(canonicalRepositoryRoot.path, canonicalParent.path)
    ) {
      return vscode.Uri.parse("gito-symlink:/snapshot?unavailable");
    }
    const registrationToken = `${registrationSession.token}:${randomUUID()}`;
    registrationSession.registrations.set(registrationToken, {
      kind: "symlink",
      filePath,
      repositoryRootPath,
      canonicalRepositoryRootPath: canonicalRepositoryRoot.path,
      repositoryRootIdentity: canonicalRepositoryRoot.identity,
      canonicalParentPath: canonicalParent.path,
      canonicalParentIdentity: canonicalParent.identity,
      symlinkIdentity,
    });
    return vscode.Uri.parse(
      `gito-symlink:/snapshot?${encodeURIComponent(registrationToken)}`,
    );
  };

  const readRegisteredSnapshotBytes = (uri: vscode.Uri): Uint8Array => {
    if (uri.scheme === "file") {
      const nativeSnapshotContent = nativeWorkingContentByPath.get(uri.fsPath);
      if (nativeSnapshotContent !== undefined)
        return Uint8Array.from(nativeSnapshotContent);
    }
    const registration = getContentRegistration(sessions, uri);
    if (registration?.kind === "working-content")
      return Uint8Array.from(registration.content);
    if (registration?.kind === "empty") return new Uint8Array();
    throw new GitDiffRequestError("Working content snapshot is unavailable.");
  };

  const provideRegisteredTextContent = async (
    uri: vscode.Uri,
  ): Promise<string> => {
    let registrationToken: string;
    try {
      registrationToken = decodeURIComponent(uri.query);
    } catch {
      if (uri.scheme === "gito-working-content")
        throw new GitDiffRequestError(
          "Working content snapshot is unavailable.",
        );
      return "[symlink target unavailable]";
    }
    const separatorIndex = registrationToken.indexOf(":");
    const sessionToken =
      separatorIndex < 0
        ? undefined
        : registrationToken.slice(0, separatorIndex);
    const registration =
      sessionToken === undefined
        ? undefined
        : sessions.get(sessionToken)?.registrations.get(registrationToken);
    if (registration === undefined) {
      if (uri.scheme === "gito-working-content")
        throw new GitDiffRequestError(
          "Working content snapshot is unavailable.",
        );
      return "[symlink target unavailable]";
    }
    if (uri.scheme === "gito-empty")
      return registration.kind === "empty" ? "" : "[empty content unavailable]";
    if (uri.scheme === "gito-working-content") {
      if (registration.kind !== "working-content")
        throw new GitDiffRequestError(
          "Working content snapshot is unavailable.",
        );
      try {
        options.onWorkingContentRequested?.();
      } catch {
        // Diagnostics observers must never affect snapshot delivery.
      }
      return Buffer.from(registration.content).toString("utf8");
    }
    if (
      uri.scheme !== "gito-symlink" ||
      registration.kind !== "symlink" ||
      !isCurrentSymlinkRegistration(registration)
    )
      return "[symlink target unavailable]";
    try {
      // readlink reads the link itself and never follows its external target.
      const linkTarget = await readlink(registration.filePath);
      return isCurrentSymlinkRegistration(registration)
        ? linkTarget
        : "[symlink target unavailable]";
    } catch {
      return "[symlink target unavailable]";
    }
  };

  const provider: DiffSymlinkUriProvider = {
    registrationLimits,
    empty: registerEmpty,
    symlink: registerSymlink,
    workingContent: registerWorkingContent,
    beginSession: () => {
      if (disposed) return;
      activeSession = createSession();
    },
    provideTextDocumentContent: provideRegisteredTextContent,
    onDidChangeFile: () => ({ dispose: () => undefined }),
    watch: () => ({ dispose: () => undefined }),
    stat: async (uri) => {
      const fileBytes = await provider.readFile(uri);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: fileBytes.byteLength,
      };
    },
    readDirectory: () => {
      throw vscode.FileSystemError.FileNotADirectory();
    },
    createDirectory: () => {
      throw vscode.FileSystemError.NoPermissions(
        "Git'o diff snapshots are read-only.",
      );
    },
    readFile: async (uri) => {
      if (uri.scheme !== "gito-symlink") {
        const snapshotBytes = readRegisteredSnapshotBytes(uri);
        if (uri.scheme === "gito-working-content") {
          try {
            options.onWorkingContentRequested?.();
          } catch {
            // Diagnostics observers must never affect snapshot delivery.
          }
        }
        return snapshotBytes;
      }
      return Buffer.from(await provideRegisteredTextContent(uri));
    },
    writeFile: () => {
      throw vscode.FileSystemError.NoPermissions(
        "Git'o diff snapshots are read-only.",
      );
    },
    delete: () => {
      throw vscode.FileSystemError.NoPermissions(
        "Git'o diff snapshots are read-only.",
      );
    },
    rename: () => {
      throw vscode.FileSystemError.NoPermissions(
        "Git'o diff snapshots are read-only.",
      );
    },
    readSnapshotBytes: readRegisteredSnapshotBytes,
    dispose: () => {
      disposed = true;
      sessions.clear();
      nativeWorkingContentByPath.clear();
      rmSync(nativeSnapshotDirectoryPath, { recursive: true, force: true });
      retainedWorkingContentBytes = 0;
    },
  };
  return provider;
}

function getContentRegistration(
  sessions: ReadonlyMap<string, DiffRegistrationSession>,
  uri: vscode.Uri,
): DiffContentRegistration | undefined {
  let registrationToken: string;
  try {
    registrationToken = decodeURIComponent(uri.query);
  } catch {
    return undefined;
  }
  const separatorIndex = registrationToken.indexOf(":");
  if (separatorIndex < 0) return undefined;
  const sessionToken = registrationToken.slice(0, separatorIndex);
  return sessions.get(sessionToken)?.registrations.get(registrationToken);
}

async function readWorkingContentSnapshot(
  filePath: string,
  repositoryRootPath: string,
  cancellationSignal: AbortSignal | undefined,
  maxBytes: number,
  expectedRepositoryRootIdentity?: DiffWorkingContentRootIdentity,
): Promise<Uint8Array | undefined> {
  throwIfDiffCancelled(cancellationSignal);
  if (
    fsConstants.O_NOFOLLOW === undefined ||
    !isPathWithinRepository(repositoryRootPath, filePath)
  )
    return undefined;
  const canonicalRoot =
    await resolveCanonicalPathWithIdentityAsync(repositoryRootPath);
  const canonicalParent = await resolveCanonicalPathWithIdentityAsync(
    nodePath.dirname(filePath),
  );
  if (
    canonicalRoot === undefined ||
    canonicalParent === undefined ||
    !isPathWithinOrEqual(canonicalRoot.path, canonicalParent.path)
  )
    return undefined;
  if (
    expectedRepositoryRootIdentity !== undefined &&
    !matchesExpectedRepositoryRootIdentity(
      canonicalRoot,
      expectedRepositoryRootIdentity,
    )
  )
    return undefined;
  let initialLeafStats: BigIntStats;
  try {
    initialLeafStats = await lstat(filePath, { bigint: true });
  } catch {
    return undefined;
  }
  if (!initialLeafStats.isFile()) return undefined;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfDiffCancelled(cancellationSignal);
    const rootBeforeOpen =
      await resolveCanonicalPathWithIdentityAsync(repositoryRootPath);
    if (
      rootBeforeOpen === undefined ||
      rootBeforeOpen.path !== canonicalRoot.path ||
      !sameFileSystemIdentity(
        rootBeforeOpen.identity,
        canonicalRoot.identity,
      ) ||
      (expectedRepositoryRootIdentity !== undefined &&
        !matchesExpectedRepositoryRootIdentity(
          rootBeforeOpen,
          expectedRepositoryRootIdentity,
        ))
    )
      return undefined;
    fileHandle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    throwIfDiffCancelled(cancellationSignal);
    const openedLeafStats = await fileHandle.stat({ bigint: true });
    if (!sameUntrackedFileIdentity(initialLeafStats, openedLeafStats))
      return undefined;
    const expectedByteCount = Number(initialLeafStats.size);
    if (
      !Number.isSafeInteger(expectedByteCount) ||
      expectedByteCount < 0 ||
      expectedByteCount > maxBytes
    )
      return undefined;
    const snapshotContent = Buffer.allocUnsafe(expectedByteCount);
    let totalBytes = 0;
    while (totalBytes < expectedByteCount) {
      throwIfDiffCancelled(cancellationSignal);
      const { bytesRead } = await fileHandle.read(
        snapshotContent,
        totalBytes,
        expectedByteCount - totalBytes,
        null,
      );
      if (bytesRead === 0) return undefined;
      totalBytes += bytesRead;
    }
    throwIfDiffCancelled(cancellationSignal);
    const finalLeafStats = await fileHandle.stat({ bigint: true });
    const finalParent = await resolveCanonicalPathWithIdentityAsync(
      nodePath.dirname(filePath),
    );
    const finalRoot =
      await resolveCanonicalPathWithIdentityAsync(repositoryRootPath);
    let finalPathStats: BigIntStats;
    try {
      finalPathStats = await lstat(filePath, { bigint: true });
    } catch {
      return undefined;
    }
    if (
      !sameUntrackedFileIdentity(initialLeafStats, finalLeafStats) ||
      !sameUntrackedFileIdentity(initialLeafStats, finalPathStats) ||
      finalParent === undefined ||
      finalParent.path !== canonicalParent.path ||
      !sameFileSystemIdentity(finalParent.identity, canonicalParent.identity) ||
      finalRoot === undefined ||
      finalRoot.path !== canonicalRoot.path ||
      !sameFileSystemIdentity(finalRoot.identity, canonicalRoot.identity)
    )
      return undefined;
    if (
      expectedRepositoryRootIdentity !== undefined &&
      !matchesExpectedRepositoryRootIdentity(
        finalRoot,
        expectedRepositoryRootIdentity,
      )
    )
      return undefined;
    return snapshotContent;
  } catch (error: unknown) {
    if (isAbortError(error)) throw error;
    return undefined;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function resolveCanonicalPathWithIdentityAsync(
  pathToResolve: string,
): Promise<CanonicalPathIdentity | undefined> {
  try {
    const path = normalizeRepositoryPath(await realpath(pathToResolve));
    const stats = await stat(path, { bigint: true });
    return {
      path,
      identity: { device: stats.dev, inode: stats.ino },
    };
  } catch {
    return undefined;
  }
}

function matchesExpectedRepositoryRootIdentity(
  canonicalRoot: CanonicalPathIdentity,
  expectedIdentity: DiffWorkingContentRootIdentity,
): boolean {
  return (
    normalizeRepositoryPath(canonicalRoot.path) ===
      normalizeRepositoryPath(expectedIdentity.canonicalPath) &&
    canonicalRoot.identity.device === expectedIdentity.device &&
    canonicalRoot.identity.inode === expectedIdentity.inode
  );
}

function normalizeProviderLimit(
  configuredLimit: number | undefined,
  defaultLimit: number,
): number {
  return configuredLimit === undefined ||
    !Number.isSafeInteger(configuredLimit) ||
    configuredLimit < 1
    ? defaultLimit
    : configuredLimit;
}

function resolveCanonicalPathWithIdentity(
  pathToResolve: string,
): CanonicalPathIdentity | undefined {
  try {
    const path = normalizeRepositoryPath(realpathSync.native(pathToResolve));
    const stats = statSync(path, { bigint: true });
    return {
      path,
      identity: { device: stats.dev, inode: stats.ino },
    };
  } catch {
    return undefined;
  }
}

function readSymlinkIdentity(
  pathToRead: string,
): FileSystemIdentity | undefined {
  try {
    const stats = lstatSync(pathToRead, { bigint: true });
    return stats.isSymbolicLink()
      ? { device: stats.dev, inode: stats.ino }
      : undefined;
  } catch {
    return undefined;
  }
}

function isCurrentSymlinkRegistration(
  registration: DiffSymlinkRegistration,
): boolean {
  const canonicalRepositoryRoot = resolveCanonicalPathWithIdentity(
    registration.repositoryRootPath,
  );
  const canonicalParent = resolveCanonicalPathWithIdentity(
    nodePath.dirname(registration.filePath),
  );
  if (
    canonicalRepositoryRoot === undefined ||
    canonicalParent === undefined ||
    canonicalRepositoryRoot.path !== registration.canonicalRepositoryRootPath ||
    canonicalParent.path !== registration.canonicalParentPath ||
    !sameFileSystemIdentity(
      canonicalRepositoryRoot.identity,
      registration.repositoryRootIdentity,
    ) ||
    !sameFileSystemIdentity(
      canonicalParent.identity,
      registration.canonicalParentIdentity,
    ) ||
    !isPathWithinOrEqual(canonicalRepositoryRoot.path, canonicalParent.path)
  ) {
    return false;
  }
  const symlinkIdentity = readSymlinkIdentity(registration.filePath);
  return (
    symlinkIdentity !== undefined &&
    sameFileSystemIdentity(symlinkIdentity, registration.symlinkIdentity)
  );
}

function sameFileSystemIdentity(
  left: FileSystemIdentity,
  right: FileSystemIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

interface ResolvedDiffSource {
  readonly source: DiffRepositorySource;
  readonly resolvedRevision?: string;
}

interface DiffCommandShape {
  readonly arguments: readonly string[];
  readonly invertResult: boolean;
  readonly hasDifference: boolean;
}

interface ParsedFileRecord {
  readonly metadata: DiffFileMetadata;
  readonly oldPath?: string;
  readonly newPath?: string;
}

interface UntrackedRecordsResult {
  readonly records: readonly ParsedFileRecord[];
  readonly truncated: boolean;
}

interface RepositoryRootBinding {
  readonly requestedRootPath: string;
  readonly canonicalRootPath: string;
  readonly identity: FileSystemIdentity;
  readonly rootBinding: GitRootBindingIdentity;
}

/** Immutable root identity shared by one user-visible diff request/session. */
export interface GitDiffRepositoryBinding {
  readonly requestedRootPath: string;
  readonly rootBinding: GitRootBindingIdentity;
}

function toPublicRepositoryBinding(
  repositoryRootBinding: RepositoryRootBinding,
): GitDiffRepositoryBinding {
  const rootBinding = freezeGitRootBindingIdentity(
    repositoryRootBinding.rootBinding,
  );
  return {
    requestedRootPath: repositoryRootBinding.requestedRootPath,
    rootBinding,
  };
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

function emptyGitCommandOutput(): GitCommandOutput {
  return { standardOutput: "", standardError: "", exitCode: 0 };
}

function throwIfDiffCancelled(
  cancellationSignal: AbortSignal | undefined,
): void {
  if (cancellationSignal?.aborted)
    throw new DOMException("Git diff cancelled", "AbortError");
}

function isGitRootBindingFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Repository root") ||
      error.message.includes("Git directory") ||
      error.message.includes("Git common directory"))
  );
}

const absolutePathPattern = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/;
const mutableStateFingerprintMaxOutputBytes = 8 * 1024 * 1024;

/**
 * Read-only Git comparison service. It creates resource URIs and editor plans;
 * VS Code remains responsible for rendering and opening those plans.
 */
export class GitDiffService {
  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly uriFactory: DiffUriFactory,
    private readonly rootBindingResolver: GitRootBindingResolver,
  ) {}

  public async createRepositoryBinding(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
  ): Promise<GitDiffRepositoryBinding> {
    throwIfDiffCancelled(cancellationSignal);
    const repositoryRootBinding = await this.pinRepositoryRoot(
      repositoryRoot,
      cancellationSignal,
    );
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    throwIfDiffCancelled(cancellationSignal);
    return toPublicRepositoryBinding(repositoryRootBinding);
  }

  public async getHeadRevision(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
    repositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<string> {
    const repositoryRootBinding = await this.resolveRepositoryBinding(
      repositoryRoot,
      repositoryBinding,
      cancellationSignal,
    );
    return (
      await this.runGitCommand(
        repositoryRootBinding,
        ["rev-parse", "--verify", "HEAD"],
        cancellationSignal,
      )
    ).trim();
  }

  public async listGitRevisions(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
    repositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<readonly string[]> {
    const repositoryRootBinding = await this.resolveRepositoryBinding(
      repositoryRoot,
      repositoryBinding,
      cancellationSignal,
    );
    try {
      const [refOutput, commitOutput] = await Promise.all([
        this.runGitCommand(
          repositoryRootBinding,
          [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/tags",
          ],
          cancellationSignal,
          128 * 1024,
        ),
        this.runGitCommand(
          repositoryRootBinding,
          ["log", "--format=%H%x09%h%x09%s", "-n", "20", "HEAD"],
          cancellationSignal,
          256 * 1024,
        ),
      ]);
      const revisions = new Set<string>();
      for (const line of refOutput.split(/\r?\n/)) {
        const revision = line.trim();
        if (revision.length > 0) revisions.add(revision);
      }
      for (const line of commitOutput.split(/\r?\n/)) {
        const [fullSha] = line.split("\t");
        if (fullSha !== undefined && /^[0-9a-f]{7,64}$/i.test(fullSha))
          revisions.add(fullSha);
      }
      return [...revisions];
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof GitDiffRequestError)
        throw error;
      // Git may be unavailable while the bundled Git extension is starting.
      return [];
    }
  }

  public async createDiffPlan(
    request: DiffPlanRequest,
    repositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<DiffPlan> {
    if (request.filePath === undefined) {
      return this.createRepositoryDiffPlan(request, repositoryBinding);
    }
    const filePlan = await this.createFileDiffPlan(request, repositoryBinding);
    if (filePlan === undefined) {
      throw new GitDiffRequestError(
        `No diff exists for file '${request.filePath}'.`,
      );
    }
    return filePlan;
  }

  public async createRepositoryDiffPlan(
    request: DiffPlanRequest,
    repositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<DiffRepositoryPlan> {
    const normalizedRequest = normalizeRequest(request);
    const repositoryRootBinding = await this.resolveRepositoryBinding(
      normalizedRequest.repositoryRoot,
      repositoryBinding,
      normalizedRequest.cancellationSignal,
    );
    const resolvedSources = await this.resolveSources(
      repositoryRootBinding,
      normalizedRequest,
    );
    const options = limitOptionsToUriRegistrationCapacity(
      normalizeOptions(normalizedRequest.options),
      resolvedSources,
      this.uriFactory.registrationLimits,
    );
    const commandShape = buildDiffCommandShape(
      resolvedSources.from,
      resolvedSources.to,
      options,
      normalizedRequest.filePath,
      "raw",
    );
    const rawOutput = commandShape.hasDifference
      ? await this.runGitDiff(
          repositoryRootBinding,
          commandShape.arguments,
          normalizedRequest.cancellationSignal,
          options.maxOutputBytes,
        )
      : emptyGitCommandOutput();
    const numstatOutput = commandShape.hasDifference
      ? await this.runGitDiff(
          repositoryRootBinding,
          buildDiffCommandShape(
            resolvedSources.from,
            resolvedSources.to,
            options,
            normalizedRequest.filePath,
            "numstat",
          ).arguments,
          normalizedRequest.cancellationSignal,
          options.maxOutputBytes,
        )
      : emptyGitCommandOutput();
    const parsedDiff = parseRawDiffMetadata(
      rawOutput.standardOutput,
      numstatOutput.standardOutput,
      options.maxFiles,
      options.maxOutputBytes,
    );
    for (const record of parsedDiff.records) {
      assertParsedGitRecordPaths(record);
    }
    const untrackedResult = await this.getUntrackedRecords(
      repositoryRootBinding,
      normalizedRequest,
      resolvedSources,
      options,
      parsedDiff.records,
    );
    const canonicalRecords = [
      ...parsedDiff.records,
      ...untrackedResult.records,
    ].slice(0, options.maxFiles);
    const records = commandShape.invertResult
      ? canonicalRecords.map(invertParsedFileRecord)
      : canonicalRecords;
    const patchOutput = commandShape.hasDifference
      ? await this.runGitDiff(
          repositoryRootBinding,
          buildDiffCommandShape(
            resolvedSources.from,
            resolvedSources.to,
            options,
            normalizedRequest.filePath,
            "patch",
          ).arguments,
          normalizedRequest.cancellationSignal,
          options.maxOutputBytes,
        )
      : emptyGitCommandOutput();
    const parsedHunks = parseDiffHunks(
      patchOutput.standardOutput,
      options.maxNavigationChanges,
      options.maxOutputBytes,
    );
    for (const path of parsedHunks.rangesByPath.keys()) {
      assertGitOutputPath(path);
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    const presentation = createPresentationDescriptor(options);
    const expectedWorkingContentRootIdentity: DiffWorkingContentRootIdentity = {
      canonicalPath: repositoryRootBinding.canonicalRootPath,
      device: repositoryRootBinding.identity.device,
      inode: repositoryRootBinding.identity.inode,
    };
    const files: DiffFilePlan[] = [];
    for (const [fileIndex, record] of records.entries()) {
      await this.assertWorkingTreeUriPaths(
        repositoryRootBinding,
        resolvedSources,
        record,
        normalizedRequest.cancellationSignal,
      );
      files.push(
        await createFilePlan(
          normalizedRequest.repositoryRoot,
          resolvedSources.from,
          resolvedSources.to,
          record,
          fileIndex,
          parsedHunks.rangesByPath,
          commandShape.invertResult,
          presentation,
          this.uriFactory,
          normalizedRequest.cancellationSignal,
          expectedWorkingContentRootIdentity,
        ),
      );
      await this.assertRepositoryRootBinding(repositoryRootBinding);
    }
    const navigation = createNavigationModel(
      files,
      options.maxNavigationChanges,
    );
    const truncated =
      parsedDiff.truncated ||
      parsedHunks.truncated ||
      rawOutput.standardOutputTruncated === true ||
      numstatOutput.standardOutputTruncated === true ||
      patchOutput.standardOutputTruncated === true ||
      untrackedResult.truncated;
    const totalFileCount = records.length + (truncated ? 1 : 0);
    return {
      kind: "repository",
      repositoryRoot: normalizedRequest.repositoryRoot,
      from: normalizedRequest.from,
      to: normalizedRequest.to,
      files,
      navigation,
      presentation,
      totalFileCount,
      omittedFileCount: Math.max(0, totalFileCount - files.length),
      truncated,
      caps: {
        maxFiles: options.maxFiles,
        maxOutputBytes: options.maxOutputBytes,
        maxNavigationChanges: options.maxNavigationChanges,
      },
    };
  }

  public async createFileDiffPlan(
    request: DiffPlanRequest,
    repositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<DiffFileOnlyPlan | undefined> {
    if (request.filePath === undefined) {
      throw new GitDiffRequestError(
        "A relative filePath is required for a single-file diff plan.",
      );
    }
    const repositoryPlan = await this.createRepositoryDiffPlan(
      request,
      repositoryBinding,
    );
    const matchingFile = repositoryPlan.files[0];
    if (matchingFile === undefined) return undefined;
    return {
      ...matchingFile,
      kind: "file",
      from: repositoryPlan.from,
      to: repositoryPlan.to,
    };
  }

  public async getMutableStateFingerprint(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
    repositoryBinding?: GitDiffRepositoryBinding,
  ): Promise<string> {
    const repositoryRootBinding = await this.resolveRepositoryBinding(
      repositoryRoot,
      repositoryBinding,
      cancellationSignal,
    );
    const workingTreeOutput = await this.runGitDiff(
      repositoryRootBinding,
      ["diff", "--no-ext-diff", "--no-textconv", "--raw", "-z"],
      cancellationSignal,
      mutableStateFingerprintMaxOutputBytes,
    );
    const indexOutput = await this.runGitDiff(
      repositoryRootBinding,
      ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--raw", "-z"],
      cancellationSignal,
      mutableStateFingerprintMaxOutputBytes,
    );
    const untrackedOutput = await this.runGitCommandOutput(
      repositoryRootBinding,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      cancellationSignal,
      mutableStateFingerprintMaxOutputBytes,
    );
    const trackedOutput = await this.runGitCommandOutput(
      repositoryRootBinding,
      ["ls-files", "--cached", "-z"],
      cancellationSignal,
      mutableStateFingerprintMaxOutputBytes,
    );
    const headOutput = await this.runGitCommandOutput(
      repositoryRootBinding,
      ["rev-parse", "--verify", "HEAD"],
      cancellationSignal,
      mutableStateFingerprintMaxOutputBytes,
    );
    const refsOutput = await this.runGitCommandOutput(
      repositoryRootBinding,
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
      cancellationSignal,
      mutableStateFingerprintMaxOutputBytes,
    );
    assertCompleteFingerprintOutput(
      "working-tree raw diff",
      workingTreeOutput,
      true,
    );
    assertCompleteFingerprintOutput("index raw diff", indexOutput, true);
    assertCompleteFingerprintOutput("untracked paths", untrackedOutput, true);
    assertCompleteFingerprintOutput("tracked paths", trackedOutput, true);
    assertCompleteFingerprintOutput("HEAD revision", headOutput);
    assertCompleteFingerprintOutput("reference list", refsOutput);
    const untrackedContentFingerprint = await this.hashUntrackedContent(
      repositoryRootBinding,
      untrackedOutput.standardOutput,
      cancellationSignal,
    );
    const trackedContentFingerprint = await this.hashTrackedContent(
      repositoryRootBinding,
      trackedOutput.standardOutput,
      cancellationSignal,
    );
    const fingerprint = createHash("sha256");
    updateFingerprintHash(fingerprint, "working", workingTreeOutput);
    updateFingerprintHash(fingerprint, "index", indexOutput);
    updateFingerprintHash(fingerprint, "untracked", untrackedOutput);
    updateFingerprintHash(fingerprint, "head", headOutput);
    updateFingerprintHash(fingerprint, "refs", refsOutput);
    fingerprint.update("untracked-content\0");
    fingerprint.update(untrackedContentFingerprint);
    fingerprint.update("\0");
    fingerprint.update("tracked-content\0");
    fingerprint.update(trackedContentFingerprint);
    fingerprint.update("\0");
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    return fingerprint.digest("hex");
  }

  public createMultiDiffEditorPlan(
    plan: DiffRepositoryPlan,
    title = createDiffTitle(plan),
  ): DiffMultiEditorPlan {
    return {
      command: "vscode.changes",
      title,
      resources: plan.files
        .filter((file) => !file.metadata.isSubmodule)
        .map(({ originalUri, modifiedUri }) => ({
          ...(originalUri === undefined ? {} : { originalUri }),
          ...(modifiedUri === undefined ? {} : { modifiedUri }),
        })),
    };
  }

  public createWorkingVsIndexRequest(
    repositoryRoot: vscode.Uri,
    options?: DiffPlanOptions,
    cancellationSignal?: AbortSignal,
  ): DiffPlanRequest {
    return {
      repositoryRoot,
      from: createIndexSource(repositoryRoot),
      to: createWorkingTreeSource(repositoryRoot),
      ...(options === undefined ? {} : { options }),
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    };
  }

  public createIndexVsHeadRequest(
    repositoryRoot: vscode.Uri,
    options?: DiffPlanOptions,
    cancellationSignal?: AbortSignal,
  ): DiffPlanRequest {
    return {
      repositoryRoot,
      from: createRevisionSource(repositoryRoot, "HEAD"),
      to: createIndexSource(repositoryRoot),
      ...(options === undefined ? {} : { options }),
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    };
  }

  public createWorkingVsHeadRequest(
    repositoryRoot: vscode.Uri,
    options?: DiffPlanOptions,
    cancellationSignal?: AbortSignal,
  ): DiffPlanRequest {
    return {
      repositoryRoot,
      from: createRevisionSource(repositoryRoot, "HEAD"),
      to: createWorkingTreeSource(repositoryRoot),
      ...(options === undefined ? {} : { options }),
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    };
  }

  public async createCommitVsParentPlan(
    request: CommitParentDiffRequest,
  ): Promise<DiffRepositoryPlan | DiffFileOnlyPlan> {
    assertRepositoryRoot(request.repositoryRoot);
    assertRevisionText(request.commitRevision, "commitRevision");
    const repositoryRootBinding = await this.pinRepositoryRoot(
      request.repositoryRoot,
      request.cancellationSignal,
    );
    const commitSha = await this.resolveCommitRevision(
      repositoryRootBinding,
      request.commitRevision,
      request.cancellationSignal,
    );
    let parentRevision = request.parentRevision;
    if (parentRevision === undefined) {
      parentRevision = await this.resolveFirstParent(
        repositoryRootBinding,
        commitSha,
        request.cancellationSignal,
      );
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    return this.createDiffPlan(
      {
        repositoryRoot: request.repositoryRoot,
        from: createRevisionSource(request.repositoryRoot, parentRevision),
        to: createRevisionSource(request.repositoryRoot, commitSha),
        ...(request.filePath === undefined
          ? {}
          : { filePath: request.filePath }),
        ...(request.options === undefined ? {} : { options: request.options }),
        ...(request.cancellationSignal === undefined
          ? {}
          : { cancellationSignal: request.cancellationSignal }),
      },
      toPublicRepositoryBinding(repositoryRootBinding),
    );
  }

  public async createRevisionDiffPlan(
    repositoryRoot: vscode.Uri,
    fromRevision: string,
    toRevision: string,
    options?: DiffPlanOptions,
    cancellationSignal?: AbortSignal,
  ): Promise<DiffRepositoryPlan> {
    return this.createRepositoryDiffPlan({
      repositoryRoot,
      from: createRevisionSource(repositoryRoot, fromRevision),
      to: createRevisionSource(repositoryRoot, toRevision),
      ...(options === undefined ? {} : { options }),
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    });
  }

  public async createMergeBaseDiffPlan(
    repositoryRoot: vscode.Uri,
    leftRevision: string,
    rightRevision: string,
    options?: DiffPlanOptions,
    cancellationSignal?: AbortSignal,
  ): Promise<DiffRepositoryPlan> {
    return this.createRepositoryDiffPlan({
      repositoryRoot,
      from: createMergeBaseSource(repositoryRoot, leftRevision, rightRevision),
      to: createRevisionSource(repositoryRoot, rightRevision),
      ...(options === undefined ? {} : { options }),
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    });
  }

  public async createPresetDiffPlan(
    repositoryRoot: vscode.Uri,
    preset: DiffComparisonPreset,
    options?: DiffPlanOptions,
    cancellationSignal?: AbortSignal,
  ): Promise<DiffRepositoryPlan> {
    const request =
      preset === "working-vs-index"
        ? this.createWorkingVsIndexRequest(
            repositoryRoot,
            options,
            cancellationSignal,
          )
        : preset === "index-vs-head"
          ? this.createIndexVsHeadRequest(
              repositoryRoot,
              options,
              cancellationSignal,
            )
          : preset === "working-vs-head"
            ? this.createWorkingVsHeadRequest(
                repositoryRoot,
                options,
                cancellationSignal,
              )
            : await this.createCommitVsParentPlan({
                repositoryRoot,
                commitRevision: "HEAD",
                ...(options === undefined ? {} : { options }),
                ...(cancellationSignal === undefined
                  ? {}
                  : { cancellationSignal }),
              });
    if ("kind" in request && request.kind === "file") {
      throw new GitDiffRequestError(
        "Preset unexpectedly returned a file plan.",
      );
    }
    return "kind" in request && request.kind === "repository"
      ? request
      : this.createRepositoryDiffPlan(request);
  }

  private async resolveSources(
    repositoryRootBinding: RepositoryRootBinding,
    request: DiffPlanRequest,
  ): Promise<{
    readonly from: ResolvedDiffSource;
    readonly to: ResolvedDiffSource;
  }> {
    return {
      from: await this.resolveSource(
        repositoryRootBinding,
        request.from,
        request.cancellationSignal,
      ),
      to: await this.resolveSource(
        repositoryRootBinding,
        request.to,
        request.cancellationSignal,
      ),
    };
  }

  private async resolveSource(
    repositoryRootBinding: RepositoryRootBinding,
    source: DiffRepositorySource,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<ResolvedDiffSource> {
    assertSameRepositoryPath(
      repositoryRootBinding.requestedRootPath,
      source.repositoryRoot,
    );
    if (source.kind === "working-tree" || source.kind === "index") {
      return { source };
    }
    if (source.kind === "revision") {
      assertRevisionText(source.revision, "revision");
      return {
        source,
        resolvedRevision: await this.resolveCommitRevision(
          repositoryRootBinding,
          source.revision,
          cancellationSignal,
        ),
      };
    }
    assertRevisionText(source.leftRevision, "leftRevision");
    assertRevisionText(source.rightRevision, "rightRevision");
    const leftRevision = await this.resolveCommitRevision(
      repositoryRootBinding,
      source.leftRevision,
      cancellationSignal,
    );
    const rightRevision = await this.resolveCommitRevision(
      repositoryRootBinding,
      source.rightRevision,
      cancellationSignal,
    );
    const mergeBaseOutput = await this.runGitCommand(
      repositoryRootBinding,
      ["merge-base", "--all", leftRevision, rightRevision],
      cancellationSignal,
    );
    const mergeBaseRevisions = mergeBaseOutput
      .split(/\r?\n/)
      .map((revision) => revision.trim())
      .filter((revision) => revision.length > 0);
    if (mergeBaseRevisions.length === 0) {
      throw new GitDiffRequestError(
        `No merge base exists for '${source.leftRevision}' and '${source.rightRevision}'.`,
      );
    }
    if (mergeBaseRevisions.length > 1) {
      throw new GitDiffRequestError(
        `Multiple merge bases exist for '${source.leftRevision}' and '${source.rightRevision}'; choose a specific revision.`,
      );
    }
    const mergeBaseRevision = mergeBaseRevisions[0]!;
    return { source, resolvedRevision: mergeBaseRevision };
  }

  private async resolveCommitRevision(
    repositoryRootBinding: RepositoryRootBinding,
    revision: string,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<string> {
    assertRevisionText(revision, "revision");
    if (revision === gitEmptyTreeSha) return revision;
    try {
      const output = await this.runGitCommand(
        repositoryRootBinding,
        ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
        cancellationSignal,
      );
      const resolvedRevision = output.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(resolvedRevision)) {
        throw new GitDiffRequestError(
          `Revision '${revision}' did not resolve to a commit.`,
        );
      }
      return resolvedRevision;
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof GitDiffRequestError)
        throw error;
      throw new GitDiffRequestError(
        `Invalid Git revision '${revision}' in '${repositoryRootBinding.canonicalRootPath}'.`,
      );
    }
  }

  private async resolveFirstParent(
    repositoryRootBinding: RepositoryRootBinding,
    commitSha: string,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<string> {
    const output = await this.runGitCommand(
      repositoryRootBinding,
      ["rev-list", "--parents", "-n", "1", commitSha],
      cancellationSignal,
    );
    const parentSha = output.trim().split(/\s+/)[1];
    return parentSha ?? gitEmptyTreeSha;
  }

  private async runGitDiff(
    repositoryRootBinding: RepositoryRootBinding,
    argumentsPassed: readonly string[],
    cancellationSignal: AbortSignal | undefined,
    maxOutputBytes: number,
  ): Promise<GitCommandOutput> {
    return this.runGitCommandOutput(
      repositoryRootBinding,
      argumentsPassed,
      cancellationSignal,
      maxOutputBytes,
    );
  }

  private async runGitCommand(
    repositoryRootBinding: RepositoryRootBinding,
    argumentsPassed: readonly string[],
    cancellationSignal: AbortSignal | undefined,
    maxOutputBytes?: number,
  ): Promise<string> {
    const output = await this.runGitCommandOutput(
      repositoryRootBinding,
      argumentsPassed,
      cancellationSignal,
      maxOutputBytes,
    );
    return output.standardOutput;
  }

  private async runGitCommandOutput(
    repositoryRootBinding: RepositoryRootBinding,
    argumentsPassed: readonly string[],
    cancellationSignal: AbortSignal | undefined,
    maxOutputBytes?: number,
  ): Promise<GitCommandOutput> {
    if (cancellationSignal?.aborted) {
      throw new DOMException("Git diff cancelled", "AbortError");
    }
    try {
      await this.assertRepositoryRootBinding(repositoryRootBinding);
      const output = await this.gitCommandRunner.run({
        repositoryRoot: repositoryRootBinding.canonicalRootPath,
        rootBinding: repositoryRootBinding.rootBinding,
        arguments: argumentsPassed,
        ...(maxOutputBytes === undefined
          ? {}
          : { maxStandardOutputBytes: maxOutputBytes }),
        ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
      });
      await this.assertRepositoryRootBinding(repositoryRootBinding);
      return output;
    } catch (error: unknown) {
      if (isGitRootBindingFailure(error)) {
        throw new GitDiffRequestError(
          `Repository root '${repositoryRootBinding.requestedRootPath}' changed or became unavailable during the diff.`,
        );
      }
      throw error;
    }
  }

  private async getUntrackedRecords(
    repositoryRootBinding: RepositoryRootBinding,
    request: DiffPlanRequest,
    resolvedSources: {
      readonly from: ResolvedDiffSource;
      readonly to: ResolvedDiffSource;
    },
    options: Required<DiffPlanOptions>,
    existingRecords: readonly ParsedFileRecord[],
  ): Promise<UntrackedRecordsResult> {
    if (!includesWorkingTree(resolvedSources.from, resolvedSources.to))
      return { records: [], truncated: false };
    const untrackedOutput = await this.runGitCommandOutput(
      repositoryRootBinding,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        ...(request.filePath === undefined ? [] : ["--", request.filePath]),
      ],
      request.cancellationSignal,
      options.maxOutputBytes,
    );
    const existingPaths = new Set(
      existingRecords.flatMap((record) =>
        [record.oldPath, record.newPath].filter(
          (filePath): filePath is string => filePath !== undefined,
        ),
      ),
    );
    const untrackedRecords: ParsedFileRecord[] = [];
    let skippedByFileCap = false;
    const completeUntrackedOutput = discardIncompleteNulRecord(
      untrackedOutput.standardOutput,
    );
    for (const filePath of completeUntrackedOutput.split("\0")) {
      if (filePath.length === 0) {
        continue;
      }
      assertGitOutputPath(filePath);
      if (existingPaths.has(filePath)) continue;
      if (
        untrackedRecords.length + existingRecords.length >=
        options.maxFiles
      ) {
        skippedByFileCap = true;
        continue;
      }
      untrackedRecords.push({
        newPath: filePath,
        metadata: {
          changeType: "added",
          newPath: filePath,
          additions: 0,
          deletions: 0,
          isBinary: false,
          isSubmodule: false,
          isSymlink: await this.isWorkingTreeSymlink(
            repositoryRootBinding,
            filePath,
          ),
        },
      });
    }
    return {
      records: untrackedRecords,
      truncated:
        untrackedOutput.standardOutputTruncated === true ||
        skippedByFileCap ||
        (untrackedOutput.standardOutput.length > 0 &&
          !untrackedOutput.standardOutput.endsWith("\0")),
    };
  }

  private async pinRepositoryRoot(
    repositoryRoot: vscode.Uri,
    cancellationSignal?: AbortSignal,
  ): Promise<RepositoryRootBinding> {
    assertRepositoryRoot(repositoryRoot);
    try {
      const rootBinding = await this.rootBindingResolver.resolve(
        repositoryRoot.fsPath,
        undefined,
        {
          cancellationSignal,
          requireGitTopLevelMatch: true,
        },
      );
      return {
        requestedRootPath: repositoryRoot.fsPath,
        canonicalRootPath: rootBinding.canonicalPath,
        identity: {
          device: BigInt(rootBinding.device),
          inode: BigInt(rootBinding.inode),
        },
        rootBinding,
      };
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof GitDiffRequestError)
        throw error;
      if (
        error instanceof Error &&
        error.message.includes("Selected repository directory")
      ) {
        throw new GitDiffRequestError(
          `Selected directory '${repositoryRoot.fsPath}' is not the Git top-level repository.`,
        );
      }
      throw new GitDiffRequestError(
        `Repository root '${repositoryRoot.fsPath}' is unavailable or is not a directory.`,
      );
    }
  }

  private async resolveRepositoryBinding(
    repositoryRoot: vscode.Uri,
    repositoryBinding?: GitDiffRepositoryBinding,
    cancellationSignal?: AbortSignal,
  ): Promise<RepositoryRootBinding> {
    if (repositoryBinding === undefined)
      return this.pinRepositoryRoot(repositoryRoot, cancellationSignal);
    assertRepositoryRoot(repositoryRoot);
    if (
      normalizeRepositoryPath(repositoryBinding.requestedRootPath) !==
      normalizeRepositoryPath(repositoryRoot.fsPath)
    ) {
      throw new GitDiffRequestError(
        `Diff request root '${repositoryRoot.fsPath}' does not match its pinned root.`,
      );
    }
    const internalBinding: RepositoryRootBinding = {
      requestedRootPath: repositoryBinding.requestedRootPath,
      canonicalRootPath: repositoryBinding.rootBinding.canonicalPath,
      identity: {
        device: BigInt(repositoryBinding.rootBinding.device),
        inode: BigInt(repositoryBinding.rootBinding.inode),
      },
      rootBinding: repositoryBinding.rootBinding,
    };
    try {
      await this.rootBindingResolver.assert(
        internalBinding.requestedRootPath,
        internalBinding.rootBinding,
        { cancellationSignal, requireGitTopLevelMatch: true },
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      if (
        error instanceof Error &&
        error.message.includes("Selected repository directory")
      ) {
        throw new GitDiffRequestError(
          `Selected directory '${internalBinding.requestedRootPath}' is not the Git top-level repository.`,
        );
      }
      throw new GitDiffRequestError(
        `Repository root '${internalBinding.requestedRootPath}' changed or became unavailable during the diff.`,
      );
    }
    await this.assertRepositoryRootBinding(internalBinding);
    return internalBinding;
  }

  private async assertRepositoryRootBinding(
    repositoryRootBinding: RepositoryRootBinding,
  ): Promise<void> {
    try {
      const currentCanonicalRootPath = await realpath(
        repositoryRootBinding.requestedRootPath,
      );
      const currentRootStats = await stat(currentCanonicalRootPath, {
        bigint: true,
      });
      const currentGitDirectoryStats = await stat(
        repositoryRootBinding.rootBinding.gitDirectory.canonicalPath,
        { bigint: true },
      );
      const currentCommonDirectoryStats = await stat(
        repositoryRootBinding.rootBinding.commonDirectory.canonicalPath,
        { bigint: true },
      );
      if (
        normalizeRepositoryPath(currentCanonicalRootPath) !==
          normalizeRepositoryPath(repositoryRootBinding.canonicalRootPath) ||
        String(currentRootStats.dev) !==
          repositoryRootBinding.rootBinding.device ||
        String(currentRootStats.ino) !==
          repositoryRootBinding.rootBinding.inode ||
        String(currentGitDirectoryStats.dev) !==
          repositoryRootBinding.rootBinding.gitDirectory.device ||
        String(currentGitDirectoryStats.ino) !==
          repositoryRootBinding.rootBinding.gitDirectory.inode ||
        String(currentCommonDirectoryStats.dev) !==
          repositoryRootBinding.rootBinding.commonDirectory.device ||
        String(currentCommonDirectoryStats.ino) !==
          repositoryRootBinding.rootBinding.commonDirectory.inode
      ) {
        throw new Error("repository root identity changed");
      }
    } catch {
      throw new GitDiffRequestError(
        `Repository root '${repositoryRootBinding.requestedRootPath}' changed or became unavailable during the diff.`,
      );
    }
  }

  private async assertWorkingTreeUriPaths(
    repositoryRootBinding: RepositoryRootBinding,
    resolvedSources: {
      readonly from: ResolvedDiffSource;
      readonly to: ResolvedDiffSource;
    },
    record: ParsedFileRecord,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<void> {
    const originalPath =
      record.metadata.changeType === "added"
        ? undefined
        : (record.metadata.oldPath ?? record.oldPath);
    const modifiedPath =
      record.metadata.changeType === "deleted"
        ? undefined
        : (record.metadata.newPath ?? record.newPath);
    if (
      originalPath !== undefined &&
      resolvedSources.from.source.kind === "working-tree"
    ) {
      await this.assertWorkingTreeUriPath(
        repositoryRootBinding,
        originalPath,
        cancellationSignal,
      );
    }
    if (
      modifiedPath !== undefined &&
      resolvedSources.to.source.kind === "working-tree"
    ) {
      await this.assertWorkingTreeUriPath(
        repositoryRootBinding,
        modifiedPath,
        cancellationSignal,
      );
    }
  }

  private async assertWorkingTreeUriPath(
    repositoryRootBinding: RepositoryRootBinding,
    relativeFilePath: string,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<void> {
    throwIfDiffCancelled(cancellationSignal);
    assertGitOutputPath(relativeFilePath);
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    const filePath = nodePath.resolve(
      repositoryRootBinding.canonicalRootPath,
      relativeFilePath,
    );
    if (
      !isPathWithinRepository(repositoryRootBinding.canonicalRootPath, filePath)
    ) {
      throw new GitDiffRequestError(
        `Git returned a file path outside repository root: '${relativeFilePath}'.`,
      );
    }
    let canonicalParentPath: string;
    try {
      canonicalParentPath = await realpath(nodePath.dirname(filePath));
    } catch {
      throw new GitDiffRequestError(
        `Git returned an unavailable working-tree path: '${relativeFilePath}'.`,
      );
    }
    if (
      !isPathWithinOrEqual(
        repositoryRootBinding.canonicalRootPath,
        canonicalParentPath,
      )
    ) {
      throw new GitDiffRequestError(
        `Git returned a file path through a parent outside repository root: '${relativeFilePath}'.`,
      );
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
  }

  private async isWorkingTreeSymlink(
    repositoryRootBinding: RepositoryRootBinding,
    relativeFilePath: string,
  ): Promise<boolean> {
    assertGitOutputPath(relativeFilePath);
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    const filePath = nodePath.resolve(
      repositoryRootBinding.canonicalRootPath,
      relativeFilePath,
    );
    if (
      !isPathWithinRepository(repositoryRootBinding.canonicalRootPath, filePath)
    ) {
      throw new GitDiffRequestError(
        `Git returned a file path outside repository root: '${relativeFilePath}'.`,
      );
    }
    let canonicalParentPath: string;
    try {
      canonicalParentPath = await realpath(nodePath.dirname(filePath));
    } catch {
      await this.assertRepositoryRootBinding(repositoryRootBinding);
      return false;
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    if (
      !isPathWithinOrEqual(
        repositoryRootBinding.canonicalRootPath,
        canonicalParentPath,
      )
    ) {
      throw new GitDiffRequestError(
        `Git returned a file path through a parent outside repository root: '${relativeFilePath}'.`,
      );
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    let isSymlink = false;
    try {
      isSymlink = (await lstat(filePath)).isSymbolicLink();
    } catch {
      // Git can report a path that disappears between enumeration and lstat.
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    return isSymlink;
  }

  private async hashTrackedContent(
    repositoryRootBinding: RepositoryRootBinding,
    nulSeparatedPaths: string,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<string> {
    if (nulSeparatedPaths.length > 0 && !nulSeparatedPaths.endsWith("\0"))
      throw new GitDiffRequestError(
        "Tracked working-tree fingerprint output was incomplete.",
      );
    const contentFingerprint = createHash("sha256");
    const relativePaths = nulSeparatedPaths
      .split("\0")
      .filter((relativePath) => relativePath.length > 0);
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    for (const relativePath of relativePaths) {
      throwIfDiffCancelled(cancellationSignal);
      assertGitOutputPath(relativePath);
      const filePath = nodePath.resolve(
        repositoryRootBinding.canonicalRootPath,
        relativePath,
      );
      if (
        !isPathWithinRepository(
          repositoryRootBinding.canonicalRootPath,
          filePath,
        )
      ) {
        throw new GitDiffRequestError(
          `Git returned a tracked path outside repository root: '${relativePath}'.`,
        );
      }
      const lexicalParentPath = nodePath.dirname(filePath);
      let canonicalParentPath: string;
      try {
        canonicalParentPath = await realpath(lexicalParentPath);
      } catch {
        throw new GitDiffRequestError(
          `Tracked path '${relativePath}' became unavailable while fingerprinting.`,
        );
      }
      if (
        !isPathWithinOrEqual(
          repositoryRootBinding.canonicalRootPath,
          canonicalParentPath,
        )
      ) {
        throw new GitDiffRequestError(
          `Tracked path '${relativePath}' escaped the repository while fingerprinting.`,
        );
      }
      const parentStats = await stat(canonicalParentPath, { bigint: true });
      contentFingerprint.update(relativePath);
      contentFingerprint.update("\0");
      let fileStats: BigIntStats;
      try {
        fileStats = await lstat(filePath, { bigint: true });
      } catch (error: unknown) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw new GitDiffRequestError(
            `Tracked path '${relativePath}' became unavailable while fingerprinting.`,
          );
        }
        contentFingerprint.update("missing\0");
        await this.assertUntrackedParentBinding(
          lexicalParentPath,
          canonicalParentPath,
          parentStats,
          relativePath,
        );
        continue;
      }
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
      if (fileStats.isSymbolicLink()) {
        const initialTarget = await readlink(filePath);
        const currentStats = await lstat(filePath, { bigint: true });
        const currentTarget = await readlink(filePath);
        if (
          !sameUntrackedFileIdentity(fileStats, currentStats) ||
          initialTarget !== currentTarget
        ) {
          throw new GitDiffRequestError(
            `Tracked symlink '${relativePath}' changed while fingerprinting.`,
          );
        }
        contentFingerprint.update("symlink\0");
        contentFingerprint.update(initialTarget);
      } else if (fileStats.isFile()) {
        contentFingerprint.update("regular\0");
        await this.hashUntrackedRegularFile(
          filePath,
          relativePath,
          fileStats,
          contentFingerprint,
          cancellationSignal,
        );
      } else {
        contentFingerprint.update("special\0");
      }
      await this.assertUntrackedParentBinding(
        lexicalParentPath,
        canonicalParentPath,
        parentStats,
        relativePath,
      );
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    return contentFingerprint.digest("hex");
  }

  private async hashUntrackedContent(
    repositoryRootBinding: RepositoryRootBinding,
    nulSeparatedPaths: string,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<string> {
    const contentFingerprint = createHash("sha256");
    const completePathOutput = discardIncompleteNulRecord(nulSeparatedPaths);
    const relativePaths = completePathOutput
      .split("\0")
      .filter((relativePath) => relativePath.length > 0);
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    for (const relativePath of relativePaths) {
      throwIfDiffCancelled(cancellationSignal);
      const filePath = nodePath.resolve(
        repositoryRootBinding.canonicalRootPath,
        relativePath,
      );
      if (
        !isPathWithinRepository(
          repositoryRootBinding.canonicalRootPath,
          filePath,
        )
      ) {
        throw new GitDiffRequestError(
          `Git returned an untracked path outside repository root: '${relativePath}'.`,
        );
      }
      const parentPath = await realpath(nodePath.dirname(filePath));
      if (
        !isPathWithinOrEqual(
          repositoryRootBinding.canonicalRootPath,
          parentPath,
        )
      ) {
        throw new GitDiffRequestError(
          `Git returned an untracked path through a parent outside repository root: '${relativePath}'.`,
        );
      }
      const parentStats = await stat(parentPath, { bigint: true });
      const fileStats = await lstat(filePath, { bigint: true });
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
      if (fileStats.isSymbolicLink()) {
        const initialTarget = await readlink(filePath);
        const currentStats = await lstat(filePath, { bigint: true });
        const currentTarget = await readlink(filePath);
        if (
          !sameUntrackedFileIdentity(fileStats, currentStats) ||
          initialTarget !== currentTarget
        ) {
          throw new GitDiffRequestError(
            `Untracked symlink '${relativePath}' changed while fingerprinting.`,
          );
        }
        contentFingerprint.update(initialTarget);
      } else if (fileStats.isFile()) {
        await this.hashUntrackedRegularFile(
          filePath,
          relativePath,
          fileStats,
          contentFingerprint,
          cancellationSignal,
        );
      }
      contentFingerprint.update("\0");
      await this.assertUntrackedParentBinding(
        nodePath.dirname(filePath),
        parentPath,
        parentStats,
        relativePath,
      );
    }
    await this.assertRepositoryRootBinding(repositoryRootBinding);
    return contentFingerprint.digest("hex");
  }

  private async assertUntrackedParentBinding(
    lexicalParentPath: string,
    expectedCanonicalParentPath: string,
    expectedParentStats: BigIntStats,
    relativePath: string,
  ): Promise<void> {
    try {
      const currentCanonicalParentPath = await realpath(lexicalParentPath);
      const currentParentStats = await stat(currentCanonicalParentPath, {
        bigint: true,
      });
      if (
        normalizeRepositoryPath(currentCanonicalParentPath) !==
          normalizeRepositoryPath(expectedCanonicalParentPath) ||
        currentParentStats.dev !== expectedParentStats.dev ||
        currentParentStats.ino !== expectedParentStats.ino
      ) {
        throw new Error("untracked parent identity changed");
      }
    } catch (error: unknown) {
      if (error instanceof GitDiffRequestError) throw error;
      throw new GitDiffRequestError(
        `Untracked path '${relativePath}' changed while fingerprinting.`,
      );
    }
  }

  private async hashUntrackedRegularFile(
    filePath: string,
    relativePath: string,
    initialStats: BigIntStats,
    contentFingerprint: ReturnType<typeof createHash>,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<void> {
    const noFollowFlag = fsConstants.O_NOFOLLOW;
    if (noFollowFlag === undefined) {
      throw new GitDiffRequestError(
        `Cannot safely fingerprint untracked file '${relativePath}'.`,
      );
    }
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(filePath, fsConstants.O_RDONLY | noFollowFlag);
      const openedStats = await fileHandle.stat({ bigint: true });
      if (!sameUntrackedFileIdentity(initialStats, openedStats)) {
        throw new GitDiffRequestError(
          `Untracked file '${relativePath}' changed while fingerprinting.`,
        );
      }
      const readBuffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        throwIfDiffCancelled(cancellationSignal);
        const { bytesRead } = await fileHandle.read(
          readBuffer,
          0,
          readBuffer.byteLength,
          null,
        );
        if (bytesRead === 0) break;
        contentFingerprint.update(readBuffer.subarray(0, bytesRead));
      }
      const finalStats = await fileHandle.stat({ bigint: true });
      if (!sameUntrackedFileIdentity(initialStats, finalStats)) {
        throw new GitDiffRequestError(
          `Untracked file '${relativePath}' changed while fingerprinting.`,
        );
      }
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof GitDiffRequestError)
        throw error;
      throw new GitDiffRequestError(
        `Unable to safely fingerprint untracked file '${relativePath}'.`,
      );
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }
}

function sameUntrackedFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function discardIncompleteNulRecord(output: string): string {
  if (output.length === 0 || output.endsWith("\0")) return output;
  const finalSeparator = output.lastIndexOf("\0");
  return finalSeparator < 0 ? "" : output.slice(0, finalSeparator + 1);
}

function updateFingerprintHash(
  fingerprint: ReturnType<typeof createHash>,
  label: string,
  output: GitCommandOutput,
): void {
  fingerprint.update(label);
  fingerprint.update("\0");
  fingerprint.update(output.standardOutput);
  fingerprint.update("\0");
  fingerprint.update(output.standardOutputTruncated === true ? "1" : "0");
  fingerprint.update("\0");
}

function assertCompleteFingerprintOutput(
  outputLabel: string,
  output: GitCommandOutput,
  requiresNulTerminator = false,
): void {
  if (
    output.standardOutputTruncated === true ||
    output.standardErrorTruncated === true ||
    (requiresNulTerminator &&
      output.standardOutput.length > 0 &&
      !output.standardOutput.endsWith("\0"))
  ) {
    throw new GitDiffRequestError(
      `Mutable-state fingerprint ${outputLabel} output exceeded the safety cap.`,
    );
  }
}

function normalizeRequest(request: DiffPlanRequest): DiffPlanRequest {
  assertRepositoryRoot(request.repositoryRoot);
  assertSameRepository(request.repositoryRoot, request.from.repositoryRoot);
  assertSameRepository(request.repositoryRoot, request.to.repositoryRoot);
  if (request.filePath !== undefined) assertRelativeFilePath(request.filePath);
  return request;
}

function normalizeOptions(
  options: DiffPlanOptions | undefined,
): Required<DiffPlanOptions> {
  const mergedOptions = { ...defaultDiffPlanOptions, ...options };
  if (
    !Number.isInteger(mergedOptions.contextLines) ||
    mergedOptions.contextLines < 0 ||
    mergedOptions.contextLines > 1_000
  ) {
    throw new GitDiffRequestError(
      "contextLines must be an integer from 0 to 1000.",
    );
  }
  if (
    !Number.isInteger(mergedOptions.renameSimilarityPercent) ||
    mergedOptions.renameSimilarityPercent < 0 ||
    mergedOptions.renameSimilarityPercent > 100
  ) {
    throw new GitDiffRequestError(
      "renameSimilarityPercent must be an integer from 0 to 100.",
    );
  }
  if (
    mergedOptions.copyDetection !== "none" &&
    mergedOptions.copyDetection !== "default" &&
    mergedOptions.copyDetection !== "harder"
  ) {
    throw new GitDiffRequestError(
      "copyDetection must be none, default, or harder.",
    );
  }
  for (const [optionName, optionValue] of [
    ["maxFiles", mergedOptions.maxFiles],
    ["maxOutputBytes", mergedOptions.maxOutputBytes],
    ["maxNavigationChanges", mergedOptions.maxNavigationChanges],
  ] as const) {
    if (!Number.isInteger(optionValue) || optionValue < 1) {
      throw new GitDiffRequestError(
        `${optionName} must be a positive integer.`,
      );
    }
  }
  return mergedOptions;
}

function limitOptionsToUriRegistrationCapacity(
  options: Required<DiffPlanOptions>,
  resolvedSources: {
    readonly from: ResolvedDiffSource;
    readonly to: ResolvedDiffSource;
  },
  registrationLimits: DiffUriRegistrationLimits | undefined,
): Required<DiffPlanOptions> {
  if (!includesWorkingTree(resolvedSources.from, resolvedSources.to))
    return options;
  if (registrationLimits === undefined) return options;
  const maximumFilesPerRegistrationCap = Math.max(
    1,
    Math.floor(registrationLimits.maxRegistrationsPerSession / 2),
  );
  const maximumFilesPerWorkingContentCap = Math.max(
    1,
    Math.floor(
      registrationLimits.maxTotalWorkingContentBytes /
        registrationLimits.workingContentReservationBytes,
    ),
  );
  const effectiveMaxFiles = Math.min(
    options.maxFiles,
    maximumFilesPerRegistrationCap,
    maximumFilesPerWorkingContentCap,
  );
  return effectiveMaxFiles === options.maxFiles
    ? options
    : { ...options, maxFiles: effectiveMaxFiles };
}

function buildDiffCommandShape(
  from: ResolvedDiffSource,
  to: ResolvedDiffSource,
  options: Required<DiffPlanOptions>,
  filePath: string | undefined,
  outputKind: "raw" | "numstat" | "patch",
): DiffCommandShape {
  const argumentsPassed: string[] = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    ...(outputKind === "raw" ? ["--raw", "-z"] : []),
    ...(outputKind === "numstat" ? ["--numstat", "-z"] : []),
    ...(outputKind === "patch" ? ["--no-color"] : []),
    ...(options.renameDetection
      ? [
          `--find-renames=${options.renameSimilarityPercent}`,
          ...(options.copyDetection === "harder"
            ? [
                `--find-copies-harder`,
                `--find-copies=${options.renameSimilarityPercent}`,
              ]
            : options.copyDetection === "default"
              ? [`--find-copies=${options.renameSimilarityPercent}`]
              : []),
        ]
      : ["--no-renames"]),
    ...whitespaceArguments(options.whitespaceMode),
    ...(outputKind === "patch" ? [`--unified=${options.contextLines}`] : []),
  ];
  const fromRevision = revisionOf(from);
  const toRevision = revisionOf(to);
  let invertResult = false;
  let hasDifference = true;
  if (from.source.kind === "working-tree" && to.source.kind === "index") {
    // Git's default diff is index -> working tree, so reverse it.
    invertResult = true;
  } else if (
    from.source.kind === "index" &&
    to.source.kind === "working-tree"
  ) {
    // Git's default diff is already index -> working tree.
  } else if (from.source.kind === "index" && toRevision !== undefined) {
    argumentsPassed.push("--cached", toRevision);
    invertResult = true;
  } else if (fromRevision !== undefined && to.source.kind === "index") {
    argumentsPassed.push("--cached", fromRevision);
  } else if (from.source.kind === "working-tree" && toRevision !== undefined) {
    argumentsPassed.push(toRevision);
    invertResult = true;
  } else if (fromRevision !== undefined && to.source.kind === "working-tree") {
    argumentsPassed.push(fromRevision);
  } else if (fromRevision !== undefined && toRevision !== undefined) {
    argumentsPassed.push(fromRevision, toRevision);
  } else {
    hasDifference = false;
  }
  if (filePath !== undefined && hasDifference) {
    argumentsPassed.push("--", filePath);
  }
  return { arguments: argumentsPassed, invertResult, hasDifference };
}

function revisionOf(source: ResolvedDiffSource): string | undefined {
  return source.source.kind === "revision" ||
    source.source.kind === "merge-base"
    ? source.resolvedRevision
    : undefined;
}

function whitespaceArguments(
  whitespaceMode: DiffWhitespaceMode,
): readonly string[] {
  switch (whitespaceMode) {
    case "ignore-all":
      return ["--ignore-all-space"];
    case "ignore-space-change":
      return ["--ignore-space-change"];
    case "ignore-space-at-eol":
      return ["--ignore-space-at-eol"];
    case "ignore-blank-lines":
      return ["--ignore-blank-lines"];
    case "default":
      return [];
  }
}

async function createFilePlan(
  repositoryRoot: vscode.Uri,
  from: ResolvedDiffSource,
  to: ResolvedDiffSource,
  record: ParsedFileRecord,
  fileIndex: number,
  rangesByPath: ReadonlyMap<string, readonly DiffChangeRange[]>,
  inverted: boolean,
  presentation: DiffPresentationDescriptor,
  uriFactory: DiffUriFactory,
  cancellationSignal: AbortSignal | undefined,
  expectedWorkingContentRootIdentity: DiffWorkingContentRootIdentity,
): Promise<DiffFilePlan> {
  const displayPath = record.newPath ?? record.oldPath ?? "(unknown file)";
  assertParsedGitRecordPaths(record);
  assertGitOutputPath(displayPath);
  // `git diff` emits ranges in its canonical (index/commit -> worktree) order.
  // Reverse requests swap metadata afterwards, so a rename's canonical new path
  // is the inverted record's old path.
  const hunkKey = inverted
    ? (record.oldPath ?? record.newPath)
    : (record.newPath ?? record.oldPath);
  let changeRanges =
    hunkKey === undefined ? [] : [...(rangesByPath.get(hunkKey) ?? [])];
  if (inverted) changeRanges = changeRanges.map(invertChangeRange);
  const navigationEntryIds = changeRanges.map(
    (_range, rangeIndex) => `diff-${fileIndex}-${rangeIndex}`,
  );
  if (changeRanges.length === 0) {
    changeRanges = [
      {
        oldStartLine: 1,
        oldLineCount: 0,
        newStartLine: 1,
        newLineCount: 0,
      },
    ];
    navigationEntryIds.push(`diff-${fileIndex}-0`);
  }
  const originalPath =
    record.metadata.changeType === "added"
      ? undefined
      : (record.metadata.oldPath ?? record.oldPath);
  const modifiedPath =
    record.metadata.changeType === "deleted"
      ? undefined
      : (record.metadata.newPath ?? record.newPath);
  const originalIsSymlink =
    record.metadata.oldMode === "120000" ||
    (record.metadata.changeType === "deleted" && record.metadata.isSymlink);
  const modifiedIsSymlink =
    record.metadata.newMode === "120000" ||
    (record.metadata.changeType === "added" && record.metadata.isSymlink);
  const originalUri =
    originalPath === undefined
      ? createEmptyUri(uriFactory, repositoryRoot, displayPath, "original")
      : await createSourceUri(
          uriFactory,
          from,
          repositoryRoot,
          originalPath,
          originalIsSymlink,
          cancellationSignal,
          expectedWorkingContentRootIdentity,
        );
  const modifiedUri =
    modifiedPath === undefined
      ? createEmptyUri(uriFactory, repositoryRoot, displayPath, "modified")
      : await createSourceUri(
          uriFactory,
          to,
          repositoryRoot,
          modifiedPath,
          modifiedIsSymlink,
          cancellationSignal,
          expectedWorkingContentRootIdentity,
        );
  return {
    repositoryRoot,
    metadata: record.metadata,
    displayPath,
    ...(originalUri === undefined ? {} : { originalUri }),
    ...(modifiedUri === undefined ? {} : { modifiedUri }),
    presentation,
    changeRanges,
    navigationEntryIds,
  };
}

function createEmptyUri(
  uriFactory: DiffUriFactory,
  repositoryRoot: vscode.Uri,
  displayPath: string,
  side: "original" | "modified",
): vscode.Uri {
  assertGitOutputPath(displayPath);
  return uriFactory.empty(
    nodePath.join(repositoryRoot.fsPath, displayPath),
    side,
  );
}

async function createSourceUri(
  uriFactory: DiffUriFactory,
  source: ResolvedDiffSource,
  repositoryRoot: vscode.Uri,
  filePath: string,
  isSymlink: boolean,
  cancellationSignal: AbortSignal | undefined,
  expectedWorkingContentRootIdentity: DiffWorkingContentRootIdentity,
): Promise<vscode.Uri> {
  assertGitOutputPath(filePath);
  const fileUri = uriFactory.file(
    nodePath.join(repositoryRoot.fsPath, filePath),
  );
  if (source.source.kind === "working-tree") {
    return isSymlink
      ? uriFactory.symlink(fileUri.fsPath, repositoryRoot.fsPath)
      : await uriFactory.workingContent(
          fileUri.fsPath,
          repositoryRoot.fsPath,
          cancellationSignal,
          expectedWorkingContentRootIdentity,
        );
  }
  const ref = source.source.kind === "index" ? "" : source.resolvedRevision;
  return fileUri.with({
    scheme: "git",
    query: JSON.stringify({ path: fileUri.fsPath, ref }),
  });
}

function createNavigationModel(
  files: readonly DiffFilePlan[],
  maxNavigationChanges: number,
): DiffNavigationModel {
  const entries: DiffNavigationEntry[] = [];
  let truncated = false;
  for (const [fileIndex, file] of files.entries()) {
    for (const [rangeIndex, range] of file.changeRanges.entries()) {
      if (entries.length >= maxNavigationChanges) {
        truncated = true;
        break;
      }
      entries.push({
        id: `diff-${fileIndex}-${rangeIndex}`,
        fileIndex,
        path: file.displayPath,
        rangeIndex,
        range,
      });
    }
    if (truncated) break;
  }
  const entryIndexById = new Map(
    entries.map((entry, index) => [entry.id, index]),
  );
  return {
    entries,
    truncated,
    nextEntryId: (currentEntryId) =>
      navigate(entryIndexById, entries, currentEntryId, 1),
    previousEntryId: (currentEntryId) =>
      navigate(entryIndexById, entries, currentEntryId, -1),
  };
}

function navigate(
  entryIndexById: ReadonlyMap<string, number>,
  entries: readonly DiffNavigationEntry[],
  currentEntryId: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (entries.length === 0) return undefined;
  if (currentEntryId === undefined) {
    return direction === 1 ? entries[0]?.id : entries[entries.length - 1]?.id;
  }
  const currentIndex = entryIndexById.get(currentEntryId);
  if (currentIndex === undefined) return undefined;
  return entries[currentIndex + direction]?.id;
}

function createPresentationDescriptor(
  options: Required<DiffPlanOptions>,
): DiffPresentationDescriptor {
  return {
    mode: options.presentationMode,
    contextLines: options.contextLines,
    whitespaceMode: options.whitespaceMode,
    wordComparison:
      options.presentationMode === "word" ||
      options.presentationMode === "intraline",
    intralineComparison: options.presentationMode === "intraline",
  };
}

function invertParsedFileRecord(record: ParsedFileRecord): ParsedFileRecord {
  const metadata = record.metadata;
  const changeType =
    metadata.changeType === "added"
      ? "deleted"
      : metadata.changeType === "deleted"
        ? "added"
        : metadata.changeType;
  const { oldPath, newPath, ...metadataWithoutPaths } = metadata;
  void oldPath;
  void newPath;
  const invertedOldPath = record.newPath ?? record.oldPath;
  const invertedNewPath = record.oldPath ?? record.newPath;
  const invertedPathFields =
    changeType === "added"
      ? invertedNewPath === undefined
        ? {}
        : { newPath: invertedNewPath }
      : changeType === "deleted"
        ? invertedOldPath === undefined
          ? {}
          : { oldPath: invertedOldPath }
        : {
            ...(invertedOldPath === undefined
              ? {}
              : { oldPath: invertedOldPath }),
            ...(invertedNewPath === undefined
              ? {}
              : { newPath: invertedNewPath }),
          };
  const invertedMetadata: DiffFileMetadata = {
    ...metadataWithoutPaths,
    changeType,
    ...invertedPathFields,
    additions: metadata.deletions,
    deletions: metadata.additions,
    ...(metadata.newMode === undefined ? {} : { oldMode: metadata.newMode }),
    ...(metadata.oldMode === undefined ? {} : { newMode: metadata.oldMode }),
  };
  return {
    ...(record.newPath === undefined ? {} : { oldPath: record.newPath }),
    ...(record.oldPath === undefined ? {} : { newPath: record.oldPath }),
    metadata: invertedMetadata,
  };
}

function invertChangeRange(range: DiffChangeRange): DiffChangeRange {
  return {
    oldStartLine: range.newStartLine,
    oldLineCount: range.newLineCount,
    newStartLine: range.oldStartLine,
    newLineCount: range.oldLineCount,
  };
}

function includesWorkingTree(
  from: ResolvedDiffSource,
  to: ResolvedDiffSource,
): boolean {
  return (
    (from.source.kind === "working-tree" ||
      to.source.kind === "working-tree") &&
    !(from.source.kind === "working-tree" && to.source.kind === "working-tree")
  );
}

function createDiffTitle(plan: DiffRepositoryPlan): string {
  return `${sourceLabel(plan.from)} ↔ ${sourceLabel(plan.to)}`;
}

function sourceLabel(source: DiffRepositorySource): string {
  switch (source.kind) {
    case "working-tree":
      return "Working Tree";
    case "index":
      return "Index";
    case "revision":
      return source.revision ?? "Revision";
    case "merge-base":
      return `merge-base(${source.leftRevision}, ${source.rightRevision})`;
  }
}

function assertRepositoryRoot(repositoryRoot: vscode.Uri): void {
  if (repositoryRoot.scheme !== "file") {
    throw new GitDiffRequestError(
      "Git diff requires a local desktop repository; remote workspaces are not supported.",
    );
  }
  if (!nodePath.isAbsolute(repositoryRoot.fsPath)) {
    throw new GitDiffRequestError(
      "repositoryRoot must be an absolute file URI.",
    );
  }
}

function assertSameRepository(
  expectedRepositoryRoot: vscode.Uri,
  candidateRepositoryRoot: vscode.Uri,
): void {
  assertRepositoryRoot(candidateRepositoryRoot);
  if (
    normalizeRepositoryPath(expectedRepositoryRoot.fsPath) !==
    normalizeRepositoryPath(candidateRepositoryRoot.fsPath)
  ) {
    throw new GitDiffRequestError(
      `Cross-repository diff source: '${candidateRepositoryRoot.fsPath}' is not '${expectedRepositoryRoot.fsPath}'.`,
    );
  }
}

function assertSameRepositoryPath(
  expectedRepositoryRootPath: string,
  candidateRepositoryRoot: vscode.Uri,
): void {
  assertRepositoryRoot(candidateRepositoryRoot);
  if (
    normalizeRepositoryPath(expectedRepositoryRootPath) !==
    normalizeRepositoryPath(candidateRepositoryRoot.fsPath)
  ) {
    throw new GitDiffRequestError(
      `Cross-repository diff source: '${candidateRepositoryRoot.fsPath}' is not '${expectedRepositoryRootPath}'.`,
    );
  }
}

function normalizeRepositoryPath(repositoryPath: string): string {
  const normalizedPath = nodePath.resolve(repositoryPath).replaceAll("\\", "/");
  return process.platform === "darwin"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function isPathWithinRepository(
  repositoryRootPath: string,
  candidatePath: string,
): boolean {
  if (
    !nodePath.isAbsolute(repositoryRootPath) ||
    !nodePath.isAbsolute(candidatePath)
  )
    return false;
  const relativePath = nodePath.relative(
    nodePath.resolve(repositoryRootPath),
    nodePath.resolve(candidatePath),
  );
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relativePath)
  );
}

function isPathWithinOrEqual(
  repositoryRootPath: string,
  candidatePath: string,
): boolean {
  if (
    !nodePath.isAbsolute(repositoryRootPath) ||
    !nodePath.isAbsolute(candidatePath)
  )
    return false;
  const relativePath = nodePath.relative(
    nodePath.resolve(repositoryRootPath),
    nodePath.resolve(candidatePath),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relativePath))
  );
}

function assertRevisionText(
  revision: string | undefined,
  fieldName: string,
): asserts revision is string {
  if (
    revision === undefined ||
    revision.trim().length === 0 ||
    revision !== revision.trim() ||
    revision.includes("\0") ||
    revision.startsWith("-")
  ) {
    throw new GitDiffRequestError(
      `${fieldName} must be a non-empty Git revision.`,
    );
  }
}

function assertParsedGitRecordPaths(record: ParsedFileRecord): void {
  for (const filePath of [
    record.oldPath,
    record.newPath,
    record.metadata.oldPath,
    record.metadata.newPath,
  ]) {
    if (filePath !== undefined) assertGitOutputPath(filePath);
  }
}

function assertGitOutputPath(filePath: string): void {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/");
  if (
    normalizedPath.length === 0 ||
    normalizedPath === "." ||
    normalizedPath.includes("\0") ||
    absolutePathPattern.test(normalizedPath) ||
    pathSegments.some(
      (pathSegment) => pathSegment === "." || pathSegment === "..",
    )
  ) {
    throw new GitDiffRequestError(
      `Git returned an unsafe file path: '${filePath}'.`,
    );
  }
}

function assertRelativeFilePath(filePath: string): void {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/");
  if (
    normalizedPath.length === 0 ||
    normalizedPath.includes("\0") ||
    absolutePathPattern.test(normalizedPath) ||
    pathSegments.some((pathSegment) => pathSegment === "..")
  ) {
    throw new GitDiffRequestError(
      `filePath must be relative to the repository: '${filePath}'.`,
    );
  }
}
