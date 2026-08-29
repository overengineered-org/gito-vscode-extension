import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const changesSidebarSource = readFileSync(
  new URL("../src/changesSidebar.ts", import.meta.url),
  "utf8",
);

test("mutates the requested Git resources instead of the active Source Control row", () => {
  assert.doesNotMatch(changesSidebarSource, /executeCommand\("git\.(?:stage|unstage|clean)"/u);
  assert.match(changesSidebarSource, /repository\.add\(\[sidebarNode\.change\.uri\]\)/u);
  assert.match(changesSidebarSource, /repository\.revert\(\[sidebarNode\.change\.uri\]\)/u);
  assert.match(changesSidebarSource, /repository\.clean\(\[sidebarNode\.change\.uri\]\)/u);
  assert.match(changesSidebarSource, /showWarningMessage/u);
});

test("assigns stable IDs to every changes-tree node", () => {
  assert.match(changesSidebarSource, /"change-group"/u);
  assert.match(changesSidebarSource, /"change"/u);
  assert.match(changesSidebarSource, /"working-tree-clean"/u);
});
