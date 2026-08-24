import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import process from "node:process";
import { join, resolve } from "node:path";

const outputLogger = globalThis.console;
const repositoryRoot = resolve(import.meta.dirname, "..");
const releaseVersion = process.argv[2];
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!releaseVersionPattern.test(releaseVersion ?? "")) {
  throw new Error(`Invalid VSIX version: ${releaseVersion}`);
}

const releaseOutputDirectory = join(repositoryRoot, "dist");
const releasePackageName = `gito-${releaseVersion}.vsix`;
const releasePackagePath = join(releaseOutputDirectory, releasePackageName);
const releaseChecksumName = `${releasePackageName}.sha256`;
const releaseChecksumPath = join(releaseOutputDirectory, releaseChecksumName);
const releaseMetadataPath = join(
  releaseOutputDirectory,
  "release-metadata.json",
);
function runNodeScript(scriptName, argumentsList = [], environment = {}) {
  execFileSync(
    process.execPath,
    [join(repositoryRoot, "scripts", scriptName), ...argumentsList],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    },
  );
}

const testedReleasePackagePath = process.env.GITO_RELEASE_PACKAGE_PATH;
if (testedReleasePackagePath === undefined) {
  runNodeScript("build.mjs");
  runNodeScript("check-bundle-budgets.mjs");
  runNodeScript("package-release.mjs", [releaseVersion], {
    GITO_SKIP_BUILD: "1",
  });
} else {
  const sourcePackagePath = resolve(process.cwd(), testedReleasePackagePath);
  const expectedSourcePackageName = releasePackageName;
  if (sourcePackagePath.split(/[/\\]/).at(-1) !== expectedSourcePackageName) {
    throw new Error(
      `Tested release package name mismatch: expected ${expectedSourcePackageName}, found ${sourcePackagePath}.`,
    );
  }
  const sourceChecksumPath = `${sourcePackagePath}.sha256`;
  const sourceMetadataPath = resolve(
    process.cwd(),
    process.env.GITO_RELEASE_METADATA_PATH ?? releaseMetadataPath,
  );
  runNodeScript("validate-installed-tested-artifact.mjs", [
    sourcePackagePath,
    sourceChecksumPath,
    sourceMetadataPath,
    releaseVersion,
  ]);
  await mkdir(releaseOutputDirectory, { recursive: true });
  for (const [sourceAssetPath, destinationAssetPath] of [
    [sourcePackagePath, releasePackagePath],
    [sourceChecksumPath, releaseChecksumPath],
    [sourceMetadataPath, releaseMetadataPath],
  ]) {
    if (sourceAssetPath !== destinationAssetPath)
      await copyFile(sourceAssetPath, destinationAssetPath);
  }
  outputLogger.log(
    `Reusing installed-tested VSIX ${releasePackageName}; exact VSIX, checksum, and metadata copied.`,
  );
}
if (testedReleasePackagePath === undefined) {
  runNodeScript("validate-installed-tested-artifact.mjs", [
    releasePackagePath,
    releaseChecksumPath,
    releaseMetadataPath,
    releaseVersion,
  ]);
}
runNodeScript("validate-package-contents.mjs", [
  releasePackagePath,
  releaseVersion,
]);

outputLogger.log(`Prepared ${releasePackageName}.`);
