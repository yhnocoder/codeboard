import { describe, expect, it } from "vitest";
import { Box, endpointEmbedder, queryText, type Doc, type Embedder } from "../src/index";
import { pieceBodies, pieces } from "../src/text";

/** A stand-in model: a vector of word counts over a small vocabulary, so "kv cache" lands near pieces that say kv cache */
const VOCAB = ["kv", "cache", "block", "scheduler", "prefill", "decode", "graph", "cuda", "attention", "sampler"];
function fake(o: { pictures?: boolean; refuse?: string } = {}): Embedder & { calls: string[][]; pics: string[] } {
  const calls: string[][] = [];
  const pics: string[] = [];
  const vec = (body: string) => {
    const v = Float32Array.from(
      VOCAB,
      (w) =>
        body
          .toLowerCase()
          .split(/\W+/)
          .filter((x) => x === w).length + 0.01,
    );
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  return {
    calls,
    pics,
    model: async () => "fake",
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => vec(t.replace(/^task: search result \| query: |^title: .*? \| text: /, "")));
    },
    // a "picture" is a data: URL whose text is what it shows
    async embedImages(urls) {
      if (o.pictures === false) return undefined;
      pics.push(...urls);
      // refuse: a picture the server turns down (too big, say)
      return urls.map((u) => {
        const shows = decodeURIComponent(u.replace(/^data:,/, ""));
        return o.refuse && shows.includes(o.refuse) ? undefined : vec(shows);
      });
    },
  };
}
const picture = (key: string, shows: string) => ({ key, url: async () => `data:,${encodeURIComponent(shows)}` });
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
    await box.update(many, e, { stop: () => e.calls.length >= 1 });
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
    const ps = pieces({ id: "x", title: "Long", text: "A sentence here. ".repeat(2000) });
    expect(ps.length).toBeLessThanOrEqual(24);
    expect(ps.every((p) => p.startsWith("title: Long | text: "))).toBe(true);
    expect(pieces({ id: "y", title: "Only a title", text: "" })).toEqual(["title: Only a title | text: Only a title"]);
  });

  it("finds a document by a picture in it, embeds each picture once, and keeps the text when the model takes no pictures", async () => {
    const e = fake(),
      box = new Box("fake");
    const docs: Doc[] = [
      ...DOCS,
      { id: "img", title: "", text: "", images: [picture("p1", "a cuda graph replayed for decode")] },
      { id: "img2", title: "Same picture", text: "", images: [picture("p1", "a cuda graph replayed for decode")] },
    ];
    await box.update(docs, e);
    const hits = box.search(await q(e, "cuda graph decode"), 5);
    expect(hits.find((h) => h.id === "img")).toMatchObject({ picture: "p1", piece: -1 });
    expect(e.pics).toHaveLength(1);
    await box.update(docs, e);
    expect(e.pics).toHaveLength(1);
    expect(
      Box.fromBytes(box.toBytes(), "fake")!
        .search(await q(e, "cuda graph decode"), 5)
        .map((h) => h.id),
    ).toContain("img");

    const blind = fake({ pictures: false }),
      plain = new Box("fake");
    await plain.update(docs, blind);
    expect(plain.size).toBe(docs.length);
    expect(plain.search(await q(blind, "scheduler"), 1)[0]).toMatchObject({ id: "b", piece: 0 });
  });

  it("leaves out a picture the server turns down, and does not ask for it again", async () => {
    const e = fake({ refuse: "huge" }),
      box = new Box("fake");
    const docs: Doc[] = [
      ...DOCS,
      { id: "big", title: "Scan", text: "", images: [picture("p1", "a huge scheduler scan")] },
      { id: "ok", title: "Plot", text: "", images: [picture("p2", "a cuda graph replayed for decode")] },
    ];
    await box.update(docs, e);
    expect(box.missing(docs)).toBe(0);
    expect(box.search(await q(e, "cuda graph decode"), 8).find((h) => h.id === "ok")).toMatchObject({ picture: "p2" });
    expect(box.search(await q(e, "scheduler"), 8).find((h) => h.id === "big")?.picture).toBeUndefined();
    await box.update(docs, e);
    expect(e.pics).toHaveLength(2);
  });

  it("counts a text piece or a picture only from its own floor up", async () => {
    const e = fake(),
      box = new Box("fake");
    const docs: Doc[] = [
      { id: "img", title: "", text: "", images: [picture("p1", "a cuda graph replayed for decode")] },
      { id: "c", title: "Model runner", text: "Captures a CUDA graph for decode." },
    ];
    await box.update(docs, e);
    const v = await q(e, "cuda graph decode");
    const [pic] = box.search(v, 2).filter((h) => h.picture);
    // under its floor the picture does not count: the card is found by its text, if at all
    expect(box.search(v, 2, { picture: pic.score + 0.01 }).find((h) => h.id === "img")?.picture).toBeUndefined();
    expect(box.search(v, 2, { text: 2, picture: pic.score }).map((h) => h.id)).toEqual(["img"]);
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

describe("pictures through an endpoint", () => {
  /** refuse: pictures it answers 413 to whatever the shape */
  const server = (takes: "part" | "item" | "none", bodies: unknown[], refuse?: string) =>
    (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "embeddinggemma-2" }] });
      const body = JSON.parse(String(init?.body));
      bodies.push(body.input);
      const x = body.input[0];
      if (refuse && JSON.stringify(x).includes(refuse)) return new Response("Payload Too Large", { status: 413 });
      const ok =
        typeof x === "string" || (takes === "part" ? x.type === "image_url" : takes === "item" && "image" in x);
      if (!ok)
        return Response.json({ error: { message: "Unsupported embedding content part type: None" } }, { status: 400 });
      return Response.json({ data: (body.input as unknown[]).map((_, index) => ({ index, embedding: [1, 0] })) });
    }) as typeof fetch;
  const A = "data:image/png;base64,AA",
    B = "data:image/png;base64,BB";

  it("sends each as an image_url part (oMLX), or an {image} item (SGLang) when that is what the server takes", async () => {
    const parts: unknown[] = [];
    expect(
      await endpointEmbedder({ base: "http://x/v1", fetch: server("part", parts) }).embedImages!([A, B]),
    ).toHaveLength(2);
    expect(parts).toEqual([
      [{ type: "image_url", image_url: { url: A } }],
      [{ type: "image_url", image_url: { url: B } }],
    ]);
    const items: unknown[] = [];
    expect(
      await endpointEmbedder({ base: "http://x/v1", fetch: server("item", items) }).embedImages!([A, B]),
    ).toHaveLength(2);
    expect(items.slice(1)).toEqual([[{ image: A }], [{ image: B }]]);
  });

  it("stops sending pictures once the server turns down the first one and a small plain PNG in every shape", async () => {
    const bodies: unknown[] = [];
    const no = endpointEmbedder({ base: "http://x/v1", fetch: server("none", bodies) });
    expect(await no.embedImages!([A, B])).toBeUndefined();
    expect(await no.embedImages!(["data:image/png;base64,CC"])).toBeUndefined();
    expect(bodies).toHaveLength(4);
  });

  it("leaves out only the picture a server that takes pictures turns down", async () => {
    const bodies: unknown[] = [];
    const e = endpointEmbedder({ base: "http://x/v1", fetch: server("part", bodies, "BIG") });
    const big = "data:image/png;base64,BIG";
    expect((await e.embedImages!([big, A]))!.map((v) => !!v)).toEqual([false, true]);
    expect((await e.embedImages!([B, big]))!.map((v) => !!v)).toEqual([true, false]);
    // the first one found the shape (and the plain PNG said pictures are taken); after that each is sent once
    expect(bodies).toHaveLength(2 + 1 + 1 + 2);
  });
});
