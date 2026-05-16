import type { AggregateOptions, Collection, Db, Document, Filter } from "mongodb";

import {
  HISTORY_CHECKPOINTS,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SEARCH_INDEX,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SESSIONS,
  HISTORY_TURNS,
  type CheckpointDoc,
  type DynamicContextDoc,
  type SearchIndexDoc,
  type SessionDoc,
  type SessionFileDoc,
  type SessionRefDoc,
  type TurnDoc,
} from "./schema.js";

// -- Result-shape types --------------------------------------------------
//
// These mirror the column shape Copilot CLI's SQLite session-store returns
// for the equivalent queries. We project explicit fields (not raw `_id`
// passthrough) so the public API stays stable even if the on-disk shape
// gains internal fields like `mirrored_at`.

export interface SessionSummary {
  session_id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  host_type: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TurnRow {
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: Date;
}

export interface SessionFull extends SessionSummary {
  // Present iff `getSession(_, true)` is called; sorted ascending by
  // `turn_index` so consumers can render the transcript directly.
  turns?: TurnRow[];
}

export interface CheckpointSummary {
  session_id: string;
  checkpoint_number: number;
  title: string | null;
  overview: string | null;
  history: string | null;
  work_done: string | null;
  technical_details: string | null;
  important_files: string | null;
  next_steps: string | null;
  created_at: Date;
}

export interface FileHistoryRow {
  session_id: string;
  file_path: string;
  tool_name: string | null;
  turn_index: number | null;
  first_seen_at: Date;
  // Joined from `history_sessions` for context — saves consumers a round-trip
  // when listing "every session that touched X".
  session_summary: string | null;
  repository: string | null;
}

export interface SessionRefRow {
  session_id: string;
  ref_type: string;
  ref_value: string;
  turn_index: number | null;
  created_at: Date;
  session_summary: string | null;
}

export interface SearchHit {
  content: string;
  session_id: string;
  source_type: string;
  source_id: string;
  // Joined session context for ranking / display.
  session_summary: string | null;
  session_updated_at: Date | null;
  // From `$meta: "textScore"`. Larger == better match.
  score: number;
}

export interface DynamicContextRow {
  repository: string;
  branch: string;
  src: string;
  name: string;
  description: string;
  content: string;
  read_count: number;
  count: number;
}

// -- Query expansion -----------------------------------------------------
//
// `findSessions` / `searchHistory` both auto-expand a single-word query
// into OR-ed synonyms, following the "act as your own embedder" retrieval
// strategy the session_store usage docs recommend. The map is intentionally
// small; everything else passes through verbatim. Mongo's `$text $search`
// treats space-separated terms as OR by default, which is exactly what
// we want for the expanded form.

const QUERY_SYNONYMS: Record<string, readonly string[]> = {
  auth: ["auth", "login", "token", "jwt", "session"],
  bug: ["bug", "fix", "error", "crash", "regression"],
  perf: ["perf", "performance", "slow", "fast", "optimize", "latency", "cache"],
  ui: ["ui", "render", "component", "layout", "css", "styling", "display"],
  doc: ["doc", "docs", "documentation", "readme", "comment"],
};

function expandQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "";
  const synonyms = QUERY_SYNONYMS[trimmed.toLowerCase()];
  return synonyms !== undefined ? synonyms.join(" ") : trimmed;
}

