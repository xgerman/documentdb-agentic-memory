// `documentdb-memory graph delete {entity|relation|obs}`. Mirrors the three
// official MCP delete tools. All three are silent on misses (no-op) since
// that's what `KnowledgeGraphStore` and the official server both do — we just
// print `ok` so the user has positive confirmation.

import type { Command } from "commander";
import { ok, runWithStore } from "./util.js";

export function registerDelete(graph: Command): void {
  const del = graph.command("delete").description("Delete entities, relations, or observations.");

  del
    .command("entity <name>")
    .description("Delete an entity and cascade to incident relations.")
    .action(async function (this: Command, name: string) {
      await runWithStore(this, async ({ store }) => {
        await store.deleteEntities([name]);
        ok(`entity "${name}" deleted (cascaded to incident relations)`);
      });
    });

  del
    .command("relation <from> <to> <type>")
    .description("Delete a single relation.")
    .action(async function (this: Command, from: string, to: string, type: string) {
      await runWithStore(this, async ({ store }) => {
        await store.deleteRelations([{ from, to, relationType: type }]);
        ok(`relation ${from} -[${type}]-> ${to} deleted`);
      });
    });

  del
    .command("obs <name> <text>")
    .description("Remove one observation text from an entity.")
    .action(async function (this: Command, name: string, text: string) {
      await runWithStore(this, async ({ store }) => {
        await store.deleteObservations([{ entityName: name, observations: [text] }]);
        ok(`observation removed from "${name}"`);
      });
    });
}
