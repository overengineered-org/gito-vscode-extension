import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFileChangeStatsByCommitHash,
  parseGitLogRecords,
  parseGraphSearchQuery,
  normalizeGraphFileFilter,
} from "../src/graphSearch.ts";

test("parses premium graph filters without losing quoted terms", () => {
  assert.deepEqual(
    parseGraphSearchQuery('fix login author:"Alex Doe" ref:release file:"src/auth flow.ts" message:oauth'),
    {
      authorTerms: ["Alex Doe"],
      filePath: "src/auth flow.ts",
      messageTerms: ["fix", "login", "oauth"],
      refTerms: ["release"],
    },
  );
});

test("keeps file-history filters inside the repository", () => {
  assert.equal(normalizeGraphFileFilter("./src\\feature.ts"), "src/feature.ts");
  assert.throws(() => normalizeGraphFileFilter("../private.txt"), /inside the selected repository/u);
  assert.throws(() => normalizeGraphFileFilter("/tmp/private.txt"), /inside the selected repository/u);
});

test("aggregates visual file-history additions and deletions", () => {
  const commitHash = "d".repeat(40);
  const gitLogOutput = `\u001e${commitHash}\u001f\u001fAlex\u001f1710000000\u001fChange file\n\n12\t3\tsrc/file.ts\n2\t1\tsrc/file.ts`;
  assert.deepEqual(
    parseFileChangeStatsByCommitHash(gitLogOutput).get(commitHash),
    { additions: 14, deletions: 4 },
  );
  assert.equal(parseGitLogRecords(gitLogOutput)[0]?.message, "Change file");
});

test("parses Git history records with parents, author, and timestamp", () => {
  const commitHash = "a".repeat(40);
  const firstParentHash = "b".repeat(40);
  const secondParentHash = "c".repeat(40);
  assert.deepEqual(
    parseGitLogRecords(
      `${commitHash}\u001f${firstParentHash} ${secondParentHash}\u001fAlex Doe\u001f1710000000\u001fMerge safely\u001e\nmalformed\u001e`,
    ),
    [{
      authorName: "Alex Doe",
      commitDate: new Date(1_710_000_000_000),
      hash: commitHash,
      message: "Merge safely",
      parents: [firstParentHash, secondParentHash],
    }],
  );
});
