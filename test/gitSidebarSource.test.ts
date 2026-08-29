import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitSidebarSource = readFileSync(
  new URL("../src/gitSidebar.ts", import.meta.url),
  "utf8",
);

test("uses a native tree icon instead of inline codicon markup", () => {
  assert.doesNotMatch(gitSidebarSource, /\$\(\$\{currentReferenceIconId\}\)/u);
  assert.match(
    gitSidebarSource,
    /new vscode\.ThemeIcon\(\s*currentReferenceIconId,/u,
  );
});
