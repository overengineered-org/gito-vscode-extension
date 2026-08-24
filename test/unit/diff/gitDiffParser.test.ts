import { describe, expect, it } from "vitest";
import {
  parseDiffHunks,
  parseRawDiffMetadata,
} from "../../../src/extension/diff/gitDiffParser.js";

describe("Git diff parser", () => {
  it("parses rename, binary, symlink, and submodule metadata from NUL records", () => {
    const rawOutput = [
      ":100644 100644 1111111 2222222 R087",
      "old name.txt",
      "new name.txt",
      ":100644 100644 3333333 4444444 M",
      "image.bin",
      ":120000 120000 5555555 6666666 M",
      "link",
      ":160000 160000 7777777 8888888 M",
      "vendor/module",
      "",
    ].join("\0");
    const numstatOutput = [
      "0\t0\t",
      "old name.txt",
      "new name.txt",
      "-\t-\timage.bin",
      "1\t1\tlink",
      "-\t-\tvendor/module",
      "",
    ].join("\0");
    const parsed = parseRawDiffMetadata(rawOutput, numstatOutput, 20, 20_000);

    expect(parsed.truncated).toBe(false);
    expect(parsed.records).toHaveLength(4);
    expect(parsed.records[0]?.metadata).toMatchObject({
      changeType: "renamed",
      oldPath: "old name.txt",
      newPath: "new name.txt",
      similarityPercent: 87,
    });
    expect(parsed.records[1]?.metadata.isBinary).toBe(true);
    expect(parsed.records[2]?.metadata.isSymlink).toBe(true);
    expect(parsed.records[3]?.metadata.isSubmodule).toBe(true);
  });

  it("does not mark exactly capped complete records as truncated", () => {
    const rawOutput = ":100644 100644 1111111 2222222 M\0file.txt\0";
    const numstatOutput = "1\t1\tfile.txt\0";

    const parsed = parseRawDiffMetadata(rawOutput, numstatOutput, 1, 1_000);

    expect(parsed.records).toHaveLength(1);
    expect(parsed.truncated).toBe(false);
  });

  it("parses zero-context hunk ranges and enforces navigation caps", () => {
    const parsed = parseDiffHunks(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -2,0 +2,2 @@",
        "+added",
        "+line",
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -8,3 +10,1 @@",
        " context",
      ].join("\n"),
      1,
      20_000,
    );

    expect(parsed.truncated).toBe(true);
    expect(parsed.rangesByPath.get("src/app.ts")).toEqual([
      {
        oldStartLine: 2,
        oldLineCount: 0,
        newStartLine: 2,
        newLineCount: 2,
      },
    ]);
  });

  it("maps quoted tab and UTF-8 paths from patch headers", () => {
    const parsed = parseDiffHunks(
      [
        'diff --git "a/na\\303\\251me\\tfile.txt" "b/na\\303\\251me\\tfile.txt"',
        "@@ -1 +1,2 @@",
      ].join("\n"),
      10,
      20_000,
    );
    expect(parsed.rangesByPath.get("naéme\tfile.txt")).toEqual([
      { oldStartLine: 1, oldLineCount: 1, newStartLine: 1, newLineCount: 2 },
    ]);
  });

  it("caps raw output in UTF-8 bytes and drops an incomplete path token", () => {
    const header = ":100644 100644 1111111 2222222 M";
    const rawOutput = `${header}\0café.txt\0`;
    const maxBytes = Buffer.byteLength(`${header}\0café.txt`, "utf8");

    const parsed = parseRawDiffMetadata(rawOutput, "", 20, maxBytes);

    expect(parsed.records).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });

  it("drops incomplete rename paths from capped numstat output", () => {
    const rawOutput = ":100644 100644 1111111 2222222 R100\0old.txt\0new.txt\0";
    const numstatOutput = "0\t0\t\0old.txt\0new";

    const parsed = parseRawDiffMetadata(rawOutput, numstatOutput, 20, 20_000);

    expect(parsed.records[0]?.metadata).toMatchObject({
      changeType: "renamed",
      oldPath: "old.txt",
      newPath: "new.txt",
      additions: 0,
      deletions: 0,
    });
    expect(parsed.truncated).toBe(true);
  });

  it("caps patch output in UTF-8 bytes without hiding parsed ranges", () => {
    const patchOutput = [
      "diff --git a/file.txt b/file.txt",
      "@@ -1 +1 @@",
      "+é",
    ].join("\n");
    const parsed = parseDiffHunks(
      patchOutput,
      20,
      Buffer.byteLength(patchOutput, "utf8") - 1,
    );

    expect(parsed.truncated).toBe(true);
    expect(parsed.rangesByPath.get("file.txt")).toEqual([
      { oldStartLine: 1, oldLineCount: 1, newStartLine: 1, newLineCount: 1 },
    ]);
  });
});
