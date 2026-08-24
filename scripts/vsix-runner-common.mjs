import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

export async function findInstalledExtension(
  extensionsDirectoryPath,
  { extensionIdentifier, extensionName, extensionPublisher },
) {
  const extensionEntries = await readdir(extensionsDirectoryPath, {
    withFileTypes: true,
  });
  const matchingExtensions = [];
  for (const extensionEntry of extensionEntries) {
    if (!extensionEntry.isDirectory()) continue;
    const candidatePath = join(extensionsDirectoryPath, extensionEntry.name);
    try {
      const manifest = JSON.parse(
        await readFile(join(candidatePath, "package.json"), "utf8"),
      );
      if (
        manifest.name === extensionName &&
        manifest.publisher === extensionPublisher
      ) {
        matchingExtensions.push({ manifest, path: candidatePath });
      }
    } catch {
      // Ignore VS Code's bookkeeping directories.
    }
  }
  if (matchingExtensions.length !== 1) {
    throw new Error(
      `Expected one installed ${extensionIdentifier}, found ${matchingExtensions.length} under ${extensionsDirectoryPath}.`,
    );
  }
  return matchingExtensions[0];
}

export async function assertRegularFile(filePath, fileLabel) {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile())
    throw new Error(`${fileLabel} must be a regular file: ${filePath}`);
}

export function resolveDownloadedVscodeExecutable(downloadedExecutablePath) {
  const candidatePaths = [downloadedExecutablePath];
  if (process.platform === "darwin") {
    const macosExecutableDirectory = dirname(downloadedExecutablePath);
    candidatePaths.push(
      join(macosExecutableDirectory, "Code"),
      join(macosExecutableDirectory, "Electron"),
    );
  }
  const existingExecutablePath = candidatePaths.find((candidatePath) =>
    existsSync(candidatePath),
  );
  if (existingExecutablePath !== undefined) return existingExecutablePath;
  throw new Error(
    `Downloaded VS Code executable is missing: ${candidatePaths.join(", ")}`,
  );
}

export async function readVscodeVersion(vscodeExecutablePath) {
  const resourcesAppPackagePath = resolve(
    dirname(vscodeExecutablePath),
    process.platform === "darwin" ? ".." : ".",
    ...(process.platform === "darwin"
      ? ["Resources", "app", "package.json"]
      : ["resources", "app", "package.json"]),
  );
  const packageJson = JSON.parse(
    await readFile(resourcesAppPackagePath, "utf8"),
  );
  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error(`VS Code version is missing: ${resourcesAppPackagePath}`);
  }
  return packageJson.version;
}

export async function sha256File(filePath) {
  const fileContents = await readFile(filePath);
  return createHash("sha256").update(fileContents).digest("hex");
}

export async function writeRunMetadata(metadataPath, metadata) {
  let existingMetadata = {};
  try {
    existingMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    // The run metadata file is created lazily after VS Code resolves.
  }
  await writeFile(
    metadataPath,
    `${JSON.stringify({ ...existingMetadata, ...metadata }, null, 2)}\n`,
  );
}

export async function findLogFiles(directoryPath, logFileSuffixes = [".log"]) {
  const logPaths = [];
  let directoryEntries;
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return logPaths;
  }
  for (const directoryEntry of directoryEntries) {
    const entryPath = join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      logPaths.push(...(await findLogFiles(entryPath, logFileSuffixes)));
      continue;
    }
    if (logFileSuffixes.some((suffix) => directoryEntry.name.endsWith(suffix)))
      logPaths.push(entryPath);
  }
  return logPaths;
}

export function describeError(error) {
  return {
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
    signal: error?.signal,
  };
}

export function formatFailure(error, artifactPaths, runnerLabel) {
  const description = describeError(error);
  const artifactSummary =
    artifactPaths.length === 0
      ? "none"
      : artifactPaths.map((artifactPath) => `\n  - ${artifactPath}`).join("");
  const guiBlockerMessage =
    process.platform === "darwin" && description.signal === "SIGABRT"
      ? "\nVS Code aborted before Extension Host startup. macOS requires a sanctioned desktop GUI session; rerun from a logged-in desktop/CI macOS session."
      : process.platform === "linux" &&
          description.signal === "SIGABRT" &&
          !process.env.DISPLAY &&
          !process.env.WAYLAND_DISPLAY
        ? "\nVS Code aborted without a display. Run this command under xvfb-run --auto-servernum."
        : "";
  return `${runnerLabel} failed (${description.signal ?? description.code ?? "unknown"}): ${description.message}${guiBlockerMessage}\nDiagnostic artifacts:${artifactSummary}`;
}
