import {
  MongoBulkWriteError,
  type AnyBulkWriteOperation,
  type Collection,
  type Db,
  type Filter,
  type IndexDescription,
  type UpdateFilter,
} from "mongodb";
import { registerIndexBootstrap } from "../../shared/mongo.js";
import type { EmbeddingConfig } from "../../shared/config.js";
import type { Embedder } from "../../shared/embeddings/index.js";
import type { Logger } from "../../shared/logging.js";
import {
  EMBEDDING_FIELD,
  ENTITIES_COLLECTION,
  RELATIONS_COLLECTION,
  VECTOR_INDEX_NAME,
  entityEmbeddingText,
  relationId,
  type Entity,
  type EntityDoc,
  type KnowledgeGraph,
  type ObservationDeletion,
  type ObservationInput,
  type ObservationResult,
  type Relation,
  type RelationDoc,
} from "./schema.js";

// MongoDB duplicate-key error code. We treat these as "another writer beat us
// to it" for the create-* paths, since the official `KnowledgeGraphManager`
// silently skips entities/relations that already exist.
const DUPLICATE_KEY_ERROR = 11000;

// Reciprocal Rank Fusion constant. Standard value from the original RRF paper;
// dampens the contribution of low-ranked results so top hits from either the
// vector or text list dominate the fused ordering.
const RRF_K = 60;

// How many nearest neighbours to request from the vector index in a hybrid
// search. Kept modest — text matches are unioned on top, and RRF re-ranks the
// combined set.
const DEFAULT_VECTOR_K = 20;

// Options controlling the optional DocumentDB Search (vector) behaviour. When
// `embedder` is absent the store behaves exactly as before: `$text`-only search
// and no `embedding` field written. This keeps the store a drop-in replacement
// for the official memory server when embeddings are not configured.
export interface GraphStoreOptions {
  embedder?: Embedder | null;
  embeddingConfig?: EmbeddingConfig;
  logger?: Logger;
}

// `KnowledgeGraphStore` is the storage-layer counterpart to the official
// `KnowledgeGraphManager`. Method names and semantics are kept identical so
// the MCP tool layer can map 1:1 onto it.
//
// Design notes:
//   * `_id` is the natural key (entity name / deterministic relation id), so
//     uniqueness and idempotency come "for free" from Mongo.
//   * Mutating methods prefer `bulkWrite` / `insertMany` over per-item loops
//     so a 1000-entity import is one round-trip, not 1000.
//   * Errors propagate. The only "expected" miss is `addObservations` against
//     a non-existent entity, which throws to match official semantics.
export class KnowledgeGraphStore {
  private readonly db: Db;
  private readonly entities: Collection<EntityDoc>;
  private readonly relations: Collection<RelationDoc>;
  private readonly embedder: Embedder | null;
  private readonly embeddingConfig: EmbeddingConfig | undefined;
  private readonly log: Logger | undefined;

  constructor(db: Db, options: GraphStoreOptions = {}) {
    this.db = db;
    this.entities = db.collection<EntityDoc>(ENTITIES_COLLECTION);
    this.relations = db.collection<RelationDoc>(RELATIONS_COLLECTION);
    this.embedder = options.embedder ?? null;
    this.embeddingConfig = options.embeddingConfig;
    this.log = options.logger;
  }

  // True when vector search is available. Exposed so callers (e.g. the doctor
  // command) can report whether DocumentDB Search is active.
  get vectorSearchEnabled(): boolean {
    return this.embedder !== null;
  }

  // -- create --------------------------------------------------------------

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    if (entities.length === 0) return [];

    // De-dupe by name within the input first — official server does the same.
    const seen = new Set<string>();
    const uniqueInputs: Entity[] = [];
    for (const e of entities) {
      if (!seen.has(e.name)) {
        seen.add(e.name);
        uniqueInputs.push(e);
      }
    }

    const names = uniqueInputs.map((e) => e.name);
    const existingDocs = await this.entities
      .find({ _id: { $in: names } }, { projection: { _id: 1 } })
      .toArray();
    const existing = new Set(existingDocs.map((d) => d._id));

