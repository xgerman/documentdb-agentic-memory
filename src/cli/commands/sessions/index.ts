// Top-level wire-up for the `documentdb-memory sessions …` subcommand tree.
//
// Mirrors the `graph` tree's layout: connection options on the parent,
// `optsWithGlobals()` inheritance for leaves, and one file per command.
// The shared helpers live in `./util.js` and are deliberately separate from
// `graph/util.ts` (sessions commands operate at the raw `Db` level instead
// of through a typed store, so the two have different context shapes).

import type { Command } from "commander";
import { registerSync } from "./sync.js";
import { registerPurge } from "./purge.js";
import { registerWipe } from "./wipe.js";
import { registerExport, registerImport } from "./io.js";
import { registerDump } from "./dump.js";

export function registerSessions(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Mirror Copilot CLI's session-store SQLite into DocumentDB and manage the mirror.")
    .option("--uri <uri>", "DocumentDB connection URI (overrides DOCUMENTDB_URI).")
    .option("--db <db>", "Database name (overrides DOCUMENTDB_DB).")
    .option("--debug", "Print full stack traces on error (also enabled by DEBUG=1).");

  registerSync(sessions);
  registerPurge(sessions);
  registerWipe(sessions);
  registerExport(sessions);
  registerImport(sessions);
  registerDump(sessions);
}
