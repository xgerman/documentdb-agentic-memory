import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHistoryIndexes } from "../../src/storage/history/schema.js";
import { SessionHistoryStore } from "../../src/storage/history/store.js";
import { SessionHistorySync } from "../../src/storage/history/sync.js";
import { buildFixture, type FixtureHandle } from "../fixtures/session-store.js";
import { closeTestClient, getTestDb, type TestDbHandle } from "../setup.js";

// Tests the read-side of the history mirror. We build a fixture, run a single
// sync into Mongo, then exercise each `SessionHistoryStore` query method.

const SPEC = {
  sessions: 3,
  turnsPerSession: 5,
  checkpointsPerSession: 2,
  files: 4,
  refs: 2,
  searchIndexRows: 4,
  dynamicContextItems: 2,
};

describe("SessionHistoryStore", () => {
  let handle: TestDbHandle;
  let fixture: FixtureHandle;
  let store: SessionHistoryStore;

  beforeAll(async () => {
    handle = await getTestDb("history_store_tests");
    await ensureHistoryIndexes(handle.db);

    fixture = buildFixture(SPEC);
    const sync = new SessionHistorySync(handle.db, { sourcePath: fixture.path });
    try {
      await sync.runOnce();
    } finally {
      sync.close();
    }

    store = new SessionHistoryStore(handle.db);
  });

  afterAll(async () => {
    fixture.cleanup();
    await closeTestClient(handle);
  });

  describe("recentSessions", () => {
    it("returns sessions sorted by updated_at DESC", async () => {
      const rows = await store.recentSessions({ limit: 5 });
      expect(rows.length).toBe(SPEC.sessions);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!.updated_at.getTime();
        const cur = rows[i]!.updated_at.getTime();
        expect(prev).toBeGreaterThanOrEqual(cur);
      }
    });

    it("respects the limit", async () => {
      const rows = await store.recentSessions({ limit: 1 });
      expect(rows).toHaveLength(1);
    });

    it("filters by repository when requested", async () => {
      const rows = await store.recentSessions({ repository: "owner/repo-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.repository).toBe("owner/repo-1");
    });

    it("returns [] for an unknown repository filter", async () => {
      const rows = await store.recentSessions({ repository: "owner/never-existed" });
      expect(rows).toEqual([]);
    });
  });

  describe("findSessions (synonym-expanded text search)", () => {
    it("expands 'auth' to match a session whose summary contains 'login'", async () => {
      // The first fixture session has summary "implemented login flow for the
      // dashboard". The store expands `auth` -> "auth login token jwt session"
      // and Mongo's text index tokenizes the summary so "login" hits.
      const rows = await store.findSessions("auth");
      const ids = rows.map((r) => r.session_id);
      expect(ids).toContain("session-1");
    });

    it("returns [] for empty / whitespace queries", async () => {
      expect(await store.findSessions("")).toEqual([]);
      expect(await store.findSessions("   ")).toEqual([]);
    });

    it("passes multi-word queries through verbatim (no synonym expansion)", async () => {
      const rows = await store.findSessions("rendering pipeline");
      const ids = rows.map((r) => r.session_id);
      expect(ids).toContain("session-3");
    });
  });

  describe("getSession", () => {
    it("returns the session summary when includeTurns=false", async () => {
      const s = await store.getSession("session-1", false);
      expect(s).not.toBeNull();
      expect(s?.session_id).toBe("session-1");
      expect(s?.repository).toBe("owner/repo-1");
      // No turns property when includeTurns is false.
      expect(s?.turns).toBeUndefined();
    });

    it("includes turns in ascending turn_index order when includeTurns=true", async () => {
      const s = await store.getSession("session-1", true);
      expect(s?.turns).toBeDefined();
      expect(s!.turns!.length).toBe(SPEC.turnsPerSession);
      for (let i = 0; i < s!.turns!.length; i++) {
        expect(s!.turns![i]!.turn_index).toBe(i);
      }
    });

    it("returns null for an unknown session id", async () => {
      const s = await store.getSession("never-existed", false);
      expect(s).toBeNull();
    });
  });

  describe("getCheckpoints", () => {
    it("returns checkpoints sorted by checkpoint_number", async () => {
      const rows = await store.getCheckpoints("session-1");
      expect(rows).toHaveLength(SPEC.checkpointsPerSession);
      expect(rows.map((r) => r.checkpoint_number)).toEqual([1, 2]);
    });

    it("returns [] for an unknown session id", async () => {
      const rows = await store.getCheckpoints("ghost");
      expect(rows).toEqual([]);
    });
  });

  describe("findFileHistory", () => {
    it("matches file paths by substring (case-insensitive regex)", async () => {
      const rows = await store.findFileHistory("src/auth");
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.file_path.toLowerCase()).toMatch(/src\/auth/);
      }
      // Joined session_summary should be populated for matched sessions.
      const withSummary = rows.find((r) => r.session_summary !== null);
      expect(withSummary).toBeDefined();
    });

    it("can additionally filter by tool_name", async () => {
      const rows = await store.findFileHistory("src", "edit");
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.tool_name).toBe("edit");
      }
    });

    it("returns [] when nothing matches", async () => {
      const rows = await store.findFileHistory("no/such/path");
      expect(rows).toEqual([]);
    });
  });

  describe("findRefs", () => {
    it("looks up sessions linked to a (refType, refValue) pair", async () => {
      const rows = await store.findRefs("pr", "42");
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.ref_type).toBe("pr");
        expect(r.ref_value).toBe("42");
      }
    });

    it("returns [] for a refType / refValue with no hits", async () => {
      const rows = await store.findRefs("pr", "9999999");
      expect(rows).toEqual([]);
    });
  });

  describe("searchHistory", () => {
    it("matches an FTS row through synonym expansion (bug -> 'bug fix error crash regression')", async () => {
      // Fixture seeds an FTS row whose content is "fixed a nasty cache bug
      // in the dashboard". The expansion for `bug` covers that string.
      const hits = await store.searchHistory("bug");
      expect(hits.length).toBeGreaterThan(0);
      // Joined fields are populated for hits whose session_id resolves.
      const enriched = hits.find((h) => h.session_summary !== null);
      expect(enriched).toBeDefined();
    });

    it("respects sourceTypes filtering", async () => {
      // Two distinct source_types appear in fixture seeds: "turn" and
      // "checkpoint_work_done" / "checkpoint_overview".
      const hits = await store.searchHistory("login", { sourceTypes: ["checkpoint_work_done"] });
      for (const h of hits) {
        expect(h.source_type).toBe("checkpoint_work_done");
      }
    });

    it("returns [] when the search_index collection has nothing matching", async () => {
      // Use a single alphabetic token: Mongo's `$text` tokenizer splits on
      // hyphens, so `zzz-very-unlikely-token-zzz` would actually match via
      // the `token` term that's in the fixture seed for `auth` synonyms.
      const hits = await store.searchHistory("xyzzyplugh");
      expect(hits).toEqual([]);
    });
  });

  describe("getDynamicContext", () => {
    it("returns rows matching repository + branch", async () => {
      const rows = await store.getDynamicContext("owner/repo-1", "main");
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.repository).toBe("owner/repo-1");
        expect(r.branch).toBe("main");
      }
    });

    it("can additionally filter by src", async () => {
      const rows = await store.getDynamicContext("owner/repo-1", "main", "user");
      for (const r of rows) {
        expect(r.src).toBe("user");
      }
    });

    it("returns [] for unknown repository/branch", async () => {
      const rows = await store.getDynamicContext("owner/never", "nope");
      expect(rows).toEqual([]);
    });
  });

  describe("tolerance for missing collections", () => {
    // The store explicitly tolerates a fresh DB where the history collections
    // don't exist yet (see `collectionExists` cache in store.ts). We probe a
    // brand-new DB to confirm every read method short-circuits to a safe
    // empty result rather than throwing.
    let emptyHandle: TestDbHandle;
    let emptyStore: SessionHistoryStore;

    beforeAll(async () => {
      emptyHandle = await getTestDb("history_store_empty_tests");
      emptyStore = new SessionHistoryStore(emptyHandle.db);
    });

    afterAll(async () => {
      await closeTestClient(emptyHandle);
    });

    it("returns empty results across the board on a fresh DB", async () => {
      expect(await emptyStore.recentSessions({})).toEqual([]);
      expect(await emptyStore.findSessions("auth")).toEqual([]);
      expect(await emptyStore.getSession("any", true)).toBeNull();
      expect(await emptyStore.getCheckpoints("any")).toEqual([]);
      expect(await emptyStore.findFileHistory("src")).toEqual([]);
      expect(await emptyStore.findRefs("pr", "1")).toEqual([]);
      expect(await emptyStore.searchHistory("bug")).toEqual([]);
      expect(await emptyStore.getDynamicContext("a", "b")).toEqual([]);
    });
  });
});
