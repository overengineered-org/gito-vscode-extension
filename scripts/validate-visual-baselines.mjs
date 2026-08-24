import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const repositoryRootPath = resolve(import.meta.dirname, "..");
const baselineDirectoryPath = resolve(
  process.env.GITO_VISUAL_BASELINE_DIRECTORY ??
    join(repositoryRootPath, "test", "visual", "golden", "repository-home"),
);
const approvalManifestPath = join(
  baselineDirectoryPath,
  "approval-manifest.json",
);
const expectedVisualVariants = [
  { id: "dark-modern", theme: "Default Dark Modern", zoomLevel: 0 },
  { id: "light-modern", theme: "Default Light Modern", zoomLevel: 0 },
  { id: "dark-hc", theme: "Default High Contrast", zoomLevel: 0 },
  {
    id: "light-hc",
    theme: "Default High Contrast Light",
    zoomLevel: 0,
  },
  { id: "custom", theme: "Git'o Visual QA", zoomLevel: 0 },
  { id: "dark-modern-200", theme: "Default Dark Modern", zoomLevel: 2 },
  { id: "dark-modern-fc", theme: "Default Dark Modern", zoomLevel: 0 },
  { id: "dark-modern-rm", theme: "Default Dark Modern", zoomLevel: 0 },
];

const approvalManifest = await readJson(
  approvalManifestPath,
  "approval manifest",
);
if (
  approvalManifest.schemaVersion !== 1 ||
  approvalManifest.status !== "approved"
) {
  throw new Error(
    `Visual baseline approval manifest must declare schemaVersion 1 and status approved: ${approvalManifestPath}`,
  );
}
assertCommitSha(approvalManifest.capturedFromCommitSha, "captured commit SHA");
assertSha256(
  approvalManifest.capturedFromSourceTreeSha256,
  "captured source-tree SHA",
);
assertSha256(approvalManifest.capturedFromVsixSha256, "captured VSIX SHA");
if (
  typeof approvalManifest.reviewer !== "string" ||
  approvalManifest.reviewer.trim().length === 0 ||
  typeof approvalManifest.approvedAt !== "string" ||
  Number.isNaN(Date.parse(approvalManifest.approvedAt)) ||
  typeof approvalManifest.reason !== "string" ||
  approvalManifest.reason.trim().length === 0
) {
  throw new Error(
    "Visual baseline approval manifest requires reviewer, approvedAt, and reason.",
  );
}

if (!Array.isArray(approvalManifest.variants))
  throw new Error(
    "Visual baseline approval manifest variants must be an array.",
  );
const expectedVariantIds = expectedVisualVariants.map(({ id }) => id);
const approvedVariantIds = approvalManifest.variants.map(
  (variant) => variant?.id,
);
if (
  approvedVariantIds.length !== expectedVariantIds.length ||
  approvedVariantIds.some(
    (variantId, variantIndex) => variantId !== expectedVariantIds[variantIndex],
  )
) {
  throw new Error(
    `Visual baseline approval manifest must list exactly: ${expectedVariantIds.join(", ")}.`,
  );
}

for (const expectedVariant of expectedVisualVariants) {
  const approvedVariant = approvalManifest.variants.find(
    (variant) => variant.id === expectedVariant.id,
  );
  if (
    approvedVariant.image !== `${expectedVariant.id}.png` ||
    approvedVariant.metadata !== `${expectedVariant.id}.json`
  ) {
    throw new Error(
      `Visual baseline approval paths are invalid for ${expectedVariant.id}; candidates must be explicitly renamed into the golden directory.`,
    );
  }
  const imagePath = join(baselineDirectoryPath, approvedVariant.image);
  const metadataPath = join(baselineDirectoryPath, approvedVariant.metadata);
  await assertRegularFile(imagePath, `${expectedVariant.id} screenshot`);
  await assertRegularFile(metadataPath, `${expectedVariant.id} metadata`);
  const screenshotBytes = await readFile(imagePath);
  const screenshotSha256 = createHash("sha256")
    .update(screenshotBytes)
    .digest("hex");
  assertSha256(
    approvedVariant.screenshotSha256,
    `${expectedVariant.id} screenshot SHA`,
  );
  if (approvedVariant.screenshotSha256 !== screenshotSha256) {
    throw new Error(
      `Visual baseline screenshot digest mismatch for ${expectedVariant.id}.`,
    );
  }
  const screenshotMetadata = await readJson(
    metadataPath,
    `${expectedVariant.id} metadata`,
  );
  if (
    screenshotMetadata.variant !== expectedVariant.id ||
    screenshotMetadata.theme !== expectedVariant.theme ||
    screenshotMetadata.zoomLevel !== expectedVariant.zoomLevel ||
    screenshotMetadata.screenshotSha256 !== screenshotSha256 ||
    screenshotMetadata.vsixSha256 !== approvalManifest.capturedFromVsixSha256 ||
    screenshotMetadata.commitSha !== approvalManifest.capturedFromCommitSha ||
    screenshotMetadata.sourceTreeSha256 !==
      approvalManifest.capturedFromSourceTreeSha256 ||
    screenshotMetadata.hostDisplay?.width !== 1440 ||
    screenshotMetadata.hostDisplay?.height !== 900 ||
    screenshotMetadata.hostDisplay?.depth !== 24 ||
    screenshotMetadata.hostDisplay?.deviceScaleFactor !== 1 ||
    screenshotMetadata.viewport?.width <= 0 ||
    screenshotMetadata.viewport?.width > 1440 ||
    screenshotMetadata.viewport?.height <= 0 ||
    screenshotMetadata.viewport?.height > 900 ||
    screenshotMetadata.viewport?.devicePixelRatio !== 1
  ) {
    throw new Error(
      `Visual baseline metadata is not bound to the approved runtime evidence for ${expectedVariant.id}.`,
    );
  }
}

process.stdout.write(
  `Validated ${expectedVisualVariants.length} approved visual baselines captured from ${approvalManifest.capturedFromCommitSha} (${approvalManifest.capturedFromVsixSha256}).\n`,
);

async function assertRegularFile(filePath, fileLabel) {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile())
    throw new Error(`${fileLabel} must be a regular file: ${filePath}`);
}

async function readJson(filePath, fileLabel) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Approved visual ${fileLabel} is missing: ${filePath}. Run the protected visual baseline candidate workflow; never synthesize or auto-update baselines.`,
      );
    }
    throw new Error(`Approved visual ${fileLabel} is invalid: ${filePath}.`, {
      cause: error,
    });
  }
}

function assertSha256(candidateSha256, label) {
  if (!/^[0-9a-f]{64}$/u.test(candidateSha256 ?? ""))
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function assertCommitSha(candidateCommitSha, label) {
  if (!/^[0-9a-f]{40}$/u.test(candidateCommitSha ?? ""))
    throw new Error(`${label} must be a 40-character lowercase commit SHA.`);
}
