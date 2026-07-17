// Shared helpers for the `graph` subcommands.
//
// The CLI surface is intentionally thin (per the plan, reads delegate to
// FUSE), but every subcommand still needs the same plumbing: resolve the
// connection options, open the shared Mongo handle, hand the store to the
// command body, and tear the connection down even if the command throws.
// Centralising that here keeps each subcommand file tiny and consistent.

import type { Command } from "commander";
import pc from "picocolors";
import type { Db } from "mongodb";
import { ConfigError, loadConfig, type AppConfig } from "../../../shared/config.js";
import { closeMongo, getMongo, runIndexBootstrap } from "../../../shared/mongo.js";
import { createEmbedder } from "../../../shared/embeddings/index.js";
import { createLogger } from "../../../shared/logging.js";
import { KnowledgeGraphStore } from "../../../storage/graph/index.js";

// Options every leaf graph command inherits from the parent `graph` command.
// They mirror `doctor`'s shape so help output is consistent.
export interface GraphGlobalOptions {
  uri?: string;
  db?: string;
  debug?: boolean;
}

export interface GraphContext {
  config: AppConfig;
  db: Db;
  store: KnowledgeGraphStore;
}

// Pull the connection-related options off the parent `graph` command. We
// register `--uri/--db/--debug` once at the parent level and let commander's
// option inheritance surface them to every leaf via `optsWithGlobals()`.
export function readGlobalOptions(cmd: Command): GraphGlobalOptions {
  const merged = cmd.optsWithGlobals() as Record<string, unknown>;
  const out: GraphGlobalOptions = {};
  if (typeof merged.uri === "string") out.uri = merged.uri;
  if (typeof merged.db === "string") out.db = merged.db;
  if (merged.debug === true) out.debug = true;
  return out;
}

// Wraps a command body in the standard bootstrap+teardown lifecycle.
//
//   * Loads config (errors print cleanly and exit 1).
//   * Opens the shared Mongo handle.
//   * Runs `runIndexBootstrap` so indexes exist on first run. Importing the
//     graph store module already registers its bootstrap as a side effect.
//   * When `options.withEmbedder` is set, builds the embedding provider (so
//     writes produce vectors) and ensures the vector index exists. Read-only
//     admin commands omit this to avoid a network probe on every invocation.
//   * Calls `body(ctx)` which is expected to return a process exit code.
//   * Always closes the Mongo client in `finally`.
//
// On failure, the error is printed as a single coloured line; the full stack
// is only shown when --debug is passed or DEBUG=1 is set in the environment.
export async function runWithStore(
  cmd: Command,
  body: (ctx: GraphContext) => Promise<number | void>,
  options: { withEmbedder?: boolean } = {},
): Promise<never> {
  const opts = readGlobalOptions(cmd);
  const debug = opts.debug === true || process.env.DEBUG === "1";

  let code = 0;
  try {
    const config = loadConfig({ uri: opts.uri, db: opts.db });
    const handle = await getMongo(config);
    await runIndexBootstrap(handle.db);
    let store: KnowledgeGraphStore;
    if (options.withEmbedder === true) {
      const log = createLogger(config.logLevel, "documentdb-memory-cli");
      const embedder = await createEmbedder(config.embedding, log);
      store = new KnowledgeGraphStore(handle.db, {
        embedder,
        embeddingConfig: config.embedding,
        logger: log,
      });
      if (embedder !== null) await store.ensureVectorIndex();
    } else {
      store = new KnowledgeGraphStore(handle.db);
    }
    const result = await body({ config, db: handle.db, store });
    code = typeof result === "number" ? result : 0;
  } catch (err) {
    code = 1;
    printError(err, debug);
  } finally {
    await closeMongo().catch(() => undefined);
  }
  process.exit(code);
}

// Print errors uniformly — one red line by default, full stack only when the
// user opted into noisy output. Config errors are highlighted separately so
// "did you forget --uri?" is immediately obvious.
export function printError(err: unknown, debug: boolean): void {
  if (err instanceof ConfigError) {
    process.stderr.write(`${pc.red("error:")} ${err.message}\n`);
    return;
  }
  if (err instanceof Error) {
    if (debug && err.stack !== undefined) {
      process.stderr.write(`${err.stack}\n`);
    } else {
      process.stderr.write(`${pc.red("error:")} ${err.message}\n`);
    }
    return;
  }
  process.stderr.write(`${pc.red("error:")} ${String(err)}\n`);
}

// Small printer helpers — pulled out so the call sites stay readable and we
// don't sprinkle `process.stdout.write` everywhere.
export function ok(line: string): void {
  process.stdout.write(`${pc.green("ok")} ${line}\n`);
}

export function info(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function warn(line: string): void {
  process.stdout.write(`${pc.yellow("warn")} ${line}\n`);
}

export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
