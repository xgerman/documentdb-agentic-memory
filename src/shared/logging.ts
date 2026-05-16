import pino, { type Logger } from "pino";
import type { LogLevel } from "./config.js";

// Thin pino wrapper. The MCP server runs over stdio, so logs must NEVER go to
// stdout — that channel is reserved for MCP framing. Everything writes to
// stderr (fd 2), which is also pino's default destination.

export function createLogger(level: LogLevel, name = "documentdb-memory"): Logger {
  const isTTY = process.stderr.isTTY === true;
  return pino(
    {
      name,
      level,
      base: undefined,
    },
    isTTY
      ? pino.transport({
          target: "pino-pretty",
          options: { destination: 2, colorize: true, translateTime: "SYS:HH:MM:ss" },
        })
      : pino.destination(2),
  );
}

export type { Logger };
