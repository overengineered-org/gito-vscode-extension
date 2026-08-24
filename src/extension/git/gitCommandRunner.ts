import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { constants as fsConstants, lstatSync, readFileSync } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import * as nodePath from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

type GitProcessLauncher = (
  command: string,
  argumentsPassed: string[],
  options: SpawnOptions,
) => ChildProcess;

interface GitRootDirectoryBinding {
  readonly cwdPath: string;
  readonly identity: GitRootBindingIdentity;
  readonly rootHandle?: FileHandle;
  readonly gitDirectoryHandle?: FileHandle;
  readonly commonDirectoryHandle?: FileHandle;
  readonly descriptorEnvironment?:
    GitDirectoryDescriptorEnvironment | undefined;
  close(): Promise<void>;
}

interface GitDirectoryDescriptorEnvironment {
  readonly pathPrefix: "/proc/self/fd" | "/dev/fd";
  readonly gitDirectoryFileDescriptor: number;
  readonly commonDirectoryFileDescriptor: number;
}

interface GitMetadataBinding {
  readonly exists: boolean;
  readonly device?: string;
  readonly inode?: string;
  readonly content?: string;
}

export interface GitDirectoryBindingIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface GitRootBindingIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly gitDirectory: GitDirectoryBindingIdentity;
  readonly commonDirectory: GitDirectoryBindingIdentity;
}

export const gitDirectoryResolutionTimeoutMilliseconds = 5_000;
export const gitDirectoryResolutionMaxBufferBytes = 16 * 1024;
export const gitCommandStandardErrorSafetyCapBytes = 64 * 1024;

export interface GitRootBindingResolutionOptions {
  readonly cancellationSignal?: AbortSignal | undefined;
  readonly timeoutMilliseconds?: number | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** Rejects a selected nested directory whose Git top-level differs. */
  readonly requireGitTopLevelMatch?: boolean | undefined;
  /** Exact executable used for Git-directory discovery. */
  readonly gitExecutablePath?: string | undefined;
  readonly executeGitDirectoryCommand?: GitDirectoryCommandExecutor | undefined;
}

export interface GitDirectoryCommandExecutionOptions {
  readonly cancellationSignal?: AbortSignal | undefined;
  readonly timeoutMilliseconds: number;
  readonly maxBufferBytes: number;
  readonly requireGitTopLevelMatch?: boolean | undefined;
  /** Exact executable used for Git-directory discovery. */
  readonly gitExecutablePath?: string | undefined;
}

export interface GitDirectoryCommandResult {
  readonly standardOutput: string;
  readonly standardError: string;
}

export type GitDirectoryCommandExecutor = (
  repositoryRoot: string,
  options: GitDirectoryCommandExecutionOptions,
) => Promise<GitDirectoryCommandResult>;

const executeFile = promisify(execFile);

export interface NodeGitCommandRunnerOptions {
  /** Injectable launcher used to exercise the root binding at spawn time. */
  readonly launchProcess?: GitProcessLauncher;
  /** Injectable platform for deterministic descriptor-boundary tests. */
  readonly platform?: NodeJS.Platform;
  /** Exact executable selected by VS Code's bundled Git extension. */
  readonly gitExecutablePath?: string;
  /** Resolves the exact executable selected by VS Code's bundled Git extension. */
  readonly gitExecutablePathResolver?:
    (() => Promise<string | undefined>) | undefined;
}

export interface GitCommandOutput {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: number;
  readonly standardErrorTruncated?: boolean;
  /** True when the child was stopped after reaching maxStandardOutputBytes. */
  readonly standardOutputTruncated?: boolean;
  /** Exact stdout bytes when a binary-safe caller requests them. */
  readonly standardOutputBytes?: Uint8Array;
}

export interface GitCommandRequest {
  readonly repositoryRoot: string;
  /** Exact executable selected by VS Code's bundled Git extension. */
  readonly gitExecutablePath?: string | undefined;
  /** Immutable repository identity required for execution-bound Git calls. */
  readonly rootBinding?: GitRootBindingIdentity | undefined;
  readonly arguments: readonly string[];
  readonly cancellationSignal?: AbortSignal | undefined;
  readonly collectStandardOutput?: boolean;
  /** Retain raw bytes only when a binary-safe consumer needs them. */
  readonly collectStandardOutputBytes?: boolean;
  /** Bounded output is retained in memory and the child is terminated at the cap. */
  readonly maxStandardOutputBytes?: number | undefined;
  /** Bounds retained stderr for failures and diagnostics. */
  readonly maxStandardErrorBytes?: number | undefined;
  /** Bounds the Git root/common-directory discovery command. */
  readonly gitRootResolutionTimeoutMilliseconds?: number | undefined;
  readonly standardInput?: Uint8Array | string | undefined;
  /** Prepends Git's global --literal-pathspecs option for path mutations. */
  readonly literalPathspecs?: boolean | undefined;
  /** Binds even read-only commands when they guard a following mutation. */
  readonly rootBindingRequired?: boolean | undefined;
}

export type GitCommandChunkHandler = (chunk: string) => void;

export interface GitCommandRunner {
  run(request: GitCommandRequest): Promise<GitCommandOutput>;
  runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: GitCommandChunkHandler,
  ): Promise<GitCommandOutput>;
}

export class GitCommandFailure extends Error {
  public constructor(
    public readonly argumentsPassed: readonly string[],
    public readonly standardError: string,
    public readonly exitCode: number,
    public readonly standardErrorTruncated = false,
  ) {
    super(formatGitCommandFailure(argumentsPassed, standardError, exitCode));
    this.name = "GitCommandFailure";
  }
}

