import { describe, expect, it } from "vitest";
import {
  readWorkflow,
  workflowActionReferences,
  workflowJob,
  workflowStep,
} from "../helpers/workflowPolicy.mjs";

const continuousIntegrationWorkflow = readWorkflow(".github/workflows/ci.yml");

describe("Marketplace credential policy", () => {
  it("uses only the protected environment secret and exact asset promotion", () => {
    const marketplaceJob = workflowJob(
      continuousIntegrationWorkflow,
      "marketplace",
    );
    expect(marketplaceJob.environment).toBe("marketplace-production");
    expect(marketplaceJob.permissions).toEqual({ contents: "read" });
    expect(marketplaceJob.needs).toEqual("release");

    const downloadStep = workflowStep(
      marketplaceJob,
      "Download exact GitHub Release assets",
    );
    expect(downloadStep.run).toContain("release-metadata.json");
    expect(downloadStep.run).toContain("remote_tag_commit_sha");
    const verificationStep = workflowStep(
      marketplaceJob,
      "Validate exact Marketplace package provenance",
    );
    expect(verificationStep.run).toContain("sha256sum --check");
    expect(verificationStep.run).toContain("RELEASE_SHA256");
    expect(verificationStep.run).toContain(
      'release_downloaded_sha256="$(sha256sum',
    );
    expect(verificationStep.run).toContain(
      '[[ "$release_downloaded_sha256" == "$RELEASE_SHA256" ]]',
    );
    expect(JSON.stringify(verificationStep.env)).not.toMatch(
      /VSCE_PAT|GH_TOKEN|GITHUB_TOKEN|secrets\./,
    );

    const publishStep = workflowStep(
      marketplaceJob,
      "Publish exact tested release package",
    );
    expect(publishStep.env).toMatchObject({
      VSCE_PAT: "${{ secrets.VSCE_PAT }}",
      RELEASE_PACKAGE_PATH: "${{ steps.release-package.outputs.path }}",
    });
    expect(publishStep.run).toContain(
      'npx --no-install vsce publish --packagePath "$RELEASE_PACKAGE_PATH" --skip-duplicate',
    );
    expect(publishStep.run).not.toMatch(/(?:^|\s)--pat(?:\s|$)/im);
    expect(publishStep.run).not.toMatch(/(?:^|\s)--token(?:\s|$)/im);
    expect(publishStep.run).not.toMatch(/AZURE_CLIENT_SECRET|AZURE_TENANT_ID/i);
    expect(publishStep.run).not.toMatch(/--sort=-v:refname/);
  });

  it("separates final artifact testing from the protected release write", () => {
    const installedVsixJob = workflowJob(
      continuousIntegrationWorkflow,
      "installed-vsix",
    );
    const installedVsixSteps = installedVsixJob.steps ?? [];
    for (const requiredStepName of [
      "Resolve semantic release version",
      "Package exact final release VSIX",
      "Run installed VSIX integration in isolated hosts",
    ]) {
      expect(
        installedVsixSteps.some((step) => step.name === requiredStepName),
      ).toBe(true);
    }
    expect(
      installedVsixSteps.some(
        (step) =>
          step.name === "Upload installed-tested release assets" &&
          step.with?.name === "installed-tested-release-assets",
      ),
    ).toBe(true);
    expect(
      workflowStep(installedVsixJob, "Resolve semantic release version").run,
    ).toContain("node scripts/resolve-release-version.mjs");
    expect(
      workflowStep(installedVsixJob, "Package exact final release VSIX").run,
    ).toContain('node scripts/package-release.mjs "$RELEASE_VERSION"');
    expect(
      workflowStep(
        installedVsixJob,
        "Run installed VSIX integration in isolated hosts",
      ).run,
    ).toContain("npm run test:installed-vsix");

    const releaseJob = workflowJob(continuousIntegrationWorkflow, "release");
    expect(releaseJob.environment).toBe("release-production");
    expect(releaseJob.needs).toEqual([
      "static",
      "tests-summary",
      "installed-vsix",
    ]);
    expect(releaseJob.permissions).toEqual({
      actions: "read",
      contents: "write",
    });
    expect(
      (releaseJob.steps ?? []).some(
        (step) =>
          step.run?.includes("npm run build") ||
          step.run?.includes("npm run package:vsix"),
      ),
    ).toBe(false);
  });

  it("pins every workflow action to a full commit SHA", () => {
    const workflowPaths = [
      ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml",
      ".github/workflows/dependency-review.yml",
      ".github/workflows/github-release-recovery.yml",
      ".github/workflows/gitleaks.yml",
    ];
    for (const workflowPath of workflowPaths) {
      const workflow = readWorkflow(workflowPath);
      for (const actionReference of workflowActionReferences(workflow)) {
        expect(
          actionReference.ref,
          `${workflowPath}: ${actionReference.action}`,
        ).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it("runs a complete current-tree credential scan alongside history scanning", () => {
    const gitleaksWorkflow = readWorkflow(".github/workflows/gitleaks.yml");
    const scanJob = workflowJob(gitleaksWorkflow, "scan");
    const currentTreeScanStep = workflowStep(
      scanJob,
      "Scan complete current tree including untracked files",
    );
    expect(currentTreeScanStep.run).toBe(
      "node scripts/scan-current-tree-secrets.mjs",
    );
    expect(
      (scanJob.steps ?? []).some((step) =>
        step.uses?.includes("gitleaks-action@"),
      ),
    ).toBe(true);
  });
});