    const toInsert = uniqueInputs.filter((e) => !existing.has(e.name));
    if (toInsert.length === 0) return [];

    const now = new Date();
    const docs: EntityDoc[] = toInsert.map((e) => ({
      _id: e.name,
      entityType: e.entityType,
      observations: e.observations.map((text) => ({ text, createdAt: now })),
      createdAt: now,
      updatedAt: now,
    }));

    // Best-effort embeddings: if an embedder is configured, embed each new
    // entity so it is immediately vector-searchable. Failures are swallowed —
    // the entity is still stored, just without a vector until the next
    // `reembed`, keeping writes resilient to a flaky embedding backend.
    await this.attachEmbeddings(
      docs,
      toInsert.map((e) => entityEmbeddingText(e)),
    );

    try {
      await this.entities.insertMany(docs, { ordered: false });
      return toInsert;
    } catch (err) {
      // Race: a concurrent writer inserted one of these names between our
      // find() and insertMany(). Treat duplicate-key as "already exists,
      // skip", but let any other error surface.
      const duplicates = collectDuplicateKeyIndices(err);
      if (duplicates === null) throw err;
      return toInsert.filter((_, i) => !duplicates.has(i));
    }
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    if (relations.length === 0) return [];

    // De-dupe by deterministic id within the input.
    const byId = new Map<string, Relation>();
    for (const r of relations) {
      byId.set(relationId(r.from, r.relationType, r.to), r);
    }
    const ids = [...byId.keys()];
    const inputs = [...byId.values()];

    const existingDocs = await this.relations
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    const existing = new Set(existingDocs.map((d) => d._id));

    const toInsert = inputs.filter((r) => !existing.has(relationId(r.from, r.relationType, r.to)));
    if (toInsert.length === 0) return [];

    const now = new Date();
    const docs: RelationDoc[] = toInsert.map((r) => ({
      _id: relationId(r.from, r.relationType, r.to),
      from: r.from,
      to: r.to,
      relationType: r.relationType,
      createdAt: now,
    }));

