// `documentdb-memory graph prune --older-than <date|dur> [--dry-run] [--json]`.
//
// Age-based cleanup. Two phases run against the underlying `Db` rather than
// `KnowledgeGraphStore` because the store deliberately has no "delete by age"
// surface (the MCP tool layer never needs it):
//
//   1. Entities with `updatedAt < cutoff` are removed; their names are then
//      cascaded into a relation `deleteMany` so we don't leave orphaned
//      relations pointing at vanished entities.
//   2. Relations with `createdAt < cutoff` are removed independently — a stale
//      relation between two still-active entities is still stale.
//
// `--dry-run` performs only counting queries and skips both delete passes.

import type { Command } from "commander";
import type { Db } from "mongodb";
import { parseCutoff } from "../../../shared/duration.js";
import {
  ENTITIES_COLLECTION,
  RELATIONS_COLLECTION,
  type EntityDoc,
  type RelationDoc,
} from "../../../storage/graph/index.js";
import { emitJson, info, ok, runWithStore } from "./util.js";

interface PruneOptions {
  olderThan: string;
  dryRun?: boolean;
  json?: boolean;
}

interface PruneCounts {
  cutoff: string;
  dryRun: boolean;
  entities: number;
  relationsByAge: number;
  relationsCascaded: number;
}

export function registerPrune(graph: Command): void {
  graph
    .command("prune")
    .description("Delete entities/relations older than a cutoff (duration or ISO date).")
    .requiredOption(
      "--older-than <when>",
      'Cutoff: ISO date ("2025-01-15") or duration ("30d", "12h").',
    )
    .option("--dry-run", "Report counts only; do not delete.")
    .option("--json", "Emit counts as JSON instead of human-readable text.")
    .action(async function (this: Command, opts: PruneOptions) {
      await runWithStore(this, async ({ db }) => {
        // `parseCutoff` accepts both ISO dates and "30d"-style durations and
        // throws a typed error on garbage input — let it propagate so the
        // outer handler prints it cleanly.
        const cutoff = parseCutoff(opts.olderThan);
        const counts = opts.dryRun === true ? await dryRun(db, cutoff) : await execute(db, cutoff);

        if (opts.json === true) {
          emitJson(counts);
        } else {
          renderText(counts);
        }
      });
    });
}

async function dryRun(db: Db, cutoff: Date): Promise<PruneCounts> {
  const entities = db.collection<EntityDoc>(ENTITIES_COLLECTION);
  const relations = db.collection<RelationDoc>(RELATIONS_COLLECTION);

  // Use `countDocuments` (not `estimatedDocumentCount`) because we have a
  // selective filter — the index on `updatedAt`/`createdAt` makes this cheap.
  const [entityCount, relationsByAge, names] = await Promise.all([
    entities.countDocuments({ updatedAt: { $lt: cutoff } }),
    relations.countDocuments({ createdAt: { $lt: cutoff } }),
    entities
      .find({ updatedAt: { $lt: cutoff } }, { projection: { _id: 1 } })
      .map((d) => d._id)
      .toArray(),
  ]);

  // Cascade count: relations not already covered by the age filter, whose
  // endpoint is among the entities we *would* delete. Subtracting the
  // double-count would require a single `$or` query with the union, so we
  // just report the cascade total — operators can sum mentally.
  const relationsCascaded =
    names.length === 0
      ? 0
      : await relations.countDocuments({
          $or: [{ from: { $in: names } }, { to: { $in: names } }],
        });

  return {
    cutoff: cutoff.toISOString(),
    dryRun: true,
    entities: entityCount,
    relationsByAge,
    relationsCascaded,
  };
}

async function execute(db: Db, cutoff: Date): Promise<PruneCounts> {
  const entities = db.collection<EntityDoc>(ENTITIES_COLLECTION);
  const relations = db.collection<RelationDoc>(RELATIONS_COLLECTION);

  // Snapshot the names first so the cascade pass knows which relations to
  // sweep even after the entity rows are gone.
  const names = await entities
    .find({ updatedAt: { $lt: cutoff } }, { projection: { _id: 1 } })
    .map((d) => d._id)
    .toArray();

  const entityRes = await entities.deleteMany({ updatedAt: { $lt: cutoff } });
  const ageRes = await relations.deleteMany({ createdAt: { $lt: cutoff } });
  const cascadeRes =
    names.length === 0
      ? { deletedCount: 0 }
      : await relations.deleteMany({
          $or: [{ from: { $in: names } }, { to: { $in: names } }],
        });

  return {
    cutoff: cutoff.toISOString(),
    dryRun: false,
    entities: entityRes.deletedCount ?? 0,
    relationsByAge: ageRes.deletedCount ?? 0,
    relationsCascaded: cascadeRes.deletedCount ?? 0,
  };
}

function renderText(c: PruneCounts): void {
  if (c.dryRun) {
    info(`dry-run: cutoff = ${c.cutoff}`);
    info(`  would delete ${c.entities} entit${c.entities === 1 ? "y" : "ies"}`);
    info(`  would delete ${c.relationsByAge} relation(s) by age`);
    info(`  cascade would touch ${c.relationsCascaded} relation(s)`);
  } else {
    ok(`pruned (cutoff = ${c.cutoff})`);
    info(`  deleted ${c.entities} entit${c.entities === 1 ? "y" : "ies"}`);
    info(`  deleted ${c.relationsByAge} relation(s) by age`);
    info(`  cascaded ${c.relationsCascaded} relation(s) from entity removals`);
  }
}
