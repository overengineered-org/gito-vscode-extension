export interface ParsedGitRemoteSyntax {
  readonly kind: "scp" | "url";
  readonly protocol: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
}

/**
 * Parses Git's two transport syntaxes without deciding which provider owns it.
 * Provider parsers remain responsible for host, protocol, and path validation.
 */
export function parseGitRemoteSyntax(
  remoteUrl: string,
): ParsedGitRemoteSyntax | undefined {
  const normalizedRemoteUrl = remoteUrl.trim();
  if (normalizedRemoteUrl.length === 0 || /[\r\n]/u.test(normalizedRemoteUrl))
    return undefined;

  const scpStyleRemoteMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(
    normalizedRemoteUrl,
  )
    ? undefined
    : /^(?:([^@/:]+)@)?([^/:]+):(.+)$/u.exec(normalizedRemoteUrl);
  if (scpStyleRemoteMatch !== undefined && scpStyleRemoteMatch !== null) {
    const [, username = "", hostname = "", remotePath = ""] =
      scpStyleRemoteMatch;
    return {
      kind: "scp",
      protocol: "scp:",
      hostname,
      pathname: `/${remotePath}`,
      username,
      password: "",
      search: "",
      hash: "",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedRemoteUrl);
  } catch {
    return undefined;
  }
  return {
    kind: "url",
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    pathname: parsedUrl.pathname,
    username: parsedUrl.username,
    password: parsedUrl.password,
    search: parsedUrl.search,
    hash: parsedUrl.hash,
  };
}
