import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import JSZip from "jszip";

export const expectedPackagedFilePaths = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/CONTRIBUTING.md",
  "extension/dist/extension.cjs",
  "extension/docs/ARCHITECTURE.md",
  "extension/media/gito.svg",
  "extension/media/onboarding/changes.svg",
  "extension/media/onboarding/file-context.svg",
  "extension/media/onboarding/graph.svg",
  "extension/media/onboarding/repositories.svg",
  "extension/media/onboarding/worktrees.svg",
  "extension/package.json",
  "extension/readme.md",
].sort();

export async function validatePackageContents(extensionPackagePath) {
  const extensionPackageArchive = await JSZip.loadAsync(readFileSync(extensionPackagePath));
  const packagedFilePaths = Object.values(extensionPackageArchive.files)
    .filter((archiveEntry) => !archiveEntry.dir)
    .map((archiveEntry) => archiveEntry.name)
    .sort();

  if (JSON.stringify(packagedFilePaths) !== JSON.stringify(expectedPackagedFilePaths)) {
    throw new Error(
      `Unexpected VSIX contents.\nExpected: ${expectedPackagedFilePaths.join(", ")}\nActual: ${packagedFilePaths.join(", ")}`,
    );
  }

  const extensionManifestEntry = extensionPackageArchive.file("extension/package.json");
  const vsixManifestEntry = extensionPackageArchive.file("extension.vsixmanifest");
  if (!extensionManifestEntry || !vsixManifestEntry) {
    throw new Error("The VSIX is missing a required manifest.");
  }

  const extensionManifest = JSON.parse(await extensionManifestEntry.async("string"));
  if (
    extensionManifest.name !== "gito" ||
    extensionManifest.publisher !== "overengineered-org" ||
    extensionManifest.main !== "./dist/extension.cjs"
  ) {
    throw new Error("The packaged extension identity or entry point is incorrect.");
  }

  const vsixManifest = await vsixManifestEntry.async("string");
  const vsixIdentityVersion = /<Identity\b[^>]*\bVersion="([^"]+)"/.exec(vsixManifest)?.[1];
  if (vsixIdentityVersion !== extensionManifest.version) {
    throw new Error(
      `VSIX identity version ${vsixIdentityVersion} does not match package version ${extensionManifest.version}.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distributionDirectory = resolve("dist");
  const extensionPackageFileNames = readdirSync(distributionDirectory).filter(
    (extensionPackageFileName) => extensionPackageFileName.endsWith(".vsix"),
  );
  if (extensionPackageFileNames.length !== 1) {
    throw new Error(
      `Expected exactly one VSIX in ${distributionDirectory}, found ${extensionPackageFileNames.length}.`,
    );
  }

  const extensionPackagePath = resolve(distributionDirectory, extensionPackageFileNames[0]);
  await validatePackageContents(extensionPackagePath);
  console.log(`Verified exact package contents: ${extensionPackageFileNames[0]}.`);
}
