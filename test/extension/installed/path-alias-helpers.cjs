const filesystem = require("node:fs");
const path = require("node:path");

function extractUriFilePath(resourceUri) {
  if (typeof resourceUri?.fsPath === "string") return resourceUri.fsPath;
  if (typeof resourceUri?.path === "string") return resourceUri.path;
  if (typeof resourceUri?.toString === "function")
    return resourceUri.toString();
  return undefined;
}

function normalizePath(filePath) {
  const pathText = String(filePath).replaceAll("\\", "/");
  const normalizedRootPath = path.parse(pathText).root.replaceAll("\\", "/");
  const pathWithoutTrailingSeparators = pathText.replace(/\/+$/u, "");
  const normalizedPath =
    pathWithoutTrailingSeparators === normalizedRootPath.replace(/\/+$/u, "")
      ? normalizedRootPath
      : pathWithoutTrailingSeparators;
  return process.platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function normalizeRelativePath(relativeFilePath) {
  return relativeFilePath.replaceAll("\\", "/");
}

/** Resolves existing symlink ancestors while preserving missing leaf paths. */
function canonicalizePathPreservingMissingLeaf(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath))
    return undefined;
  const absolutePath = path.resolve(filePath);
  let unresolvedPath = absolutePath;
  const missingPathSegments = [];
  while (true) {
    try {
      const realpath =
        filesystem.realpathSync.native ?? filesystem.realpathSync;
      return normalizePath(
        path.resolve(
          realpath(unresolvedPath),
          ...missingPathSegments.reverse(),
        ),
      );
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
        return undefined;
      try {
        if (filesystem.lstatSync(unresolvedPath).isSymbolicLink())
          return undefined;
      } catch {
        // Missing paths are handled by resolving their existing ancestors.
      }
      const parentPath = path.dirname(unresolvedPath);
      if (parentPath === unresolvedPath) return normalizePath(absolutePath);
      missingPathSegments.push(path.basename(unresolvedPath));
      unresolvedPath = parentPath;
    }
  }
}

function comparablePath(filePath) {
  return (
    canonicalizePathPreservingMissingLeaf(filePath) ?? normalizePath(filePath)
  );
}

function pathsRepresentSameLocation(leftPath, rightPath) {
  if (typeof leftPath !== "string" || typeof rightPath !== "string")
    return false;
  return comparablePath(leftPath) === comparablePath(rightPath);
}

function relativePathWithinRepository(repositoryRootPath, resourcePath) {
  if (
    typeof repositoryRootPath !== "string" ||
    typeof resourcePath !== "string"
  )
    return undefined;
  return normalizeRelativePath(
    path.relative(
      comparablePath(repositoryRootPath),
      comparablePath(resourcePath),
    ),
  );
}

function uriWithinRepository(resourceUri, repositoryRootPath) {
  const resourcePath = extractUriFilePath(resourceUri);
  if (resourcePath === undefined || typeof repositoryRootPath !== "string")
    return false;
  const canonicalRepositoryRootPath =
    canonicalizePathPreservingMissingLeaf(repositoryRootPath);
  const canonicalResourcePath =
    canonicalizePathPreservingMissingLeaf(resourcePath);
  if (
    canonicalRepositoryRootPath === undefined ||
    canonicalResourcePath === undefined
  )
    return false;
  const relativePath = normalizeRelativePath(
    path.relative(canonicalRepositoryRootPath, canonicalResourcePath),
  );
  return (
    relativePath !== undefined &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !path.isAbsolute(relativePath)
  );
}

module.exports = {
  canonicalizePathPreservingMissingLeaf,
  extractUriFilePath,
  normalizePath,
  normalizeRelativePath,
  pathsRepresentSameLocation,
  relativePathWithinRepository,
  uriWithinRepository,
};
