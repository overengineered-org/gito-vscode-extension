import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";
import { readVSIXPackage } from "@vscode/vsce/out/zip.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createPackagedExtensionTestRootPath } from "./packaged-extension-test-support.mjs";
import {
  assertRegularFile,
  describeError,
  findInstalledExtension,
  findLogFiles,
  formatFailure,
  readVscodeVersion,
  resolveDownloadedVscodeExecutable,
  sha256File,
  writeRunMetadata,
} from "./vsix-runner-common.mjs";

const executeFile = promisify(execFile);
const extensionRootPath = resolve(import.meta.dirname, "..");
const extensionTestPath = resolve(
  extensionRootPath,
  "test",
  "extension",
  "performance",
);
const packagedExtensionIdentifier = "overengineered-org.gito";
const packagedActivationSampleCount = parseSampleCount(
  process.env.GITO_PACKAGED_ACTIVATION_SAMPLES,
);
const packagedActivationP95BudgetMilliseconds = 500;
const packagedVsixPath = resolve(
  process.argv[2] ?? process.env.GITO_VSIX_PATH ?? "",
);

if (!packagedVsixPath || packagedVsixPath === resolve(".")) {
  throw new Error(
    "Pass the exact VSIX path: node scripts/run-packaged-extension-tests.mjs path/to/gito.vsix",
  );
}
if (!packagedVsixPath.endsWith(".vsix")) {
  throw new Error(`Expected a .vsix file, received: ${packagedVsixPath}`);
}
await assertRegularFile(packagedVsixPath, "VSIX");

const packagedVsix = await readVSIXPackage(packagedVsixPath);
if (
  packagedVsix.manifest.publisher !== "overengineered-org" ||
  packagedVsix.manifest.name !== "gito"
) {
  throw new Error(
    `Expected VSIX ${packagedExtensionIdentifier}, received ${packagedVsix.manifest.publisher}.${packagedVsix.manifest.name}.`,
  );
}
const packagedExtensionVersion = packagedVsix.manifest.version;
const packagedVsixSha256 = await sha256File(packagedVsixPath);
const isolatedRootPath = await createPackagedExtensionTestRootPath();
const runMetadataPath = join(isolatedRootPath, "run-metadata.json");
const activationSamples = [];
let runFailure;

