import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AzureOpenAIEmbedder,
  OllamaEmbedder,
  OpenAIEmbedder,
} from "../../src/shared/embeddings/providers.js";
import { EmbeddingError } from "../../src/shared/embeddings/types.js";

// Helper: stub the global fetch with a single JSON response.
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

describe("embedding providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("OllamaEmbedder", () => {
    it("returns the embeddings array from /api/embed", async () => {
      stubFetch(200, { embeddings: [[1, 2, 3]] });
      const e = new OllamaEmbedder("nomic-embed-text", 3, "http://localhost:11434");
      const vecs = await e.embed(["hello"]);
      expect(vecs).toEqual([[1, 2, 3]]);
    });

    it("returns [] for an empty input without calling fetch", async () => {
      const spy = vi.fn();
      vi.stubGlobal("fetch", spy);
      const e = new OllamaEmbedder("m", 3, "http://localhost:11434");
      expect(await e.embed([])).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it("throws EmbeddingError when the count does not match", async () => {
      stubFetch(200, { embeddings: [[1, 2, 3]] });
      const e = new OllamaEmbedder("m", 3, "http://localhost:11434");
      await expect(e.embed(["a", "b"])).rejects.toBeInstanceOf(EmbeddingError);
    });

    it("throws EmbeddingError on a non-2xx status", async () => {
      stubFetch(500, { error: "boom" });
      const e = new OllamaEmbedder("m", 3, "http://localhost:11434");
      await expect(e.embed(["a"])).rejects.toBeInstanceOf(EmbeddingError);
    });
  });

  describe("OpenAIEmbedder", () => {
    it("orders vectors by response index", async () => {
      stubFetch(200, {
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      });
      const e = new OpenAIEmbedder("text-embedding-3-small", 2, "https://api.openai.com/v1", "k");
      const vecs = await e.embed(["first", "second"]);
      expect(vecs).toEqual([
        [1, 1],
        [9, 9],
      ]);
    });
  });

  describe("AzureOpenAIEmbedder", () => {
    it("builds the deployment URL and parses OpenAI-shaped data", async () => {
      const fetchMock = vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.5, 0.5] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const e = new AzureOpenAIEmbedder(
        "my-deploy",
        2,
        "https://res.openai.azure.com",
        "secret",
        "2024-02-01",
      );
      const vecs = await e.embed(["x"]);
      expect(vecs).toEqual([[0.5, 0.5]]);
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain("/openai/deployments/my-deploy/embeddings");
      expect(calledUrl).toContain("api-version=2024-02-01");
    });
  });
});
