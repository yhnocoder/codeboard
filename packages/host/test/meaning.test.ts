// ⌘K's Related by Meaning against a stand-in embedding server and the real box binary (npm run build -w @codeboard/box): the
// project's cards and sidenotes are handed to box (each with the boards it is on) and Image cards with their picture, only
// changed text is embedded again, two hosts (two windows) on one storage folder share one service and one index, and ⌘K's
// This Board keeps both groups to the board asked from
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { binIn, connect } from "@codeboard/box";
import { emptyBoard, type Board } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { HostContext } from "../src/context";
import { search } from "../src/search";
import { nodeWorkspace } from "./node-workspace";

const BIN = binIn(path.resolve(__dirname, "../../box/bin"));
const built = fs.existsSync(BIN);
if (!built && process.env.CI) throw new Error(`no box binary at ${BIN}: npm run build -w @codeboard/box`);
if (!built)
  console.warn(
    `Related by Meaning tests skipped: no box binary at ${BIN} (npm run build -w @codeboard/box; needs Rust)`,
  );

const WORDS = ["kv", "cache", "scheduler", "prefill", "graph", "cuda", "显存"];
/** What the server was asked to embed, and with which key */
const asked: { texts: string[]; auth?: string }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "test-embed" }] }));
    const { input } = JSON.parse(body) as { input: (string | { image_url: { url: string } })[] };
    // a "picture" here is a file whose bytes are the words it shows
    const text = (x: (typeof input)[number]) =>
      typeof x === "string" ? x : Buffer.from(x.image_url.url.split(",")[1], "base64").toString("utf8");
    asked.push({ texts: input.map(text), auth: req.headers.authorization });
    const vec = (t: string) => WORDS.map((w) => t.split(w).length - 1 + 0.01);
    res.end(
      JSON.stringify({
        data: input.map((x, index) => ({ index, embedding: vec(text(x).replace(/^.*?\| (text|query): /, "")) })),
      }),
    );
  });
});

const W = nodeWorkspace();
let url = "";
W.settings = { ...W.settings, get: <T>(k: string) => (k === "codeboard.search.embeddingUrl" ? url : undefined) as T };
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-meaning-")));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codeboard-box-"));
const box = { bin: BIN, home };
const store = new Storage(nodeFs, { dir: () => dir });
/** The test's own look into the service: how far indexing is */
const probe = connect(box);
let cx: HostContext;

/** Until box has embedded everything it was handed (the storage folder is not in git: ref "_") */
const indexed = () =>
  vi.waitFor(
    async () => {
      const s = await probe.status(dir, "_");
      if (s.indexing || s.left) throw new Error(`indexing, ${s.left} left`);
      return s;
    },
    { timeout: 10000, interval: 20 },
  );

