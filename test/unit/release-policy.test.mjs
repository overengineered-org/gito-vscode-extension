import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  readWorkflow,
  workflowActionReferences,
  workflowJob,
  workflowRun,
  workflowStep,
} from "../helpers/workflowPolicy.mjs";
import { calculateSourceTreeFingerprint } from "../../scripts/source-tree-fingerprint.mjs";
import {
  scanReadableForCredentials,
  scanRegularFileForCredentials,
} from "../../scripts/scan-current-tree-secrets.mjs";

const require = createRequire(import.meta.url);
const releaseConfiguration = require("../../release.config.cjs");
const repositoryRoot = resolve(import.meta.dirname, "../..");
const continuousIntegrationWorkflow = readWorkflow(".github/workflows/ci.yml");
const visualBaselineCaptureWorkflow = readWorkflow(
  ".github/workflows/visual-baseline-capture.yml",
);
const packageReleaseScript = readFileSync(
  resolve(repositoryRoot, "scripts/package-release.mjs"),
  "utf8",
);
const prepareReleaseScript = readFileSync(
  resolve(repositoryRoot, "scripts/prepare-release.mjs"),
  "utf8",
);
const resolveReleaseVersionScript = readFileSync(
  resolve(repositoryRoot, "scripts/resolve-release-version.mjs"),
  "utf8",
);
const packageContentsValidator = readFileSync(
  resolve(repositoryRoot, "scripts/validate-package-contents.mjs"),
  "utf8",
);
const installedTestedArtifactValidator = readFileSync(
  resolve(repositoryRoot, "scripts/validate-installed-tested-artifact.mjs"),
  "utf8",
);
const packagedExtensionTestRunner = readFileSync(
  resolve(repositoryRoot, "scripts/run-packaged-extension-tests.mjs"),
  "utf8",
);
const installedVsixTestRunner = readFileSync(
  resolve(repositoryRoot, "scripts/run-installed-vsix-tests.mjs"),
  "utf8",
);
const visualVsixTestRunner = readFileSync(
  resolve(repositoryRoot, "scripts/run-installed-vsix-visual-tests.mjs"),
  "utf8",
);
const vsixRunnerCommon = readFileSync(
  resolve(repositoryRoot, "scripts/vsix-runner-common.mjs"),
  "utf8",
);
const releaseRecoveryWorkflow = readWorkflow(
  ".github/workflows/github-release-recovery.yml",
);
const packageManifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);

function dependencyNames(job) {
  return Array.isArray(job.needs)
    ? job.needs
    : typeof job.needs === "string"
      ? [job.needs]
      : [];
}

function assertProtectedWriteJob(
  job,
  expectedEnvironment,
  { requireJobConcurrency = true } = {},
) {
  assert.equal(job.environment, expectedEnvironment);
  assert.equal(job.permissions?.contents, "write");
  assert.ok(
    Object.entries(job.permissions ?? {}).every(
      ([permissionName, permissionLevel]) =>
        (permissionName === "contents" && permissionLevel === "write") ||
        (permissionName === "actions" && permissionLevel === "read"),
    ),
  );
  if (requireJobConcurrency)
    assert.equal(job.concurrency?.["cancel-in-progress"], false);
}

function runScripts(job) {
  return (Array.isArray(job.steps) ? job.steps : [])
    .filter((step) => typeof step?.run === "string")
    .map((step) => step.run);
}

function findStepByUses(job, actionName) {
  const matchingStep = (job.steps ?? []).find(
    (step) =>
      typeof step?.uses === "string" && step.uses.startsWith(actionName),
  );
  assert.ok(matchingStep, `Workflow uses ${actionName}`);
  return matchingStep;
}

function findStepByName(job, stepName) {
  return workflowStep(job, stepName);
}

function stepIndex(job, stepName) {
  const matchingStepIndex = (job.steps ?? []).findIndex(
    (step) => step?.name === stepName,
  );
  assert.notEqual(matchingStepIndex, -1, `Workflow defines step ${stepName}`);
  return matchingStepIndex;
}

test("publishes only versioned releases from main", () => {
  assert.deepEqual(releaseConfiguration.branches, ["main"]);
  assert.equal(releaseConfiguration.tagFormat, "v${version}");
  const githubPlugin = releaseConfiguration.plugins.find(
    ([pluginName]) => pluginName === "@semantic-release/github",
  );
  assert.ok(githubPlugin);
  assert.deepEqual(
    githubPlugin[1].assets.map(({ path }) => path),
    [
      "dist/gito-*.vsix",
      "dist/gito-*.vsix.sha256",
      "dist/release-metadata.json",
    ],
  );
  assert.equal(
    releaseConfiguration.plugins.some(
      ([pluginName]) => pluginName === "@semantic-release/exec",
    ),
    false,
  );
});

