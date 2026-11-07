// ⌘K's Related by Meaning against a stand-in embedding server: the project's cards and sidenotes are indexed (each with its
// board and Section), the index is a file in the storage folder kept out of git, and only changed text is embedded again;
// ⌘K's This Board keeps both groups to the board asked from
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyBoard, type Board } from "@codeboard/core";
import { Storage } from "../src/storage/boards";
import { nodeFs } from "../src/storage/nodefs";
import { HostContext } from "../src/context";
import { search } from "../src/search";
import { nodeWorkspace } from "./node-workspace";

const WORDS = ["kv", "cache", "scheduler", "prefill", "graph", "cuda", "显存"];
/** What the server was asked to embed, and with which key */
const asked: { texts: string[]; auth?: string }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "test-embed" }] }));
    const { input } = JSON.parse(body) as { input: string[] };
    asked.push({ texts: input, auth: req.headers.authorization });
    const vec = (t: string) => WORDS.map((w) => t.split(w).length - 1 + 0.01);
    res.end(
      JSON.stringify({
        data: input.map((t, index) => ({ index, embedding: vec(t.replace(/^.*?\| (text|query): /, "")) })),
      }),
    );
  });
});

const W = nodeWorkspace();
let url = "";
W.settings = { ...W.settings, get: <T>(k: string) => (k === "codeboard.search.embeddingUrl" ? url : undefined) as T };
const dir = fs.realpathSync(fs.mkdtempSync("/tmp/codeboard-meaning-"));
const store = new Storage(nodeFs, { dir: () => dir });
let cx: HostContext;

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
  cx = new HostContext(W);
});
afterAll(() => {
  cx.dispose();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Related by Meaning", () => {
  it("finds cards and sidenotes by meaning, with their board, and stores the index outside git", async () => {
    await cx.meaning.update(store);
    const r = await cx.meaning.search(store, "kv cache", "a");
    expect(r.items[0]).toMatchObject({ kind: "card", card: "n1", board: "a", detail: "This board" });
    const g = await cx.meaning.search(store, "cuda graph", "b");
    expect(g.items[0]).toMatchObject({ kind: "sidenote", sidenote: "sn1", card: "n2", detail: "Engine" });
    // each piece carries where it sits; the key goes to the server
    expect(asked.flatMap((a) => a.texts)).toContain(
      "title: Block manager | text: ## Block manager Frees kv cache blocks when a sequence ends.",
    );
    expect(asked.every((a) => a.auth === "Bearer k1")).toBe(true);
    expect(fs.readdirSync(path.join(dir, ".innerbox")).sort()).toEqual([".gitignore", "test-embed.ibx"]);
    expect(fs.readFileSync(path.join(dir, ".innerbox", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("embeds again only what changed, and a new host reads the index from its file", async () => {
    const b = (await store.load("a"))!;
    (b.cards[1] as { md: string }).md = "## Scheduler\nPicks prefill or decode. Keeps 显存 in check.";
    await store.save(b);
    const before = asked.length;
    cx.meaning.soon(store); // as startHost does on a change
    await cx.meaning.update(store);
    const texts = asked.slice(before).flatMap((a) => a.texts);
    expect(texts).toEqual(["title: Scheduler | text: ## Scheduler Picks prefill or decode. Keeps 显存 in check."]);
    const fresh = new HostContext(W);
    const start = asked.length;
    const r = await fresh.meaning.search(store, "显存", "a");
    await fresh.meaning.update(store);
    expect(r.items[0]).toMatchObject({ card: "n2" });
    expect(asked.slice(start).flatMap((a) => a.texts)).toEqual(["task: search result | query: 显存"]);
    fresh.dispose();
  });

  it("is off while no endpoint is set, and says what failed when the server does", async () => {
    const keep = url;
    url = "";
    const off = new HostContext(W);
    expect(await off.meaning.search(store, "kv", "a")).toEqual({ items: [], off: true });
    url = "http://127.0.0.1:1/v1";
    const down = await off.meaning.search(store, "kv", "a");
    expect(down.error).toMatch(/Cannot reach the embedding server/);
    off.dispose();
    url = keep;
  });
});

describe("Search this board only", () => {
  it("finds by meaning only what is on the board asked from", async () => {
    await cx.meaning.update(store);
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
