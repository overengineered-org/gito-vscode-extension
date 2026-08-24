import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release asset contract", () => {
  it("uses versioned VSIX, checksum, and provenance assets", () => {
    const releaseConfiguration = readFileSync(
      resolve("release.config.cjs"),
      "utf8",
    );
    expect(releaseConfiguration).toContain("dist/gito-*.vsix");
    expect(releaseConfiguration).toContain("dist/gito-*.vsix.sha256");
    expect(releaseConfiguration).toContain("dist/release-metadata.json");
    expect(releaseConfiguration).toContain('tagFormat: "v${version}"');
  });

  it("builds and loads a separate graph webview bundle", () => {
    const buildScript = readFileSync(resolve("scripts/build.mjs"), "utf8");
    const graphPanel = readFileSync(
      resolve("src/extension/graphExperience/graphExperiencePanel.ts"),
      "utf8",
    );
    expect(buildScript).toContain(
      'entryPoints: ["src/webview/graph/main.tsx"]',
    );
    expect(buildScript).toContain('outfile: "dist/graph.js"');
    expect(graphPanel).toContain('"dist", "graph.js"');
    expect(graphPanel).toContain('"dist", "graph.css"');
  });

  it("packages graph virtual layout without CSP-unsafe inline styles", () => {
    const graphApp = readFileSync(
      resolve("src/webview/graph/GraphExperienceApp.tsx"),
      "utf8",
    );
    const graphPanel = readFileSync(
      resolve("src/extension/graphExperience/graphExperiencePanel.ts"),
      "utf8",
    );
    expect(graphApp).toContain("gito-graph-layout-style");
    expect(graphApp).not.toContain("style={{");
    expect(graphPanel).toContain("gito-webview-style-nonce");
    expect(graphPanel).toContain("'nonce-${escapedContentSecurityNonce}'");
    expect(graphPanel).not.toContain("unsafe-inline");
  });
});
