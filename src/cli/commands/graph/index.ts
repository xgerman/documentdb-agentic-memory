// Top-level wire-up for the `documentdb-memory graph …` subcommand tree.
//
// Connection options live on the `graph` parent so every leaf inherits them;
// each leaf reads them via commander's `optsWithGlobals()` inside `util.ts`.
// The actual command logic is split across sibling files to keep this entry
// scannable.

import type { Command } from "commander";
import { registerAdd } from "./add.js";
import { registerDelete } from "./delete.js";
import { registerPrune } from "./prune.js";
import { registerReembed } from "./reembed.js";
import { registerWipe } from "./wipe.js";
import { registerExport, registerImport } from "./io.js";
import { registerDump, registerStats } from "./inspect.js";

export function registerGraph(program: Command): void {
  const graph = program
    .command("graph")
    .description("Manage the knowledge-graph collections (entities + relations).")
    .option("--uri <uri>", "DocumentDB connection URI (overrides DOCUMENTDB_URI).")
    .option("--db <db>", "Database name (overrides DOCUMENTDB_DB).")
    .option("--debug", "Print full stack traces on error (also enabled by DEBUG=1).");

  registerAdd(graph);
  registerDelete(graph);
  registerPrune(graph);
  registerReembed(graph);
  registerWipe(graph);
  registerExport(graph);
  registerImport(graph);
  registerStats(graph);
  registerDump(graph);
}
