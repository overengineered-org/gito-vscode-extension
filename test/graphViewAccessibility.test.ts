import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const graphViewSource = readFileSync(
  new URL("../src/graphView.ts", import.meta.url),
  "utf8",
);

test("keeps commit open and action controls as keyboard-accessible siblings", () => {
  const createCommitRowSource = graphViewSource.slice(
    graphViewSource.indexOf("function createCommitRow"),
    graphViewSource.indexOf("function renderWorktrees"),
  );

  assert.match(createCommitRowSource, /commitOpenButton\.type = 'button'/u);
  assert.match(createCommitRowSource, /commitActionsButton\.type = 'button'/u);
  assert.match(
    createCommitRowSource,
    /commitRowElement\.append\(commitOpenButton, commitActionsButton\)/u,
  );
  assert.doesNotMatch(createCommitRowSource, /commitRowElement\.tabIndex/u);
  assert.doesNotMatch(
    createCommitRowSource,
    /commitRowElement\.setAttribute\('role', 'button'\)/u,
  );
});

test("provides a persistent, replayable, keyboard-accessible Graph tour", () => {
  assert.match(
    graphViewSource,
    /id="tour-trigger"[^>]*type="button"[^>]*aria-expanded="false"/u,
  );
  assert.match(
    graphViewSource,
    /id="tour"[^>]*role="dialog"[^>]*aria-live="polite"[^>]*aria-labelledby="tour-title"[^>]*aria-describedby="tour-description"/u,
  );
  assert.match(graphViewSource, /id="tour-trigger"[^>]*><svg[^>]*aria-hidden="true"/u);
  assert.match(
    graphViewSource,
    /if \(!graphTourCompleted && graphViewMessage\.rows\.length\) startGraphTour\(false\)/u,
  );
  assert.match(graphViewSource, /vscode\.postMessage\(\{ type: 'completeGraphTour' \}\)/u);
  assert.match(graphViewSource, /graphViewMessage\.type === "completeGraphTour"/u);
  assert.match(graphViewSource, /globalState\.update\(graphTourCompletedStorageKey, true\)/u);
  assert.match(graphViewSource, /if \(!graphTour\.hidden\) completeGraphTour\(\)/u);
  assert.match(graphViewSource, /\.row-actions\.tour-anchor \{ opacity: 1; \}/u);
});
