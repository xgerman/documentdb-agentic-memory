import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeGraphStore, ensureGraphIndexes } from "../../src/storage/graph/store.js";
import { ENTITIES_COLLECTION, RELATIONS_COLLECTION } from "../../src/storage/graph/schema.js";
import { closeTestClient, getTestDb, type TestDbHandle } from "../setup.js";

describe("KnowledgeGraphStore", () => {
  let handle: TestDbHandle;
  let store: KnowledgeGraphStore;

  beforeAll(async () => {
    handle = await getTestDb("graph_store_tests");
    await ensureGraphIndexes(handle.db);
    store = new KnowledgeGraphStore(handle.db);
  });

  afterAll(async () => {
    await closeTestClient(handle);
  });

  beforeEach(async () => {
    // Wipe BOTH collections between tests but keep the indexes (drop just the
    // documents, not the collection — dropping the collection would also
    // drop the text index we just bootstrapped).
    await handle.db.collection(ENTITIES_COLLECTION).deleteMany({});
    await handle.db.collection(RELATIONS_COLLECTION).deleteMany({});
  });

  // -- createEntities ------------------------------------------------------

  describe("createEntities", () => {
    it("inserts and returns the newly-created entities", async () => {
      const created = await store.createEntities([
        { name: "Alice", entityType: "person", observations: ["likes tea"] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);
      expect(created.map((e) => e.name).sort()).toEqual(["Alice", "Bob"]);

      const graph = await store.readGraph();
      expect(graph.entities.map((e) => e.name).sort()).toEqual(["Alice", "Bob"]);
    });

    it("filters duplicate names within a single call", async () => {
      const created = await store.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Alice", entityType: "person", observations: ["dup"] },
      ]);
      expect(created.map((e) => e.name)).toEqual(["Alice"]);
    });

    it("is idempotent across two calls (returns empty the second time)", async () => {
      await store.createEntities([{ name: "Alice", entityType: "person", observations: ["one"] }]);
      const second = await store.createEntities([
        { name: "Alice", entityType: "person", observations: ["two"] },
      ]);
      expect(second).toEqual([]);
      // Existing observations untouched.
      const graph = await store.readGraph();
      const alice = graph.entities.find((e) => e.name === "Alice");
      expect(alice?.observations).toEqual(["one"]);
    });

    it("handles concurrent inserts of the same entity (duplicate-key race)", async () => {
      const input = [{ name: "Charlie", entityType: "person", observations: [] }];
      const [a, b] = await Promise.all([store.createEntities(input), store.createEntities(input)]);
      // Both calls resolve without throwing. One returns the create, the other
      // either returns the create (rare ordering) or an empty array — but the
      // total winning inserts across the two calls is at most one.
      const totalCreated = a.length + b.length;
      expect(totalCreated).toBeLessThanOrEqual(1);
      const graph = await store.readGraph();
      expect(graph.entities.filter((e) => e.name === "Charlie")).toHaveLength(1);
    });

    it("returns [] when given an empty input", async () => {
      const out = await store.createEntities([]);
      expect(out).toEqual([]);
    });
  });

  // -- addObservations / deleteObservations ---------------------------------

  describe("addObservations", () => {
    beforeEach(async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: ["existing"] },
      ]);
    });

    it("appends new observations and reports them", async () => {
      const res = await store.addObservations([
        { entityName: "Alice", contents: ["fresh-1", "fresh-2"] },
      ]);
      expect(res).toEqual([{ entityName: "Alice", addedObservations: ["fresh-1", "fresh-2"] }]);
      const graph = await store.readGraph();
      expect(graph.entities[0]?.observations).toEqual(["existing", "fresh-1", "fresh-2"]);
    });

    it("is idempotent: identical observations report empty addedObservations", async () => {
      await store.addObservations([{ entityName: "Alice", contents: ["fresh-1"] }]);
      const res = await store.addObservations([
        { entityName: "Alice", contents: ["fresh-1", "fresh-1", "existing"] },
      ]);
      expect(res).toEqual([{ entityName: "Alice", addedObservations: [] }]);

      const graph = await store.readGraph();
      // Still: existing + the one fresh-1. No duplicates.
      expect(graph.entities[0]?.observations).toEqual(["existing", "fresh-1"]);
    });

    it("throws when an entity does not exist", async () => {
      await expect(
        store.addObservations([{ entityName: "Nope", contents: ["x"] }]),
      ).rejects.toThrow(/Entity not found/);
    });
  });

  describe("deleteObservations", () => {
    it("removes the named observations", async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: ["a", "b", "c"] },
      ]);
      await store.deleteObservations([{ entityName: "Alice", observations: ["b"] }]);
      const graph = await store.readGraph();
      expect(graph.entities[0]?.observations).toEqual(["a", "c"]);
    });

    it("is silent when the entity or observation is missing", async () => {
      await store.createEntities([{ name: "Alice", entityType: "person", observations: ["a"] }]);
      await store.deleteObservations([
        { entityName: "Alice", observations: ["never-was"] },
        { entityName: "Ghost", observations: ["x"] },
      ]);
      const graph = await store.readGraph();
      expect(graph.entities[0]?.observations).toEqual(["a"]);
    });
  });

  // -- createRelations / deleteRelations ------------------------------------

  describe("createRelations", () => {
    beforeEach(async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
        { name: "Carol", entityType: "person", observations: [] },
      ]);
    });

    it("inserts and de-dupes by (from, type, to)", async () => {
      const created = await store.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Alice", to: "Bob", relationType: "knows" }, // dup
        { from: "Alice", to: "Carol", relationType: "knows" },
      ]);
      expect(created).toHaveLength(2);
      const graph = await store.readGraph();
      expect(graph.relations).toHaveLength(2);
    });

    it("is idempotent on re-creation", async () => {
      await store.createRelations([{ from: "Alice", to: "Bob", relationType: "knows" }]);
      const second = await store.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
      ]);
      expect(second).toEqual([]);
    });
  });

  describe("deleteEntities cascade", () => {
    it("removes relations pointing at the deleted entity (from and to)", async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
        { name: "Carol", entityType: "person", observations: [] },
      ]);
      await store.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Carol", to: "Bob", relationType: "knows" },
        { from: "Alice", to: "Carol", relationType: "knows" },
      ]);

      await store.deleteEntities(["Bob"]);

      const graph = await store.readGraph();
      expect(graph.entities.map((e) => e.name).sort()).toEqual(["Alice", "Carol"]);
      // Both relations touching Bob (as `from` or `to`) are gone.
      expect(graph.relations).toEqual([{ from: "Alice", to: "Carol", relationType: "knows" }]);
    });

    it("is a no-op when the entity does not exist", async () => {
      await expect(store.deleteEntities(["Ghost"])).resolves.toBeUndefined();
    });
  });

  // -- read paths ----------------------------------------------------------

  describe("searchNodes", () => {
    beforeEach(async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: ["loves tea"] },
        { name: "Bob", entityType: "person", observations: ["loves coffee"] },
        { name: "WidgetCo", entityType: "company", observations: ["makes widgets"] },
      ]);
      await store.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Alice", to: "WidgetCo", relationType: "works_at" },
      ]);
    });

    it("matches an entity name (Mongo $text is case-insensitive by default)", async () => {
      const graph = await store.searchNodes("alice");
      expect(graph.entities.map((e) => e.name)).toContain("Alice");
    });

    it("matches against observation text", async () => {
      const graph = await store.searchNodes("widgets");
      expect(graph.entities.map((e) => e.name)).toContain("WidgetCo");
    });

    it("only returns relations whose endpoints are BOTH in the match set", async () => {
      // "alice" alone matches only Alice (Bob, WidgetCo don't tokenize to it),
      // so no relation has both endpoints inside the match set.
      const graph = await store.searchNodes("alice");
      expect(graph.entities.map((e) => e.name)).toEqual(["Alice"]);
      expect(graph.relations).toHaveLength(0);

      // Combine two tokens — both endpoints in scope means the relation comes
      // along.
      const both = await store.searchNodes("alice bob");
      const names = both.entities.map((e) => e.name).sort();
      expect(names).toEqual(["Alice", "Bob"]);
      expect(both.relations).toEqual([{ from: "Alice", to: "Bob", relationType: "knows" }]);
    });

    it("returns an empty graph when nothing matches", async () => {
      const graph = await store.searchNodes("zzz-no-such-token");
      expect(graph.entities).toEqual([]);
      expect(graph.relations).toEqual([]);
    });
  });

  describe("openNodes", () => {
    beforeEach(async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
        { name: "Carol", entityType: "person", observations: [] },
      ]);
      await store.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Alice", to: "Carol", relationType: "knows" },
      ]);
    });

    it("returns only the requested entities and the relations BETWEEN them", async () => {
      const graph = await store.openNodes(["Alice", "Bob"]);
      expect(graph.entities.map((e) => e.name).sort()).toEqual(["Alice", "Bob"]);
      // Carol is excluded so Alice->Carol is also excluded; only Alice->Bob remains.
      expect(graph.relations).toEqual([{ from: "Alice", to: "Bob", relationType: "knows" }]);
    });

    it("silently skips names that don't exist", async () => {
      const graph = await store.openNodes(["Alice", "Ghost"]);
      expect(graph.entities.map((e) => e.name)).toEqual(["Alice"]);
    });

    it("returns an empty graph for an empty input", async () => {
      const graph = await store.openNodes([]);
      expect(graph).toEqual({ entities: [], relations: [] });
    });
  });

  describe("readGraph", () => {
    it("returns all entities and relations in the DB", async () => {
      await store.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);
      await store.createRelations([{ from: "Alice", to: "Bob", relationType: "knows" }]);

      const graph = await store.readGraph();
      expect(graph.entities.map((e) => e.name).sort()).toEqual(["Alice", "Bob"]);
      expect(graph.relations).toEqual([{ from: "Alice", to: "Bob", relationType: "knows" }]);
    });
  });
});
