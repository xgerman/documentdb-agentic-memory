import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import type { Db } from "mongodb";
import {
  ConfigError,
  loadConfig,
  type AppConfig,
  type ConfigOverrides,
} from "../../shared/config.js";
import { closeMongo, getMongo, type MongoHandle } from "../../shared/mongo.js";

type CheckStatus = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface DoctorOptions {
  uri?: string;
  db?: string;
  source?: string;
  json?: boolean;
}

interface JsonOutput {
  ok: boolean;
  checks: CheckResult[];
  config: {
    documentdbUri: string;
    documentdbDb: string;
    copilotSessionStore: string;
    fuseMountPath: string | null;
  } | null;
}

const GRAPH_COLLECTIONS = ["graph_entities", "graph_relations"] as const;
const HISTORY_COLLECTIONS = [
  "history_sessions",
  "history_turns",
  "history_checkpoints",
  "history_session_files",
  "history_session_refs",
  "history_search_index",
  "history_dynamic_context_items",
  "history_sync_state",
] as const;

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Run connection, index, and mount health checks.")
    .option("--uri <uri>", "DocumentDB connection URI (overrides DOCUMENTDB_URI).")
    .option("--db <db>", "Database name (overrides DOCUMENTDB_DB).")
    .option(
      "--source <path>",
      "Path to Copilot CLI's session-store.db (overrides COPILOT_SESSION_STORE).",
    )
    .option("--json", "Emit a JSON report on stdout instead of a table.")
    .action(async (opts: DoctorOptions) => {
      const exitCode = await runDoctor(opts);
      process.exit(exitCode);
    });
}

async function runDoctor(opts: DoctorOptions): Promise<number> {
  const json = opts.json === true;
  const results: CheckResult[] = [];
  const overrides: ConfigOverrides = {
    uri: opts.uri,
    db: opts.db,
    source: opts.source,
  };

  let config: AppConfig | null = null;

  try {
    const cfgRes = resolveConfig(overrides);
    results.push(cfgRes.result);
    if (cfgRes.config === undefined) {
      return finalize(results, null, json);
    }
    config = cfgRes.config;

    let handle: MongoHandle | null = null;
    const connect = await checkMongoConnect(config);
    results.push(connect.result);
    handle = connect.handle ?? null;

    if (handle !== null) {
      results.push(await checkDbReadable(handle.db, config.documentdbDb));
      results.push(await checkCollectionGroup("graph-indexes", handle.db, GRAPH_COLLECTIONS));
      results.push(await checkCollectionGroup("history-indexes", handle.db, HISTORY_COLLECTIONS));
    } else {
      // Mongo unreachable — emit warns for the downstream checks so the
      // report stays well-formed.
      results.push({
        name: "mongo-db-readable",
        status: "warn",
        detail: "skipped: mongo-connect failed",
      });
      results.push({
        name: "graph-indexes",
        status: "warn",
        detail: "skipped: mongo-connect failed",
      });
      results.push({
        name: "history-indexes",
        status: "warn",
        detail: "skipped: mongo-connect failed",
      });
    }

    results.push(await checkSessionStorePath(config.copilotSessionStore));
    results.push(await checkFuseMount(config.documentdbDb));

    return finalize(results, config, json);
  } finally {
    await closeMongo().catch(() => undefined);
  }
}

function resolveConfig(overrides: ConfigOverrides): { result: CheckResult; config?: AppConfig } {
  try {
    const config = loadConfig(overrides);
    return {
      result: {
        name: "config-resolve",
        status: "ok",
        detail: `db=${config.documentdbDb}, source=${config.copilotSessionStore}`,
      },
      config,
    };
  } catch (err) {
    const msg = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    return {
      result: { name: "config-resolve", status: "fail", detail: msg },
    };
  }
}

async function checkMongoConnect(
  config: AppConfig,
): Promise<{ result: CheckResult; handle?: MongoHandle }> {
  try {
    const handle = await getMongo(config);
    await handle.client.db("admin").command({ ping: 1 });
    return {
      result: {
        name: "mongo-connect",
        status: "ok",
        detail: `ping ok @ ${hostOf(config.documentdbUri)}`,
      },
      handle,
    };
  } catch (err) {
    return {
      result: {
        name: "mongo-connect",
        status: "fail",
        detail: `${hostOf(config.documentdbUri)}: ${errMsg(err)}`,
      },
    };
  }
}

