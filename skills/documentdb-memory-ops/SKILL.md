---
name: documentdb-memory-ops
description: >-
    Operate, diagnose, and repair the documentdb-memory stack — health checks (doctor), force a
    session-store sync, prune or wipe old data, export/import collections, and browse via the
    documentdbfuse mount. Use when the user says "is documentdb-memory healthy", "sync now",
    "purge old sessions", "back up the graph", "why isn't memory working", or mentions
    `documentdb-memory doctor` / `sessions sync` / `graph prune`.
user-invocable: true
---

# Operate and diagnose the documentdb-memory stack

You are the operator surface for the `documentdb-memory` system: the MCP
server, the SQLite→DocumentDB sync sidecar, the DocumentDB instance itself,
and the `documentdbfuse` mount. The repo lives at
`~/Projects/documentdb-agentic-memory` and the production deploy is the
`compose.full.yml` stack.

## Stack topology (one process per container)

| Container | Image | Role |
|-----------|-------|------|
| `documentdb-agentic-memory-documentdb` | `ghcr.io/documentdb/documentdb/documentdb-local:latest` | MongoDB-wire server on port 10260 |
| `documentdb-agentic-memory-documentdbfuse` | `documentdb-agentic-memory-documentdbfuse` | FUSE mount of the database at `/mnt/db/<db>/<collection>/<id>.json` |
| `documentdb-memory-mcp` | `documentdb-memory:local` | MCP stdio server, exposes 9 graph tools + 8 `history_*` tools |
| `documentdb-memory-sync` | `documentdb-memory:local` | Long-running sidecar: mirrors `~/.copilot/session-store.db` → DocumentDB (`SYNC_INTERVAL` default 30s) |

## Health check first

Always start with `doctor` when anything looks wrong:

```bash
cd ~/Projects/documentdb-agentic-memory
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js doctor
```

Or, host-side if installed via `npm install -g .`:

```bash
documentdb-memory doctor
documentdb-memory doctor --json   # machine-readable; password redacted
```

Seven checks run: config-resolve, mongo-connect, mongo-db-readable,
graph-indexes, history-indexes, session-store-path, fuse-mount. Every line
that goes red tells you what to fix.

## Common operations

### Force / inspect a sync

```bash
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js sessions sync --once          # one-shot
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js sessions sync --once --full   # rebuild from scratch (repairs watermark gaps)
docker compose -f compose.full.yml logs -f documentdb-memory-sync   # watch the daemon
```

The daemon keeps per-table watermarks in `history_sync_state`. The default
mode uses `>` comparison on `updated_at`, which can drop ties at batch
boundaries — `--full` is the documented repair path.

### Prune old history

`purge` only drops mirrored documents in DocumentDB; the local SQLite is
never touched.

```bash
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js sessions purge --older-than 30d
```

### Prune the knowledge graph

```bash
documentdb-memory graph prune --older-than 90d
documentdb-memory graph inspect --json   # stats
```

### Backup / restore

```bash
# Export every history_* collection to JSONL
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js sessions export /tmp/backup
# Import (upsert by _id)
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js sessions import /tmp/backup
```

The graph has equivalent `graph export` / `graph import` JSONL commands in
the official-server wire format.

### Wipe (destructive)

```bash
documentdb-memory sessions wipe   # drops all history_* collections, prompts unless --yes
documentdb-memory graph wipe      # drops graph_entities + graph_relations
```

Both re-bootstrap indexes after dropping.

### Browse with FUSE

```bash
docker compose -f compose.full.yml exec -T documentdbfuse \
  ls /mnt/db/copilot_memory/
# graph_entities/  graph_relations/  history_sessions/  history_turns/  history_checkpoints/
# history_session_files/  history_session_refs/  history_search_index/
# history_dynamic_context_items/  history_sync_state/
```

See `docs/fuse-recipes.md` in the repo for the full catalog of `ls`/`cat`/
`grep` recipes plus `.match`/`.sort`/`.limit`/`.project` pipeline paths.

## Diagnosis recipes

**"Memory tools are missing from this Copilot CLI session"** → check
`~/.copilot/mcp-config.json`. The `documentdb-memory` entry must include
`"type": "stdio"` AND `"tools": ["*"]`. Without `tools: ["*"]`, Copilot CLI
connects to the server but does not auto-register its tools. Restart
Copilot CLI after editing.

**"Sync daemon container is up but no new sessions appear"** →
1. `docker compose -f compose.full.yml logs --tail=100 documentdb-memory-sync`
2. Verify the bind: container reads `/copilot/session-store.db`, which is a
   read-only bind of `$COPILOT_DIR` (defaults to `$HOME/.copilot`).
3. Run `sessions sync --once --full` to repair watermark gaps.

**"DocumentDB connection refused"** → the local container enforces TLS in
some images. The default URI in `.env.example` for the dockerized stack is:
`mongodb://localadmin:Admin100@localhost:10260/?directConnection=true&tls=true&tlsInsecure=true`.

**"FUSE mount shows empty database"** → restart the `documentdbfuse`
container after the DocumentDB container is healthy. The mount discovers
databases at start.

## Don't

- Don't touch `~/.copilot/session-store.db` directly. Copilot CLI hard-codes
  that path and writes raw bytes; we mirror, never replace.
- Don't edit files under the FUSE mount. It's a read surface for inspection,
  not a write API.
- Don't run `wipe` without confirming the user really means it.
