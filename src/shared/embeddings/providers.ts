// HTTP-based embedder implementations.
//
// Each class talks to one embedding backend over `fetch` (global since
// Node 18). None of them hold the vector dimensionality up front — the factory
// probes with a short string and reads the observed length. Any network or
// shape error becomes an `EmbeddingError` so the factory can downgrade cleanly.

import { EmbeddingError, type Embedder } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

// -- shared fetch helper ----------------------------------------------------

interface PostJsonArgs {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  provider: string;
}

async function postJson<T>({ url, headers, body, provider }: PostJsonArgs): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EmbeddingError(`${provider}: request to ${url} failed`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EmbeddingError(
      `${provider}: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new EmbeddingError(`${provider}: response was not valid JSON`, { cause: err });
  }
}

function assertVectors(vectors: unknown, provider: string, expected: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new EmbeddingError(
      `${provider}: expected ${expected} embedding vector(s), got ${
        Array.isArray(vectors) ? vectors.length : typeof vectors
      }`,
    );
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number")) {
      throw new EmbeddingError(`${provider}: embedding vector had an unexpected shape`);
    }
  }
  return vectors as number[][];
}

// -- Ollama (self-hosted / "local") -----------------------------------------
//
// POST {baseUrl}/api/embed  { model, input: string[] }  ->  { embeddings: number[][] }

export class OllamaEmbedder implements Embedder {
  readonly provider = "ollama";
  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly baseUrl: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await postJson<{ embeddings?: number[][] }>({
      url: `${this.baseUrl.replace(/\/$/, "")}/api/embed`,
      headers: {},
      body: { model: this.model, input: texts },
      provider: this.provider,
    });
    return assertVectors(data.embeddings, this.provider, texts.length);
  }
}

// -- OpenAI -----------------------------------------------------------------
//
// POST {baseUrl}/embeddings  { model, input: string[] }
//   -> { data: [{ index, embedding: number[] }, ...] }

interface OpenAIEmbeddingResponse {
  data?: { index: number; embedding: number[] }[];
}

function orderOpenAIVectors(
  data: OpenAIEmbeddingResponse["data"],
  provider: string,
  expected: number,
): number[][] {
  if (!Array.isArray(data)) {
    throw new EmbeddingError(`${provider}: response missing "data" array`);
  }
  const ordered = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return assertVectors(ordered, provider, expected);
}

export class OpenAIEmbedder implements Embedder {
  readonly provider = "openai";
  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await postJson<OpenAIEmbeddingResponse>({
      url: `${this.baseUrl.replace(/\/$/, "")}/embeddings`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: { model: this.model, input: texts },
      provider: this.provider,
    });
    return orderOpenAIVectors(data.data, this.provider, texts.length);
  }
}

// -- Azure OpenAI -----------------------------------------------------------
//
// POST {endpoint}/openai/deployments/{model}/embeddings?api-version=...
//   header: api-key: <key>
//   body:  { input: string[] }
//   -> { data: [{ index, embedding }] }  (same shape as OpenAI)

export class AzureOpenAIEmbedder implements Embedder {
  readonly provider = "azure-openai";
  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly apiVersion: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const base = this.endpoint.replace(/\/$/, "");
    const url = `${base}/openai/deployments/${encodeURIComponent(this.model)}/embeddings?api-version=${encodeURIComponent(this.apiVersion)}`;
    const data = await postJson<OpenAIEmbeddingResponse>({
      url,
      headers: { "api-key": this.apiKey },
      body: { input: texts },
      provider: this.provider,
    });
    return orderOpenAIVectors(data.data, this.provider, texts.length);
  }
}
