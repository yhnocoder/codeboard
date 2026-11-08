// The client against the real binary (npm run build -w @codeboard/box builds it) and a stand-in embedding server: it starts
// the service, two clients share it, and a client whose service went away starts it again
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { binIn, connect, type BoxClient, type BoxItem } from "../src/index";

const BIN = binIn(path.join(__dirname, "..", "bin"));
const built = fs.existsSync(BIN);
if (!built && process.env.CI) throw new Error(`no box binary at ${BIN}: npm run build -w @codeboard/box`);
if (!built) console.warn(`box client tests skipped: no binary at ${BIN} (npm run build -w @codeboard/box; needs Rust)`);

const WORDS = ["kv", "cache", "scheduler", "prefill", "graph", "cuda"];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "test-embed" }] }));
    const { input } = JSON.parse(body) as { input: string[] };
    const vec = (t: string) => WORDS.map((w) => t.split(w).length - 1 + 0.01);
    res.end(
      JSON.stringify({
        data: input.map((t, index) => ({ index, embedding: vec(t.replace(/^.*?\| (text|query): /, "")) })),
      }),
    );
  });
});
const home = fs.mkdtempSync(path.join(os.tmpdir(), "box-client-"));
let base = "";
const clients: BoxClient[] = [];
const open = () => {
  const c = connect({ bin: BIN, home });
  clients.push(c);
  return c;
};
const items: BoxItem[] = [
  { id: "a", title: "Block manager", text: "Frees kv cache blocks.", groups: ["b1"], meta: { n: 1 } },
  { id: "b", title: "Graphs", text: "The cuda graph is captured once.", groups: ["b2"] },
];
const settled = (c: BoxClient) =>
  vi.waitFor(
    async () => {
      const s = await c.status("src", "main");
      if (s.indexing) throw new Error("indexing");
      return s;
    },
    { timeout: 10000, interval: 20 },
  );

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(async () => {
  const pid = await clients[0]?.pid().catch(() => 0);
  for (const c of clients) c.close();
  if (pid) process.kill(pid);
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!built)("box client", () => {
  it("starts the service, syncs and finds items by meaning", async () => {
    const c = open();
    await expect(c.sync("src", "main", { base }, items)).resolves.toEqual({ accepted: 2 });
    expect(await settled(c)).toMatchObject({ items: 2, left: 0, model: "test-embed", synced: true });
    const r = await c.search({ source: "src", ref: "main", q: "kv cache", k: 1 });
    expect(r).toMatchObject({ model: "test-embed", source: "src", ref: "main", left: 0 });
    expect(r.hits).toEqual([{ id: "a", score: expect.any(Number), piece: 0, range: [0, 22], meta: { n: 1 } }]);
    const only = await c.search({ source: "src", ref: "main", q: "kv cache", groups: ["b2"] });
    expect(only.hits.map((h) => h.id)).toEqual(["b"]);
    // the keyword group: its own list, only what has the words
    const kw = await c.searchKeyword({ source: "src", ref: "main", q: "cuda graph" });
    expect(kw).toEqual({
      source: "src",
      ref: "main",
      hits: [{ id: "b", score: expect.any(Number), range: [4, 8], meta: null }],
    });
  });

  it("shares one service between clients, and starts it again when it has gone", async () => {
    const [c, d] = [clients[0], open()];
    const pid = await c.pid();
    expect(await d.pid()).toBe(pid);
    process.kill(pid);
    // the next request finds no service, starts one, and that one asks for a sync first
    const r = await vi.waitFor(() => d.search({ source: "src", ref: "main", q: "kv" }), { timeout: 10000 });
    expect(r.unsynced).toBe(true);
    expect(await d.pid()).not.toBe(pid);
    await d.sync("src", "main", { base }, items);
    await settled(d);
    expect((await d.search({ source: "src", ref: "main", q: "cuda graph" })).hits[0].id).toBe("b");
    expect(await c.pid()).toBe(await d.pid());
  });
});
