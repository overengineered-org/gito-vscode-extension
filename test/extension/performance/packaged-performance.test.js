const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const vscode = require("vscode");

const packagedActivationP95BudgetMilliseconds = 500;
const packagedActivationDurationPath =
  process.env.GITO_PACKAGED_ACTIVATION_DURATION_PATH;
const packagedExtensionVersion = process.env.GITO_PACKAGED_EXTENSION_VERSION;
const packagedVsixPath = process.env.GITO_PACKAGED_VSIX_PATH;
const packagedVsixSha256 = process.env.GITO_PACKAGED_VSIX_SHA256;
const packagedVscodeVersion = process.env.GITO_PACKAGED_VSCODE_VERSION;

module.exports = async function runPackagedPerformance() {
  assert.ok(
    packagedActivationDurationPath,
    "Packaged VSIX runner must provide GITO_PACKAGED_ACTIVATION_DURATION_PATH",
  );
  assert.ok(
    packagedExtensionVersion,
    "Packaged VSIX runner must provide GITO_PACKAGED_EXTENSION_VERSION",
  );
  assert.ok(
    packagedVsixPath,
    "Packaged VSIX runner must provide GITO_PACKAGED_VSIX_PATH",
  );
  assert.ok(
    packagedVsixSha256,
    "Packaged VSIX runner must provide GITO_PACKAGED_VSIX_SHA256",
  );
  assert.ok(
    packagedVscodeVersion,
    "Packaged VSIX runner must provide GITO_PACKAGED_VSCODE_VERSION",
  );
  const extension = vscode.extensions.getExtension("overengineered-org.gito");
  assert.ok(extension, "Git'o VSIX is available in the Extension Host");
  assert.equal(
    extension.extensionPath,
    process.env.GITO_PACKAGED_EXTENSION_PATH,
    "Extension Host loaded the installed VSIX path",
  );
  assert.equal(
    vscode.version,
    packagedVscodeVersion,
    "Extension Host ran under the runner-selected VS Code version",
  );
  assert.equal(
    extension.packageJSON.version,
    packagedExtensionVersion,
    "Extension Host loaded the expected VSIX version",
  );
  assert.equal(
    await sha256File(packagedVsixPath),
    packagedVsixSha256,
    "Extension Host is bound to the exact VSIX archive hash",
  );
  assert.equal(
    extension.isActive,
    false,
    "Packaged activation sample starts before Git'o is activated",
  );

  // Each host process is a cold sample. Never call activate() repeatedly here:
  // VS Code returns the already-resolved activation promise after the first call.
  const activationStartTime = performance.now();
  await extension.activate();
  const activationElapsedMilliseconds = performance.now() - activationStartTime;
  await writeFile(
    packagedActivationDurationPath,
    `${activationElapsedMilliseconds}\n`,
    "utf8",
  );
  assert.ok(
    activationElapsedMilliseconds <= packagedActivationP95BudgetMilliseconds,
    `packaged activation ${activationElapsedMilliseconds.toFixed(2)} ms exceeds ${packagedActivationP95BudgetMilliseconds} ms`,
  );
  assert.ok(
    (await vscode.commands.getCommands()).includes("gito.openHome"),
    "Git'o command registration is live in the packaged Extension Host",
  );
};

async function sha256File(filePath) {
  const fileContents = await readFile(filePath);
  return createHash("sha256").update(fileContents).digest("hex");
}