/** Runs the Git executable without a shell and supports cancellation. */
export class NodeGitCommandRunner implements GitCommandRunner {
  private readonly launchProcess: GitProcessLauncher;
  private readonly platform: NodeJS.Platform;
  private readonly gitExecutablePath: string;
  private readonly gitExecutablePathResolver:
    (() => Promise<string | undefined>) | undefined;

  public constructor(options: NodeGitCommandRunnerOptions = {}) {
    this.launchProcess = options.launchProcess ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.gitExecutablePath = validateGitExecutablePath(
      options.gitExecutablePath ?? defaultGitExecutablePath,
    );
    this.gitExecutablePathResolver = options.gitExecutablePathResolver;
  }

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    return this.runStreaming(request, () => undefined);
  }

  public async runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: GitCommandChunkHandler,
  ): Promise<GitCommandOutput> {
    if (request.cancellationSignal?.aborted) {
      throw new DOMException("Git command cancelled", "AbortError");
    }
    const gitExecutablePath = await this.resolveGitExecutablePath(request);
    const rootDirectoryBinding =
      request.rootBinding !== undefined || requiresMutationRootBinding(request)
        ? await openGitRootDirectoryBinding(
            request.repositoryRoot,
            request.rootBinding,
            {
              cancellationSignal: request.cancellationSignal,
              timeoutMilliseconds: request.gitRootResolutionTimeoutMilliseconds,
              platform: this.platform,
              gitExecutablePath,
            },
          )
        : undefined;
    try {
      throwIfGitCommandCancelled(request.cancellationSignal);
      return await new Promise((resolve, reject) => {
        const processInvocation = buildGitProcessInvocation(
          request,
          rootDirectoryBinding,
          gitExecutablePath,
        );
        const processStdio: SpawnOptions["stdio"] =
          rootDirectoryBinding?.descriptorEnvironment === undefined
            ? ["pipe", "pipe", "pipe"]
            : [
                "pipe",
                "pipe",
                "pipe",
                rootDirectoryBinding.descriptorEnvironment
                  .gitDirectoryFileDescriptor,
                rootDirectoryBinding.descriptorEnvironment
                  .commonDirectoryFileDescriptor,
              ];
        const childProcess = this.launchProcess(
          processInvocation.command,
          processInvocation.argumentsPassed,
          {
            cwd: rootDirectoryBinding?.cwdPath ?? request.repositoryRoot,
            stdio: processStdio,
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
          },
        );

        // Unbounded text uses chunks until close; bounded text uses one byte
        // buffer. Never concatenate on each data event or retain both forms.
        const standardOutputChunks: string[] = [];
        const standardOutputByteChunks: Buffer[] = [];
        const collectStandardOutputBytes =
          request.collectStandardOutputBytes === true;
        let boundedTextOutputBytes =
          request.collectStandardOutput !== false &&
          !collectStandardOutputBytes &&
          request.maxStandardOutputBytes !== undefined
            ? Buffer.allocUnsafe(request.maxStandardOutputBytes)
            : undefined;
        let boundedTextOutputByteCount = 0;
        let settled = false;
        let standardOutputTruncated = false;
        let outputLimitTerminationRequested = false;
        let outputBytesSeen = 0;
        let cancellationRequested = false;
        let terminationTimer: NodeJS.Timeout | undefined;
        let standardOutputByteCount = 0;
        const maxStandardErrorBytes =
          request.maxStandardErrorBytes ??
          gitCommandStandardErrorSafetyCapBytes;
        const boundedStandardErrorBytes = Buffer.allocUnsafe(
          maxStandardErrorBytes,
        );
        let standardErrorByteCount = 0;
        let standardErrorTruncated = false;
        const standardOutputDecoder = new StringDecoder("utf8");

        const cancellationHandler = (): void => {
          if (settled) return;
          cancellationRequested = true;
          terminateChildProcessTree(childProcess);
          terminationTimer = setTimeout(() => {
            if (!settled) terminateChildProcessTree(childProcess, "SIGKILL");
          }, 1000);
        };

        const cleanupCancellation = (): void => {
          if (request.cancellationSignal !== undefined) {
            request.cancellationSignal.removeEventListener(
              "abort",
              cancellationHandler,
            );
          }
          if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        };

        const rejectIfNotSettled = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanupCancellation();
          reject(error);
        };

        childProcess.once("error", (error) => rejectIfNotSettled(error));
        childProcess.stdin!.on("error", (error: NodeJS.ErrnoException) => {
          // Git may close stdin immediately after consuming/rejecting input;
          // let the child close handler report its real exit status.
          if (error.code === "ERR_STREAM_WRITE_AFTER_END") return;
          if (error.code === "EPIPE") {
            setImmediate(() => {
              if (settled) return;
              if (request.cancellationSignal?.aborted === true) {
                cancellationRequested = true;
                return;
              }
              rejectIfNotSettled(error);
            });
            return;
          }
          rejectIfNotSettled(error);
        });
        childProcess.stdout!.on("data", (chunk: Buffer | string) => {
          const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const textChunk = standardOutputDecoder.write(rawChunk);
          const outputChunk =
            request.maxStandardOutputBytes === undefined
              ? textChunk
              : takeOutputPrefix(
                  textChunk,
                  request.maxStandardOutputBytes - outputBytesSeen,
                );
          if (request.collectStandardOutput !== false) {
            if (boundedTextOutputBytes === undefined) {
              standardOutputChunks.push(outputChunk);
            } else {
              const remainingBytes = Math.max(
                0,
                boundedTextOutputBytes.byteLength - boundedTextOutputByteCount,
              );
              if (remainingBytes > 0) {
                const copiedBytes = Math.min(
                  rawChunk.byteLength,
                  remainingBytes,
                );
                rawChunk.copy(
                  boundedTextOutputBytes,
                  boundedTextOutputByteCount,
                  0,
                  copiedBytes,
                );
                boundedTextOutputByteCount += copiedBytes;
              }
            }
          }
          const outputByteLimit = request.maxStandardOutputBytes;
          const remainingBytes =
            outputByteLimit === undefined
              ? rawChunk.byteLength
              : Math.max(0, outputByteLimit - standardOutputByteCount);
          if (collectStandardOutputBytes && remainingBytes > 0) {
            const outputBytes = rawChunk.subarray(0, remainingBytes);
            standardOutputByteChunks.push(outputBytes);
            standardOutputByteCount += outputBytes.byteLength;
          }
          if (outputChunk.length > 0) onStandardOutputChunk(outputChunk);
          outputBytesSeen += rawChunk.byteLength;
          if (
            request.maxStandardOutputBytes !== undefined &&
            outputBytesSeen >= request.maxStandardOutputBytes &&
            !outputLimitTerminationRequested
          ) {
            outputLimitTerminationRequested = true;
            standardOutputTruncated = true;
            terminateChildProcessTree(childProcess);
          }
        });
        childProcess.stderr!.on("data", (chunk: Buffer | string) => {
          const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remainingBytes = Math.max(
            0,
            maxStandardErrorBytes - standardErrorByteCount,
          );
          if (remainingBytes > 0) {
            const copiedBytes = Math.min(rawChunk.byteLength, remainingBytes);
            rawChunk.copy(
              boundedStandardErrorBytes,
              standardErrorByteCount,
              0,
              copiedBytes,
            );
            standardErrorByteCount += copiedBytes;
          }
          if (rawChunk.byteLength > remainingBytes)
            standardErrorTruncated = true;
        });
        childProcess.once("close", (exitCode, signal) => {
          if (settled) return;
          const trailingStandardOutput = standardOutputDecoder.end();
          if (!outputLimitTerminationRequested) {
            if (
              request.collectStandardOutput !== false &&
              boundedTextOutputBytes === undefined
            )
              standardOutputChunks.push(trailingStandardOutput);
            if (trailingStandardOutput.length > 0)
              onStandardOutputChunk(trailingStandardOutput);
          }
          const standardOutput =
            boundedTextOutputBytes === undefined
              ? standardOutputChunks.join("")
              : takeUtf8BytePrefix(
                  boundedTextOutputBytes.subarray(
                    0,
                    boundedTextOutputByteCount,
                  ),
                ).toString("utf8");
          const standardError = takeUtf8BytePrefix(
            boundedStandardErrorBytes.subarray(0, standardErrorByteCount),
          ).toString("utf8");
          boundedTextOutputBytes = undefined;
          boundedTextOutputByteCount = 0;
          // Release per-chunk strings before resolving. The returned aggregate
          // is the sole text owner; retaining both forms breaks the 64 MiB cap.
          standardOutputChunks.length = 0;
          const standardOutputBytes = !collectStandardOutputBytes
            ? undefined
            : Buffer.concat(standardOutputByteChunks, standardOutputByteCount);
          standardOutputByteChunks.length = 0;
          if (cancellationRequested) {
            settled = true;
            cleanupCancellation();
            reject(new DOMException("Git command cancelled", "AbortError"));
            return;
          }
          settled = true;
          cleanupCancellation();
          if (outputLimitTerminationRequested) {
            resolve({
              standardOutput,
              standardError,
              exitCode: 0,
              standardOutputTruncated,
              ...(standardErrorTruncated
                ? { standardErrorTruncated: true }
                : {}),
              ...(standardOutputBytes === undefined
                ? {}
                : { standardOutputBytes }),
            });
            return;
          }
          if (exitCode !== 0) {
            reject(
              new GitCommandFailure(
                request.arguments,
                standardError,
                exitCode ?? signalExitCode(signal),
                standardErrorTruncated,
              ),
            );
            return;
          }
          resolve({
            standardOutput,
            standardError,
            exitCode: 0,
            ...(standardErrorTruncated ? { standardErrorTruncated: true } : {}),
            ...(standardOutputBytes === undefined
              ? {}
              : { standardOutputBytes }),
          });
        });

        if (request.standardInput === undefined) childProcess.stdin!.end();
        else childProcess.stdin!.end(request.standardInput);

        if (request.cancellationSignal?.aborted) {
          cancellationHandler();
        } else {
          request.cancellationSignal?.addEventListener(
            "abort",
            cancellationHandler,
            { once: true },
          );
        }
      });
    } finally {
      await rootDirectoryBinding?.close();
    }
  }

  private async resolveGitExecutablePath(
    request: GitCommandRequest,
  ): Promise<string> {
    if (request.gitExecutablePath !== undefined) {
      return validateGitExecutablePath(request.gitExecutablePath);
    }
    const resolvedGitExecutablePath = await this.gitExecutablePathResolver?.();
    return validateGitExecutablePath(
      resolvedGitExecutablePath ?? this.gitExecutablePath,
    );
  }
}

