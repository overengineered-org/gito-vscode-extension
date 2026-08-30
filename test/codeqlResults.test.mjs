import assert from "node:assert/strict";
import test from "node:test";

import { collectUnsuppressedCodeqlFindings } from "../scripts/assert-codeql-results.mjs";

test("reports only actionable CodeQL findings with useful locations", () => {
  const unsuppressedCodeqlFindings = collectUnsuppressedCodeqlFindings([
    {
      runs: [
        {
          results: [
            {
              locations: [
                { physicalLocation: { artifactLocation: { uri: "src/extension.ts" } } },
              ],
              message: { text: "Unsafe operation" },
              ruleId: "js/example",
            },
            {
              message: { text: "Accepted risk" },
              ruleId: "js/suppressed",
              suppressions: [{ kind: "external" }],
            },
          ],
        },
      ],
    },
  ]);

  assert.deepEqual(unsuppressedCodeqlFindings, [
    {
      message: "Unsafe operation",
      ruleIdentifier: "js/example",
      sourceLocation: "src/extension.ts",
    },
  ]);
});

test("accepts CodeQL runs without findings", () => {
  assert.deepEqual(collectUnsuppressedCodeqlFindings([{ runs: [{ results: [] }] }]), []);
  assert.deepEqual(collectUnsuppressedCodeqlFindings([{ runs: [] }]), []);
});
