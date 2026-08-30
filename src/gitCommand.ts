import { execFile } from "node:child_process";

export interface GitCommandContext {
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly repositoryPath: string;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly standardError: string;
  readonly standardOutput: string;
}

export function runGitCommand(
  gitCommandContext: GitCommandContext,
  gitArguments: readonly string[],
  timeoutMilliseconds = 20_000,
): Promise<string> {
  return new Promise((resolveGitOutput, rejectGitCommand) => {
    execFile(
      gitCommandContext.executablePath,
      [...gitArguments],
      {
        cwd: gitCommandContext.repositoryPath,
        encoding: "utf8",
        env: {
          ...process.env,
          ...gitCommandContext.environment,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMilliseconds,
      },
      (gitCommandFailure, gitOutput) => {
        if (gitCommandFailure === null) {
          resolveGitOutput(gitOutput);
          return;
        }
        rejectGitCommand(gitCommandFailure);
      },
    );
  });
}

export function runGitCommandWithExitCode(
  gitCommandContext: GitCommandContext,
  gitArguments: readonly string[],
  timeoutMilliseconds = 20_000,
): Promise<GitCommandResult> {
  return new Promise((resolveGitResult, rejectGitCommand) => {
    execFile(
      gitCommandContext.executablePath,
      [...gitArguments],
      {
        cwd: gitCommandContext.repositoryPath,
        encoding: "utf8",
        env: {
          ...process.env,
          ...gitCommandContext.environment,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMilliseconds,
      },
      (gitCommandFailure, standardOutput, standardError) => {
        if (gitCommandFailure === null) {
          resolveGitResult({ exitCode: 0, standardError, standardOutput });
          return;
        }
        if (typeof gitCommandFailure.code === "number") {
          resolveGitResult({
            exitCode: gitCommandFailure.code,
            standardError,
            standardOutput,
          });
          return;
        }
        rejectGitCommand(gitCommandFailure);
      },
    );
  });
}
