import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbedder } from "../../src/shared/embeddings/index.js";
import type { EmbeddingConfig } from "../../src/shared/config.js";

function baseConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "ollama",
    model: "nomic-embed-text",
    apiVersion: "2024-02-01",
    indexKind: "vector-ivf",
    similarity: "COS",
    numLists: 100,
    m: 16,
    efConstruction: 64,
    ...overrides,
  };
}

describe("createEmbedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when provider is none (no probe)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const e = await createEmbedder(baseConfig({ provider: "none" }));
    expect(e).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null (graceful) when the backend is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const e = await createEmbedder(baseConfig());
    expect(e).toBeNull();
  });

  it("returns null when openai provider lacks an API key", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const e = await createEmbedder(baseConfig({ provider: "openai", apiKey: undefined }));
    expect(e).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("probes and resolves dimensions from the observed vector length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3, 0.4]] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const e = await createEmbedder(baseConfig());
    expect(e).not.toBeNull();
    expect(e?.dimensions).toBe(4);
    expect(e?.provider).toBe("ollama");
  });
});
