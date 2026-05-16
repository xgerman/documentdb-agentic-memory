// `documentdb-memory sessions sync [--once | --watch | --full]
//                                  [--interval <dur>] [--source <path>] [--json]`.
//
// Sync owns its own bootstrap (no `runWithDb`) because it needs a logger and a
// `SessionHistorySync` instance whose lifecycle has to wrap the Mongo
// connection — the sync instance also owns a SQLite handle that we must close
// in `finally`, and watch mode plumbs SIGINT/SIGTERM through its `stop()`
// callback. Doing this through `runWithDb` would require leaking sync internals
// into the shared util.

import type { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import { loadConfig } from "../../../shared/config.js";
import { closeMongo, getMongo, runIndexBootstrap } from "../../../shared/mongo.js";
import { createLogger } from "../../../shared/logging.js";
import { SessionHistorySync, type SyncResult } from "../../../storage/history/index.js";
import { printError, readGlobalOptions, stderrInfo } from "./util.js";

interface SyncOptions {
  once?: boolean;
  watch?: boolean;
  full?: boolean;
  interval?: string;
  source?: string;
  json?: boolean;
}

export function registerSync(sessions: Command): void {
  sessions
    .command("sync")
    .description(
      "Mirror Copilot CLI's session-store SQLite into DocumentDB " + "(default mode: --once).",
    )
    .option("--once", "Run a single sync pass and exit (default if no mode is given).")
    .option("--watch", "Run continuously; sleep --interval between passes.")
    .option("--full", "Ignore watermarks and re-upsert every row in a single pass.")
    .option(
      "--interval <dur>",
      'Sleep between --watch passes (e.g. "30s", "5m"). Overrides SYNC_INTERVAL.',
    )
    .option(
      "--source <path>",
      "Path to Copilot CLI's session-store.db (overrides COPILOT_SESSION_STORE).",
    )
    .option("--json", "Emit the SyncResult as JSON on stdout. Only valid with --once / --full.")
    .action(async function (this: Command, opts: SyncOptions) {
      const code = await runSync(this, opts);
      process.exit(code);
    });
}

async function runSync(cmd: Command, opts: SyncOptions): Promise<number> {
  const globals = readGlobalOptions(cmd);
  const debug = globals.debug === true || process.env.DEBUG === "1";

  // Mode flags are mutually exclusive. Default (none of them) implies --once.
  const modeCount = [opts.once, opts.watch, opts.full].filter((v) => v === true).length;
  if (modeCount > 1) {
    process.stderr.write(
      `${pc.red("error:")} --once, --watch, and --full are mutually exclusive.\n`,
    );
    return 1;
  }

  // `--json` in watch mode would interleave with the per-pass log output, so
  // require the user to pick one. The sync layer already logs each pass to
  // stderr via the configured logger, which covers the watch-mode observability
  // story.
  if (opts.watch === true && opts.json === true) {
    process.stderr.write(
      `${pc.red("error:")} --json is not supported with --watch (the sync logger handles per-pass output).\n`,
    );
    return 1;
  }

  let sync: SessionHistorySync | null = null;

  try {
    const config = loadConfig({
      uri: globals.uri,
      db: globals.db,
      source: opts.source,
      interval: opts.interval,
    });
    const handle = await getMongo(config);
    await runIndexBootstrap(handle.db);

    // Logger always goes to stderr (see `shared/logging.ts`) so `--json` on
    // stdout stays clean.
    const logger = createLogger(config.logLevel, "documentdb-memory sync");

    sync = new SessionHistorySync(handle.db, {
      sourcePath: config.copilotSessionStore,
      intervalMs: config.syncIntervalMs,
      full: opts.full === true,
      logger,
    });

    if (opts.watch === true) {
      return await runWatch(sync, config.copilotSessionStore);
    }

    // --once (default) or --full — one pass and out.
    const result = await sync.runOnce();
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      renderResult(result, config.copilotSessionStore);
    }
    return 0;
  } catch (err) {
    printError(err, debug);
    return 1;
  } finally {
    // In watch mode, `stop()` already calls `sync.close()`. Re-calling here is
    // a no-op because `SessionHistorySync.close()` is idempotent.
    if (sync !== null) {
      try {
        sync.close();
      } catch {
        // Already closed by stop(); ignore.
      }
    }
    await closeMongo().catch(() => undefined);
  }
}

// Watch loop wiring: install SIGINT/SIGTERM listeners that call `stop()` once
// (subsequent signals are dedup'd by the `stopping` flag) and resolve when the
// in-flight `runOnce` completes. `stop()` already awaits the loop promise
// and closes the SQLite handle, so once it resolves we're free to exit.
async function runWatch(sync: SessionHistorySync, sourcePath: string): Promise<number> {
  stderrInfo(`watching ${sourcePath} (Ctrl-C to stop)`);
  const { stop } = sync.startWatch();

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      stderrInfo(`received ${signal}, stopping…`);
      stop().then(
        () => resolve(),
        (err: unknown) => {
          process.stderr.write(
            `stop failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          resolve();
        },
      );
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
  return 0;
}

// Tidy per-table count table after a successful `runOnce`. Columns are sorted
// in source dependency order so the human reader sees `history_sessions`
// before its children — that's the same order the sync layer processes them
// in, which makes it easy to correlate with the logger output.
function renderResult(result: SyncResult, sourcePath: string): void {
  const table = new Table({ head: ["Collection", "Upserts"] });
  for (const [name, count] of Object.entries(result.upserts)) {
    table.push([name, count]);
  }
  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(
    `\n${pc.dim("source:")} ${sourcePath}  ${pc.dim("duration:")} ${result.durationMs}ms\n`,
  );
}
