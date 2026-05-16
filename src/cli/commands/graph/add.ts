// `documentdb-memory graph add {entity|relation|obs}` — three sibling commands
// for the three insert paths the official memory server exposes. All three
// route through `KnowledgeGraphStore` so semantics (silent on duplicates,
// throws on missing entity for observations) are identical to the MCP tools.

import type { Command } from "commander";
import { info, ok, runWithStore } from "./util.js";

interface AddEntityOptions {
  type: string;
  obs?: string[];
}

export function registerAdd(graph: Command): void {
  const add = graph.command("add").description("Insert entities, relations, or observations.");

  add
    .command("entity <name>")
    .description("Insert (or upsert) a named entity.")
    .requiredOption("--type <T>", "Entity type label (e.g. person, project).")
    .option(
      "--obs <text>",
      "Initial observation; pass repeatedly for multiple.",
      collectStrings,
      [] as string[],
    )
    .action(async function (this: Command, name: string, opts: AddEntityOptions) {
      await runWithStore(this, async ({ store }) => {
        const observations = opts.obs ?? [];
        const created = await store.createEntities([{ name, entityType: opts.type, observations }]);
        if (created.length === 1) {
          ok(`entity "${name}" created (type=${opts.type}, observations=${observations.length})`);
        } else {
          info(`entity "${name}" already exists; no changes`);
        }
      });
    });

  add
    .command("relation <from> <to> <type>")
    .description("Insert a relation with deterministic _id.")
    .action(async function (this: Command, from: string, to: string, type: string) {
      await runWithStore(this, async ({ store }) => {
        const created = await store.createRelations([{ from, to, relationType: type }]);
        if (created.length === 1) {
          ok(`relation ${from} -[${type}]-> ${to} created`);
        } else {
          info(`relation ${from} -[${type}]-> ${to} already exists; no changes`);
        }
      });
    });

  add
    .command("obs <name> <text>")
    .description("Append one observation to an entity.")
    .action(async function (this: Command, name: string, text: string) {
      await runWithStore(this, async ({ store }) => {
        // The store throws "Entity not found: <name>" for unknown entities;
        // surface that as a clean 1-line error rather than a stack trace.
        try {
          const [result] = await store.addObservations([{ entityName: name, contents: [text] }]);
          const added = result?.addedObservations.length ?? 0;
          if (added === 1) {
            ok(`observation appended to "${name}"`);
          } else {
            info(`observation already present on "${name}"; no changes`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Entity not found")) {
            throw new Error(`entity "${name}" does not exist (create it first)`);
          }
          throw err;
        }
      });
    });
}

// commander's collect callback for repeatable `--obs` flags. Keeping it local
// avoids leaking a generic helper that callers might confuse with a parser.
function collectStrings(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