export function validateGitExecutablePath(gitExecutablePath: string): string {
  const trimmedGitExecutablePath = gitExecutablePath.trim();
  if (trimmedGitExecutablePath.length === 0) {
    throw new Error("Git executable path must not be empty.");
  }
  // Do not use node:path.isAbsolute here: a Windows path must remain valid
  // when the resolver is exercised on a non-Windows host.
  const isPosixAbsolutePath = trimmedGitExecutablePath.startsWith("/");
  const isWindowsAbsolutePath = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(
    trimmedGitExecutablePath,
  );
  if (!isPosixAbsolutePath && !isWindowsAbsolutePath) {
    throw new Error("Git executable path must be absolute.");
  }
  if (trimmedGitExecutablePath !== gitExecutablePath) {
    throw new Error(
      "Git executable path must not have surrounding whitespace.",
    );
  }
  return gitExecutablePath;
}

function buildGitProcessInvocation(
  request: GitCommandRequest,
  binding: GitRootDirectoryBinding | undefined,
  gitExecutablePath: string,
): { readonly command: string; readonly argumentsPassed: string[] } {
  const gitArguments = [
    ...(request.literalPathspecs === true ? ["--literal-pathspecs"] : []),
    ...request.arguments,
  ];
  if (binding === undefined) {
    return { command: gitExecutablePath, argumentsPassed: gitArguments };
  }
  return {
    command: process.execPath,
    argumentsPassed: [
      "-e",
      ROOT_BOUND_GIT_WORKER_SOURCE,
      JSON.stringify({
        root: binding.identity,
        descriptorEnvironment:
          binding.descriptorEnvironment === undefined
            ? undefined
            : {
                pathPrefix: binding.descriptorEnvironment.pathPrefix,
                gitDirectoryFileDescriptor: 3,
                commonDirectoryFileDescriptor: 4,
              },
      }),
      gitExecutablePath,
      ...gitArguments,
    ],
  };
}

