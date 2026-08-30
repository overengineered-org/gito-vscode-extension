import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBlameAge,
  formatLineBlameAnnotation,
  parseLineBlame,
} from "../src/blameModel.ts";

test("parses committed and uncommitted line authorship", () => {
  const commitHash = "a".repeat(40);
  assert.deepEqual(
    parseLineBlame([
      `${commitHash} 1 1 1`,
      "author Alex Doe",
      "author-time 1710000000",
      "summary fix: preserve work",
      "\tcontent",
    ].join("\n")),
    {
      authorName: "Alex Doe",
      authoredAt: new Date(1_710_000_000_000),
      commitHash,
      summary: "fix: preserve work",
    },
  );
  assert.deepEqual(
    parseLineBlame(`${"0".repeat(40)} 1 1 1\nauthor Not Committed Yet\nsummary Version of file\n`),
    { authorName: "You", summary: "Uncommitted change" },
  );
});

test("formats concise inline blame without splitting grapheme clusters", () => {
  const familyEmoji = "👨‍👩‍👧‍👦";
  assert.equal(
    formatLineBlameAnnotation(
      { authorName: "Alex", summary: familyEmoji.repeat(4) },
      "2d",
      3,
    ),
    `  Alex · 2d · ${familyEmoji.repeat(2)}…`,
  );
});

test("formats blame age at useful human boundaries", () => {
  const now = new Date("2026-08-30T00:00:00Z");
  assert.equal(formatBlameAge(new Date("2026-08-29T23:58:00Z"), now), "2m");
  assert.equal(formatBlameAge(new Date("2026-08-27T00:00:00Z"), now), "3d");
  assert.equal(formatBlameAge(new Date("2024-08-30T00:00:00Z"), now), "2y");
});
