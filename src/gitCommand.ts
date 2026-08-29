import { execFile } from "node:child_process";

export interface GitCommandContext {
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly repositoryPath: string;
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
