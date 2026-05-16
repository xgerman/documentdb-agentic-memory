import type { Db } from "mongodb";
import { registerIndexBootstrap } from "../../shared/mongo.js";

// Collection names for the session-history mirror. Kept as named constants so
// callers never have to spell the prefix themselves and refactors stay safe.

export const HISTORY_SESSIONS = "history_sessions";
export const HISTORY_TURNS = "history_turns";
export const HISTORY_CHECKPOINTS = "history_checkpoints";
export const HISTORY_SESSION_FILES = "history_session_files";
export const HISTORY_SESSION_REFS = "history_session_refs";
export const HISTORY_SEARCH_INDEX = "history_search_index";
export const HISTORY_DYNAMIC_CONTEXT_ITEMS = "history_dynamic_context_items";
export const HISTORY_SYNC_STATE = "history_sync_state";

// Document types mirror the source SQLite tables 1:1 (Copilot CLI's
// `~/.copilot/session-store.db`) so the sync layer can `Object.assign` rows
// onto the doc shape without renaming. Every doc additionally carries a
// `mirrored_at` timestamp recording when this process last wrote it.

export interface SessionDoc {
  _id: string;
  session_id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  host_type: string | null;
  created_at: Date;
  updated_at: Date;
  mirrored_at: Date;
}

export interface TurnDoc {
  _id: string;
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: Date;
  mirrored_at: Date;
}

export interface CheckpointDoc {
  _id: string;
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
  mirrored_at: Date;
}

export interface SessionFileDoc {
  _id: string;
  session_id: string;
  file_path: string;
  tool_name: string | null;
  turn_index: number | null;
  first_seen_at: Date;
  mirrored_at: Date;
}

export interface SessionRefDoc {
  _id: string;
  session_id: string;
  ref_type: string;
  ref_value: string;
  turn_index: number | null;
  created_at: Date;
  mirrored_at: Date;
}

export interface SearchIndexDoc {
  _id: string;
  content: string;
  session_id: string;
  source_type: string;
  source_id: string;
  mirrored_at: Date;
}

export interface DynamicContextDoc {
  _id: string;
  repository: string;
  branch: string;
  src: string;
  name: string;
  description: string;
  content: string;
  read_count: number;
  count: number;
  mirrored_at: Date;
}

// Watermark per source table. `watermark` is a string for the `sessions` table
// (ISO timestamp of the last `updated_at` consumed) and a number for the
// autoincrement-keyed tables (max `id` consumed) and `search_index` (max
// `rowid`). `_id` is the source table name.
export interface SyncStateDoc {
  _id: string;
  watermark: string | number;
  updated_at: Date;
}

// `_id` builders. Use `#` as the field separator (per plan.md) so the
// composite keys are human-readable and FUSE filenames remain meaningful.

export function sessionId(session_id: string): string {
  return session_id;
}

export function turnId(session_id: string, turn_index: number): string {
  return `${session_id}#${turn_index}`;
}

export function checkpointId(session_id: string, checkpoint_number: number): string {
  return `${session_id}#${checkpoint_number}`;
}

export function sessionFileId(session_id: string, file_path: string): string {
  return `${session_id}#${file_path}`;
}

export function sessionRefId(session_id: string, ref_type: string, ref_value: string): string {
  return `${session_id}#${ref_type}#${ref_value}`;
}

export function searchIndexId(session_id: string, source_type: string, source_id: string): string {
  return `${session_id}#${source_type}#${source_id}`;
}

export function dynamicContextId(
  repository: string,
  branch: string,
  src: string,
  name: string,
): string {
  return `${repository}#${branch}#${src}#${name}`;
}

// Index bootstrap. Called once at process startup via the shared
// `runIndexBootstrap` registry. Every `createIndex` call is idempotent — Mongo
// silently skips when a spec+name pair already exists.
export async function ensureHistoryIndexes(db: Db): Promise<void> {
  const sessions = db.collection<SessionDoc>(HISTORY_SESSIONS);
  await sessions.createIndex({ repository: 1 }, { name: "history_sessions_repository" });
  await sessions.createIndex({ cwd: 1 }, { name: "history_sessions_cwd" });
  await sessions.createIndex({ updated_at: 1 }, { name: "history_sessions_updated_at" });
  await sessions.createIndex({ summary: "text" }, { name: "history_sessions_text" });

  const turns = db.collection<TurnDoc>(HISTORY_TURNS);
  await turns.createIndex({ session_id: 1 }, { name: "history_turns_session_id" });
  await turns.createIndex(
    { user_message: "text", assistant_response: "text" },
    { name: "history_turns_text" },
  );

  const checkpoints = db.collection<CheckpointDoc>(HISTORY_CHECKPOINTS);
  await checkpoints.createIndex({ session_id: 1 }, { name: "history_checkpoints_session_id" });
  await checkpoints.createIndex(
    {
      title: "text",
      overview: "text",
      history: "text",
      work_done: "text",
      technical_details: "text",
      important_files: "text",
      next_steps: "text",
    },
    { name: "history_checkpoints_text" },
  );

  const sessionFiles = db.collection<SessionFileDoc>(HISTORY_SESSION_FILES);
  await sessionFiles.createIndex({ session_id: 1 }, { name: "history_session_files_session_id" });
  await sessionFiles.createIndex({ file_path: 1 }, { name: "history_session_files_file_path" });

  const sessionRefs = db.collection<SessionRefDoc>(HISTORY_SESSION_REFS);
  await sessionRefs.createIndex({ session_id: 1 }, { name: "history_session_refs_session_id" });
  await sessionRefs.createIndex(
    { ref_type: 1, ref_value: 1 },
    { name: "history_session_refs_ref_type_ref_value" },
  );

  const searchIndex = db.collection<SearchIndexDoc>(HISTORY_SEARCH_INDEX);
  await searchIndex.createIndex({ session_id: 1 }, { name: "history_search_index_session_id" });
  await searchIndex.createIndex({ source_type: 1 }, { name: "history_search_index_source_type" });
  await searchIndex.createIndex({ content: "text" }, { name: "history_search_index_text" });

  const dynamicContext = db.collection<DynamicContextDoc>(HISTORY_DYNAMIC_CONTEXT_ITEMS);
  await dynamicContext.createIndex(
    { repository: 1, branch: 1 },
    { name: "history_dynamic_context_items_repository_branch" },
  );
  await dynamicContext.createIndex(
    { content: "text", description: "text" },
    { name: "history_dynamic_context_items_text" },
  );

  // history_sync_state: small, accessed by `_id` only — no extra indexes.
}

registerIndexBootstrap(ensureHistoryIndexes);
