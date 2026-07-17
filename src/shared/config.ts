import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseDurationMs } from "./duration.js";

export interface AppConfig {
  documentdbUri: string;
  documentdbDb: string;
  copilotSessionStore: string;
  logLevel: LogLevel;
  syncIntervalMs: number;
  embedding: EmbeddingConfig;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

// -- DocumentDB Search (vector search) configuration ------------------------
//
// "DocumentDB Search" is our name for the embedding-backed vector search that
// augments the graph `search_nodes` tool. Embeddings are produced by a
// pluggable provider; the vectors are indexed and queried through DocumentDB's
// native vector index (wire token `cosmosSearch`). All fields have defaults so
// an unconfigured deployment still works — it just falls back to text-only
// search when the provider is `none` or unreachable.

export type EmbeddingProvider = "local" | "ollama" | "openai" | "azure-openai" | "none";

// Vector index algorithm + distance metric. `vector-ivf` is the lighter,
// faster-to-build default; `vector-hnsw` trades build cost for recall. The
// similarity metric MUST match how the provider normalises its vectors —
// `COS` (cosine) is the safe default for every embedding model we support.
export type VectorIndexKind = "vector-ivf" | "vector-hnsw";
export type VectorSimilarity = "COS" | "L2" | "IP";

export interface EmbeddingConfig {
  // `local` is an alias for `ollama` (a self-hosted Ollama HTTP endpoint), and
  // is the default so a self-hosted deployment needs no external credentials.
  provider: EmbeddingProvider;
  model: string;
  // Base URL for `ollama`/`local` (default http://localhost:11434) and an
  // optional override for `openai` (default https://api.openai.com/v1).
  baseUrl?: string;
  // Bearer token (openai) or api-key (azure-openai).
  apiKey?: string;
  // Azure OpenAI resource endpoint, e.g. https://my-res.openai.azure.com.
  endpoint?: string;
  // Azure OpenAI REST api-version.
  apiVersion: string;
  // Explicit embedding dimensionality. When undefined we probe the provider
  // once at startup and use the observed length to build the vector index.
  dimensions?: number;
  // Vector index tuning.
  indexKind: VectorIndexKind;
  similarity: VectorSimilarity;
  numLists: number; // vector-ivf only
  m: number; // vector-hnsw only
  efConstruction: number; // vector-hnsw only
}

const VALID_EMBEDDING_PROVIDERS: ReadonlySet<EmbeddingProvider> = new Set([
  "local",
  "ollama",
  "openai",
  "azure-openai",
  "none",
]);

const VALID_INDEX_KINDS: ReadonlySet<VectorIndexKind> = new Set(["vector-ivf", "vector-hnsw"]);
const VALID_SIMILARITIES: ReadonlySet<VectorSimilarity> = new Set(["COS", "L2", "IP"]);

// Sensible default embedding model per provider. Kept small + widely-available
// so a fresh install has a working model name without extra configuration.
const DEFAULT_MODEL: Record<EmbeddingProvider, string> = {
  local: "nomic-embed-text",
  ollama: "nomic-embed-text",
  openai: "text-embedding-3-small",
  "azure-openai": "text-embedding-3-small",
  none: "",
};

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

  const embedding = loadEmbeddingConfig();

  return {
    documentdbUri: uri,
    documentdbDb: db,
    copilotSessionStore,
    logLevel: logLevelRaw as LogLevel,
    syncIntervalMs,
    embedding,
  };
}

// Parse the DocumentDB Search / embedding settings from the environment. All
// values have defaults; only genuinely invalid values (bad enum, non-numeric
// dimensions) raise `ConfigError`. Absent credentials are allowed here — the
// embedder factory downgrades to text-only search at runtime instead.
function loadEmbeddingConfig(): EmbeddingConfig {
  const providerRaw = (process.env.MEMORY_EMBEDDING_PROVIDER ?? "local").toLowerCase();
  if (!VALID_EMBEDDING_PROVIDERS.has(providerRaw as EmbeddingProvider)) {
    throw new ConfigError(
      `Invalid MEMORY_EMBEDDING_PROVIDER "${providerRaw}". Expected one of: ${[...VALID_EMBEDDING_PROVIDERS].join(", ")}.`,
    );
  }
  const provider = providerRaw as EmbeddingProvider;

  const model =
    envString("MEMORY_EMBEDDING_MODEL") ?? DEFAULT_MODEL[provider] ?? DEFAULT_MODEL.local;

  const indexKindRaw = (process.env.MEMORY_VECTOR_INDEX_KIND ?? "vector-ivf").toLowerCase();
  if (!VALID_INDEX_KINDS.has(indexKindRaw as VectorIndexKind)) {
    throw new ConfigError(
      `Invalid MEMORY_VECTOR_INDEX_KIND "${indexKindRaw}". Expected one of: ${[...VALID_INDEX_KINDS].join(", ")}.`,
    );
  }

  const similarityRaw = (process.env.MEMORY_VECTOR_SIMILARITY ?? "COS").toUpperCase();
  if (!VALID_SIMILARITIES.has(similarityRaw as VectorSimilarity)) {
    throw new ConfigError(
      `Invalid MEMORY_VECTOR_SIMILARITY "${similarityRaw}". Expected one of: ${[...VALID_SIMILARITIES].join(", ")}.`,
    );
  }

  return {
    provider,
    model,
    baseUrl: envString("MEMORY_EMBEDDING_BASE_URL"),
    apiKey: envString("MEMORY_EMBEDDING_API_KEY"),
    endpoint: envString("MEMORY_EMBEDDING_ENDPOINT"),
    apiVersion: envString("MEMORY_EMBEDDING_API_VERSION") ?? "2024-02-01",
    dimensions: envPositiveInt("MEMORY_EMBEDDING_DIMENSIONS"),
    indexKind: indexKindRaw as VectorIndexKind,
    similarity: similarityRaw as VectorSimilarity,
    numLists: envPositiveInt("MEMORY_VECTOR_NUM_LISTS") ?? 100,
    m: envPositiveInt("MEMORY_VECTOR_HNSW_M") ?? 16,
    efConstruction: envPositiveInt("MEMORY_VECTOR_HNSW_EF_CONSTRUCTION") ?? 64,
  };
}

function envString(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

function envPositiveInt(key: string): number | undefined {
  const raw = envString(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${key} must be a positive integer (got "${raw}").`);
  }
  return n;
}

export function defaultSessionStorePath(): string {
  return resolve(homedir(), ".copilot", "session-store.db");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}
