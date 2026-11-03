import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Compiles the project once so end-to-end tests fork the compiled child.
    globalSetup: ["test/helpers/global-setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one PostgreSQL database; run files sequentially
    // so reservation/cap tests observe deterministic counters.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
