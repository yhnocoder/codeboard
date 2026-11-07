import { describe, expect, it } from "vitest";
import { Box, endpointEmbedder, queryText, type Doc, type Embedder } from "../src/index";
import { pieceBodies, pieces } from "../src/text";

/** A stand-in model: a vector of word counts over a small vocabulary, so "kv cache" lands near pieces that say kv cache */
const VOCAB = ["kv", "cache", "block", "scheduler", "prefill", "decode", "graph", "cuda", "attention", "sampler"];
function fake(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    model: async () => "fake",
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => {
        const body = t.replace(/^task: search result \| query: |^title: .*? \| text: /, "").toLowerCase();
        const v = Float32Array.from(VOCAB, (w) => body.split(/\W+/).filter((x) => x === w).length + 0.01);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
  };
}
const q = async (e: Embedder, s: string) => (await e.embed([queryText(s)]))[0];

const DOCS: Doc[] = [
  { id: "a", title: "Block manager", text: "Allocates kv cache blocks. Frees a block when a sequence ends." },
  { id: "b", title: "Scheduler", text: "The scheduler picks prefill or decode for each step." },
  { id: "c", title: "Model runner", text: "Captures a CUDA graph for decode. Runs attention." },
];

describe("innerbox", () => {
  it("finds a document by its best piece", async () => {
    const e = fake(),
      box = new Box("fake");
    await box.update(DOCS, e);
    expect(box.search(await q(e, "kv cache"), 3)[0].id).toBe("a");
    expect(box.search(await q(e, "cuda graph"), 3)[0].id).toBe("c");
  });

  it("says which piece matched, for the preview", async () => {
    const e = fake(),
      box = new Box("fake");
    const long = {
      id: "l",
      title: "Long",
      text: `${"The scheduler decides. ".repeat(20)}Then a cuda graph is replayed.`,
    };
    await box.update([long], e);
    const [hit] = box.search(await q(e, "cuda graph"), 1);
    expect(pieceBodies(long)[hit.piece]).toContain("cuda graph");
    expect(hit.piece).toBeGreaterThan(0);
  });

  it("embeds only text it has not seen, and forgets documents that are gone", async () => {
    const e = fake(),
      box = new Box("fake");
    await box.update(DOCS, e);
    const first = e.calls.flat().length;
    await box.update([...DOCS.slice(0, 2), { ...DOCS[2], text: `${DOCS[2].text} Uses the sampler.` }], e);
    expect(e.calls.flat().length - first).toBeLessThanOrEqual(pieces(DOCS[2]).length + 1);
    await box.update(DOCS.slice(0, 1), e);
    expect(box.size).toBe(1);
  });

  it("stops between requests and carries on later", async () => {
    const e = fake(),
      box = new Box("fake");
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, title: `Doc ${i}`, text: `block ${i}` }));
    await box.update(many, e, () => e.calls.length >= 1);
    expect(box.size).toBeGreaterThan(0);
    expect(box.missing(many)).toBeGreaterThan(0);
    await box.update(many, e);
    expect(box.missing(many)).toBe(0);
    expect(box.size).toBe(40);
  });

  it("reads back what it wrote, and only for the same model", async () => {
    const e = fake(),
      box = new Box("fake");
    await box.update(DOCS, e);
    const back = Box.fromBytes(box.toBytes(), "fake")!;
    expect(back.size).toBe(3);
    expect(back.search(await q(e, "scheduler prefill"), 1)[0].id).toBe("b");
    expect(Box.fromBytes(box.toBytes(), "other")).toBeUndefined();
    expect(Box.fromBytes(new Uint8Array([1, 2, 3]), "fake")).toBeUndefined();
  });

  it("keeps long documents to a bounded number of pieces, each with its title", () => {
    const ps = pieces({ id: "x", title: "Long", ctx: "Board", text: "A sentence here. ".repeat(2000) });
    expect(ps.length).toBeLessThanOrEqual(24);
    expect(ps.every((p) => p.startsWith("title: Board › Long | text: "))).toBe(true);
    expect(pieces({ id: "y", title: "Only a title", text: "" })).toEqual(["title: Only a title | text: Only a title"]);
  });

  it("talks to an OpenAI-compatible endpoint, picking its embedding model", async () => {
    const seen: string[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url} ${(init?.headers as Record<string, string>).authorization ?? ""}`);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen-chat" }, { id: "embeddinggemma-2" }] });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("embeddinggemma-2");
      return Response.json({
        data: (body.input as string[]).map((_, i) => ({ index: i, embedding: [3, 4] })).reverse(),
      });
    }) as typeof fetch;
    const e = endpointEmbedder({ base: "http://127.0.0.1:11001/v1/", key: "k", fetch: fetchStub });
    const vs = await e.embed(["a", "b"]);
    expect(Array.from(vs[0])).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect(seen).toEqual([
      "GET http://127.0.0.1:11001/v1/models Bearer k",
      "POST http://127.0.0.1:11001/v1/embeddings Bearer k",
    ]);
  });
});
