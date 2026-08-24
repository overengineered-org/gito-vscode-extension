import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

describe("production bundle budgets", () => {
  it("keeps extension and webview gzip sizes within the contract", () => {
    const bundleBudgets = [
      { bundlePath: "dist/extension.js", maximumGzipBytes: 300 * 1024 },
      { bundlePath: "dist/graph.js", maximumGzipBytes: 100 * 1024 },
      { bundlePath: "dist/webview.js", maximumGzipBytes: 100 * 1024 },
    ];
    for (const { bundlePath, maximumGzipBytes } of bundleBudgets) {
      expect(existsSync(bundlePath)).toBe(true);
      expect(
        gzipSync(readFileSync(bundlePath), { level: 9 }).byteLength,
      ).toBeLessThanOrEqual(maximumGzipBytes);
    }
  });
});
