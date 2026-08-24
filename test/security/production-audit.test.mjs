import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertEmittedNetworkSinkAllowlist } from "../../scripts/production-audit.mjs";

const allowedExtensionBundle = 'fetch("https://api.github.com");';
const allowedGraphBundle = 'const svgNamespace = "http://www.w3.org/2000/svg";';
const allowedWebviewBundle =
  'const schemaUrl = "https://json-schema.org/draft/2020-12/schema";';

async function createBundleFixture(bundleOverrides = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gito-production-audit-"));
  const distRoot = join(fixtureRoot, "dist");
  await mkdir(distRoot);
  const bundleContents = {
    "extension.js": allowedExtensionBundle,
    "graph.js": allowedGraphBundle,
    "webview.js": allowedWebviewBundle,
    ...bundleOverrides,
  };
  for (const [bundleName, contents] of Object.entries(bundleContents)) {
    const bundlePath = join(distRoot, bundleName);
    await mkdir(join(bundlePath, ".."), { recursive: true });
    await writeFile(bundlePath, contents);
  }
  return fixtureRoot;
}

test("production audit rejects a forbidden graph bundle egress", async () => {
  const fixtureRoot = await createBundleFixture({
    "graph.js": 'fetch("https://evil.example/graph");',
  });
  try {
    await assert.rejects(
      assertEmittedNetworkSinkAllowlist(fixtureRoot),
      (error) => {
        assert.match(error.message, /graph\.js/);
        assert.match(error.message, /evil\.example\/graph/);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("production audit rejects a forbidden webview bundle egress", async () => {
  const fixtureRoot = await createBundleFixture({
    "webview.js": 'fetch("https://evil.example/webview");',
  });
  try {
    await assert.rejects(
      assertEmittedNetworkSinkAllowlist(fixtureRoot),
      (error) => {
        assert.match(error.message, /webview\.js/);
        assert.match(error.message, /evil\.example\/webview/);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("production audit includes future JavaScript bundles in dist", async () => {
  const fixtureRoot = await createBundleFixture({
    "future.js": 'fetch("https://evil.example/future");',
  });
  try {
    await assert.rejects(
      assertEmittedNetworkSinkAllowlist(fixtureRoot),
      (error) => {
        assert.match(error.message, /future\.js/);
        assert.match(error.message, /evil\.example\/future/);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
