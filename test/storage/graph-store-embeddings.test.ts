import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeGraphStore, ensureGraphIndexes } from "../../src/storage/graph/store.js";
import { ENTITIES_COLLECTION } from "../../src/storage/graph/schema.js";
import type { EntityDoc } from "../../src/storage/graph/schema.js";
import type { Embedder } from "../../src/shared/embeddings/index.js";
import type { EmbeddingConfig } from "../../src/shared/config.js";
import { closeTestClient, getTestDb, type TestDbHandle } from "../setup.js";

// Deterministic fake embedder: maps text length + a char sum to a fixed-length
// vector. No network. Records the batches it was asked to embed so tests can
// assert the write path calls it exactly when expected.
class FakeEmbedder implements Embedder {
  readonly provider = "fake";
  readonly model = "fake-model-v1";
  readonly dimensions = 4;
  readonly calls: string[][] = [];
  private failNext = false;

  failOnce(): void {
    this.failNext = true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated embedding failure");
    }
    this.calls.push(texts);
    return texts.map((t) => {
      const sum = [...t].reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return [t.length, sum % 97, (sum * 7) % 101, 1];
    });
  }
}

const EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: "ollama",
  model: "fake-model-v1",
  apiVersion: "2024-02-01",
  indexKind: "vector-ivf",
  similarity: "COS",
  numLists: 100,
  m: 16,
  efConstruction: 64,
};

describe("KnowledgeGraphStore — DocumentDB Search (embeddings)", () => {
  let handle: TestDbHandle;
  let embedder: FakeEmbedder;
  let store: KnowledgeGraphStore;

  beforeAll(async () => {
    handle = await getTestDb("graph_store_embeddings_tests");
    await ensureGraphIndexes(handle.db);
    embedder = new FakeEmbedder();
    store = new KnowledgeGraphStore(handle.db, { embedder, embeddingConfig: EMBEDDING_CONFIG });
  });

  afterAll(async () => {
    await closeTestClient(handle);
  });

  beforeEach(async () => {
    await handle.db.collection(ENTITIES_COLLECTION).deleteMany({});
    embedder.calls.length = 0;
  });

  const rawDoc = (name: string): Promise<EntityDoc | null> =>
    handle.db.collection<EntityDoc>(ENTITIES_COLLECTION).findOne({ _id: name });

  it("writes an embedding vector + metadata on createEntities", async () => {
    await store.createEntities([
      { name: "Alice", entityType: "person", observations: ["likes tea"] },
    ]);
    const doc = await rawDoc("Alice");
    expect(doc?.embedding).toHaveLength(4);
    expect(doc?.embeddingModel).toBe("fake-model-v1");
    expect(doc?.embeddingText).toContain("Alice");
    expect(doc?.embeddingText).toContain("likes tea");
    expect(embedder.calls).toHaveLength(1);
  });

  it("refreshes the embedding when addObservations changes content", async () => {
    await store.createEntities([{ name: "Bob", entityType: "person", observations: [] }]);
    const before = await rawDoc("Bob");
    await store.addObservations([{ entityName: "Bob", contents: ["now has a hobby"] }]);
    const after = await rawDoc("Bob");
    expect(after?.embeddingText).toContain("now has a hobby");
    expect(after?.embedding).not.toEqual(before?.embedding);
  });

  it("does not re-embed when addObservations adds nothing new", async () => {
    await store.createEntities([{ name: "Carol", entityType: "person", observations: ["x"] }]);
    embedder.calls.length = 0;
    await store.addObservations([{ entityName: "Carol", contents: ["x"] }]); // duplicate
    expect(embedder.calls).toHaveLength(0);
  });

  it("still stores the entity when the embedder throws (graceful)", async () => {
    embedder.failOnce();
    const created = await store.createEntities([
      { name: "Dave", entityType: "person", observations: ["resilient"] },
    ]);
    expect(created.map((e) => e.name)).toEqual(["Dave"]);
    const doc = await rawDoc("Dave");
    expect(doc).not.toBeNull();
    expect(doc?.embedding).toBeUndefined(); // no vector, but the entity exists
  });

  it("reembed backfills entities missing a vector and skips fresh ones", async () => {
    // Insert a doc directly (no embedding), plus one created normally.
    await handle.db.collection<EntityDoc>(ENTITIES_COLLECTION).insertOne({
      _id: "Legacy",
      entityType: "thing",
      observations: [{ text: "old", createdAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await store.createEntities([{ name: "Fresh", entityType: "thing", observations: ["new"] }]);
    embedder.calls.length = 0;

    const result = await store.reembed({ onlyStale: true });
    expect(result.scanned).toBe(2);
    expect(result.embedded).toBe(1); // only "Legacy" needed embedding

    const legacy = await rawDoc("Legacy");
    expect(legacy?.embedding).toHaveLength(4);
  });

  it("reembed({onlyStale:false}) re-embeds everything", async () => {
    await store.createEntities([{ name: "One", entityType: "t", observations: ["a"] }]);
    await store.createEntities([{ name: "Two", entityType: "t", observations: ["b"] }]);
    const result = await store.reembed({ onlyStale: false });
    expect(result.scanned).toBe(2);
    expect(result.embedded).toBe(2);
  });

  it("searchNodes falls back to text results when vector search is unavailable", async () => {
    // The in-memory Mongo has no cosmosSearch, so vectorSearchIds catches the
    // aggregation error and returns null — search must still return text hits.
    await store.createEntities([
      { name: "Kubernetes", entityType: "tech", observations: ["container orchestration"] },
      { name: "Postgres", entityType: "tech", observations: ["relational database"] },
    ]);
    const graph = await store.searchNodes("orchestration");
    expect(graph.entities.map((e) => e.name)).toContain("Kubernetes");
  });
});

describe("KnowledgeGraphStore — no embedder (text-only, drop-in)", () => {
  let handle: TestDbHandle;
  let store: KnowledgeGraphStore;

  beforeAll(async () => {
    handle = await getTestDb("graph_store_no_embedder_tests");
    await ensureGraphIndexes(handle.db);
    store = new KnowledgeGraphStore(handle.db);
  });

  afterAll(async () => {
    await closeTestClient(handle);
  });

  beforeEach(async () => {
    await handle.db.collection(ENTITIES_COLLECTION).deleteMany({});
  });

  it("reports vector search disabled", () => {
    expect(store.vectorSearchEnabled).toBe(false);
  });

  it("does not write any embedding field", async () => {
    await store.createEntities([{ name: "Zoe", entityType: "person", observations: ["hi"] }]);
    const doc = await handle.db
      .collection<EntityDoc>(ENTITIES_COLLECTION)
      .findOne({ _id: "Zoe" });
    expect(doc?.embedding).toBeUndefined();
    expect(doc?.embeddingModel).toBeUndefined();
  });

  it("reembed is a no-op returning zero counts", async () => {
    await store.createEntities([{ name: "Yan", entityType: "person", observations: [] }]);
    const result = await store.reembed();
    expect(result).toEqual({ scanned: 0, embedded: 0 });
  });

  it("searchNodes returns text matches", async () => {
    await store.createEntities([
      { name: "Redis", entityType: "tech", observations: ["in-memory cache"] },
    ]);
    const graph = await store.searchNodes("cache");
    expect(graph.entities.map((e) => e.name)).toContain("Redis");
  });
});
