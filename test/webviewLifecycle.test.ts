import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("only caches graph state after the webview receives it", () => {
  assert.match(graphViewSource, /const graphStateDelivered = await/u);
  assert.match(graphViewSource, /if \(graphStateDelivered &&/u);
});

test("owns every resolved webview subscription", () => {
  for (const webviewSource of [graphViewSource, commitViewSource]) {
    assert.match(webviewSource, /resolvedViewSubscriptions = vscode\.Disposable\.from/u);
    assert.match(webviewSource, /resolvedViewSubscriptions\?\.dispose\(\)/u);
  }
});
