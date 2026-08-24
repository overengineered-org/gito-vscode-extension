import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from "@vscode/test-electron";
import { readVSIXPackage } from "@vscode/vsce/out/zip.js";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import {
  assertRegularFile,
  findInstalledExtension,
  findLogFiles,
  readVscodeVersion,
  resolveDownloadedVscodeExecutable,
  sha256File,
  writeRunMetadata,
} from "./vsix-runner-common.mjs";
import { seedTrustedWorkspace } from "./installed-vsix-trust.mjs";
import { calculateSourceTreeFingerprint } from "./source-tree-fingerprint.mjs";

const executeFile = promisify(execFile);
const repositoryRootPath = resolve(import.meta.dirname, "..");
const visualDriverPath = resolve(
  repositoryRootPath,
  "test",
  "extension",
  "visual",
);
const visualOutputDirectoryPath = resolve(
  process.env.GITO_VISUAL_OUTPUT_DIR ?? join(tmpdir(), "gito-visual-artifacts"),
);
const packagedVsixPath = resolve(
  process.argv[2] ?? process.env.GITO_VSIX_PATH ?? "",
);
const visualHostTimeoutMilliseconds = 5 * 60 * 1000;
const visualPollMilliseconds = 100;
const visualDisplayWidth = 1440;
const visualDisplayHeight = 900;

const visualVariants = [
  { id: "dark-modern", theme: "Default Dark Modern", zoomLevel: 0 },
  { id: "light-modern", theme: "Default Light Modern", zoomLevel: 0 },
  {
    id: "dark-hc",
    theme: "Default High Contrast",
    zoomLevel: 0,
  },
  {
    id: "light-hc",
    theme: "Default High Contrast Light",
    zoomLevel: 0,
  },
  { id: "custom", theme: "Git'o Visual QA", zoomLevel: 0 },
  { id: "dark-modern-200", theme: "Default Dark Modern", zoomLevel: 2 },
  {
    id: "dark-modern-fc",
    theme: "Default Dark Modern",
    zoomLevel: 0,
    forcedColors: true,
  },
  {
    id: "dark-modern-rm",
    theme: "Default Dark Modern",
    zoomLevel: 0,
    reducedMotion: true,
  },
];

await assertVsixPath();
const packagedVsix = await readVSIXPackage(packagedVsixPath);
const packagedVsixSha256 = await sha256File(packagedVsixPath);
const packagedExtensionVersion = packagedVsix.manifest.version;
if (
  packagedVsix.manifest.publisher !== "overengineered-org" ||
  packagedVsix.manifest.name !== "gito"
) {
  throw new Error(
    `Expected overengineered-org.gito VSIX, received ${packagedVsix.manifest.publisher}.${packagedVsix.manifest.name}.`,
  );
}
const commitSha = await readCurrentCommitSha();
const sourceTreeSha256 =
  await calculateSourceTreeFingerprint(repositoryRootPath);
const releaseMetadata = await readReleaseMetadataAttestation({
  packagedVsixPath,
  packagedExtensionVersion,
  packagedVsixSha256,
  commitSha,
  sourceTreeSha256,
});
const requestedVscodeVersion = process.env.GITO_VSCODE_VERSION ?? "stable";
const visualRunRootPath = await mkdtemp(
  join(tmpdir(), "gito-installed-vsix-visual-"),
);
const visualRunMetadataPath = join(visualRunRootPath, "run-metadata.json");
const visualManifestEntries = [];
let actualVscodeVersion;

