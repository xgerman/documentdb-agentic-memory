# Architecture

This document explains what `documentdb-agentic-memory` actually is, how the
two tracks fit together, and what is stored where. It is the reference for
operators and contributors; user-facing setup is in the [README](../README.md)
and operator commands are in [cli.md](./cli.md).

## What it is, in one sentence

A DocumentDB-backed substitute for two pieces of Copilot tooling at once:

1. The **knowledge-graph MCP server** that ships in
   `@modelcontextprotocol/server-memory`, replacing its single JSON file with
   a real database.
2. The **`session_store` SQLite database** that GitHub Copilot CLI writes at
   `~/.copilot/session-store.db`, mirrored into the same DocumentDB so
   Copilot sessions on other machines can read it as MCP tool calls and so
   any MongoDB client (including [DocumentDBFUSE](./fuse-recipes.md)) can
   query it.

Both tracks land in **one process** (`documentdb-memory-mcp`) and **one
database** (default name `copilot_memory`). They are separated only by
collection prefix (`graph_*` vs `history_*`).

## The two tracks at a glance

```
┌─────────────────────────┐         ┌─────────────────────────┐
│  Copilot session        │         │  documentdb-memory-mcp  │
│  (Copilot CLI, Claude   │  stdio  │  (one Node process,     │
│  Desktop, Cursor, …)    │ ◀──────▶│   17 tools registered)  │
└─────────────────────────┘         └────────────┬────────────┘
                                                 │ MongoDB driver
                                                 ▼
                              ┌──────────────────────────────────┐
                              │  DocumentDB (default db:         │
                              │    copilot_memory)               │
                              │                                  │
                              │  graph_entities                  │
                              │  graph_relations                 │   ← Track 1
                              │                                  │
                              │  history_sessions                │
                              │  history_turns                   │
                              │  history_checkpoints             │
                              │  history_session_files           │   ← Track 2
                              │  history_session_refs            │
                              │  history_search_index            │
                              │  history_dynamic_context_items   │
                              │  history_sync_state              │
                              └──────────────────────────────────┘
                                                 ▲
                                                 │
                ┌──────────────────────────────────────────────┐
                │  documentdb-memory sessions sync             │
                │  (CLI; one-shot or `--watch`)                │
                └────────────────────┬─────────────────────────┘
                                     │ better-sqlite3
                                     ▼
                  ~/.copilot/session-store.db   (read-only)
```

## Track 1: knowledge-graph (`graph_*`)

A drop-in replacement for the official MCP memory server. The wire surface
(tool names, argument shapes, return shapes) is byte-compatible with the
upstream `@modelcontextprotocol/server-memory`; only the storage layer
differs.

### Collections

| Collection        | `_id` shape                                   | Purpose                                                                                          |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `graph_entities`  | the entity name itself                        | One document per entity, with `entityType` and an `observations[]` array of `{text, createdAt}`. |
| `graph_relations` | `${from}__${type}__${to}` (double underscore) | One document per directed triple; deterministic `_id` makes inserts idempotent.                  |

Indexes (declared in `src/storage/graph/schema.ts`):

- `graph_entities`: text index over `_id`, `entityType`, `observations.text`
  (powers `search_nodes`); `entityType` ascending; `updatedAt` ascending.
- `graph_relations`: `from`, `to`, `relationType`, `createdAt` (each
  separately, ascending).

### Tools exposed by the MCP server

Nine tools, all named identically to the upstream server so any prompt
template that mentions them keeps working:

```
create_entities       create_relations      add_observations
delete_entities       delete_relations      delete_observations
read_graph            search_nodes          open_nodes
```

`search_nodes` uses the text index; results include any relation whose
**both** endpoints are in the match set — the same containment rule the
upstream server applies.

Writes are race-safe: `createEntities` / `createRelations` use
`insertMany({ ordered: false })` and swallow E11000 duplicate-key errors,
so concurrent sessions adding the same entity converge instead of crashing.

## Track 2: session-history (`history_*`)

Mirror of the SQLite database that Copilot CLI writes at
`~/.copilot/session-store.db`. The mirror is **read-only with respect to
SQLite** — the sync daemon only ever pulls; nothing here writes back to the
local file.

### Collections

| Collection                      | `_id` shape                        | Source                  |
| ------------------------------- | ---------------------------------- | ----------------------- |
| `history_sessions`              | `session_id`                       | `sessions` table        |
| `history_turns`                 | `session_id#turn_index`            | `turns`                 |
| `history_checkpoints`           | `session_id#checkpoint_number`     | `checkpoints`           |
| `history_session_files`         | `session_id#file_path`             | `session_files`         |
| `history_session_refs`          | `session_id#ref_type#ref_value`    | `session_refs`          |
| `history_search_index`          | `session_id#source_type#source_id` | `search_index` (FTS5)   |
| `history_dynamic_context_items` | `repository#branch#src#name`       | `dynamic_context_items` |
| `history_sync_state`            | one row per source table           | sync metadata only      |

### How the mirror stays current

`SessionHistorySync` (`src/storage/history/sync.ts`) runs per-table
incremental upserts in batches of 500. Each table has its own watermark
stored in `history_sync_state`:

| Source table            | Watermark column          | Operator                   |
| ----------------------- | ------------------------- | -------------------------- |
| `sessions`              | `updated_at` (ISO string) | `>` (strict)               |
| `turns`                 | `id` (autoincrement)      | `>`                        |
| `checkpoints`           | `id`                      | `>`                        |
| `session_files`         | `id`                      | `>`                        |
| `session_refs`          | `id`                      | `>`                        |
| `search_index`          | `rowid` (FTS5)            | `>`                        |
| `dynamic_context_items` | none                      | full re-upsert every cycle |

