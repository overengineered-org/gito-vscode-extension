import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { readVSIXPackage } from "@vscode/vsce/out/zip.js";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";
import { clearTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
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
import { seedTrustedWorkspace } from "./installed-vsix-trust.mjs";
import { calculateSourceTreeFingerprint } from "./source-tree-fingerprint.mjs";

const require = createRequire(import.meta.url);
const {
  parseCompletedTestDriverResult,
} = require("../test/extension/installed/test-driver-result.cjs");
const executeFile = promisify(execFile);
const extensionRootPath = resolve(import.meta.dirname, "..");
const extensionTestPath = resolve(
  extensionRootPath,
  "test",
  "extension",
  "installed",
);
const extensionIdentifier = "overengineered-org.gito";
const extensionName = "gito";
const extensionPublisher = "overengineered-org";
const installedExtensionHostTimeoutMilliseconds = 5 * 60 * 1000;
const processTerminationSettleTimeoutMilliseconds = 5_000;
const installedTestResultPollMilliseconds = 100;
const packagedVsixPath = resolve(
  process.argv[2] ?? process.env.GITO_VSIX_PATH ?? "",
);

if (!packagedVsixPath || packagedVsixPath === resolve(".")) {
  throw new Error(
    "Pass the exact VSIX path: node scripts/run-installed-vsix-tests.mjs path/to/gito.vsix",
  );
}
if (!packagedVsixPath.endsWith(".vsix")) {
  throw new Error(`Expected a .vsix file, received: ${packagedVsixPath}`);
}
await assertRegularFile(packagedVsixPath, "VSIX");

const runStartedAtMilliseconds = Date.now();
const packagedVsix = await readVSIXPackage(packagedVsixPath);
if (
  packagedVsix.manifest.name !== extensionName ||
  packagedVsix.manifest.publisher !== extensionPublisher
) {
  throw new Error(
    `Expected VSIX ${extensionIdentifier}, received ${packagedVsix.manifest.publisher}.${packagedVsix.manifest.name}.`,
  );
}
const packagedExtensionVersion = packagedVsix.manifest.version;
const packagedVsixSha256 = await sha256File(packagedVsixPath);
const commitSha = await readCurrentCommitSha();
const sourceTreeSha256 =
  await calculateSourceTreeFingerprint(extensionRootPath);
const releaseMetadata = await readReleaseMetadataAttestation({
  packagedVsixPath,
  packagedExtensionVersion,
  packagedVsixSha256,
  commitSha,
  sourceTreeSha256,
});
const isolatedRootPath = await mkdtemp(join(tmpdir(), "gito-installed-vsix-"));
const userDataDirectoryPath = join(isolatedRootPath, "user-data");
const extensionsDirectoryPath = join(isolatedRootPath, "extensions");
const sharedDataDirectoryPath = join(isolatedRootPath, "shared-data");
const repositoryPath = join(isolatedRootPath, "repository");
const runMetadataPath = join(isolatedRootPath, "run-metadata.json");
const testDriverResultPath = join(isolatedRootPath, "test-driver-result.json");
let runFailure;

try {
  const hostEnvironment =
    await createInstalledHostEnvironment(isolatedRootPath);
  await createDisposableRepository(repositoryPath, hostEnvironment);
  const isolatedUserSettingsDirectoryPath = join(userDataDirectoryPath, "User");
  await mkdir(isolatedUserSettingsDirectoryPath, { recursive: true });
  await writeFile(
    join(isolatedUserSettingsDirectoryPath, "settings.json"),
    `${JSON.stringify(
      {
        "gito.developerDiagnostics": true,
        "gito.history.enabled": true,
        "gito.history.blame.enabled": true,
        "gito.history.codeLens.enabled": true,
      },
      null,
      2,
    )}\n`,
  );

  const vscodeVersion = process.env.GITO_VSCODE_VERSION ?? "stable";
  const downloadedVscodeExecutablePath = await downloadAndUnzipVSCode({
    version: vscodeVersion,
    extensionDevelopmentPath: extensionRootPath,
  });
  const vscodeExecutablePath = resolveDownloadedVscodeExecutable(
    downloadedVscodeExecutablePath,
  );
  const actualVscodeVersion = await readVscodeVersion(vscodeExecutablePath);
  await writeRunMetadata(runMetadataPath, {
    extensionIdentifier,
    packagedVsixPath,
    packagedVsixSha256,
    packagedExtensionVersion,
    repositoryPath,
    requestedVscodeVersion: vscodeVersion,
    actualVscodeVersion,
    commitSha,
    sourceTreeSha256,
    releaseMetadata: releaseMetadata.metadata,
    userDataDirectoryPath,
    extensionsDirectoryPath,
    sharedDataDirectoryPath,
    testDriverResultPath,
  });
  await seedTrustedWorkspace({
    repositoryPath,
    sharedDataDirectoryPath,
    executeSqlite: executeFile,
  });

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
      "--disable-telemetry",
      `--user-data-dir=${userDataDirectoryPath}`,
      `--extensions-dir=${extensionsDirectoryPath}`,
      `--shared-data-dir=${sharedDataDirectoryPath}`,
      "--install-extension",
      packagedVsixPath,
      "--force",
    ],
    {
      env: hostEnvironment,
      shell: process.platform === "win32",
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  const installedExtension = await findInstalledExtension(
    extensionsDirectoryPath,
    { extensionIdentifier, extensionName, extensionPublisher },
  );
  if (installedExtension.manifest.version === undefined) {
    throw new Error(
      `Installed ${extensionIdentifier} has no package version: ${installedExtension.path}`,
    );
  }
  const extensionVersion = installedExtension.manifest.version;
  if (extensionVersion !== packagedExtensionVersion) {
    throw new Error(
      `Installed ${extensionIdentifier} version ${extensionVersion} does not match VSIX version ${packagedExtensionVersion}.`,
    );
  }
  await writeRunMetadata(runMetadataPath, {
    installedExtensionPath: installedExtension.path,
    installedExtensionVersion: extensionVersion,
  });

  const { testDriverResult } = await launchExactExtensionHost({
    vscodeExecutablePath,
    testDriverExtensionPath: extensionTestPath,
    repositoryPath,
    userDataDirectoryPath,
    extensionsDirectoryPath,
    sharedDataDirectoryPath,
    testDriverResultPath,
    environment: hostEnvironment,
    extensionTestsEnv: {
      GITO_INSTALLED_EXTENSION_PATH: installedExtension.path,
      GITO_INSTALLED_EXTENSION_VERSION: extensionVersion,
      GITO_INSTALLED_REPOSITORY_PATH: repositoryPath,
      GITO_INSTALLED_VSIX_PATH: packagedVsixPath,
      GITO_INSTALLED_VSIX_SHA256: packagedVsixSha256,
      GITO_INSTALLED_VSCODE_VERSION: actualVscodeVersion,
      GITO_INSTALLED_COMMIT_SHA: commitSha,
      GITO_INSTALLED_SOURCE_TREE_SHA256: sourceTreeSha256,
      GITO_INSTALLED_RELEASE_METADATA_SHA256: releaseMetadata.metadata.sha256,
      GITO_INSTALLED_RELEASE_METADATA_VERSION: releaseMetadata.metadata.version,
      GITO_TEST_RUN_DIRECTORY: isolatedRootPath,
      GITO_INSTALLED_TEST_RESULT_PATH: testDriverResultPath,
    },
  });
  if (testDriverResult.passed !== true) {
    throw new Error(
      `Installed VSIX test driver failed: ${testDriverResult.error?.message ?? "unknown failure"}`,
    );
  }
  await writeRunMetadata(runMetadataPath, { testDriverResult });
  const postHostInstalledVsixSha256 = await sha256File(packagedVsixPath);
  if (postHostInstalledVsixSha256 !== packagedVsixSha256) {
    throw new Error(
      `Installed VSIX changed after Extension Host: expected ${packagedVsixSha256}, found ${postHostInstalledVsixSha256}.`,
    );
  }
} catch (error) {
  runFailure = error;
  throw error;
} finally {
  const retainedArtifactPaths = await describeFailureArtifacts(
    isolatedRootPath,
    runStartedAtMilliseconds,
    runFailure?.signal === "SIGABRT",
  );
  const keepRunArtifacts =
    runFailure !== undefined || process.env.GITO_KEEP_TEST_ARTIFACTS === "1";
  if (keepRunArtifacts) {
    await writeRunMetadata(runMetadataPath, {
      completed: runFailure === undefined,
      failure: runFailure === undefined ? undefined : describeError(runFailure),
      retainedArtifactPaths,
    });
    if (runFailure !== undefined) {
      process.stderr.write(
        `${formatFailure(runFailure, retainedArtifactPaths, "Installed VSIX Extension Host")}\n`,
      );
    }
    process.stderr.write(`Installed VSIX run artifacts: ${isolatedRootPath}\n`);
  } else {
    await rm(isolatedRootPath, { recursive: true, force: true });
  }
}

/**
 * Launches the downloaded executable directly. VS Code intentionally uses
 * in-memory storage whenever `--extensionTestsPath` is present, so a normal
 * development-host driver runs the assertions instead. Git'o remains the
 * exact installed extension, and the disposable workspace must load its
 * pre-seeded trust record from persistent isolated shared storage.
 */
async function launchExactExtensionHost({
  vscodeExecutablePath,
  testDriverExtensionPath,
  repositoryPath,
  userDataDirectoryPath,
  extensionsDirectoryPath,
  sharedDataDirectoryPath,
  testDriverResultPath,
  environment,
  extensionTestsEnv,
}) {
  const launchArguments = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--disable-telemetry",
    "--skip-welcome",
    "--skip-release-notes",
    `--extensionDevelopmentPath=${testDriverExtensionPath}`,
    repositoryPath,
    join(repositoryPath, "change.gito-proof"),
    `--user-data-dir=${userDataDirectoryPath}`,
    `--extensions-dir=${extensionsDirectoryPath}`,
    `--shared-data-dir=${sharedDataDirectoryPath}`,
  ];
  if (
    launchArguments.some(
      (launchArgument) =>
        launchArgument === "--disable-workspace-trust" ||
        launchArgument.startsWith("--disable-workspace-trust=") ||
        launchArgument.startsWith("--extensionTestsPath="),
    )
  ) {
    throw new Error(
      "Installed VSIX runner must use persistent Workspace Trust storage; refusing to launch.",
    );
  }
  await rm(testDriverResultPath, { force: true });
  await rm(`${testDriverResultPath}.tmp`, { force: true });
  return new Promise((resolveHostRun, rejectLaunch) => {
    const extensionHostProcess = spawn(vscodeExecutablePath, launchArguments, {
      detached: process.platform !== "win32",
      env: { ...environment, ...extensionTestsEnv },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    extensionHostProcess.stdout.on("data", (chunk) =>
      process.stdout.write(chunk),
    );
    extensionHostProcess.stderr.on("data", (chunk) =>
      process.stderr.write(chunk),
    );
    let spawnError;
    let timedOut = false;
    let settled = false;
    let testDriverResult;
    let terminationPromise;
    let terminationSettleTimer;
    let resultPollTimer;
    let timeoutTimer;
    let resultPollInFlight = false;
    const clearLifecycleTimers = () => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (resultPollTimer !== undefined) clearTimeout(resultPollTimer);
      if (terminationSettleTimer !== undefined)
        clearTimeout(terminationSettleTimer);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers();
      rejectLaunch(error);
    };
    const resolveOnce = (exitCode) => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers();
      resolveHostRun({ exitCode, testDriverResult });
    };
    const beginTermination = (terminationReason) => {
      if (terminationPromise !== undefined) return terminationPromise;
      terminationPromise = terminateProcessTree(extensionHostProcess);
      terminationSettleTimer = scheduleTimeout(
        () =>
          rejectOnce(
            new Error(
              `Installed VSIX Extension Host did not terminate after ${terminationReason}.`,
            ),
          ),
        processTerminationSettleTimeoutMilliseconds,
      );
      terminationPromise.catch(rejectOnce);
      return terminationPromise;
    };
    const readResultIfComplete = async () => {
      let serializedResult;
      try {
        serializedResult = await readFile(testDriverResultPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
      return parseCompletedTestDriverResult(serializedResult);
    };
    const pollForTestDriverResult = async () => {
      if (settled || resultPollInFlight) return;
      resultPollInFlight = true;
      try {
        const completedResult = await readResultIfComplete();
        if (completedResult !== undefined && !settled) {
          testDriverResult = completedResult;
          beginTermination("test driver result");
          return;
        }
      } catch (error) {
        rejectOnce(error);
        return;
      } finally {
        resultPollInFlight = false;
      }
      if (!settled)
        resultPollTimer = scheduleTimeout(
          pollForTestDriverResult,
          installedTestResultPollMilliseconds,
        );
    };
    const timeoutError = new Error(
      `Installed VSIX Extension Host exceeded ${installedExtensionHostTimeoutMilliseconds}ms.`,
    );
    timeoutError.code = "ETIMEDOUT";
    timeoutTimer = scheduleTimeout(() => {
      timedOut = true;
      beginTermination("the host deadline");
    }, installedExtensionHostTimeoutMilliseconds);
    extensionHostProcess.once("error", (error) => {
      spawnError = error;
    });
    extensionHostProcess.once("close", async (exitCode, signal) => {
      try {
        if (testDriverResult === undefined) {
          testDriverResult = await readResultIfComplete();
          if (testDriverResult !== undefined) beginTermination("host close");
        }
        await terminationPromise;
      } catch (error) {
        rejectOnce(error);
        return;
      }
      if (settled) return;
      if (testDriverResult !== undefined) {
        resolveOnce(exitCode ?? 0);
        return;
      }
      if (timedOut) {
        rejectOnce(timeoutError);
        return;
      }
      if (spawnError !== undefined) {
        rejectOnce(spawnError);
        return;
      }
      if (exitCode === 0) {
        rejectOnce(
          new Error(
            "Installed VSIX Extension Host exited before writing its test driver result.",
          ),
        );
        return;
      }
      const launchError = new Error(
        `Installed VSIX Extension Host exited with ${exitCode ?? signal ?? "unknown"}.`,
      );
      launchError.code = exitCode ?? undefined;
      launchError.signal = signal ?? undefined;
      rejectOnce(launchError);
    });
    void pollForTestDriverResult();
  });
}

async function terminateProcessTree(childProcess) {
  if (childProcess.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      await executeFile(
        "taskkill",
        ["/pid", String(childProcess.pid), "/t", "/f"],
        { encoding: "utf8", windowsHide: true },
      );
    } catch (error) {
      if (error?.code !== 128 && error?.code !== "ESRCH") throw error;
    }
    return;
  }
  try {
    process.kill(-childProcess.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await delay(250);
  try {
    process.kill(-childProcess.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  try {
    process.kill(-childProcess.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function createInstalledHostEnvironment(isolatedRootPath) {
  const isolatedHomePath = join(isolatedRootPath, "home");
  const isolatedTempPath = join(isolatedRootPath, "tmp");
  const isolatedConfigPath = join(isolatedRootPath, "config");
  const isolatedCachePath = join(isolatedRootPath, "cache");
  const isolatedDataPath = join(isolatedRootPath, "data");
  const isolatedStatePath = join(isolatedRootPath, "state");
  const isolatedRuntimePath = join(isolatedRootPath, "runtime");
  await mkdir(isolatedHomePath, { recursive: true });
  await mkdir(isolatedTempPath, { recursive: true });
  await mkdir(isolatedConfigPath, { recursive: true });
  await mkdir(isolatedCachePath, { recursive: true });
  await mkdir(isolatedDataPath, { recursive: true });
  await mkdir(isolatedStatePath, { recursive: true });
  await mkdir(isolatedRuntimePath, { recursive: true, mode: 0o700 });
  const isolatedGlobalGitConfigPath = join(isolatedHomePath, ".gitconfig");
  await writeFile(isolatedGlobalGitConfigPath, "", "utf8");

  const environmentVariableNames = [
    "ComSpec",
    "DISPLAY",
    "ELECTRON_OZONE_PLATFORM_HINT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "SHELL",
    "SystemDrive",
    "SystemRoot",
    "TERM",
    "USERDOMAIN",
    "USERNAME",
    "WAYLAND_DISPLAY",
    "WINDIR",
    "XDG_SESSION_TYPE",
  ];
  const environment = Object.fromEntries(
    environmentVariableNames.flatMap((environmentVariableName) => {
      const environmentValue = process.env[environmentVariableName];
      return environmentValue === undefined
        ? []
        : [[environmentVariableName, environmentValue]];
    }),
  );
  environment.PATH ??= process.env.Path ?? "";
  environment.HOME = isolatedHomePath;
  environment.USERPROFILE = isolatedHomePath;
  environment.APPDATA = join(isolatedHomePath, "AppData", "Roaming");
  environment.LOCALAPPDATA = join(isolatedHomePath, "AppData", "Local");
  environment.TMPDIR = isolatedTempPath;
  environment.TMP = isolatedTempPath;
  environment.TEMP = isolatedTempPath;
  environment.XDG_CONFIG_HOME = isolatedConfigPath;
  environment.XDG_CACHE_HOME = isolatedCachePath;
  environment.XDG_DATA_HOME = isolatedDataPath;
  environment.XDG_STATE_HOME = isolatedStatePath;
  environment.XDG_RUNTIME_DIR = isolatedRuntimePath;
  environment.GIT_CONFIG_GLOBAL = isolatedGlobalGitConfigPath;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.VSCODE_DISABLE_TELEMETRY = "1";
  environment.VSCODE_DISABLE_CRASH_REPORTER = "1";
  return environment;
}

async function createDisposableRepository(
  repositoryDirectoryPath,
  environment,
) {
  await mkdir(repositoryDirectoryPath, { recursive: true });
  await runGit(
    repositoryDirectoryPath,
    ["init", "-b", "main", "."],
    environment,
  );
  await runGit(
    repositoryDirectoryPath,
    ["config", "user.name", "Git'o Integration Fixture"],
    environment,
  );
  await runGit(
    repositoryDirectoryPath,
    ["config", "user.email", "gito-installed-vsix@example.test"],
    environment,
  );
  await writeFile(join(repositoryDirectoryPath, "README.md"), "fixture\n");
  await writeFile(
    join(repositoryDirectoryPath, "diff.txt"),
    "installed VSIX diff baseline\n",
  );
  await runGit(
    repositoryDirectoryPath,
    ["add", "README.md", "diff.txt"],
    environment,
  );
  await runGit(
    repositoryDirectoryPath,
    ["commit", "-m", "test: installed VSIX fixture"],
    environment,
  );
  await writeFile(
    join(repositoryDirectoryPath, "change.gito-proof"),
    "installed VSIX integration\n",
  );
}

async function runGit(repositoryDirectoryPath, gitArguments, environment) {
  await executeFile("git", gitArguments, {
    cwd: repositoryDirectoryPath,
    env: environment,
    shell: false,
    encoding: "utf8",
  });
}

async function readCurrentCommitSha() {
  const result = await executeFile("git", ["rev-parse", "HEAD"], {
    cwd: extensionRootPath,
    encoding: "utf8",
  });
  const currentCommitSha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(currentCommitSha))
    throw new Error(`Current Git commit SHA is invalid: ${currentCommitSha}`);
  return currentCommitSha;
}

async function readReleaseMetadataAttestation({
  packagedVsixPath,
  packagedExtensionVersion,
  packagedVsixSha256,
  commitSha,
  sourceTreeSha256,
}) {
  const releaseMetadataPath = resolve(
    process.env.GITO_RELEASE_METADATA_PATH ??
      join(extensionRootPath, "dist", "release-metadata.json"),
  );
  let releaseMetadataText;
  try {
    releaseMetadataText = await readFile(releaseMetadataPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Release metadata is required for an installed-tested run: ${releaseMetadataPath}`,
        { cause: error },
      );
    }
    throw new Error(
      `Unable to read release metadata ${releaseMetadataPath}: ${error.message}`,
      { cause: error },
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(releaseMetadataText);
  } catch (error) {
    throw new Error(
      `Release metadata is not valid JSON: ${releaseMetadataPath}`,
      { cause: error },
    );
  }
  const expectedAssetName = basename(packagedVsixPath);
  if (
    metadata.assetName !== expectedAssetName ||
    metadata.checksumAssetName !== `${expectedAssetName}.sha256` ||
    metadata.version !== packagedExtensionVersion ||
    metadata.tag !== `v${packagedExtensionVersion}` ||
    metadata.sha256 !== packagedVsixSha256 ||
    metadata.commitSha !== commitSha ||
    metadata.sourceTreeSha256 !== sourceTreeSha256
  ) {
    throw new Error(
      `Release metadata is stale or does not bind to ${expectedAssetName} at ${commitSha}.`,
    );
  }
  return { path: releaseMetadataPath, metadata };
}

async function describeFailureArtifacts(
  isolatedRootPath,
  runStartedAt,
  includeDelayedReports,
) {
  const artifactPaths = await findLogFiles(isolatedRootPath, [".log", ".ips"]);
  if (process.platform !== "darwin" || !includeDelayedReports)
    return artifactPaths;

  // macOS may write DiagnosticReports shortly after the child exits.
  const diagnosticReportPaths = await waitForDiagnosticReports(runStartedAt);
  artifactPaths.push(...diagnosticReportPaths);
  return [...new Set(artifactPaths)];
}

async function waitForDiagnosticReports(runStartedAt) {
  const diagnosticReportDirectoryPath = join(
    homedir(),
    "Library",
    "Logs",
    "DiagnosticReports",
  );
  for (let reportPollIndex = 0; reportPollIndex < 30; reportPollIndex += 1) {
    const diagnosticReportPaths = await findRecentDiagnosticReports(
      diagnosticReportDirectoryPath,
      runStartedAt,
    );
    if (diagnosticReportPaths.length > 0) return diagnosticReportPaths;
    await delay(500);
  }
  return [];
}

async function findRecentDiagnosticReports(
  diagnosticReportDirectoryPath,
  runStartedAt,
) {
  let diagnosticReportEntries;
  try {
    diagnosticReportEntries = await readdir(diagnosticReportDirectoryPath, {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const diagnosticReportPaths = [];
  for (const diagnosticReportEntry of diagnosticReportEntries) {
    if (!diagnosticReportEntry.isFile()) continue;
    if (!diagnosticReportEntry.name.startsWith("Code-")) continue;
    const diagnosticReportPath = join(
      diagnosticReportDirectoryPath,
      diagnosticReportEntry.name,
    );
    const diagnosticReportStat = await stat(diagnosticReportPath);
    if (diagnosticReportStat.mtimeMs >= runStartedAt - 1_000) {
      diagnosticReportPaths.push(diagnosticReportPath);
    }
  }
  return diagnosticReportPaths;
}