// Escape a string for use as a literal-substring regex pattern. Covers the
// metacharacters Mongo's PCRE-ish regex engine recognises.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- Store ---------------------------------------------------------------
//
// `SessionHistoryStore` is the read-side of the session-history mirror.
// Sync (SQLite → Mongo) lives in `./sync.ts` and writes the same
// collections this class reads from.
//
// Design notes:
//   * Constructor mirrors `KnowledgeGraphStore`: a single `Db`, with
//     `Collection<T>` handles cached so each call is one driver round-trip.
//   * Every public method tolerates a fresh (pre-bootstrap) database where
//     the history collections don't exist yet. We check `listCollections`
//     once per name and cache the result on the instance.
//   * Text searches go through `aggregate` rather than `find().project()`
//     so we can use `$meta: "textScore"` cleanly without `any`-typing
//     the projection.
export class SessionHistoryStore {
  private readonly db: Db;
  private readonly sessions: Collection<SessionDoc>;
  private readonly turns: Collection<TurnDoc>;
  private readonly checkpoints: Collection<CheckpointDoc>;
  private readonly sessionFiles: Collection<SessionFileDoc>;
  private readonly sessionRefs: Collection<SessionRefDoc>;
  private readonly searchIndex: Collection<SearchIndexDoc>;
  private readonly dynamicContext: Collection<DynamicContextDoc>;
  // Per-instance memo: collection name → "does it exist on the server?".
  // Cached forever; restart the process if you've just created a collection.
  private readonly existence = new Map<string, Promise<boolean>>();

  constructor(db: Db) {
    this.db = db;
    this.sessions = db.collection<SessionDoc>(HISTORY_SESSIONS);
    this.turns = db.collection<TurnDoc>(HISTORY_TURNS);
    this.checkpoints = db.collection<CheckpointDoc>(HISTORY_CHECKPOINTS);
    this.sessionFiles = db.collection<SessionFileDoc>(HISTORY_SESSION_FILES);
    this.sessionRefs = db.collection<SessionRefDoc>(HISTORY_SESSION_REFS);
    this.searchIndex = db.collection<SearchIndexDoc>(HISTORY_SEARCH_INDEX);
    this.dynamicContext = db.collection<DynamicContextDoc>(HISTORY_DYNAMIC_CONTEXT_ITEMS);
  }

  // -- recent / browse ---------------------------------------------------

  async recentSessions(
    opts: { limit?: number; repository?: string; branch?: string } = {},
  ): Promise<SessionSummary[]> {
    if (!(await this.collectionExists(HISTORY_SESSIONS))) return [];
    const limit = opts.limit ?? 20;
    const filter: Filter<SessionDoc> = { updated_at: { $exists: true } };
    if (opts.repository !== undefined) filter.repository = opts.repository;
    if (opts.branch !== undefined) filter.branch = opts.branch;
    const docs = await this.sessions
      .find(filter, { projection: SESSION_SUMMARY_PROJECTION })
      .sort({ updated_at: -1 })
      .limit(limit)
      .toArray();
    return docs.map(mapSessionSummary);
  }

  // -- find by text ------------------------------------------------------

