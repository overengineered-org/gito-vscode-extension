import assert from "node:assert/strict";
import test from "node:test";

import { GitReferenceType } from "../src/gitModel.ts";
import { parseRemoteTagReferences } from "../src/remoteTags.ts";

test("resolves annotated and lightweight remote tags to their target commits", () => {
  const annotatedTagObject = "a".repeat(40);
  const annotatedTagCommit = "c".repeat(40);
  const sha256Commit = "b".repeat(64);
  const remoteTagOutput = [
    `${annotatedTagObject}\trefs/tags/v1.0.0`,
    `${annotatedTagCommit}\trefs/tags/v1.0.0^{}`,
    `${sha256Commit}\trefs/tags/v2.0.0`,
    "malformed",
  ].join("\r\n");

  assert.deepEqual(parseRemoteTagReferences(remoteTagOutput), [
    { commit: annotatedTagCommit, name: "v1.0.0", type: GitReferenceType.tag },
    { commit: sha256Commit, name: "v2.0.0", type: GitReferenceType.tag },
  ]);
});
