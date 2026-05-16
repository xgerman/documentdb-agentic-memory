// CLI entry point. Subcommands are registered by their respective modules so
// each todo owns its own surface area.
//
// Wired here:   doctor, graph, sessions

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerDoctor } from "./commands/doctor.js";
import { registerGraph } from "./commands/graph/index.js";
import { registerSessions } from "./commands/sessions/index.js";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/index.ts -> ../../package.json
  // dist/cli/index.js -> ../../package.json
  const candidates = [
    resolvePath(here, "..", "..", "package.json"),
    resolvePath(process.cwd(), "package.json"),
  ];
  for (const c of candidates) {
    try {
      const raw = readFileSync(c, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("documentdb-memory")
    .description(
      "DocumentDB-backed Copilot memory: knowledge-graph + session-store mirror, " +
        "browsable via documentdbfuse.",
    )
    .version(readVersion(), "-v, --version", "Print version and exit.")
    .helpOption("-h, --help", "Print this help text and exit.")
    .showHelpAfterError("(run with --help for usage)");

  registerDoctor(program);
  registerGraph(program);
  registerSessions(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
