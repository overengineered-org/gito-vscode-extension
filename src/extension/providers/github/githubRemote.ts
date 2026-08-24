import type { CloudRepositoryIdentity } from "../../../domain/cloudGitProvider.js";
import { parseGitRemoteSyntax } from "../remoteSyntax.js";

const githubHost = "github.com";

function isValidRepositorySegment(repositorySegment: string): boolean {
  return (
    repositorySegment.length > 0 &&
    repositorySegment.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repositorySegment)
  );
}

function decodeRepositorySegment(
  repositorySegment: string,
): string | undefined {
  try {
    const decodedSegment = decodeURIComponent(repositorySegment);
    return isValidRepositorySegment(decodedSegment)
      ? decodedSegment
      : undefined;
  } catch {
    return undefined;
  }
}

function parseRepositoryPath(
  repositoryPath: string,
): Pick<CloudRepositoryIdentity, "owner" | "repositoryName"> | undefined {
  const pathSegments = repositoryPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");

  if (pathSegments.length !== 2) {
    return undefined;
  }

  const owner = decodeRepositorySegment(pathSegments[0] ?? "");
  const repositoryName = decodeRepositorySegment(pathSegments[1] ?? "");
  if (!owner || !repositoryName) {
    return undefined;
  }

  return { owner, repositoryName };
}

/** Parse only GitHub.com HTTPS and SSH remotes. */
export function parseGitHubRemote(
  remoteUrl: string,
): CloudRepositoryIdentity | undefined {
  const parsedRemote = parseGitRemoteSyntax(remoteUrl);
  if (
    parsedRemote === undefined ||
    parsedRemote.hostname.toLowerCase() !== githubHost
  )
    return undefined;
  if (
    parsedRemote.kind === "url" &&
    (parsedRemote.protocol === "ssh:" || parsedRemote.protocol === "git+ssh:")
  ) {
    if (
      parsedRemote.password.length > 0 ||
      parsedRemote.search.length > 0 ||
      parsedRemote.hash.length > 0
    )
      return undefined;
  } else if (
    parsedRemote.kind !== "scp" &&
    (parsedRemote.protocol !== "https:" ||
      parsedRemote.username.length > 0 ||
      parsedRemote.password.length > 0 ||
      parsedRemote.search.length > 0 ||
      parsedRemote.hash.length > 0)
  ) {
    return undefined;
  }

  const parsedRepository = parseRepositoryPath(parsedRemote.pathname);
  if (!parsedRepository) {
    return undefined;
  }

  return {
    providerId: "github",
    owner: parsedRepository.owner,
    repositoryName: parsedRepository.repositoryName,
  };
}

export const githubRemoteHost = githubHost;
