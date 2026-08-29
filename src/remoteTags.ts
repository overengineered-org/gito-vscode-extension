import { runGitCommand } from "./gitCommand.ts";
import { type GitReference, GitReferenceType } from "./gitModel.ts";

const remoteTagLinePattern = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/tags\/(.+?)(\^\{\})?$/;

export async function listRemoteTagReferences(
  gitExecutablePath: string,
  gitEnvironment: Readonly<Record<string, string>>,
  repositoryRootPath: string,
  remoteName: string,
): Promise<readonly GitReference[]> {
  const remoteTagOutput = await runGitCommand(
    {
      environment: gitEnvironment,
      executablePath: gitExecutablePath,
      repositoryPath: repositoryRootPath,
    },
    // VS Code's getRemoteRefs omits peeled annotated-tag targets.
    ["ls-remote", "--tags", "--", remoteName],
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
