import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ageflow/core": resolve(__dirname, "../../core/src/index.ts"),
      "@ageflow/runner-api": resolve(__dirname, "../api/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/* [0-9]*",
      "**/* [0-9]/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
    passWithNoTests: true,
  },
});
