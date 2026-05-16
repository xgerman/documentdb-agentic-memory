# `documentdb-memory` CLI reference

The `documentdb-memory` binary is the operator-facing surface of this project.
It is **not** required at runtime by the MCP server (the server is the
`documentdb-memory-mcp` bin) — the CLI exists to bootstrap, inspect, repair,
and back up the two MongoDB-protocol databases the server reads from and the
sync daemon writes to.

This page is the authoritative reference for command grammar. Every option
listed here was checked against `src/cli/commands/` in this repository; if a
flag appears in `--help` but is not here, that is a bug — please file an
issue.

## Conventions

- `<angle>` — required positional argument.
- `[square]` — optional argument or flag.
- All commands resolve config in the same order: CLI flag → env var → default.
  The relevant env vars are listed in [`.env.example`](../.env.example).
- On error, the CLI prints a single red line. Pass `--debug` (where supported)
  or set `DEBUG=1` for a full stack trace.
- Commands that take a duration accept the grammar `<number><unit>`, where
  unit is one of `ms`, `s`, `m`, `h`, `d`, `w`. Decimals are allowed
  (`1.5h`). Bare integers (no unit) are rejected.
- Commands that take a cutoff (`--older-than`) accept either a duration
  (interpreted as "now minus this") or an ISO-8601 date/time
  (`2024-01-15T00:00:00Z`).

## Global / shared options

These apply to most top-level commands. They do not bubble up from
subcommands — pass them on the immediate command that documents them.

| Flag          | Default                              | Notes                                                                       |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `--uri <uri>` | `$DOCUMENTDB_URI`                    | MongoDB-protocol connection string.                                         |
| `--db <name>` | `$DOCUMENTDB_DB` or `copilot_memory` | Target database.                                                            |
| `--debug`     | off                                  | Print full error stack traces. Available on `graph` and `sessions` parents. |
| `--json`      | off                                  | Where supported, emit machine-readable JSON instead of human text.          |

---

## `documentdb-memory doctor`

Connectivity and configuration self-check. Run this first if anything seems
off.

```text
documentdb-memory doctor [--uri <uri>] [--db <name>] [--source <path>] [--json]
```

Options:

- `--source <path>` — path to the Copilot CLI session-store SQLite file used
  by `sessions sync`. Defaults to `$COPILOT_SESSION_STORE` or
  `$HOME/.copilot/session-store.db`.
- `--json` — emit one JSON object per check.

Checks performed (in order, fail-fast):

1. **config-resolve** — env / flags parse cleanly.
2. **mongo-connect** — `MongoClient.connect()` succeeds.
3. **mongo-db-readable** — `db.command({ping:1})` succeeds.
4. **graph-indexes** — `graph_entities` and `graph_relations` indexes are
   present (creates them if not — `ensureGraphIndexes` is idempotent).
5. **history-indexes** — same, for the `history_*` collections.
6. **session-store-path** — the SQLite file is present and readable.
7. **fuse-mount** — only run if the `FUSE_MOUNT_PATH` env var is set
   (manually; this knob is intentionally not in `.env.example`). Stats
   `${FUSE_MOUNT_PATH}/${DOCUMENTDB_DB}` to confirm the mirror is visible.

Exit code is `0` if every check passes, `1` otherwise.

---

## `documentdb-memory graph`

The knowledge-graph track. Read/write `graph_entities` and `graph_relations`.
The MCP server reads from the same collections, so anything you write here
is immediately visible to a Copilot session using the
`documentdb-memory-mcp` server.

Parent options: `--uri`, `--db`, `--debug`.

### `graph add entity <name>`

Insert one entity. Idempotent — re-adding the same name is a no-op
(duplicate-key errors are swallowed; observations are appended).

```text
documentdb-memory graph add entity <name> --type <T> [--obs <text>...]
```

- `--type <T>` — required. Entity type (e.g. `Person`, `Project`).
- `--obs <text>` — optional, repeatable. Each occurrence is appended as a
  separate observation.

### `graph add relation <from> <to> <type>`

Insert one relation. `_id` is computed as `${from}__${type}__${to}` (double
underscore) so the same triple cannot be inserted twice.

```text
documentdb-memory graph add relation <from> <to> <type>
```

### `graph add obs <entity> <text>`

Append one observation to an existing entity. Errors if the entity does not
exist.

```text
documentdb-memory graph add obs <entity> <text>
```

### `graph delete entity <name>`

Remove an entity **and** cascade-delete any relation referencing it as
`from` or `to`.

```text
documentdb-memory graph delete entity <name>
```

### `graph delete relation <from> <to> <type>`

Remove exactly one relation triple.

### `graph delete obs <entity> <text>`

Remove a single observation by exact-string match.

### `graph prune`

Time-based cleanup. Removes entities not updated since `<when>`; cascades to
their relations.

