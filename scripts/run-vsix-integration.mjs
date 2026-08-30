import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  downloadAndUnzipVSCode,
  runTests,
  runVSCodeCommand,
} from "@vscode/test-electron";

import { createIntegrationFixture } from "../test/integrationFixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const distributionDirectory = resolve(repositoryRoot, "dist");
const packagedExtensionFileNames = existsSync(distributionDirectory)
  ? readdirSync(distributionDirectory).filter((fileName) => fileName.endsWith(".vsix"))
  : [];
if (packagedExtensionFileNames.length !== 1) {
  throw new Error(
    `Expected exactly one packaged VSIX in ${distributionDirectory}, found ${packagedExtensionFileNames.length}`,
  );
}

const packagedExtensionPath = resolve(distributionDirectory, packagedExtensionFileNames[0]);
const vscodeVersion = process.env.GITO_VSCODE_VERSION ?? "stable";
const integrationFixture = createIntegrationFixture();
const vscodeStateRoot = mkdtempSync(join(tmpdir(), "gito-vsix-host-"));
const extensionsDirectory = resolve(vscodeStateRoot, "extensions");
const userDataDirectory = resolve(vscodeStateRoot, "user-data");

try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  await runVSCodeCommand(
    [
      "--install-extension",
      packagedExtensionPath,
      "--force",
      `--extensions-dir=${extensionsDirectory}`,
      `--user-data-dir=${userDataDirectory}`,
    ],
    { version: vscodeVersion },
  );
  await runTests({
    extensionDevelopmentPath: resolve(repositoryRoot, "test", "harness"),
    extensionTestsPath: resolve(repositoryRoot, ".integration-test", "suite.cjs"),
    launchArgs: [
      integrationFixture.workspaceRepositoryPath,
      `--extensions-dir=${extensionsDirectory}`,
      `--user-data-dir=${userDataDirectory}`,
      "--disable-crash-reporter",
      "--disable-telemetry",
      "--disable-workspace-trust",
      "--skip-welcome",
    ],
    vscodeExecutablePath,
  });
} finally {
  integrationFixture.dispose();
  rmSync(vscodeStateRoot, { force: true, recursive: true });
}
