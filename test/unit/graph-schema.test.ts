import { describe, expect, it } from "vitest";
import {
  ENTITIES_COLLECTION,
  RELATIONS_COLLECTION,
  relationId,
} from "../../src/storage/graph/schema.js";

describe("graph schema constants", () => {
  it("uses the documented collection names", () => {
    expect(ENTITIES_COLLECTION).toBe("graph_entities");
    expect(RELATIONS_COLLECTION).toBe("graph_relations");
  });
});

describe("relationId", () => {
  it("joins parts with the documented `__` separator", () => {
    expect(relationId("Alice", "knows", "Bob")).toBe("Alice__knows__Bob");
  });

  it("preserves spacing and case as-is", () => {
    expect(relationId("John Smith", "works_at", "Acme")).toBe("John Smith__works_at__Acme");
  });

  it("collides when an input already contains the `__` separator", () => {
    // The current implementation does not escape or validate inputs: any name
    // containing `__` can produce the same composite id as a different (from,
    // type, to) triple. We document the limitation here rather than fix it.
    // See: src/storage/graph/schema.ts — `relationId`.
    const a = relationId("foo__bar", "rel", "baz");
    const b = relationId("foo", "bar__rel", "baz");
    expect(a).toBe(b);
    expect(a).toBe("foo__bar__rel__baz");
  });
});