function requiresMutationRootBinding(request: GitCommandRequest): boolean {
  if (request.rootBindingRequired === true || request.literalPathspecs === true)
    return true;
  const gitArguments = request.arguments;
  let subcommandIndex = 0;
  while (subcommandIndex < gitArguments.length) {
    const argument = gitArguments[subcommandIndex];
    if (argument === "-c" || argument === "--config-env") {
      subcommandIndex += 2;
      continue;
    }
    if (argument?.startsWith("-")) {
      subcommandIndex += 1;
      continue;
    }
    break;
  }
  const subcommand = gitArguments[subcommandIndex];
  if (subcommand === "hash-object") {
    return gitArguments.includes("-w") || gitArguments.includes("--path");
  }
  if (subcommand === "worktree") {
    return gitArguments[subcommandIndex + 1] !== "list";
  }
  return subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-mailmap",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-parse",
  "show",
  "show-ref",
  "shortlog",
  "status",
  "verify-commit",
  "verify-pack",
  "worktree",
]);

async function openGitRootDirectoryBinding(
  repositoryRoot: string,
  expectedIdentity?: GitRootBindingIdentity,
  resolutionOptions: GitRootBindingResolutionOptions = {},
): Promise<GitRootDirectoryBinding> {
  const identity = await resolveGitRootBinding(
    repositoryRoot,
    expectedIdentity,
    resolutionOptions,
  );
  throwIfGitCommandCancelled(resolutionOptions.cancellationSignal);
  const descriptorEnvironment =
    identity.gitDirectory.canonicalPath === identity.canonicalPath
      ? undefined
      : getGitDirectoryDescriptorEnvironment(
          resolutionOptions.platform ?? process.platform,
        );
  const boundRepositoryRoot = identity.canonicalPath;
  const directoryOpenFlags = getDirectoryOpenFlags(
    resolutionOptions.platform ?? process.platform,
  );
  const rootHandle = await openBoundDirectory(
    boundRepositoryRoot,
    directoryOpenFlags,
  );
  let gitDirectoryHandle: FileHandle | undefined;
  let commonDirectoryHandle: FileHandle | undefined;
  try {
    gitDirectoryHandle = await openBoundDirectory(
      identity.gitDirectory.canonicalPath,
      directoryOpenFlags,
    );
    commonDirectoryHandle = await openBoundDirectory(
      identity.commonDirectory.canonicalPath,
      directoryOpenFlags,
    );
    await assertOpenDirectoryIdentity(rootHandle, identity, "Repository root");
    await assertOpenDirectoryIdentity(
      gitDirectoryHandle,
      identity.gitDirectory,
      "Git directory",
    );
    await assertOpenDirectoryIdentity(
      commonDirectoryHandle,
      identity.commonDirectory,
      "Git common directory",
    );
  } catch (error: unknown) {
    await closeDistinctHandles([
      commonDirectoryHandle,
      gitDirectoryHandle,
      rootHandle,
    ]);
    throw error;
  }
  return {
    cwdPath: boundRepositoryRoot,
    identity,
    rootHandle,
    gitDirectoryHandle,
    commonDirectoryHandle,
    descriptorEnvironment:
      descriptorEnvironment === undefined
        ? undefined
        : {
            ...descriptorEnvironment,
            gitDirectoryFileDescriptor: gitDirectoryHandle.fd,
            commonDirectoryFileDescriptor: commonDirectoryHandle.fd,
          },
    close: async (): Promise<void> => {
      let firstError: unknown;
      try {
        await assertOpenDirectoryIdentity(
          rootHandle,
          identity,
          "Repository root",
        );
        await assertOpenDirectoryIdentity(
          gitDirectoryHandle,
          identity.gitDirectory,
          "Git directory",
        );
        await assertOpenDirectoryIdentity(
          commonDirectoryHandle,
          identity.commonDirectory,
          "Git common directory",
        );
      } catch (error: unknown) {
        firstError = error;
      }
      try {
        await closeDistinctHandles([
          commonDirectoryHandle,
          gitDirectoryHandle,
          rootHandle,
        ]);
      } catch (error: unknown) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw asError(firstError);
    },
  };
}

