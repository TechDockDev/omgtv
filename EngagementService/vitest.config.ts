import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/audience/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share one Postgres database and truncate between tests.
    fileParallelism: false,
  },
});
