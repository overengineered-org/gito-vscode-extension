import { constants } from "node:fs";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";

const explicitShortTempRootPath = "/tmp";
const packagedExtensionTestDirectoryPrefix = "gito-vsix-";

export function getPackagedExtensionTestTempRootCandidates({
  platform = process.platform,
  systemTempRoot = tmpdir(),
  explicitTempRoot = explicitShortTempRootPath,
} = {}) {
  const candidateTempRootPaths =
    platform === "win32"
      ? [systemTempRoot]
      : [explicitTempRoot, systemTempRoot];
  return [...new Set(candidateTempRootPaths)];
}

export async function createPackagedExtensionTestRootPath(options = {}) {
  const candidateTempRootPaths =
    getPackagedExtensionTestTempRootCandidates(options);
  const candidateFailures = [];

  for (const candidateTempRootPath of candidateTempRootPaths) {
    if (!isAbsolute(candidateTempRootPath)) {
      candidateFailures.push(`${candidateTempRootPath}: path is not absolute`);
      continue;
    }

    try {
      const candidateTempRootStats = await stat(candidateTempRootPath);
      if (!candidateTempRootStats.isDirectory()) {
        throw new Error("path is not a directory");
      }
      await access(candidateTempRootPath, constants.W_OK);
      return await mkdtemp(
        join(candidateTempRootPath, packagedExtensionTestDirectoryPrefix),
      );
    } catch (error) {
      candidateFailures.push(
        `${candidateTempRootPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Could not create an isolated packaged VSIX test root: ${candidateFailures.join("; ")}`,
  );
}
