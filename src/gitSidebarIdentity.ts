export function createGitSidebarTreeItemId(
  repositoryRootPath: string,
  nodeKind: string,
  nodeIdentity?: string,
): string {
  return [repositoryRootPath, nodeKind, nodeIdentity]
    .filter((identityPart): identityPart is string => identityPart !== undefined)
    .map(encodeURIComponent)
    .join(":");
}
