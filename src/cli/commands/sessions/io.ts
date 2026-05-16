// `documentdb-memory sessions export <dir>` and `sessions import <dir>`.
//
// Format: one `<collection>.jsonl` per history collection, with one JSON
// document per line. Dates are serialised as ISO-8601 strings via
// `JSON.stringify` and revived on import. `_id` is preserved verbatim so
// re-import is round-trippable.
//
// Streaming on both sides:
//
//   * Export uses a Mongo cursor (`batchSize: 200`) feeding a `WriteStream`,
//     honouring backpressure (`await drain` when `write` returns false). This
//     keeps memory bounded even for very large `history_search_index`
//     dumps.
//
//   * Import uses `readline` to consume one line at a time and flushes a
//     `bulkWrite` every 500 ops. Each op is a `replaceOne` upsert with `_id`
//     stripped from the replacement payload (Mongo forbids `replaceOne` from
//     setting `_id` even to the same value as the filter).
//
// Date revival is collection-specific: every history doc has `mirrored_at`,
// and most also have `created_at` / `updated_at` / `timestamp` /
// `first_seen_at`. We pass the union list and only revive fields that exist
// on the row, so it's safe to apply the same list everywhere.

import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Command } from "commander";
import type { AnyBulkWriteOperation, Db } from "mongodb";
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
import { info, ok, runWithDb, warn } from "./util.js";

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

// Fields that hold timestamps across the history schema. `reviveDates` walks
// this list per-doc and only touches fields actually present, so it's safe to
// share across every collection.
const DATE_FIELDS = [
  "created_at",
  "updated_at",
  "timestamp",
  "first_seen_at",
  "mirrored_at",
] as const;

const BATCH_SIZE = 500;
const CURSOR_BATCH = 200;

export function registerExport(sessions: Command): void {
  sessions
    .command("export <dir>")
    .description("Write every history_* collection to <dir>/<collection>.jsonl (one doc per line).")
    .action(async function (this: Command, dir: string) {
      await runWithDb(this, async ({ db }) => {
        await mkdir(dir, { recursive: true });
        for (const name of HISTORY_COLLECTIONS) {
          const path = join(dir, `${name}.jsonl`);
          const count = await exportCollection(db, name, path);
          info(`  ${name}: ${count} doc(s) -> ${path}`);
        }
        ok(`exported to ${dir}`);
      });
    });
}

export function registerImport(sessions: Command): void {
  sessions
    .command("import <dir>")
    .description("Load every <dir>/history_*.jsonl produced by `sessions export` (upsert by _id).")
    .action(async function (this: Command, dir: string) {
      await runWithDb(this, async ({ db }) => {
        // Tolerate extra files in `dir` — we look only at `history_*.jsonl`.
        // This lets users co-locate the dump with notes, READMEs, etc.
        const entries = await readdir(dir);
        const files = entries.filter((f) => /^history_[a-z_]+\.jsonl$/.test(f)).sort();
        if (files.length === 0) {
          warn(`no history_*.jsonl files found in ${dir}`);
          return;
        }
        let total = 0;
        for (const file of files) {
          const collection = file.replace(/\.jsonl$/, "");
          const path = join(dir, file);
          const upserts = await importCollection(db, collection, path);
          info(`  ${collection}: ${upserts} upsert(s) <- ${path}`);
          total += upserts;
        }
        ok(`imported ${total} doc(s) from ${dir}`);
      });
    });
}

// Export one collection. Returns the number of docs written.
//
// Backpressure pattern: `stream.write()` returns false when the kernel buffer
// fills; we then await the next `drain` event before continuing. Without this
// Node would queue the entire result set in memory.
async function exportCollection(db: Db, name: string, path: string): Promise<number> {
  const stream = createWriteStream(path, { encoding: "utf8" });
  let count = 0;
  try {
    const cursor = db.collection(name).find({}, { batchSize: CURSOR_BATCH });
    for await (const doc of cursor) {
      const line = `${JSON.stringify(doc)}\n`;
      if (!stream.write(line)) {
        await drain(stream);
      }
      count += 1;
    }
    stream.end();
    await once(stream, "finish");
  } catch (err) {
    // Best-effort close on error so we don't leak the fd. Re-throw to surface
    // the original cause.
    stream.destroy();
    throw err;
  }
  return count;
}

async function drain(stream: WriteStream): Promise<void> {
  await once(stream, "drain");
}

// Import one collection. Returns the number of upsert ops dispatched (note:
// `bulkWrite.upsertedCount + matchedCount` isn't a stable single counter; we
// count *ops we issued* instead, which matches what the user expects from
// "rows in the file").
// Generic doc shape: every history collection's `_id` is a string (composite
// or session-id). Typing both the collection and the bulk batch with this
// shape keeps the driver from defaulting `_id` to `ObjectId`.
interface StringIdDoc {
  _id: string;
  [key: string]: unknown;
}

async function importCollection(db: Db, name: string, path: string): Promise<number> {
  const coll = db.collection<StringIdDoc>(name);
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let opCount = 0;
  let batch: AnyBulkWriteOperation<StringIdDoc>[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await coll.bulkWrite(batch, { ordered: false });
    opCount += batch.length;
    batch = [];
  };

  for await (const raw of reader) {
    lineNo += 1;
    const line = raw.trim();
    if (line === "") continue;

    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid JSON in ${path} line ${lineNo}: ${msg}`);
    }
    if (typeof doc !== "object" || doc === null) {
      throw new Error(`${path} line ${lineNo}: expected an object`);
    }

    const obj = doc as Record<string, unknown>;
    const id = obj._id;
    if (typeof id !== "string") {
      throw new Error(`${path} line ${lineNo}: missing or non-string _id`);
    }

    reviveDates(obj, DATE_FIELDS);

    // Mongo rejects `replaceOne` payloads that re-state `_id` — even when it
    // equals the filter. Pull it off the replacement so the filter alone owns
    // the identity.
    const { _id: _drop, ...rest } = obj;
    void _drop;

    batch.push({
      replaceOne: {
        filter: { _id: id },
        replacement: rest,
        upsert: true,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
  }
  await flush();
  return opCount;
}

// Convert ISO date strings back to `Date` instances in-place. Only fields
// actually present on the doc are touched, so the union list is safe to
// share across collections.
function reviveDates(doc: Record<string, unknown>, fields: readonly string[]): void {
  for (const f of fields) {
    const v = doc[f];
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        doc[f] = d;
      }
    }
  }
}
