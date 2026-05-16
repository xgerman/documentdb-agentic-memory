# Querying memory through the filesystem (DocumentDBFUSE recipes)

[DocumentDBFUSE](https://github.com/xgerman/documentdbfuse) mounts any
MongoDB-compatible database as a filesystem. With this project's
`compose.yml` stack, your `copilot_memory` database is browsable under
`/mnt/db/copilot_memory/` (or wherever you bind the mount) — and that
means every MCP tool result is also reachable from any tool that reads
files: `ls`, `cat`, `grep`, `jq`, shell pipelines, agents that lack a
MongoDB driver.

This page is a tour of useful queries. The aggregation-path syntax (every
`.match/`, `.sort/-...`, `.json/results` segment) is documented upstream;
see the [DocumentDBFUSE README](https://github.com/xgerman/documentdbfuse#aggregation-pipeline-queries)
for the full grammar.

## Setup

Bring up the bundled stack:

```bash
docker compose up -d
```

`compose.yml` includes `vendor/documentdbfuse-compose.yml`, which starts
`documentdb` + `documentdbfuse` together. The mount lives inside the
`documentdbfuse` container at `/mnt/db`. To work with it from the host
shell:

```bash
# Quick exec
docker exec -it documentdb-agentic-memory-documentdbfuse \
  ls /mnt/db/copilot_memory/
```

If you want the mount visible directly on the host, switch to the
host-bind compose overlay:

```bash
COMPOSE_FILE=compose.yml:compose.fuse-host-bind.yml docker compose up -d
```

The mount will then appear at the path you configured via the
`FUSE_HOST_BIND` env var. **FUSE on macOS** requires
[macFUSE](https://osxfuse.github.io/); on Linux the kernel module is
already loaded.

> **Sanity tip:** every recipe below assumes you're inside the
> `documentdbfuse` container or have host-bind enabled. Paths are written
> as `/mnt/db/copilot_memory/` for readability.

## Browsing

```bash
# What databases are visible?
ls /mnt/db/
# → copilot_memory  admin  ...

# What collections does our DB have?
ls /mnt/db/copilot_memory/
# → graph_entities  graph_relations  history_sessions  history_turns  ...

# How big is each collection? (O(1), no scan)
for c in /mnt/db/copilot_memory/*/; do
  printf '%-35s %s\n' "$(basename "$c")" "$(cat "${c}.count")"
done
```

`ls /mnt/db/copilot_memory/history_turns/` will refuse to list everything
on a large collection (10 000-document default cap); use the recipes below
or `.all/` if you really want the full listing.

## Graph (Track 1) recipes

The `_id` of every entity is its name, so direct `cat` works:

```bash
# Read one entity by name
cat /mnt/db/copilot_memory/graph_entities/Alice.json
```

```bash
# All entities of type Person, newest first
cat /mnt/db/copilot_memory/graph_entities/\
.match/entityType/Person/.sort/-updated_at/.limit/50/.json/results
```

```bash
# Every relation originating from Alice, as a CSV with header
cat /mnt/db/copilot_memory/graph_relations/.match/from/Alice/.csv/results
```

```bash
# Count how many relations point at "Project-Phoenix"
cat /mnt/db/copilot_memory/graph_relations/.match/to/Project-Phoenix/.count
```

Note that `.match/` is **exact-value** match; there's no regex segment in
the upstream pipeline grammar. For substring search across observation
text, use the MCP `search_nodes` tool (which goes through the text index)
or pipe a JSON dump to `jq`:

```bash
cat /mnt/db/copilot_memory/graph_entities/.json/results \
  | jq '.[] | select(any(.observations[].text; contains("Postgres")))'
```

## Session-history (Track 2) recipes

History `_id`s use `#` as a separator (`session_id#turn_index`,
`session_id#checkpoint_number`, etc.), so direct `cat` on a session works
by id, but for turns you'll usually go through a pipeline.

```bash
# The 10 most recently updated sessions for a given repo, JSON array
cat /mnt/db/copilot_memory/history_sessions/\
.match/repository/owner%2Frepo/.sort/-updated_at/.limit/10/.json/results
```

(URL-encode any `/` inside a match value — `owner%2Frepo`.)

```bash
# All turns for one session, in order
cat /mnt/db/copilot_memory/history_turns/\
.match/session_id/abc-123/.sort/turn_index/.json/results
```

```bash
# Sessions that touched a specific file
cat /mnt/db/copilot_memory/history_session_files/\
.match/file_path/src%2Fauth%2Fsession.ts/.json/results
```

```bash
# Pull session ids from a PR ref, then look up each session
ids=$(cat /mnt/db/copilot_memory/history_session_refs/\
.match/ref_type/pr/.match/ref_value/42/.project/session_id/.json/results \
  | jq -r '.[].session_id')
for id in $ids; do
  cat /mnt/db/copilot_memory/history_sessions/"${id}".json
done
```

## When `.match/` isn't enough

The pipeline path syntax is a subset of MongoDB aggregation: only
`$match` (exact value), `$sort`, `$limit`, `$skip`, and `$project`. For
anything beyond that — regex, `$or`, `$lookup`, `$group` — you have two
options:

1. **Use the MCP tools** instead of FUSE — they call the MongoDB driver
   directly and can express the full query language. `search_nodes` (for
   graph) and `history_search` (for the FTS5 mirror) cover most "I want
   substring/keyword search" needs.
2. **Dump and pipe to `jq`** — pull a manageable slice into JSON and let
   `jq` do the heavy lifting on the host. Works well when the slice is
   bounded; falls over on a "find me in 50k turns" query.

The FUSE recipes shine for the common case: "I roughly know what I want,
my tools speak files, I don't want to write a query script."
