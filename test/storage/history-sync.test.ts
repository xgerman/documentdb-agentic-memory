import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HISTORY_CHECKPOINTS,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SEARCH_INDEX,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SESSIONS,
  HISTORY_SYNC_STATE,
  HISTORY_TURNS,
} from "../../src/storage/history/schema.js";
import { SessionHistorySync } from "../../src/storage/history/sync.js";
import { buildFixture, type FixtureHandle } from "../fixtures/session-store.js";
import { closeTestClient, getTestDb, type TestDbHandle } from "../setup.js";

// Fixed fixture sizes used throughout the file. Matches the brief: 3 sessions,
// 5 turns each, 2 checkpoints each, 4 file rows, 2 ref rows, 4 search-index
// rows, 2 dynamic-context rows. Keep this in sync with the assertions below.
const SPEC = {
  sessions: 3,
  turnsPerSession: 5,
  checkpointsPerSession: 2,
  files: 4,
  refs: 2,
  searchIndexRows: 4,
  dynamicContextItems: 2,
};

const EXPECTED_TURNS = SPEC.sessions * SPEC.turnsPerSession; // 15
const EXPECTED_CHECKPOINTS = SPEC.sessions * SPEC.checkpointsPerSession; // 6

describe("SessionHistorySync", () => {
  let handle: TestDbHandle;
  let fixture: FixtureHandle;
  let sync: SessionHistorySync;

  beforeAll(async () => {
    handle = await getTestDb("history_sync_tests");
    fixture = buildFixture(SPEC);
    sync = new SessionHistorySync(handle.db, { sourcePath: fixture.path });
  });

  afterAll(async () => {
    sync.close();
    fixture.cleanup();
    await closeTestClient(handle);
  });

  it("mirrors every fixture row on the first run", async () => {
    const result = await sync.runOnce();
    expect(result.upserts[HISTORY_SESSIONS]).toBe(SPEC.sessions);
    expect(result.upserts[HISTORY_TURNS]).toBe(EXPECTED_TURNS);
    expect(result.upserts[HISTORY_CHECKPOINTS]).toBe(EXPECTED_CHECKPOINTS);
    expect(result.upserts[HISTORY_SESSION_FILES]).toBe(SPEC.files);
    expect(result.upserts[HISTORY_SESSION_REFS]).toBe(SPEC.refs);
    expect(result.upserts[HISTORY_SEARCH_INDEX]).toBe(SPEC.searchIndexRows);
    expect(result.upserts[HISTORY_DYNAMIC_CONTEXT_ITEMS]).toBe(SPEC.dynamicContextItems);

    // Spot-check the actual collection counts on the mirror.
    const sessionsCount = await handle.db.collection(HISTORY_SESSIONS).countDocuments();
    const turnsCount = await handle.db.collection(HISTORY_TURNS).countDocuments();
    const checkpointsCount = await handle.db.collection(HISTORY_CHECKPOINTS).countDocuments();
    expect(sessionsCount).toBe(SPEC.sessions);
    expect(turnsCount).toBe(EXPECTED_TURNS);
    expect(checkpointsCount).toBe(EXPECTED_CHECKPOINTS);
  });

  it("records watermarks per source table in history_sync_state", async () => {
    const watermarks = await handle.db.collection(HISTORY_SYNC_STATE).find({}).toArray();
    const byTable = new Map(watermarks.map((d) => [d._id, d]));

    // Watermark-bearing tables only. dynamic_context_items has no watermark
    // (it's a full re-upsert every cycle).
    expect(byTable.has(HISTORY_SESSIONS)).toBe(true);
    expect(byTable.has(HISTORY_TURNS)).toBe(true);
    expect(byTable.has(HISTORY_CHECKPOINTS)).toBe(true);
    expect(byTable.has(HISTORY_SESSION_FILES)).toBe(true);
    expect(byTable.has(HISTORY_SESSION_REFS)).toBe(true);
    expect(byTable.has(HISTORY_SEARCH_INDEX)).toBe(true);

    // Sessions uses a string watermark (the max updated_at), the others use
    // numeric autoincrement / rowid watermarks.
    expect(typeof byTable.get(HISTORY_SESSIONS)?.watermark).toBe("string");
    expect(typeof byTable.get(HISTORY_TURNS)?.watermark).toBe("number");
    expect(byTable.get(HISTORY_TURNS)?.watermark).toBe(EXPECTED_TURNS);
    expect(byTable.get(HISTORY_CHECKPOINTS)?.watermark).toBe(EXPECTED_CHECKPOINTS);

    // Every watermark record has an updated_at Date.
    for (const w of watermarks) {
      expect(w.updated_at).toBeInstanceOf(Date);
    }
  });

  it("is idempotent: a second runOnce mirrors nothing new on the watermark-bearing tables", async () => {
    const second = await sync.runOnce();
    // Watermark-bearing tables: zero new upserts because nothing changed.
    expect(second.upserts[HISTORY_SESSIONS]).toBe(0);
    expect(second.upserts[HISTORY_TURNS]).toBe(0);
    expect(second.upserts[HISTORY_CHECKPOINTS]).toBe(0);
    expect(second.upserts[HISTORY_SESSION_FILES]).toBe(0);
    expect(second.upserts[HISTORY_SESSION_REFS]).toBe(0);
    expect(second.upserts[HISTORY_SEARCH_INDEX]).toBe(0);
    // dynamic_context_items has no watermark — every cycle is a full
    // re-upsert. Source impl counts each replaceOne whose document already
    // existed as a "modified" → that contributes to upserts > 0 here, but
    // total mirror count is unchanged. We assert the count is stable rather
    // than zero to match the documented "full re-upsert each cycle" behaviour.
    const dyn = await handle.db.collection(HISTORY_DYNAMIC_CONTEXT_ITEMS).countDocuments();
    expect(dyn).toBe(SPEC.dynamicContextItems);

    // No duplicate sessions/turns from the idempotent second pass.
    expect(await handle.db.collection(HISTORY_SESSIONS).countDocuments()).toBe(SPEC.sessions);
    expect(await handle.db.collection(HISTORY_TURNS).countDocuments()).toBe(EXPECTED_TURNS);
  });

  it("incrementally picks up new SQLite rows on the next runOnce", async () => {
    // Insert a 4th session straight into the fixture SQLite. Use a much later
    // `updated_at` so the string watermark on `sessions` advances.
    const wdb = fixture.open();
    try {
      wdb
        .prepare(
          `INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "session-new",
          "/repo/new",
          "owner/new-repo",
          "main",
          "brand new session",
          "2099-12-31 23:59:58",
          "2099-12-31 23:59:59",
          "copilot-cli",
        );
      // Plus a turn for that new session — autoincrement id will be EXPECTED_TURNS+1.
      wdb
        .prepare(
          `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run("session-new", 0, "hi", "hello", "2099-12-31 23:59:59");
    } finally {
      wdb.close();
    }

    const result = await sync.runOnce();
    expect(result.upserts[HISTORY_SESSIONS]).toBe(1);
    expect(result.upserts[HISTORY_TURNS]).toBe(1);
    expect(result.upserts[HISTORY_CHECKPOINTS]).toBe(0);

    expect(await handle.db.collection(HISTORY_SESSIONS).countDocuments()).toBe(SPEC.sessions + 1);
    expect(await handle.db.collection(HISTORY_TURNS).countDocuments()).toBe(EXPECTED_TURNS + 1);
  });
});

describe("SessionHistorySync constructor", () => {
  it("throws a clear error when the SQLite source is missing", () => {
    expect(
      () =>
        new SessionHistorySync({} as never, {
          sourcePath: "/nonexistent/path/to/session-store.db",
        }),
    ).toThrow(/SQLite source not readable/);
  });
});

describe("SessionHistorySync --full mode (constructor option `full: true`)", () => {
  let handle: TestDbHandle;
  let fixture: FixtureHandle;

  beforeAll(async () => {
    handle = await getTestDb("history_sync_full_tests");
    fixture = buildFixture(SPEC);
  });

  afterAll(async () => {
    fixture.cleanup();
    await closeTestClient(handle);
  });

  it("ignores watermarks and re-upserts every row", async () => {
    // Pre-seed watermarks so a non-full sync would skip everything.
    await handle.db.collection(HISTORY_SYNC_STATE).insertMany([
      { _id: HISTORY_SESSIONS, watermark: "2999-12-31 23:59:59", updated_at: new Date() },
      { _id: HISTORY_TURNS, watermark: 999_999, updated_at: new Date() },
      { _id: HISTORY_CHECKPOINTS, watermark: 999_999, updated_at: new Date() },
      { _id: HISTORY_SESSION_FILES, watermark: 999_999, updated_at: new Date() },
      { _id: HISTORY_SESSION_REFS, watermark: 999_999, updated_at: new Date() },
      { _id: HISTORY_SEARCH_INDEX, watermark: 999_999, updated_at: new Date() },
    ]);

    // Sanity: without --full, the pre-seeded watermarks would block all
    // mirroring of the watermark-bearing tables.
    const incremental = new SessionHistorySync(handle.db, { sourcePath: fixture.path });
    try {
      const r = await incremental.runOnce();
      expect(r.upserts[HISTORY_SESSIONS]).toBe(0);
      expect(r.upserts[HISTORY_TURNS]).toBe(0);
    } finally {
      incremental.close();
    }

    // Now request --full and confirm every row comes through anyway.
    const full = new SessionHistorySync(handle.db, {
      sourcePath: fixture.path,
      full: true,
    });
    try {
      const r = await full.runOnce();
      expect(r.upserts[HISTORY_SESSIONS]).toBe(SPEC.sessions);
      expect(r.upserts[HISTORY_TURNS]).toBe(EXPECTED_TURNS);
      expect(r.upserts[HISTORY_CHECKPOINTS]).toBe(EXPECTED_CHECKPOINTS);
    } finally {
      full.close();
    }

    expect(await handle.db.collection(HISTORY_SESSIONS).countDocuments()).toBe(SPEC.sessions);
  });
});

// Smoke check that better-sqlite3 actually opens the fixture file we built.
// Failing here means the fixture build is broken, not the sync itself.
describe("fixture sanity", () => {
  it("produces a SQLite file with the documented row counts", () => {
    const fx = buildFixture(SPEC);
    try {
      const db = fx.open();
      try {
        const count = (table: string): number =>
          (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
        expect(count("sessions")).toBe(SPEC.sessions);
        expect(count("turns")).toBe(EXPECTED_TURNS);
        expect(count("checkpoints")).toBe(EXPECTED_CHECKPOINTS);
        expect(count("session_files")).toBe(SPEC.files);
        expect(count("session_refs")).toBe(SPEC.refs);
        expect(count("search_index")).toBe(SPEC.searchIndexRows);
        expect(count("dynamic_context_items")).toBe(SPEC.dynamicContextItems);
      } finally {
        db.close();
      }
    } finally {
      fx.cleanup();
    }
  });
});
