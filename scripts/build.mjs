import { build } from "esbuild";

const sharedBuildOptions = {
  bundle: true,
  minify: true,
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...sharedBuildOptions,
    entryPoints: ["src/extension/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: ["src/webview/main.tsx"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    loader: { ".ttf": "file" },
    assetNames: "[name]",
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: ["src/webview/graph/main.tsx"],
    outfile: "dist/graph.js",
    platform: "browser",
    format: "iife",
    assetNames: "[name]",
  }),
]);
