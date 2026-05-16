// Vitest global setup. Starts ONE in-memory MongoDB instance for the entire
// test run and publishes its connection URI via `provide()`. Storage-layer
// tests pick the URI up through `inject('mongoUri')` (see `test/setup.ts`).
//
// MongoMemoryServer downloads the `mongod` binary on first use, which can
// take a while in CI. The vitest `hookTimeout` is bumped in `vitest.config.ts`
// to accommodate this.

import { MongoMemoryServer } from "mongodb-memory-server";
import type { GlobalSetupContext } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  // MongoDB doesn't publish ARM64 Debian binaries; mongodb-memory-server
  // defaults to the host distro and 404s on aarch64-debian. Pin to a binary
  // distro/version that exists for both x64 and arm64 (Ubuntu 22.04 + 7.0.14
  // has builds for every supported arch). Env vars take precedence over this
  // default so CI can still override.
  process.env.MONGOMS_DISTRO ??= "ubuntu-22.04";
  process.env.MONGOMS_VERSION ??= "7.0.14";

  const server = await MongoMemoryServer.create();
  provide("mongoUri", server.getUri());
  return async () => {
    await server.stop();
  };
}
