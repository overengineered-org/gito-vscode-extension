import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const outputLogger = globalThis.console;
const requiredManifestFields = [
  "name",
  "displayName",
  "description",
  "publisher",
  "license",
  "engines",
  "main",
  "icon",
];
const allowedNetworkSinks = new Set([
  "https://api.github.com",
  "https://dev.azure.com",
  "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1",
]);
const allowedNonSinkUrls = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://github.com/octokit/octokit.js/#fetch-missing",
  "https://example.test/repo.git",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/2000/svg",
]);
const ipv6ValidationUrlPattern =
  /^http:\/\/\[\$\{[A-Za-z_$][\w$]*(?:\.value)?\}\]$/;
const emittedUrlPattern = /https?:\/\/[^"'`\\\s)]+/g;

function assertStructuredManifestCapabilities(packageManifest) {
  const untrustedWorkspaceCapability =
    packageManifest.capabilities?.untrustedWorkspaces;
  if (untrustedWorkspaceCapability?.supported !== true) {
    throw new Error(
      "package.json must declare structured untrusted-workspace support.",
    );
  }
  if (
    typeof untrustedWorkspaceCapability.description !== "string" ||
    !/trusted workspace|trust the workspace/iu.test(
      untrustedWorkspaceCapability.description,
    )
  ) {
    throw new Error(
      "package.json must describe the trusted-workspace mutation boundary.",
    );
  }

  const contributedCommands = packageManifest.contributes?.commands;
  if (!Array.isArray(contributedCommands) || contributedCommands.length === 0) {
    throw new Error("package.json must declare structured commands.");
  }
  const commandIdentifiers = new Set();
  for (const contributedCommand of contributedCommands) {
    if (
      typeof contributedCommand?.command !== "string" ||
      typeof contributedCommand.title !== "string" ||
      contributedCommand.command.length === 0 ||
      contributedCommand.title.length === 0 ||
      commandIdentifiers.has(contributedCommand.command)
    ) {
      throw new Error("Command contributions must be unique and typed.");
    }
    commandIdentifiers.add(contributedCommand.command);
  }
  for (const activationEvent of packageManifest.activationEvents ?? []) {
    if (
      typeof activationEvent === "string" &&
      activationEvent.startsWith("onCommand:") &&
      !commandIdentifiers.has(activationEvent.slice("onCommand:".length))
    ) {
      throw new Error(
        `Activation event has no matching command: ${activationEvent}`,
      );
    }
  }
  for (const menuContributions of Object.values(
    packageManifest.contributes?.menus ?? {},
  )) {
    if (!Array.isArray(menuContributions)) continue;
    for (const menuContribution of menuContributions) {
      if (
        typeof menuContribution?.command === "string" &&
        !commandIdentifiers.has(menuContribution.command)
      ) {
        throw new Error(
          `Menu contribution has no matching command: ${menuContribution.command}`,
        );
      }
    }
  }
}

function assertNoUnstructuredCapabilityKeys(value, path = "package.json") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoUnstructuredCapabilityKeys(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      /^(?:telemetry|analytics|diagnostic|tracking|feature.?flag|backend|account|billing)$/iu.test(
        key,
      )
    ) {
      throw new Error(`Forbidden product capability key: ${path}.${key}`);
    }
    assertNoUnstructuredCapabilityKeys(nestedValue, `${path}.${key}`);
  }
}

async function discoverJavaScriptBundles(directoryPath) {
  const directoryEntries = (
    await readdir(directoryPath, {
      withFileTypes: true,
    })
  ).sort((leftEntry, rightEntry) =>
    leftEntry.name < rightEntry.name
      ? -1
      : leftEntry.name > rightEntry.name
        ? 1
        : 0,
  );
  const discoveredBundlePaths = [];
  for (const directoryEntry of directoryEntries) {
    const entryPath = join(directoryPath, directoryEntry.name);
    const entryStats = await lstat(entryPath);
    if (entryStats.isSymbolicLink()) {
      throw new Error(
        `Production audit rejects symlinked dist entry: ${entryPath}`,
      );
    }
    if (entryStats.isDirectory()) {
      discoveredBundlePaths.push(
        ...(await discoverJavaScriptBundles(entryPath)),
      );
      continue;
    }
    if (!directoryEntry.name.endsWith(".js")) continue;
    if (!entryStats.isFile()) {
      throw new Error(
        `Production audit rejects non-regular dist bundle: ${entryPath}`,
      );
    }
    discoveredBundlePaths.push(entryPath);
  }
  return discoveredBundlePaths;
}

function assertBundleNetworkSinkAllowlist(bundlePath, bundleContents) {
  const emittedUrls = new Set(bundleContents.match(emittedUrlPattern) ?? []);
  for (const emittedUrl of emittedUrls) {
    if (
      allowedNetworkSinks.has(emittedUrl) ||
      allowedNonSinkUrls.has(emittedUrl) ||
      ipv6ValidationUrlPattern.test(emittedUrl) ||
      emittedUrl.startsWith("https://github.com/${") ||
      emittedUrl.startsWith("https://dev.azure.com/${") ||
      emittedUrl.includes("json-schema.org/draft-07/schema") ||
      emittedUrl.includes("json-schema.org/draft-04/schema")
    )
      continue;
    throw new Error(
      `Unexpected emitted network sink URL in ${bundlePath}: ${emittedUrl}`,
    );
  }
}

export async function assertEmittedNetworkSinkAllowlist(repositoryRoot) {
  const distDirectoryPath = join(repositoryRoot, "dist");
  const emittedJavaScriptBundlePaths =
    await discoverJavaScriptBundles(distDirectoryPath);
  if (emittedJavaScriptBundlePaths.length === 0) {
    throw new Error(
      "Production audit requires at least one emitted JS bundle.",
    );
  }
  for (const emittedJavaScriptBundlePath of emittedJavaScriptBundlePaths) {
    const bundleContents = await readFile(emittedJavaScriptBundlePath, "utf8");
    assertBundleNetworkSinkAllowlist(
      relative(repositoryRoot, emittedJavaScriptBundlePath),
      bundleContents,
    );
  }
}

async function runProductionAudit(repositoryRoot) {
  const packageManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  for (const requiredManifestField of requiredManifestFields) {
    if (!packageManifest[requiredManifestField]) {
      throw new Error(`package.json is missing ${requiredManifestField}`);
    }
  }

  if (
    packageManifest.name !== "gito" ||
    packageManifest.publisher !== "overengineered-org"
  ) {
    throw new Error(
      "Extension identity does not match the Git'o naming contract.",
    );
  }
  if (packageManifest.license !== "Apache-2.0") {
    throw new Error("Extension must declare Apache-2.0 licensing.");
  }
  if (!/^\^\d+\.\d+\.\d+$/.test(packageManifest.engines.vscode)) {
    throw new Error(
      "engines.vscode must pin a minimum supported VS Code release.",
    );
  }
  if (!packageManifest.main.endsWith("dist/extension.js")) {
    throw new Error(
      "Production entry point must be the bundled extension host file.",
    );
  }
  if (packageManifest.icon !== "media/gito.png") {
    throw new Error(
      "Marketplace icon must be the derived media/gito.png asset.",
    );
  }
  await lstat(join(repositoryRoot, packageManifest.icon));

  assertStructuredManifestCapabilities(packageManifest);
  assertNoUnstructuredCapabilityKeys(packageManifest);
  await assertEmittedNetworkSinkAllowlist(repositoryRoot);

  outputLogger.log(
    `Production audit passed for VS Code ${packageManifest.engines.vscode}.`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runProductionAudit(join(import.meta.dirname, ".."));
}
