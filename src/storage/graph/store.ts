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
import {
  ENTITIES_COLLECTION,
  RELATIONS_COLLECTION,
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
  private readonly entities: Collection<EntityDoc>;
  private readonly relations: Collection<RelationDoc>;

  constructor(db: Db) {
    this.entities = db.collection<EntityDoc>(ENTITIES_COLLECTION);
    this.relations = db.collection<RelationDoc>(RELATIONS_COLLECTION);
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
      .find({ _id: { $in: names } }, { projection: { _id: 1, observations: 1 } })
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
    // Uses the text index declared in `ensureGraphIndexes`. Returns matched
    // entities AND the relations whose endpoints are BOTH in the match set —
    // the same containment rule the official server applies.
    const matched = await this.entities.find({ $text: { $search: query } }).toArray();
    if (matched.length === 0) {
      return { entities: [], relations: [] };
    }
    const names = matched.map((d) => d._id);
    const relationDocs = await this.relations
      .find({ from: { $in: names }, to: { $in: names } })
      .toArray();
    return {
      entities: matched.map((d) => this.mapEntity(d)),
      relations: relationDocs.map((d) => mapRelation(d)),
    };
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

  // -- helpers ------------------------------------------------------------

  private mapEntity(doc: EntityDoc): Entity {
    return {
      name: doc._id,
      entityType: doc.entityType,
      observations: doc.observations.map((o) => o.text),
    };
  }
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
