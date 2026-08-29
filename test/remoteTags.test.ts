import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GitReferenceType } from "../src/gitModel.ts";
import { parseRemoteTagReferences } from "../src/remoteTags.ts";

const remoteTagsSource = readFileSync(
  new URL("../src/remoteTags.ts", import.meta.url),
  "utf8",
);

test("resolves annotated and lightweight remote tags to their target commits", () => {
  const annotatedTagObject = "a".repeat(40);
  const annotatedTagCommit = "c".repeat(40);
  const sha256Commit = "b".repeat(64);
  const remoteTagOutput = [
    `${annotatedTagObject}\trefs/tags/v1.0.0`,
    `${annotatedTagCommit}\trefs/tags/v1.0.0^{}`,
    `${sha256Commit}\trefs/tags/v2.0.0`,
    "malformed",
  ].join("\n");

  assert.deepEqual(parseRemoteTagReferences(remoteTagOutput), [
    { commit: annotatedTagCommit, name: "v1.0.0", type: GitReferenceType.tag },
    { commit: sha256Commit, name: "v2.0.0", type: GitReferenceType.tag },
  ]);
});

test("requests peeled tags with VS Code Git authentication", () => {
  assert.doesNotMatch(remoteTagsSource, /"--refs"/u);
  assert.match(remoteTagsSource, /\.\.\.gitEnvironment/u);
});
