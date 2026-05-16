export {
  HISTORY_SESSIONS,
  HISTORY_TURNS,
  HISTORY_CHECKPOINTS,
  HISTORY_SESSION_FILES,
  HISTORY_SESSION_REFS,
  HISTORY_SEARCH_INDEX,
  HISTORY_DYNAMIC_CONTEXT_ITEMS,
  HISTORY_SYNC_STATE,
  ensureHistoryIndexes,
  sessionId,
  turnId,
  checkpointId,
  sessionFileId,
  sessionRefId,
  searchIndexId,
  dynamicContextId,
} from "./schema.js";
export type {
  SessionDoc,
  TurnDoc,
  CheckpointDoc,
  SessionFileDoc,
  SessionRefDoc,
  SearchIndexDoc,
  DynamicContextDoc,
  SyncStateDoc,
} from "./schema.js";

export { SessionHistorySync } from "./sync.js";
export type { SyncOptions, SyncResult } from "./sync.js";
export { SessionHistoryStore } from "./store.js";
export type {
  SessionSummary,
  SessionFull,
  TurnRow,
  CheckpointSummary,
  FileHistoryRow,
  SessionRefRow,
  SearchHit,
  DynamicContextRow,
} from "./store.js";
