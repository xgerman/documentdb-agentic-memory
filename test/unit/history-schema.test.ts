import { describe, expect, it } from "vitest";
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
} from "../../src/storage/history/schema.js";

describe("history collection-name constants", () => {
  it("matches the documented names exactly", () => {
    // All 8 constants the sync and store reach for. Keeping this pinned
    // means a typo or accidental rename surfaces as a test failure rather
    // than silent data loss at the boundary.
    expect(HISTORY_SESSIONS).toBe("history_sessions");
    expect(HISTORY_TURNS).toBe("history_turns");
    expect(HISTORY_CHECKPOINTS).toBe("history_checkpoints");
    expect(HISTORY_SESSION_FILES).toBe("history_session_files");
    expect(HISTORY_SESSION_REFS).toBe("history_session_refs");
    expect(HISTORY_SEARCH_INDEX).toBe("history_search_index");
    expect(HISTORY_DYNAMIC_CONTEXT_ITEMS).toBe("history_dynamic_context_items");
    expect(HISTORY_SYNC_STATE).toBe("history_sync_state");
  });
});

describe("history _id builders", () => {
  it("sessionId is the bare session id", () => {
    expect(sessionId("abc-123")).toBe("abc-123");
  });

  it("turnId joins session_id and turn_index with `#`", () => {
    expect(turnId("abc-123", 4)).toBe("abc-123#4");
  });

  it("checkpointId joins session_id and checkpoint_number with `#`", () => {
    expect(checkpointId("abc-123", 2)).toBe("abc-123#2");
  });

  it("sessionFileId joins session_id and file_path with `#`", () => {
    expect(sessionFileId("abc-123", "src/index.ts")).toBe("abc-123#src/index.ts");
  });

  it("sessionRefId joins session_id, ref_type, ref_value with `#`", () => {
    expect(sessionRefId("abc-123", "pr", "42")).toBe("abc-123#pr#42");
  });

  it("searchIndexId joins session_id, source_type, source_id with `#`", () => {
    expect(searchIndexId("abc-123", "turn", "5")).toBe("abc-123#turn#5");
  });

  it("dynamicContextId joins repository, branch, src, name with `#`", () => {
    expect(dynamicContextId("owner/repo", "main", "user", "note-1")).toBe(
      "owner/repo#main#user#note-1",
    );
  });
});