test("release waits for static validation and the complete Tests aggregate", () => {
  const releaseJob = workflowJob(continuousIntegrationWorkflow, "release");
  assert.match(releaseJob.if, /github\.event_name == 'push'/);
  assert.match(releaseJob.if, /github\.ref == 'refs\/heads\/main'/);
  assert.deepEqual(dependencyNames(releaseJob), [
    "static",
    "tests-summary",
    "installed-vsix",
  ]);
  assertProtectedWriteJob(releaseJob, "release-production");
  const artifactDownloadStep = findStepByUses(
    releaseJob,
    "actions/download-artifact@",
  );
  assert.deepEqual(artifactDownloadStep.with, {
    name: "installed-tested-release-assets",
    path: "dist",
  });
  const releaseCreationStep = findStepByName(
    releaseJob,
    "Create semantic GitHub Release",
  );
  const securityWorkflowPreflightStep = findStepByName(
    releaseJob,
    "Require successful security workflow checks",
  );
  assert.deepEqual(securityWorkflowPreflightStep.env, {
    GH_TOKEN: "${{ github.token }}",
    GH_REPO: "${{ github.repository }}",
    RELEASE_COMMIT_SHA: "${{ steps.local-release-commit.outputs.commit-sha }}",
  });
  for (const requiredSecurityWorkflowProof of [
    "codeql.yml",
    "dependency-review.yml",
    "gitleaks.yml",
    "gh run list",
    '--commit "$RELEASE_COMMIT_SHA"',
    "createdAt",
    "sort_by(.createdAt)",
    ".[-1].databaseId",
    "latest_run_id",
    "gh run view",
    'status == "completed"',
    'conclusion == "success"',
    "deadline=$((SECONDS + 600))",
  ]) {
    assert.ok(
      securityWorkflowPreflightStep.run.includes(requiredSecurityWorkflowProof),
      `Release security preflight includes ${requiredSecurityWorkflowProof}`,
    );
  }
  assert.ok(
    stepIndex(releaseJob, "Require successful security workflow checks") <
      stepIndex(releaseJob, "Create semantic GitHub Release"),
  );
  assert.doesNotMatch(
    securityWorkflowPreflightStep.run,
    /gh run (?:rerun|cancel|delete)/,
  );
  const immutableCapabilityStep = findStepByName(
    releaseJob,
    "Require immutable-release capability",
  );
  assert.deepEqual(immutableCapabilityStep.env, {
    GH_TOKEN: "${{ github.token }}",
    GH_REPO: "${{ github.repository }}",
  });
  assert.match(
    immutableCapabilityStep.run,
    /repos\/\$\{GH_REPO\}\/immutable-releases/,
  );
  assert.match(immutableCapabilityStep.run, /\.enabled == true/);
  assert.ok(
    stepIndex(releaseJob, "Require immutable-release capability") <
      stepIndex(releaseJob, "Create semantic GitHub Release"),
  );
  assert.deepEqual(releaseCreationStep.env, {
    GITHUB_TOKEN: "${{ github.token }}",
    GITO_RELEASE_PACKAGE_PATH:
      "dist/gito-${{ needs.installed-vsix.outputs.release-version }}.vsix",
  });
  assert.match(releaseCreationStep.run, /^npm run release$/m);
  assert.equal(
    runScripts(releaseJob).some((run) => run.includes("npm run build")),
    false,
  );
  assert.equal(
    runScripts(releaseJob).some((run) => run.includes("npm run package:vsix")),
    false,
  );
  assert.deepEqual(releaseJob.outputs, {
    "release-tag": "${{ steps.resolve-release.outputs.tag }}",
    "release-asset-name": "${{ steps.resolve-release.outputs.asset-name }}",
    "release-sha256": "${{ steps.resolve-release.outputs.sha256 }}",
    "release-commit-sha": "${{ steps.resolve-release.outputs.commit-sha }}",
  });
  const releaseCommitBindingScript = workflowRun(
    releaseJob,
    "Bind local release commit",
  );
  assert.match(releaseCommitBindingScript, /git rev-parse HEAD/);
  const releaseVerificationScript = workflowRun(
    releaseJob,
    "Verify released assets and expose exact metadata",
  );
  for (const requiredReleaseProof of [
    "release-metadata.json",
    "git/ref/tags",
    "gh release view",
    ".isDraft",
    ".isImmutable",
    ".assets | length",
    "expected_asset_names",
    'remote_tag_commit_sha="$(resolve_remote_tag_commit_sha)"',
    '[[ "$remote_tag_commit_sha" == "$LOCAL_COMMIT_SHA" ]]',
    "sha256sum --check",
    'release_downloaded_sha256="$(sha256sum',
  ]) {
    assert.ok(
      releaseVerificationScript.includes(requiredReleaseProof),
      `release proof includes ${requiredReleaseProof}`,
    );
  }
  assert.doesNotMatch(releaseVerificationScript, /\bnode\b/);
  assert.doesNotMatch(releaseVerificationScript, /--sort=-v:refname/);
});

test("visual baseline capture accepts only exact pre-release CI artifacts", () => {
  const captureJob = workflowJob(visualBaselineCaptureWorkflow, "capture");
  const selectRunStep = findStepByName(
    captureJob,
    "Select exact pre-release CI run and commit",
  );
  assert.deepEqual(selectRunStep.env, {
    GH_TOKEN: "${{ github.token }}",
    CI_RUN_ID: "${{ inputs.ci_run_id }}",
    GH_REPO: "${{ github.repository }}",
  });
  for (const requiredPreReleaseProof of [
    '--repo "$GH_REPO"',
    "headSha,headBranch,event,status,conclusion,workflowName,jobs",
    '"Tests"',
    '"Installed VSIX Extension Host"',
    '"Installed VSIX Visual Evidence (compare or candidate)"',
    "Require approved visual baselines for release",
    'failed_job_names="$(jq -r',
    'run_head_sha="$(jq -er',
    'run_head_sha" =~ ^[0-9a-f]{40}$',
  ]) {
    assert.ok(
      selectRunStep.run.includes(requiredPreReleaseProof),
      `Visual baseline capture checks ${requiredPreReleaseProof}`,
    );
  }
  assert.match(selectRunStep.run, /run_conclusion=.*\.conclusion.*run_json/s);
  assert.match(
    selectRunStep.run,
    /case "\$run_conclusion" in[\s\S]*success\)[\s\S]*failure\)/,
  );

  const artifactCheckStep = findStepByName(
    captureJob,
    "Verify installed-tested visual artifact exists",
  );
  assert.match(
    artifactCheckStep.run,
    /actions\/runs\/\$\{CI_RUN_ID\}\/artifacts/,
  );
  assert.match(artifactCheckStep.run, /installed-tested-visual-input/);
  assert.match(artifactCheckStep.run, /\.expired == false/);
  assert.match(artifactCheckStep.run, /\.size_in_bytes/);

  const downloadArtifactStep = findStepByName(
    captureJob,
    "Download exact installed-tested VSIX artifact",
  );
  assert.match(
    downloadArtifactStep.run,
    /gh run download "\$CI_RUN_ID" --repo "\$GH_REPO" --name installed-tested-visual-input/,
  );
  const uploadCandidateStep = findStepByName(
    captureJob,
    "Upload candidate evidence only",
  );
  assert.equal(
    uploadCandidateStep.with.name,
    "visual-baseline-candidates-${{ steps.select-ci-run.outputs.commit-sha }}",
  );
});

