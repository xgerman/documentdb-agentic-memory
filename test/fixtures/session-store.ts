// Programmatic builder for a Copilot CLI session-store fixture. Mirrors the
// SQLite schema documented implicitly by `src/storage/history/sync.ts`:
// the SELECT statements there pin the column layout, and the FTS5 contentless
// shape for `search_index` is required so `SELECT rowid, content, session_id,
// source_type, source_id FROM search_index` works the way the sync expects.
//
// Each builder call produces a brand-new file under `os.tmpdir()` so tests in
// parallel cannot stomp on each other's fixture.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface FixtureHandle {
  path: string;
  cleanup: () => void;
  /** Open a writable handle for follow-up insertions (e.g. incremental sync). */
  open: () => Database.Database;
}

export interface FixtureSpec {
  /** Number of sessions to create. Defaults to 3. */
  sessions?: number;
  /** Turns per session. Defaults to 5. */
  turnsPerSession?: number;
  /** Checkpoints per session. Defaults to 2. */
  checkpointsPerSession?: number;
  /** Total session_files rows. Defaults to 4. */
  files?: number;
  /** Total session_refs rows. Defaults to 2. */
  refs?: number;
  /** Total dynamic_context_items rows. Defaults to 2. */
  dynamicContextItems?: number;
  /** Total search_index rows. Defaults to 4. */
  searchIndexRows?: number;
}

const SCHEMA_SQL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT,
  repository TEXT,
  branch TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  host_type TEXT
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  user_message TEXT,
  assistant_response TEXT,
  timestamp TEXT NOT NULL
);

CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  checkpoint_number INTEGER NOT NULL,
  title TEXT,
  overview TEXT,
  history TEXT,
  work_done TEXT,
  technical_details TEXT,
  important_files TEXT,
  next_steps TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE session_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  tool_name TEXT,
  turn_index INTEGER,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE session_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  turn_index INTEGER,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE search_index USING fts5(content, session_id, source_type, source_id);

CREATE TABLE dynamic_context_items (
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  src TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT,
  read_count INTEGER,
  count INTEGER
);
`;

// One canonical "summary" line per session. The first session's summary
// contains "login" so the synonym-expansion path for `findSessions("auth")`
// has a hit to land on (auth expands to "auth login token jwt session").
const SESSION_SUMMARIES = [
  "implemented login flow for the dashboard",
  "fixed cache invalidation regression",
  "refactored rendering pipeline",
];

// ISO-ish timestamps for the `sessions.updated_at` watermark to advance
// monotonically across rows. Spaces (not "T") so we match the
// `datetime('now')` shape Copilot CLI writes.
function iso(offsetMin: number): string {
  const base = new Date("2025-01-15T08:00:00Z").getTime();
  const d = new Date(base + offsetMin * 60_000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Create a fresh fixture SQLite file with deterministic content. Caller MUST
 * invoke `handle.cleanup()` in `afterAll` to delete the temp directory.
 */
export function buildFixture(spec: FixtureSpec = {}): FixtureHandle {
  const sessions = spec.sessions ?? 3;
  const turnsPerSession = spec.turnsPerSession ?? 5;
  const checkpointsPerSession = spec.checkpointsPerSession ?? 2;
  const files = spec.files ?? 4;
  const refs = spec.refs ?? 2;
  const dynamicContextItems = spec.dynamicContextItems ?? 2;
  const searchIndexRows = spec.searchIndexRows ?? 4;

  const dir = mkdtempSync(join(tmpdir(), "ddb-mem-fixture-"));
  const path = join(dir, "session-store.db");
  const db = new Database(path);

  try {
    db.exec(SCHEMA_SQL);

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertCheckpoint = db.prepare(
      `INSERT INTO checkpoints (session_id, checkpoint_number, title, overview, history,
                                work_done, technical_details, important_files, next_steps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFile = db.prepare(
      `INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertRef = db.prepare(
      `INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertSearch = db.prepare(
      `INSERT INTO search_index (content, session_id, source_type, source_id) VALUES (?, ?, ?, ?)`,
    );
    const insertDynamic = db.prepare(
      `INSERT INTO dynamic_context_items (repository, branch, src, name, description, content, read_count, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.transaction(() => {
      // sessions
      for (let i = 0; i < sessions; i++) {
        const id = `session-${i + 1}`;
        const summary = SESSION_SUMMARIES[i] ?? `session ${i + 1} summary`;
        insertSession.run(
          id,
          `/repo/path/${i + 1}`,
          `owner/repo-${i + 1}`,
          i % 2 === 0 ? "main" : "develop",
          summary,
          iso(i * 60),
          iso(i * 60 + 30),
          "copilot-cli",
        );

        // turns for this session
        for (let t = 0; t < turnsPerSession; t++) {
          insertTurn.run(
            id,
            t,
            t === 0 ? `Help me with ${summary}` : `follow-up question ${t}`,
            `assistant response ${t} for ${id}`,
            iso(i * 60 + t),
          );
        }

        // checkpoints for this session
        for (let c = 0; c < checkpointsPerSession; c++) {
          insertCheckpoint.run(
            id,
            c + 1,
            `checkpoint ${c + 1}`,
            `overview for ${id} checkpoint ${c + 1}`,
            "history",
            c === 0 ? "fixed a small bug" : "more work done",
            "technical details",
            `src/auth/login.ts\nsrc/auth/token.ts`,
            "next steps",
            iso(i * 60 + 45),
          );
        }
      }

      // session_files: distribute across sessions by round-robin
      const filePaths = [
        "src/auth/login.ts",
        "src/auth/token.ts",
        "src/render/pipeline.ts",
        "src/util/log.ts",
      ];
      for (let f = 0; f < files; f++) {
        const sessionIdx = f % sessions;
        insertFile.run(
          `session-${sessionIdx + 1}`,
          filePaths[f % filePaths.length] ?? `src/file-${f}.ts`,
          f % 2 === 0 ? "edit" : "create",
          f,
          iso(sessionIdx * 60 + 10 + f),
        );
      }

      // session_refs
      const refSpecs = [
        { type: "pr", value: "42" },
        { type: "issue", value: "1337" },
      ];
      for (let r = 0; r < refs; r++) {
        const spec = refSpecs[r % refSpecs.length]!;
        const sessionIdx = r % sessions;
        insertRef.run(
          `session-${sessionIdx + 1}`,
          spec.type,
          spec.value,
          null,
          iso(sessionIdx * 60 + 20 + r),
        );
      }

      // search_index rows
      const searchSamples = [
        { content: "fixed a nasty cache bug in the dashboard", source_type: "turn" },
        { content: "implemented login token refresh", source_type: "checkpoint_work_done" },
        { content: "rendering pipeline performance optimization", source_type: "turn" },
        { content: "documentation update for the readme", source_type: "checkpoint_overview" },
      ];
      for (let s = 0; s < searchIndexRows; s++) {
        const sample = searchSamples[s % searchSamples.length]!;
        const sessionIdx = s % sessions;
        insertSearch.run(
          sample.content,
          `session-${sessionIdx + 1}`,
          sample.source_type,
          `src-${s}`,
        );
      }

      // dynamic_context_items
      for (let d = 0; d < dynamicContextItems; d++) {
        insertDynamic.run(
          `owner/repo-${(d % sessions) + 1}`,
          "main",
          d === 0 ? "user" : "agent",
          `note-${d}`,
          `description ${d}`,
          `content for dynamic context entry ${d}`,
          d,
          d + 1,
        );
      }
    })();
  } finally {
    db.close();
  }

  return {
    path,
    open: () => new Database(path),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore — temp dir leakage is harmless
      }
    },
  };
}
