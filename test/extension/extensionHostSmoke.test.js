const assert = require("node:assert/strict");
const vscode = require("vscode");

module.exports = async function runExtensionHostSmoke() {
  const extension = vscode.extensions.getExtension("overengineered-org.gito");
  assert.ok(extension, "Git'o extension is available in the Extension Host");
  await extension.activate();
  await vscode.commands.executeCommand("gito.openHome");
  const registeredCommands = await vscode.commands.getCommands();
  assert.ok(registeredCommands.includes("gito.openHome"));
};
