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