try {
  const vscodeVersion = process.env.GITO_VSCODE_VERSION ?? "stable";
  const downloadedVscodeExecutablePath = await downloadAndUnzipVSCode({
    version: vscodeVersion,
    extensionDevelopmentPath: extensionRootPath,
  });
  const vscodeExecutablePath = resolveDownloadedVscodeExecutable(
    downloadedVscodeExecutablePath,
  );
  const actualVscodeVersion = await readVscodeVersion(vscodeExecutablePath);

  for (
    let sampleIndex = 0;
    sampleIndex < packagedActivationSampleCount;
    sampleIndex += 1
  ) {
    const sampleRootPath = join(
      isolatedRootPath,
      `sample-${String(sampleIndex + 1).padStart(2, "0")}`,
    );
    const userDataDirectoryPath = join(sampleRootPath, "user-data");
    const extensionsDirectoryPath = join(sampleRootPath, "extensions");
    const activationDurationPath = join(
      sampleRootPath,
      "activation-duration-ms.txt",
    );
    await mkdir(sampleRootPath, { recursive: true });

    const [vscodeCliPath, ...vscodeCliProfileArguments] =
      resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
        reuseMachineInstall: true,
      });
    await executeFile(
      vscodeCliPath,
      [
        ...vscodeCliProfileArguments,
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--disable-updates",
        `--user-data-dir=${userDataDirectoryPath}`,
        `--extensions-dir=${extensionsDirectoryPath}`,
        "--install-extension",
        packagedVsixPath,
        "--force",
      ],
      {
        shell: process.platform === "win32",
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    const installedExtension = await findInstalledExtension(
      extensionsDirectoryPath,
      {
        extensionIdentifier: packagedExtensionIdentifier,
        extensionName: "gito",
        extensionPublisher: "overengineered-org",
      },
    );
    if (installedExtension.manifest.version !== packagedExtensionVersion) {
      throw new Error(
        `Installed ${packagedExtensionIdentifier} version ${installedExtension.manifest.version} does not match VSIX version ${packagedExtensionVersion}.`,
      );
    }

    const exitCode = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: installedExtension.path,
      extensionTestsPath: extensionTestPath,
      extensionTestsEnv: {
        GITO_PACKAGED_ACTIVATION_DURATION_PATH: activationDurationPath,
        GITO_PACKAGED_EXTENSION_PATH: installedExtension.path,
        GITO_PACKAGED_EXTENSION_VERSION: packagedExtensionVersion,
        GITO_PACKAGED_VSCODE_VERSION: actualVscodeVersion,
        GITO_PACKAGED_VSIX_PATH: packagedVsixPath,
        GITO_PACKAGED_VSIX_SHA256: packagedVsixSha256,
      },
      launchArgs: [
        `--user-data-dir=${userDataDirectoryPath}`,
        `--extensions-dir=${extensionsDirectoryPath}`,
      ],
      reuseMachineInstall: true,
    });
    if (exitCode !== 0) {
      throw new Error(
        `Packaged VSIX Extension Host sample ${sampleIndex + 1} exited with ${exitCode}.`,
      );
    }
    const postHostPackagedVsixSha256 = await sha256File(packagedVsixPath);
    if (postHostPackagedVsixSha256 !== packagedVsixSha256) {
      throw new Error(
        `Packaged VSIX changed after Extension Host sample ${sampleIndex + 1}: expected ${packagedVsixSha256}, found ${postHostPackagedVsixSha256}.`,
      );
    }
    const activationElapsedMilliseconds = Number(
      await readFile(activationDurationPath, "utf8"),
    );
    if (!Number.isFinite(activationElapsedMilliseconds)) {
      throw new Error(
        `Packaged VSIX sample ${sampleIndex + 1} did not report an activation duration.`,
      );
    }
    activationSamples.push(activationElapsedMilliseconds);
  }

  const sortedSamples = [...activationSamples].sort(
    (leftSample, rightSample) => leftSample - rightSample,
  );
  const p95Index = Math.min(
    sortedSamples.length - 1,
    Math.ceil(sortedSamples.length * 0.95) - 1,
  );
  const activationP95Milliseconds = sortedSamples[p95Index];
  if (activationP95Milliseconds > packagedActivationP95BudgetMilliseconds) {
    throw new Error(
      `packaged activation p95 ${activationP95Milliseconds.toFixed(2)} ms exceeds ${packagedActivationP95BudgetMilliseconds} ms`,
    );
  }
  await writeRunMetadata(runMetadataPath, {
    actualVscodeVersion,
    activationSamples,
    packagedActivationP95BudgetMilliseconds,
    packagedActivationP95Milliseconds: activationP95Milliseconds,
    packagedActivationSampleCount,
    packagedExtensionIdentifier,
    packagedExtensionVersion,
    packagedVsixPath,
    packagedVsixSha256,
    requestedVscodeVersion: vscodeVersion,
  });
} catch (error) {
  runFailure = error;
  throw error;
} finally {
  const logPaths = await findLogFiles(isolatedRootPath);
  if (
    runFailure !== undefined ||
    process.env.GITO_KEEP_TEST_ARTIFACTS === "1"
  ) {
    await writeRunMetadata(runMetadataPath, {
      completed: runFailure === undefined,
      failure: runFailure === undefined ? undefined : describeError(runFailure),
      logPaths,
    });
    if (runFailure !== undefined) {
      process.stderr.write(
        formatFailure(runFailure, logPaths, "Packaged VSIX Extension Host"),
      );
    }
    process.stderr.write(`Packaged VSIX run artifacts: ${isolatedRootPath}\n`);
  } else {
    await rm(isolatedRootPath, { recursive: true, force: true });
  }
}

function parseSampleCount(rawSampleCount) {
  if (rawSampleCount === undefined) return 9;
  const parsedSampleCount = Number(rawSampleCount);
  if (!Number.isInteger(parsedSampleCount) || parsedSampleCount < 1) {
    throw new Error(
      `GITO_PACKAGED_ACTIVATION_SAMPLES must be a positive integer, received: ${rawSampleCount}`,
    );
  }
  return parsedSampleCount;
}
