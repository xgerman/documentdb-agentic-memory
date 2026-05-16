import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { ConfigError, defaultSessionStorePath, loadConfig } from "../../src/shared/config.js";

// `loadConfig` is heavily env-driven. We snapshot the relevant variables
// before each test so a single noisy env var on the host cannot bleed in.
const RELEVANT_ENV_KEYS = [
  "DOCUMENTDB_URI",
  "MONGODB_URI",
  "DOCUMENTDB_DB",
  "COPILOT_SESSION_STORE",
  "MEMORY_LOG_LEVEL",
  "SYNC_INTERVAL",
] as const;

describe("loadConfig", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const k of RELEVANT_ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of RELEVANT_ENV_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("throws ConfigError when no URI is configured anywhere", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("accepts URI via overrides", () => {
    const cfg = loadConfig({ uri: "mongodb://x:27017" });
    expect(cfg.documentdbUri).toBe("mongodb://x:27017");
  });

  it("falls back to DOCUMENTDB_URI env when no override is provided", () => {
    process.env.DOCUMENTDB_URI = "mongodb://env-host:27017";
    const cfg = loadConfig({});
    expect(cfg.documentdbUri).toBe("mongodb://env-host:27017");
  });

  it("falls back to MONGODB_URI when DOCUMENTDB_URI is unset", () => {
    process.env.MONGODB_URI = "mongodb://mongo-env:27017";
    const cfg = loadConfig({});
    expect(cfg.documentdbUri).toBe("mongodb://mongo-env:27017");
  });

  it("overrides win over env vars", () => {
    process.env.DOCUMENTDB_URI = "mongodb://env-host:27017";
    process.env.DOCUMENTDB_DB = "env_db";
    const cfg = loadConfig({ uri: "mongodb://override:27017", db: "override_db" });
    expect(cfg.documentdbUri).toBe("mongodb://override:27017");
    expect(cfg.documentdbDb).toBe("override_db");
  });

  it("defaults DB name to copilot_memory when neither override nor env is set", () => {
    const cfg = loadConfig({ uri: "mongodb://x:27017" });
    expect(cfg.documentdbDb).toBe("copilot_memory");
  });

  it("rejects a whitespace-only URI", () => {
    expect(() => loadConfig({ uri: "   " })).toThrow(ConfigError);
  });

  it("rejects an invalid MEMORY_LOG_LEVEL", () => {
    expect(() => loadConfig({ uri: "mongodb://x:27017", logLevel: "not-a-level" })).toThrow(
      ConfigError,
    );
  });

  it("accepts a valid log level case-insensitively", () => {
    const cfg = loadConfig({ uri: "mongodb://x:27017", logLevel: "DEBUG" });
    expect(cfg.logLevel).toBe("debug");
  });

  it("defaults syncIntervalMs from the '30s' default", () => {
    const cfg = loadConfig({ uri: "mongodb://x:27017" });
    expect(cfg.syncIntervalMs).toBe(30_000);
  });

  it("rejects invalid SYNC_INTERVAL via override", () => {
    expect(() => loadConfig({ uri: "mongodb://x:27017", interval: "invalid" })).toThrow();
  });

  it("expands a leading ~ in session-store path", () => {
    const cfg = loadConfig({ uri: "mongodb://x:27017", source: "~/custom/store.db" });
    expect(cfg.copilotSessionStore).toBe(resolve(homedir(), "custom", "store.db"));
  });
});

describe("defaultSessionStorePath", () => {
  it("returns ~/.copilot/session-store.db", () => {
    const p = defaultSessionStorePath();
    // Use platform `sep` to keep the test portable. On Unix this is "/"; on
    // Windows the resolved path uses backslashes.
    const expectedTail = `${sep}.copilot${sep}session-store.db`;
    expect(p.endsWith(expectedTail)).toBe(true);
    expect(p.startsWith(homedir())).toBe(true);
  });
});
