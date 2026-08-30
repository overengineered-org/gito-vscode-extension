import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import JSZip from "jszip";

const releaseVersion = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(releaseVersion ?? "")) {
  throw new Error(`Invalid release version: ${releaseVersion}`);
}

const releasePackageName = `gito-${releaseVersion}.vsix`;
const releasePackagePath = resolve("dist", releasePackageName);
const releaseChecksumPath = `${releasePackagePath}.sha256`;
for (const requiredReleaseFilePath of [releasePackagePath, releaseChecksumPath]) {
  if (!existsSync(requiredReleaseFilePath)) {
    throw new Error(`Required release file not found: ${requiredReleaseFilePath}`);
  }
}

const releasePackageBytes = readFileSync(releasePackagePath);
const releasePackageDigest = createHash("sha256").update(releasePackageBytes).digest("hex");
const expectedChecksumFileContents = `${releasePackageDigest}  ${basename(releasePackagePath)}\n`;
if (readFileSync(releaseChecksumPath, "utf8") !== expectedChecksumFileContents) {
  throw new Error(`Release checksum does not match ${releasePackageName}`);
}

const releaseArchive = await JSZip.loadAsync(releasePackageBytes);
const packagedExtensionManifestEntry = releaseArchive.file("extension/package.json");
const vsixManifestEntry = releaseArchive.file("extension.vsixmanifest");
if (!packagedExtensionManifestEntry || !vsixManifestEntry) {
  throw new Error(`${releasePackageName} does not contain required extension manifests`);
}

const packagedExtensionManifest = JSON.parse(await packagedExtensionManifestEntry.async("string"));
if (packagedExtensionManifest.version !== releaseVersion) {
  throw new Error(
    `${releasePackageName} contains version ${packagedExtensionManifest.version}, expected ${releaseVersion}`,
  );
}

const vsixManifest = await vsixManifestEntry.async("string");
const packagedVsixIdentityVersion = /<Identity\b[^>]*\bVersion="([^"]+)"/.exec(vsixManifest)?.[1];
if (packagedVsixIdentityVersion !== releaseVersion) {
  throw new Error(
    `${releasePackageName} contains VSIX identity version ${packagedVsixIdentityVersion}, expected ${releaseVersion}`,
  );
}

console.log(`Verified exact release package ${releasePackageName} (${releasePackageDigest}).`);
