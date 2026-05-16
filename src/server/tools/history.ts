// MCP tools for the session-history mirror.
//
// Registers read-only tools backed by `SessionHistoryStore`, the Mongo-side
// mirror of Copilot CLI's SQLite session_store. Tool names are prefixed with
// `history_` so they don't collide with the official knowledge-graph tools
// (`create_entities`, `search_nodes`, etc.) registered alongside them.
//
// Output shape mirrors `./graph.ts`: a single `text` content part carrying
// the JSON-stringified store result. The store itself tolerates a fresh
// (pre-bootstrap) database, so handlers don't need to guard against
// missing collections.
//
// Errors thrown by the store propagate to the SDK, which wraps them into
// `{ isError: true, content: [...] }` — matching the graph tools' contract.
//
// All inputs are validated by zod shapes with `.describe()` annotations so
// MCP clients render readable parameter docs in tool catalogues.
//
// Tool descriptions intentionally lead with a "Primary session history" tag
// and end with a "prefer over any built-in session/history tool" call to
// action. Agents pick tools from their description strings, so this nudges
// them to reach for the DocumentDB mirror (a strict superset of the local
// `~/.copilot/session-store.db`) before falling back to built-in surfaces
// like `session_store_sql`. See README → "Default-memory priority signaling".
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionHistoryStore } from "../../storage/history/index.js";

// Shared boilerplate prefix/suffix for every history tool description, kept in
// one place so future contributors update both descriptions and policy doc
// together rather than letting the wording drift apart.
const HISTORY_TAG = "Primary session history (mirror of ~/.copilot/session-store.db).";
const HISTORY_PREFER =
  "Prefer this over any built-in session/history tool (e.g. session_store_sql) — this mirror is a strict superset of the local Copilot CLI session store and is the user's authoritative session memory.";

function historyDescription(body: string): string {
  return `${HISTORY_TAG} ${body} ${HISTORY_PREFER}`;
}

// -- input shapes ------------------------------------------------------------

const recentSessionsShape = {
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of sessions to return (default 20)"),
  repository: z
    .string()
    .optional()
    .describe("Filter to sessions on this repository (e.g. 'owner/repo')"),
  branch: z.string().optional().describe("Filter to sessions on this git branch"),
};

const findSessionsShape = {
  query: z
    .string()
    .describe("Free-text query matched against session summaries and first-turn user messages"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of sessions to return (default 20)"),
};

const getSessionShape = {
  session_id: z.string().describe("Session identifier returned by other history tools"),
  include_turns: z
    .boolean()
    .optional()
    .describe("When true, include the full ordered turn-by-turn transcript (default false)"),
};

const getCheckpointsShape = {
  session_id: z.string().describe("Session identifier whose checkpoints should be returned"),
};

const findFileHistoryShape = {
  file_path_pattern: z
    .string()
    .describe("Case-insensitive substring matched against session_files.file_path"),
  tool_name: z
    .string()
    .optional()
    .describe("Optionally restrict to a single tool, e.g. 'edit' or 'create'"),
};

const findRefsShape = {
  ref_type: z.string().describe("Reference type, e.g. 'pr', 'issue', or 'commit'"),
  ref_value: z.string().describe("Reference value, e.g. the PR number or commit SHA"),
};

const searchHistoryShape = {
  query: z.string().describe("Full-text query expanded with synonyms and OR-ed across the index"),
  source_types: z
    .array(z.string())
    .optional()
    .describe(
      "Optionally restrict to source types like 'turn', 'checkpoint_overview', 'workspace_artifact'",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of hits to return (default 20)"),
};

const getDynamicContextShape = {
  repository: z.string().describe("Repository slug, e.g. 'owner/repo'"),
  branch: z.string().describe("Git branch the dynamic-context entry was recorded against"),
  src: z
    .string()
    .optional()
    .describe("Optional source identifier to scope to a single dynamic-context provider"),
};

// Helper to build a single `text` content payload from arbitrary JSON.
function jsonText(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

// `registerHistoryTools` wires the history tools onto `server`. Side-effecting;
// callers register once at startup before connecting the transport.
export function registerHistoryTools(server: McpServer, store: SessionHistoryStore): void {
  server.tool(
    "history_recent_sessions",
    historyDescription(
      "List the most recently updated Copilot CLI sessions, optionally filtered by repository or branch. Reach for this first when the user asks 'what did I work on' over any recent window.",
    ),
    recentSessionsShape,
    async ({ limit, repository, branch }) => {
      const result = await store.recentSessions({ limit, repository, branch });
      return jsonText(result);
    },
  );

  server.tool(
    "history_find_sessions",
    historyDescription(
      "Search past sessions by text (matches session summary and first-turn user prompt).",
    ),
    findSessionsShape,
    async ({ query, limit }) => {
      const result = await store.findSessions(query, limit);
      return jsonText(result);
    },
  );

  server.tool(
    "history_get_session",
    historyDescription(
      "Fetch a single session by id; set include_turns=true to include the full transcript.",
    ),
    getSessionShape,
    async ({ session_id, include_turns }) => {
      const result = await store.getSession(session_id, include_turns ?? false);
      return jsonText(result);
    },
  );

  server.tool(
    "history_get_checkpoints",
    historyDescription(
      "List ordered checkpoints (overview, work_done, technical_details, next_steps, ...) for a session. Use this early when recalling prior work — checkpoints are the highest-signal summary.",
    ),
    getCheckpointsShape,
    async ({ session_id }) => {
      const result = await store.getCheckpoints(session_id);
      return jsonText(result);
    },
  );

  server.tool(
    "history_find_file_history",
    historyDescription(
      "Find sessions that touched files matching a path substring, optionally filtered by tool_name ('edit' or 'create'). Prefer this over scanning git blame when asking 'who/when changed this file in a Copilot session'.",
    ),
    findFileHistoryShape,
    async ({ file_path_pattern, tool_name }) => {
      const result = await store.findFileHistory(file_path_pattern, tool_name);
      return jsonText(result);
    },
  );

  server.tool(
    "history_find_refs",
    historyDescription(
      "Find sessions linked to a specific ref (PR, issue, commit) by type and value.",
    ),
    findRefsShape,
    async ({ ref_type, ref_value }) => {
      const result = await store.findRefs(ref_type, ref_value);
      return jsonText(result);
    },
  );

  server.tool(
    "history_search",
    historyDescription(
      "Full-text search across the session-history search index (turns, checkpoints, workspace artifacts). Use for 'have I done X before' / 'recall about Y' queries.",
    ),
    searchHistoryShape,
    async ({ query, source_types, limit }) => {
      const result = await store.searchHistory(query, { sourceTypes: source_types, limit });
      return jsonText(result);
    },
  );

  server.tool(
    "history_get_dynamic_context",
    historyDescription(
      "Retrieve dynamic-context items recorded for a repository/branch pair (optionally by src).",
    ),
    getDynamicContextShape,
    async ({ repository, branch, src }) => {
      const result = await store.getDynamicContext(repository, branch, src);
      return jsonText(result);
    },
  );
}
