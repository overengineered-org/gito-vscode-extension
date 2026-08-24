import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { scanReadableForCredentials } from "./credential-detector.mjs";

export {
  assertCredentialFreeText,
  credentialPatterns,
  findCredentialPattern,
  scanReadableForCredentials,
} from "./credential-detector.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
export const ignoredDirectoryNames = new Set([
  ".git",
  "node_modules",
  "coverage",
  ".vscode-test",
]);
export const sensitiveFilePatterns = [
  /(?:^|\/)\.env$/u,
  /(?:^|\/)\.env\.(?!example$)[^/]+$/u,
  /(?:^|\/)\.envrc$/u,
  /(?:^|\/)\.npmrc$/u,
  /(?:^|\/)[^/]+\.(?:jks|key|keystore|p12|pem|pfx)$/u,
  /(?:^|\/)[^/]+\.log(?:\.[^/]+)?$/u,
  /(?:^|\/)logs(?:\/|$)/u,
  /(?:^|\/)(?:\.?operator-evidence|\.?release-evidence)(?:\/|$)/u,
];
const scanChunkByteLength = 64 * 1024;

async function assertRegularPath(filePath, displayPath) {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink())
    throw new Error(`Secret scan rejects symlink input: ${displayPath}.`);
  if (!fileStat.isFile())
    throw new Error(`Secret scan rejects non-regular input: ${displayPath}.`);
}

export async function scanRegularFileForCredentials(filePath, displayPath) {
  await assertRegularPath(filePath, displayPath);
  await scanReadableForCredentials(
    createReadStream(filePath, { highWaterMark: scanChunkByteLength }),
    displayPath,
  );
}

export async function scanRegularTreeForCredentials(
  directoryPath,
  rootPath = directoryPath,
) {
  const directoryStat = await lstat(directoryPath);
  if (directoryStat.isSymbolicLink())
    throw new Error(`Secret scan rejects symlink input: ${directoryPath}.`);
  if (!directoryStat.isDirectory())
    throw new Error(
      `Secret scan rejects non-directory input: ${directoryPath}.`,
    );
  for (const directoryEntry of await readdir(directoryPath, {
    withFileTypes: true,
  })) {
    const filePath = join(directoryPath, directoryEntry.name);
    const displayPath = relative(rootPath, filePath).replaceAll("\\", "/");
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink())
      throw new Error(`Secret scan rejects symlink input: ${displayPath}.`);
    if (fileStat.isDirectory()) {
      if (!ignoredDirectoryNames.has(directoryEntry.name))
        await scanRegularTreeForCredentials(filePath, rootPath);
      continue;
    }
    if (!fileStat.isFile())
      throw new Error(`Secret scan rejects non-regular input: ${displayPath}.`);
    await scanRegularFileForCredentials(filePath, displayPath);
  }
}

export function isSensitiveFilename(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return sensitiveFilePatterns.some((sensitiveFilePattern) =>
    sensitiveFilePattern.test(normalizedPath),
  );
}

function readGitPathList(repositoryPath, gitArguments) {
  const gitOutput = execFileSync("git", gitArguments, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return gitOutput.split("\0").filter(Boolean);
}

export async function scanTrackedAndStagedSensitiveFiles(repositoryPath) {
  const trackedPaths = readGitPathList(repositoryPath, [
    "ls-files",
    "--cached",
    "-z",
  ]);
  const stagedPaths = readGitPathList(repositoryPath, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMRTUXB",
    "-z",
  ]);
  const sensitivePaths = new Set(
    [...trackedPaths, ...stagedPaths].filter(isSensitiveFilename),
  );
  const repositoryAbsolutePath = resolve(repositoryPath);
  for (const relativePath of sensitivePaths) {
    const absolutePath = resolve(repositoryAbsolutePath, relativePath);
    if (
      absolutePath !== repositoryAbsolutePath &&
      !absolutePath.startsWith(`${repositoryAbsolutePath}${sep}`)
    ) {
      throw new Error(
        `Secret scan rejects path outside repository: ${relativePath}.`,
      );
    }
    try {
      await scanRegularFileForCredentials(absolutePath, relativePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function scanSensitiveRootFilesForCredentials(repositoryPath) {
  for (const directoryEntry of await readdir(repositoryPath, {
    withFileTypes: true,
  })) {
    if (!isSensitiveFilename(directoryEntry.name)) continue;
    await scanRegularFileForCredentials(
      join(repositoryPath, directoryEntry.name),
      directoryEntry.name,
    );
  }
}

export async function scanCurrentTreeForCredentials(
  directoryPath = repositoryRoot,
  { includeIgnoredSensitiveRootFiles = false } = {},
) {
  await scanRegularTreeForCredentials(directoryPath, directoryPath);
  await scanTrackedAndStagedSensitiveFiles(directoryPath);
  if (includeIgnoredSensitiveRootFiles)
    await scanSensitiveRootFilesForCredentials(directoryPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await scanCurrentTreeForCredentials(repositoryRoot, {
    includeIgnoredSensitiveRootFiles: true,
  });
  process.stdout.write(
    "Current-tree credential scan passed for tracked and untracked files.\n",
  );
}