test("Marketplace promotes only the exact released asset", () => {
  const marketplaceJob = workflowJob(
    continuousIntegrationWorkflow,
    "marketplace",
  );
  assert.match(marketplaceJob.if, /github\.event_name == 'push'/);
  assert.match(marketplaceJob.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(marketplaceJob.if, /needs\.release\.outputs\.release-tag != ''/);
  assert.deepEqual(dependencyNames(marketplaceJob), ["release"]);
  assert.equal(marketplaceJob.environment, "marketplace-production");
  assert.deepEqual(marketplaceJob.permissions, { contents: "read" });
  assert.equal(marketplaceJob.concurrency?.["cancel-in-progress"], false);
  const marketplaceDownloadStep = findStepByName(
    marketplaceJob,
    "Download exact GitHub Release assets",
  );
  assert.deepEqual(marketplaceDownloadStep.env, {
    GH_TOKEN: "${{ github.token }}",
    RELEASE_TAG: "${{ needs.release.outputs.release-tag }}",
    RELEASE_ASSET_NAME: "${{ needs.release.outputs.release-asset-name }}",
    RELEASE_COMMIT_SHA: "${{ needs.release.outputs.release-commit-sha }}",
  });
  const marketplaceVerificationStep = findStepByName(
    marketplaceJob,
    "Validate exact Marketplace package provenance",
  );
  assert.doesNotMatch(
    JSON.stringify(marketplaceVerificationStep.env),
    /GH_TOKEN|GITHUB_TOKEN|VSCE_PAT|secrets\./,
  );
  const marketplacePublishStep = findStepByName(
    marketplaceJob,
    "Publish exact tested release package",
  );
  assert.equal(marketplacePublishStep.env.VSCE_PAT, "${{ secrets.VSCE_PAT }}");
  assert.equal(
    marketplacePublishStep.env.RELEASE_PACKAGE_PATH,
    "${{ steps.release-package.outputs.path }}",
  );
  const marketplaceDownloadScript = marketplaceDownloadStep.run;
  const marketplaceVerificationScript = marketplaceVerificationStep.run;
  const marketplacePublishScript = marketplacePublishStep.run;
  for (const requiredMarketplaceProof of [
    'release_package_name="$RELEASE_ASSET_NAME"',
    'release_checksum_name="${release_package_name}.sha256"',
    "gh release download",
    "isImmutable",
    ".assets | length",
    "expected_asset_names",
    "release-metadata.json",
    "remote_tag_commit_sha",
  ]) {
    assert.ok(
      marketplaceDownloadScript.includes(requiredMarketplaceProof),
      `Marketplace download proof includes ${requiredMarketplaceProof}`,
    );
  }
  for (const requiredMarketplaceProof of [
    "sha256sum --check",
    "release_downloaded_sha256",
    "scripts/validate-installed-tested-artifact.mjs",
    "scripts/validate-package-contents.mjs",
    '== "$RELEASE_SHA256"',
  ]) {
    assert.ok(
      marketplaceVerificationScript.includes(requiredMarketplaceProof),
      `Marketplace validation proof includes ${requiredMarketplaceProof}`,
    );
  }
  assert.match(
    marketplacePublishScript,
    /npx --no-install vsce publish --packagePath "\$RELEASE_PACKAGE_PATH" --skip-duplicate/,
  );
  assert.doesNotMatch(marketplacePublishScript, /(?:^|\s)--pat(?:\s|$)/im);
  assert.doesNotMatch(marketplacePublishScript, /(?:^|\s)--token(?:\s|$)/im);
  assert.equal(
    runScripts(marketplaceJob).some((run) => run.includes("npm run build")),
    false,
  );
  assert.equal(
    runScripts(marketplaceJob).some((run) =>
      run.includes("npm run package:vsix"),
    ),
    false,
  );
});

test("semantic-release publishes only the prevalidated final VSIX", () => {
  assert.ok(prepareReleaseScript.includes("GITO_RELEASE_PACKAGE_PATH"));
  assert.ok(prepareReleaseScript.includes("Reusing installed-tested VSIX"));
  assert.ok(prepareReleaseScript.includes("copyFile"));
  assert.ok(resolveReleaseVersionScript.includes("dryRun: true"));
  assert.ok(resolveReleaseVersionScript.includes("nextRelease?.version"));
  assert.deepEqual(
    releaseConfiguration.plugins
      .filter(([pluginName]) =>
        [
          "@semantic-release/commit-analyzer",
          "@semantic-release/release-notes-generator",
        ].includes(pluginName),
      )
      .map(([pluginName, pluginOptions = {}]) => [pluginName, pluginOptions]),
    [
      ["@semantic-release/commit-analyzer", {}],
      ["@semantic-release/release-notes-generator", {}],
    ],
  );
  assert.ok(
    resolveReleaseVersionScript.includes("releaseConfiguration.plugins"),
  );
  assert.ok(
    resolveReleaseVersionScript.includes(
      "repositoryUrl: `file://${bareRepositoryPath}`",
    ),
  );
  assert.ok(resolveReleaseVersionScript.includes('"init", "--bare"'));
  assert.ok(
    resolveReleaseVersionScript.includes("@semantic-release/commit-analyzer"),
  );
  assert.ok(
    resolveReleaseVersionScript.includes(
      "@semantic-release/release-notes-generator",
    ),
  );
  assert.doesNotMatch(resolveReleaseVersionScript, /GITHUB_TOKEN|GH_TOKEN/);
  assert.doesNotMatch(resolveReleaseVersionScript, /next release version is/);
  assert.ok(
    prepareReleaseScript.includes('runNodeScript("package-release.mjs"'),
  );
  assert.ok(prepareReleaseScript.includes('GITO_SKIP_BUILD: "1"'));
  assert.ok(
    prepareReleaseScript.includes(
      'runNodeScript("validate-package-contents.mjs"',
    ),
  );
  assert.ok(
    prepareReleaseScript.includes(
      'runNodeScript("validate-installed-tested-artifact.mjs"',
    ),
  );
  assert.doesNotMatch(prepareReleaseScript, /releaseCommitSha/);
  assert.doesNotMatch(prepareReleaseScript, /createHash\("sha256"\)/);
  assert.ok(packageReleaseScript.includes("releaseMetadataPath"));
  assert.ok(packageReleaseScript.includes("commitSha"));
  assert.doesNotMatch(prepareReleaseScript, /production-security-audit\.mjs/);
  assert.ok(prepareReleaseScript.includes("release-metadata.json"));
  assert.ok(packageReleaseScript.includes('"package",\n    releaseVersion'));
  assert.ok(packageReleaseScript.includes('"--no-update-package-json"'));
  assert.ok(packageReleaseScript.includes('"--no-dependencies"'));
  assert.doesNotMatch(
    packageReleaseScript,
    /mkdtemp|stagingDirectory|stagedManifest/,
  );
  assert.ok(packageReleaseScript.includes("SOURCE_DATE_EPOCH"));
});

test("local verification includes the security policies", () => {
  assert.equal(
    packageManifest.scripts["test:production-audit-policy"],
    "node --test test/security/production-audit.test.mjs",
  );
  assert.match(
    packageManifest.scripts["verify:static"],
    /npm run test:release-policy/,
  );
  assert.match(
    packageManifest.scripts["verify:static"],
    /npm run test:production-audit-policy/,
  );
  assert.equal(
    packageManifest.scripts["security:scan"],
    "node scripts/scan-current-tree-secrets.mjs",
  );
  for (const requiredVerificationCommand of [
    "npm run test:package",
    "npm run test:production-audit",
    "npm run audit:production",
    "npm run security:scan",
  ]) {
    assert.match(
      packageManifest.scripts.verify,
      new RegExp(requiredVerificationCommand),
    );
  }
});

test("resolver returns semantic-release result, not forged log text", async () => {
  const fixtureRepositoryRoot = await mkdtemp(
    join(tmpdir(), "gito-release-resolver-fixture-"),
  );
  try {
    await writeFile(
      join(fixtureRepositoryRoot, "package.json"),
      '{"name":"resolver-fixture","version":"0.0.0-development"}\n',
    );
    await writeFile(join(fixtureRepositoryRoot, "fixture.txt"), "baseline\n");
    execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Release Fixture"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["config", "user.email", "release-fixture@example.invalid"],
      { cwd: fixtureRepositoryRoot, stdio: "ignore" },
    );
    execFileSync("git", ["add", "package.json", "fixture.txt"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "-m", "chore: fixture baseline"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["tag", "v1.0.0"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    const resolveFixtureVersion = () =>
      execFileSync(
        process.execPath,
        [resolve(repositoryRoot, "scripts/resolve-release-version.mjs")],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            GITO_RELEASE_RESOLVER_REPOSITORY: fixtureRepositoryRoot,
            GITHUB_TOKEN: "forged-token-that-must-be-ignored",
          },
        },
      ).trim();
    await writeFile(join(fixtureRepositoryRoot, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "-m", "feat: add fixture feature"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    assert.equal(resolveFixtureVersion(), "1.1.0");
    execFileSync("git", ["tag", "v1.1.0"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    await writeFile(join(fixtureRepositoryRoot, "change.txt"), "fix release\n");
    execFileSync("git", ["add", "change.txt"], {
      cwd: fixtureRepositoryRoot,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "commit",
        "-m",
        "fix: resolve fixture release",
        "-m",
        "next release version is 99.99.99",
      ],
      { cwd: fixtureRepositoryRoot, stdio: "ignore" },
    );
    assert.equal(resolveFixtureVersion(), "1.1.1");
  } finally {
    await rm(fixtureRepositoryRoot, { recursive: true, force: true });
  }
});

test("installed-tested validator rejects symlinked artifact inputs", async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "gito-installed-tested-path-fixture-"),
  );
  try {
    const packageName = "gito-1.0.0.vsix";
    await writeFile(join(fixtureRoot, "actual.vsix"), "not a VSIX\n");
    await symlink("actual.vsix", join(fixtureRoot, packageName));
    await writeFile(join(fixtureRoot, `${packageName}.sha256`), "\n");
    await writeFile(join(fixtureRoot, "release-metadata.json"), "{}\n");
    let validatorFailure;
    try {
      execFileSync(
        process.execPath,
        [
          resolve(
            repositoryRoot,
            "scripts/validate-installed-tested-artifact.mjs",
          ),
          packageName,
          `${packageName}.sha256`,
          "release-metadata.json",
          "1.0.0",
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      validatorFailure = error;
    }
    assert.ok(validatorFailure);
    assert.match(validatorFailure.stderr, /must be a regular file/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("release rejects stale installed-tested VSIX metadata", () => {
  const installedVsixJob = workflowJob(
    continuousIntegrationWorkflow,
    "installed-vsix",
  );
  assert.deepEqual(installedVsixJob.permissions, { contents: "read" });
  const releaseVersionResolutionStep = findStepByName(
    installedVsixJob,
    "Resolve semantic release version",
  );
  assert.equal(releaseVersionResolutionStep.env, undefined);
  assert.match(
    releaseVersionResolutionStep.run,
    /node scripts\/resolve-release-version\.mjs/,
  );
  const packagedVsixStep = findStepByName(
    installedVsixJob,
    "Run installed VSIX integration in isolated hosts",
  );
  assert.match(packagedVsixStep.run, /npm run test:packaged-vsix/);
  assert.ok(
    stepIndex(installedVsixJob, "Package exact final release VSIX") <
      stepIndex(
        installedVsixJob,
        "Run installed VSIX integration in isolated hosts",
      ),
  );
  assert.doesNotMatch(
    JSON.stringify(installedVsixJob),
    /GITHUB_TOKEN|GH_TOKEN|github\.token|secrets\./,
  );
  const releaseJob = workflowJob(continuousIntegrationWorkflow, "release");
  const artifactUploadStep = (installedVsixJob.steps ?? []).find(
    (step) => step.name === "Upload installed-tested release assets",
  );
  assert.ok(artifactUploadStep);
  assert.equal(
    artifactUploadStep.with.path,
    "dist/gito-${{ steps.resolve-release-version.outputs.version }}.vsix\ndist/gito-${{ steps.resolve-release-version.outputs.version }}.vsix.sha256\ndist/release-metadata.json\n",
  );
  assert.equal(artifactUploadStep.with["retention-days"], 90);
  const bindingStep = workflowStep(
    releaseJob,
    "Verify installed-tested source binding",
  );
  assert.match(bindingStep.run, /validate-installed-tested-artifact\.mjs/);
  assert.match(bindingStep.run, /validate-package-contents\.mjs/);
  for (const requiredBindingCheck of [
    '"rev-parse", "HEAD"',
    'createHash("sha256")',
    "calculateSourceTreeFingerprint",
    "extension/package.json",
    "metadata.commitSha",
    "metadata.sha256",
    "metadata.sourceTreeSha256",
    "lstat",
    "isFile()",
  ]) {
    assert.ok(
      installedTestedArtifactValidator.includes(requiredBindingCheck),
      `Installed-tested validator checks ${requiredBindingCheck}`,
    );
  }
});

test("release security preflight requires exact successful main push runs", () => {
  const releaseJob = workflowJob(continuousIntegrationWorkflow, "release");
  const securityPreflightStep = findStepByName(
    releaseJob,
    "Require successful security workflow checks",
  );
  const securityPreflightScript = securityPreflightStep.run;

  assert.match(
    securityPreflightScript,
    /--json databaseId,headSha,headBranch,event,status,conclusion/,
  );
  assert.match(
    securityPreflightScript,
    /\.headSha == \$commit_sha and\s+\.headBranch == "main" and\s+\.event == "push" and\s+\.status == "completed" and\s+\.conclusion == "success"/,
  );
  assert.match(
    securityPreflightScript,
    /gh run view .*--json databaseId,headSha,headBranch,event,status,conclusion/,
  );
  assert.match(
    securityPreflightScript,
    /\(\.databaseId \| tostring\) == \$run_id and \.headSha == \$commit_sha and \.headBranch == "main" and \.event == "push" and \.status == "completed" and \.conclusion == "success"/,
  );
  assert.doesNotMatch(
    securityPreflightScript,
    /\.status == "completed" and\s+\.conclusion == "success"\s+\)\]\[0\]/,
  );
});

test("release rechecks the semantic version before the protected write", () => {
  const releaseJob = workflowJob(continuousIntegrationWorkflow, "release");
  const versionBindingStep = findStepByName(
    releaseJob,
    "Recompute and bind release version before write",
  );
  assert.deepEqual(versionBindingStep.env, {
    EXPECTED_RELEASE_VERSION:
      "${{ needs.installed-vsix.outputs.release-version }}",
  });
  assert.match(versionBindingStep.run, /resolve-release-version\.mjs/);
  assert.match(versionBindingStep.run, /metadata_release_version/);
  assert.match(versionBindingStep.run, /resolved_release_version/);
  assert.match(versionBindingStep.run, /EXPECTED_RELEASE_VERSION/);
  assert.ok(
    stepIndex(releaseJob, "Recompute and bind release version before write") <
      stepIndex(releaseJob, "Create semantic GitHub Release"),
  );
});

test("source fingerprint binds untracked inputs but excludes root dist outputs", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-source-fingerprint-"));
  try {
    await mkdir(join(fixtureRoot, "src"), { recursive: true });
    await writeFile(join(fixtureRoot, "package.json"), "{}\n");
    const initialFingerprint =
      await calculateSourceTreeFingerprint(fixtureRoot);
    await writeFile(
      join(fixtureRoot, "src", "untracked.ts"),
      "export const one = 1;\n",
    );
    const sourceChangedFingerprint =
      await calculateSourceTreeFingerprint(fixtureRoot);
    assert.notEqual(sourceChangedFingerprint, initialFingerprint);
    const nestedReleaseMetadataPath = join(
      fixtureRoot,
      "src",
      "release-metadata.json",
    );
    const nestedReleasePackagePath = join(
      fixtureRoot,
      "src",
      "gito-1.0.0.vsix",
    );
    const nestedReleaseChecksumPath = join(
      fixtureRoot,
      "src",
      "gito-1.0.0.vsix.sha256",
    );
    const nestedSourceDistFilePath = join(
      fixtureRoot,
      "src",
      "dist",
      "source-bundle.js",
    );
    await mkdir(join(fixtureRoot, "src", "dist"), { recursive: true });
    await writeFile(nestedReleaseMetadataPath, "source metadata\n");
    await writeFile(nestedReleasePackagePath, "source archive\n");
    await writeFile(nestedReleaseChecksumPath, "source checksum\n");
    await writeFile(nestedSourceDistFilePath, "nested source bundle\n");
    const nestedSourceFingerprint =
      await calculateSourceTreeFingerprint(fixtureRoot);
    await writeFile(nestedReleaseMetadataPath, "changed metadata\n");
    assert.notEqual(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "nested release-metadata.json remains a source-tree input",
    );
    await writeFile(nestedReleaseMetadataPath, "source metadata\n");
    await writeFile(nestedReleasePackagePath, "changed archive\n");
    assert.notEqual(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "nested gito VSIX remains a source-tree input",
    );
    await writeFile(nestedReleasePackagePath, "source archive\n");
    await writeFile(nestedReleaseChecksumPath, "changed checksum\n");
    assert.notEqual(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "nested gito VSIX checksum remains a source-tree input",
    );
    await writeFile(nestedReleaseChecksumPath, "source checksum\n");
    await writeFile(nestedSourceDistFilePath, "changed nested source bundle\n");
    assert.notEqual(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "nested source dist directory remains a source-tree input",
    );
    await writeFile(nestedSourceDistFilePath, "nested source bundle\n");

    await writeFile(join(fixtureRoot, ".env"), "VSCE_PAT=local-only\n");
    assert.equal(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "ignored local credentials are not provenance inputs",
    );
    for (const ignoredLocalOutputName of [
      "runner.log.1",
      "signing.jks",
      "signing.keystore",
    ]) {
      await writeFile(
        join(fixtureRoot, ignoredLocalOutputName),
        "local-only\n",
      );
      assert.equal(
        await calculateSourceTreeFingerprint(fixtureRoot),
        nestedSourceFingerprint,
        `ignored local output is not a provenance input: ${ignoredLocalOutputName}`,
      );
    }
    await writeFile(
      join(fixtureRoot, ".env.example"),
      "VSCE_PAT=documented-placeholder\n",
    );
    assert.notEqual(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "publishable environment examples remain provenance inputs",
    );
    await rm(join(fixtureRoot, ".env.example"));

    const rootDistDirectoryPath = join(fixtureRoot, "dist");
    const rootDistOutputPaths = [
      join(rootDistDirectoryPath, "extension.js"),
      join(rootDistDirectoryPath, "gito-1.0.0.vsix"),
      join(rootDistDirectoryPath, "gito-1.0.0.vsix.sha256"),
      join(rootDistDirectoryPath, "release-metadata.json"),
    ];
    await mkdir(rootDistDirectoryPath, { recursive: true });
    for (const rootDistOutputPath of rootDistOutputPaths)
      await writeFile(rootDistOutputPath, "initial generated output\n");
    assert.equal(
      await calculateSourceTreeFingerprint(fixtureRoot),
      nestedSourceFingerprint,
      "root dist outputs are excluded from the source fingerprint",
    );
    for (const rootDistOutputPath of rootDistOutputPaths) {
      await writeFile(rootDistOutputPath, "changed generated output\n");
      assert.equal(
        await calculateSourceTreeFingerprint(fixtureRoot),
        nestedSourceFingerprint,
        `root dist change remains excluded: ${rootDistOutputPath}`,
      );
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("source fingerprint rejects external symlinks before target changes can evade provenance", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-source-symlink-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "gito-source-external-"));
  try {
    await mkdir(join(fixtureRoot, "media"), { recursive: true });
    const externalSecretPath = join(externalRoot, "external.svg");
    const linkedPath = join(fixtureRoot, "media", "external.svg");
    await writeFile(externalSecretPath, "first target\n");
    await symlink(externalSecretPath, linkedPath);
    await assert.rejects(
      calculateSourceTreeFingerprint(fixtureRoot),
      /rejects symlink input/u,
    );
    await writeFile(externalSecretPath, "changed target\n");
    await assert.rejects(
      calculateSourceTreeFingerprint(fixtureRoot),
      /rejects symlink input/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("secret scan streams complete large packaged bytes", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-secret-stream-"));
  try {
    const largeFilePath = join(fixtureRoot, "media.bin");
    const syntheticCredential = [
      "ghp_",
      "abcdefghijklmnopqrstuvwxyz1234567890",
    ].join("");
    const largeBytes = Buffer.alloc(20 * 1024 * 1024 + 128, 32);
    largeBytes.write(syntheticCredential, largeBytes.length - 40);
    await writeFile(largeFilePath, largeBytes);
    await assert.rejects(
      scanRegularFileForCredentials(largeFilePath, "media.bin"),
      /Credential-shaped value/u,
    );
    await assert.rejects(
      scanReadableForCredentials(
        Readable.from(["safe ", syntheticCredential]),
        "fixture stream",
      ),
      /Credential-shaped value/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("package policy validates emitted archive entries", () => {
  assert.ok(packageContentsValidator.includes('["-Z1", releasePackagePath]'));
  assert.ok(packageContentsValidator.includes("expectedArchiveEntries"));
  assert.doesNotMatch(packageContentsValidator, /vsce.*ls/);
  assert.ok(packageContentsValidator.includes("extension/dist/codicon.ttf"));
  assert.ok(packageContentsValidator.includes("releasePackageFileVersion"));
  assert.ok(packageContentsValidator.includes("embeddedManifest.version"));
  assert.ok(packageContentsValidator.includes("Unix file attributes"));
  assert.ok(packageContentsValidator.includes("scanArchiveForCredentials"));
  assert.ok(
    packageContentsValidator.includes("assertStructuredExtensionManifest"),
  );
  assert.doesNotMatch(
    packageContentsValidator,
    /production-security-audit\.mjs/,
  );
  assert.ok(packageReleaseScript.includes("scanRegularTreeForCredentials"));
  assert.deepEqual(packageManifest.files, [
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "SUPPORT.md",
    "dist/extension.js",
    "dist/graph.css",
    "dist/graph.js",
    "dist/webview.css",
    "dist/webview.js",
    "dist/codicon.ttf",
    "media/gito.png",
    "media/gito.svg",
    "media/onboarding/setup.svg",
  ]);
});

test("Tests aggregate depends on every required lane", () => {
  const testsSummaryJob = workflowJob(
    continuousIntegrationWorkflow,
    "tests-summary",
  );
  const requiredLaneNames = [
    "static",
    "security",
    "supported-vscode",
    "installed-vsix",
    "installed-vsix-visual",
    "macos",
    "windows",
  ];
  assert.deepEqual(dependencyNames(testsSummaryJob), requiredLaneNames);
  for (const requiredLaneName of requiredLaneNames) {
    assert.ok(
      continuousIntegrationWorkflow.jobs[requiredLaneName],
      `Tests aggregate dependency exists: ${requiredLaneName}`,
    );
  }
  assert.equal(testsSummaryJob.if, "always()");
  const resultCheckStep = findStepByName(
    testsSummaryJob,
    "Require every test lane to pass",
  );
  assert.deepEqual(resultCheckStep.env, {
    TEST_RESULTS: "${{ toJSON(needs) }}",
  });
  const resultCheckScript = resultCheckStep.run;
  assert.match(
    resultCheckScript,
    /jq -e 'length > 0 and all\(\.\[\]; \.result == "success"\)'/,
  );
  assert.match(resultCheckScript, /jq -r 'to_entries\[\]/);
  assert.doesNotMatch(resultCheckScript, /\[\[.*TEST_RESULTS.*==.*\*/);
});

test("Tests aggregate treats each needs result as structured data", () => {
  const testsSummaryJob = workflowJob(
    continuousIntegrationWorkflow,
    "tests-summary",
  );
  const resultCheckScript = findStepByName(
    testsSummaryJob,
    "Require every test lane to pass",
  ).run;
  assert.match(resultCheckScript, /all\(\.\[\]; \.result == "success"\)/);
  assert.match(resultCheckScript, /\.value\.result/);
  assert.doesNotMatch(resultCheckScript, /result.*failure.*\*/);
  assert.doesNotMatch(resultCheckScript, /result.*cancelled.*\*/);
  assert.doesNotMatch(resultCheckScript, /result.*skipped.*\*/);
});

test("VSIX host runners preserve the exact archive bytes", () => {
  assert.match(
    packagedExtensionTestRunner,
    /const packagedVsixSha256 = await sha256File\(packagedVsixPath\)/,
  );
  assert.match(
    packagedExtensionTestRunner,
    /const postHostPackagedVsixSha256 = await sha256File\(packagedVsixPath\)/,
  );
  assert.match(
    installedVsixTestRunner,
    /const packagedVsixSha256 = await sha256File\(packagedVsixPath\)/,
  );
  assert.match(
    installedVsixTestRunner,
    /const postHostInstalledVsixSha256 = await sha256File\(packagedVsixPath\)/,
  );
  for (const vsixRunnerSource of [
    packagedExtensionTestRunner,
    installedVsixTestRunner,
    visualVsixTestRunner,
  ]) {
    assert.match(
      vsixRunnerSource,
      /await assertRegularFile\(packagedVsixPath, "VSIX"\)/,
    );
    assert.doesNotMatch(vsixRunnerSource, /statSync/);
  }
  assert.match(vsixRunnerCommon, /export async function assertRegularFile/);
  assert.match(vsixRunnerCommon, /await lstat\(filePath\)/);

  const installedVsixJob = workflowJob(
    continuousIntegrationWorkflow,
    "installed-vsix",
  );
  const hostTestStep = findStepByName(
    installedVsixJob,
    "Run installed VSIX integration in isolated hosts",
  );
  assert.equal(hostTestStep.id, "run-isolated-host-tests");
  assert.match(hostTestStep.run, /pre_host_vsix_sha256=/);
  assert.match(hostTestStep.run, /verify_vsix_digest "after packaged host"/);
  assert.match(hostTestStep.run, /verify_vsix_digest "after installed host"/);
  assert.match(hostTestStep.run, /vsix-sha256=\$pre_host_vsix_sha256/);

  const uploadVerificationStep = findStepByName(
    installedVsixJob,
    "Reverify exact tested VSIX before upload",
  );
  assert.match(uploadVerificationStep.run, /sha256sum --check/);
  assert.match(uploadVerificationStep.run, /EXPECTED_VSIX_SHA256/);
  assert.match(uploadVerificationStep.run, /metadata_vsix_sha256/);
});

test("all workflow actions use full commit SHA references", () => {
  for (const workflowPath of [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/github-release-recovery.yml",
    ".github/workflows/gitleaks.yml",
  ]) {
    const workflow = readWorkflow(workflowPath);
    for (const actionReference of workflowActionReferences(workflow)) {
      assert.match(
        actionReference.ref,
        /^[0-9a-f]{40}$/,
        `${workflowPath}: ${actionReference.action}`,
      );
    }
  }
});

test("dependency review runs for exact main commits", () => {
  const dependencyReviewWorkflow = readWorkflow(
    ".github/workflows/dependency-review.yml",
  );
  assert.deepEqual(dependencyReviewWorkflow.on.push.branches, ["main"]);
  const dependencyReviewStep = findStepByUses(
    workflowJob(dependencyReviewWorkflow, "review"),
    "actions/dependency-review-action@",
  );
  assert.equal(
    dependencyReviewStep.with["base-ref"],
    "${{ github.event_name == 'push' && github.event.before || github.event.pull_request.base.sha }}",
  );
  assert.equal(dependencyReviewStep.with["head-ref"], "${{ github.sha }}");
});

test("release recovery never overwrites an immutable published release", () => {
  assert.ok(recoveryBuildWorkflowEvents(releaseRecoveryWorkflow));
  const recoveryBuildJob = workflowJob(releaseRecoveryWorkflow, "build");
  const recoveryPublishJob = workflowJob(releaseRecoveryWorkflow, "publish");
  assert.equal(recoveryBuildJob.name, "Recover exact release assets");
  for (const recoveryJob of [recoveryBuildJob, recoveryPublishJob]) {
    assert.equal(
      recoveryJob.steps?.[0]?.name,
      "Require recovery dispatch from main",
    );
    const recoveryGuardScript = recoveryJob.steps[0].run;
    assert.match(recoveryGuardScript, /WORKFLOW_REF/);
    assert.match(recoveryGuardScript, /refs\/heads\/main/);
    assert.match(recoveryGuardScript, /exit 1/);
  }
  assertProtectedWriteJob(recoveryPublishJob, "release-production", {
    requireJobConcurrency: false,
  });
  assert.equal(
    releaseRecoveryWorkflow.concurrency?.["cancel-in-progress"],
    false,
  );
  const recoveryImmutableCapabilityStep = findStepByName(
    recoveryPublishJob,
    "Require immutable-release capability",
  );
  assert.deepEqual(recoveryImmutableCapabilityStep.env, {
    GH_TOKEN: "${{ github.token }}",
    GH_REPO: "${{ github.repository }}",
  });
  assert.match(
    recoveryImmutableCapabilityStep.run,
    /repos\/\$\{GH_REPO\}\/immutable-releases/,
  );
  assert.match(recoveryImmutableCapabilityStep.run, /\.enabled == true/);
  assert.ok(
    stepIndex(recoveryPublishJob, "Require immutable-release capability") <
      stepIndex(
        recoveryPublishJob,
        "Create, publish, or verify immutable release",
      ),
  );
  const recoveryUploadStep = findStepByUses(
    recoveryBuildJob,
    "actions/upload-artifact@",
  );
  assert.equal(
    recoveryUploadStep.with.path,
    "dist/${{ steps.recovered-assets.outputs.package-name }}\ndist/${{ steps.recovered-assets.outputs.checksum-name }}\ndist/release-metadata.json\n",
  );
  assert.equal(recoveryUploadStep.with["retention-days"], 90);
  const recoveryBuildScripts = runScripts(recoveryBuildJob).join("\n");
  assert.match(
    recoveryBuildScripts,
    /Reverify exact recovered VSIX before upload|sha256sum --check/,
  );
  const recoveryPublishScript = workflowRun(
    recoveryPublishJob,
    "Create, publish, or verify immutable release",
  );
  assert.equal(
    (recoveryPublishJob.steps ?? []).some((step) =>
      step.uses?.startsWith("actions/checkout@"),
    ),
    false,
  );
  assert.doesNotMatch(runScripts(recoveryPublishJob).join("\n"), /\bnode\b/);
  for (const requiredRecoveryProof of [
    "git rev-parse HEAD",
    "git rev-list -n 1",
    "git/ref/tags",
    "gh run list --workflow ci.yml --commit",
    "latest_ci_run_id",
    "security_workflows=(codeql.yml dependency-review.yml gitleaks.yml)",
    '--workflow "$workflow_file"',
    "latest_security_run_id",
    "createdAt",
    "sort_by(.createdAt)",
    ".[-1].databaseId",
    'headBranch == "main"',
    "gh run view",
    "ci_run_readback",
    "security_run_readback",
    ".databaseId | tostring",
    "did not succeed",
    "gh run download",
    "installed-tested-release-assets",
    "sha256sum --check",
    "installed_tested_metadata_sha256",
    "installed_tested_package_sha256",
    "INSTALLED_TESTED_PACKAGE_PATH",
    "GITO_RELEASE_PACKAGE_PATH=",
  ]) {
    assert.ok(
      recoveryBuildScripts.includes(requiredRecoveryProof),
      `Recovery build proof includes ${requiredRecoveryProof}`,
    );
  }
  for (const requiredReleaseGate of [
    "npm run verify:static",
    "npm run test:release-policy",
    "npm run build",
    "npm run check:bundle",
    "scripts/prepare-release.mjs",
    "npm run package:verify",
    "npm run test:production-audit",
    "npm run audit:production",
    "npm run security:scan",
    "scripts/validate-installed-tested-artifact.mjs",
  ]) {
    assert.ok(
      recoveryBuildScripts.includes(requiredReleaseGate),
      `Recovery runs ${requiredReleaseGate}`,
    );
  }
  for (const requiredRecoveryPublishProof of [
    "release_is_draft",
    "verify_immutable_release",
    "isImmutable",
    ".assets | length",
    "resolve_remote_tag_commit_sha",
    "gh release create",
    "sha256sum --check",
    "release_metadata_sha256",
    "downloaded_package_sha256",
    "extension/package.json",
    '== "$release_metadata_sha256"',
  ]) {
    assert.ok(
      recoveryPublishScript.includes(requiredRecoveryPublishProof),
      `Recovery publish proof includes ${requiredRecoveryPublishProof}`,
    );
  }
  assert.doesNotMatch(recoveryPublishScript, /(?:^|\s)--pat(?:\s|$)/im);
  assert.doesNotMatch(recoveryPublishScript, /(?:^|\s)--token(?:\s|$)/im);
});

function recoveryBuildWorkflowEvents(workflow) {
  const dispatchInput = workflow.on?.workflow_dispatch?.inputs?.tag;
  assert.ok(dispatchInput);
  assert.equal(dispatchInput.required, true);
  assert.equal(dispatchInput.type, "string");
  assert.ok(workflowJob(workflow, "build"));
  assert.ok(workflowJob(workflow, "publish"));
  return true;
}
