// The Node addon on its own platform, in a Node process as a single-process tool uses it: node test/smoke-addon.mjs <box.node>.
// Opens an index in a fresh data folder, syncs two items against a stand-in embedding server, searches, closes. Node strips
// the wrapper's types itself (Node 22.18 and later).
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { open } from "../src/embedded.ts";

const addon = path.resolve(process.argv[2] ?? "");
const fail = (msg) => {
  console.error(`smoke-addon: ${msg}`);
  process.exit(1);
};
const WORDS = ["kv", "cache", "graph", "cuda"];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "smoke-embed" }] }));
    const { input } = JSON.parse(body);
    const vec = (t) => WORDS.map((w) => t.split(w).length - 1 + 0.01);
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vec(String(t)) })) }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "box-addon-smoke-"));
const index = open({ addon, home });
const until = Date.now() + 30_000;
try {
  await index.sync("src", "main", { base }, [
    { id: "a", title: "Blocks", text: "Frees kv cache blocks." },
    { id: "b", title: "Graphs", text: "The cuda graph is captured once." },
  ]);
  for (;;) {
    const s = await index.status("src", "main");
    if (!s.indexing && !s.left) break;
    if (Date.now() > until) fail(`indexing did not finish: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await index.search({ source: "src", ref: "main", q: "cuda graph", k: 1 });
  if (r.hits[0]?.id !== "b" || r.model !== "smoke-embed") fail(`unexpected answer ${JSON.stringify(r)}`);
  console.log(`addon search ok: ${JSON.stringify(r.hits[0])}`);
} finally {
  index.close();
  server.close();
}
