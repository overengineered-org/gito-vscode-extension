import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), "test/helpers/vscodeModuleStub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/performance/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