try {
  const hostEnvironment = await createVisualHostEnvironment(visualRunRootPath);
  const downloadedVscodeExecutablePath = await downloadAndUnzipVSCode({
    version: requestedVscodeVersion,
    extensionDevelopmentPath: repositoryRootPath,
  });
  const vscodeExecutablePath = resolveDownloadedVscodeExecutable(
    downloadedVscodeExecutablePath,
  );
  actualVscodeVersion = await readVscodeVersion(vscodeExecutablePath);
  await mkdir(visualOutputDirectoryPath, { recursive: true });
  await writeRunMetadata(visualRunMetadataPath, {
    actualVscodeVersion,
    commitSha,
    packagedExtensionVersion,
    packagedVsixPath: basename(packagedVsixPath),
    packagedVsixSha256,
    requestedVscodeVersion,
    sourceTreeSha256,
    visualDisplay: `${visualDisplayWidth}x${visualDisplayHeight}x24`,
    visualOutputDirectoryPath,
  });

  for (const visualVariant of visualVariants) {
    const variantResult = await runVisualVariant({
      actualVscodeVersion,
      commitSha,
      hostEnvironment,
      packagedExtensionVersion,
      packagedVsixSha256,
      releaseMetadata,
      visualVariant,
      vscodeExecutablePath,
    });
    visualManifestEntries.push(variantResult);
  }

  await writeFile(
    join(visualOutputDirectoryPath, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        commitSha,
        extension: "overengineered-org.gito",
        packagedExtensionVersion,
        packagedVsixSha256,
        sourceTreeSha256,
        vscodeVersion: actualVscodeVersion,
        display: {
          width: visualDisplayWidth,
          height: visualDisplayHeight,
          depth: 24,
          deviceScaleFactor: 1,
        },
        variants: visualManifestEntries,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  await writeRunMetadata(visualRunMetadataPath, {
    completed: false,
    error: serializeError(error),
  });
  throw error;
} finally {
  const retainTestArtifacts = process.env.GITO_KEEP_TEST_ARTIFACTS === "1";
  if (retainTestArtifacts && existsSync(visualRunMetadataPath)) {
    const currentRunMetadata = JSON.parse(
      await readFile(visualRunMetadataPath, "utf8"),
    );
    await writeRunMetadata(visualRunMetadataPath, {
      ...(currentRunMetadata.completed === false ? {} : { completed: true }),
      logs: await findLogFiles(visualRunRootPath),
    });
  }
  if (existsSync(visualRunMetadataPath)) {
    await writeFile(
      join(visualOutputDirectoryPath, "run-metadata.json"),
      await readFile(visualRunMetadataPath, "utf8"),
    );
  }
  if (!retainTestArtifacts) {
    await rm(visualRunRootPath, { recursive: true, force: true });
  } else {
    process.stderr.write(
      `Installed VSIX visual run artifacts: ${visualRunRootPath}\n`,
    );
  }
}

async function runVisualVariant({
  actualVscodeVersion,
  commitSha,
  hostEnvironment,
  packagedExtensionVersion,
  packagedVsixSha256,
  releaseMetadata,
  visualVariant,
  vscodeExecutablePath,
}) {
  const variantRootPath = join(visualRunRootPath, visualVariant.id);
  const userDataDirectoryPath = join(variantRootPath, "user-data");
  const extensionsDirectoryPath = join(variantRootPath, "extensions");
  const sharedDataDirectoryPath = join(variantRootPath, "shared-data");
  const repositoryPath = join(variantRootPath, "repository");
  const readyResultPath = join(variantRootPath, "visual-ready.json");
  const completedResultPath = join(variantRootPath, "visual-completed.json");
  const visualLogPath = join(variantRootPath, "vscode.log");
  const variantOutputDirectoryPath = join(
    visualOutputDirectoryPath,
    visualVariant.id,
  );
  await mkdir(variantRootPath, { recursive: true });
  await mkdir(variantOutputDirectoryPath, { recursive: true });
  await createDisposableVisualRepository(repositoryPath, hostEnvironment);
  await writeVisualSettings(userDataDirectoryPath, visualVariant);
  await seedTrustedWorkspace({
    repositoryPath,
    sharedDataDirectoryPath,
    executeSqlite: executeFile,
  });
  await installExactVsix({
    extensionsDirectoryPath,
    hostEnvironment,
    packagedVsixPath,
    userDataDirectoryPath,
    sharedDataDirectoryPath,
    vscodeExecutablePath,
  });
  const installedExtension = await findInstalledExtension(
    extensionsDirectoryPath,
    {
      extensionIdentifier: "overengineered-org.gito",
      extensionName: "gito",
      extensionPublisher: "overengineered-org",
    },
  );
  if (installedExtension.manifest.version !== packagedExtensionVersion) {
    throw new Error(
      `Installed VSIX version ${installedExtension.manifest.version} does not match ${packagedExtensionVersion}.`,
    );
  }

  const remoteDebuggingPort = await allocateTcpPort();
  const hostProcess = await spawnVisualHost({
    actualVscodeVersion,
    completedResultPath,
    commitSha,
    extensionsDirectoryPath,
    hostEnvironment,
    packagedVsixSha256,
    readyResultPath,
    remoteDebuggingPort,
    repositoryPath,
    sharedDataDirectoryPath,
    userDataDirectoryPath,
    variantRootPath,
    visualLogPath,
    visualVariant,
    vscodeExecutablePath,
  });
  let browser;
  let variantError;
  let visualEvidence;
  try {
    await waitForJsonResult(readyResultPath, "visual driver readiness");
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${remoteDebuggingPort}`,
    );
    visualEvidence = await captureVisualEvidence({
      actualVscodeVersion,
      browser,
      commitSha,
      outputDirectoryPath: variantOutputDirectoryPath,
      packagedExtensionVersion,
      packagedVsixSha256,
      releaseMetadata,
      visualVariant,
    });
    await writeJsonAtomically(completedResultPath, {
      passed: true,
      evidence: visualEvidence,
    });
  } catch (error) {
    variantError = error;
    await writeJsonAtomically(completedResultPath, {
      passed: false,
      error: serializeError(error),
    });
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
  }
  await waitForProcessExit(hostProcess, visualHostTimeoutMilliseconds);
  const finalDriverResult = JSON.parse(
    await readFile(completedResultPath, "utf8"),
  );
  if (
    finalDriverResult.passed !== true ||
    finalDriverResult.driverCompleted !== true
  ) {
    throw new Error(
      `Visual driver did not complete successfully for ${visualVariant.id}.`,
    );
  }
  const observedVsixSha256 = await sha256File(packagedVsixPath);
  if (observedVsixSha256 !== packagedVsixSha256) {
    throw new Error(
      `VSIX changed during ${visualVariant.id}: expected ${packagedVsixSha256}, found ${observedVsixSha256}.`,
    );
  }
  if (variantError !== undefined) throw variantError;
  return {
    id: visualVariant.id,
    theme: visualVariant.theme,
    zoomLevel: visualVariant.zoomLevel,
    forcedColors: visualVariant.forcedColors === true,
    reducedMotion: visualVariant.reducedMotion === true,
    baselineStatus: visualEvidence.metadata.baselineStatus,
    screenshotDirectory: visualVariant.id,
    vsixSha256: packagedVsixSha256,
  };
}

async function captureVisualEvidence({
  actualVscodeVersion,
  browser,
  commitSha,
  outputDirectoryPath,
  packagedExtensionVersion,
  packagedVsixSha256,
  releaseMetadata,
  visualVariant,
}) {
  const webviewDocument = await findRepositoryHomeWebview(browser);
  await emulateVisualMedia(webviewDocument.page, visualVariant);
  await settleWebview(webviewDocument.frame);
  const runtimeEvidence = await webviewDocument.frame.evaluate(
    collectRuntimeEvidence,
  );
  assertRuntimeEvidence(runtimeEvidence, visualVariant);
  const baselineStatus = resolveBaselineStatus(visualVariant.id);
  const keyboardEvidence = await collectKeyboardEvidence(webviewDocument.frame);
  const accessibilityEvidence = await collectAccessibilityEvidence(
    webviewDocument.frame,
  );
  const screenshotBytes = await webviewDocument.frame
    .locator("#gito-root")
    .screenshot({ animations: "disabled" });
  const screenshotPath = join(outputDirectoryPath, "repository-home.png");
  await writeFile(screenshotPath, screenshotBytes);
  const screenshotSha256 = createHash("sha256")
    .update(screenshotBytes)
    .digest("hex");
  const metadata = {
    schemaVersion: 1,
    commitSha,
    extension: "overengineered-org.gito",
    extensionVersion: packagedExtensionVersion,
    vsixSha256: packagedVsixSha256,
    sourceTreeSha256: releaseMetadata.metadata.sourceTreeSha256,
    vscodeVersion: actualVscodeVersion,
    variant: visualVariant.id,
    theme: visualVariant.theme,
    zoomLevel: visualVariant.zoomLevel,
    baselineStatus,
    hostDisplay: {
      width: visualDisplayWidth,
      height: visualDisplayHeight,
      depth: 24,
      deviceScaleFactor: 1,
    },
    forcedColors: visualVariant.forcedColors === true,
    reducedMotion: visualVariant.reducedMotion === true,
    viewport: runtimeEvidence.viewport,
    screenshotSha256,
  };
  await writeFile(
    join(outputDirectoryPath, "repository-home.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await writeFile(
    join(outputDirectoryPath, "runtime-evidence.json"),
    `${JSON.stringify(runtimeEvidence, null, 2)}\n`,
  );
  await writeFile(
    join(outputDirectoryPath, "keyboard-trace.json"),
    `${JSON.stringify(keyboardEvidence, null, 2)}\n`,
  );
  await writeFile(
    join(outputDirectoryPath, "accessibility.json"),
    `${JSON.stringify(accessibilityEvidence, null, 2)}\n`,
  );
  await compareWithApprovedBaseline({
    baselineStatus,
    outputDirectoryPath,
    screenshotBytes,
    visualVariant,
  });
  return {
    metadata,
    runtimeEvidence,
    keyboardEvidence,
    accessibilityEvidence,
  };
}

function resolveBaselineStatus(visualVariantId) {
  const baselineDirectoryPath = resolve(
    repositoryRootPath,
    "test",
    "visual",
    "golden",
    "repository-home",
  );
  const baselinePath = join(baselineDirectoryPath, `${visualVariantId}.png`);
  const approvalManifestPath = join(
    baselineDirectoryPath,
    "approval-manifest.json",
  );
  if (existsSync(baselinePath) && existsSync(approvalManifestPath)) {
    return process.env.GITO_VISUAL_CAPTURE_ONLY === "1"
      ? "capture-only"
      : "approved";
  }
  if (process.env.GITO_VISUAL_CAPTURE_ONLY === "1") return "missing";
  throw new Error(
    `Approved visual baseline or approval manifest is missing: ${baselinePath}, ${approvalManifestPath}. Capture candidates with GITO_VISUAL_CAPTURE_ONLY=1, then use the protected baseline approval workflow.`,
  );
}

async function compareWithApprovedBaseline({
  baselineStatus,
  outputDirectoryPath,
  screenshotBytes,
  visualVariant,
}) {
  const baselineDirectoryPath = resolve(
    repositoryRootPath,
    "test",
    "visual",
    "golden",
    "repository-home",
  );
  const baselinePath = join(baselineDirectoryPath, `${visualVariant.id}.png`);
  const diffPath = join(outputDirectoryPath, "baseline-diff.png");
  if (baselineStatus !== "approved") return;
  const actualImage = PNG.sync.read(screenshotBytes);
  const baselineImage = PNG.sync.read(await readFile(baselinePath));
  if (
    actualImage.width !== baselineImage.width ||
    actualImage.height !== baselineImage.height
  ) {
    throw new Error(
      `Visual baseline dimensions differ for ${visualVariant.id}: actual ${actualImage.width}x${actualImage.height}, baseline ${baselineImage.width}x${baselineImage.height}.`,
    );
  }
  const diffImage = new PNG({
    width: actualImage.width,
    height: actualImage.height,
  });
  const differingPixelCount = pixelmatch(
    baselineImage.data,
    actualImage.data,
    diffImage.data,
    actualImage.width,
    actualImage.height,
    { threshold: 0.1 },
  );
  if (differingPixelCount > 0) {
    await writeFile(diffPath, PNG.sync.write(diffImage));
    throw new Error(
      `Visual baseline differs for ${visualVariant.id}: ${differingPixelCount} pixels. Baselines require explicit approval; they are never updated automatically.`,
    );
  }
}

async function findRepositoryHomeWebview(browser) {
  const deadline = Date.now() + visualHostTimeoutMilliseconds;
  while (Date.now() < deadline) {
    for (const browserContext of browser.contexts()) {
      for (const page of browserContext.pages()) {
        for (const frame of page.frames()) {
          try {
            if ((await frame.locator("#gito-root").count()) > 0)
              return { frame, page };
          } catch {
            // The workbench can detach a Webview frame during theme startup.
          }
        }
      }
    }
    await delay(visualPollMilliseconds);
  }
  throw new Error(
    "Repository Home Webview did not appear in the real VS Code renderer.",
  );
}

async function settleWebview(frame) {
  await frame.locator("main.repository-home").waitFor({ state: "visible" });
  await frame.evaluate(async () => {
    const browserDocument = globalThis.document;
    await browserDocument.fonts.ready;
    await new Promise((resolve) =>
      globalThis.requestAnimationFrame(() =>
        globalThis.requestAnimationFrame(resolve),
      ),
    );
  });
}

async function emulateVisualMedia(page, visualVariant) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "forced-colors",
        value: visualVariant.forcedColors === true ? "active" : "none",
      },
      {
        name: "prefers-reduced-motion",
        value:
          visualVariant.reducedMotion === true ? "reduce" : "no-preference",
      },
    ],
  });
}

function collectRuntimeEvidence() {
  const browserDocument = globalThis.document;
  const browserWindow = globalThis.window;
  const root = browserDocument.documentElement;
  const body = browserDocument.body;
  const requiredSelectors = {
    root: "#gito-root",
    dashboard: "main.repository-home",
    title: "#repository-home-title",
    repositoryContext: "section[aria-label='Selected repository']",
    providerStrip: "section[aria-label='Cloud provider connections']",
    metrics: ".metrics-grid",
    commitActivity: ".commit-card",
    pullRequestGrid: ".pull-request-grid",
    health: "section[aria-label='Repository health']",
  };
  const regions = Object.fromEntries(
    Object.entries(requiredSelectors).map(([name, selector]) => {
      const element = browserDocument.querySelector(selector);
      const bounds = element?.getBoundingClientRect();
      return [
        name,
        {
          selector,
          present: element !== null,
          width: bounds?.width ?? 0,
          height: bounds?.height ?? 0,
          left: bounds?.left ?? 0,
          right: bounds?.right ?? 0,
          top: bounds?.top ?? 0,
          bottom: bounds?.bottom ?? 0,
        },
      ];
    }),
  );
  const metricCards = [...browserDocument.querySelectorAll(".metric-card")];
  const heatmapScrollRegion = browserDocument.querySelector(
    ".heatmap-scroll-region",
  );
  const computedRootStyle = globalThis.getComputedStyle(root);
  return {
    viewport: {
      width: browserWindow.innerWidth,
      height: browserWindow.innerHeight,
      devicePixelRatio: browserWindow.devicePixelRatio,
      documentWidth: root.clientWidth,
      documentHeight: root.clientHeight,
    },
    regions,
    metricCardCount: metricCards.length,
    pullRequestPanelCount: browserDocument.querySelectorAll(
      ".pull-request-panel",
    ).length,
    bodyOverflowX: body.scrollWidth - root.clientWidth,
    heatmapOverflowX: heatmapScrollRegion?.scrollWidth ?? 0,
    media: {
      forcedColors: browserWindow.matchMedia("(forced-colors: active)").matches,
      reducedMotion: browserWindow.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches,
    },
    themeVariables: {
      background: computedRootStyle
        .getPropertyValue("--gito-background")
        .trim(),
      text: computedRootStyle.getPropertyValue("--gito-text").trim(),
      border: computedRootStyle.getPropertyValue("--gito-border").trim(),
    },
    title: browserDocument
      .querySelector("#repository-home-title")
      ?.textContent?.trim(),
  };
}

function assertRuntimeEvidence(runtimeEvidence, visualVariant) {
  for (const [regionName, region] of Object.entries(runtimeEvidence.regions)) {
    if (!region.present || region.width <= 0 || region.height <= 0)
      throw new Error(
        `Visual anatomy region is missing or empty: ${regionName}.`,
      );
    if (region.left < -1 || region.right > runtimeEvidence.viewport.width + 1)
      throw new Error(
        `Visual anatomy region is clipped horizontally: ${regionName}.`,
      );
  }
  if (runtimeEvidence.title !== "Repository Home")
    throw new Error("Visual anatomy title is not Repository Home.");
  if (runtimeEvidence.metricCardCount !== 4)
    throw new Error(
      `Expected 4 metric cards, found ${runtimeEvidence.metricCardCount}.`,
    );
  if (runtimeEvidence.pullRequestPanelCount !== 2)
    throw new Error(
      `Expected 2 pull-request panels, found ${runtimeEvidence.pullRequestPanelCount}.`,
    );
  if (runtimeEvidence.bodyOverflowX > 1)
    throw new Error(
      `Unexpected dashboard horizontal overflow: ${runtimeEvidence.bodyOverflowX}px.`,
    );
  if (
    visualVariant.forcedColors === true &&
    !runtimeEvidence.media.forcedColors
  )
    throw new Error("Forced-colors evidence did not reach the real Webview.");
  if (
    visualVariant.reducedMotion === true &&
    !runtimeEvidence.media.reducedMotion
  )
    throw new Error("Reduced-motion evidence did not reach the real Webview.");
  for (const [variableName, variableValue] of Object.entries(
    runtimeEvidence.themeVariables,
  )) {
    if (variableValue.length === 0)
      throw new Error(`Theme variable is empty: ${variableName}.`);
  }
}

async function collectKeyboardEvidence(frame) {
  await frame
    .locator("body")
    .click({ position: { x: 4, y: 4 } })
    .catch(() => undefined);
  const focusTrace = [];
  for (let tabIndex = 0; tabIndex < 32; tabIndex += 1) {
    await frame.locator("body").press("Tab");
    const focusedControl = await frame.evaluate(() => {
      const browserDocument = globalThis.document;
      const element = browserDocument.activeElement;
      if (!(element instanceof globalThis.HTMLElement)) return undefined;
      const bounds = element.getBoundingClientRect();
      return {
        tagName: element.tagName,
        role: element.getAttribute("role"),
        name:
          element.getAttribute("aria-label") ??
          element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 120),
        visible: bounds.width > 0 && bounds.height > 0,
      };
    });
    if (focusedControl !== undefined) focusTrace.push(focusedControl);
  }
  const visibleFocusTrace = focusTrace.filter((focus) => focus.visible);
  if (visibleFocusTrace.length < 4)
    throw new Error(
      `Keyboard traversal reached only ${visibleFocusTrace.length} visible controls.`,
    );
  if (
    !visibleFocusTrace.some((focus) =>
      focus.name?.includes("Refresh repository dashboard"),
    )
  )
    throw new Error(
      "Keyboard traversal did not reach the dashboard refresh control.",
    );
  return { focusTrace: visibleFocusTrace };
}

async function collectAccessibilityEvidence(frame) {
  return frame.evaluate(() => {
    const browserDocument = globalThis.document;
    return {
      landmarks: [
        ...browserDocument.querySelectorAll("main, header, section"),
      ].map((element) => ({
        tagName: element.tagName,
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label"),
        labelledBy: element.getAttribute("aria-labelledby"),
      })),
      headings: [...browserDocument.querySelectorAll("h1, h2, h3")].map(
        (element) => ({
          level: Number(element.tagName.slice(1)),
          name: element.textContent?.trim(),
        }),
      ),
      controls: [...browserDocument.querySelectorAll("button, select, a")].map(
        (element) => ({
          tagName: element.tagName,
          role: element.getAttribute("role"),
          name:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 120),
          disabled:
            element instanceof globalThis.HTMLButtonElement ||
            element instanceof globalThis.HTMLSelectElement
              ? element.disabled
              : false,
        }),
      ),
    };
  });
}

async function spawnVisualHost({
  actualVscodeVersion,
  completedResultPath,
  commitSha,
  extensionsDirectoryPath,
  hostEnvironment,
  packagedVsixSha256,
  readyResultPath,
  remoteDebuggingPort,
  repositoryPath,
  sharedDataDirectoryPath,
  userDataDirectoryPath,
  variantRootPath,
  visualLogPath,
  visualVariant,
  vscodeExecutablePath,
}) {
  const launchArguments = [
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--disable-telemetry",
    "--skip-welcome",
    "--skip-release-notes",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--extensionDevelopmentPath=${visualDriverPath}`,
    repositoryPath,
    join(repositoryPath, "change.txt"),
    `--user-data-dir=${userDataDirectoryPath}`,
    `--extensions-dir=${extensionsDirectoryPath}`,
    `--shared-data-dir=${sharedDataDirectoryPath}`,
  ];
  const childProcess = spawn(vscodeExecutablePath, launchArguments, {
    detached: process.platform !== "win32",
    env: {
      ...hostEnvironment,
      GITO_VISUAL_RUN_DIRECTORY: variantRootPath,
      GITO_VISUAL_READY_PATH: readyResultPath,
      GITO_VISUAL_COMPLETED_PATH: completedResultPath,
      GITO_VISUAL_EXPECTED_THEME: visualVariant.theme,
      GITO_VISUAL_EXPECTED_ZOOM_LEVEL: String(visualVariant.zoomLevel),
      GITO_VISUAL_EXPECTED_VARIANT: visualVariant.id,
      GITO_VISUAL_VSIX_SHA256: packagedVsixSha256,
      GITO_VISUAL_VSCODE_VERSION: actualVscodeVersion,
      GITO_VISUAL_COMMIT_SHA: commitSha,
      GITO_VISUAL_REPOSITORY_PATH: repositoryPath,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = [];
  childProcess.stdout.on("data", (chunk) => logStream.push(chunk.toString()));
  childProcess.stderr.on("data", (chunk) => logStream.push(chunk.toString()));
  childProcess.once("close", () => {
    void writeFile(visualLogPath, logStream.join(""));
  });
  childProcess.once("error", (error) =>
    logStream.push(`${serializeError(error).message}\n`),
  );
  return childProcess;
}

async function waitForProcessExit(childProcess, timeoutMilliseconds) {
  if (childProcess.exitCode !== null) {
    assertSuccessfulHostExit(childProcess.exitCode, childProcess.signalCode);
    return;
  }
  const exitStatus = await new Promise((resolveProcess, rejectProcess) => {
    const timeout = globalThis.setTimeout(() => {
      void terminateProcessTree(childProcess).finally(() =>
        rejectProcess(
          new Error(`Visual VS Code host exceeded ${timeoutMilliseconds}ms.`),
        ),
      );
    }, timeoutMilliseconds);
    childProcess.once("close", (exitCode, signalCode) => {
      globalThis.clearTimeout(timeout);
      resolveProcess({ exitCode, signalCode });
    });
    childProcess.once("error", (error) => {
      globalThis.clearTimeout(timeout);
      rejectProcess(error);
    });
  });
  assertSuccessfulHostExit(exitStatus.exitCode, exitStatus.signalCode);
}

function assertSuccessfulHostExit(exitCode, signalCode) {
  if (exitCode !== 0 || (signalCode !== null && signalCode !== undefined)) {
    throw new Error(
      `Visual VS Code host exited unsuccessfully (code=${exitCode ?? "null"}, signal=${signalCode ?? "none"}).`,
    );
  }
}

async function terminateProcessTree(childProcess) {
  if (childProcess.pid === undefined) return;
  if (process.platform === "win32") {
    await executeFile(
      "taskkill",
      ["/pid", String(childProcess.pid), "/t", "/f"],
      {
        windowsHide: true,
      },
    ).catch((error) => {
      if (error?.code !== 128 && error?.code !== "ESRCH") throw error;
    });
    return;
  }
  try {
    process.kill(-childProcess.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await delay(250);
  try {
    process.kill(-childProcess.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function installExactVsix({
  extensionsDirectoryPath,
  hostEnvironment,
  packagedVsixPath,
  sharedDataDirectoryPath,
  userDataDirectoryPath,
  vscodeExecutablePath,
}) {
  const [vscodeCliPath, ...profileArguments] =
    resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true,
    });
  await executeFile(
    vscodeCliPath,
    [
      ...profileArguments,
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
    { env: hostEnvironment, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
}

async function writeVisualSettings(userDataDirectoryPath, visualVariant) {
  const settingsDirectoryPath = join(userDataDirectoryPath, "User");
  await mkdir(settingsDirectoryPath, { recursive: true });
  await writeFile(
    join(settingsDirectoryPath, "settings.json"),
    `${JSON.stringify(
      {
        "workbench.colorTheme": visualVariant.theme,
        "window.zoomLevel": visualVariant.zoomLevel,
        "window.autoDetectColorScheme": false,
        "window.autoDetectHighContrast": false,
        "gito.authorEmails": ["gito-visual@example.test"],
      },
      null,
      2,
    )}\n`,
  );
}

async function createDisposableVisualRepository(repositoryPath, environment) {
  await mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ["init", "-b", "main", "."], environment);
  await runGit(
    repositoryPath,
    ["config", "user.name", "Git'o Visual Fixture"],
    environment,
  );
  await runGit(
    repositoryPath,
    ["config", "user.email", "gito-visual@example.test"],
    environment,
  );
  await writeFile(join(repositoryPath, "README.md"), "visual fixture\n");
  await writeFile(
    join(repositoryPath, "change.txt"),
    "visual fixture change\n",
  );
  await runGit(repositoryPath, ["add", "README.md", "change.txt"], environment);
  await runGit(
    repositoryPath,
    ["commit", "-m", "test: visual fixture"],
    environment,
  );
}

async function runGit(repositoryPath, gitArguments, environment) {
  await executeFile("git", gitArguments, {
    cwd: repositoryPath,
    env: environment,
    encoding: "utf8",
  });
}

async function createVisualHostEnvironment(visualRootPath) {
  const isolatedHomePath = join(visualRootPath, "home");
  const isolatedTempPath = join(visualRootPath, "tmp");
  const isolatedConfigPath = join(visualRootPath, "config");
  const isolatedCachePath = join(visualRootPath, "cache");
  const isolatedDataPath = join(visualRootPath, "data");
  const isolatedStatePath = join(visualRootPath, "state");
  const isolatedRuntimePath = join(visualRootPath, "runtime");
  await Promise.all(
    [
      isolatedHomePath,
      isolatedTempPath,
      isolatedConfigPath,
      isolatedCachePath,
      isolatedDataPath,
      isolatedStatePath,
    ].map((directoryPath) => mkdir(directoryPath, { recursive: true })),
  );
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
  Object.assign(environment, {
    HOME: isolatedHomePath,
    USERPROFILE: isolatedHomePath,
    APPDATA: join(isolatedHomePath, "AppData", "Roaming"),
    LOCALAPPDATA: join(isolatedHomePath, "AppData", "Local"),
    TMPDIR: isolatedTempPath,
    TMP: isolatedTempPath,
    TEMP: isolatedTempPath,
    XDG_CONFIG_HOME: isolatedConfigPath,
    XDG_CACHE_HOME: isolatedCachePath,
    XDG_DATA_HOME: isolatedDataPath,
    XDG_STATE_HOME: isolatedStatePath,
    XDG_RUNTIME_DIR: isolatedRuntimePath,
    GIT_CONFIG_GLOBAL: isolatedGlobalGitConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    VSCODE_DISABLE_TELEMETRY: "1",
    VSCODE_DISABLE_CRASH_REPORTER: "1",
  });
  if (process.platform === "linux" && environment.DISPLAY === undefined) {
    throw new Error(
      "Visual VSIX run requires Linux DISPLAY from Xvfb; refusing a headless/mock fallback.",
    );
  }
  return environment;
}

async function allocateTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string")
    throw new Error("Unable to allocate visual CDP port.");
  return address.port;
}

async function waitForJsonResult(resultPath, label) {
  const deadline = Date.now() + visualHostTimeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      if (result?.passed === true) return result;
      if (result?.passed === false)
        throw new Error(
          `${label} failed: ${result.error?.message ?? "unknown failure"}`,
        );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(visualPollMilliseconds);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function writeJsonAtomically(resultPath, result) {
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(`${resultPath}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${resultPath}.tmp`, resultPath);
}

async function readReleaseMetadataAttestation({
  packagedVsixPath,
  packagedExtensionVersion,
  packagedVsixSha256,
  commitSha,
  sourceTreeSha256,
}) {
  const checksumPath = `${packagedVsixPath}.sha256`;
  await assertRegularFile(checksumPath, "VSIX checksum");
  const checksumTokens = (await readFile(checksumPath, "utf8"))
    .trim()
    .split(/\s+/u);
  if (
    checksumTokens.length !== 2 ||
    checksumTokens[0] !== packagedVsixSha256 ||
    checksumTokens[1] !== basename(packagedVsixPath)
  ) {
    throw new Error(
      `VSIX checksum does not attest ${basename(packagedVsixPath)} at ${packagedVsixSha256}.`,
    );
  }
  const metadataPath = resolve(
    process.env.GITO_RELEASE_METADATA_PATH ??
      join(repositoryRootPath, "dist", "release-metadata.json"),
  );
  await assertRegularFile(metadataPath, "release metadata");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    metadata.assetName !== basename(packagedVsixPath) ||
    metadata.checksumAssetName !== `${basename(packagedVsixPath)}.sha256` ||
    metadata.version !== packagedExtensionVersion ||
    metadata.tag !== `v${packagedExtensionVersion}` ||
    metadata.sha256 !== packagedVsixSha256 ||
    metadata.commitSha !== commitSha ||
    metadata.sourceTreeSha256 !== sourceTreeSha256
  ) {
    throw new Error(
      `Release metadata does not attest the exact visual VSIX at ${commitSha}.`,
    );
  }
  return { path: metadataPath, metadata };
}

async function readCurrentCommitSha() {
  const result = await executeFile("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRootPath,
    encoding: "utf8",
  });
  const currentCommitSha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(currentCommitSha))
    throw new Error(`Current commit SHA is invalid: ${currentCommitSha}`);
  return currentCommitSha;
}

async function assertVsixPath() {
  if (!packagedVsixPath || packagedVsixPath === resolve("."))
    throw new Error(
      "Pass the exact VSIX path: npm run test:visual-vsix -- path/to/gito.vsix",
    );
  if (!packagedVsixPath.endsWith(".vsix"))
    throw new Error(`Expected a VSIX file, received: ${packagedVsixPath}`);
  await assertRegularFile(packagedVsixPath, "VSIX");
}

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}
