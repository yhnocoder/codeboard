// box inside this process (the Node addon, npm run build -w @codeboard/box builds it) against a stand-in embedding server:
// open, sync, search, one process per data folder
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addonIn, type BoxIndex, open } from "../src/embedded";

const ADDON = addonIn(path.join(__dirname, "..", "node", "bin"));
const built = fs.existsSync(ADDON);
if (!built && process.env.CI) throw new Error(`no box addon at ${ADDON}: npm run build -w @codeboard/box`);
if (!built) console.warn(`box addon tests skipped: no addon at ${ADDON} (npm run build -w @codeboard/box; needs Rust)`);

const WORDS = ["kv", "cache", "graph", "cuda"];
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "box-addon-"));
let base = "";
let index: BoxIndex | undefined;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => {
  index?.close();
  server.close();
});

describe.skipIf(!built)("box addon", () => {
  it("syncs and searches in this process, and keeps a second open out", async () => {
    index = open({ addon: ADDON, home });
    expect(() => open({ addon: ADDON, home })).toThrow(/another process/);
    await expect(index.search({ source: "src", ref: "main", q: "kv" })).resolves.toMatchObject({ unsynced: true });
    await expect(
      index.sync("src", "main", { base }, [
        { id: "a", title: "Blocks", text: "Frees kv cache blocks.", groups: ["b1"], meta: { n: 1 } },
        { id: "b", title: "Graphs", text: "The cuda graph is captured once." },
      ]),
    ).resolves.toEqual({ accepted: 2 });
    const ix = index;
    await vi.waitFor(
      async () => {
        const s = await ix.status("src", "main");
        if (s.indexing || s.left) throw new Error("indexing");
      },
      { timeout: 10000, interval: 20 },
    );
    const r = await ix.search({ source: "src", ref: "main", q: "cuda graph", k: 1 });
    expect(r).toMatchObject({ model: "test-embed", left: 0 });
    expect(r.hits.map((h) => h.id)).toEqual(["b"]);
    await ix.forget("src");
    expect(await ix.status("src", "main")).toMatchObject({ items: 0, synced: false });
  });
});
