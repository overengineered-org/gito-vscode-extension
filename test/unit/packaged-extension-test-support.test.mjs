import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import {
  createPackagedExtensionTestRootPath,
  getPackagedExtensionTestTempRootCandidates,
} from "../../scripts/packaged-extension-test-support.mjs";

test("prefers the explicit short temp root outside Windows", () => {
  assert.deepEqual(
    getPackagedExtensionTestTempRootCandidates({
      platform: "darwin",
      systemTempRoot: "/var/folders/long-system-temp-root",
    }),
    ["/tmp", "/var/folders/long-system-temp-root"],
  );
});

test("uses only the system temp root on Windows", () => {
  assert.deepEqual(
    getPackagedExtensionTestTempRootCandidates({
      platform: "win32",
      systemTempRoot: "C:\\Users\\runner\\AppData\\Local\\Temp",
    }),
    ["C:\\Users\\runner\\AppData\\Local\\Temp"],
  );
});

test("creates an isolated root with mkdtemp and falls back when needed", async () => {
  const isolatedRootPath = await createPackagedExtensionTestRootPath({
    explicitTempRoot: join(tmpdir(), "missing-gito-vsix-temp-root"),
    systemTempRoot: tmpdir(),
  });

  try {
    assert.ok(isAbsolute(isolatedRootPath));
    assert.equal(
      isolatedRootPath.startsWith(join(tmpdir(), "gito-vsix-")),
      true,
    );
  } finally {
    await rm(isolatedRootPath, { recursive: true, force: true });
  }
});
