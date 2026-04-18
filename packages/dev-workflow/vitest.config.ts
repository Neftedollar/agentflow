import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [
      "**/* [0-9]*.*",
      "**/* [0-9]*/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
    passWithNoTests: true,
  },
});
