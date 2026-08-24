import { describe, expect, it } from "vitest";
import {
  classifyConflictEntry,
  parseConflictStatusRecords,
  parseUnmergedIndexEntries,
} from "../../../src/extension/conflicts/index.js";

describe("conflict parsers", () => {
  it("keeps stage 1/2/3 object ids and paths containing spaces", () => {
    const entries = parseUnmergedIndexEntries(
      [
        "100644 base-object 1\tpath with spaces.txt",
        "100644 current-object 2\tpath with spaces.txt",
        "100644 incoming-object 3\tpath with spaces.txt",
      ].join("\0") + "\0",
    );

    expect(entries).toEqual([
      {
        mode: "100644",
        objectId: "base-object",
        path: "path with spaces.txt",
        stage: 1,
      },
      {
        mode: "100644",
        objectId: "current-object",
        path: "path with spaces.txt",
        stage: 2,
      },
      {
        mode: "100644",
        objectId: "incoming-object",
        path: "path with spaces.txt",
        stage: 3,
      },
    ]);
  });

  it("preserves tabs and newlines inside literal index paths", () => {
    const literalPath = "odd\tname\n.txt";
    const entries = parseUnmergedIndexEntries(
      [
        `100644 base-object 1\t${literalPath}`,
        `100644 current-object 2\t${literalPath}`,
        `100644 incoming-object 3\t${literalPath}`,
      ].join("\0") + "\0",
    );

    expect(entries.every((entry) => entry.path === literalPath)).toBe(true);
  });

  it("parses v2 unmerged records and classifies conflict forms", () => {
    const records = parseConflictStatusRecords(
      "u UU N... 100644 100644 100644 100644 base current incoming path.txt\0original.txt\0",
    );
    expect(records).toEqual([
      {
        path: "path.txt",
        originalPath: undefined,
        statusCode: "UU",
      },
    ]);
    expect(
      classifyConflictEntry(
        "AA",
        {
          base: undefined,
          current: { exists: true },
          incoming: { exists: true },
        },
        undefined,
        false,
        false,
      ),
    ).toBe("add-add");
    expect(
      classifyConflictEntry(
        "UU",
        {
          base: { exists: true },
          current: { exists: true },
          incoming: { exists: true },
        },
        undefined,
        true,
        false,
      ),
    ).toBe("binary");
  });

  it("does not consume a status-like path as a synthetic rename source", () => {
    const records = parseConflictStatusRecords(
      "u UU N... 100644 100644 100644 100644 base current incoming destination.txt\0u source.txt\0",
    );

    expect(records).toEqual([
      {
        path: "destination.txt",
        originalPath: undefined,
        statusCode: "UU",
      },
    ]);
  });

  it("accepts porcelain-v2 type-change status codes", () => {
    expect(
      parseConflictStatusRecords(
        "u TU N... 100644 100644 000000 100644 base current incoming type-change.txt\0u source.txt\0",
      ),
    ).toEqual([
      {
        path: "type-change.txt",
        originalPath: undefined,
        statusCode: "TU",
      },
    ]);
  });
});
