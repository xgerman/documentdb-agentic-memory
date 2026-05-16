import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // `hookTimeout` covers `MongoMemoryServer.create()` in
    // `test/global-setup.ts`, which downloads the `mongod` binary on first
    // run. 120s is comfortably above the cold-cache time on a slow CI runner.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: "forks",
    globalSetup: ["./test/global-setup.ts"],
  },
});
