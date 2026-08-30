import assert from "node:assert/strict";
import test from "node:test";

import { extractGeneratedBrowserScript } from "./webviewTestUtils.ts";

test("extracts scripts regardless of HTML tag casing", () => {
  const webviewSource = 'return `<!doctype html><SCRIPT>window.ready = true;</SCRIPT>`;';

  assert.equal(
    extractGeneratedBrowserScript(webviewSource),
    "window.ready = true;",
  );
});
