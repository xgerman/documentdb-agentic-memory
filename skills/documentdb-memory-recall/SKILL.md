---
name: documentdb-memory-recall
description: >-
    Look up past Copilot CLI sessions (what was worked on, when, in which repo, with which files,
    PRs, or issues) using the documentdb-memory MCP server. Use when the user asks "what did I
    work on today / yesterday / last week", "have I touched this file before", "what session
    created PR #123", "did I investigate <X> recently", or otherwise wants historical context
    pulled from prior sessions on any machine that mirrors into the shared DocumentDB.
user-invocable: true
---

# Recall past Copilot work from DocumentDB

You are the recall surface over the `documentdb-memory` MCP server. The server
mirrors Copilot CLI's local `~/.copilot/session-store.db` from one or more
machines into a shared DocumentDB so that any session can ask "what did I do
before, anywhere?" and get a real answer.

Use the `documentdb-memory-history_*` MCP tools **first**. Only fall back to
the FUSE mount or the CLI if those tools are not registered for this session.

## Tool selection cheatsheet

| User asks | Tool | Notes |
|-----------|------|-------|
| "most recent sessions", "what am I doing lately", "sessions on `main` of repo X" | `documentdb-memory-history_recent_sessions` | Pass `repository` / `branch` to filter. Default limit 20. |
| "did I work on X", "find sessions about auth", free-text recall | `documentdb-memory-history_find_sessions` | Matches session summaries and first-turn user messages. Synonym-expanded. |
| "show me the transcript of session abc" | `documentdb-memory-history_get_session` | Set `include_turns: true` for the full turn-by-turn dump. |
| "what was the plan / overview / next steps" | `documentdb-memory-history_get_checkpoints` | Returns ordered checkpoints (overview, work_done, next_steps, technical_details, important_files). This is usually the highest-signal answer for "what did I work on" questions — read it before fetching turns. |
| "have I touched `src/foo.ts`", "every session that edited this file" | `documentdb-memory-history_find_file_history` | `file_path_pattern` is a case-insensitive substring; optional `tool_name` filter (`edit` / `create`). |
| "what session created PR #42", "sessions linked to issue 117", "sessions that touched commit abc" | `documentdb-memory-history_find_refs` | `ref_type` is `pr`, `issue`, or `commit`. |
| "search everything for <term>" — turns + checkpoints + artifacts | `documentdb-memory-history_search` | Full-text across the search index; can scope with `source_types: ["turn", "checkpoint_overview", "workspace_artifact"]`. |
| "what dynamic-context entries are saved for this repo/branch" | `documentdb-memory-history_get_dynamic_context` | Repo + branch required; optional `src` to scope to one provider. |

## Recall workflow

1. **Pick the narrowest tool first.** If the user names a file, go straight to
   `history_find_file_history`. If they name a PR / issue / commit, use
   `history_find_refs`. If they give a date range or "today", use
   `history_recent_sessions` and filter client-side on `updated_at`.
2. **Read checkpoints before turns.** Checkpoints (`overview`, `work_done`,
   `next_steps`, `technical_details`, `important_files`) are pre-summarized by
   prior sessions and almost always answer "what did I work on" without
   needing the full transcript.
3. **Only fetch full turns when asked for specifics** — citations, exact code,
   error messages. `history_get_session({session_id, include_turns: true})`.
4. **Cite the session id and timestamps** in your answer so the user can
   `/resume <id>` if they want to keep going.

## When the MCP tools are not registered

If `documentdb-memory-history_*` tools are missing from the toolset, the MCP
server is connected but its tools aren't being auto-loaded. Two recovery
paths:

- **Discover them dynamically** via `tool_search_tool_regex pattern="history_"`
  — they exist, they just weren't pre-loaded.
- **Fix the root cause**: open `~/.copilot/mcp-config.json` and ensure the
  `documentdb-memory` entry includes `"type": "stdio"` and `"tools": ["*"]`.
  Without `tools: ["*"]`, Copilot CLI registers the server but does not
  surface its tools by default. Restart Copilot CLI after editing.

## FUSE / CLI fallback (only if MCP tools cannot be used)

The same data is mounted by the `documentdbfuse` container at
`/mnt/db/copilot_memory/` inside the `documentdbfuse` service. Useful when the
MCP tools are unavailable or you need a bulk grep:

```bash
# Sessions updated today
docker compose -f compose.full.yml exec -T documentdbfuse \
  sh -c 'grep -l "\"updated_at\": \"$(date -u +%Y-%m-%d)" /mnt/db/copilot_memory/history_sessions/*.json'

# Checkpoint for a specific session
docker compose -f compose.full.yml exec -T documentdbfuse \
  cat /mnt/db/copilot_memory/history_checkpoints/<session_id>#1.json
```

CLI dump fallback (no FUSE required):

```bash
docker compose -f compose.full.yml exec -T documentdb-memory-mcp \
  node /app/dist/cli/index.js sessions dump --collection history_sessions --jsonl
```

## Don't

- Don't `cat ~/.copilot/session-store.db` — that's SQLite bytes, not queryable
  text, and it only contains *this* machine's sessions.
- Don't paste raw JSON checkpoints back to the user; summarize.
- Don't call `history_get_session` with `include_turns: true` as a first
  step — checkpoints almost always suffice and are 10–100× smaller.
