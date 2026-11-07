// ⌘K's Related by Meaning against a stand-in embedding server and the real box binary (npm run build -w @codeboard/box): the
// project's cards and sidenotes are handed to box (each with the boards it is on), only changed text is embedded again, and two
// hosts (two windows) on one storage folder share one service and one index
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
});
