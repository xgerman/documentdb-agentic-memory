// Embedder factory for DocumentDB Search.
//
// `createEmbedder(config, log)` returns a ready, health-checked `Embedder`, or
// `null` when embeddings are disabled (`provider: "none"`) or the backend is
// unreachable. Returning `null` — never throwing — is deliberate: the graph
// store treats a missing embedder as "text-only search", so a misconfigured or
// offline embedding backend degrades gracefully instead of taking the whole
// MCP server down.

import type { EmbeddingConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { AzureOpenAIEmbedder, OllamaEmbedder, OpenAIEmbedder } from "./providers.js";
import { EmbeddingError, type Embedder } from "./types.js";

export type { Embedder } from "./types.js";
export { EmbeddingError } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1";
// Short, cheap string used to probe the backend and learn the vector length.
const PROBE_TEXT = "documentdb search probe";

// Build a concrete embedder for the given dimensions. Returns null (with a
// warning) when required credentials/endpoints are missing so the caller can
// fall back to text-only search.
function construct(config: EmbeddingConfig, dimensions: number, log?: Logger): Embedder | null {
  switch (config.provider) {
    case "local":
    case "ollama":
      return new OllamaEmbedder(config.model, dimensions, config.baseUrl ?? DEFAULT_OLLAMA_URL);
    case "openai": {
      if (config.apiKey === undefined) {
        log?.warn("embeddings: openai provider selected but MEMORY_EMBEDDING_API_KEY is unset");
        return null;
      }
      return new OpenAIEmbedder(
        config.model,
        dimensions,
        config.baseUrl ?? DEFAULT_OPENAI_URL,
        config.apiKey,
      );
    }
    case "azure-openai": {
      if (config.endpoint === undefined || config.apiKey === undefined) {
        log?.warn(
          "embeddings: azure-openai provider needs MEMORY_EMBEDDING_ENDPOINT and MEMORY_EMBEDDING_API_KEY",
        );
        return null;
      }
      return new AzureOpenAIEmbedder(
        config.model,
        dimensions,
        config.endpoint,
        config.apiKey,
        config.apiVersion,
      );
    }
    case "none":
      return null;
  }
}

export async function createEmbedder(
  config: EmbeddingConfig,
  log?: Logger,
): Promise<Embedder | null> {
  if (config.provider === "none") {
    log?.debug("embeddings: disabled (provider=none); using text-only search");
    return null;
  }

  // Provisional instance (embedding does not depend on `dimensions`) used only
  // to probe. We then rebuild with the resolved dimension count.
  const provisional = construct(config, config.dimensions ?? 0, log);
  if (provisional === null) return null;

  let probeVector: number[];
  try {
    const [vec] = await provisional.embed([PROBE_TEXT]);
    if (vec === undefined) throw new EmbeddingError(`${config.provider}: probe returned no vector`);
    probeVector = vec;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.warn(
      { err: message, provider: config.provider, model: config.model },
      "embeddings: provider unreachable; falling back to text-only search",
    );
    return null;
  }

  const observed = probeVector.length;
  if (config.dimensions !== undefined && config.dimensions !== observed) {
    log?.warn(
      { configured: config.dimensions, observed },
      "embeddings: MEMORY_EMBEDDING_DIMENSIONS does not match the model; using observed length",
    );
  }

  const embedder = construct(config, observed, log);
  if (embedder === null) return null;
  log?.info(
    { provider: embedder.provider, model: embedder.model, dimensions: embedder.dimensions },
    "embeddings: DocumentDB Search enabled",
  );
  return embedder;
}
