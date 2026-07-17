// Schema and shared types for the knowledge-graph storage.
//
// Two collections back the graph:
//   * `graph_entities` — one document per entity. `_id` is the entity name,
//     which gives us an implicit uniqueness constraint AND makes FUSE
//     filenames human-readable (`graph_entities/John_Smith.json`).
//   * `graph_relations` — one document per relation. `_id` is the deterministic
//     string `${from}__${relationType}__${to}`, which enforces uniqueness on
//     the natural composite key without a separate compound index.
//
// The public-API shapes (`Entity`, `Relation`, `KnowledgeGraph`, …) mirror
// the official MCP `@modelcontextprotocol/server-memory` server so that
// existing prompts and clients keep working unmodified.

export const ENTITIES_COLLECTION = "graph_entities";
export const RELATIONS_COLLECTION = "graph_relations";

export interface EntityObservation {
  text: string;
  createdAt: Date;
}

export interface EntityDoc {
  _id: string;
  entityType: string;
  observations: EntityObservation[];
  createdAt: Date;
  updatedAt: Date;
  // DocumentDB Search fields (optional; present only when an embedder is
  // configured). `embedding` is the dense vector indexed for vector search;
  // `embeddingModel` records which model produced it (so a model change can be
  // detected and re-embedded); `embeddingText` is the exact text that was
  // embedded, used to skip re-embedding when nothing relevant changed.
  embedding?: number[];
  embeddingModel?: string;
  embeddingText?: string;
}

export interface RelationDoc {
  _id: string;
  from: string;
  to: string;
  relationType: string;
  createdAt: Date;
}

// Public-API shapes (wire-compatible with the official memory server).

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

export interface ObservationInput {
  entityName: string;
  contents: string[];
}

export interface ObservationResult {
  entityName: string;
  addedObservations: string[];
}

export interface ObservationDeletion {
  entityName: string;
  observations: string[];
}

// Deterministic relation `_id` builder. The double-underscore separator keeps
// the parts visually distinct in FUSE listings (`John_Smith__works_at__Acme`)
// and is unlikely to collide with names containing single underscores.
export function relationId(from: string, relationType: string, to: string): string {
  return `${from}__${relationType}__${to}`;
}

// Name of the DocumentDB vector index on `graph_entities.embedding`. The wire
// token for the index type is `cosmosSearch`; this project refers to the
// feature as "DocumentDB Search" everywhere else.
export const VECTOR_INDEX_NAME = "graph_entities_embedding";
export const EMBEDDING_FIELD = "embedding";

// Canonical text an entity is embedded from. Combines the name, type, and all
// observations so vector search matches on any of them — mirroring the fields
// the `$text` index already covers. Keeping this in one place guarantees the
// write path and the `reembed` CLI produce identical vectors.
export function entityEmbeddingText(entity: {
  name: string;
  entityType: string;
  observations: string[];
}): string {
  return [entity.name, entity.entityType, ...entity.observations]
    .filter((s) => s.length > 0)
    .join("\n");
}
