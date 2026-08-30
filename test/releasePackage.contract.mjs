import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { expectedPackagedFilePaths } from "../scripts/validate-package-contents.mjs";

test("versions and checksums the exact validated VSIX", async () => {
  const contractVersion = "999.999.999";
  const contractPackagePath = resolve("dist", `gito-${contractVersion}.vsix`);
  const contractChecksumPath = `${contractPackagePath}.sha256`;
  assert.equal(existsSync(contractPackagePath), false, "contract package must start absent");
  assert.equal(existsSync(contractChecksumPath), false, "contract checksum must start absent");

  try {
    execFileSync("node", ["scripts/package-release.mjs", contractVersion], { stdio: "pipe" });
    execFileSync("node", ["scripts/verify-release-package.mjs", contractVersion], {
      stdio: "pipe",
    });

    const contractPackageBytes = readFileSync(contractPackagePath);
    const contractPackageDigest = createHash("sha256")
      .update(contractPackageBytes)
      .digest("hex");
    assert.equal(
      readFileSync(contractChecksumPath, "utf8"),
      `${contractPackageDigest}  gito-${contractVersion}.vsix\n`,
    );

    const contractArchive = await JSZip.loadAsync(contractPackageBytes);
    const packagedFilePaths = Object.values(contractArchive.files)
      .filter((archiveEntry) => !archiveEntry.dir)
      .map((archiveEntry) => archiveEntry.name)
      .sort();
    assert.deepEqual(packagedFilePaths, expectedPackagedFilePaths);

    const extensionManifest = JSON.parse(
      await contractArchive.file("extension/package.json").async("string"),
    );
    assert.equal(extensionManifest.version, contractVersion);
  } finally {
    rmSync(contractPackagePath, { force: true });
    rmSync(contractChecksumPath, { force: true });
  }
});