  async findSessions(query: string, limit = 20): Promise<SessionSummary[]> {
    if (!(await this.collectionExists(HISTORY_SESSIONS))) return [];
    const expanded = expandQuery(query);
    if (expanded.length === 0) return [];

    // Two parallel $text passes — one over `summary` (text index on
    // `history_sessions`), one over `user_message` + `assistant_response`
    // restricted to the first turn (text index on `history_turns`). We
    // then merge on session_id, keep the higher score per session, and
    // sort by combined relevance. `.catch(() => [])` is defensive: a
    // missing text index throws but we'd rather degrade gracefully than
    // 500.
    const sessionMatchesP = this.sessions
      .aggregate<SessionDoc & { score: number }>(
        [
          { $match: { $text: { $search: expanded } } },
          { $addFields: { score: { $meta: "textScore" } } },
          { $project: { ...SESSION_SUMMARY_PROJECTION, score: 1 } },
        ],
        TEXT_AGGREGATE_OPTS,
      )
      .toArray()
      .catch(() => [] as Array<SessionDoc & { score: number }>);

    const turnMatchesP = (await this.collectionExists(HISTORY_TURNS))
      ? this.turns
          .aggregate<{ session_id: string; score: number }>(
            [
              { $match: { $text: { $search: expanded }, turn_index: 0 } },
              { $addFields: { score: { $meta: "textScore" } } },
              { $project: { _id: 0, session_id: 1, score: 1 } },
            ],
            TEXT_AGGREGATE_OPTS,
          )
          .toArray()
          .catch(() => [] as Array<{ session_id: string; score: number }>)
      : Promise.resolve([] as Array<{ session_id: string; score: number }>);

    const [sessionMatches, turnMatches] = await Promise.all([sessionMatchesP, turnMatchesP]);

    const scores = new Map<string, number>();
    const summaries = new Map<string, SessionSummary>();
    for (const d of sessionMatches) {
      summaries.set(d.session_id, mapSessionSummary(d));
      scores.set(d.session_id, Math.max(scores.get(d.session_id) ?? 0, d.score));
    }
    for (const t of turnMatches) {
      scores.set(t.session_id, Math.max(scores.get(t.session_id) ?? 0, t.score));
    }

    // Hydrate sessions that only matched on a first-turn hit.
    const missingIds: string[] = [];
    for (const id of scores.keys()) {
      if (!summaries.has(id)) missingIds.push(id);
    }
    if (missingIds.length > 0) {
      const extra = await this.sessions
        .find({ _id: { $in: missingIds } }, { projection: SESSION_SUMMARY_PROJECTION })
        .toArray();
      for (const d of extra) summaries.set(d.session_id, mapSessionSummary(d));
    }

    const ranked: Array<{ summary: SessionSummary; score: number }> = [];
    for (const [id, score] of scores) {
      const summary = summaries.get(id);
      if (summary !== undefined) ranked.push({ summary, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit).map((r) => r.summary);
  }

  // -- get one session ---------------------------------------------------

  async getSession(sessionId: string, includeTurns: boolean): Promise<SessionFull | null> {
    if (!(await this.collectionExists(HISTORY_SESSIONS))) return null;
    const doc = await this.sessions.findOne(
      { _id: sessionId },
      { projection: SESSION_SUMMARY_PROJECTION },
    );
    if (doc === null) return null;
    const summary = mapSessionSummary(doc);
    if (!includeTurns) return { ...summary };
    if (!(await this.collectionExists(HISTORY_TURNS))) return { ...summary, turns: [] };
    const turnDocs = await this.turns
      .find({ session_id: sessionId }, { projection: TURN_PROJECTION })
      .sort({ turn_index: 1 })
      .toArray();
    return { ...summary, turns: turnDocs.map(mapTurn) };
  }

  // -- checkpoints --------------------------------------------------------

  async getCheckpoints(sessionId: string): Promise<CheckpointSummary[]> {
    if (!(await this.collectionExists(HISTORY_CHECKPOINTS))) return [];
    const docs = await this.checkpoints
      .find({ session_id: sessionId }, { projection: CHECKPOINT_PROJECTION })
      .sort({ checkpoint_number: 1 })
      .toArray();
    return docs.map(mapCheckpoint);
  }

  // -- file history -------------------------------------------------------

  async findFileHistory(filePathPattern: string, toolName?: string): Promise<FileHistoryRow[]> {
    if (!(await this.collectionExists(HISTORY_SESSION_FILES))) return [];
    const match: Filter<SessionFileDoc> = {
      file_path: new RegExp(escapeRegex(filePathPattern), "i"),
    };
    if (toolName !== undefined) match.tool_name = toolName;
    const pipeline: Document[] = [
      { $match: match },
      { $sort: { first_seen_at: -1 } },
      { $limit: 100 },
      {
        $lookup: {
          from: HISTORY_SESSIONS,
          localField: "session_id",
          foreignField: "_id",
          as: "session",
        },
      },
      { $unwind: { path: "$session", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          session_id: 1,
          file_path: 1,
          tool_name: 1,
          turn_index: 1,
          first_seen_at: 1,
          session_summary: { $ifNull: ["$session.summary", null] },
          repository: { $ifNull: ["$session.repository", null] },
        },
      },
    ];
    const docs = await this.sessionFiles.aggregate<FileHistoryRow>(pipeline).toArray();
    return docs.map(normalizeFileHistory);
  }

  // -- refs ---------------------------------------------------------------

  async findRefs(refType: string, refValue: string): Promise<SessionRefRow[]> {
    if (!(await this.collectionExists(HISTORY_SESSION_REFS))) return [];
    const pipeline: Document[] = [
      { $match: { ref_type: refType, ref_value: refValue } },
      { $sort: { created_at: -1 } },
      { $limit: 100 },
      {
        $lookup: {
          from: HISTORY_SESSIONS,
          localField: "session_id",
          foreignField: "_id",
          as: "session",
        },
      },
      { $unwind: { path: "$session", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          session_id: 1,
          ref_type: 1,
          ref_value: 1,
          turn_index: 1,
          created_at: 1,
          session_summary: { $ifNull: ["$session.summary", null] },
        },
      },
    ];
    const docs = await this.sessionRefs.aggregate<SessionRefRow>(pipeline).toArray();
    return docs.map(normalizeSessionRef);
  }

  // -- full-text search ---------------------------------------------------

  async searchHistory(
    query: string,
    opts: { sourceTypes?: string[]; limit?: number } = {},
  ): Promise<SearchHit[]> {
    if (!(await this.collectionExists(HISTORY_SEARCH_INDEX))) return [];
    const expanded = expandQuery(query);
    if (expanded.length === 0) return [];
    const limit = opts.limit ?? 20;
    const match: Filter<SearchIndexDoc> = { $text: { $search: expanded } };
    if (opts.sourceTypes !== undefined && opts.sourceTypes.length > 0) {
      match.source_type = { $in: opts.sourceTypes };
    }
    const pipeline: Document[] = [
      { $match: match },
      { $addFields: { score: { $meta: "textScore" } } },
      { $sort: { score: { $meta: "textScore" } } },
      { $limit: limit },
      {
        $lookup: {
          from: HISTORY_SESSIONS,
          localField: "session_id",
          foreignField: "_id",
          as: "session",
        },
      },
      { $unwind: { path: "$session", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          content: 1,
          session_id: 1,
          source_type: 1,
          source_id: 1,
          score: 1,
          session_summary: { $ifNull: ["$session.summary", null] },
          session_updated_at: { $ifNull: ["$session.updated_at", null] },
        },
      },
    ];
    try {
      const docs = await this.searchIndex
        .aggregate<SearchHit>(pipeline, TEXT_AGGREGATE_OPTS)
        .toArray();
      return docs.map(normalizeSearchHit);
    } catch {
      // No text index yet (fresh DB before bootstrap) or driver-level
      // textScore rejection — treat as "no hits" rather than 500.
      return [];
    }
  }

  // -- dynamic context ----------------------------------------------------

  async getDynamicContext(
    repository: string,
    branch: string,
    src?: string,
  ): Promise<DynamicContextRow[]> {
    if (!(await this.collectionExists(HISTORY_DYNAMIC_CONTEXT_ITEMS))) return [];
    const filter: Filter<DynamicContextDoc> = { repository, branch };
    if (src !== undefined) filter.src = src;
    const docs = await this.dynamicContext
      .find(filter, { projection: DYNAMIC_CONTEXT_PROJECTION })
      .toArray();
    return docs.map(mapDynamicContext);
  }

  // -- helpers -----------------------------------------------------------

  private collectionExists(name: string): Promise<boolean> {
    let p = this.existence.get(name);
    if (p === undefined) {
      // `listCollections({ name }, { nameOnly: true })` is the cheapest
      // existence probe the driver offers. Errors collapse to `false`
      // so a broken connection doesn't poison subsequent queries.
      p = this.db
        .listCollections({ name }, { nameOnly: true })
        .toArray()
        .then((cols) => cols.length > 0)
        .catch(() => false);
      this.existence.set(name, p);
    }
    return p;
  }
}

// -- Projections & mappers ----------------------------------------------

// Projecting `_id: 0` keeps the result payload tight and forces callers
// (and mappers) to read the natural `session_id` field instead of relying
// on the implementation detail that `_id === session_id`.

const SESSION_SUMMARY_PROJECTION: Document = {
  _id: 0,
  session_id: 1,
  cwd: 1,
  repository: 1,
  branch: 1,
  summary: 1,
  host_type: 1,
  created_at: 1,
  updated_at: 1,
};

const TURN_PROJECTION: Document = {
  _id: 0,
  session_id: 1,
  turn_index: 1,
  user_message: 1,
  assistant_response: 1,
  timestamp: 1,
};

const CHECKPOINT_PROJECTION: Document = {
  _id: 0,
  session_id: 1,
  checkpoint_number: 1,
  title: 1,
  overview: 1,
  history: 1,
  work_done: 1,
  technical_details: 1,
  important_files: 1,
  next_steps: 1,
  created_at: 1,
};

const DYNAMIC_CONTEXT_PROJECTION: Document = {
  _id: 0,
  repository: 1,
  branch: 1,
  src: 1,
  name: 1,
  description: 1,
  content: 1,
  read_count: 1,
  count: 1,
};

// `allowDiskUse: true` is cheap insurance for $text + $sort pipelines that
// could exceed the 100MB in-memory aggregation limit on busy mirrors.
const TEXT_AGGREGATE_OPTS: AggregateOptions = { allowDiskUse: true };

function mapSessionSummary(doc: SessionDoc): SessionSummary {
  return {
    session_id: doc.session_id,
    cwd: doc.cwd ?? null,
    repository: doc.repository ?? null,
    branch: doc.branch ?? null,
    summary: doc.summary ?? null,
    host_type: doc.host_type ?? null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function mapTurn(doc: TurnDoc): TurnRow {
  return {
    session_id: doc.session_id,
    turn_index: doc.turn_index,
    user_message: doc.user_message ?? null,
    assistant_response: doc.assistant_response ?? null,
    timestamp: doc.timestamp,
  };
}

function mapCheckpoint(doc: CheckpointDoc): CheckpointSummary {
  return {
    session_id: doc.session_id,
    checkpoint_number: doc.checkpoint_number,
    title: doc.title ?? null,
    overview: doc.overview ?? null,
    history: doc.history ?? null,
    work_done: doc.work_done ?? null,
    technical_details: doc.technical_details ?? null,
    important_files: doc.important_files ?? null,
    next_steps: doc.next_steps ?? null,
    created_at: doc.created_at,
  };
}

function mapDynamicContext(doc: DynamicContextDoc): DynamicContextRow {
  return {
    repository: doc.repository,
    branch: doc.branch,
    src: doc.src,
    name: doc.name,
    description: doc.description,
    content: doc.content,
    read_count: doc.read_count,
    count: doc.count,
  };
}

// Aggregation `$project` with `$ifNull` produces explicit `null` for
// missing joined fields, but the driver still types them as `string` /
// `Date` (the generic asserts the shape). Coerce defensively so callers
// never see an undefined where they expect `null`.

function normalizeFileHistory(row: FileHistoryRow): FileHistoryRow {
  return {
    session_id: row.session_id,
    file_path: row.file_path,
    tool_name: row.tool_name ?? null,
    turn_index: row.turn_index ?? null,
    first_seen_at: row.first_seen_at,
    session_summary: row.session_summary ?? null,
    repository: row.repository ?? null,
  };
}

function normalizeSessionRef(row: SessionRefRow): SessionRefRow {
  return {
    session_id: row.session_id,
    ref_type: row.ref_type,
    ref_value: row.ref_value,
    turn_index: row.turn_index ?? null,
    created_at: row.created_at,
    session_summary: row.session_summary ?? null,
  };
}

function normalizeSearchHit(row: SearchHit): SearchHit {
  return {
    content: row.content,
    session_id: row.session_id,
    source_type: row.source_type,
    source_id: row.source_id,
    session_summary: row.session_summary ?? null,
    session_updated_at: row.session_updated_at ?? null,
    score: row.score,
  };
}
