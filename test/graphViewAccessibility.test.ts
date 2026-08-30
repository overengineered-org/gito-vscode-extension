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

test("keeps onboarding out of the compact Graph view", () => {
  assert.doesNotMatch(graphViewSource, /id="tour"/u);
  assert.doesNotMatch(graphViewSource, /startGraphTour/u);
  assert.doesNotMatch(graphViewSource, /completeGraphTour/u);
  assert.doesNotMatch(graphViewSource, /graphTourCompleted/u);
});

test("animates Graph hierarchy once per repository and respects reduced motion", () => {
  assert.match(
    graphViewSource,
    /const shouldAnimateGraph = currentRepositoryPath !== graphViewMessage\.repositoryPath/u,
  );
  assert.match(
    graphViewSource,
    /shouldAnimateGraph && commitRowIndex < 12/u,
  );
  assert.match(graphViewSource, /graphPath\.setAttribute\('pathLength', '1'\)/u);
  assert.match(graphViewSource, /@keyframes graph-path-enter/u);
  assert.match(
    graphViewSource,
    /@media \(prefers-reduced-motion: reduce\)[^}]*animation-duration: \.01ms !important/u,
  );
});
