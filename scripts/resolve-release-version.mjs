import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { gt, inc, prerelease, valid } from "semver";

const supportedReleaseIncrements = new Set(["major", "minor", "patch"]);

export function calculateNextReleaseVersion(
  manifestVersion,
  latestReleaseTagVersion,
  releaseIncrement,
) {
  requireStableVersion(manifestVersion, "Package version");
  if (latestReleaseTagVersion !== undefined) {
    requireStableVersion(latestReleaseTagVersion, "Latest release tag");
  }
  if (!supportedReleaseIncrements.has(releaseIncrement)) {
    throw new Error(`Unsupported release increment: ${releaseIncrement}`);
  }

  const releaseBaselineVersion =
    latestReleaseTagVersion !== undefined && gt(latestReleaseTagVersion, manifestVersion)
      ? latestReleaseTagVersion
      : manifestVersion;
  const nextReleaseVersion = inc(releaseBaselineVersion, releaseIncrement);
  if (nextReleaseVersion === null) {
    throw new Error(`Could not increment release baseline: ${releaseBaselineVersion}`);
  }
  return nextReleaseVersion;
}

export function findLatestReleaseTagVersion(repositoryPath = ".") {
  const releaseTagVersions = execFileSync(
    "git",
    ["-C", repositoryPath, "tag", "--list", "v[0-9]*"],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((releaseTagName) => releaseTagName.trim().replace(/^v/u, ""))
    .filter((releaseTagVersion) => isStableVersion(releaseTagVersion));

  return releaseTagVersions.reduce(
    (latestReleaseTagVersion, releaseTagVersion) =>
      latestReleaseTagVersion === undefined || gt(releaseTagVersion, latestReleaseTagVersion)
        ? releaseTagVersion
        : latestReleaseTagVersion,
    undefined,
  );
}

export function resolveReleaseVersion(releaseIncrement) {
  const extensionManifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (typeof extensionManifest.version !== "string") {
    throw new Error("package.json must contain a string version.");
  }
  return calculateNextReleaseVersion(
    extensionManifest.version,
    findLatestReleaseTagVersion(),
    releaseIncrement,
  );
}

function isStableVersion(releaseVersion) {
  return valid(releaseVersion) === releaseVersion && prerelease(releaseVersion) === null;
}

function requireStableVersion(releaseVersion, versionSource) {
  if (!isStableVersion(releaseVersion)) {
    throw new Error(`${versionSource} must use stable semantic versioning: ${releaseVersion}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releaseIncrement = process.argv[2];
  if (releaseIncrement === undefined || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/resolve-release-version.mjs <patch|minor|major>");
  }
  console.log(resolveReleaseVersion(releaseIncrement));
}
