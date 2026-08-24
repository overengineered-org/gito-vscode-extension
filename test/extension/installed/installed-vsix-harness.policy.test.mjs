import assert from "node:assert/strict";
import { symlink, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  gitOriginalRelativePath,
  isNativeSnapshotUri,
  parseGitOriginalPath,
} = require("./diff-proof-helpers.cjs");
const { parseCompletedTestDriverResult } = require("./test-driver-result.cjs");
const {
  pathsRepresentSameLocation,
  relativePathWithinRepository,
  uriWithinRepository,
} = require("./path-alias-helpers.cjs");

const repositoryRootPath = resolve(import.meta.dirname, "../../..");
const runnerSourcePath = join(
  repositoryRootPath,
  "scripts",
  "run-installed-vsix-tests.mjs",
);
const installedIntegrationSourcePath = join(
  repositoryRootPath,
  "test",
  "extension",
  "installed",
  "installed-vsix.integration.test.js",
);
const pathAliasHelperSourcePath = join(
  repositoryRootPath,
  "test",
  "extension",
  "installed",
  "path-alias-helpers.cjs",
);

test("installed runner keeps host credentials out of the child environment", async () => {
  const runnerSource = await readFile(runnerSourcePath, "utf8");
  assert.doesNotMatch(
    runnerSource,
    /env:\s*\{\s*\.\.\.process\.env/u,
    "installed host must not inherit the complete parent environment",
  );
  assert.match(runnerSource, /GIT_CONFIG_GLOBAL/u);
  assert.match(runnerSource, /VSCODE_DISABLE_TELEMETRY/u);
  assert.match(runnerSource, /--disable-telemetry/u);
  assert.match(runnerSource, /--disable-gpu/u);
  assert.match(runnerSource, /Release metadata is required/u);
  assert.doesNotMatch(
    runnerSource,
    /GITO_INSTALLED_RELEASE_METADATA_ATTESTED/u,
  );
});

test("installed runner has a bounded, process-tree-aware host lifecycle", async () => {
  const runnerSource = await readFile(runnerSourcePath, "utf8");
  assert.match(runnerSource, /installedExtensionHostTimeoutMilliseconds/u);
  assert.match(runnerSource, /detached:\s*process\.platform !== "win32"/u);
  assert.match(runnerSource, /terminateProcessTree/u);
  assert.match(runnerSource, /taskkill/u);
  assert.match(runnerSource, /SIGKILL/u);
  assert.match(runnerSource, /process\.kill\(-childProcess\.pid, 0\)/u);
  assert.match(runnerSource, /processTerminationSettleTimeoutMilliseconds/u);
  assert.match(runnerSource, /installedTestResultPollMilliseconds/u);
  assert.match(runnerSource, /pollForTestDriverResult/u);
  assert.match(runnerSource, /beginTermination\("test driver result"\)/u);
  assert.match(runnerSource, /readResultIfComplete/u);
  assert.match(runnerSource, /testDriverResultPath/u);
  assert.match(runnerSource, /testDriverResult\.passed/u);
  assert.doesNotMatch(
    runnerSource,
    /if \(exitCode !== 0\)/u,
    "driver result, not the forced shutdown code, is authoritative",
  );
  assert.match(runnerSource, /exited before writing its test driver result/u);
});

test("installed driver result parsing requires an atomic boolean outcome", () => {
  assert.deepEqual(parseCompletedTestDriverResult('{"passed":true}'), {
    passed: true,
  });
  assert.deepEqual(
    parseCompletedTestDriverResult('{"passed":false,"error":{"message":"x"}}'),
    { passed: false, error: { message: "x" } },
  );
  assert.equal(parseCompletedTestDriverResult("{"), undefined);
  assert.equal(parseCompletedTestDriverResult('{"passed":"true"}'), undefined);
  assert.equal(parseCompletedTestDriverResult('{"message":"done"}'), undefined);
});

test("installed graph proof observes runtime protocol data", async () => {
  const integrationSource = await readFile(
    installedIntegrationSourcePath,
    "utf8",
  );
  assert.match(integrationSource, /createGraphWebviewProbe/u);
  assert.match(integrationSource, /graphReady/u);
  assert.match(integrationSource, /graphQuery/u);
  assert.match(integrationSource, /graphPageLoaded/u);
  assert.match(integrationSource, /knownCommitSha/u);
  assert.match(integrationSource, /knownCommitSubject/u);
  assert.doesNotMatch(
    integrationSource,
    /assertInstalledGraphArtifactHandshake/u,
    "graph proof must not regress to static bundle inspection",
  );
});

test("installed hover proof isolates language providers and attributes Git'o", async () => {
  const [integrationSource, runnerSource, driverManifestSource] =
    await Promise.all([
      readFile(installedIntegrationSourcePath, "utf8"),
      readFile(runnerSourcePath, "utf8"),
      readFile(
        join(
          repositoryRootPath,
          "test",
          "extension",
          "installed",
          "package.json",
        ),
        "utf8",
      ),
    ]);
  const driverManifest = JSON.parse(driverManifestSource);
  const proofLanguage = driverManifest.contributes?.languages?.find(
    (language) => language.id === "gito-installed-proof",
  );
  assert.deepEqual(proofLanguage?.extensions, [".gito-proof"]);
  assert.match(runnerSource, /change\.gito-proof/u);
  assert.match(integrationSource, /vscode\.executeHoverProvider/u);
  assert.match(integrationSource, /gito-installed-proof/u);
  assert.match(integrationSource, /knownCommitSubject/u);
  assert.match(integrationSource, /knownCommitSha/u);
  assert.match(integrationSource, /command:gito\\\.history\\\.openCommit/u);
});

test("installed diff proof binds both resource schemes and the exact file", () => {
  const repositoryRootPath = join(
    tmpdir(),
    "gito-installed-diff-proof-repository",
  );
  const repositoryFilePath = join(repositoryRootPath, "change.txt");
  const originalUri = {
    scheme: "git",
    query: JSON.stringify({ path: repositoryFilePath, ref: "" }),
  };
  const modifiedUri = {
    scheme: "file",
    fsPath: join(tmpdir(), "gito-native-snapshot.txt"),
  };

  assert.equal(parseGitOriginalPath(originalUri), repositoryFilePath);
  assert.equal(
    gitOriginalRelativePath(originalUri, repositoryRootPath),
    "change.txt",
  );
  assert.equal(isNativeSnapshotUri(modifiedUri), true);
  assert.equal(
    gitOriginalRelativePath(modifiedUri, repositoryRootPath),
    undefined,
  );
  assert.equal(
    isNativeSnapshotUri({ scheme: "git", fsPath: repositoryFilePath }),
    false,
  );
  assert.equal(
    gitOriginalRelativePath(
      {
        scheme: "git",
        query: JSON.stringify({
          path: join(
            tmpdir(),
            "outside-gito-installed-repository",
            "change.txt",
          ),
          ref: "",
        }),
      },
      repositoryRootPath,
    ),
    undefined,
  );
});

test("installed raw diff probe isolates native URI compatibility", async () => {
  const integrationSource = await readFile(
    installedIntegrationSourcePath,
    "utf8",
  );
  assert.match(
    integrationSource,
    /verifyRawVscodeDiffUriMatrix/u,
    "installed proof includes an explicit raw vscode.diff probe",
  );
  assert.match(
    integrationSource,
    /installedNativeDiffProbeTimeoutMilliseconds/u,
    "raw diff probe has a bounded per-case timeout",
  );
  for (const uriPair of ["file->file", "git->file", "product-git->file"]) {
    assert.match(
      integrationSource,
      new RegExp(uriPair, "u"),
      `raw diff probe covers ${uriPair}`,
    );
  }
  assert.match(
    integrationSource,
    /findDiffTabForUris\(/u,
    "raw diff probe observes native tab URI inputs",
  );
  assert.match(
    integrationSource,
    /tabGroups\.close\(preexistingDiffTab\.tab/u,
    "raw diff probe does not reuse the extension-produced proof tab",
  );
  assert.match(
    integrationSource,
    /readResourceText\(diffTab\.original\)/u,
    "raw diff probe reads the original resource",
  );
  assert.match(
    integrationSource,
    /readResourceText\(diffTab\.modified\)/u,
    "raw diff probe reads the modified resource",
  );
  assert.match(
    integrationSource,
    /probeResults\.every\(\(probeResult\) => probeResult\.passed\)/u,
    "raw diff probe fails on any unsupported URI pair",
  );
  assert.match(
    integrationSource,
    /if \(commandOutcome\.failure !== undefined\) throw commandOutcome\.failure/u,
    "raw diff probe fails on a native command rejection",
  );
  assert.match(
    integrationSource,
    /finally \{[\s\S]*tabGroups\.close\(ownedDiffTab[\s\S]*findDiffTabForUris/u,
    "raw diff probe closes its own tab and observes removal in finally",
  );
  assert.match(
    integrationSource,
    /observedOriginalUri === expectedOriginalUri/u,
    "raw diff probe verifies the exact original URI",
  );
  assert.match(
    integrationSource,
    /observedModifiedUri === expectedModifiedUri/u,
    "raw diff probe verifies the exact modified URI",
  );
});

test("installed product diff proof precedes raw URI probes and settles", async () => {
  const integrationSource = await readFile(
    installedIntegrationSourcePath,
    "utf8",
  );
  const productProofIndex = integrationSource.indexOf(
    '"Installed VSIX diff has exact sources and content"',
  );
  const rawProbeIndex = integrationSource.indexOf(
    "verifyRawVscodeDiffUriMatrix(repositoryRootPath, exactDiffProof)",
  );
  assert.ok(productProofIndex >= 0, "installed product diff proof is present");
  assert.ok(
    rawProbeIndex > productProofIndex,
    "raw probes run after product proof",
  );
  assert.match(
    integrationSource,
    /await awaitInstalledUiCommandSettlement\([\s\S]*diffCommandOutcome/u,
    "product diff proof requires command settlement",
  );
  assert.match(
    integrationSource,
    /exactDiffProof\.originalScheme,[\s\S]*exactDiffProof\.modifiedScheme/u,
    "product diff proof binds both exact URI schemes",
  );
});

test("installed fixture cleanup remains in finally blocks", async () => {
  const integrationSource = await readFile(
    installedIntegrationSourcePath,
    "utf8",
  );
  assert.match(integrationSource, /finally \{/u);
  assert.match(integrationSource, /"stash"/u);
  assert.match(integrationSource, /"pop"/u);
  assert.match(integrationSource, /"merge",\s*"--abort"/u);
  assert.match(integrationSource, /interactiveCommandCompletion/u);
  const driverSource = await readFile(
    join(repositoryRootPath, "test", "extension", "installed", "index.js"),
    "utf8",
  );
  assert.match(driverSource, /pendingResultPath/u);
  assert.match(driverSource, /rename\(pendingResultPath, testResultPath\)/u);
});

test("installed path comparisons resolve aliases and missing leaves", async (testContext) => {
  const fixtureRootPath = await mkdtemp(join(tmpdir(), "gito-path-alias-"));
  const repositoryRootPath = join(fixtureRootPath, "repository");
  const repositoryAliasPath = join(fixtureRootPath, "repository-alias");
  try {
    await mkdir(repositoryRootPath, { recursive: true });
    try {
      await symlink(
        repositoryRootPath,
        repositoryAliasPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        testContext.skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }
    const repositoryFilePath = join(
      repositoryRootPath,
      "missing",
      "change.txt",
    );
    const aliasedRepositoryFilePath = join(
      repositoryAliasPath,
      "missing",
      "change.txt",
    );
    assert.equal(
      pathsRepresentSameLocation(repositoryFilePath, aliasedRepositoryFilePath),
      true,
    );
    assert.equal(
      relativePathWithinRepository(
        repositoryRootPath,
        aliasedRepositoryFilePath,
      ),
      "missing/change.txt",
    );
    assert.equal(
      uriWithinRepository(
        {
          toString: () => aliasedRepositoryFilePath,
        },
        repositoryRootPath,
      ),
      true,
    );
  } finally {
    await rm(fixtureRootPath, { recursive: true, force: true });
  }
});

test("installed path assertions use the shared canonical helper", async () => {
  const [integrationSource, helperSource] = await Promise.all([
    readFile(installedIntegrationSourcePath, "utf8"),
    readFile(pathAliasHelperSourcePath, "utf8"),
  ]);
  assert.match(integrationSource, /pathsRepresentSameLocation/u);
  assert.match(integrationSource, /relativePathWithinRepository/u);
  assert.match(integrationSource, /gitOriginalRelativePath/u);
  assert.match(integrationSource, /isNativeSnapshotUri/u);
  assert.match(integrationSource, /originalScheme/u);
  assert.match(integrationSource, /modifiedScheme/u);
  assert.doesNotMatch(integrationSource, /uriContainsRelativePath/u);
  assert.match(helperSource, /realpathSync\.native/u);
  assert.match(helperSource, /missingPathSegments/u);
});
