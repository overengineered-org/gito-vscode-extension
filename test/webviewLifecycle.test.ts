import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractGeneratedBrowserScript } from "./webviewTestUtils.ts";

const graphViewSource = readFileSync(
  new URL("../src/graphView.ts", import.meta.url),
  "utf8",
);
const commitViewSource = readFileSync(
  new URL("../src/commitView.ts", import.meta.url),
  "utf8",
);

test("generates browser-valid webview JavaScript", () => {
  for (const webviewSource of [graphViewSource, commitViewSource]) {
    assert.doesNotThrow(() => Function(extractGeneratedBrowserScript(webviewSource)));
  }
});
