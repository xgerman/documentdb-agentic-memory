// `documentdb-memory sessions wipe [--yes]`.
//
// Destructive: drops every `history_*` collection in the configured Mongo
// database. Modeled on `graph wipe`:
//
//   * Interactive TTY: prompt for an explicit "yes" before nuking anything.
//   * Non-TTY (CI, pipes): refuse unless `--yes` is supplied.
//
// After the drop we re-run `runIndexBootstrap` so the schema (collections +
// indexes) matches a freshly-deployed instance. Mongo would lazily create the
// collections on next insert anyway, but doing it eagerly keeps `doctor`'s
// view consistent and avoids missing-index foot-guns on the next sync pass.
//
// NOTE: This intentionally drops `history_sync_state` and
// `history_dynamic_context_items` as well — "wipe" means everything in the
// history namespace, including watermarks. The next `sessions sync` run will
// re-mirror from scratch (a `--full` pass effectively).

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import pc from "picocolors";
import type { Db } from "mongodb";
import { runIndexBootstrap } from "../../../shared/mongo.js";
import {
  HISTORY_CHECKPOINTS,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SEARCH_INDEX,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SESSIONS,
  HISTORY_SYNC_STATE,
  HISTORY_TURNS,
} from "../../../storage/history/index.js";
import { info, isNamespaceNotFound, ok, runWithDb } from "./util.js";

interface WipeOptions {
  yes?: boolean;
}

const HISTORY_COLLECTIONS = [
  HISTORY_SESSIONS,
  HISTORY_TURNS,
  HISTORY_CHECKPOINTS,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SEARCH_INDEX,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SYNC_STATE,
] as const;

export function registerWipe(sessions: Command): void {
  sessions
    .command("wipe")
    .description("Drop ALL history collections after confirmation.")
    .option("--yes", "Skip the confirmation prompt (required when STDIN is not a TTY).")
    .action(async function (this: Command, opts: WipeOptions) {
      await runWithDb(this, async ({ config, db }) => {
        if (opts.yes !== true) {
          if (process.stdin.isTTY !== true) {
            process.stderr.write(
              `${pc.red("error:")} --yes is required when STDIN is not a TTY.\n`,
            );
            return 1;
          }
          const confirmed = await confirmInteractive(config.documentdbDb);
          if (!confirmed) {
            info("aborted");
            return 1;
          }
        }

        const dropped = await dropCollections(db);
        // Recreate the empty collections + indexes so the next `doctor` /
        // `sync` run starts from a healthy baseline.
        await runIndexBootstrap(db);
        ok(`wiped ${dropped.join(", ") || "(no collections existed)"}`);
        return 0;
      });
    });
}

async function confirmInteractive(dbName: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `About to drop ALL history_* collections from "${dbName}". Type "yes" to confirm: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function dropCollections(db: Db): Promise<string[]> {
  const dropped: string[] = [];
  for (const name of HISTORY_COLLECTIONS) {
    try {
      const wasDropped = await db.collection(name).drop();
      if (wasDropped) dropped.push(name);
    } catch (err) {
      // `NamespaceNotFound` means the collection never existed — fine for an
      // idempotent wipe. Anything else (auth, network, …) is genuinely fatal.
      if (isNamespaceNotFound(err)) continue;
      throw err;
    }
  }
  return dropped;
}
