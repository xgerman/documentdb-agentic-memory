import { describe, it, expect } from "vitest";
import {
  DurationParseError,
  CutoffParseError,
  parseDurationMs,
  parseCutoff,
  formatDurationMs,
} from "../../src/shared/duration.js";

describe("parseDurationMs", () => {
  it("parses days", () => {
    expect(parseDurationMs("30d")).toBe(30 * 86_400_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("parses hours", () => {
    expect(parseDurationMs("12h")).toBe(12 * 3_600_000);
  });

  it("parses minutes", () => {
    expect(parseDurationMs("5m")).toBe(5 * 60_000);
  });

  it("parses seconds", () => {
    expect(parseDurationMs("10s")).toBe(10_000);
  });

  it("parses milliseconds", () => {
    expect(parseDurationMs("750ms")).toBe(750);
  });

  it("parses weeks (extra unit beyond the brief but supported by source)", () => {
    expect(parseDurationMs("2w")).toBe(2 * 7 * 86_400_000);
  });

  it("parses fractional values and rounds to nearest ms", () => {
    expect(parseDurationMs("1.5s")).toBe(1_500);
    // 0.0015s = 1.5ms which rounds to 2.
    expect(parseDurationMs("0.0015s")).toBe(2);
  });

  it("tolerates surrounding whitespace and case", () => {
    expect(parseDurationMs("  30D  ")).toBe(30 * 86_400_000);
    expect(parseDurationMs("5MS")).toBe(5);
  });

  it("throws DurationParseError for non-duration strings", () => {
    expect(() => parseDurationMs("invalid")).toThrow(DurationParseError);
    expect(() => parseDurationMs("")).toThrow(DurationParseError);
    expect(() => parseDurationMs("30")).toThrow(DurationParseError); // missing unit
    expect(() => parseDurationMs("d")).toThrow(DurationParseError); // missing value
    expect(() => parseDurationMs("-5s")).toThrow(DurationParseError); // negative not allowed
  });

  it('rejects the bare integer "0" — must include a unit suffix', () => {
    // The regex `/^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i` requires a unit
    // suffix, so "0" is invalid. The valid zero form is "0s" / "0ms" / etc.
    expect(() => parseDurationMs("0")).toThrow(DurationParseError);
    expect(parseDurationMs("0s")).toBe(0);
    expect(parseDurationMs("0ms")).toBe(0);
  });
});

describe("parseCutoff", () => {
  const now = new Date("2025-06-15T12:00:00Z");

  it("interprets durations as 'now minus this duration'", () => {
    const cutoff = parseCutoff("30d", now);
    expect(cutoff.getTime()).toBe(now.getTime() - 30 * 86_400_000);
  });

  it("parses ISO date strings", () => {
    const cutoff = parseCutoff("2024-01-15", now);
    expect(cutoff.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("parses ISO date-time strings with timezone", () => {
    const cutoff = parseCutoff("2024-01-15T08:00:00Z", now);
    expect(cutoff.toISOString()).toBe("2024-01-15T08:00:00.000Z");
  });

  it("uses current time as default when `now` is omitted", () => {
    const before = Date.now();
    const cutoff = parseCutoff("1s");
    const after = Date.now();
    // cutoff should be (some now between before/after) minus 1 second.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 1_000);
  });

  it("throws CutoffParseError on unparseable input", () => {
    expect(() => parseCutoff("nonsense")).toThrow(CutoffParseError);
    expect(() => parseCutoff("not-a-date")).toThrow(CutoffParseError);
  });
});

describe("formatDurationMs", () => {
  it("formats milliseconds", () => {
    expect(formatDurationMs(500)).toBe("500ms");
    expect(formatDurationMs(0)).toBe("0ms");
  });

  it("formats seconds, minutes, hours, days at clean boundaries", () => {
    expect(formatDurationMs(30_000)).toBe("30s");
    expect(formatDurationMs(5 * 60_000)).toBe("5m");
    expect(formatDurationMs(12 * 3_600_000)).toBe("12h");
    expect(formatDurationMs(86_400_000)).toBe("1d");
  });

  it("uses one decimal place for non-clean values", () => {
    expect(formatDurationMs(1_500)).toBe("1.5s");
    expect(formatDurationMs(90_000)).toBe("1.5m");
  });

  it("round-trips with parseDurationMs at clean boundaries", () => {
    for (const input of [500, 30_000, 5 * 60_000, 12 * 3_600_000, 86_400_000]) {
      const out = parseDurationMs(formatDurationMs(input));
      expect(out).toBe(input);
    }
  });

  it("round-trips with parseDurationMs for fractional clean values", () => {
    // 1.5s = 1500ms, 1.5d = 129600000ms — both expressible as a single
    // unit with one decimal place.
    expect(parseDurationMs(formatDurationMs(1_500))).toBe(1_500);
    expect(parseDurationMs(formatDurationMs(129_600_000))).toBe(129_600_000);
  });
});