async function checkDbReadable(db: Db, name: string): Promise<CheckResult> {
  try {
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    return {
      name: "mongo-db-readable",
      status: "ok",
      detail: `${name}: ${cols.length} collection(s)`,
    };
  } catch (err) {
    return {
      name: "mongo-db-readable",
      status: "fail",
      detail: `${name}: ${errMsg(err)}`,
    };
  }
}

async function checkCollectionGroup(
  checkName: string,
  db: Db,
  names: readonly string[],
): Promise<CheckResult> {
  const parts: string[] = [];
  let worst: CheckStatus = "ok";

  for (const collName of names) {
    try {
      const existing = await db.listCollections({ name: collName }, { nameOnly: true }).toArray();
      if (existing.length === 0) {
        parts.push(`${collName}: not yet created`);
        if (worst === "ok") worst = "warn";
        continue;
      }
      const idxRaw = (await db.collection(collName).indexes()) as Array<{ name?: string }>;
      const idxNames = idxRaw
        .map((i) => (typeof i.name === "string" ? i.name : "<unnamed>"))
        .join(",");
      parts.push(`${collName}: [${idxNames}]`);
    } catch (err) {
      parts.push(`${collName}: ${errMsg(err)}`);
      worst = "fail";
    }
  }

  return { name: checkName, status: worst, detail: parts.join("; ") };
}

async function checkSessionStorePath(p: string): Promise<CheckResult> {
  try {
    const st = await stat(p);
    if (!st.isFile()) {
      return {
        name: "session-store-path",
        status: "warn",
        detail: `${p}: exists but is not a regular file`,
      };
    }
    return {
      name: "session-store-path",
      status: "ok",
      detail: `${p} (${st.size} bytes)`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        name: "session-store-path",
        status: "warn",
        detail: `${p}: not found (Copilot CLI may not be installed yet)`,
      };
    }
    return {
      name: "session-store-path",
      status: "fail",
      detail: `${p}: ${errMsg(err)}`,
    };
  }
}

async function checkFuseMount(dbName: string): Promise<CheckResult> {
  const mount = process.env.FUSE_MOUNT_PATH;
  if (mount === undefined || mount.trim() === "") {
    return {
      name: "fuse-mount",
      status: "warn",
      detail: "FUSE_MOUNT_PATH not set; skipping (set it when documentdbfuse is mounted).",
    };
  }
  try {
    const st = await stat(mount);
    if (!st.isDirectory()) {
      return {
        name: "fuse-mount",
        status: "fail",
        detail: `${mount}: not a directory`,
      };
    }
    // The plan calls a successful stat "reachable". As a bonus, peek at the
    // expected db subdirectory so the operator sees whether the mirror is
    // already visible through FUSE.
    const dbDir = resolvePath(mount, dbName);
    let suffix: string;
    try {
      await stat(dbDir);
      suffix = `; ${dbName}/ visible`;
    } catch {
      suffix = `; ${dbName}/ not yet visible (mirror may be empty)`;
    }
    return {
      name: "fuse-mount",
      status: "ok",
      detail: `${mount} reachable${suffix}`,
    };
  } catch (err) {
    return {
      name: "fuse-mount",
      status: "fail",
      detail: `${mount}: ${errMsg(err)}`,
    };
  }
}

function finalize(results: CheckResult[], config: AppConfig | null, json: boolean): number {
  const hasFail = results.some((r) => r.status === "fail");
  if (json) {
    const out: JsonOutput = {
      ok: !hasFail,
      checks: results,
      config:
        config === null
          ? null
          : {
              documentdbUri: redactUri(config.documentdbUri),
              documentdbDb: config.documentdbDb,
              copilotSessionStore: config.copilotSessionStore,
              fuseMountPath: process.env.FUSE_MOUNT_PATH ?? null,
            },
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    const table = new Table({ head: ["Check", "Status", "Detail"], wordWrap: true });
    for (const r of results) {
      table.push([r.name, colorStatus(r.status), r.detail]);
    }
    process.stdout.write(`${table.toString()}\n`);
    if (config !== null) {
      process.stdout.write(
        `\n${pc.dim("uri:")} ${redactUri(config.documentdbUri)}  ${pc.dim("db:")} ${config.documentdbDb}\n`,
      );
    }
  }
  return hasFail ? 1 : 0;
}

function colorStatus(s: CheckStatus): string {
  switch (s) {
    case "ok":
      return pc.green("ok");
    case "warn":
      return pc.yellow("warn");
    case "fail":
      return pc.red("fail");
  }
}

function redactUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.password !== "") {
      u.password = "***";
    }
    return u.toString();
  } catch {
    return uri;
  }
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host === "" ? uri : u.host;
  } catch {
    return uri;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
