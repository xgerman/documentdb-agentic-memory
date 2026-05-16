# documentdb-agentic-memory

DocumentDB-backed memory plugin for GitHub Copilot and other MCP clients.
One MCP server, two tracks:

- **Knowledge graph** — a drop-in replacement for the official
  [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
  server. Same nine tools (`create_entities`, `search_nodes`,
  `read_graph`, …) with byte-compatible wire shapes, but storage is a
  MongoDB-protocol database instead of a single JSON file.
- **Session history** — a continuous mirror of GitHub Copilot CLI's local
  `~/.copilot/session-store.db` into the same database, exposed through
  eight additional `history_*` MCP tools. Lets a Copilot session ask "what
  did I work on last week?" and get an answer drawn from sessions on any
  machine you've mirrored.

Both tracks land in **one process** (`documentdb-memory-mcp`) and **one
database** (default name `copilot_memory`), separated only by collection
prefix (`graph_*` vs `history_*`).

If you can connect to MongoDB, you can also browse the same data with
[DocumentDBFUSE](https://github.com/xgerman/documentdbfuse) using `ls`,
`cat`, and `grep`. See [fuse-recipes.md](./docs/fuse-recipes.md).

## Why?

The upstream MCP memory server stores everything in one JSON file. That
works until:

- You want memory to survive across machines, agents, and clients.
- You want to inspect or repair it with anything other than the tool that
  wrote it.
- You also want session-level history — what Copilot did, when, in which
  repo, on which PR — and not just a flat entity/relation graph.

This project addresses both by collapsing them onto the same DocumentDB
instance and serving them through one MCP server. Architectural rationale
in [architecture.md](./docs/architecture.md).

## Quick start

The fastest path brings up DocumentDB, DocumentDBFUSE, the MCP server,
and the sync daemon as one compose stack:

```bash
git clone https://github.com/xgerman/documentdb-agentic-memory.git
cd documentdb-agentic-memory
cp .env.example .env       # edit DOCUMENTDB_URI if needed
docker compose -f compose.full.yml up -d
```

Verify everything is wired correctly:

```bash
# from the host: confirm the CLI sees DocumentDB + your session store
docker compose -f compose.full.yml exec documentdb-memory-mcp \
  node /app/dist/cli/index.js doctor
```

Every check should be green. If something is red, the line will tell you
what to fix.

Then point your MCP client at the server — see
[mcp-config.md](./docs/mcp-config.md) for the exact `mcpServers` entry for
GitHub Copilot CLI, Claude Desktop, Cursor, and any other stdio MCP
client.

### Want it without docker?

Install the CLI and server as host binaries:

```bash
npm install
npm run build
npm install -g .
documentdb-memory doctor
```

You now have two bins on your PATH:

- `documentdb-memory-mcp` — the MCP server (stdio).
- `documentdb-memory` — the operator CLI (`doctor`, `graph`, `sessions`).

To run the sync daemon as a host service, use the templates under
[`deploy/`](./deploy/README.md):

- macOS LaunchAgent at
  `deploy/launchd/com.documentdb.copilot-memory-sync.plist`.
- Linux systemd user unit at
  `deploy/systemd/documentdb-copilot-memory-sync.service`.

## The two bins

### `documentdb-memory-mcp` — the MCP server

Speaks MCP over stdio. Registers 17 tools (9 graph + 8 history). Reads
config from `.env` then env vars then defaults. All logs go to stderr;
stdout is reserved for MCP framing.

Wire it into your MCP client and forget about it.

Full tool surface in [mcp-config.md](./docs/mcp-config.md#tool-surface-quick-index).

### `documentdb-memory` — the CLI

```text
documentdb-memory doctor                 # connectivity + config self-check
documentdb-memory graph ...              # manage the knowledge graph
documentdb-memory sessions ...           # manage the session-history mirror
```

The CLI is what you run when you want to inspect, repair, back up,
import, prune, or wipe what the MCP server reads. It's also what runs the
sync daemon (`documentdb-memory sessions sync --watch`).

Full reference in [cli.md](./docs/cli.md).

The most commonly used flows:

```bash
# Inspect: how big is the graph, and when was it last touched?
documentdb-memory graph stats --json

# Add: shovel some seed knowledge in
documentdb-memory graph add entity Alice --type Person --obs "Lives in Seattle"
documentdb-memory graph add relation Alice Project-Phoenix worksOn

# Sync: bring the history mirror up to date once and exit
documentdb-memory sessions sync --once

# Watch: same, but keep running every 30s (this is what the daemon does)
documentdb-memory sessions sync --watch --interval 30s

# Forget: drop sessions older than 30 days, cascade through everything they own
documentdb-memory sessions purge --older-than 30d

# Back up the graph to a single JSONL file
documentdb-memory graph export ./backup/graph.jsonl
```

## Configuration

Every knob is documented inline in [`.env.example`](./.env.example). The
ones that come up daily:

| Variable                | Default                       | What it does                                              |
| ----------------------- | ----------------------------- | --------------------------------------------------------- |
| `DOCUMENTDB_URI`        | —                             | MongoDB-protocol connection string. **Must** be set.      |
| `DOCUMENTDB_DB`         | `copilot_memory`              | Database name.                                            |
| `COPILOT_SESSION_STORE` | `~/.copilot/session-store.db` | SQLite source for the sync daemon.                        |
| `MEMORY_LOG_LEVEL`      | `info`                        | Pino log level (`debug` is useful when things misbehave). |
| `SYNC_INTERVAL`         | `30s`                         | How often `sessions sync --watch` polls.                  |

The compose-managed DocumentDB enforces TLS server-side with a
self-signed cert, so the internal URI looks like
`mongodb://localadmin:Admin100@documentdb:10260/?directConnection=true&tls=true&tlsInsecure=true`.
The same database reached from the host (where TLS isn't required) is
`mongodb://localadmin:Admin100@localhost:10260/?tls=false`. The compose
stack uses the first; the deploy templates default to the second.

## What's where

```
.
├── README.md                    ← you are here
├── .env.example                 ← every config knob, commented
├── compose.yml                  ← DocumentDB + DocumentDBFUSE
├── compose.full.yml             ← + MCP server + sync daemon
├── compose.fuse-host-bind.yml   ← overlay to bind FUSE to host
├── compose.dev.yml              ← live-reload variant for hacking on src/
├── deploy/                      ← launchd + systemd templates for host install
│   └── README.md
├── docs/
│   ├── architecture.md          ← what's stored where, why one process, …
│   ├── cli.md                   ← authoritative CLI reference
│   ├── mcp-config.md            ← wiring the server into Copilot CLI etc.
│   └── fuse-recipes.md          ← querying memory via ls/cat/jq
├── src/
│   ├── server/                  ← the MCP server (17 tools)
│   ├── cli/                     ← the operator CLI
│   ├── storage/{graph,history}/ ← MongoDB-side data model + sync logic
│   └── shared/                  ← config, mongo, duration parser
└── vendor/
    └── documentdbfuse-compose.yml  ← upstream FUSE compose, vendored
```

## Default-memory priority signaling

The MCP server identifies itself to agents as the user's **primary persistent
memory**, so agents loading this plugin (Copilot CLI, Claude Desktop, Cursor,
…) prefer it over any built-in note-taking, knowledge-graph, or session-store
surface — including `session_store_sql`.

This is implemented at three layers, all of which travel with the plugin (no
per-host or per-session instructions file needed):

1. **Server-level `instructions`** on the MCP `initialize` response
   (`src/server/index.ts`, `SERVER_INSTRUCTIONS`). Most clients deliver this
   text to the model as part of its system prompt. It names every tool, marks
   the plugin as primary memory, and tells the agent to reach for
   `history_recent_sessions` / `history_search` / `search_nodes` early when
   the user references prior work or known entities.
2. **Tool descriptions** for all 17 tools (`src/server/tools/{graph,history}.ts`)
   lead with a `Primary …` tag and end with a `prefer this over …` sentence.
   Agents that pick tools from description text alone still get the signal.
3. **Tool names and input schemas remain byte-compatible** with the upstream
   `@modelcontextprotocol/server-memory` server — only the descriptions
   diverge — so existing prompt templates that quote those names keep working.

If you fork the descriptions, update both the per-tool strings **and**
`SERVER_INSTRUCTIONS` together so the policy stays consistent.

## Compatibility notes

- The MCP **wire surface** of the knowledge-graph tools (names, input schemas,
  return shapes) is byte-compatible with `@modelcontextprotocol/server-memory`.
  Prompt templates and agent scaffolding that reference the upstream tool names
  work unchanged. Tool **descriptions** intentionally diverge — they carry the
  default-memory priority signal documented above; the original upstream
  sentence is preserved verbatim inside each description so anything that
  greps for it still finds it.
- The **export/import file format** for the graph (`documentdb-memory graph
export <file>`) matches the upstream server's `--memory-file-path` JSON
  Lines format. You can hand a dump to the upstream server and vice versa.
- The history tools are **this project's own** — they are not part of any
  upstream MCP spec.

## Status

Early but useful. The MCP server, sync daemon, and CLI are stable; the
deployment story is documented and tested on macOS and Linux. The FUSE
overlay works wherever the kernel supports it (macFUSE on macOS, native
FUSE on Linux).

## License

MIT.
