// `documentdb-memory sessions purge --older-than <date|dur> [--dry-run] [--json]`.
//
// Age-based cleanup for the MIRRORED data only. Two important guarantees:
//
//   1. The LOCAL SQLite file at `config.copilotSessionStore` is NEVER touched.
//      Purge runs purely against Mongo. Copilot CLI keeps writing to the same
//      SQLite file; the next `sessions sync` pass will re-mirror any rows
//      whose `updated_at` is newer than the cutoff and bypass anything we
//      already deleted (its watermark is a max value, not a checkpoint).
//
//   2. Purge cascades to every collection that owns a `session_id` referring
//      to `history_sessions._id`. `history_dynamic_context_items` has no
//      session ownership — its rows are global to a (repository, branch, src,
//      name) tuple — so it's deliberately excluded.
//
// Strategy: read the IDs of sessions whose `updated_at < cutoff` first, then
// `deleteMany({ session_id: { $in: ids } })` against each child, then finally
// remove the parent rows themselves. We snapshot the IDs up front so the
// cascade keeps working even though the parent rows go away last.

import type { Command } from "commander";
import type { Db } from "mongodb";
import { parseCutoff } from "../../../shared/duration.js";
import {
  HISTORY_CHECKPOINTS,
  HISTORY_SEARCH_INDEX,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SESSIONS,
  HISTORY_TURNS,
  type SessionDoc,
} from "../../../storage/history/index.js";
import { emitJson, info, ok, runWithDb } from "./util.js";

interface PurgeOptions {
  olderThan: string;
  dryRun?: boolean;
  json?: boolean;
}

// Child collections that store a `session_id` referencing `history_sessions._id`.
// Order matters only for the human-friendly counts table; cascading deletes are
// independent of each other.
const CHILD_COLLECTIONS = [
  HISTORY_TURNS,
  HISTORY_CHECKPOINTS,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SEARCH_INDEX,
] as const;

interface PurgeCounts {
  cutoff: string;
  dryRun: boolean;
  // Rows deleted from / matched in `history_sessions` itself.
  sessions: number;
  // Per child collection, rows deleted / matched.
  children: Record<string, number>;
}

export function registerPurge(sessions: Command): void {
  sessions
    .command("purge")
    .description("Drop mirrored sessions older than a cutoff. Local SQLite is NEVER touched.")
    .requiredOption(
      "--older-than <when>",
      'Cutoff: ISO date ("2025-01-15") or duration ("30d", "12h").',
    )
    .option("--dry-run", "Report counts only; do not delete anything.")
    .option("--json", "Emit counts as JSON instead of human-readable text.")
    .action(async function (this: Command, opts: PurgeOptions) {
      await runWithDb(this, async ({ db }) => {
        // `parseCutoff` throws a typed error on garbage input; let it
        // propagate so `runWithDb` prints it cleanly.
        const cutoff = parseCutoff(opts.olderThan);
        const counts = opts.dryRun === true ? await dryRun(db, cutoff) : await execute(db, cutoff);
        if (opts.json === true) {
          emitJson(counts);
        } else {
          render(counts);
        }
      });
    });
}

// Read the candidate session IDs once. We project `_id` only because
// `history_sessions._id === session_id` (see schema.ts:`sessionId()`).
async function listOldSessionIds(db: Db, cutoff: Date): Promise<string[]> {
  return db
    .collection<SessionDoc>(HISTORY_SESSIONS)
    .find({ updated_at: { $lt: cutoff } }, { projection: { _id: 1 } })
    .map((d) => d._id)
    .toArray();
}

async function dryRun(db: Db, cutoff: Date): Promise<PurgeCounts> {
  const ids = await listOldSessionIds(db, cutoff);
  const children: Record<string, number> = {};
  for (const name of CHILD_COLLECTIONS) {
    children[name] =
      ids.length === 0 ? 0 : await db.collection(name).countDocuments({ session_id: { $in: ids } });
  }
  return {
    cutoff: cutoff.toISOString(),
    dryRun: true,
    sessions: ids.length,
    children,
  };
}

async function execute(db: Db, cutoff: Date): Promise<PurgeCounts> {
  const ids = await listOldSessionIds(db, cutoff);

  // Cascade first, parent last. If a crash interrupts the cascade we'd be
  // left with orphan child rows but the parents would still be present, so a
  // re-run would re-cover them. The reverse (parents first) would leak
  // children we can't address anymore.
  const children: Record<string, number> = {};
  for (const name of CHILD_COLLECTIONS) {
    if (ids.length === 0) {
      children[name] = 0;
      continue;
    }
    const res = await db.collection(name).deleteMany({ session_id: { $in: ids } });
    children[name] = res.deletedCount ?? 0;
  }

  let sessionsDeleted = 0;
  if (ids.length > 0) {
    const res = await db.collection<SessionDoc>(HISTORY_SESSIONS).deleteMany({ _id: { $in: ids } });
    sessionsDeleted = res.deletedCount ?? 0;
  }

  return {
    cutoff: cutoff.toISOString(),
    dryRun: false,
    sessions: sessionsDeleted,
    children,
  };
}

function render(c: PurgeCounts): void {
  const childTotal = Object.values(c.children).reduce((a, b) => a + b, 0);
  if (c.dryRun) {
    info(`dry-run: cutoff = ${c.cutoff}`);
    info(`  would purge ${c.sessions} session(s) and approximately ${childTotal} child row(s)`);
    for (const name of Object.keys(c.children)) {
      info(`    ${name}: ${c.children[name] ?? 0}`);
    }
    info(`  (local SQLite is NOT touched)`);
  } else {
    ok(`purged (cutoff = ${c.cutoff})`);
    info(`  deleted ${c.sessions} session(s) and ${childTotal} child row(s)`);
    for (const name of Object.keys(c.children)) {
      info(`    ${name}: ${c.children[name] ?? 0}`);
    }
    info(`  (local SQLite untouched)`);
  }
}
