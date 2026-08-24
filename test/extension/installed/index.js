const { rename, writeFile } = require("node:fs/promises");
const vscode = require("vscode");
const runInstalledVsixIntegration = require("./installed-vsix.integration.test.js");

function activate() {
  const testResultPath = process.env.GITO_INSTALLED_TEST_RESULT_PATH;
  if (!testResultPath) {
    throw new Error(
      "Installed VSIX test driver requires GITO_INSTALLED_TEST_RESULT_PATH",
    );
  }

  setTimeout(() => {
    void runInstalledVsixTestDriver(testResultPath).catch(() => undefined);
  }, 0);
}

async function runInstalledVsixTestDriver(testResultPath) {
  let testDriverResult;
  try {
    await runInstalledVsixIntegration();
    testDriverResult = { passed: true };
  } catch (error) {
    testDriverResult = {
      passed: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
  }

  try {
    const pendingResultPath = `${testResultPath}.tmp`;
    await writeFile(
      pendingResultPath,
      JSON.stringify(testDriverResult, null, 2),
    );
    await rename(pendingResultPath, testResultPath);
  } finally {
    await vscode.commands.executeCommand("workbench.action.quit");
  }
}

module.exports = { activate };
