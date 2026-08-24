import { describe, expect, it } from "vitest";
import {
  SearchQueryError,
  parseSearchQuery,
  searchDocumentMatches,
  type SearchDocument,
} from "../../../src/extension/compare/searchDsl.js";

const commitDocument: SearchDocument = {
  commitSha: "1111111111111111111111111111111111111111",
  shortSha: "1111111",
  subject: "Fix Parser",
  body: "Handle quoted search values",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.com",
  authorDate: "2026-08-20T09:00:00+10:00",
  refs: ["HEAD -> main", "tag: v1.0"],
  files: [{ path: "src/parser.ts", status: "modified" }],
  patch: "+quoted-value\n",
};

describe("compare search DSL", () => {
  it("parses quoted fields and evaluates match-all queries", () => {
    const query = parseSearchQuery(
      'message:"Fix Parser" author:ada file:parser.ts date:>=2026-08-01',
      { matchAll: true },
    );
    expect(query.clauses).toEqual([
      { field: "message", value: "Fix Parser", operator: "contains" },
      { field: "author", value: "ada", operator: "contains" },
      { field: "file", value: "parser.ts", operator: "contains" },
      { field: "date", value: "2026-08-01", operator: "on-or-after" },
    ]);
    expect(searchDocumentMatches(commitDocument, query)).toBe(true);
  });

  it("supports @me, case-sensitive, regex, refs, and patch fields", () => {
    const query = parseSearchQuery("@me ref:main patch:quoted", {
      currentUser: { email: "ada@example.com" },
      matchAll: true,
      matchCase: false,
    });
    expect(searchDocumentMatches(commitDocument, query)).toBe(true);
    expect(
      searchDocumentMatches(
        commitDocument,
        parseSearchQuery("message:fix", { matchCase: true }),
      ),
    ).toBe(false);
    expect(
      searchDocumentMatches(
        commitDocument,
        parseSearchQuery("patch:^\\+quoted", { regex: true }),
      ),
    ).toBe(true);
  });

  it("rejects invalid regular expressions and malformed dates", () => {
    expect(() => parseSearchQuery("patch:[", { regex: true })).toThrow(
      SearchQueryError,
    );
    expect(() => parseSearchQuery("date:2026-8-1")).toThrow(SearchQueryError);
    expect(() => parseSearchQuery("mystery:value")).toThrow(SearchQueryError);
  });

  it("rejects catastrophic nested quantifiers before evaluation", () => {
    expect(() => parseSearchQuery("message:^(a+)+$", { regex: true })).toThrow(
      /nested quantifiers|Invalid regular expression/,
    );
    expect(() =>
      parseSearchQuery(`message:${"a".repeat(513)}`, { regex: true }),
    ).toThrow(/limited to/);
    for (const unsafePattern of [
      "message:(a|aa)+$",
      "message:a*a*",
      "message:(a+){2,}",
    ]) {
      expect(() => parseSearchQuery(unsafePattern, { regex: true })).toThrow(
        /Only literals|nested quantifiers|Invalid regular expression/,
      );
    }
  });

  it("bounds wildcard matching work against large input", () => {
    const query = parseSearchQuery(`message:${"a".repeat(500)}.`, {
      regex: true,
    });
    expect(() =>
      searchDocumentMatches(
        {
          ...commitDocument,
          subject: "b".repeat(256 * 1024),
        },
        query,
      ),
    ).toThrow(/bounded work budget/);
  });

  it("rejects impossible calendar dates, including non-leap-day February 29", () => {
    expect(() => parseSearchQuery("date:2026-02-29")).toThrow(SearchQueryError);
    expect(() => parseSearchQuery("date:2024-02-29")).not.toThrow();
    expect(() => parseSearchQuery("date:2024-04-31")).toThrow(SearchQueryError);
  });

  it("requires identity input for @me", () => {
    expect(() => parseSearchQuery("@me")).toThrow(/current user/);
  });
});
