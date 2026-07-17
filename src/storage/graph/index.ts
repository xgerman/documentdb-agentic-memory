// Public surface for the knowledge-graph storage layer.
// Importing this module also registers the index bootstrap as a side effect
// (via `./store.js` → `registerIndexBootstrap`).

export { KnowledgeGraphStore, ensureGraphIndexes, type GraphStoreOptions } from "./store.js";
export {
  ENTITIES_COLLECTION,
  RELATIONS_COLLECTION,
  VECTOR_INDEX_NAME,
  EMBEDDING_FIELD,
  entityEmbeddingText,
  relationId,
  type Entity,
  type EntityDoc,
  type EntityObservation,
  type KnowledgeGraph,
  type ObservationDeletion,
  type ObservationInput,
  type ObservationResult,
  type Relation,
  type RelationDoc,
} from "./schema.js";
