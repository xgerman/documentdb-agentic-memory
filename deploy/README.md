# Host-binary deployment templates

This directory ships init-system templates for running
`documentdb-memory sessions sync --watch` directly on the host (no container),
as a long-lived background daemon that mirrors `~/.copilot/session-store.db`
into DocumentDB.

There are two templates:

| File                                                                                                     | OS    | Init system                |
| -------------------------------------------------------------------------------------------------------- | ----- | -------------------------- |
| [`launchd/com.documentdb.copilot-memory-sync.plist`](./launchd/com.documentdb.copilot-memory-sync.plist) | macOS | launchd (user LaunchAgent) |
| [`systemd/documentdb-copilot-memory-sync.service`](./systemd/documentdb-copilot-memory-sync.service)     | Linux | systemd (user unit)        |

Both are **templates** — you must edit them before installing to set:

1. The absolute path to the `documentdb-memory` binary (run
   `which documentdb-memory` to find it).
2. Your real `DOCUMENTDB_URI` (the templates ship with the local
   docker-compose default, which is a placeholder).
3. macOS only: the absolute path to `~/.copilot/session-store.db`
   (plists do not expand `~`). systemd uses `%h` so it just works.

Both templates are **user-level**, never system-level. The daemon needs read
access to `~/.copilot/session-store.db`, which is per-user; running it as
root would be wrong.

## Prerequisite: install the CLI globally

```bash
cd /path/to/documentdb-agentic-memory
npm install           # if you haven't yet
npm run build
npm install -g .      # installs the `documentdb-memory` binary into your PATH
which documentdb-memory   # sanity check
documentdb-memory doctor  # confirms DocumentDB connectivity, version, etc.
```

If `which documentdb-memory` returns nothing, your global npm bin directory is
not on `$PATH`. Fix that first (`npm config get prefix` will show where
globals land; ensure `<prefix>/bin` is on `$PATH`).

## Deployment options

| Mode                  | When to use                                                                                                       | How                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Containerized**     | You want everything (DocumentDB + sync daemon + MCP server) self-contained and easy to tear down.                 | `docker compose -f compose.full.yml up -d` |
| **launchd (macOS)**   | You're on macOS and want the sync daemon to start at login.                                                       | This directory, `launchd/` template        |
| **systemd (Linux)**   | You're on Linux and want the sync daemon to start at login (and optionally at boot via `loginctl enable-linger`). | This directory, `systemd/` template        |
| **Manual / one-shot** | Ad-hoc syncs, testing, CI. No daemon.                                                                             | `documentdb-memory sessions sync --once`   |

The containerized path (`compose.full.yml`) and the host-binary path
(this directory) are alternatives — pick one. Running both will not corrupt
anything (each sync run is idempotent), but it's wasted work and the logs
get confusing.

## macOS quick start

```bash
cp deploy/launchd/com.documentdb.copilot-memory-sync.plist \
   ~/Library/LaunchAgents/com.documentdb.copilot-memory-sync.plist
$EDITOR ~/Library/LaunchAgents/com.documentdb.copilot-memory-sync.plist   # set paths + URI
launchctl load -w ~/Library/LaunchAgents/com.documentdb.copilot-memory-sync.plist
launchctl list | grep documentdb-memory-sync
tail -F /tmp/documentdb-memory-sync.err.log
```

See the comment header inside the plist for the full lifecycle (unload,
reload-after-edit, etc.).

## Linux quick start

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/documentdb-copilot-memory-sync.service \
   ~/.config/systemd/user/documentdb-copilot-memory-sync.service
$EDITOR ~/.config/systemd/user/documentdb-copilot-memory-sync.service   # set path + URI
chmod 600 ~/.config/systemd/user/documentdb-copilot-memory-sync.service
systemctl --user daemon-reload
systemctl --user enable --now documentdb-copilot-memory-sync.service
journalctl --user -u documentdb-copilot-memory-sync.service -f
```

If you want it to start at boot without you having to log in, also run:

```bash
loginctl enable-linger $USER
```

See the comment header inside the unit file for the full lifecycle.

## Troubleshooting

### Daemon not starting

- Run `which documentdb-memory` — if it returns nothing, the CLI isn't on
  your `$PATH`. Re-run `npm install -g .` from the repo root and check
  `npm config get prefix` to see where the binary landed.
- Run `documentdb-memory doctor`. It checks DocumentDB connectivity,
  session-store accessibility, and the CLI's own config. All rows should be
  green before you enable the daemon.
- **launchd**: `launchctl list | grep documentdb-memory-sync`. If the second
  column (last exit status) is non-zero, look at
  `/tmp/documentdb-memory-sync.err.log` for the crash reason.
- **systemd**: `systemctl --user status documentdb-copilot-memory-sync.service`.
  The last 10 log lines appear at the bottom of the status output.

### Mongo connection refused

- If you're using the containerized DocumentDB, verify it's up:
  `docker compose -f compose.full.yml ps`. The `documentdb` service should
  be `running (healthy)`.
- Verify the `DOCUMENTDB_URI` in the plist / unit matches the one in your
  `.env` (or whatever you used when starting DocumentDB). A mismatch in
  port, password, or `tls=false` will surface as ECONNREFUSED or an auth
  error.
- Network: launchd / systemd user units run as you, so they see localhost
  but not docker-internal hostnames. Use `localhost` + the published port,
  not the docker service name.

### Logs are empty

- **systemd**: `StandardOutput=journal` and `StandardError=journal` send
  everything to the journal. Use
  `journalctl --user -u documentdb-copilot-memory-sync.service -f` (note
  `--user`); the system journal will not show user-unit logs.
- **launchd**: pino writes structured JSON to **stderr**, which lands in
  `/tmp/documentdb-memory-sync.err.log`. The `.out.log` will usually be
  small (just startup banners). If both files are empty:
  - The daemon may not be running — check `launchctl list`.
  - `/tmp` may have been cleared on reboot; the file is recreated on the
    next launchd start.
- Bump verbosity by setting `MEMORY_LOG_LEVEL=debug` in the
  `EnvironmentVariables` block (plist) or `Environment=` line (unit), then
  reload.
