import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), "test/helpers/vscodeModuleStub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: [...configDefaults.exclude, "test/performance/**"],
    maxWorkers: 2,
    coverage: { reporter: ["text", "lcov"] },
  },
});
