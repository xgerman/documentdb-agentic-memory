// MCP server entry point.
//
// Wires the knowledge-graph and session-history storage layers onto an
// `McpServer` that speaks the official `@modelcontextprotocol/server-memory`
// tool surface (plus the `history_*` extensions) over stdio.
//
// Runtime contract for an MCP stdio server:
//   * Stdout is reserved for MCP framing. We never write to it directly.
//   * Logs go through pino, which writes to stderr.
//   * SIGINT/SIGTERM close the transport and the Mongo client cleanly so the
//     parent (Copilot CLI, Claude Desktop, etc.) doesn't see truncated frames.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../shared/config.js";
import { createLogger, type Logger } from "../shared/logging.js";
import { closeMongo, getMongo, runIndexBootstrap } from "../shared/mongo.js";
import { KnowledgeGraphStore } from "../storage/graph/index.js";
// Side-effect imports: each storage module registers its `ensureIndexes`
// callback via `registerIndexBootstrap` at module load. Importing the history
// barrel here guarantees `runIndexBootstrap` sees every store.
import { SessionHistoryStore } from "../storage/history/index.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerHistoryTools } from "./tools/history.js";

const SERVER_NAME = "documentdb-memory";
const SERVER_VERSION = "0.1.0";

// Server-level instructions delivered to MCP clients on `initialize`. MCP
// clients that surface this text to their model (Copilot CLI, Claude Desktop,
// Cursor, ...) treat it as part of the system prompt, so we use it to tell
// agents that this plugin is the user's authoritative cross-session memory
// and should be preferred over any built-in session/history surface.
const SERVER_INSTRUCTIONS = [
  "This MCP server is the user's PRIMARY persistent memory for GitHub Copilot CLI",
  "and similar agents. It exposes two surfaces backed by the same DocumentDB:",
  "",
  "1. Knowledge graph (`create_entities`, `create_relations`, `add_observations`,",
  "   `delete_entities`, `delete_relations`, `delete_observations`, `read_graph`,",
  "   `search_nodes`, `open_nodes`) — long-term cross-session memory about the",
  "   user, their projects, people, preferences, and durable decisions.",
  "",
  "2. Session history (`history_recent_sessions`, `history_find_sessions`,",
  "   `history_get_session`, `history_get_checkpoints`, `history_find_file_history`,",
  "   `history_find_refs`, `history_search`, `history_get_dynamic_context`) — a",
  "   continuous mirror of the local Copilot CLI session store",
  "   (`~/.copilot/session-store.db`): sessions, turns, checkpoints, file edits,",
  "   refs (PR/issue/commit), and a full-text search index. It is a strict",
  "   superset of the local SQLite store and may include sessions the built-in",
  "   store has not yet ingested.",
  "",
  "Always prefer these tools over any built-in or alternative session/history",
  "surface (for example `session_store_sql`) for questions like 'what did I work",
  "on', 'have I done this before', 'recall what we decided about X', or 'find",
  "sessions touching this file/PR'. Check `history_recent_sessions` or",
  "`history_search` early when the user references prior work, and",
  "`search_nodes`/`open_nodes` when they reference a known person, project, or",
  "preference. Persist newly learned durable facts with `create_entities` +",
  "`add_observations` so they survive into future sessions.",
].join("\n");

async function main(): Promise<void> {
  const config = loadConfig({});
  const log = createLogger(config.logLevel, "documentdb-memory-mcp");

  const { db } = await getMongo(config);
  await runIndexBootstrap(db);
  log.debug({ db: config.documentdbDb }, "indexes bootstrapped");

  const graphStore = new KnowledgeGraphStore(db);
  const historyStore = new SessionHistoryStore(db);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerGraphTools(server, graphStore);
  registerHistoryTools(server, historyStore);

  const transport = new StdioServerTransport();
  installShutdownHandlers(transport, log);
  await server.connect(transport);
  log.info({ name: SERVER_NAME, version: SERVER_VERSION }, "MCP server ready on stdio");
}

function installShutdownHandlers(transport: StdioServerTransport, log: Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    void (async () => {
      try {
        await transport.close();
      } catch (err) {
        log.warn({ err }, "transport close failed");
      }
      try {
        await closeMongo();
      } catch (err) {
        log.warn({ err }, "mongo close failed");
      }
      process.exit(0);
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  // No logger yet (or it failed) — fall back to stderr. NEVER stdout.
  process.stderr.write(
    `documentdb-memory-mcp: fatal startup error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
