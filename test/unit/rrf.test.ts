import { describe, expect, it } from "vitest";
import { fuseRankings } from "../../src/storage/graph/store.js";

describe("fuseRankings (Reciprocal Rank Fusion)", () => {
  it("returns the single list unchanged when the other is empty", () => {
    expect(fuseRankings(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    expect(fuseRankings([], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("de-duplicates names appearing in both lists", () => {
    const fused = fuseRankings(["a", "b"], ["b", "c"]);
    expect([...fused].sort()).toEqual(["a", "b", "c"]);
    expect(new Set(fused).size).toBe(fused.length);
  });

  it("ranks a name appearing high in both lists above singletons", () => {
    // "shared" is rank 1 in listA and rank 0 in listB → highest fused score.
    const fused = fuseRankings(["onlyA", "shared"], ["shared", "onlyB"]);
    expect(fused[0]).toBe("shared");
  });

  it("preserves ordering when a list has a clear top hit", () => {
    // Both lists agree "a" is best.
    const fused = fuseRankings(["a", "b", "c"], ["a", "c", "b"]);
    expect(fused[0]).toBe("a");
  });

  it("breaks score ties by first appearance", () => {
    // Disjoint lists, same rank 0 → equal score; listA's element wins the tie.
    const fused = fuseRankings(["a"], ["b"]);
    expect(fused).toEqual(["a", "b"]);
  });
});
