import { execFileSync, spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import process from "node:process";
import { join, resolve } from "node:path";
import { scanReadableForCredentials } from "./credential-detector.mjs";

const outputLogger = globalThis.console;
const repositoryRoot = resolve(import.meta.dirname, "..");
const releasePackagePattern = /^gito-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.vsix$/;
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertStructuredExtensionManifest(extensionManifest) {
  const untrustedWorkspaceCapability =
    extensionManifest.capabilities?.untrustedWorkspaces;
  if (untrustedWorkspaceCapability?.supported !== true) {
    throw new Error(
      "Packaged extension must declare structured untrusted-workspace support.",
    );
  }
  if (
    typeof untrustedWorkspaceCapability.description !== "string" ||
    !/trusted workspace|trust the workspace/iu.test(
      untrustedWorkspaceCapability.description,
    )
  ) {
    throw new Error(
      "Packaged extension must explain the trusted-workspace mutation boundary.",
    );
  }

  const contributedCommands = extensionManifest.contributes?.commands;
  if (!Array.isArray(contributedCommands) || contributedCommands.length === 0) {
    throw new Error("Packaged extension must declare structured commands.");
  }
  const commandIdentifiers = new Set();
  for (const contributedCommand of contributedCommands) {
    if (
      typeof contributedCommand?.command !== "string" ||
      contributedCommand.command.length === 0 ||
      typeof contributedCommand.title !== "string" ||
      contributedCommand.title.length === 0 ||
      commandIdentifiers.has(contributedCommand.command)
    ) {
      throw new Error(
        "Packaged command contributions must be unique and typed.",
      );
    }
    commandIdentifiers.add(contributedCommand.command);
  }
  for (const activationEvent of extensionManifest.activationEvents ?? []) {
    if (
      typeof activationEvent === "string" &&
      activationEvent.startsWith("onCommand:") &&
      !commandIdentifiers.has(activationEvent.slice("onCommand:".length))
    ) {
      throw new Error(
        `Activation event has no matching command contribution: ${activationEvent}`,
      );
    }
  }
  for (const menuContributions of Object.values(
    extensionManifest.contributes?.menus ?? {},
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

const packagePathArgument = process.argv[2];
let releasePackagePath;
if (packagePathArgument) {
  releasePackagePath = resolve(process.cwd(), packagePathArgument);
} else {
  const releaseOutputDirectory = join(repositoryRoot, "dist");
  const releasePackageNames = (await readdir(releaseOutputDirectory)).filter(
    (fileName) => releasePackagePattern.test(fileName),
  );
  if (releasePackageNames.length !== 1) {
    throw new Error(
      `Expected exactly one VSIX in dist; found ${releasePackageNames.length}.`,
    );
  }
  releasePackagePath = join(releaseOutputDirectory, releasePackageNames[0]);
}

const releasePackageName = releasePackagePath.split(/[/\\]/).at(-1);
const releasePackageStats = await lstat(releasePackagePath);
if (!releasePackageStats.isFile()) {
  throw new Error(
    `VSIX package must be a regular file: ${releasePackageName}.`,
  );
}
const releasePackageFileVersion =
  releasePackageName?.match(/^gito-(.+)\.vsix$/)?.[1];
const releaseVersionArgument = process.argv[3];
const releaseVersion = releaseVersionArgument ?? releasePackageFileVersion;
if (!releaseVersionPattern.test(releaseVersion ?? "")) {
  throw new Error(
    `Could not determine a semantic VSIX version from ${releasePackagePath}.`,
  );
}
if (releasePackageFileVersion !== releaseVersion) {
  throw new Error(
    `VSIX filename version mismatch for ${releasePackagePath}: expected ${releaseVersion}, found ${releasePackageFileVersion}.`,
  );
}

const archiveEntries = execFileSync("unzip", ["-Z1", releasePackagePath], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();

const expectedArchiveEntries = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/NOTICE",
  "extension/changelog.md",
  "extension/dist/extension.js",
  "extension/dist/graph.css",
  "extension/dist/graph.js",
  "extension/dist/codicon.ttf",
  "extension/dist/webview.css",
  "extension/dist/webview.js",
  "extension/media/gito.png",
  "extension/media/gito.svg",
  "extension/media/onboarding/setup.svg",
  "extension/package.json",
  "extension/readme.md",
  "extension/SUPPORT.md",
].sort();

if (JSON.stringify(archiveEntries) !== JSON.stringify(expectedArchiveEntries)) {
  throw new Error(
    `Unexpected VSIX archive contents for ${releasePackagePath}.\nExpected:\n${expectedArchiveEntries.join("\n")}\nActual:\n${archiveEntries.join("\n")}`,
  );
}

const archiveDetails = execFileSync("unzip", ["-Z", "-v", releasePackagePath], {
  encoding: "utf8",
});
const archiveEntryDetails = new Map();
const archiveDetailLines = archiveDetails.split(/\r?\n/u);
for (let lineIndex = 0; lineIndex < archiveDetailLines.length; lineIndex += 1) {
  if (!archiveDetailLines[lineIndex]?.startsWith("Central directory entry #"))
    continue;
  const blockEndIndex = archiveDetailLines.findIndex(
    (line, candidateIndex) =>
      candidateIndex > lineIndex &&
      line.startsWith("Central directory entry #"),
  );
  const blockLines = archiveDetailLines.slice(
    lineIndex,
    blockEndIndex < 0 ? undefined : blockEndIndex,
  );
  const entryName = blockLines
    .slice(2)
    .find(
      (line) =>
        line.trim().length > 0 &&
        !line.trim().startsWith("There are an extra "),
    )
    ?.trim();
  const fileAttributes = blockLines
    .find((line) => line.includes("Unix file attributes ("))
    ?.split(":", 2)[1]
    ?.trim();
  if (entryName === undefined || entryName.length === 0) continue;
  if (!/^[r-][rwx-]{9}$/u.test(fileAttributes ?? "")) {
    throw new Error(`VSIX archive entry is not a regular file: ${entryName}.`);
  }
  archiveEntryDetails.set(entryName, fileAttributes);
}
if (archiveEntryDetails.size !== archiveEntries.length) {
  throw new Error(
    `VSIX archive regular-file metadata was incomplete: expected ${archiveEntries.length}, found ${archiveEntryDetails.size}.`,
  );
}

async function scanArchiveForCredentials() {
  const childProcess = spawn("unzip", ["-p", releasePackagePath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let scanError;
  const scanPromise = scanReadableForCredentials(
    childProcess.stdout,
    `VSIX archive contents ${releasePackagePath}`,
  ).catch((error) => {
    scanError = error;
    childProcess.kill();
  });
  const exitCode = await new Promise((resolveExitCode, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", resolveExitCode);
  });
  await scanPromise;
  if (scanError !== undefined) throw scanError;
  if (exitCode !== 0)
    throw new Error(`Could not read VSIX archive ${releasePackagePath}.`);
}

await scanArchiveForCredentials();

const embeddedManifest = JSON.parse(
  execFileSync("unzip", ["-p", releasePackagePath, "extension/package.json"], {
    encoding: "utf8",
  }),
);
if (embeddedManifest.version !== releaseVersion) {
  throw new Error(
    `VSIX version mismatch for ${releasePackagePath}: expected ${releaseVersion}, found ${embeddedManifest.version}.`,
  );
}
assertStructuredExtensionManifest(embeddedManifest);

outputLogger.log(
  `Validated exact VSIX archive allowlist and embedded version ${releaseVersion}: ${archiveEntries.length} entries.`,
);
