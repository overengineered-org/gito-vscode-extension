import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const visualRunnerSource = readFileSync(
  "scripts/run-installed-vsix-visual-tests.mjs",
  "utf8",
);
const visualDriverSource = readFileSync(
  "test/extension/visual/index.js",
  "utf8",
);
const visualWorkflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
const visualBaselineWorkflowSource = readFileSync(
  ".github/workflows/visual-baseline-capture.yml",
  "utf8",
);
const visualBaselineValidatorSource = readFileSync(
  "scripts/validate-visual-baselines.mjs",
  "utf8",
);

describe("installed VSIX visual evidence policy", () => {
  it("keeps the runner syntactically valid and unambiguous", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["--check", "scripts/run-installed-vsix-visual-tests.mjs"],
        {
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
    const spawnVisualHostParameters = visualRunnerSource.match(
      /async function spawnVisualHost\(\{([\s\S]*?)\}\) \{/u,
    )?.[1];
    expect(
      spawnVisualHostParameters?.match(/\bvisualLogPath\b/gu),
    ).toHaveLength(1);
  });

  it("retains failed metadata when diagnostic artifacts are kept", () => {
    expect(visualRunnerSource).toContain("currentRunMetadata");
    expect(visualRunnerSource).toContain(
      "currentRunMetadata.completed === false ? {} : { completed: true }",
    );
    expect(visualRunnerSource).toContain(
      "logs: await findLogFiles(visualRunRootPath)",
    );
  });

  it("uses the real VS Code renderer and exact archive attestation", () => {
    expect(visualRunnerSource).toContain("chromium.connectOverCDP");
    expect(visualRunnerSource).toContain("readVSIXPackage");
    expect(visualRunnerSource).toContain("sha256File");
    expect(visualRunnerSource).toContain("packagedVsixSha256");
    expect(visualRunnerSource).toContain("findRepositoryHomeWebview");
    expect(visualRunnerSource).toContain("driverCompleted");
    expect(visualRunnerSource).toContain("assertSuccessfulHostExit");
    expect(visualRunnerSource).toContain("checksumTokens");
    expect(visualRunnerSource).toContain("checksumAssetName");
    expect(visualRunnerSource).toContain("metadata.tag");
    expect(visualRunnerSource).not.toContain("jsdom");
    expect(visualRunnerSource).not.toContain("@testing-library");
    expect(visualRunnerSource).not.toContain('"gito.developerDiagnostics"');
    expect(visualRunnerSource).toContain(
      'join(tmpdir(), "gito-visual-artifacts")',
    );
    expect(visualDriverSource).toContain("gito.openHome");
    expect(visualDriverSource).toContain("gito.repositoryHome");
    expect(visualDriverSource).not.toContain("postMessage");
  });

  it("fails closed for unapproved baselines", () => {
    expect(visualRunnerSource).toContain(
      "Approved visual baseline or approval manifest is missing",
    );
    expect(visualRunnerSource).toContain("GITO_VISUAL_CAPTURE_ONLY");
    expect(visualRunnerSource).toContain("never updated automatically");
    expect(visualRunnerSource).not.toMatch(/writeFile\(baselinePath/u);
    expect(visualRunnerSource).not.toMatch(/copyFile\([^\n]*baseline/u);
  });

  it("records all required theme and media variants", () => {
    for (const requiredVariant of [
      "dark-modern",
      "light-modern",
      "dark-hc",
      "light-hc",
      "custom",
      "dark-modern-200",
      "dark-modern-fc",
      "dark-modern-rm",
    ]) {
      expect(visualRunnerSource).toContain(`id: "${requiredVariant}"`);
    }
    expect(visualRunnerSource).toContain("forced-colors");
    expect(visualRunnerSource).toContain("prefers-reduced-motion");
    expect(visualRunnerSource).toContain('"window.zoomLevel"');
    expect(visualRunnerSource).toContain("visualDisplayWidth = 1440");
    expect(visualRunnerSource).toContain("visualDisplayHeight = 900");
    expect(visualRunnerSource).toContain("hostDisplay");
    expect(visualRunnerSource).toContain("baselineStatus");
    expect(visualRunnerSource).toMatch(
      /id: "dark-modern-fc"[\s\S]{0,160}theme: "Default Dark Modern"/u,
    );
    expect(visualRunnerSource).not.toContain("--force-high-contrast");
    expect(visualRunnerSource).toContain("Emulation.setEmulatedMedia");
  });

  it("runs the visual lane under a fixed Linux Xvfb display", () => {
    expect(visualWorkflowSource).toContain("installed-vsix-visual");
    expect(visualWorkflowSource).toContain("xvfb-run");
    expect(visualWorkflowSource).toContain("1440x900x24");
    expect(visualWorkflowSource).toContain("actions/upload-artifact@");
  });

  it("keeps bootstrap candidates gated and release approval explicit", () => {
    expect(visualWorkflowSource).toContain("baselineStatus=missing");
    expect(visualWorkflowSource).toContain("GITO_VISUAL_CAPTURE_ONLY:");
    expect(visualWorkflowSource).toContain("test:visual-baselines");
    expect(visualWorkflowSource).toContain("approved-compare");
    expect(visualWorkflowSource).toContain("candidate-capture");
    expect(visualWorkflowSource).toContain("visual-mode");
    expect(visualWorkflowSource).toContain("approval-manifest.json");
    expect(visualWorkflowSource).toContain("metadata_count");
    expect(visualBaselineWorkflowSource).toContain("workflow_dispatch");
    expect(visualBaselineWorkflowSource).toContain("visual-baseline-approval");
    expect(visualBaselineWorkflowSource).toContain(
      'GITO_VISUAL_CAPTURE_ONLY: "1"',
    );
    expect(visualBaselineWorkflowSource).toContain("gh run download");
    expect(visualBaselineWorkflowSource).toContain(
      "installed-tested-visual-input",
    );
    expect(visualBaselineWorkflowSource).toContain(
      "validate-installed-tested-artifact.mjs",
    );
    expect(visualBaselineWorkflowSource).toContain(".commitSha");
    expect(visualBaselineWorkflowSource).toContain(".sha256");
    expect(visualBaselineWorkflowSource).toContain("headSha");
    expect(visualBaselineWorkflowSource).toContain("headBranch");
    expect(visualBaselineWorkflowSource).toContain('== "main"');
    expect(visualBaselineWorkflowSource).toContain('== "push"');
    expect(visualBaselineWorkflowSource).not.toContain("npm run build");
    expect(visualBaselineWorkflowSource).not.toContain("npm run package:vsix");
    expect(visualBaselineWorkflowSource).toContain("actions/upload-artifact@");
    expect(visualBaselineWorkflowSource).not.toMatch(
      /git\s+(add|commit|push)/u,
    );
    expect(visualBaselineValidatorSource).toContain("approval-manifest.json");
    expect(visualBaselineValidatorSource).toContain(
      "capturedFromSourceTreeSha256",
    );
    expect(visualBaselineValidatorSource).toContain("screenshotSha256");
    expect(visualBaselineValidatorSource).toContain("must be a regular file");
    expect(visualBaselineValidatorSource).not.toContain(
      "currentSourceTreeSha256",
    );
    expect(visualBaselineValidatorSource).not.toContain(
      "approvalManifest.commitSha !==",
    );
  });
});
