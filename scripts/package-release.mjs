import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  scanRegularFileForCredentials,
  scanRegularTreeForCredentials,
} from "./scan-current-tree-secrets.mjs";
import { calculateSourceTreeFingerprint } from "./source-tree-fingerprint.mjs";

const outputLogger = globalThis.console;

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifestPath = join(repositoryRoot, "package.json");
const packageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
const releaseVersion = process.argv[2] ?? packageManifest.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  throw new Error(`Invalid VSIX version: ${releaseVersion}`);
}

if (process.env.GITO_SKIP_BUILD !== "1") {
  execFileSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "build.mjs")],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );
}

const releaseOutputDirectory = join(repositoryRoot, "dist");
await mkdir(releaseOutputDirectory, { recursive: true });
const releasePackageName = `gito-${releaseVersion}.vsix`;
const releasePackagePath = join(releaseOutputDirectory, releasePackageName);
const releaseChecksumPath = `${releasePackagePath}.sha256`;
const releaseMetadataPath = join(
  releaseOutputDirectory,
  "release-metadata.json",
);

for (const existingReleaseAssetName of await readdir(releaseOutputDirectory)) {
  if (
    /^gito-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.vsix(?:\.sha256)?$/.test(
      existingReleaseAssetName,
    )
  ) {
    await rm(join(releaseOutputDirectory, existingReleaseAssetName), {
      force: true,
    });
  }
}

const packageSourcePaths = [
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "SUPPORT.md",
  "dist",
  "media",
];
async function scanPackageInputs() {
  for (const packageSourcePath of packageSourcePaths) {
    const sourcePath = join(repositoryRoot, packageSourcePath);
    if (packageSourcePath === "dist" || packageSourcePath === "media")
      await scanRegularTreeForCredentials(sourcePath, repositoryRoot);
    else await scanRegularFileForCredentials(sourcePath, packageSourcePath);
  }
}
await scanPackageInputs();
const sourceTreeSha256 = await calculateSourceTreeFingerprint(repositoryRoot);

const vsceExecutable = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vsce.cmd" : "vsce",
);
execFileSync(
  vsceExecutable,
  [
    "package",
    releaseVersion,
    "--no-update-package-json",
    "--no-dependencies",
    "--out",
    releasePackagePath,
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH:
        process.env.SOURCE_DATE_EPOCH ??
        execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }).trim(),
    },
    stdio: "inherit",
  },
);
await scanPackageInputs();

const releasePackageBytes = await readFile(releasePackagePath);
const releasePackageDigest = createHash("sha256")
  .update(releasePackageBytes)
  .digest("hex");
await writeFile(
  releaseChecksumPath,
  `${releasePackageDigest}  ${releasePackageName}\n`,
);
const releaseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
await writeFile(
  releaseMetadataPath,
  `${JSON.stringify(
    {
      assetName: releasePackageName,
      checksumAssetName: `${releasePackageName}.sha256`,
      commitSha: releaseCommitSha,
      sha256: releasePackageDigest,
      sourceTreeSha256,
      tag: `v${releaseVersion}`,
      version: releaseVersion,
    },
    null,
    2,
  )}\n`,
);

outputLogger.log(`Packaged ${relative(repositoryRoot, releasePackagePath)}`);
outputLogger.log(`SHA-256 ${releasePackageDigest}`);
