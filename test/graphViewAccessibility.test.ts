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
