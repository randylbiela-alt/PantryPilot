import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",

    include: [
      "tests/integration/**/*.test.ts"
    ],

    hookTimeout: 60_000,
    testTimeout: 30_000,
    teardownTimeout: 30_000,

    fileParallelism: false,
    maxWorkers: 1,

    reporters: [
      "default"
    ]
  }
});