function note(b: Board, id: string, md: string, section?: string) {
  b.cards.push({ id, kind: "note", md, look: "note" });
  b.place[id] = { x: 0, y: b.cards.length * 200, w: 300, ...(section ? { section } : {}) };
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await W.secrets.set("codeboard.embeddingApiKey", "k1");
  const a = emptyBoard("a", "Engine");
  a.sections.push({ id: "s1", title: "Memory", x: 0, y: 0, w: 800, h: 800 });
  note(a, "n1", "## Block manager\nFrees kv cache blocks when a sequence ends.", "s1");
  note(a, "n2", "## Scheduler\nPicks prefill or decode.");
  a.sidenotes = [{ id: "sn1", at: { card: "n2" }, kind: "text", md: "The cuda graph is captured once." }];
  await store.save(a);
  await store.save({ ...emptyBoard("b", "Other"), cards: [], place: {} });
  cx = new HostContext(W, { box });
});
afterAll(async () => {
  cx?.dispose();
  const pid = await probe.pid().catch(() => 0);
  probe.close();
  if (pid) process.kill(pid);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!built)("Related by Meaning", () => {
  it("finds cards and sidenotes by meaning, with their board, and keeps the index out of the project", async () => {
    await cx.meaning.update(store);
    expect(await indexed()).toMatchObject({ items: 3, model: "test-embed" });
    const r = await cx.meaning.search(store, "kv cache", "a");
    expect(r.items[0]).toMatchObject({ kind: "card", card: "n1", board: "a", detail: "This board" });
    // for ⌘K's search traces: each row's score, best first, and the model the scores come from
    const scores = r.items.map((i) => (i.kind === "card" || i.kind === "sidenote" ? i.score : undefined));
    expect(scores.every((x) => typeof x === "number")).toBe(true);
    expect(scores).toEqual([...scores].sort((x, y) => y! - x!));
    expect(r.model).toBe("test-embed");
    const g = await cx.meaning.search(store, "cuda graph", "b");
    expect(g.items[0]).toMatchObject({ kind: "sidenote", sidenote: "sn1", card: "n2", detail: "Engine" });
    // each piece carries its card's own title, not where it sits; the key goes to the server
    expect(asked.flatMap((a) => a.texts)).toContain(
      "title: Block manager | text: ## Block manager\nFrees kv cache blocks when a sequence ends.",
    );
    expect(asked.every((a) => a.auth === "Bearer k1")).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => !f.endsWith(".json"))).toEqual([]);
    expect(fs.existsSync(path.join(home, "index.db"))).toBe(true);
  });

  it("embeds again only what changed, and a second window shares the service and its index", async () => {
    const b = (await store.load("a"))!;
    (b.cards[1] as { md: string }).md = "## Scheduler\nPicks prefill or decode. Keeps 显存 in check.";
    await store.save(b);
    const before = asked.length;
    cx.meaning.soon(store); // as startHost does on a change
    await cx.meaning.update(store);
    await indexed();
    const texts = asked.slice(before).flatMap((a) => a.texts);
    expect(texts).toEqual(["title: Scheduler | text: ## Scheduler\nPicks prefill or decode. Keeps 显存 in check."]);
    const other = new HostContext(W, { box });
    const start = asked.length;
    const r = await other.meaning.search(store, "显存", "a");
    expect(r.items[0]).toMatchObject({ card: "n2" });
    // nothing embedded again: only the query
    expect(asked.slice(start).flatMap((a) => a.texts)).toEqual(["task: search result | query: 显存"]);
    const pids = new Set(
      await Promise.all([probe.pid(), connect(box).pid(), connect(box).pid()].map((p) => p.catch(() => 0))),
    );
    expect(pids.size).toBe(1);
    other.dispose();
  });

  it("finds an Image card by its picture, read from assets/", async () => {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "f00d.png"), "a prefill scheduler diagram");
    const b = (await store.load("b"))!;
    b.cards.push({ id: "pic", kind: "image", src: "f00d.png" });
    b.place.pic = { x: 0, y: 0, w: 300 };
    await store.save(b);
    await cx.meaning.update(store);
    await indexed();
    const r = await cx.meaning.search(store, "prefill scheduler", "b");
    const pic = r.items.find((i) => i.kind === "card" && i.card === "pic");
    // its picture goes with it, for the row's thumbnail
    expect(pic?.kind === "card" && pic.preview?.picture).toBe("assets/f00d.png");
    expect(asked.flatMap((a) => a.texts)).toContain("a prefill scheduler diagram");
  });

  it("shows the picture in a long Note that matched, not its opening", async () => {
    const b = (await store.load("b"))!;
    const filler = Array.from({ length: 60 }, (_, i) => `Line ${i} about something else entirely.`).join("\n");
    b.cards.push({ id: "long", kind: "note", look: "note", md: `${filler}\n\n![](assets/f00d.png)\n\nThe end.` });
    b.place.long = { x: 400, y: 0, w: 300 };
    await store.save(b);
    await cx.meaning.update(store);
    await indexed();
    const r = await cx.meaning.search(store, "prefill scheduler", "b");
    const long = r.items.find((i) => i.kind === "card" && i.card === "long");
    expect(long?.kind === "card" && long.preview).toMatchObject({ picture: "assets/f00d.png" });
    expect(long?.kind === "card" && long.preview?.hit).toBeUndefined();
    expect(long?.kind === "card" && long.preview?.md).toContain("![](assets/f00d.png)");
  });

  it("finds an SVG by its words, and by the PNG an open board draws of it", async () => {
    fs.writeFileSync(
      path.join(dir, "assets", "beef.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="9">cuda graph &amp; kv</text><rect/></svg>',
    );
    const drawn: string[] = [];
    cx.meaning.drawWith(async (svg) => {
      drawn.push(svg);
      return `data:image/png;base64,${Buffer.from("a scheduler drawing").toString("base64")}`;
    });
    const b = (await store.load("b"))!;
    b.cards.push({ id: "vec", kind: "image", src: "beef.svg" });
    b.place.vec = { x: 0, y: 400, w: 300 };
    await store.save(b);
    await cx.meaning.update(store);
    await indexed();
    const texts = asked.flatMap((a) => a.texts);
    expect(texts).toContain("title: Image | text: cuda graph & kv");
    expect(texts).toContain("a scheduler drawing");
    expect(drawn[0]).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((await cx.meaning.search(store, "cuda graph", "b")).items.map((i) => i.kind === "card" && i.card)).toContain(
      "vec",
    );
    // box has its picture now: the next sync hands only its key, so it is not drawn again
    await cx.meaning.update(store);
    expect(drawn.length).toBe(1);
  });

  it("is off while no endpoint is set or without the binary, and says what failed when the server does", async () => {
    const keep = url;
    url = "";
    const off = new HostContext(W, { box });
    expect(await off.meaning.search(store, "kv", "a")).toEqual({ items: [], off: true });
    url = "http://127.0.0.1:1/v1";
    const down = await off.meaning.search(store, "kv", "a");
    expect(down.error).toMatch(/Cannot reach the embedding server/);
    off.dispose();
    const none = new HostContext(W, { box: { bin: path.join(home, "no-box") } });
    expect(await none.meaning.search(store, "kv", "a")).toMatchObject({ items: [], off: true, error: /needs box/ });
    none.dispose();
    url = keep;
  });

  it("hides a picture below the same floor as text", async () => {
    // the same words as a picture and as a Note, both scoring under MIN_SCORE: neither is shown
    const words = "cache cuda graph scheduler";
    fs.writeFileSync(path.join(dir, "assets", "ca5e.png"), words);
    const c = emptyBoard("c", "Pictures");
    c.cards.push({ id: "shot", kind: "image", src: "ca5e.png" });
    c.place.shot = { x: 0, y: 0, w: 300 };
    note(c, "words", words);
    await store.save(c);
    await cx.meaning.update(store);
    await indexed();
    const hits = (await probe.search({ source: dir, ref: "_", q: "cache", k: 40 })).hits;
    const score = (id: string) => hits.find((h) => h.id === `card:${id}`)?.score ?? 0;
    expect(score("shot")).toBeCloseTo(score("words"), 3);
    expect(score("shot")).toBeGreaterThanOrEqual(0.5);
    expect(score("shot")).toBeLessThan(0.55);
    const r = await cx.meaning.search(store, "cache", "c");
    expect(r.items.find((i) => i.kind === "card" && i.card === "shot")).toBeUndefined();
    expect(r.items.find((i) => i.kind === "card" && i.card === "words")).toBeUndefined();
  });
});

describe("Search this board only", () => {
  it.skipIf(!built)("finds by meaning only what is on the board asked from", async () => {
    await cx.meaning.update(store);
    await indexed();
    expect((await cx.meaning.search(store, "kv cache", "a", true)).items[0]).toMatchObject({ card: "n1", board: "a" });
    const elsewhere = await cx.meaning.search(store, "kv cache", "b", true);
    expect(elsewhere.items).toEqual([]);
  });

  it("finds by words only the cards and sidenotes on that board, and no functions or files", async () => {
    const here = await search(cx, store, "Scheduler", "board", "a");
    expect(here.map((r) => r.kind)).toEqual(["card"]);
    expect(here[0]).toMatchObject({ card: "n2", board: "a" });
    expect(await search(cx, store, "Scheduler", "board", "b")).toEqual([]);
    expect((await search(cx, store, "cuda graph", "board", "a")).map((r) => r.kind)).toEqual(["sidenote"]);
  });
});
