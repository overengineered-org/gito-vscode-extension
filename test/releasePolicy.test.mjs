import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const actConfiguration = readFileSync(".actrc", "utf8");
const localWorkflow = readFileSync(".act/workflows/verify.yml", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const localVerificationScript = readFileSync("scripts/verify-local.sh", "utf8");
const packagedIntegrationRunner = readFileSync("scripts/run-vsix-integration.mjs", "utf8");

test("keeps pull-request validation local and release execution explicit", () => {
  assert.deepEqual(readdirSync(".github/workflows").sort(), ["release.yml"]);
  assert.match(releaseWorkflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(releaseWorkflow, /\n  (pull_request|push|schedule):/);
  assert.match(releaseWorkflow, /commit_sha:/);
  assert.match(releaseWorkflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.equal((releaseWorkflow.match(/git rev-parse origin\/main/g) ?? []).length, 5);
});

test("pins and reuses one immutable ACT environment", () => {
  assert.match(localWorkflow, /name: "Git'o local validation"/);
  assert.match(localWorkflow, /name: "Git'o Linux, CodeQL, and package validation"/);
  assert.match(
    actConfiguration,
    /ghcr\.io\/catthehacker\/ubuntu:act-24\.04@sha256:dff4ec57d90046a7283aafc314298380be82bfeccb9ad0f1b36c4ebe74aabe78/,
  );
  for (const requiredActOption of ["--bind", "--pull=false", "--reuse", "linux/amd64"]) {
    assert.match(actConfiguration, new RegExp(requiredActOption.replace("/", "\\/")));
  }
  assert.match(actConfiguration, /gito-codeql-cache/);
  assert.match(localVerificationScript, /docker image inspect/);
  assert.match(localVerificationScript, /docker image prune --force/);
  assert.doesNotMatch(localVerificationScript, /docker (container|system|volume) prune/);
});

test("validates the exact VSIX across Linux and native release hosts", () => {
  assert.match(localWorkflow, /node-version: 24\.14\.0/);
  assert.match(localWorkflow, /GITO_VSCODE_VERSION: 1\.134\.0/);
  assert.match(localWorkflow, /npm run test:integration:vsix/);
  assert.match(localWorkflow, /npm run test:release-package/);
  assert.match(localWorkflow, /npm run audit:production/);
  assert.match(localWorkflow, /npm audit/);
  assert.match(releaseWorkflow, /- name: Install test dependencies\n        run: npm ci/);
  assert.doesNotMatch(releaseWorkflow, /npm ci --ignore-scripts/);
  assert.match(localVerificationScript, /npm run test:integration:vsix/);
  assert.match(localVerificationScript, /scripts\/secret-scan\.sh/);
  assert.match(localVerificationScript, /resolve-release-version\.mjs/);
  assert.match(localVerificationScript, /release-it/);
  assert.match(packagedIntegrationRunner, /--install-extension/);
  assert.doesNotMatch(packagedIntegrationRunner, /--disable-extensions/);
});

test("reuses tested bytes through release and protected publication", () => {
  const marketplaceJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  marketplace:"));
  for (const releaseOperatingSystem of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(releaseWorkflow, new RegExp(releaseOperatingSystem));
  }
  assert.match(releaseWorkflow, /name: validated-vsix/g);
  assert.match(releaseWorkflow, /sha256sum --check/);
  assert.match(releaseWorkflow, /node scripts\/resolve-release-version\.mjs/);
  assert.match(releaseWorkflow, /npm run release -- "\$RELEASE_VERSION"/);
  assert.match(releaseWorkflow, /environment: marketplace-production/);
  assert.match(releaseWorkflow, /VSCE_PAT: \$\{\{ secrets\.VSCE_PAT \}\}/);
  assert.match(releaseWorkflow, /vsce publish --packagePath/);
  assert.doesNotMatch(marketplaceJob, /npm run package:vsix/);
});

test("pins identical CodeQL tooling locally and for SARIF upload", () => {
  const codeqlInstaller = readFileSync("scripts/install-codeql.sh", "utf8");
  assert.match(codeqlInstaller, /codeql_bundle_version="2\.26\.4"/);
  assert.match(localWorkflow, /scripts\/run-codeql-analysis\.sh/);
  assert.match(releaseWorkflow, /scripts\/run-codeql-analysis\.sh/);
  assert.match(
    releaseWorkflow,
    /github\/codeql-action\/upload-sarif@fddeee1a7ece751b577e409a89057319e3172939/,
  );
});

test("reports one status only for the clean pushed PR commit", () => {
  assert.match(localVerificationScript, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(localVerificationScript, /git ls-remote --heads origin/);
  assert.match(localVerificationScript, /validate-pull-request-title\.mjs/);
  assert.match(localVerificationScript, /statuses\/\$\{validated_commit_sha\}/);
  assert.match(localVerificationScript, /local_validation_context="Local validation"/);
});