export async function resolveGitRootBinding(
  repositoryRoot: string,
  expectedIdentity?: GitRootBindingIdentity,
  resolutionOptions: GitRootBindingResolutionOptions = {},
): Promise<GitRootBindingIdentity> {
  throwIfGitCommandCancelled(resolutionOptions.cancellationSignal);
  const canonicalPath = await realpath(repositoryRoot);
  if (
    expectedIdentity !== undefined &&
    canonicalPath !== expectedIdentity.canonicalPath
  )
    throw new Error("Repository root path changed before Git execution.");
  const rootStats = await stat(canonicalPath, { bigint: true });
  if (!rootStats.isDirectory())
    throw new Error("Repository root is not a directory.");
  const rootIdentity = {
    canonicalPath,
    device: String(rootStats.dev),
    inode: String(rootStats.ino),
  } satisfies GitDirectoryBindingIdentity;
  const gitDirectoryPaths = await resolveGitDirectoryPaths(
    canonicalPath,
    resolutionOptions,
  );
  if (
    resolutionOptions.requireGitTopLevelMatch === true &&
    gitDirectoryPaths.gitTopLevelPath !== canonicalPath
  ) {
    throw new Error(
      "Selected repository directory does not match Git's top-level directory.",
    );
  }
  throwIfGitCommandCancelled(resolutionOptions.cancellationSignal);
  const currentRootStats = await stat(canonicalPath, { bigint: true });
  if (
    String(currentRootStats.dev) !== rootIdentity.device ||
    String(currentRootStats.ino) !== rootIdentity.inode
  )
    throw new Error("Repository root identity changed during Git resolution.");
  const gitDirectory = await resolveDirectoryBindingIdentity(
    gitDirectoryPaths.gitDirectory,
    rootIdentity,
  );
  const commonDirectory = await resolveDirectoryBindingIdentity(
    gitDirectoryPaths.commonDirectory,
    rootIdentity,
  );
  const identity = {
    ...rootIdentity,
    gitDirectory,
    commonDirectory,
  } satisfies GitRootBindingIdentity;
  if (
    expectedIdentity !== undefined &&
    (identity.device !== expectedIdentity.device ||
      identity.inode !== expectedIdentity.inode)
  )
    throw new Error("Repository root identity changed before execution.");
  if (
    expectedIdentity !== undefined &&
    (!sameDirectoryBindingIdentity(
      identity.gitDirectory,
      expectedIdentity.gitDirectory,
    ) ||
      !sameDirectoryBindingIdentity(
        identity.commonDirectory,
        expectedIdentity.commonDirectory,
      ))
  )
    throw new Error(
      "Repository Git-directory identity changed before execution.",
    );
  return identity;
}

async function resolveGitDirectoryPaths(
  canonicalRootPath: string,
  resolutionOptions: GitRootBindingResolutionOptions,
): Promise<{
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly gitTopLevelPath?: string;
}> {
  const metadataBinding = captureGitMetadataBinding(canonicalRootPath);
  try {
    const executeGitDirectoryCommand =
      resolutionOptions.executeGitDirectoryCommand ??
      defaultGitDirectoryCommandExecutor;
    const commandOutput = await runGitDirectoryCommandWithGuards(
      executeGitDirectoryCommand,
      canonicalRootPath,
      resolutionOptions,
    );
    assertGitMetadataBinding(canonicalRootPath, metadataBinding);
    const stdoutText: string = commandOutput.standardOutput;
    const [gitDirectoryPath, commonDirectoryPath, gitTopLevelPath] = stdoutText
      .trim()
      .split(/\r?\n/);
    if (gitDirectoryPath === undefined || commonDirectoryPath === undefined)
      throw new Error("Git did not return both directory bindings.");
    if (
      resolutionOptions.requireGitTopLevelMatch === true &&
      gitTopLevelPath === undefined
    )
      throw new Error("Git did not return its top-level directory.");
    return {
      gitDirectory: await realpath(
        resolveGitPath(canonicalRootPath, gitDirectoryPath),
      ),
      commonDirectory: await realpath(
        resolveGitPath(canonicalRootPath, commonDirectoryPath),
      ),
      ...(gitTopLevelPath === undefined
        ? {}
        : {
            gitTopLevelPath: await realpath(
              resolveGitPath(canonicalRootPath, gitTopLevelPath),
            ),
          }),
    };
  } catch (error: unknown) {
    assertGitMetadataBinding(canonicalRootPath, metadataBinding);
    if (isGitDirectoryResolutionAbort(error))
      throw createGitCommandAbortError();
    if (isGitDirectoryResolutionLimit(error))
      throw new Error(
        "Git directory resolution exceeded its bounded output limit.",
      );
    if (isGitDirectoryResolutionTimeout(error))
      throw new Error("Git directory resolution timed out.");
    if (
      process.env.GIT_DIR !== undefined ||
      process.env.GIT_COMMON_DIR !== undefined
    )
      throw error;
    if (resolutionOptions.requireGitTopLevelMatch === true) throw error;
    if (hasNonstandardGitMetadataEntry(canonicalRootPath)) throw error;
    return {
      gitDirectory: canonicalRootPath,
      commonDirectory: canonicalRootPath,
    };
  }
}

