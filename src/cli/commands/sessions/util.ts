// Shared helpers for the `sessions` subcommands.
//
// Mirrors `graph/util.ts` 1:1 except that the context exposes the raw `Db`
// instead of a typed store — the sessions CLI mostly speaks at the collection
// level (bulk writes for import/export, `deleteMany` for purge/wipe) and the
// `SessionHistoryStore` is read-only, so a per-command store would be unused
// cargo. `printError`, `ok`/`info`/`warn`/`emitJson`, the `--debug`/`DEBUG=1`
// hide-stacks convention, and the `NamespaceNotFound` helper are intentionally
// duplicated rather than extracted into a single `src/cli/util.ts` so this todo
// doesn't change `graph/util.ts`'s contract.

import type { Command } from "commander";
import pc from "picocolors";
import type { Db } from "mongodb";
import { ConfigError, loadConfig, type AppConfig } from "../../../shared/config.js";
import { closeMongo, getMongo, runIndexBootstrap } from "../../../shared/mongo.js";

// Options every leaf `sessions` command inherits from the parent. Mirror
// `doctor`/`graph` so help output is consistent across the CLI surface.
// `--source` is deliberately NOT here — it's a `sync`-only flag because no
// other subcommand reads the source SQLite file.
export interface SessionsGlobalOptions {
  uri?: string;
  db?: string;
  debug?: boolean;
}

export interface SessionsContext {
  config: AppConfig;
  db: Db;
}

// Pull the parent-command options off `cmd`. Commander's option inheritance
// surfaces them via `optsWithGlobals()`; we type-narrow into a known shape so
// callers don't have to deal with `Record<string, unknown>`.
export function readGlobalOptions(cmd: Command): SessionsGlobalOptions {
  const merged = cmd.optsWithGlobals() as Record<string, unknown>;
  const out: SessionsGlobalOptions = {};
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
//     history-schema module registers its bootstrap as a side effect.
//   * Calls `body(ctx)` and uses its return value (or 0) as the process exit
//     code.
//   * Always closes the Mongo client in `finally`.
//
// On failure, the error prints as a single coloured line; the full stack is
// only shown when `--debug` is passed or `DEBUG=1` is set in the environment.
export async function runWithDb(
  cmd: Command,
  body: (ctx: SessionsContext) => Promise<number | void>,
): Promise<never> {
  const opts = readGlobalOptions(cmd);
  const debug = opts.debug === true || process.env.DEBUG === "1";

  let code = 0;
  try {
    const config = loadConfig({ uri: opts.uri, db: opts.db });
    const handle = await getMongo(config);
    await runIndexBootstrap(handle.db);
    const result = await body({ config, db: handle.db });
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

// Small printer helpers — kept identical to `graph/util.ts` so output formatting
// is consistent across the two CLIs.
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

// Status lines that must NOT pollute stdout when `--json` is active. Used by
// `sync --json --once`, where stdout is reserved for the SyncResult object.
export function stderrInfo(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Mongo's `db.collection(x).drop()` rejects with code 26 / codeName
// `NamespaceNotFound` for unknown collections. Treat it as a no-op rather than
// an error so `wipe` is idempotent.
export function isNamespaceNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; codeName?: unknown };
  return e.code === 26 || e.codeName === "NamespaceNotFound";
}
