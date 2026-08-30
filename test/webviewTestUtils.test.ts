import assert from "node:assert/strict";
import test from "node:test";

import { extractGeneratedBrowserScript } from "./webviewTestUtils.ts";

test("extracts scripts across valid HTML closing-tag variants", () => {
  const webviewSource =
    'return `<!doctype html><SCRIPT>window.ready = true;</SCRIPT\t\n ignored>`;';

  assert.equal(
    extractGeneratedBrowserScript(webviewSource),
    "window.ready = true;",
  );
});