function captureGitMetadataBinding(
  canonicalRootPath: string,
): GitMetadataBinding {
  try {
    const metadataPath = nodePath.join(canonicalRootPath, ".git");
    const metadataStats = lstatSync(metadataPath, { bigint: true });
    if (metadataStats.isFile() && metadataStats.size > 4096n)
      throw new Error("Git metadata file exceeds the safe binding limit.");
    return {
      exists: true,
      device: String(metadataStats.dev),
      inode: String(metadataStats.ino),
      ...(metadataStats.isFile()
        ? { content: readFileSync(metadataPath, "utf8") }
        : {}),
    };
  } catch (error: unknown) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function assertGitMetadataBinding(
  canonicalRootPath: string,
  expectedBinding: GitMetadataBinding,
): void {
  const currentBinding = captureGitMetadataBinding(canonicalRootPath);
  if (
    currentBinding.exists !== expectedBinding.exists ||
    currentBinding.device !== expectedBinding.device ||
    currentBinding.inode !== expectedBinding.inode ||
    currentBinding.content !== expectedBinding.content
  ) {
    throw new Error("Git metadata changed during Git directory resolution.");
  }
}

function hasNonstandardGitMetadataEntry(canonicalRootPath: string): boolean {
  try {
    const gitMetadataStats = lstatSync(
      nodePath.join(canonicalRootPath, ".git"),
    );
    return !gitMetadataStats.isDirectory() || gitMetadataStats.isSymbolicLink();
  } catch (error: unknown) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code === "ENOENT") return false;
    throw error;
  }
}

// Production composition injects VS Code's exact bundled path. This absolute
// POSIX default keeps direct runner use deterministic without PATH lookup.
const defaultGitExecutablePath =
  process.platform === "win32"
    ? "C:\\Program Files\\Git\\cmd\\git.exe"
    : "/usr/bin/git";

const defaultGitDirectoryCommandExecutor: GitDirectoryCommandExecutor = async (
  canonicalRootPath,
  executionOptions,
) => {
  const rootDiscoveryArguments = ["rev-parse", "--git-dir", "--git-common-dir"];
  if (executionOptions.requireGitTopLevelMatch === true)
    rootDiscoveryArguments.push("--show-toplevel");
  const commandOutput = await executeFile(
    validateGitExecutablePath(
      executionOptions.gitExecutablePath ?? defaultGitExecutablePath,
    ),
    rootDiscoveryArguments,
    {
      cwd: canonicalRootPath,
      encoding: "utf8",
      maxBuffer: executionOptions.maxBufferBytes,
      signal: executionOptions.cancellationSignal,
      timeout: executionOptions.timeoutMilliseconds,
      windowsHide: true,
    },
  );
  return {
    standardOutput: String(commandOutput.stdout),
    standardError: String(commandOutput.stderr),
  };
};

async function runGitDirectoryCommandWithGuards(
  executeGitDirectoryCommand: GitDirectoryCommandExecutor,
  canonicalRootPath: string,
  resolutionOptions: GitRootBindingResolutionOptions,
): Promise<GitDirectoryCommandResult> {
  const timeoutMilliseconds =
    resolutionOptions.timeoutMilliseconds ??
    gitDirectoryResolutionTimeoutMilliseconds;
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0)
    throw new Error("Git directory resolution timeout is invalid.");
  throwIfGitCommandCancelled(resolutionOptions.cancellationSignal);
  let timeoutHandle: NodeJS.Timeout | undefined;
  let cancellationHandler: (() => void) | undefined;
  const guardedResult = new Promise<GitDirectoryCommandResult>(
    (resolve, reject) => {
      const settle = (settlement: () => void): void => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (cancellationHandler !== undefined)
          resolutionOptions.cancellationSignal?.removeEventListener(
            "abort",
            cancellationHandler,
          );
        settlement();
      };
      cancellationHandler = () =>
        settle(() => reject(createGitCommandAbortError()));
      if (resolutionOptions.cancellationSignal !== undefined)
        resolutionOptions.cancellationSignal.addEventListener(
          "abort",
          cancellationHandler,
          { once: true },
        );
      timeoutHandle = setTimeout(
        () => settle(() => reject(new GitDirectoryResolutionTimeoutError())),
        timeoutMilliseconds,
      );
      void executeGitDirectoryCommand(canonicalRootPath, {
        cancellationSignal: resolutionOptions.cancellationSignal,
        timeoutMilliseconds,
        maxBufferBytes: gitDirectoryResolutionMaxBufferBytes,
        requireGitTopLevelMatch:
          resolutionOptions.requireGitTopLevelMatch === true,
        gitExecutablePath:
          resolutionOptions.gitExecutablePath === undefined
            ? undefined
            : validateGitExecutablePath(resolutionOptions.gitExecutablePath),
      }).then(
        (result) => {
          if (
            Buffer.byteLength(result.standardOutput) +
              Buffer.byteLength(result.standardError) >
            gitDirectoryResolutionMaxBufferBytes
          ) {
            settle(() => reject(new GitDirectoryResolutionLimitError()));
            return;
          }
          settle(() => resolve(result));
        },
        (error: unknown) =>
          settle(() =>
            reject(error instanceof Error ? error : new Error(String(error))),
          ),
      );
    },
  );
  return guardedResult;
}

class GitDirectoryResolutionTimeoutError extends Error {
  public constructor() {
    super("Git directory resolution timed out.");
    this.name = "GitDirectoryResolutionTimeoutError";
  }
}

class GitDirectoryResolutionLimitError extends Error {
  public constructor() {
    super("Git directory resolution exceeded its bounded output limit.");
    this.name = "GitDirectoryResolutionLimitError";
  }
}

function isGitDirectoryResolutionAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

