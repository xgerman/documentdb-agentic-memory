// Parsers for two kinds of "when" strings we use across the CLI:
//
//   * Duration: "30d", "12h", "5m", "10s", "750ms" -> milliseconds.
//     Bare integers (no suffix) are rejected to avoid ambiguity.
//
//   * Cutoff: either an ISO-8601 date/time, or a duration interpreted as
//     "now minus this duration". Returns a Date.
//
// These are deliberately strict — `prune --older-than` and `sync --interval`
// take user input, and a permissive parser would silently let bad strings
// behave in surprising ways.

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i;

export class DurationParseError extends Error {
  constructor(input: string) {
    super(`Invalid duration: "${input}". Expected forms like "30d", "12h", "5m", "10s", "750ms".`);
    this.name = "DurationParseError";
  }
}

export class CutoffParseError extends Error {
  constructor(input: string) {
    super(
      `Invalid cutoff: "${input}". Expected an ISO-8601 date/time (e.g. "2025-01-15" or "2025-01-15T08:00:00Z") or a duration like "30d".`,
    );
    this.name = "CutoffParseError";
  }
}

export function parseDurationMs(input: string): number {
  const m = DURATION_RE.exec(input);
  if (!m) throw new DurationParseError(input);
  const value = Number.parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const factor = DURATION_UNITS[unit];
  if (factor === undefined) throw new DurationParseError(input);
  return Math.round(value * factor);
}

export function parseCutoff(input: string, now: Date = new Date()): Date {
  if (DURATION_RE.test(input)) {
    return new Date(now.getTime() - parseDurationMs(input));
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new CutoffParseError(input);
  return parsed;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms % 1_000 === 0 ? 0 : 1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(ms % 60_000 === 0 ? 0 : 1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)}h`;
  return `${(ms / 86_400_000).toFixed(ms % 86_400_000 === 0 ? 0 : 1)}d`;
}
