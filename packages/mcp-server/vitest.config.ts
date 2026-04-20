import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const serverSqliteSource = fileURLToPath(
  new URL("../server-sqlite/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // Keep tests on workspace source to avoid dependency prebundle issues
      // around Bun builtins (bun:sqlite) in dist artifacts.
      "@ageflow/server-sqlite": serverSqliteSource,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/* [0-9]*.*",
      "**/* [0-9]*/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
    typecheck: {
      enabled: true,
      include: ["src/**/*.test-d.ts"],
    },
    passWithNoTests: true,
  },
});