function isGitDirectoryResolutionLimit(error: unknown): boolean {
  return (
    error instanceof GitDirectoryResolutionLimitError ||
    (error instanceof Error &&
      (error as NodeJS.ErrnoException).code ===
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
  );
}

function isGitDirectoryResolutionTimeout(error: unknown): boolean {
  return (
    error instanceof GitDirectoryResolutionTimeoutError ||
    (error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT")
  );
}

function createGitCommandAbortError(): DOMException {
  return new DOMException("Git command cancelled", "AbortError");
}

function throwIfGitCommandCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createGitCommandAbortError();
}

async function resolveDirectoryBindingIdentity(
  directoryPath: string,
  fallbackIdentity: GitDirectoryBindingIdentity,
): Promise<GitDirectoryBindingIdentity> {
  try {
    const directoryStats = await stat(directoryPath, { bigint: true });
    if (!directoryStats.isDirectory()) throw new Error("Not a directory.");
    return {
      canonicalPath: directoryPath,
      device: String(directoryStats.dev),
      inode: String(directoryStats.ino),
    };
  } catch (error: unknown) {
    if (directoryPath === fallbackIdentity.canonicalPath)
      return fallbackIdentity;
    throw error;
  }
}

function sameDirectoryBindingIdentity(
  leftIdentity: GitDirectoryBindingIdentity,
  rightIdentity: GitDirectoryBindingIdentity,
): boolean {
  return (
    leftIdentity.canonicalPath === rightIdentity.canonicalPath &&
    leftIdentity.device === rightIdentity.device &&
    leftIdentity.inode === rightIdentity.inode
  );
}

function resolveGitPath(repositoryRoot: string, gitPath: string): string {
  return nodePath.isAbsolute(gitPath)
    ? gitPath
    : nodePath.resolve(repositoryRoot, gitPath);
}

function getDirectoryOpenFlags(
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform === "win32") return fsConstants.O_RDONLY;
  if (platform !== "linux" && platform !== "darwin")
    throw new Error(
      `Root-bound Git execution is unavailable on ${platform}; no mutation was attempted.`,
    );
  const requiredFlags =
    (fsConstants as { readonly O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  const noFollowFlag =
    (fsConstants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  if (requiredFlags === 0 || noFollowFlag === 0)
    throw new Error(
      "Root-bound Git execution is unavailable without directory no-follow support; no mutation was attempted.",
    );
  return fsConstants.O_RDONLY | requiredFlags | noFollowFlag;
}

export interface GitDirectoryDescriptorPaths {
  readonly pathPrefix: "/proc/self/fd" | "/dev/fd";
}

export function getGitDirectoryDescriptorPaths(
  platform: NodeJS.Platform,
): GitDirectoryDescriptorPaths | undefined {
  if (platform === "linux") return { pathPrefix: "/proc/self/fd" };
  // Darwin exposes directory fds through /dev/fd, but Git cannot traverse
  // them reliably (for example, /dev/fd/3/.git may be ENOENT/ENOTDIR).
  // Darwin and Windows therefore use canonical paths plus pre/post identity
  // checks. Linked worktrees remain supported; a same-user replacement in the
  // narrow interval between those checks remains outside this boundary.
  return undefined;
}

function getGitDirectoryDescriptorEnvironment(
  platform: NodeJS.Platform,
): GitDirectoryDescriptorEnvironment | undefined {
  const descriptorPaths = getGitDirectoryDescriptorPaths(platform);
  if (descriptorPaths === undefined) return undefined;
  return {
    ...descriptorPaths,
    gitDirectoryFileDescriptor: -1,
    commonDirectoryFileDescriptor: -1,
  };
}

async function openBoundDirectory(
  directoryPath: string,
  openFlags: number,
): Promise<FileHandle> {
  if (process.platform === "win32") {
    const rootStats = lstatSync(directoryPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
      throw new Error(
        "Root-bound Git execution requires a stable non-symlink directory; no mutation was attempted.",
      );
  }
  return open(directoryPath, openFlags);
}

async function assertOpenDirectoryIdentity(
  directoryHandle: FileHandle | undefined,
  expectedIdentity: GitDirectoryBindingIdentity,
  label: string,
): Promise<void> {
  if (directoryHandle === undefined)
    throw new Error(`${label} binding is unavailable.`);
  const directoryStats = await directoryHandle.stat({ bigint: true });
  if (
    String(directoryStats.dev) !== expectedIdentity.device ||
    String(directoryStats.ino) !== expectedIdentity.inode
  )
    throw new Error(`${label} identity changed before Git execution.`);
}

async function closeDistinctHandles(
  handles: readonly (FileHandle | undefined)[],
): Promise<void> {
  const closedHandles = new Set<FileHandle>();
  for (const handle of handles) {
    if (handle === undefined || closedHandles.has(handle)) continue;
    closedHandles.add(handle);
    await handle.close();
  }
}

export async function withGitRootBinding<T>(
  repositoryRoot: string,
  expectedIdentity: GitRootBindingIdentity | undefined,
  operation: () => Promise<T>,
  resolutionOptions: GitRootBindingResolutionOptions = {},
): Promise<T> {
  const binding = await openGitRootDirectoryBinding(
    repositoryRoot,
    expectedIdentity,
    resolutionOptions,
  );
  let operationCompleted = false;
  let operationResult!: T;
  let operationError: unknown;
  try {
    operationResult = await operation();
    operationCompleted = true;
  } catch (error: unknown) {
    operationError = error;
  }
  let bindingValidationError: unknown;
  try {
    await resolveGitRootBinding(
      repositoryRoot,
      expectedIdentity,
      resolutionOptions,
    );
  } catch (error: unknown) {
    bindingValidationError = error;
  }
  try {
    await binding.close();
  } catch (error: unknown) {
    bindingValidationError ??= error;
  }
  if (bindingValidationError !== undefined)
    throw asError(bindingValidationError);
  if (!operationCompleted) throw asError(operationError);
  return operationResult;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const ROOT_BOUND_GIT_WORKER_SOURCE = `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const expectedBinding = JSON.parse(process.argv[1]);
const command = process.argv[2];
const commandArguments = process.argv.slice(3);
const descriptorEnvironment = expectedBinding.descriptorEnvironment;
const sameIdentity = (directoryPath, expectedIdentity) => {
  const currentStats = fs.statSync(directoryPath, { bigint: true });
  return (currentStats.mode & 0o170000n) === 0o040000n &&
    String(currentStats.dev) === expectedIdentity.device &&
    String(currentStats.ino) === expectedIdentity.inode;
};
const sameDescriptorIdentity = (fileDescriptor, expectedIdentity) => {
  const currentStats = fs.fstatSync(fileDescriptor, { bigint: true });
  return (currentStats.mode & 0o170000n) === 0o040000n &&
    String(currentStats.dev) === expectedIdentity.device &&
    String(currentStats.ino) === expectedIdentity.inode;
};
const assertBinding = () => {
  if (!sameIdentity(".", expectedBinding.root))
    throw new Error("Repository root changed before Git started.");
  if (!sameIdentity(expectedBinding.root.gitDirectory.canonicalPath, expectedBinding.root.gitDirectory))
    throw new Error("Git directory changed before Git execution.");
  if (!sameIdentity(expectedBinding.root.commonDirectory.canonicalPath, expectedBinding.root.commonDirectory))
    throw new Error("Git common directory changed before Git execution.");
  if (descriptorEnvironment !== undefined) {
    if (!sameDescriptorIdentity(3, expectedBinding.root.gitDirectory) ||
        !sameDescriptorIdentity(4, expectedBinding.root.commonDirectory))
      throw new Error("Git directory descriptor identity changed before Git execution.");
  }
};
try {
  assertBinding();
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
  process.exit(125);
}
const childEnvironment = { ...process.env };
if (descriptorEnvironment !== undefined) {
  childEnvironment.GIT_DIR = descriptorEnvironment.pathPrefix + "/" + descriptorEnvironment.gitDirectoryFileDescriptor;
  childEnvironment.GIT_COMMON_DIR = descriptorEnvironment.pathPrefix + "/" + descriptorEnvironment.commonDirectoryFileDescriptor;
} else if (expectedBinding.root.gitDirectory.canonicalPath !== expectedBinding.root.canonicalPath ||
           process.env.GIT_DIR !== undefined || process.env.GIT_COMMON_DIR !== undefined) {
  childEnvironment.GIT_DIR = expectedBinding.root.gitDirectory.canonicalPath;
  childEnvironment.GIT_COMMON_DIR = expectedBinding.root.commonDirectory.canonicalPath;
}
const childStdio = descriptorEnvironment === undefined
  ? ["pipe", "pipe", "pipe"]
  : ["pipe", "pipe", "pipe", "inherit", "inherit"];
const gitProcess = childProcess.spawn(command, commandArguments, {
  shell: false,
  stdio: childStdio,
  detached: false,
  windowsHide: true,
  env: childEnvironment,
});
process.stdin.pipe(gitProcess.stdin);
gitProcess.stdout.pipe(process.stdout);
gitProcess.stderr.pipe(process.stderr);
gitProcess.once("error", (error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
  process.exitCode = 125;
});
gitProcess.once("close", (exitCode, signal) => {
  try {
    assertBinding();
  } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
    process.exitCode = 125;
    return;
  }
  process.exitCode = exitCode ?? (signal === null ? 1 : 128);
});
`;

function terminateChildProcessTree(
  childProcess: import("node:child_process").ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (childProcess.pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-childProcess.pid, signal);
      return;
    }
  } catch {
    // The process may have already exited or process groups may be unavailable.
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(childProcess.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through when taskkill is unavailable.
    }
  }
  try {
    childProcess.kill(signal);
  } catch {
    // The process may have already exited.
  }
}

function takeOutputPrefix(outputChunk: string, remainingBytes: number): string {
  if (remainingBytes <= 0) return "";
  if (Buffer.byteLength(outputChunk) <= remainingBytes) return outputChunk;
  let prefix = "";
  let usedBytes = 0;
  for (const character of outputChunk) {
    const characterBytes = Buffer.byteLength(character);
    if (usedBytes + characterBytes > remainingBytes) break;
    prefix += character;
    usedBytes += characterBytes;
  }
  return prefix;
}

function takeUtf8BytePrefix(outputBytes: Buffer): Buffer {
  let validByteCount = outputBytes.byteLength;
  let continuationByteCount = 0;
  let byteIndex = validByteCount - 1;
  while (byteIndex >= 0) {
    const currentByte = outputBytes[byteIndex] ?? 0;
    if ((currentByte & 0b1100_0000) !== 0b1000_0000) break;
    continuationByteCount += 1;
    byteIndex -= 1;
  }
  if (continuationByteCount === 0) {
    const trailingByte = outputBytes[validByteCount - 1] ?? 0;
    if (trailingByte >= 0xc2 && trailingByte <= 0xf4)
      return outputBytes.subarray(0, validByteCount - 1);
    return outputBytes;
  }
  const leadByte = outputBytes[validByteCount - continuationByteCount - 1];
  if (leadByte === undefined) return outputBytes;
  const expectedByteCount =
    leadByte < 0x80 ? 1 : leadByte < 0xe0 ? 2 : leadByte < 0xf0 ? 3 : 4;
  if (continuationByteCount + 1 < expectedByteCount) {
    validByteCount -= continuationByteCount + 1;
  }
  return outputBytes.subarray(0, validByteCount);
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal === null ? 1 : 128;
}

function formatGitCommandFailure(
  argumentsPassed: readonly string[],
  standardError: string,
  exitCode: number,
): string {
  const commandText = ["git", ...argumentsPassed]
    .map((argument) => quoteGitArgument(argument))
    .join(" ");
  const trimmedError = standardError.trim();
  return trimmedError.length === 0
    ? `${commandText} exited with code ${exitCode}.`
    : `${commandText} exited with code ${exitCode}: ${trimmedError}`;
}

function quoteGitArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