The strict-`>` comparator on `sessions.updated_at` has one known edge case:
if many rows share the same timestamp and the batch boundary falls on it,
the tail will be skipped. Running `sessions sync --full` repairs this; for
the autoincrement tables the issue doesn't apply.

`dynamic_context_items` has no watermark because the table is small (one
row per (repository, branch, key) tuple) and rows are rewritten in place;
a full re-upsert every cycle is cheaper than tracking deltas.

### Tools exposed by the MCP server

Eight history tools, all prefixed `history_`:

```
history_recent_sessions       history_find_sessions
history_get_session           history_get_checkpoints
history_find_file_history     history_find_refs
history_search                history_get_dynamic_context
```

These names are this project's own — they are **not** part of any upstream
spec. See [mcp-config.md](./mcp-config.md) for argument shapes and example
prompts.

## The MCP server process

`src/server/index.ts`. One Node process speaking JSON-RPC over stdio. On
start it:

1. Loads `.env` via `dotenv` (best-effort).
2. Opens one shared `MongoClient` (`src/shared/mongo.ts`).
3. Runs the index bootstrap for both stores (idempotent).
4. Registers all 17 tools (9 graph + 8 history) via the MCP SDK.
5. Installs SIGINT/SIGTERM handlers for clean shutdown.

The MCP SDK protocol framing on stdio means **nothing must write to stdout
except the SDK itself**. All logs go to stderr via pino (controlled by
`MEMORY_LOG_LEVEL`).

## The sync daemon

Same image as the MCP server, different entrypoint. Reads
`~/.copilot/session-store.db` with `better-sqlite3` (a native module —
this is why the Dockerfile ships a C++ toolchain in the builder stage)
and runs `SessionHistorySync.runOnce()` either once or in a `setInterval`
loop.

The daemon **never opens write transactions on SQLite**. It uses
`new Database(path, { readonly: true })`, so even a buggy version could
not corrupt the source.

## Deployment modes

The repo supports four ways to run this; pick whichever matches your
appetite for containerization:

### 1. Fully containerized (`compose.full.yml`)

```bash
docker compose -f compose.full.yml up -d
```

Brings up four services:

- `documentdb` — `ghcr.io/documentdb/documentdb/documentdb-local:latest`
  with `--username localadmin --password Admin100` passed as CLI args
  (the image does **not** honor `MONGODB_INITDB_ROOT_*` env vars).
- `documentdbfuse` — built from
  `github.com/xgerman/documentdbfuse#main` on first run; mounts the
  database tree under `/mnt/db` inside the container.
- `documentdb-memory-mcp` — this project's MCP server, kept alive with
  `stdin_open: true` so Copilot clients can attach via
  `docker exec -i documentdb-memory-mcp node /app/dist/server/index.js`.
- `documentdb-memory-sync` — same image, runs
  `documentdb-memory sessions sync --watch`; mounts your `~/.copilot`
  directory read-only at `/copilot`.

Inside the compose network, DocumentDB requires TLS (the image enforces
it with a self-signed cert), so the internal URI is
`mongodb://localadmin:Admin100@documentdb:10260/?directConnection=true&tls=true&tlsInsecure=true`.

### 2. Compose, sync daemon on host (`compose.fuse-host-bind.yml`)

A variant that runs DocumentDB + DocumentDBFUSE in containers but expects
the sync daemon to run on the host (see modes 3 and 4 below). Useful when
you want the FUSE mount to be visible to the host shell with no extra
work.

### 3. Host binary, init-managed daemon

`npm install -g .` then load one of the [deployment
templates](../deploy/README.md):

- macOS: `deploy/launchd/com.documentdb.copilot-memory-sync.plist`.
- Linux: `deploy/systemd/documentdb-copilot-memory-sync.service`.

Both are user-level (per-user SQLite access) and templated; you must
substitute the binary path and `DOCUMENTDB_URI` before loading.

### 4. Manual / one-shot

`documentdb-memory sessions sync --once` from any shell. Idempotent;
useful for CI, smoke tests, or post-import sanity passes.

You may mix modes (e.g. compose-managed DocumentDB + launchd-managed sync)
but you should not run two sync daemons against the same DocumentDB —
nothing breaks, but it's wasted work and the logs interleave confusingly.

## Configuration surface

Every knob is documented in [`.env.example`](../.env.example). The most
load-bearing:

| Variable                | Default                           | Read by                               |
| ----------------------- | --------------------------------- | ------------------------------------- |
| `DOCUMENTDB_URI`        | (none — must be set)              | MCP server, CLI                       |
| `DOCUMENTDB_DB`         | `copilot_memory`                  | both                                  |
| `COPILOT_SESSION_STORE` | `$HOME/.copilot/session-store.db` | sync daemon, `doctor`                 |
| `COPILOT_DIR`           | `$HOME/.copilot`                  | `compose.full.yml` (mounts read-only) |
| `MEMORY_LOG_LEVEL`      | `info`                            | pino (server + sync)                  |
| `SYNC_INTERVAL`         | `30s`                             | sync daemon `--watch`                 |
| `FUSE_HOST_BIND`        | (off)                             | `compose.fuse-host-bind.yml`          |
| `FUSE_MOUNT_PATH`       | (off)                             | `doctor` only — manual opt-in         |

## Why one process for two tracks?

The original plan kept them separate. We collapsed them because:

- Both speak MCP over stdio to the same client, and stdio is a finite
  resource per Copilot session.
- Both share the same `MongoClient`, the same `.env`, the same logger.
- Splitting them would require operators to wire two MCP servers into
  every client config and keep two daemons running — that's twice the
  failure modes for no upside.

The two tracks remain logically independent: dropping `graph_*`
collections does not affect history tools, and vice versa.
