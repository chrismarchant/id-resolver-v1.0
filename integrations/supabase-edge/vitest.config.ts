import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // All files share one PostgreSQL database.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
