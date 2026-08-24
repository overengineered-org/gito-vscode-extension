import { describe, expect, it } from "vitest";
import { takeUtf8Prefix } from "../../../src/extension/git/utf8.js";

describe("takeUtf8Prefix", () => {
  it("keeps complete Unicode code points within the byte budget", () => {
    expect(takeUtf8Prefix("a🙂b", 1)).toBe("a");
    expect(takeUtf8Prefix("a🙂b", 5)).toBe("a🙂");
    expect(takeUtf8Prefix("a🙂b", 6)).toBe("a🙂b");
  });

  it("returns an empty prefix for non-positive budgets", () => {
    expect(takeUtf8Prefix("content", 0)).toBe("");
    expect(takeUtf8Prefix("content", -1)).toBe("");
  });
});
