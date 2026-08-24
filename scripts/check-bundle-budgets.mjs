import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const outputLogger = globalThis.console;

const bundleBudgets = [
  { bundlePath: "dist/extension.js", maximumGzipBytes: 300 * 1024 },
  { bundlePath: "dist/graph.js", maximumGzipBytes: 100 * 1024 },
  { bundlePath: "dist/webview.js", maximumGzipBytes: 100 * 1024 },
];

for (const { bundlePath, maximumGzipBytes } of bundleBudgets) {
  const compressedByteCount = gzipSync(
    await readFile(join(import.meta.dirname, "..", bundlePath)),
    {
      level: 9,
    },
  ).byteLength;
  if (compressedByteCount > maximumGzipBytes) {
    throw new Error(
      `${bundlePath} is ${compressedByteCount} gzip bytes; maximum is ${maximumGzipBytes}.`,
    );
  }
  outputLogger.log(
    `${bundlePath}: ${compressedByteCount} gzip bytes / ${maximumGzipBytes} budget`,
  );
}
