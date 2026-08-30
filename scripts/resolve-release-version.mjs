import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Bumper } from "conventional-recommended-bump";

export function calculateNextReleaseVersion(currentVersion, releaseType) {
  const versionParts = parseStableVersion(currentVersion);
  if (!versionParts) {
    throw new Error(`Current version is not stable semantic versioning: ${currentVersion}`);
  }

  const [majorVersion, minorVersion, patchVersion] = versionParts;
  switch (releaseType) {
    case "major":
      return `${majorVersion + 1}.0.0`;
    case "minor":
      return `${majorVersion}.${minorVersion + 1}.0`;
    case "patch":
      return `${majorVersion}.${minorVersion}.${patchVersion + 1}`;
    default:
      throw new Error(`Unsupported conventional release type: ${releaseType}`);
  }
}

export function selectReleaseBaselineVersion(manifestVersion, latestTagVersion) {
  const manifestVersionParts = parseStableVersion(manifestVersion);
  const latestTagVersionParts = parseStableVersion(latestTagVersion);
  if (!manifestVersionParts || !latestTagVersionParts) {
    throw new Error("Release baselines must use stable semantic versioning.");
  }

  for (let versionPartIndex = 0; versionPartIndex < manifestVersionParts.length; versionPartIndex += 1) {
    if (manifestVersionParts[versionPartIndex] !== latestTagVersionParts[versionPartIndex]) {
      return manifestVersionParts[versionPartIndex] > latestTagVersionParts[versionPartIndex]
        ? manifestVersion
        : latestTagVersion;
    }
  }
  return manifestVersion;
}

function parseStableVersion(stableVersion) {
  const parsedVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableVersion);
  return parsedVersion ? parsedVersion.slice(1).map(Number) : undefined;
}

export async function resolveReleaseVersion() {
  const extensionManifest = JSON.parse(readFileSync("package.json", "utf8"));
  let latestReleaseVersion = extensionManifest.version;
  try {
    const latestTagVersion = execFileSync(
      "git",
      ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .replace(/^v/, "");
    latestReleaseVersion = selectReleaseBaselineVersion(
      extensionManifest.version,
      latestTagVersion,
    );
  } catch {
    // The manifest version is the deliberate baseline before Git'o's first release tag.
  }

  const releaseRecommendation = await new Bumper().loadPreset("conventionalcommits").bump();
  if (!releaseRecommendation.releaseType) {
    throw new Error("Current main has no releasable conventional commits.");
  }

  return calculateNextReleaseVersion(latestReleaseVersion, releaseRecommendation.releaseType);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await resolveReleaseVersion());
}
