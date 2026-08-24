const assert = require("node:assert/strict");
const { readFile, rename, writeFile } = require("node:fs/promises");
const vscode = require("vscode");

const visualRunDirectory = process.env.GITO_VISUAL_RUN_DIRECTORY;
const readyResultPath = process.env.GITO_VISUAL_READY_PATH;
const completedResultPath = process.env.GITO_VISUAL_COMPLETED_PATH;
const expectedTheme = process.env.GITO_VISUAL_EXPECTED_THEME;
const expectedZoomLevel = Number(process.env.GITO_VISUAL_EXPECTED_ZOOM_LEVEL);
const expectedVariant = process.env.GITO_VISUAL_EXPECTED_VARIANT;
const expectedVsixSha256 = process.env.GITO_VISUAL_VSIX_SHA256;
const expectedVscodeVersion = process.env.GITO_VISUAL_VSCODE_VERSION;
const repositoryPath = process.env.GITO_VISUAL_REPOSITORY_PATH;
const driverTimeoutMilliseconds = 120_000;
const pollMilliseconds = 100;

function activate() {
  void runVisualDriver().catch((error) => {
    void writeAtomicResult(completedResultPath, {
      passed: false,
      error: serializeError(error),
    });
  });
}

async function runVisualDriver() {
  assert.ok(visualRunDirectory, "Visual driver requires its run directory");
  assert.ok(readyResultPath, "Visual driver requires its ready result path");
  assert.ok(
    completedResultPath,
    "Visual driver requires its completed result path",
  );
  assert.ok(expectedTheme, "Visual driver requires its expected theme");
  assert.ok(
    Number.isInteger(expectedZoomLevel),
    "Visual driver requires an integer zoom level",
  );
  assert.ok(expectedVariant, "Visual driver requires its expected variant");
  assert.match(expectedVsixSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.match(expectedVscodeVersion ?? "", /^\d+\.\d+\.\d+$/u);
  assert.ok(
    repositoryPath,
    "Visual driver requires the fixture repository path",
  );

  try {
    await vscode.commands.executeCommand("gito.openHome");
    await waitForCondition("Repository Home tab", () =>
      allTabs().some(
        (tab) =>
          tab.input?.viewType === "gito.repositoryHome" &&
          tab.label === "Repository Home",
      ),
    );

    const colorTheme = vscode.workspace
      .getConfiguration("workbench")
      .get("colorTheme");
    const zoomLevel = vscode.workspace
      .getConfiguration("window")
      .get("zoomLevel");
    assert.equal(colorTheme, expectedTheme);
    assert.equal(zoomLevel, expectedZoomLevel);

    await writeAtomicResult(readyResultPath, {
      passed: true,
      repositoryPath,
      theme: colorTheme,
      variant: expectedVariant,
      zoomLevel,
      vsixSha256: expectedVsixSha256,
      vscodeVersion: vscode.version,
    });

    await waitForCondition(
      "external visual evidence result",
      async () => {
        try {
          const result = JSON.parse(
            await readFile(completedResultPath, "utf8"),
          );
          return result && typeof result.passed === "boolean"
            ? result
            : undefined;
        } catch (error) {
          if (error?.code === "ENOENT") return undefined;
          throw error;
        }
      },
      (result) => result !== undefined,
    );
    const completedResult = JSON.parse(
      await readFile(completedResultPath, "utf8"),
    );
    if (!completedResult.passed)
      throw new Error(
        completedResult.error?.message ?? "Visual evidence failed.",
      );
    await writeAtomicResult(completedResultPath, {
      ...completedResult,
      driverCompleted: true,
    });
  } catch (error) {
    await writeAtomicResult(completedResultPath, {
      passed: false,
      error: serializeError(error),
    });
    throw error;
  } finally {
    await vscode.commands.executeCommand("workbench.action.quit");
  }
}

function allTabs() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

async function waitForCondition(label, readValue, predicate = Boolean) {
  const deadline = Date.now() + driverTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function writeAtomicResult(resultPath, result) {
  if (!resultPath) return;
  await writeFile(`${resultPath}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${resultPath}.tmp`, resultPath);
}

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

module.exports = { activate };
