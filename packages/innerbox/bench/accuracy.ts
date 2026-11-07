// How well innerbox finds things, against a real embedding server (not run in CI: it needs the user's own model).
//   npm run bench -w @codeboard/innerbox -- --base http://127.0.0.1:11001/v1 --key KEY [--model NAME]
// The test set (corpus.json: 177 board items, queries.json: 44 queries with the items they should find; Chinese for English,
// English for Chinese, other wording, identifiers) goes through exactly what ⌘K's Related by Meaning does: pieces, best piece.
// Prints recall@5 and MRR per kind of query, the misses, and the times: indexing, one query end to end, search over 15k pieces.
import { Box, endpointEmbedder, queryText, type Doc } from "../src/index";
import corpusJson from "./corpus.json";
import queriesJson from "./queries.json";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const base = arg("base") ?? process.env.INNERBOX_BASE ?? "http://127.0.0.1:11001/v1";
const key = arg("key") ?? process.env.INNERBOX_KEY;
const embedder = endpointEmbedder({ base, key, model: arg("model") });

type Item = { id: string; kind: string; text: string };
type Query = { id: string; type: string; query: string; relevant: string[] };
const corpus: Item[] = corpusJson;
const queries: Query[] = queriesJson;

// the title of a board item is its first line (a Note's heading, a code card's path · symbol)
const docs: Doc[] = corpus.map((c) => {
  const [first, ...rest] = c.text.split("\n");
  return { id: c.id, title: first.replace(/^#+\s*/, ""), text: rest.join("\n") };
});

const model = await embedder.model();
const box = new Box(model);
let t = performance.now();
const pieces = box.missing(docs);
await box.update(docs, embedder);
const indexMs = performance.now() - t;

const rows: { type: string; r5: number; mrr: number }[] = [];
const misses: string[] = [];
let queryMs = 0;
for (const q of queries) {
  t = performance.now();
  const [qv] = await embedder.embed([queryText(q.query)]);
  const ids = box.search(qv, 10).map((h) => h.id);
  queryMs += performance.now() - t;
  const rel = new Set(q.relevant);
  const first = ids.findIndex((id) => rel.has(id));
  rows.push({
    type: q.type,
    r5: ids.slice(0, 5).filter((id) => rel.has(id)).length / Math.min(5, rel.size),
    mrr: first >= 0 ? 1 / (first + 1) : 0,
  });
  if (first !== 0)
    misses.push(
      `  [${q.type}] ${q.query}\n      got: ${ids.slice(0, 3).join(", ")}  (first relevant: #${first < 0 ? "-" : first + 1})\n      want: ${q.relevant.join(", ")}`,
    );
}

// search speed on a bigger project: 15k pieces of random unit vectors in the same dimensions
const big = new Box("speed");
const dim = (await embedder.embed(["dim"]))[0].length;
const rand = () => {
  const v = Float32Array.from({ length: dim }, () => Math.random() - 0.5);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const fakeDocs: Doc[] = Array.from({ length: 5000 }, (_, i) => ({ id: `d${i}`, title: `t${i}`, text: "a. b. c. d" }));
const fakeEmbedder = { model: async () => "speed", embed: async (xs: string[]) => xs.map(rand) };
await big.update(
  fakeDocs.map((d, i) => ({
    ...d,
    text: `one ${i}. `.repeat(40) + `two ${i}. `.repeat(40) + `three ${i}. `.repeat(40),
  })),
  fakeEmbedder,
);
const qv = rand();
big.search(qv, 16); // packs the vectors once, as the first search after a change does
t = performance.now();
for (let i = 0; i < 10; i++) big.search(qv, 16);
const bigMs = (performance.now() - t) / 10;

const avg = (xs: typeof rows, f: (r: (typeof rows)[0]) => number) =>
  xs.reduce((a, r) => a + f(r), 0) / (xs.length || 1);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const names: Record<string, string> = { xling: "中文查英文", en2zh: "英文查中文", para: "换说法", ident: "标识符" };
console.log(`\n${model} at ${base}, ${dim} dims`);
console.log(`index: ${docs.length} items, ${pieces} pieces in ${(indexMs / 1000).toFixed(1)} s`);
console.log(`one query (embed + search): ${(queryMs / queries.length).toFixed(0)} ms`);
console.log(`search alone over ${big.size} items (3 pieces each): ${bigMs.toFixed(1)} ms\n`);
console.log("recall@5 / MRR");
for (const ty of [...new Set(rows.map((r) => r.type))]) {
  const rs = rows.filter((r) => r.type === ty);
  console.log(
    `  ${(names[ty] ?? ty).padEnd(8)} ${pct(avg(rs, (r) => r.r5))} / ${pct(avg(rs, (r) => r.mrr))}   (${rs.length})`,
  );
}
console.log(`  全部      ${pct(avg(rows, (r) => r.r5))} / ${pct(avg(rows, (r) => r.mrr))}   (${rows.length})`);
console.log(`\nbest result not relevant (${misses.length}):\n${misses.join("\n")}`);
