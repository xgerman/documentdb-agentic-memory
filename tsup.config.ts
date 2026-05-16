import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "server/index": "src/server/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // better-sqlite3 is a native module; tsup must not try to bundle it.
  external: ["better-sqlite3", "mongodb"],
  onSuccess: "chmod +x dist/server/index.js dist/cli/index.js",
});
