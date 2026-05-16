# Production image for documentdb-agentic-memory.
#
# Consumed by `compose.full.yml`, which runs two containers from this same
# image:
#   * MCP server  — default CMD (node /app/dist/server/index.js).
#   * Sync daemon — compose overrides CMD with the CLI subcommand.
#
# Multi-stage so the final runtime image carries no build toolchain and no
# devDependencies. The development image (`Dockerfile.dev`) is a separate
# concern and is NOT touched by this file.

# ---------------------------------------------------------------------------
# Stage 1: builder
#
# We need a full C++ toolchain here because `better-sqlite3` is a native
# module: `npm install` runs node-gyp which invokes python3/make/g++ to
# compile the SQLite bindings against the local Node ABI.
#
# `git` is kept in case any transitive npm dep pulls from VCS. `ca-certificates`
# lets npm reach the public registry over TLS.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        git \
        ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifest(s) first so the dep-install layer caches independently of the
# source code. The `*` keeps the COPY tolerant of a missing `package-lock.json`
# (the repo currently gitignores it; CI may produce one).
COPY package*.json ./

# Use `npm ci` for reproducible installs when a lockfile is present, otherwise
# fall back to `npm install`. Either path produces a fully built node_modules
# (including the compiled better-sqlite3 .node binary) that we hand off to the
# runtime stage as-is.
RUN if [ -f package-lock.json ]; then \
        npm ci --no-audit --no-fund; \
    else \
        npm install --no-audit --no-fund; \
    fi

# Source + build config last so edits to src/ don't bust the dep-install cache.
COPY tsconfig.json tsup.config.ts ./
COPY src ./src

# tsup emits dist/server/index.js and dist/cli/index.js with `#!/usr/bin/env
# node` shebangs and chmods them +x via its onSuccess hook.
RUN npm run build

# Drop devDependencies (tsup, typescript, vitest, eslint, etc.) so the
# node_modules tree we copy to the runtime stage only carries production deps.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime
#
# Same base as builder (glibc + same Node ABI) so the native `.node` binary
# compiled in stage 1 keeps working. Alpine/musl would have required either
# a recompile here or a separate Alpine builder; bookworm-slim is small enough
# (~80 MB base) and avoids that complication.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# `tini` is a minimal init that reaps zombies and forwards SIGTERM/SIGINT to
# PID 1. The MCP server runs on stdio and the sync daemon is a long-lived
# loop — both need clean signal delivery so `docker stop` doesn't have to
# escalate to SIGKILL after the 10s grace period.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy build artifacts and pruned production node_modules from the builder.
# We deliberately do NOT re-run `npm install` here: that would force node-gyp
# to recompile better-sqlite3 (and pull the toolchain back in). Reusing the
# already-compiled tree keeps the runtime image lean.
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# `node:20-bookworm-slim` ships a non-root `node` user at uid 1000. Hand the
# /app tree over to it before switching, then run as `node` for the rest of
# the container's life.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
# Tell tini to act as a sub-reaper so any grandchild processes started by the
# Node entrypoints (e.g. mongo driver workers) are still reaped if their
# immediate parent dies.
ENV TINI_SUBREAPER=1

# No HEALTHCHECK on purpose: the MCP server's liveness signal is its stdio
# pipe to the parent client (Copilot CLI, Claude Desktop, ...), not a network
# port we could curl. compose.full.yml can wire a service-specific healthcheck
# if it needs one.

LABEL org.opencontainers.image.title="documentdb-agentic-memory" \
      org.opencontainers.image.description="DocumentDB-backed Copilot memory: MCP knowledge-graph plugin + Copilot CLI session-store mirror." \
      org.opencontainers.image.source="https://github.com/xgerman/documentdb-agentic-memory" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Default to the MCP server. compose.full.yml overrides CMD for the sync
# daemon container.
CMD ["node", "/app/dist/server/index.js"]
