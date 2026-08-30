import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

import { createIntegrationFixture } from "./integrationFixture.mjs";
import {
  initializeIsolatedUserData,
  isolatedHostLaunchArguments,
} from "./integrationHost.mjs";

const integrationFixture = createIntegrationFixture();
const userDataDirectory = join(integrationFixture.integrationFixtureRootPath, "user-data");

try {
  initializeIsolatedUserData(userDataDirectory);
  await runTests({
    extensionDevelopmentPath: resolve("."),
    extensionTestsPath: resolve(".integration-test/suite.cjs"),
    launchArgs: [
      integrationFixture.workspaceRepositoryPath,
      `--extensions-dir=${join(integrationFixture.integrationFixtureRootPath, "extensions")}`,
      `--user-data-dir=${userDataDirectory}`,
      ...isolatedHostLaunchArguments,
    ],
  });
} finally {
  integrationFixture.dispose();
}
