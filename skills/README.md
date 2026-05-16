# documentdb-memory Copilot CLI skills

Three skill packs that teach GitHub Copilot CLI **when** and **how** to use
the `documentdb-memory` MCP server. Drop them into your global skills
directory and the agent will reach for the right `documentdb-memory-*` tools
automatically — without you having to remember the tool names.

| Skill | Trigger phrases | What it does |
|-------|-----------------|--------------|
| **documentdb-memory-recall** | "what did I work on today / last week", "have I touched this file before", "what session created PR #N", "find sessions about X" | Routes recall questions to the eight `documentdb-memory-history_*` MCP tools (with FUSE / `sessions dump` fallbacks). |
| **documentdb-memory-remember** | "remember that…", "save this preference", "note that A depends on B", "don't forget…" | Persists facts to the shared knowledge graph via the nine official-memory tools (`create_entities`, `create_relations`, `search_nodes`, …). |
| **documentdb-memory-ops** | "is memory healthy", "sync now", "purge old sessions", "back up the graph", "why isn't memory working" | Drives `documentdb-memory doctor`, `sessions sync / purge / wipe / export`, `graph prune / inspect`, and FUSE inspection. |

All three are `user-invocable: true`, so they also appear as slash
commands: `/documentdb-memory-recall`, `/documentdb-memory-remember`,
`/documentdb-memory-ops`. The descriptions are written so the agent
auto-triggers them on matching natural-language prompts, too — you usually
don't need to type the slash command.

## Install

GitHub Copilot CLI loads global skills from `~/.copilot/skills/<skill-name>/SKILL.md`.

```bash
# from the repo root
mkdir -p ~/.copilot/skills
cp -R skills/documentdb-memory-recall   ~/.copilot/skills/
cp -R skills/documentdb-memory-remember ~/.copilot/skills/
cp -R skills/documentdb-memory-ops      ~/.copilot/skills/
```

Or in one line:

```bash
mkdir -p ~/.copilot/skills && cp -R skills/documentdb-memory-* ~/.copilot/skills/
```

Symlinks work too if you'd rather keep the canonical copies under version
control here:

```bash
mkdir -p ~/.copilot/skills
for d in skills/documentdb-memory-*; do
  ln -sfn "$PWD/$d" "$HOME/.copilot/skills/$(basename "$d")"
done
```

Verify Copilot CLI sees them:

```bash
copilot
# inside the REPL:
/skills          # should list documentdb-memory-recall / -remember / -ops
/env             # shows skills, MCP servers, instructions in one view
```

No restart is needed for skill changes — Copilot CLI re-scans
`~/.copilot/skills/` on each session.

## Prerequisite: a working MCP entry

The skills assume the `documentdb-memory` MCP server is registered in
`~/.copilot/mcp-config.json` **with `tools: ["*"]`**. If you only have:

```json
"documentdb-memory": {
  "command": "docker",
  "args": ["exec", "-i", "documentdb-memory-mcp", "node", "/app/dist/server/index.js"]
}
```

then Copilot CLI connects to the server but doesn't pre-load its tools into
the agent's default toolset — so the agent will reach for `cat`/`grep`
fallbacks instead of `history_recent_sessions`. The correct entry is:

```json
"documentdb-memory": {
  "type": "stdio",
  "command": "docker",
  "args": ["exec", "-i", "documentdb-memory-mcp", "node", "/app/dist/server/index.js"],
  "tools": ["*"]
}
```

Restart Copilot CLI after editing. `/mcp` should show
`documentdb-memory` with the 17 tools registered (9 graph + 8 history).

## How skills, MCP, and instructions relate

- **MCP server** = the tools (verbs). It exposes `history_recent_sessions`,
  `create_entities`, etc.
- **Skill** = guidance on *when* to use those tools, what order to call them
  in, what to do when they fail, what to avoid. Loaded into the agent's
  context when its description matches the user's prompt.
- **Instructions** (`copilot-instructions.md`, `AGENTS.md`) = always-on
  context that ships in every prompt. Use sparingly — large instructions
  eat the context window.

Skills are the right place for "use this MCP server *like this*" guidance:
they're scoped (only loaded when relevant), discoverable, and don't bloat
every turn.

## Editing the skills

The skill loader reads YAML frontmatter:

```yaml
---
name: documentdb-memory-recall   # must match the directory name
description: >-                  # this is the auto-trigger phrase the agent matches against
    ...                          # write it so a model can recognize when to invoke
user-invocable: true             # show as /<name> slash command; false = agent-only
---
```

Body is plain markdown — keep it focused on *when* to call which tool and
which traps to avoid. The whole body is loaded as context when the skill
fires, so brevity helps.
