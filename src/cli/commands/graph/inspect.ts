// `documentdb-memory graph stats` and `graph dump --json`.
//
// `stats` is the one read-side command the CLI keeps — operators legitimately
// want a quick "how big is the graph" pulse without spinning up FUSE. `dump`
// is the explicit no-FUSE fallback for environments where the FUSE mount
// isn't available; it prints the whole graph as JSON.

import type { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import type { Db } from "mongodb";
import { ENTITIES_COLLECTION, RELATIONS_COLLECTION } from "../../../storage/graph/index.js";
import { emitJson, runWithStore } from "./util.js";

interface StatsOptions {
  json?: boolean;
}

interface StatsReport {
  database: string;
  entities: { count: number; oldestUpdatedAt: string | null; newestUpdatedAt: string | null };
  relations: { count: number };
  topEntityTypes: Array<{ entityType: string; count: number }>;
}

interface DumpOptions {
  json: boolean;
}

export function registerStats(graph: Command): void {
  graph
    .command("stats")
    .description("Print collection counts, top entity types, and updated-at bookends.")
    .option("--json", "Emit a JSON report instead of a table.")
    .action(async function (this: Command, opts: StatsOptions) {
      await runWithStore(this, async ({ config, db }) => {
        const report = await collectStats(db, config.documentdbDb);
        if (opts.json === true) {
          emitJson(report);
        } else {
          renderTable(report);
        }
      });
    });
}

export function registerDump(graph: Command): void {
  graph
    .command("dump")
    .description("Dump the entire graph as JSON. Explicit fallback for no-FUSE environments.")
    .requiredOption("--json", "Required: this command's only output mode.")
    .action(async function (this: Command, _opts: DumpOptions) {
      await runWithStore(this, async ({ store }) => {
        const snapshot = await store.readGraph();
        emitJson(snapshot);
      });
    });
}

async function collectStats(db: Db, dbName: string): Promise<StatsReport> {
  const entities = db.collection(ENTITIES_COLLECTION);
  const relations = db.collection(RELATIONS_COLLECTION);

  const [entityCount, relationCount, top, oldestDoc, newestDoc] = await Promise.all([
    entities.estimatedDocumentCount(),
    relations.estimatedDocumentCount(),
    entities
      .aggregate<{
        _id: string;
        n: number;
      }>([{ $group: { _id: "$entityType", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }])
      .toArray(),
    entities
      .find({}, { projection: { updatedAt: 1 } })
      .sort({ updatedAt: 1 })
      .limit(1)
      .toArray(),
    entities
      .find({}, { projection: { updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .limit(1)
      .toArray(),
  ]);

  return {
    database: dbName,
    entities: {
      count: entityCount,
      oldestUpdatedAt: pickUpdatedAt(oldestDoc[0]?.updatedAt),
      newestUpdatedAt: pickUpdatedAt(newestDoc[0]?.updatedAt),
    },
    relations: { count: relationCount },
    topEntityTypes: top.map((t) => ({ entityType: t._id, count: t.n })),
  };
}

function pickUpdatedAt(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function renderTable(r: StatsReport): void {
  const counts = new Table({ head: ["Collection", "Count"] });
  counts.push([ENTITIES_COLLECTION, r.entities.count], [RELATIONS_COLLECTION, r.relations.count]);
  process.stdout.write(`${counts.toString()}\n`);

  const range = new Table({ head: ["Entity updatedAt", "Value"] });
  range.push(
    ["oldest", r.entities.oldestUpdatedAt ?? pc.dim("(no entities)")],
    ["newest", r.entities.newestUpdatedAt ?? pc.dim("(no entities)")],
  );
  process.stdout.write(`${range.toString()}\n`);

  if (r.topEntityTypes.length > 0) {
    const types = new Table({ head: ["entityType (top 10)", "Count"] });
    for (const t of r.topEntityTypes) {
      types.push([t.entityType, t.count]);
    }
    process.stdout.write(`${types.toString()}\n`);
  }

  process.stdout.write(`\n${pc.dim("db:")} ${r.database}\n`);
}
