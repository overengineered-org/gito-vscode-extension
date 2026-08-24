const path = require("node:path");
const {
  normalizeRelativePath,
  relativePathWithinRepository,
} = require("./path-alias-helpers.cjs");

function parseGitOriginalPath(resourceUri) {
  if (resourceUri?.scheme !== "git" || typeof resourceUri.query !== "string")
    return undefined;

  const queryCandidates = [resourceUri.query];
  try {
    const decodedQuery = decodeURIComponent(resourceUri.query);
    if (decodedQuery !== resourceUri.query) queryCandidates.push(decodedQuery);
  } catch {
    // The raw query is still safe to inspect as JSON.
  }

  for (const queryCandidate of queryCandidates) {
    try {
      const queryObject = JSON.parse(queryCandidate);
      if (typeof queryObject?.path === "string") return queryObject.path;
    } catch {
      // Ignore non-JSON git URIs and keep searching for a valid representation.
    }
  }
  return undefined;
}

function gitOriginalRelativePath(resourceUri, repositoryRootPath) {
  const originalPath = parseGitOriginalPath(resourceUri);
  if (!path.isAbsolute(originalPath ?? "")) return undefined;
  const relativePath = relativePathWithinRepository(
    repositoryRootPath,
    originalPath,
  );
  if (
    relativePath === undefined ||
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  )
    return undefined;
  return normalizeRelativePath(relativePath);
}

function isNativeSnapshotUri(resourceUri) {
  return (
    resourceUri?.scheme === "file" &&
    path.isAbsolute(resourceUri.fsPath ?? resourceUri.path ?? "")
  );
}

module.exports = {
  gitOriginalRelativePath,
  isNativeSnapshotUri,
  parseGitOriginalPath,
};
