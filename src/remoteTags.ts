import { execFile } from "node:child_process";

import { type GitReference, GitReferenceType } from "./gitModel.ts";

const remoteTagLinePattern = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/tags\/(.+?)(\^\{\})?$/;

export async function listRemoteTagReferences(
  gitExecutablePath: string,
  gitEnvironment: Readonly<Record<string, string>>,
  repositoryRootPath: string,
  remoteName: string,
): Promise<readonly GitReference[]> {
  const remoteTagOutput = await executeGitLsRemote(
    gitExecutablePath,
    gitEnvironment,
    repositoryRootPath,
    remoteName,
  );
  return parseRemoteTagReferences(remoteTagOutput);
}

export function parseRemoteTagReferences(remoteTagOutput: string): readonly GitReference[] {
  const remoteTagsByName = new Map<string, GitReference>();
  for (const remoteTagLine of remoteTagOutput.split(/\r?\n/u)) {
    const remoteTagMatch = remoteTagLine.match(remoteTagLinePattern);
    const remoteTagCommit = remoteTagMatch?.[1];
    const remoteTagName = remoteTagMatch?.[2];
    if (remoteTagCommit === undefined || remoteTagName === undefined) {
      continue;
    }
    const isPeeledAnnotatedTag = remoteTagMatch?.[3] !== undefined;
    if (isPeeledAnnotatedTag || !remoteTagsByName.has(remoteTagName)) {
      remoteTagsByName.set(remoteTagName, {
        commit: remoteTagCommit,
        name: remoteTagName,
        type: GitReferenceType.tag,
      });
    }
  }
  return [...remoteTagsByName.values()].toSorted((firstTag, secondTag) =>
    (firstTag.name ?? "").localeCompare(secondTag.name ?? ""),
  );
}

function executeGitLsRemote(
  gitExecutablePath: string,
  gitEnvironment: Readonly<Record<string, string>>,
  repositoryRootPath: string,
  remoteName: string,
): Promise<string> {
  return new Promise((resolveRemoteTagOutput, rejectRemoteTagCheck) => {
    execFile(
      gitExecutablePath,
      // VS Code's getRemoteRefs omits peeled annotated-tag targets, so use its Git and auth env.
      ["ls-remote", "--tags", "--", remoteName],
      {
        cwd: repositoryRootPath,
        encoding: "utf8",
        env: { ...process.env, ...gitEnvironment, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 20_000,
      },
      (gitError, remoteTagOutput) => {
        if (gitError === null) {
          resolveRemoteTagOutput(remoteTagOutput);
          return;
        }
        rejectRemoteTagCheck(gitError);
      },
    );
  });
}