    try {
      await this.relations.insertMany(docs, { ordered: false });
      return toInsert;
    } catch (err) {
      const duplicates = collectDuplicateKeyIndices(err);
      if (duplicates === null) throw err;
      return toInsert.filter((_, i) => !duplicates.has(i));
    }
  }

  // -- observations --------------------------------------------------------

  async addObservations(observations: ObservationInput[]): Promise<ObservationResult[]> {
    if (observations.length === 0) return [];

    const names = observations.map((o) => o.entityName);
    const docs = await this.entities
      .find({ _id: { $in: names } }, { projection: { _id: 1, entityType: 1, observations: 1 } })
      .toArray();
    const byName = new Map<string, EntityDoc>(docs.map((d) => [d._id, d] as const));

    // Match official semantics: throw on the first missing entity rather than
    // partially applying. The official message is "Entity with name X not
    // found"; we use the shorter form the design doc specifies.
    for (const input of observations) {
      if (!byName.has(input.entityName)) {
        throw new Error(`Entity not found: ${input.entityName}`);
      }
    }

    const now = new Date();
    const results: ObservationResult[] = [];
    const ops: AnyBulkWriteOperation<EntityDoc>[] = [];
    // Entities whose observations changed, paired with the full text to embed.
    // Collected here so we can batch a single embed() call after the loop.
    const toEmbed: { name: string; text: string }[] = [];

    for (const input of observations) {
      const doc = byName.get(input.entityName);
      if (doc === undefined) continue; // unreachable; checked above
      const existingTexts = new Set(doc.observations.map((o) => o.text));

      // Preserve input order, drop within-batch dupes too.
      const newTexts: string[] = [];
      const seenInBatch = new Set<string>();
      for (const text of input.contents) {
        if (!existingTexts.has(text) && !seenInBatch.has(text)) {
          newTexts.push(text);
          seenInBatch.add(text);
        }
      }

      results.push({ entityName: input.entityName, addedObservations: newTexts });

      if (newTexts.length > 0) {
        const newObs = newTexts.map((text) => ({ text, createdAt: now }));
        const update: UpdateFilter<EntityDoc> = {
          $push: { observations: { $each: newObs } },
          $set: { updatedAt: now },
        };
        ops.push({
          updateOne: {
            filter: { _id: input.entityName },
            update,
          },
        });
        // The entity content changed, so its vector is now stale. Re-embed
        // from name + type + the full (existing + new) observation set.
        const allTexts = [...doc.observations.map((o) => o.text), ...newTexts];
        toEmbed.push({
          name: input.entityName,
          text: entityEmbeddingText({
            name: input.entityName,
            entityType: doc.entityType,
            observations: allTexts,
          }),
        });
      }
    }

    // Best-effort re-embed of the changed entities as a second set of update
    // ops. Failures are swallowed so the observation append still succeeds.
    if (this.embedder !== null && toEmbed.length > 0) {
      const vectors = await this.embedTexts(toEmbed.map((t) => t.text));
      if (vectors !== null) {
        for (let i = 0; i < toEmbed.length; i++) {
          const entry = toEmbed[i];
          const vec = vectors[i];
          if (entry === undefined || vec === undefined) continue;
          ops.push({
            updateOne: {
              filter: { _id: entry.name },
              update: {
                $set: {
                  embedding: vec,
                  embeddingModel: this.embedder.model,
                  embeddingText: entry.text,
                },
              },
            },
          });
        }
      }
    }

    if (ops.length > 0) {
      await this.entities.bulkWrite(ops, { ordered: false });
    }
    return results;
  }

  // -- delete --------------------------------------------------------------

  async deleteEntities(entityNames: string[]): Promise<void> {
    if (entityNames.length === 0) return;

    // Cascade: drop the entities and any incident relations in parallel.
    // `deleteMany` is silent when the filter matches nothing, which matches
    // the official server's "no-op on missing" behaviour.
    const relationFilter: Filter<RelationDoc> = {
      $or: [{ from: { $in: entityNames } }, { to: { $in: entityNames } }],
    };
    await Promise.all([
      this.entities.deleteMany({ _id: { $in: entityNames } }),
      this.relations.deleteMany(relationFilter),
    ]);
  }

  async deleteObservations(deletions: ObservationDeletion[]): Promise<void> {
    if (deletions.length === 0) return;

    const now = new Date();
    const ops: AnyBulkWriteOperation<EntityDoc>[] = deletions
      .filter((d) => d.observations.length > 0)
      .map((d) => {
        const update: UpdateFilter<EntityDoc> = {
          $pull: { observations: { text: { $in: d.observations } } },
          $set: { updatedAt: now },
        };
        return {
          updateOne: {
            filter: { _id: d.entityName },
            update,
          },
        };
      });

    if (ops.length === 0) return;
    // Missing entities / missing observation texts both result in zero
    // modifications, which is the silent-on-missing behaviour we want.
    await this.entities.bulkWrite(ops, { ordered: false });

    // Removing observations changes entity content, so refresh their vectors.
    // Best-effort: a failure here leaves a slightly stale vector, not an error.
    if (this.embedder !== null) {
      const names = deletions.filter((d) => d.observations.length > 0).map((d) => d.entityName);
      if (names.length > 0) {
        await this.reembed({ onlyStale: true, names });
      }
    }
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    if (relations.length === 0) return;
    const ids = relations.map((r) => relationId(r.from, r.relationType, r.to));
    await this.relations.deleteMany({ _id: { $in: ids } });
  }

  // -- read ---------------------------------------------------------------

  async readGraph(): Promise<KnowledgeGraph> {
    const [entityDocs, relationDocs] = await Promise.all([
      this.entities.find({}).toArray(),
      this.relations.find({}).toArray(),
    ]);
    return {
      entities: entityDocs.map((d) => this.mapEntity(d)),
      relations: relationDocs.map((d) => mapRelation(d)),
    };
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
    // Hybrid retrieval: combine keyword (`$text`) and, when an embedder is
    // configured, semantic (vector) results, fused with Reciprocal Rank
    // Fusion. When no embedder is present this collapses to the original
    // text-only behaviour, keeping the store wire-compatible with the official
    // memory server. In both cases we return matched entities AND the relations
    // whose endpoints are BOTH in the match set — the containment rule the
    // official server applies.
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { entities: [], relations: [] };
    }

    const [textIds, vectorHits] = await Promise.all([
      this.textSearchIds(trimmed),
      this.vectorSearchIds(trimmed, DEFAULT_VECTOR_K),
    ]);

    // Fuse the two ranked lists. `vectorHits === null` means vector search was
    // unavailable (no embedder or a runtime failure) — fall back to text order.
    const rankedNames =
      vectorHits === null
        ? textIds
        : fuseRankings(textIds, vectorHits.map((h) => h.id));

    if (rankedNames.length === 0) {
      return { entities: [], relations: [] };
    }

    const entityDocs = await this.entities.find({ _id: { $in: rankedNames } }).toArray();
    // Reorder the fetched docs to match the fused ranking (find() does not
    // preserve `$in` order).
    const byId = new Map(entityDocs.map((d) => [d._id, d] as const));
    const orderedEntities = rankedNames
      .map((name) => byId.get(name))
      .filter((d): d is EntityDoc => d !== undefined);

    const relationDocs = await this.relations
      .find({ from: { $in: rankedNames }, to: { $in: rankedNames } })
      .toArray();

    return {
      entities: orderedEntities.map((d) => this.mapEntity(d)),
      relations: relationDocs.map((d) => mapRelation(d)),
    };
  }

  // Keyword search via the `$text` index, returned as entity names ranked by
  // text score (best first).
  private async textSearchIds(query: string): Promise<string[]> {
    const docs = await this.entities
      .aggregate<{ _id: string }>([
        { $match: { $text: { $search: query } } },
        { $addFields: { __score: { $meta: "textScore" } } },
        { $sort: { __score: -1 } },
        { $project: { _id: 1 } },
      ])
      .toArray();
    return docs.map((d) => d._id);
  }

  // Semantic search via the DocumentDB vector index (`cosmosSearch`). Returns
  // null — never throws — when embeddings are disabled or the query embedding /
  // vector query fails, so callers transparently fall back to text-only search.
  private async vectorSearchIds(
    query: string,
    k: number,
  ): Promise<{ id: string; score: number }[] | null> {
    if (this.embedder === null) return null;
    const vectors = await this.embedTexts([query]);
    const queryVector = vectors?.[0];
    if (queryVector === undefined) return null;

    try {
      const docs = await this.entities
        .aggregate<{ _id: string; __score: number }>([
          {
            $search: {
              cosmosSearch: { vector: queryVector, path: EMBEDDING_FIELD, k },
            },
          },
          { $project: { _id: 1, __score: { $meta: "searchScore" } } },
        ])
        .toArray();
      return docs.map((d) => ({ id: d._id, score: d.__score }));
    } catch (err) {
      this.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "vector search failed; falling back to text-only results",
      );
      return null;
    }
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }
    const [entityDocs, relationDocs] = await Promise.all([
      this.entities.find({ _id: { $in: names } }).toArray(),
      this.relations.find({ from: { $in: names }, to: { $in: names } }).toArray(),
    ]);
    // Silently skip unknown names: we only return what we found.
    return {
      entities: entityDocs.map((d) => this.mapEntity(d)),
      relations: relationDocs.map((d) => mapRelation(d)),
    };
  }

  // -- embeddings (DocumentDB Search) -------------------------------------

  // Embed a batch of texts, returning one vector per input, or null on any
  // failure / when no embedder is configured. Never throws: embeddings are a
  // best-effort enhancement, so the calling write/search path stays resilient.
  private async embedTexts(texts: string[]): Promise<number[][] | null> {
    if (this.embedder === null) return null;
    try {
      return await this.embedder.embed(texts);
    } catch (err) {
      this.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "embedding failed; entity stored without a vector",
      );
      return null;
    }
  }

  // Mutate the given docs in place, attaching `embedding`/`embeddingModel`/
  // `embeddingText` computed from the parallel `texts` array. No-op when
  // embeddings are unavailable.
  private async attachEmbeddings(docs: EntityDoc[], texts: string[]): Promise<void> {
    if (this.embedder === null || docs.length === 0) return;
    const vectors = await this.embedTexts(texts);
    if (vectors === null) return;
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const vec = vectors[i];
      const text = texts[i];
      if (doc === undefined || vec === undefined || text === undefined) continue;
      doc.embedding = vec;
      doc.embeddingModel = this.embedder.model;
      doc.embeddingText = text;
    }
  }

  // Re-embed entities, refreshing their stored vectors. When `onlyStale` is
  // true (default), entities whose `embeddingText` already matches the current
  // content AND were embedded by the current model are skipped. Returns the
  // number of entities scanned and (re)embedded. Used by the `graph reembed`
  // CLI command and after observation deletions.
  async reembed(
    options: { onlyStale?: boolean; names?: string[] } = {},
  ): Promise<{ scanned: number; embedded: number }> {
    if (this.embedder === null) return { scanned: 0, embedded: 0 };
    const onlyStale = options.onlyStale ?? true;
    const filter: Filter<EntityDoc> =
      options.names && options.names.length > 0 ? { _id: { $in: options.names } } : {};

    let scanned = 0;
    let embedded = 0;
    const batch: EntityDoc[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const texts = batch.map((d) =>
        entityEmbeddingText({
          name: d._id,
          entityType: d.entityType,
          observations: d.observations.map((o) => o.text),
        }),
      );
      const vectors = await this.embedTexts(texts);
      if (vectors !== null) {
        const ops: AnyBulkWriteOperation<EntityDoc>[] = [];
        for (let i = 0; i < batch.length; i++) {
          const doc = batch[i];
          const vec = vectors[i];
          const text = texts[i];
          if (doc === undefined || vec === undefined || text === undefined) continue;
          ops.push({
            updateOne: {
              filter: { _id: doc._id },
              update: {
                $set: {
                  embedding: vec,
                  embeddingModel: this.embedder!.model,
                  embeddingText: text,
                },
              },
            },
          });
        }
        if (ops.length > 0) {
          await this.entities.bulkWrite(ops, { ordered: false });
          embedded += ops.length;
        }
      }
      batch.length = 0;
    };

    const cursor = this.entities.find(filter);
    for await (const doc of cursor) {
      scanned++;
      if (onlyStale) {
        const text = entityEmbeddingText({
          name: doc._id,
          entityType: doc.entityType,
          observations: doc.observations.map((o) => o.text),
        });
        if (doc.embeddingModel === this.embedder.model && doc.embeddingText === text) {
          continue;
        }
      }
      batch.push(doc);
      if (batch.length >= 32) await flush();
    }
    await flush();
    return { scanned, embedded };
  }

  // Create the DocumentDB vector index on `graph_entities.embedding`. Requires
  // an embedder (for the resolved dimensionality). Safe to call repeatedly —
  // an existing equivalent index makes this a no-op. When embeddings are
  // disabled this returns false without touching the database.
  async ensureVectorIndex(): Promise<boolean> {
    if (this.embedder === null) return false;
    const cfg = this.embeddingConfig;
    const kind = cfg?.indexKind ?? "vector-ivf";
    const similarity = cfg?.similarity ?? "COS";
    const cosmosSearchOptions: Record<string, unknown> = {
      kind,
      similarity,
      dimensions: this.embedder.dimensions,
    };
    if (kind === "vector-ivf") {
      cosmosSearchOptions.numLists = cfg?.numLists ?? 100;
    } else {
      cosmosSearchOptions.m = cfg?.m ?? 16;
      cosmosSearchOptions.efConstruction = cfg?.efConstruction ?? 64;
    }

    try {
      await this.db.command({
        createIndexes: ENTITIES_COLLECTION,
        indexes: [
          {
            name: VECTOR_INDEX_NAME,
            key: { [EMBEDDING_FIELD]: "cosmosSearch" },
            cosmosSearchOptions,
          },
        ],
      });
      return true;
    } catch (err) {
      // An index already exists with different options (e.g. dimensions changed
      // after switching models). Surface a clear, actionable message.
      this.log?.warn(
        { err: err instanceof Error ? err.message : String(err), kind, similarity },
        "could not create vector index; DocumentDB Search may be unavailable until it is recreated",
      );
      return false;
    }
  }

  // -- helpers ------------------------------------------------------------

  private mapEntity(doc: EntityDoc): Entity {
    return {
      name: doc._id,
      entityType: doc.entityType,
      observations: doc.observations.map((o) => o.text),
    };
  }
}

