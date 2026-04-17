import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/* [0-9]*",
      "**/* [0-9]/**",
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
