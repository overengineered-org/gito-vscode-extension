import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const excludedDirectoryNames = new Set([
  ".git",
  "node_modules",
  "out",
  "coverage",
  ".nyc_output",
  ".vscode-test",
  ".vscode-test-web",
  ".vitest",
  ".turbo",
  ".cache",
  ".direnv",
  ".idea",
  ".history",
  "test-results",
  "playwright-report",
  "blob-report",
  ".scannerwork",
  "tmp",
  "temp",
  "logs",
  ".operator-evidence",
  "operator-evidence",
  ".release-evidence",
  "release-evidence",
]);

/**
 * Hashes every release-affecting current-tree input, including untracked
 * source, tests, workflows, package metadata, scripts, and media. Generated
 * root dist output and ignored local credentials, caches, and evidence stay
 * outside provenance.
 */
export async function calculateSourceTreeFingerprint(repositoryRootPath) {
  const fileRecords = [];
  await collectFileRecords(repositoryRootPath, repositoryRootPath, fileRecords);
  fileRecords.sort((leftRecord, rightRecord) =>
    leftRecord.relativePath.localeCompare(rightRecord.relativePath),
  );
  const fingerprintInput = fileRecords
    .map(
      ({ relativePath, byteLength, sha256 }) =>
        `${relativePath}\0regular\0${byteLength}\0${sha256}\n`,
    )
    .join("");
  return createHash("sha256").update(fingerprintInput, "utf8").digest("hex");
}

async function collectFileRecords(
  directoryPath,
  repositoryRootPath,
  fileRecords,
) {
  const directoryEntries = await readdir(directoryPath, {
    withFileTypes: true,
  });
  for (const directoryEntry of directoryEntries) {
    const filePath = join(directoryPath, directoryEntry.name);
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(
        `Source-tree fingerprint rejects symlink input: ${relative(repositoryRootPath, filePath)}.`,
      );
    }
    if (fileStat.isDirectory()) {
      const relativeDirectoryPath = relative(
        repositoryRootPath,
        filePath,
      ).replaceAll("\\", "/");
      if (
        relativeDirectoryPath === "dist" ||
        excludedDirectoryNames.has(directoryEntry.name)
      )
        continue;
      await collectFileRecords(filePath, repositoryRootPath, fileRecords);
      continue;
    }
    if (!fileStat.isFile()) {
      throw new Error(
        `Source-tree fingerprint rejects non-regular input: ${relative(repositoryRootPath, filePath)}.`,
      );
    }
    const relativePath = relative(repositoryRootPath, filePath).replaceAll(
      "\\",
      "/",
    );
    if (isLocalOnlyFile(directoryEntry.name)) continue;
    const fileBytes = await readFile(filePath);
    fileRecords.push({
      relativePath,
      byteLength: fileBytes.byteLength,
      sha256: createHash("sha256").update(fileBytes).digest("hex"),
    });
  }
}

function isLocalOnlyFile(fileName) {
  return (
    fileName === ".DS_Store" ||
    fileName === "Thumbs.db" ||
    fileName === ".eslintcache" ||
    fileName === ".envrc" ||
    fileName === ".npmrc" ||
    fileName.endsWith(".log") ||
    fileName.includes(".log.") ||
    fileName.endsWith(".lcov") ||
    fileName.endsWith(".sarif") ||
    fileName.endsWith(".tgz") ||
    fileName.endsWith(".tmp") ||
    fileName.endsWith(".pid") ||
    fileName.endsWith(".pid.lock") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key") ||
    fileName.endsWith(".p12") ||
    fileName.endsWith(".pfx") ||
    fileName.endsWith(".jks") ||
    fileName.endsWith(".keystore") ||
    (fileName.startsWith("junit") && fileName.endsWith(".xml")) ||
    fileName.endsWith(".swp") ||
    fileName.endsWith(".swo") ||
    fileName.endsWith(".tsbuildinfo") ||
    fileName.endsWith("~") ||
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example")
  );
}
