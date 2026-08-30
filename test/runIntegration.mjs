import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

import { createIntegrationFixture } from "./integrationFixture.mjs";

const integrationFixture = createIntegrationFixture();

try {
  await runTests({
    extensionDevelopmentPath: resolve("."),
    extensionTestsPath: resolve(".integration-test/suite.cjs"),
    launchArgs: [
      integrationFixture.workspaceRepositoryPath,
      `--extensions-dir=${join(integrationFixture.integrationFixtureRootPath, "extensions")}`,
      `--user-data-dir=${join(integrationFixture.integrationFixtureRootPath, "user-data")}`,
      "--disable-extensions",
      "--disable-telemetry",
      "--disable-workspace-trust",
      "--skip-welcome",
    ],
  });
} finally {
  integrationFixture.dispose();
}