```text
documentdb-memory graph prune --older-than <when> [--dry-run] [--json]
```

- `--older-than <when>` — required. Duration (`30d`, `4w`) or ISO-8601.
- `--dry-run` — print what would be deleted; touch nothing.
- `--json` — machine-readable summary.

### `graph wipe`

Drop both graph collections and re-run the index bootstrap. Asks for
confirmation unless `--yes` is passed.

```text
documentdb-memory graph wipe [--yes]
```

### `graph stats`

Counts and small summary (top entity types, oldest/newest `updated_at`).

```text
documentdb-memory graph stats [--json]
```

### `graph dump`

Full JSON snapshot to stdout. The `--json` flag is required (it is currently
the only output mode).

```text
documentdb-memory graph dump --json
```

### `graph export <file>`

Stream the entire graph to a single newline-delimited JSON (`.jsonl`) file.
Each line is one of:

```json
{"type": "entity",   "name": "...", "entityType": "...", "observations": [...]}
{"type": "relation", "from": "...", "to": "...", "relationType": "..."}
```

This format is byte-compatible with the official
`@modelcontextprotocol/server-memory` dump format — you can hand the file to
that server's `--memory-file-path` flag.

### `graph import <file>`

Inverse of `export`. Reads a `.jsonl` file in the same format.

```text
documentdb-memory graph import <file> [--merge | --replace]
```

- `--merge` (default) — insert-or-update; existing entities get new
  observations appended.
- `--replace` — wipe the graph first, then import. Use with care.

---

## `documentdb-memory sessions`

The session-history track. Manages the DocumentDB mirror of Copilot CLI's
local `session-store.db`. **The CLI never modifies the local SQLite file**;
every operation here only touches MongoDB-protocol collections.

Parent options: `--uri`, `--db`, `--debug`.

### `sessions sync`

Mirror the local SQLite into DocumentDB. This is the workhorse command.

```text
documentdb-memory sessions sync [--once | --watch | --full]
                                [--interval <dur>]
                                [--source <path>]
                                [--json]
```

Modes (mutually exclusive; `--once` is the default if none is given):

- `--once` — incremental pass using each table's watermark; exit `0`.
- `--watch` — incremental pass every `--interval`, forever. Pino logs to
  stderr; progress lines to stdout.
- `--full` — ignore watermarks; re-upsert every row in the source. Useful
  after a `sessions wipe` or to repair drift.

Other flags:

- `--interval <dur>` — only with `--watch`. Defaults to `$SYNC_INTERVAL`
  (`30s`).
- `--source <path>` — override the SQLite path.
- `--json` — machine-readable summary. Rejected with `--watch` (no
  terminator).

### `sessions purge`

Delete old sessions and everything they own. Cascades through `history_turns`,
`history_checkpoints`, `history_session_files`, `history_session_refs`, and
`history_search_index`. **Does not** touch `history_dynamic_context_items`
(globally scoped) or `history_sync_state` (sync metadata).

```text
documentdb-memory sessions purge --older-than <when> [--dry-run] [--json]
```

### `sessions wipe`

Drop every `history_*` collection, **including** `history_sync_state`. The
next `sync` run will therefore re-mirror every row from SQLite (effectively
a `--full`).

```text
documentdb-memory sessions wipe [--yes]
```

### `sessions export <dir>`

Write one `<collection>.jsonl` file per `history_*` collection into `<dir>`.
The directory is created if missing.

```text
documentdb-memory sessions export <dir>
```

### `sessions import <dir>`

Inverse of `export`. Reads every `<collection>.jsonl` in the directory.

```text
documentdb-memory sessions import <dir> [--merge | --replace]
```

### `sessions dump --collection <name>`

Dump one collection to stdout.

```text
documentdb-memory sessions dump --collection <name> --json [--jsonl]
```

- `--collection <name>` — required. One of the `history_*` collections.
- `--json` — currently the only output mode; explicit flag required.
- `--jsonl` — emit one object per line (streaming) instead of a single
  JSON array.

---

## Deployment templates

If you want to run the sync daemon as a host service instead of inside
docker compose, the repo ships init-system templates at:

- `deploy/launchd/com.documentdb.copilot-memory-sync.plist` — macOS
  user-level LaunchAgent.
- `deploy/systemd/documentdb-copilot-memory-sync.service` — Linux
  user-level systemd unit.

Both templates wrap `documentdb-memory sessions sync --watch --interval 30s`
and require you to edit the binary path and `DOCUMENTDB_URI` before
loading. The full lifecycle (load, reload, unload, log paths,
troubleshooting) lives in [`deploy/README.md`](../deploy/README.md).

The container-based alternative — `docker compose -f compose.full.yml up -d`
— is documented in [architecture.md](./architecture.md#deployment-modes).
