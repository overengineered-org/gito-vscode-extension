import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import JSZip from "jszip";

const [releaseVersion, replacementOption] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(releaseVersion ?? "")) {
  throw new Error(`Invalid release version: ${releaseVersion}`);
}
if (replacementOption !== undefined && replacementOption !== "--replace-source") {
  throw new Error(`Unknown release packaging option: ${replacementOption}`);
}

const replaceSourcePackage = replacementOption === "--replace-source";
const releaseDistributionDirectory = resolve("dist");
const releasePackageName = `gito-${releaseVersion}.vsix`;
const releasePackagePath = resolve(releaseDistributionDirectory, releasePackageName);
const sourcePackageFileNames = existsSync(releaseDistributionDirectory)
  ? readdirSync(releaseDistributionDirectory).filter(
      (fileName) => fileName.endsWith(".vsix") && fileName !== releasePackageName,
    )
  : [];
if (sourcePackageFileNames.length !== 1) {
  throw new Error(
    `Expected exactly one source VSIX in ${releaseDistributionDirectory}, found ${sourcePackageFileNames.length}`,
  );
}

const sourcePackagePath = resolve(releaseDistributionDirectory, sourcePackageFileNames[0]);
const sourcePackageArchive = await JSZip.loadAsync(readFileSync(sourcePackagePath));
const packagedExtensionManifestEntry = sourcePackageArchive.file("extension/package.json");
const vsixManifestEntry = sourcePackageArchive.file("extension.vsixmanifest");
if (!packagedExtensionManifestEntry || !vsixManifestEntry) {
  throw new Error(`${basename(sourcePackagePath)} is missing required extension manifests`);
}

const packagedExtensionManifest = JSON.parse(await packagedExtensionManifestEntry.async("string"));
packagedExtensionManifest.version = releaseVersion;
sourcePackageArchive.file(
  "extension/package.json",
  `${JSON.stringify(packagedExtensionManifest, null, 2)}\n`,
);

const sourceVsixManifest = await vsixManifestEntry.async("string");
const versionedVsixManifest = sourceVsixManifest.replace(
  /(<Identity\b[^>]*\bVersion=")[^"]+("[^>]*>)/,
  (_identityElement, identityPrefix, identitySuffix) =>
    `${identityPrefix}${releaseVersion}${identitySuffix}`,
);
if (versionedVsixManifest === sourceVsixManifest) {
  throw new Error(`${basename(sourcePackagePath)} does not contain a versioned VSIX identity`);
}
sourcePackageArchive.file("extension.vsixmanifest", versionedVsixManifest);

const releasePackageBytes = await sourcePackageArchive.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
const releaseStagingDirectory = mkdtempSync(resolve(releaseDistributionDirectory, ".gito-release-"));
const stagedReleasePackagePath = resolve(releaseStagingDirectory, releasePackageName);
try {
  writeFileSync(stagedReleasePackagePath, releasePackageBytes);
  renameSync(stagedReleasePackagePath, releasePackagePath);
} finally {
  rmSync(releaseStagingDirectory, { force: true, recursive: true });
}

const releasePackageDigest = createHash("sha256").update(releasePackageBytes).digest("hex");
const releaseChecksumPath = `${releasePackagePath}.sha256`;
writeFileSync(releaseChecksumPath, `${releasePackageDigest}  ${releasePackageName}\n`, "utf8");

if (replaceSourcePackage) {
  rmSync(sourcePackagePath, { force: true });
}

console.log(`Created ${releasePackageName} (${releasePackageDigest}).`);
