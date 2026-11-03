import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // DOM tests run in happy-dom on a fixed https origin; node-only tests opt out per file.
    environment: "happy-dom",
    environmentOptions: { happyDOM: { url: "https://www.example.com/pricing" } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
