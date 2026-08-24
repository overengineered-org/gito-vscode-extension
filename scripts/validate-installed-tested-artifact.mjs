import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { calculateSourceTreeFingerprint } from "./source-tree-fingerprint.mjs";

const [packageArgument, checksumArgument, metadataArgument, expectedVersion] =
  process.argv.slice(2);
if (
  !packageArgument ||
  !checksumArgument ||
  !metadataArgument ||
  !expectedVersion
) {
  throw new Error(
    "Usage: node scripts/validate-installed-tested-artifact.mjs <vsix> <sha256> <metadata> <version>",
  );
}

const packagePath = resolve(process.cwd(), packageArgument);
const checksumPath = resolve(process.cwd(), checksumArgument);
const metadataPath = resolve(process.cwd(), metadataArgument);
async function assertRegularFile(filePath, fileLabel) {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`Installed-tested ${fileLabel} must be a regular file.`);
  }
}
await Promise.all([
  assertRegularFile(packagePath, "VSIX"),
  assertRegularFile(checksumPath, "checksum"),
  assertRegularFile(metadataPath, "metadata"),
]);

const packageBytes = await readFile(packagePath);
const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
const packageName = packagePath.split(/[/\\]/u).at(-1);
const expectedPackageName = `gito-${expectedVersion}.vsix`;
if (packageName !== expectedPackageName) {
  throw new Error(
    `Installed-tested VSIX name mismatch: expected ${expectedPackageName}, found ${packageName}.`,
  );
}

const checksumTokens = (await readFile(checksumPath, "utf8"))
  .trim()
  .split(/\s+/u);
if (
  checksumTokens.length !== 2 ||
  checksumTokens[0] !== packageSha256 ||
  checksumTokens[1] !== expectedPackageName
) {
  throw new Error(
    `Installed-tested VSIX checksum mismatch for ${expectedPackageName}.`,
  );
}

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const expectedCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const currentSourceTreeSha256 = await calculateSourceTreeFingerprint(
  process.cwd(),
);
if (
  metadata.assetName !== expectedPackageName ||
  metadata.checksumAssetName !== `${expectedPackageName}.sha256` ||
  metadata.version !== expectedVersion ||
  metadata.tag !== `v${expectedVersion}` ||
  metadata.sha256 !== packageSha256 ||
  metadata.commitSha !== expectedCommitSha ||
  metadata.sourceTreeSha256 !== currentSourceTreeSha256
) {
  throw new Error(
    `Installed-tested VSIX metadata is stale or does not bind to ${expectedCommitSha}.`,
  );
}

const embeddedManifest = JSON.parse(
  execFileSync("unzip", ["-p", packagePath, "extension/package.json"], {
    encoding: "utf8",
  }),
);
if (
  embeddedManifest.name !== "gito" ||
  embeddedManifest.publisher !== "overengineered-org" ||
  embeddedManifest.version !== expectedVersion
) {
  throw new Error(
    `Installed-tested VSIX manifest does not match ${expectedPackageName}.`,
  );
}

process.stdout.write(
  `Validated installed-tested VSIX ${expectedPackageName} at ${expectedCommitSha} (${packageSha256}); source tree ${currentSourceTreeSha256}.\n`,
);
