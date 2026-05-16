import { accessSync, constants as fsConstants } from "node:fs";
import Database from "better-sqlite3";
import type { AnyBulkWriteOperation, Collection, Db } from "mongodb";
import type { Logger } from "../../shared/logging.js";
import {
  HISTORY_CHECKPOINTS,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SEARCH_INDEX,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SESSIONS,
  HISTORY_SYNC_STATE,
  HISTORY_TURNS,
  checkpointId,
  dynamicContextId,
  searchIndexId,
  sessionFileId,
  sessionId,
  sessionRefId,
  turnId,
  type CheckpointDoc,
  type DynamicContextDoc,
  type SearchIndexDoc,
  type SessionDoc,
  type SessionFileDoc,
  type SessionRefDoc,
  type SyncStateDoc,
  type TurnDoc,
} from "./schema.js";

// Number of source rows pulled per batch. The watermark advances once per
// batch, so a smaller value means more granular crash-resume; a larger value
// means fewer round-trips to Mongo. 500 is the sweet spot recommended in the
// spec.
const BATCH_SIZE = 500;

export interface SyncOptions {
  sourcePath: string;
  intervalMs?: number;
  full?: boolean;
  logger?: Logger;
}

export interface SyncResult {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  upserts: Record<string, number>;
}

// Names of every source table the sync touches. Used to pre-fetch all
// watermarks in a single Mongo round-trip and to build an empty upsert tally.
const TABLE_NAMES = [
  HISTORY_SESSIONS,
  HISTORY_TURNS,
  HISTORY_CHECKPOINTS,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SEARCH_INDEX,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
] as const;

// Raw row shapes returned by `better-sqlite3`. Mirror the SQLite column types
// exactly — TEXT columns come back as `string | null`, INTEGER columns as
// `number | null`. The sync layer is responsible for converting timestamp
// strings to `Date` and providing the synthetic `_id`.
interface SessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  host_type: string | null;
}

interface TurnRow {
  id: number;
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string;
}

interface CheckpointRow {
  id: number;
  session_id: string;
  checkpoint_number: number;
  title: string | null;
  overview: string | null;
  history: string | null;
  work_done: string | null;
  technical_details: string | null;
  important_files: string | null;
  next_steps: string | null;
  created_at: string;
}

interface SessionFileRow {
  id: number;
  session_id: string;
  file_path: string;
  tool_name: string | null;
  turn_index: number | null;
  first_seen_at: string;
}

interface SessionRefRow {
  id: number;
  session_id: string;
  ref_type: string;
  ref_value: string;
  turn_index: number | null;
  created_at: string;
}

interface SearchIndexRow {
  rowid: number;
  content: string | null;
  session_id: string | null;
  source_type: string | null;
  source_id: string | null;
}

interface DynamicContextRow {
  repository: string;
  branch: string;
  src: string;
  name: string;
  description: string | null;
  content: string | null;
  read_count: number | null;
  count: number | null;
}

// `SessionHistorySync` mirrors Copilot CLI's local SQLite session store into
// Mongo. The SQLite handle is owned by this instance — opened in the
// constructor (so a missing file fails fast) and closed via `close()` or the
// `stop()` callback returned from `startWatch`.
//
// Each call to `runOnce` walks the source tables in dependency order
// (sessions first), pulls rows in batches of `BATCH_SIZE`, and upserts them
// via `bulkWrite` keyed by the synthetic `_id` builders in `schema.ts`. The
// per-table watermark is persisted in the `history_sync_state` collection
// AFTER the batch is acknowledged — so a crash mid-batch leaves a
// re-processable window. All upserts are idempotent (same `_id`, `mirrored_at`
// is the only field that always changes).
export class SessionHistorySync {
  private readonly db: Db;
  private readonly sourcePath: string;
  private readonly intervalMs: number;
  private readonly full: boolean;
  private readonly logger: Logger | undefined;

  private sqlite: Database.Database;
  private closed = false;

