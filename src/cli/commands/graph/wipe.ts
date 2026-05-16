// `documentdb-memory graph wipe [--yes]` — drop the two graph collections.
//
// Destructive, so we gate it behind explicit confirmation:
//
//   * Interactive TTY: prompt for "yes" (case-insensitive). Anything else
//     aborts cleanly.
//   * Non-TTY (CI, pipes, kubernetes job): the prompt would dangle forever,
//     so we refuse unless `--yes` is supplied.
//
// After dropping, we re-run `runIndexBootstrap` so subsequent commands don't
// hit an empty collection with no indexes (Mongo would create them lazily
// anyway, but doing it now keeps the indexes consistent with what `doctor`
// expects to see).

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import pc from "picocolors";
import type { Db } from "mongodb";
import { runIndexBootstrap } from "../../../shared/mongo.js";
import { ENTITIES_COLLECTION, RELATIONS_COLLECTION } from "../../../storage/graph/index.js";
import { info, ok, runWithStore } from "./util.js";

interface WipeOptions {
  yes?: boolean;
}

export function registerWipe(graph: Command): void {
  graph
    .command("wipe")
    .description("Drop both graph collections after confirmation.")
    .option("--yes", "Skip the confirmation prompt (required when STDIN is not a TTY).")
    .action(async function (this: Command, opts: WipeOptions) {
      await runWithStore(this, async ({ config, db }) => {
        if (opts.yes !== true) {
          if (process.stdin.isTTY !== true) {
            process.stderr.write(
              `${pc.red("error:")} --yes is required when STDIN is not a TTY.\n`,
            );
            return 1;
          }
          const confirmed = await confirmInteractive(config.documentdbDb);
          if (!confirmed) {
            info("aborted");
            return 1;
          }
        }

        const dropped = await dropCollections(db);
        // Re-register indexes against the now-empty collections so the schema
        // matches what `doctor` reports on a fresh deployment.
        await runIndexBootstrap(db);
        ok(`wiped ${dropped.join(", ") || "(no collections existed)"}`);
        return 0;
      });
    });
}

async function confirmInteractive(dbName: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `About to drop graph_entities and graph_relations from "${dbName}". Type "yes" to confirm: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function dropCollections(db: Db): Promise<string[]> {
  const dropped: string[] = [];
  for (const name of [ENTITIES_COLLECTION, RELATIONS_COLLECTION]) {
    try {
      const wasDropped = await db.collection(name).drop();
      if (wasDropped) dropped.push(name);
    } catch (err) {
      // Mongo throws NamespaceNotFound when the collection doesn't exist yet.
      // Anything else (auth, network, …) should surface so we re-throw it.
      if (isNamespaceNotFound(err)) continue;
      throw err;
    }
  }
  return dropped;
}

function isNamespaceNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; codeName?: unknown };
  return e.code === 26 || e.codeName === "NamespaceNotFound";
}
