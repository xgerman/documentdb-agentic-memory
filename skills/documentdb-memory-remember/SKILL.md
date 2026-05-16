---
name: documentdb-memory-remember
description: >-
    Persist long-lived facts, preferences, decisions, or relationships into the shared
    DocumentDB-backed knowledge graph via the documentdb-memory MCP server. Use when the user
    says "remember that…", "don't forget…", "save this preference", "note that X depends on Y",
    or whenever a fact should survive across sessions and machines.
user-invocable: true
---

# Persist facts to the shared knowledge graph

You are the write/read surface over the knowledge-graph half of the
`documentdb-memory` MCP server. This is a drop-in replacement for the official
`@modelcontextprotocol/server-memory`, with the same nine tools and the same
wire shapes — but storage is shared DocumentDB instead of one local JSON file,
so anything you write here is visible from every machine that points at the
same database.

## When to write

Write to the graph when the user states a fact that should outlive this
session:

- Preferences ("I prefer pnpm over npm", "always use Conventional Commits")
- Decisions ("we chose Postgres over Mongo for project X because …")
- Relationships ("service A depends on queue B", "PR #42 is blocked on #41")
- People / handles / aliases
- Project-specific context that you'd want a future session to pick up
  automatically

Don't write transient per-session state (todos for this session, scratch
plans, intermediate reasoning). Use SQL/`plan.md` for those.

## Tool selection cheatsheet

All tools are prefixed `documentdb-memory-` in the registered tool list.

| Intent | Tool |
|--------|------|
| Create new entities (typed nodes with observations) | `create_entities` |
| Add observation strings to existing entities | `add_observations` |
| Connect two entities with a typed relation | `create_relations` |
| Remove specific observations from an entity | `delete_observations` |
| Remove relations | `delete_relations` |
| Remove entities (cascades relations) | `delete_entities` |
| Dump the whole graph | `read_graph` |
| Text search by name / type / observation contents | `search_nodes` |
| Fetch a precise set of entities by name | `open_nodes` |

These match the official server's tool names and shapes exactly — any prompt
or workflow written against `@modelcontextprotocol/server-memory` works
unchanged.

## Write workflow

1. **Search before you write.** Call `search_nodes` (or `open_nodes` if you
   know the exact name) to check whether the entity already exists. Names are
   the primary key (`_id`).
2. **Pick a stable entity name.** Prefer the canonical identifier the user
   uses (`user:geeichbe`, `repo:msdata/cosmosdb-pgcosmos`, `pref:commit-style`).
   Names are case-sensitive and globally unique.
3. **Use a clear `entityType`** — `person`, `preference`, `project`, `service`,
   `decision`, `pr`, etc. Reuse existing types; only invent a new one if no
   existing type fits.
4. **Observations are short factual statements**, one per array entry. Don't
   pack a paragraph into one observation; split it.
5. **Use relations to express dependencies.** `relationType` should be active
   voice (`depends_on`, `prefers`, `owns`, `mentions`, `supersedes`).
6. **Confirm what was written.** Echo the entity name + new observations or
   relations back to the user so they can correct you immediately.

## Read workflow

When you need to pull memory back in:

- `search_nodes({ query: "<term>" })` — broad recall by text match.
- `open_nodes({ names: ["repo:x", "pref:y"] })` — surgical fetch when you
  already know the names. Cheaper than `read_graph`.
- `read_graph()` — only when you genuinely need the whole graph (rare; the
  graph can grow large).

## Examples

User: *"Remember that I always want commits signed-off in the
documentdb-agentic-memory repo."*

```
search_nodes({ query: "documentdb-agentic-memory" })       # check for existing entity
create_entities({ entities: [{
  name: "repo:xgerman/documentdb-agentic-memory",
  entityType: "repository",
  observations: ["Requires DCO sign-off on every commit."]
}]})
```

User: *"Note that service `billing-api` depends on `payments-queue`."*

```
create_entities({ entities: [
  { name: "service:billing-api",   entityType: "service", observations: [] },
  { name: "service:payments-queue", entityType: "service", observations: [] }
]})  # no-ops if they already exist
create_relations({ relations: [{
  from: "service:billing-api",
  to:   "service:payments-queue",
  relationType: "depends_on"
}]})
```

## When the MCP tools are not registered

Same recovery as for the recall skill: ensure the `documentdb-memory` entry
in `~/.copilot/mcp-config.json` has `"type": "stdio"` and
`"tools": ["*"]`, then restart Copilot CLI. As a one-off, you can dynamically
discover the tools with `tool_search_tool_regex pattern="create_entities"`.

## FUSE inspection (read-only)

The graph is browsable as files under the `documentdbfuse` mount:

```bash
docker compose -f compose.full.yml exec -T documentdbfuse \
  ls /mnt/db/copilot_memory/graph_entities | head
docker compose -f compose.full.yml exec -T documentdbfuse \
  cat /mnt/db/copilot_memory/graph_entities/<entity-name>.json
```

Useful for `grep`-style audits, but **never edit those files directly** —
write goes through the MCP tools so indexes stay consistent.
