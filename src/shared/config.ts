import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseDurationMs } from "./duration.js";

export interface AppConfig {
  documentdbUri: string;
  documentdbDb: string;
  copilotSessionStore: string;
  logLevel: LogLevel;
  syncIntervalMs: number;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const VALID_LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

export interface ConfigOverrides {
  uri?: string;
  db?: string;
  source?: string;
  logLevel?: string;
  interval?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const uri = overrides.uri ?? process.env.DOCUMENTDB_URI ?? process.env.MONGODB_URI;
  if (!uri || uri.trim() === "") {
    throw new ConfigError(
      "DOCUMENTDB_URI (or MONGODB_URI) is required. Set it in .env or pass --uri.",
    );
  }

  const db = overrides.db ?? process.env.DOCUMENTDB_DB ?? "copilot_memory";

  const sessionStoreRaw =
    overrides.source ?? process.env.COPILOT_SESSION_STORE ?? defaultSessionStorePath();
  const copilotSessionStore = resolve(expandHome(sessionStoreRaw));

  const logLevelRaw = (overrides.logLevel ?? process.env.MEMORY_LOG_LEVEL ?? "info").toLowerCase();
  if (!VALID_LOG_LEVELS.has(logLevelRaw as LogLevel)) {
    throw new ConfigError(
      `Invalid MEMORY_LOG_LEVEL "${logLevelRaw}". Expected one of: ${[...VALID_LOG_LEVELS].join(", ")}.`,
    );
  }

  const syncIntervalStr = overrides.interval ?? process.env.SYNC_INTERVAL ?? "30s";
  const syncIntervalMs = parseDurationMs(syncIntervalStr);
  if (syncIntervalMs <= 0) {
    throw new ConfigError(`SYNC_INTERVAL must be a positive duration (got "${syncIntervalStr}").`);
  }

  return {
    documentdbUri: uri,
    documentdbDb: db,
    copilotSessionStore,
    logLevel: logLevelRaw as LogLevel,
    syncIntervalMs,
  };
}

export function defaultSessionStorePath(): string {
  return resolve(homedir(), ".copilot", "session-store.db");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}
