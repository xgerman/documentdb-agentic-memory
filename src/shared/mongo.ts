import { MongoClient, type Db } from "mongodb";
import type { AppConfig } from "./config.js";

// Shared MongoClient handle. Stores (graph + history) share one client per
// process so we open at most one connection pool. The handle is created lazily
// and closed via `closeMongo()` on shutdown.

let cached: { client: MongoClient; uri: string } | null = null;

export interface MongoHandle {
  client: MongoClient;
  db: Db;
}

export async function getMongo(config: AppConfig): Promise<MongoHandle> {
  if (cached === null || cached.uri !== config.documentdbUri) {
    if (cached !== null) {
      await cached.client.close().catch(() => undefined);
      cached = null;
    }
    const client = new MongoClient(config.documentdbUri, {
      // Reasonable defaults for a long-running daemon + short-lived CLIs.
      // The driver's own defaults are fine for everything else.
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    cached = { client, uri: config.documentdbUri };
  }
  return { client: cached.client, db: cached.client.db(config.documentdbDb) };
}

export async function closeMongo(): Promise<void> {
  if (cached !== null) {
    await cached.client.close().catch(() => undefined);
    cached = null;
  }
}

// Registry of `ensureIndexes` callbacks contributed by each store. The MCP
// server and the CLI call `runIndexBootstrap()` once on startup; individual
// stores register themselves via `registerIndexBootstrap()` at module load.

type IndexBootstrap = (db: Db) => Promise<void>;
const bootstraps: IndexBootstrap[] = [];

export function registerIndexBootstrap(fn: IndexBootstrap): void {
  bootstraps.push(fn);
}

export async function runIndexBootstrap(db: Db): Promise<void> {
  for (const fn of bootstraps) {
    await fn(db);
  }
}
