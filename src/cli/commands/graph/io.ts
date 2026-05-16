// `documentdb-memory graph export <file.jsonl>` and `graph import <file.jsonl>`.
//
// JSONL format mirrors the official `@modelcontextprotocol/server-memory`
// dump so users can carry graphs between implementations without conversion:
//
//   {"type":"entity",  "name":"X","entityType":"T","observations":["…"]}
//   {"type":"relation","from":"X","to":"Y","relationType":"…"}
//
// One JSON object per line, no array wrapping.

import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import pc from "picocolors";
import type { Db } from "mongodb";
import { runIndexBootstrap } from "../../../shared/mongo.js";
import {
  ENTITIES_COLLECTION,
  RELATIONS_COLLECTION,
  type Entity,
  type Relation,
} from "../../../storage/graph/index.js";
import { info, ok, runWithStore, warn } from "./util.js";

interface ImportOptions {
  merge?: boolean;
  replace?: boolean;
}

export function registerExport(graph: Command): void {
  graph
    .command("export <file>")
    .description("Write the entire graph as JSONL to <file>.")
    .action(async function (this: Command, file: string) {
      await runWithStore(this, async ({ store }) => {
        const { entities, relations } = await store.readGraph();
        const lines: string[] = [];
        for (const e of entities) {
          lines.push(JSON.stringify({ type: "entity", ...e }));
        }
        for (const r of relations) {
          lines.push(JSON.stringify({ type: "relation", ...r }));
        }
        // Trailing newline keeps `wc -l` honest and matches POSIX text-file
        // conventions; consumers that split on `\n` get an empty tail they
        // already need to handle.
        const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
        await writeFile(file, body, "utf8");
        ok(
          `exported ${entities.length} entit${entities.length === 1 ? "y" : "ies"} and ${relations.length} relation(s) to ${file}`,
        );
      });
    });
}

export function registerImport(graph: Command): void {
  graph
    .command("import <file>")
    .description("Load JSONL produced by `graph export` (or the official server).")
    .option("--merge", "Merge into existing data (default; duplicates are skipped).")
    .option("--replace", "Drop both collections first, then load.")
    .action(async function (this: Command, file: string, opts: ImportOptions) {
      if (opts.merge === true && opts.replace === true) {
        process.stderr.write(`${pc.red("error:")} --merge and --replace are mutually exclusive\n`);
        process.exit(1);
      }
      await runWithStore(this, async ({ db, store }) => {
        const { entities, relations, skipped } = await parseJsonl(file);
        if (skipped > 0) {
          warn(`skipped ${skipped} unrecognised line(s) (missing or unknown "type")`);
        }

        if (opts.replace === true) {
          await dropAll(db);
          await runIndexBootstrap(db);
        }

        const createdEntities = await store.createEntities(entities);
        const createdRelations = await store.createRelations(relations);
        const mode = opts.replace === true ? "replace" : "merge";
        ok(
          `imported ${createdEntities.length}/${entities.length} entit${entities.length === 1 ? "y" : "ies"} and ${createdRelations.length}/${relations.length} relation(s) (mode=${mode})`,
        );
        if (
          entities.length !== createdEntities.length ||
          relations.length !== createdRelations.length
        ) {
          info(
            `  (${entities.length - createdEntities.length} entit${entities.length - createdEntities.length === 1 ? "y" : "ies"} and ${relations.length - createdRelations.length} relation(s) already existed)`,
          );
        }
      });
    });
}

interface ParsedJsonl {
  entities: Entity[];
  relations: Relation[];
  skipped: number;
}

// Tolerant JSONL parser. Blank lines are silently skipped; lines we can't
// classify get counted into `skipped` so the user sees a warning but the
// import still proceeds for the valid rows.
async function parseJsonl(file: string): Promise<ParsedJsonl> {
  const text = await readFile(file, "utf8");
  const entities: Entity[] = [];
  const relations: Relation[] = [];
  let skipped = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid JSON on line ${i + 1}: ${msg}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      skipped += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "entity" && isEntityShape(obj)) {
      entities.push({
        name: obj.name,
        entityType: obj.entityType,
        observations: obj.observations,
      });
    } else if (obj.type === "relation" && isRelationShape(obj)) {
      relations.push({
        from: obj.from,
        to: obj.to,
        relationType: obj.relationType,
      });
    } else {
      skipped += 1;
    }
  }
  return { entities, relations, skipped };
}

function isEntityShape(o: Record<string, unknown>): o is {
  name: string;
  entityType: string;
  observations: string[];
} & Record<string, unknown> {
  return (
    typeof o.name === "string" &&
    typeof o.entityType === "string" &&
    Array.isArray(o.observations) &&
    o.observations.every((v) => typeof v === "string")
  );
}

function isRelationShape(o: Record<string, unknown>): o is {
  from: string;
  to: string;
  relationType: string;
} & Record<string, unknown> {
  return (
    typeof o.from === "string" && typeof o.to === "string" && typeof o.relationType === "string"
  );
}

async function dropAll(db: Db): Promise<void> {
  for (const name of [ENTITIES_COLLECTION, RELATIONS_COLLECTION]) {
    try {
      await db.collection(name).drop();
    } catch (err) {
      if (isNamespaceNotFound(err)) continue;
      throw err;
    }
  }
}

function isNamespaceNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; codeName?: unknown };
  return e.code === 26 || e.codeName === "NamespaceNotFound";
}