// Reciprocal Rank Fusion of two ranked lists of entity names into a single
// ranked, de-duplicated list. Each list contributes 1/(RRF_K + rank) to a
// name's score; names appearing high in both lists rank best. Order within the
// output is by descending fused score, ties broken by first appearance.
// Exported for unit testing — it is a pure function with no I/O.
export function fuseRankings(listA: string[], listB: string[]): string[] {
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  const add = (list: string[]): void => {
    for (let rank = 0; rank < list.length; rank++) {
      const name = list[rank];
      if (name === undefined) continue;
      score.set(name, (score.get(name) ?? 0) + 1 / (RRF_K + rank));
      if (!firstSeen.has(name)) firstSeen.set(name, order++);
    }
  };
  add(listA);
  add(listB);
  return [...score.keys()].sort((a, b) => {
    const diff = (score.get(b) ?? 0) - (score.get(a) ?? 0);
    if (diff !== 0) return diff;
    return (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
  });
}

function mapRelation(doc: RelationDoc): Relation {
  return {
    from: doc.from,
    to: doc.to,
    relationType: doc.relationType,
  };
}

// Extract the indices of duplicate-key write errors from a possible
// `MongoBulkWriteError`. Returns null if the error is something else (caller
// should re-throw) or if there are any non-duplicate write errors mixed in.
function collectDuplicateKeyIndices(err: unknown): Set<number> | null {
  if (!(err instanceof MongoBulkWriteError)) return null;
  // `writeErrors` is typed `OneOrMore<WriteError>` (single value OR array)
  // by the driver — normalise to an array before iterating.
  const raw = err.writeErrors ?? [];
  const writeErrors = Array.isArray(raw) ? raw : [raw];
  // No per-op errors means the bulk failure was something else entirely
  // (write-concern, network, …) — be conservative and re-throw.
  if (writeErrors.length === 0) return null;
  const dupes = new Set<number>();
  for (const w of writeErrors) {
    if (w.code !== DUPLICATE_KEY_ERROR) return null;
    dupes.add(w.index);
  }
  return dupes;
}

// `ensureGraphIndexes` is idempotent — Mongo's `createIndexes` is a no-op for
// indexes that already match. It's registered with the shared bootstrap
// registry at module load so any process that imports the store gets the
// indexes set up on first `runIndexBootstrap()`.
export async function ensureGraphIndexes(db: Db): Promise<void> {
  const entityIndexes: IndexDescription[] = [
    { key: { entityType: 1 }, name: "graph_entities_entityType" },
    { key: { updatedAt: 1 }, name: "graph_entities_updatedAt" },
    {
      // Text index powers `searchNodes`. `_id` is included so name matches
      // surface even when an entity has no observations yet.
      key: { _id: "text", entityType: "text", "observations.text": "text" },
      name: "graph_entities_text",
    },
  ];
  const relationIndexes: IndexDescription[] = [
    { key: { from: 1 }, name: "graph_relations_from" },
    { key: { to: 1 }, name: "graph_relations_to" },
    { key: { relationType: 1 }, name: "graph_relations_relationType" },
    { key: { createdAt: 1 }, name: "graph_relations_createdAt" },
  ];

  await Promise.all([
    db.collection(ENTITIES_COLLECTION).createIndexes(entityIndexes),
    db.collection(RELATIONS_COLLECTION).createIndexes(relationIndexes),
  ]);
}

registerIndexBootstrap(ensureGraphIndexes);
