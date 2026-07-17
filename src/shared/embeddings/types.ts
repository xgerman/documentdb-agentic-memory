// Embedder abstraction for DocumentDB Search.
//
// An `Embedder` turns text into dense vectors. Implementations are thin HTTP
// clients (Ollama / OpenAI / Azure OpenAI) so the project stays dependency-free
// — no native model runtime is bundled. The factory in `./index.ts` picks an
// implementation from `EmbeddingConfig` and health-checks it once; if the probe
// fails the whole feature degrades to text-only search rather than erroring.

export interface Embedder {
  // Provider identifier, for logs/diagnostics (e.g. "ollama", "openai").
  readonly provider: string;
  // Model name in use.
  readonly model: string;
  // Vector dimensionality. Known only after a successful `embed`/probe, so it
  // is resolved during factory construction and fixed thereafter.
  readonly dimensions: number;
  // Embed a batch of texts, returning one vector per input in the same order.
  embed(texts: string[]): Promise<number[][]>;
}

// Raised by an embedder when the backend is unreachable or returns an
// unexpected shape. The factory catches this during the startup probe and
// downgrades to text-only search.
export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}
