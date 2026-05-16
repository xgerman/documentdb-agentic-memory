# Wiring `documentdb-memory-mcp` into a Copilot client

The `documentdb-memory-mcp` binary speaks Model Context Protocol over stdio.
It registers **17 tools** in one process: the 9 graph tools from the
upstream `@modelcontextprotocol/server-memory` (under the same names), plus
8 `history_*` tools that expose this project's mirror of Copilot CLI's
session store.

This page covers the two pieces of work you need to do:

1. Make the binary reachable.
2. Tell your MCP client (Copilot CLI, Claude Desktop, Cursor, …) where to
   find it.

Background on what the tools actually do is in
[architecture.md](./architecture.md#tools-exposed-by-the-mcp-server).
Operator commands are in [cli.md](./cli.md).

## Prerequisites

You need a running DocumentDB instance and a populated database. The
fastest path is the bundled stack:

```bash
docker compose -f compose.full.yml up -d
documentdb-memory doctor
```

`doctor` should print one green line per check. If anything is red, fix it
before continuing — every MCP tool call will fail with the same error.

## Choose how to run the server

There are three reasonable shapes.

### A. Global npm install (recommended for host clients)

```bash
cd /path/to/documentdb-agentic-memory
npm install
npm run build
npm install -g .
which documentdb-memory-mcp   # confirm it resolves
```

This gives you both bins: `documentdb-memory-mcp` (the server) and
`documentdb-memory` (the CLI). The server reads config from `.env` in the
current working directory, then env vars, then defaults — so wherever your
MCP client launches the binary from, it needs to be able to find
`DOCUMENTDB_URI`.

### B. Container exec (`compose.full.yml`)

The full-stack compose file keeps a persistent MCP container alive with
`stdin_open: true` so clients can attach over `docker exec`:

```bash
docker compose -f compose.full.yml up -d
```

The MCP server inside the container is launched via the explicit `node`
invocation — the image does not install the bin globally:

```text
docker exec -i documentdb-memory-mcp node /app/dist/server/index.js
```

### C. Local script wrapper (debugging)

Useful when you're iterating on the server itself:

```bash
npm run build
node ./dist/server/index.js
```

You'd typically point your MCP client at the absolute path of this script
and inject `DOCUMENTDB_URI` via the client's `env` block.

## Client wiring

### GitHub Copilot CLI

The Copilot CLI honors entries under `mcpServers` in its config. Drop one
of these blocks in (the exact file location depends on your CLI version —
see `copilot config path` if available):

**Option A — global install:**

```json
{
  "mcpServers": {
    "documentdb-memory": {
      "command": "documentdb-memory-mcp",
      "env": {
        "DOCUMENTDB_URI": "mongodb://localadmin:Admin100@localhost:10260/?tls=false",
        "DOCUMENTDB_DB": "copilot_memory"
      }
    }
  }
}
```

**Option B — container exec:**

```json
{
  "mcpServers": {
    "documentdb-memory": {
      "command": "docker",
      "args": ["exec", "-i", "documentdb-memory-mcp", "node", "/app/dist/server/index.js"]
    }
  }
}
```

The container already has `DOCUMENTDB_URI` baked in via compose, so no
`env` block is needed.

### Claude Desktop / Cursor / other stdio MCP clients

Same shape — every spec-compliant client supports a `command + args + env`
launcher block. Just paste the command line above into the equivalent
config field. Restart the client after editing.

## Health check: from inside the client

After your client picks up the new server, ask it to call one of the cheap
tools. Good probes:

- `read_graph` — returns the full graph (empty on a fresh database).
- `history_recent_sessions` — returns the most recently updated sessions.

If both return without an error, the wire is good. If `read_graph` works
but `history_recent_sessions` returns "no sessions", run
`documentdb-memory sessions sync --once` to populate the mirror; then try
again.

## Tool surface, quick index

The exact argument shapes are visible by reading the MCP server's
self-describing schema — most clients show them on hover. The tables below
are a cheat sheet.

All 17 tools advertise themselves as **primary memory** in their descriptions,
and the server delivers a top-level `instructions` block on `initialize`
telling agents to prefer this plugin over any built-in session/history or
note-taking tool (for example `session_store_sql`). See
[README → "Default-memory priority signaling"](../README.md#default-memory-priority-signaling)
for the rationale.

### Graph tools (9)

Tool **names and input schemas** are identical to the upstream
`@modelcontextprotocol/server-memory` server. If you have prompt templates
that mention these by name, they work unchanged. Tool **descriptions** carry
the default-memory priority signal — the upstream sentence is preserved
verbatim inside each description.

| Tool                  | Purpose                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_entities`     | Insert one or more entities (name + type + observations[]). Idempotent on `name`.                                                                     |
| `create_relations`    | Insert one or more `{from, to, relationType}` triples. Idempotent on the triple.                                                                      |
| `add_observations`    | Append observation strings to existing entities.                                                                                                      |
| `delete_entities`     | Remove entities; cascades to relations referencing them.                                                                                              |
| `delete_relations`    | Remove specific `{from, to, relationType}` triples.                                                                                                   |
| `delete_observations` | Remove observations by exact-string match.                                                                                                            |
| `read_graph`          | Return the full graph. Use sparingly on large stores.                                                                                                 |
| `search_nodes`        | Text-index search over names, entity types, and observation text. Returns matched entities + relations whose **both** endpoints are in the match set. |
| `open_nodes`          | Fetch a specific set of entities by name + their interconnecting relations.                                                                           |

### History tools (8)

This project's own tool surface for the session-store mirror.

| Tool                          | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `history_recent_sessions`     | The most recently updated N sessions, with summaries.                    |
| `history_find_sessions`       | Filter sessions by repository, branch, or free-text against the summary. |
| `history_get_session`         | Fetch one session by id; optionally include the full turn transcript.    |
| `history_get_checkpoints`     | All checkpoints for a session (overview + structured fields).            |
| `history_find_file_history`   | Sessions and turns that touched a given file path.                       |
| `history_find_refs`           | Sessions linked to a PR / issue / commit ref.                            |
| `history_search`              | Keyword search over the FTS5 mirror (`history_search_index`).            |
| `history_get_dynamic_context` | Retrieve dynamic-context items by repository + branch.                   |

## Troubleshooting

- **"DocumentDB connection refused"** — run `documentdb-memory doctor`. The
  CLI shares the same connection-string resolution as the server, so
  whatever fails for `doctor` fails for the server.
- **"empty results from history\_\*"** — the mirror is empty. Either the sync
  daemon isn't running or `~/.copilot/session-store.db` doesn't exist
  (Copilot CLI hasn't recorded any sessions yet). Run
  `documentdb-memory sessions sync --once` and inspect with
  `documentdb-memory sessions dump --collection history_sessions --json | head`.
- **Garbage on stdout breaks the client** — almost always a misconfigured
  Node version or a Node module printing to stdout at import time. The
  MCP framing requires that **only** the MCP SDK write to stdout; all this
  project's logs go to stderr. If you see JSON-RPC framing errors in the
  client, run the binary by hand and verify nothing comes out on stdout
  before the first `Content-Length:` header.
- **Logs are too quiet** — set `MEMORY_LOG_LEVEL=debug` in the `env` block
  of your client config and restart. Pino structured JSON will appear on
  stderr (visible in the client's MCP server log pane).
