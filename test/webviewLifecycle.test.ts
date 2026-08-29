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

test("registers webview listeners before loading HTML", () => {
  for (const webviewSource of [graphViewSource, commitViewSource]) {
    assert.ok(
      webviewSource.indexOf("onDidReceiveMessage") <
        webviewSource.indexOf("webviewView.webview.html"),
    );
    assert.match(webviewSource, /vscode\.postMessage\(\{ type: 'ready' \}\)/u);
    assert.match(webviewSource, /\.type === "ready"/u);
  }
});

test("generates browser-valid webview JavaScript", () => {
  for (const webviewSource of [graphViewSource, commitViewSource]) {
    assert.doesNotThrow(() => Function(extractGeneratedBrowserScript(webviewSource)));
  }
});

test("only caches graph state after the webview receives it", () => {
  assert.match(graphViewSource, /const graphStateDelivered = await/u);
  assert.match(graphViewSource, /if \(graphStateDelivered &&/u);
});

test("runs the first graph refresh without a visibility race", () => {
  assert.match(
    graphViewSource,
    /graphViewMessage\.type === "ready"[\s\S]*await this\.refreshRunner\.requestRefresh\(true\)/u,
  );
});

test("loads the visible graph from HEAD instead of walking every ref", () => {
  assert.match(graphViewSource, /loadCommitGraphPage\(/u);
  assert.doesNotMatch(graphViewSource, /refNames:/u);
});

test("owns every resolved webview subscription", () => {
  for (const webviewSource of [graphViewSource, commitViewSource]) {
    assert.match(webviewSource, /resolvedViewSubscriptions = vscode\.Disposable\.from/u);
    assert.match(webviewSource, /resolvedViewSubscriptions\?\.dispose\(\)/u);
  }
});
