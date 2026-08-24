import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  isSensitiveFilename,
  scanSensitiveRootFilesForCredentials,
  scanReadableForCredentials,
  scanTrackedAndStagedSensitiveFiles,
} from "../../scripts/scan-current-tree-secrets.mjs";

function syntheticCredential(prefix) {
  return `${prefix}${"A".repeat(24)}`;
}

function isIgnoredByRepository(pathToCheck) {
  try {
    execFileSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", pathToCheck],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

test("gitignore protects local credentials and operator evidence", () => {
  const gitignore = readFileSync(".gitignore", "utf8");
  for (const requiredPattern of [
    /^\.env$/mu,
    /^\.env\.\*$/mu,
    /^!\.env\.example$/mu,
    /^\.npmrc$/mu,
    /^\.envrc$/mu,
    /^\.direnv\/$/mu,
    /^\*\.pem$/mu,
    /^\*\.key$/mu,
    /^\*\.p12$/mu,
    /^\*\.pfx$/mu,
    /^\*\.jks$/mu,
    /^\*\.keystore$/mu,
    /^\*\.log$/mu,
    /^\*\.log\.\*$/mu,
    /^logs\/$/mu,
    /^operator-evidence\/$/mu,
    /^release-evidence\/$/mu,
  ]) {
    assert.match(gitignore, requiredPattern);
  }
  assert.equal(isSensitiveFilename(".env.example"), false);
  assert.equal(isSensitiveFilename(".env.local"), true);
  assert.equal(isSensitiveFilename(".npmrc"), true);
  assert.equal(isSensitiveFilename(".envrc"), true);
  assert.equal(isSensitiveFilename("signing.key"), true);
  assert.equal(isSensitiveFilename("signing.jks"), true);
  assert.equal(isSensitiveFilename("signing.keystore"), true);
  assert.equal(isSensitiveFilename("logs/runner.log"), true);
  assert.equal(isSensitiveFilename("runner.log.1"), true);
  assert.equal(isSensitiveFilename("package.json"), false);
});

test("gitignore excludes transient build, test, cache, and analysis output", () => {
  for (const ignoredPath of [
    "dist/extension.js",
    "out/extension.js",
    "coverage/lcov.info",
    ".vscode-test/user-data/settings.json",
    ".vitest/results.json",
    "test-results/junit.xml",
    "playwright-report/index.html",
    "scan.sarif",
    "runner.log.1",
    "signing.jks",
    "signing.keystore",
    "tmp/session.txt",
    "extension-1.0.0.tgz",
  ]) {
    assert.equal(isIgnoredByRepository(ignoredPath), true, ignoredPath);
  }
  assert.equal(isIgnoredByRepository(".env.example"), false);
  assert.equal(isIgnoredByRepository("src/extension.ts"), false);
});

test("root ignored environment files are scanned when explicitly enabled", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-secret-root-"));
  try {
    await writeFile(
      join(fixtureRoot, ".env"),
      `GITHUB_TOKEN=${syntheticCredential("ghp_")}\n`,
    );
    await assert.rejects(
      scanSensitiveRootFilesForCredentials(fixtureRoot),
      /Credential-shaped value found/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("tracked or staged ignored npmrc secrets cannot bypass scanning", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-secret-index-"));
  try {
    execFileSync("git", ["init", "--quiet"], {
      cwd: fixtureRoot,
      stdio: "ignore",
    });
    await writeFile(
      join(fixtureRoot, ".npmrc"),
      `//registry.npmjs.org/:_authToken=${syntheticCredential("npm_")}\n`,
    );
    execFileSync("git", ["add", "--force", ".npmrc"], {
      cwd: fixtureRoot,
      stdio: "ignore",
    });
    await assert.rejects(
      scanTrackedAndStagedSensitiveFiles(fixtureRoot),
      /Credential-shaped value found/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("staged log credentials are scanned despite ignored log paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-secret-log-"));
  try {
    execFileSync("git", ["init", "--quiet"], {
      cwd: fixtureRoot,
      stdio: "ignore",
    });
    await writeFile(
      join(fixtureRoot, "runner.log"),
      `Authorization: ${syntheticCredential("ghp_")}\n`,
    );
    execFileSync("git", ["add", "--force", "runner.log"], {
      cwd: fixtureRoot,
      stdio: "ignore",
    });
    await assert.rejects(
      scanTrackedAndStagedSensitiveFiles(fixtureRoot),
      /Credential-shaped value found/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("detects every GitHub token family across stream chunk boundaries", async () => {
  for (const tokenPrefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
    const syntheticToken = `${tokenPrefix}${"A".repeat(24)}`;
    await assert.rejects(
      scanReadableForCredentials(
        Readable.from([
          `Authorization: ${syntheticToken.slice(0, -7)}`,
          `${syntheticToken.slice(-7)}\n`,
        ]),
        `${tokenPrefix} fixture`,
      ),
      /Credential-shaped value found/u,
    );
  }
});

test("detects signed and context-bound Azure DevOps PAT formats", async () => {
  const signedAzurePat = `${"A".repeat(76)}AZDO${"B".repeat(4)}`;
  const legacyVscePat = `VSCE_PAT=${"C".repeat(52)}`;
  await assert.rejects(
    scanReadableForCredentials(
      Readable.from([signedAzurePat]),
      "signed Azure PAT fixture",
    ),
    /Credential-shaped value found/u,
  );
  await assert.rejects(
    scanReadableForCredentials(
      Readable.from([legacyVscePat]),
      "legacy VSCE PAT fixture",
    ),
    /Credential-shaped value found/u,
  );
});

test("does not flag random long strings or unresolved PAT references", async () => {
  await assert.doesNotReject(
    scanReadableForCredentials(
      Readable.from([
        `random=${"A".repeat(84)}\nVSCE_PAT: \${{ secrets.VSCE_PAT }}\n`,
      ]),
      "safe PAT fixture",
    ),
  );
});
