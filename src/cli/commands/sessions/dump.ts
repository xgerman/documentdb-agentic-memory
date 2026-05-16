// `documentdb-memory sessions dump --collection <name> --json [--jsonl]`.
//
// Explicit no-FUSE escape hatch: print one history collection to stdout. We
// validate the collection name BEFORE entering `runWithDb` so a typo doesn't
// pointlessly open a Mongo connection — `runWithDb` always calls
// `process.exit`, so anything after `await runWithDb(…)` is unreachable.
//
// Modes:
//   * Default (`--json`): collect into an array and pretty-print once.
//   * `--jsonl`: stream one JSON object per line (no array wrapper). Useful
//     for very large collections where buffering the entire result set is
//     undesirable.

import type { Command } from "commander";
import pc from "picocolors";
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
import { emitJson, runWithDb } from "./util.js";

interface DumpOptions {
  collection: string;
  json: boolean;
  jsonl?: boolean;
}

const VALID_COLLECTIONS = new Set<string>([
  HISTORY_SESSIONS,
  HISTORY_TURNS,
  HISTORY_CHECKPOINTS,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SEARCH_INDEX,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SYNC_STATE,
]);

export function registerDump(sessions: Command): void {
  sessions
    .command("dump")
    .description("Dump one history collection to stdout (explicit no-FUSE fallback).")
    .requiredOption("--collection <name>", "Collection name (must be a history_* collection).")
    .requiredOption("--json", "Required: this command's default output mode is JSON.")
    .option("--jsonl", "Stream one JSON object per line instead of a single array.")
    .action(async function (this: Command, opts: DumpOptions) {
      // Validate BEFORE runWithDb so we don't open Mongo on bad input. The
      // sorted list in the error message helps the user pick the right name.
      if (!VALID_COLLECTIONS.has(opts.collection)) {
        const valid = [...VALID_COLLECTIONS].sort().join(", ");
        process.stderr.write(
          `${pc.red("error:")} unknown collection "${opts.collection}". Valid: ${valid}\n`,
        );
        process.exit(1);
      }

      await runWithDb(this, async ({ db }) => {
        const coll = db.collection(opts.collection);
        if (opts.jsonl === true) {
          // Stream mode: one doc per line. Keep the cursor batch small so
          // the first row appears quickly.
          for await (const doc of coll.find({}, { batchSize: 200 })) {
            process.stdout.write(`${JSON.stringify(doc)}\n`);
          }
        } else {
          // Default: collect and pretty-print as a single JSON array.
          const docs = await coll.find({}).toArray();
          emitJson(docs);
        }
      });
    });
}
