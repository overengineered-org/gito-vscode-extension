import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { existsSync } from "node:fs";
import process from "node:process";
import { dirname, join, resolve } from "node:path";

const extensionDevelopmentPath = resolve(import.meta.dirname, "..");
const extensionTestsPath = resolve(
  extensionDevelopmentPath,
  "test",
  "extension",
);
const vscodeVersion = process.env.GITO_VSCODE_VERSION ?? "stable";
const downloadedVscodeExecutablePath = await downloadAndUnzipVSCode({
  version: vscodeVersion,
  extensionDevelopmentPath,
});

function resolveDownloadedVscodeExecutable(downloadedExecutablePath) {
  if (existsSync(downloadedExecutablePath)) return downloadedExecutablePath;
  if (process.platform === "darwin") {
    const macosExecutableDirectory = dirname(downloadedExecutablePath);
    const renamedVscodeExecutablePath = join(macosExecutableDirectory, "Code");
    if (existsSync(renamedVscodeExecutablePath))
      return renamedVscodeExecutablePath;
  }
  throw new Error(
    `Downloaded VS Code executable is missing: ${downloadedExecutablePath}`,
  );
}

await runTests({
  vscodeExecutablePath: resolveDownloadedVscodeExecutable(
    downloadedVscodeExecutablePath,
  ),
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: ["--disable-extensions"],
});