  constructor(db: Db, opts: SyncOptions) {
    this.db = db;
    this.sourcePath = opts.sourcePath;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.full = opts.full === true;
    this.logger = opts.logger;

    // Fail fast with a clear message when the source file is missing or
    // unreadable. `better-sqlite3` raises an opaque "unable to open database
    // file" otherwise.
    try {
      accessSync(this.sourcePath, fsConstants.R_OK);
    } catch (err) {
      throw new Error(
        `SQLite source not readable at "${this.sourcePath}": ${(err as Error).message}`,
      );
    }

    this.sqlite = new Database(this.sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
  }

  // Public so callers can release the read transaction explicitly. Safe to
  // call more than once.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sqlite.close();
    } catch (err) {
      this.logger?.warn({ err }, "failed to close SQLite handle");
    }
  }

  async runOnce(): Promise<SyncResult> {
    if (this.closed) {
      throw new Error("SessionHistorySync is closed");
    }
    const startedAt = new Date();
    const upserts: Record<string, number> = Object.fromEntries(TABLE_NAMES.map((t) => [t, 0]));
    this.logger?.info({ source: this.sourcePath, full: this.full }, "history sync started");

    const watermarks = await this.loadWatermarks();

    // Order matters only loosely (Mongo has no FK), but processing sessions
    // first means dependent reads against the mirror always see a parent.
    upserts[HISTORY_SESSIONS] = await this.syncSessions(watermarks);
    upserts[HISTORY_TURNS] = await this.syncTurns(watermarks);
    upserts[HISTORY_CHECKPOINTS] = await this.syncCheckpoints(watermarks);
    upserts[HISTORY_SESSION_FILES] = await this.syncSessionFiles(watermarks);
    upserts[HISTORY_SESSION_REFS] = await this.syncSessionRefs(watermarks);
    upserts[HISTORY_SEARCH_INDEX] = await this.syncSearchIndex(watermarks);
    upserts[HISTORY_DYNAMIC_CONTEXT_ITEMS] = await this.syncDynamicContext();

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    this.logger?.info({ durationMs, upserts }, "history sync finished");
    return { startedAt, finishedAt, durationMs, upserts };
  }

  startWatch(): { stop: () => Promise<void> } {
    if (this.closed) {
      throw new Error("SessionHistorySync is closed");
    }
    let stopped = false;
    let sleepTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveSleep: (() => void) | null = null;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          await this.runOnce();
        } catch (err) {
          // Don't crash the daemon on a transient failure. Sleep and retry.
          this.logger?.error({ err }, "history sync run failed");
        }
        if (stopped) break;
        await new Promise<void>((resolve) => {
          resolveSleep = resolve;
          sleepTimer = setTimeout(() => {
            sleepTimer = null;
            resolveSleep = null;
            resolve();
          }, this.intervalMs);
        });
      }
    };

    const loopPromise = loop();

    return {
      stop: async () => {
        stopped = true;
        if (sleepTimer !== null) {
          clearTimeout(sleepTimer);
          sleepTimer = null;
        }
        if (resolveSleep !== null) {
          const r = resolveSleep;
          resolveSleep = null;
          r();
        }
        await loopPromise;
        this.close();
      },
    };
  }

  // -- watermark plumbing --------------------------------------------------

  private async loadWatermarks(): Promise<Map<string, string | number>> {
    const result = new Map<string, string | number>();
    if (this.full) {
      // Caller asked for a full re-upsert. Skip the round-trip and pretend
      // every table is at its zero watermark.
      return result;
    }
    const coll = this.db.collection<SyncStateDoc>(HISTORY_SYNC_STATE);
    const docs = await coll.find({ _id: { $in: [...TABLE_NAMES] } }).toArray();
    for (const doc of docs) {
      result.set(doc._id, doc.watermark);
    }
    return result;
  }

  private async persistWatermark(table: string, value: string | number): Promise<void> {
    const coll = this.db.collection<SyncStateDoc>(HISTORY_SYNC_STATE);
    await coll.replaceOne(
      { _id: table },
      { watermark: value, updated_at: new Date() },
      { upsert: true },
    );
  }

  // -- per-table syncers ---------------------------------------------------

  private async syncSessions(watermarks: Map<string, string | number>): Promise<number> {
    // `updated_at` is a TEXT column. Lexicographic comparison works because
    // SQLite's `datetime('now')` produces fixed-width ISO-ish strings.
    // Caveat: ties at the batch boundary can be dropped when `>` excludes
    // the cursor. A `--full` rebuild repairs that and Copilot CLI's writes
    // rarely tie at the second.
    const initial = stringWatermark(watermarks.get(HISTORY_SESSIONS));
    const stmt = this.sqlite.prepare(
      `SELECT id, cwd, repository, branch, summary, created_at, updated_at, host_type
       FROM sessions
       WHERE updated_at > ?
       ORDER BY updated_at ASC
       LIMIT ?`,
    );

    const coll = this.db.collection<SessionDoc>(HISTORY_SESSIONS);
    let cursor = initial;
    let total = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH_SIZE) as SessionRow[];
      if (rows.length === 0) break;

      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<SessionDoc>[] = rows.map((r) => ({
        replaceOne: {
          filter: { _id: sessionId(r.id) },
          replacement: {
            session_id: r.id,
            cwd: r.cwd,
            repository: r.repository,
            branch: r.branch,
            summary: r.summary,
            host_type: r.host_type,
            created_at: toDate(r.created_at),
            updated_at: toDate(r.updated_at),
            mirrored_at: mirroredAt,
          },
          upsert: true,
        },
      }));

      total += await execBulk(coll, ops);

      // ORDER BY guarantees the last row carries the max watermark.
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.updated_at;
      await this.persistWatermark(HISTORY_SESSIONS, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  private async syncTurns(watermarks: Map<string, string | number>): Promise<number> {
    const initial = numberWatermark(watermarks.get(HISTORY_TURNS));
    const stmt = this.sqlite.prepare(
      `SELECT id, session_id, turn_index, user_message, assistant_response, timestamp
       FROM turns
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );

    const coll = this.db.collection<TurnDoc>(HISTORY_TURNS);
    let cursor = initial;
    let total = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH_SIZE) as TurnRow[];
      if (rows.length === 0) break;

      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<TurnDoc>[] = rows.map((r) => ({
        replaceOne: {
          filter: { _id: turnId(r.session_id, r.turn_index) },
          replacement: {
            session_id: r.session_id,
            turn_index: r.turn_index,
            user_message: r.user_message,
            assistant_response: r.assistant_response,
            timestamp: toDate(r.timestamp),
            mirrored_at: mirroredAt,
          },
          upsert: true,
        },
      }));

      total += await execBulk(coll, ops);

      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.id;
      await this.persistWatermark(HISTORY_TURNS, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  private async syncCheckpoints(watermarks: Map<string, string | number>): Promise<number> {
    const initial = numberWatermark(watermarks.get(HISTORY_CHECKPOINTS));
    const stmt = this.sqlite.prepare(
      `SELECT id, session_id, checkpoint_number, title, overview, history, work_done,
              technical_details, important_files, next_steps, created_at
       FROM checkpoints
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );

    const coll = this.db.collection<CheckpointDoc>(HISTORY_CHECKPOINTS);
    let cursor = initial;
    let total = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH_SIZE) as CheckpointRow[];
      if (rows.length === 0) break;

      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<CheckpointDoc>[] = rows.map((r) => ({
        replaceOne: {
          filter: { _id: checkpointId(r.session_id, r.checkpoint_number) },
          replacement: {
            session_id: r.session_id,
            checkpoint_number: r.checkpoint_number,
            title: r.title,
            overview: r.overview,
            history: r.history,
            work_done: r.work_done,
            technical_details: r.technical_details,
            important_files: r.important_files,
            next_steps: r.next_steps,
            created_at: toDate(r.created_at),
            mirrored_at: mirroredAt,
          },
          upsert: true,
        },
      }));

      total += await execBulk(coll, ops);

      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.id;
      await this.persistWatermark(HISTORY_CHECKPOINTS, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  private async syncSessionFiles(watermarks: Map<string, string | number>): Promise<number> {
    const initial = numberWatermark(watermarks.get(HISTORY_SESSION_FILES));
    const stmt = this.sqlite.prepare(
      `SELECT id, session_id, file_path, tool_name, turn_index, first_seen_at
       FROM session_files
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );

    const coll = this.db.collection<SessionFileDoc>(HISTORY_SESSION_FILES);
    let cursor = initial;
    let total = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH_SIZE) as SessionFileRow[];
      if (rows.length === 0) break;

      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<SessionFileDoc>[] = rows.map((r) => ({
        replaceOne: {
          filter: { _id: sessionFileId(r.session_id, r.file_path) },
          replacement: {
            session_id: r.session_id,
            file_path: r.file_path,
            tool_name: r.tool_name,
            turn_index: r.turn_index,
            first_seen_at: toDate(r.first_seen_at),
            mirrored_at: mirroredAt,
          },
          upsert: true,
        },
      }));

      total += await execBulk(coll, ops);

      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.id;
      await this.persistWatermark(HISTORY_SESSION_FILES, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  private async syncSessionRefs(watermarks: Map<string, string | number>): Promise<number> {
    const initial = numberWatermark(watermarks.get(HISTORY_SESSION_REFS));
    const stmt = this.sqlite.prepare(
      `SELECT id, session_id, ref_type, ref_value, turn_index, created_at
       FROM session_refs
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );

    const coll = this.db.collection<SessionRefDoc>(HISTORY_SESSION_REFS);
    let cursor = initial;
    let total = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH_SIZE) as SessionRefRow[];
      if (rows.length === 0) break;

      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<SessionRefDoc>[] = rows.map((r) => ({
        replaceOne: {
          filter: { _id: sessionRefId(r.session_id, r.ref_type, r.ref_value) },
          replacement: {
            session_id: r.session_id,
            ref_type: r.ref_type,
            ref_value: r.ref_value,
            turn_index: r.turn_index,
            created_at: toDate(r.created_at),
            mirrored_at: mirroredAt,
          },
          upsert: true,
        },
      }));

      total += await execBulk(coll, ops);

      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.id;
      await this.persistWatermark(HISTORY_SESSION_REFS, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  private async syncSearchIndex(watermarks: Map<string, string | number>): Promise<number> {
    // `search_index` is an FTS5 virtual table. Its implicit `rowid` is the
    // monotonic key. The columns are content, session_id, source_type,
    // source_id — we select rowid explicitly because FTS5 omits it from
    // `SELECT *` results.
    const initial = numberWatermark(watermarks.get(HISTORY_SEARCH_INDEX));
    const stmt = this.sqlite.prepare(
      `SELECT rowid, content, session_id, source_type, source_id
       FROM search_index
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`,
    );

    const coll = this.db.collection<SearchIndexDoc>(HISTORY_SEARCH_INDEX);
    let cursor = initial;
    let total = 0;
    for (;;) {
      const rows = stmt.all(cursor, BATCH_SIZE) as SearchIndexRow[];
      if (rows.length === 0) break;

      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<SearchIndexDoc>[] = [];
      for (const r of rows) {
        // FTS5 stores NULLs as empty strings for some inserts, but a row with
        // a missing session_id / source_id can't form a stable `_id`. Skip
        // such rows defensively — the SQLite side has no FK to enforce this.
        const sid = r.session_id;
        const stype = r.source_type;
        const sourceId = r.source_id;
        if (sid === null || stype === null || sourceId === null) {
          this.logger?.warn(
            { rowid: r.rowid },
            "search_index row missing identity columns; skipping",
          );
          continue;
        }
        ops.push({
          replaceOne: {
            filter: { _id: searchIndexId(sid, stype, sourceId) },
            replacement: {
              content: r.content ?? "",
              session_id: sid,
              source_type: stype,
              source_id: sourceId,
              mirrored_at: mirroredAt,
            },
            upsert: true,
          },
        });
      }

      if (ops.length > 0) {
        total += await execBulk(coll, ops);
      }

      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursor = last.rowid;
      await this.persistWatermark(HISTORY_SEARCH_INDEX, cursor);

      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  private async syncDynamicContext(): Promise<number> {
    // `dynamic_context_items` has no monotonic key — the PK is a composite of
    // (repository, branch, src, name) — so every cycle does a full
    // re-upsert. The table is intentionally small (Copilot CLI's curated
    // dynamic context). No watermark is persisted.
    const stmt = this.sqlite.prepare(
      `SELECT repository, branch, src, name, description, content, read_count, count
       FROM dynamic_context_items`,
    );

    const coll = this.db.collection<DynamicContextDoc>(HISTORY_DYNAMIC_CONTEXT_ITEMS);
    let total = 0;
    let batch: DynamicContextRow[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const mirroredAt = new Date();
      const ops: AnyBulkWriteOperation<DynamicContextDoc>[] = batch.map((r) => ({
        replaceOne: {
          filter: { _id: dynamicContextId(r.repository, r.branch, r.src, r.name) },
          replacement: {
            repository: r.repository,
            branch: r.branch,
            src: r.src,
            name: r.name,
            description: r.description ?? "",
            content: r.content ?? "",
            read_count: r.read_count ?? 0,
            count: r.count ?? 0,
            mirrored_at: mirroredAt,
          },
          upsert: true,
        },
      }));
      total += await execBulk(coll, ops);
      batch = [];
    };

    for (const row of stmt.iterate() as IterableIterator<DynamicContextRow>) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        await flush();
      }
    }
    await flush();
    return total;
  }
}

// -- shared helpers --------------------------------------------------------

async function execBulk<T extends { _id: string }>(
  coll: Collection<T>,
  ops: AnyBulkWriteOperation<T>[],
): Promise<number> {
  if (ops.length === 0) return 0;
  const res = await coll.bulkWrite(ops, { ordered: false });
  // `replaceOne` with `upsert: true` produces either upsertedCount (new doc)
  // or modifiedCount (existing doc replaced). `insertedCount` is normally 0
  // for replace ops but we include it for completeness.
  return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0) + (res.insertedCount ?? 0);
}

// SQLite TEXT timestamps come back as `"YYYY-MM-DD HH:MM:SS"` (Copilot CLI
// uses `datetime('now')`). V8's `Date` parser accepts that shape, so a single
// `new Date(value)` is enough. Throws on null/unexpected types so corruption
// surfaces loudly instead of silently producing epoch dates.
function toDate(value: string | null): Date {
  if (value === null) {
    throw new Error("Expected ISO timestamp, got NULL");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable timestamp: ${JSON.stringify(value)}`);
  }
  return d;
}

function stringWatermark(value: string | number | undefined): string {
  if (typeof value === "string") return value;
  // Number or undefined: pretend it's the empty string, which sorts before
  // every real ISO timestamp Copilot CLI writes.
  return "";
}

function numberWatermark(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  // String or undefined: fall back to zero. Autoincrement IDs start at 1 and
  // FTS5 rowids start at 1, so this is below the smallest real value.
  return 0;
}
