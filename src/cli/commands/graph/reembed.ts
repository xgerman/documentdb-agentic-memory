// `documentdb-memory graph reembed` — (re)compute embedding vectors for the
// knowledge-graph entities so DocumentDB Search can find them semantically.
//
// Use this to backfill vectors for entities created before embeddings were
// enabled, or after switching the embedding model (which changes the vector
// dimensionality and therefore requires a full re-embed + index rebuild).

import type { Command } from "commander";
import { info, ok, runWithStore, warn } from "./util.js";

interface ReembedOptions {
  all?: boolean;
}

export function registerReembed(graph: Command): void {
  graph
    .command("reembed")
    .description("(Re)compute embedding vectors for entities (DocumentDB Search).")
    .option(
      "--all",
      "Re-embed every entity, not just those missing or stale vectors.",
      false,
    )
    .action(async function (this: Command, opts: ReembedOptions) {
      await runWithStore(
        this,
        async ({ store }) => {
          if (!store.vectorSearchEnabled) {
            warn(
              "no embedding provider available (set MEMORY_EMBEDDING_PROVIDER and ensure the backend is reachable); nothing to do",
            );
            return 1;
          }
          info(opts.all === true ? "re-embedding all entities…" : "embedding missing/stale entities…");
          const { scanned, embedded } = await store.reembed({ onlyStale: opts.all !== true });
          ok(`reembed complete: scanned ${scanned}, embedded ${embedded}`);
          return 0;
        },
        { withEmbedder: true },
      );
    });
}
