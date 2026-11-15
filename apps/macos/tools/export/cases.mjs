// What the extension's Markdown export (packages/core/src/export.ts exportOrder and boardMarkdown, with the board's
// md/blocks.ts noteBlocks splitting Notes) makes of a set of boards, for the tests of its Swift port
// (Sources/CodeBoardModel/Export.swift, Tests/CodeBoardModelTests/ExportTests.swift) to compare against: the Swift side
// imports the same board files and exports them. Writes Tests/CodeBoardModelTests/Fixtures/export.json; run it again
// when those files or the cases change (from the repository root, after npm ci and the Markdown package's build):
//   node apps/macos/tools/export/cases.mjs
// Permalinks are the ones core makes without asking git (GitHub segments): the app knows no other remote. The content is
// made up.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = import.meta.dirname;
const root = path.resolve(here, "../../../..");
const out = path.resolve(here, "../../Tests/CodeBoardModelTests/Fixtures/export.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "export-cases-"));
const entry = path.join(tmp, "entry.ts");
const file = (p) => JSON.stringify(path.join(root, p));
fs.writeFileSync(
  entry,
  `export { exportOrder, boardMarkdown, segPermalink } from ${file("packages/core/src/export.ts")};\n` +
    `export { emptyBoard, blockSig } from ${file("packages/core/src/model.ts")};\n` +
    `export { noteBlocks } from ${file("packages/board/src/md/blocks.ts")};\n`,
);
const bundle = path.join(tmp, "export.mjs");
await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "error",
  nodePaths: [path.join(root, "node_modules")],
});
const X = await import(pathToFileURL(bundle).href);
fs.rmSync(tmp, { recursive: true, force: true });

const git = { kind: "git", commit: "bb823b3c0ffee1234567890abcdef1234567890a" };
const seg = (id, p, start, text, more = {}) => ({
  id,
  src: { kind: "repo", repo: "" },
  path: p,
  lang: "python",
  start,
  end: start + text.length - 1,
  text,
  version: git,
  ...more,
});
const code = (id, segments, more = {}) => ({ id, kind: "code", segments, ...more });
const note = (id, md, look = "note", more = {}) => ({ id, kind: "note", md, look, ...more });

function board(id, name, cards, at, more = {}) {
  const b = { ...X.emptyBoard(id, name), cards, ...more };
  delete b.cam;
  cards.forEach((c, i) => {
    const p = at[c.id] ?? [i * 600, 0];
    b.place[c.id] = { x: p[0], y: p[1], w: 500, ...(p[2] ? { section: p[2] } : {}) };
  });
  return b;
}

// ---- the boards ---------------------------------------------------------------------------------------------------
const schedule = code("sched", [
  seg(
    "s1",
    "nanovllm/engine/scheduler.py",
    24,
    [
      "    def schedule(self):",
      "        seqs = []",
      "        # prefill first",
      "        return self.block_manager.can_allocate(seq)",
      "    ```not a fence```",
    ],
    { symbol: { qual: "Scheduler.schedule", kind: "function" }, hidden: [[25, 26]] },
  ),
]);
const allocate = code("alloc", [
  seg("s2", "nanovllm/engine/block_manager.py", 40, ["def can_allocate(self, seq):", "    return len(self.free) >= seq.n"], {
    src: { kind: "github", owner: "GeeeekExplorer", name: "nano-vllm", ref: "main" },
    symbol: { qual: "BlockManager.can_allocate", kind: "function" },
  }),
  seg("s3", "nanovllm/engine/block_manager.py", 60, ["def allocate(self, seq):", "", "    pass"], {
    src: { kind: "github", owner: "GeeeekExplorer", name: "nano-vllm", ref: "main" },
    scope: "BlockManager.allocate",
    lang: "cuda-cpp",
  }),
]);
const pkg = code("pkg", [
  seg("s4", "torch/nn/functional.py", 1, ["def relu(x):", "  return x"], {
    version: { kind: "pkg", name: "torch", version: "2.5.0" },
  }),
]);
const hashed = code(
  "hashed",
  [seg("s5", "tools/run.sh", 3, ["echo hi"], { lang: "shellscript", version: { kind: "hash", hash: "9f3e2a1b" } })],
  { title: "Runner", desc: "How it starts.\n\nSee [[Prefill#^S]]." },
);
const free = code("free", [
  {
    id: "s6",
    src: { kind: "free" },
    path: "",
    lang: "rust",
    start: 1,
    end: 2,
    text: ["fn main() {", "}"],
    version: { kind: "none" },
  },
]);
const plan = note(
  "plan",
  '## Prefix caching\n\nA chain of hashes: block_manager and __init__: $O(n)$\n\n- one\n- two\n\nSee [[Free code#^free]] and [[Gone#^nothere]]\n\n![warp](assets/a-1x1.png "Fig. 1: \\"if\\" paths"){width=40%}\n\n![](assets/b-1x1.png) ![w](https://a.b/c.png)',
);
const text = note("txt", "Threads **wait** here", "text");
const box = note("bx", "", "box", { fill: "blue" });
const picture = { id: "pic", kind: "image", src: "a-1x1.png", alt: "Memory map" };
const webPic = { id: "wpic", kind: "image", src: "https://example.com/x.png" };
const web = {
  id: "web",
  kind: "web",
  url: "https://www.example.com/paged-attention",
  meta: { title: "Paged attention", desc: "How pages hold the cache." },
};
const bare = { id: "bare", kind: "web", url: "https://docs.example.org/a/b" };
const links = {
  id: "links",
  kind: "links",
  items: [
    { id: "i1", url: "https://example.com/one", title: "One" },
    { id: "i2", url: "https://www.example.net/two", meta: { title: "Two from meta" } },
    { id: "i3", url: "https://example.org/three" },
  ],
};
const sub = { id: "subc", kind: "board", board: "bother" };

const main = board(
  "bmain",
  "Engine step",
  [schedule, allocate, pkg, hashed, free, plan, text, box, picture, webPic, web, bare, links, sub],
  {
    sched: [0, 0],
    alloc: [700, 0],
    pkg: [1400, 0],
    hashed: [0, 300, "S"],
    free: [600, 300, "S"],
    plan: [0, 900, "T"],
    txt: [600, 900],
    bx: [600, 900],
    pic: [0, 1500],
    wpic: [600, 1500],
    web: [1200, 1500],
    bare: [0, 2000],
    links: [600, 2000],
    subc: [1200, 2000],
  },
);
main.place.subc.h = 300;
main.sections.push(
  { id: "S", title: "Prefill", x: -20, y: 260, w: 1200, h: 400 },
  { id: "T", title: "  ", x: -20, y: 860, w: 560, h: 400, parent: "S" },
);
const blocks = X.noteBlocks(plan.md);
const sig = X.blockSig;
main.links.push(
  { id: "l1", from: { card: "sched", seg: "s1", line: 27 }, to: { card: "alloc" }, label: "asks" },
  { id: "l2", from: { card: "sched" }, to: { card: "plan", block: { i: 2, h: sig(blocks[2]) } } },
  { id: "l3", from: { card: "plan", block: { i: 1, h: sig(blocks[1]) } }, to: { card: "txt" } },
  { id: "l4", from: { card: "alloc", seg: "s3", line: 60 }, to: { card: "pkg" } },
  { id: "l5", from: { card: "alloc", seg: "s2", line: 40 }, to: { card: "hashed" }, label: "then" },
  { id: "l6", from: { card: "txt" }, to: { card: "sched" } },
  { id: "l7", from: { card: "plan", block: { i: 9, h: "zzzz" } }, to: { card: "web" } },
);
main.sidenotes.push(
  { id: "n1", kind: "text", at: { card: "sched", seg: "s1", lines: [27, 27] }, md: "prefill, then decode" },
  { id: "n2", kind: "text", at: { card: "sched" }, md: "private\n\nnote ![s](assets/b-1x1.png)", boardOnly: true },
  {
    id: "n3",
    kind: "code",
    at: { card: "alloc", seg: "s2", lines: [40, 41] },
    code: seg("s7", "nanovllm/utils.py", 5, ["    x = 1", "    y = 2"]),
    why: "where n comes from",
  },
  {
    id: "q1",
    kind: "text",
    at: { card: "alloc", seg: "s2", lines: [41, 41] },
    md: "why >=?\nnot >",
    q: { at: 1, answers: [{ id: "a1", md: "free ids\nsecond line", at: 2 }] },
  },
  { id: "q2", kind: "text", at: { card: "alloc" }, md: "", q: { at: 3, done: true } },
  { id: "n4", kind: "text", at: { section: "S" }, md: "on the section" },
  { id: "n5", kind: "text", at: { x: 10, y: 10 }, md: "free on the board" },
);
const other = board("bother", "Memory model", [note("on", "other")], {});

// ---- the cases ----------------------------------------------------------------------------------------------------
const boards = { "bmain.json": main, "bother.json": other };
const names = { bmain: main.name, bother: other.name };
const cases = [
  { name: "whole board", scope: { kind: "board" } },
  { name: "whole board with questions and board-only notes", scope: { kind: "board" }, questions: true, boardOnly: true },
  { name: "a section and the one inside it", scope: { kind: "sections", ids: ["S"] } },
  { name: "the inner section alone", scope: { kind: "sections", ids: ["T"] }, questions: true },
  { name: "walkthrough from a card", scope: { kind: "walk", start: "sched" } },
  { name: "walkthrough from the end of a path", scope: { kind: "walk", start: "web" } },
].map((c) => {
  const b = JSON.parse(JSON.stringify(main));
  const order = X.exportOrder(b, c.scope);
  const segs = order.flatMap((id) => {
    const k = b.cards.find((x) => x.id === id);
    return [
      ...(k?.kind === "code" ? k.segments : []),
      ...b.sidenotes.filter((n) => n.at.card === id && n.kind === "code").map((n) => n.code),
    ];
  });
  const links = {};
  for (const s of segs) {
    const u = X.segPermalink(s);
    if (u) links[s.id] = u;
  }
  const markdown = X.boardMarkdown(b, {
    order,
    questions: c.questions,
    boardOnly: c.boardOnly,
    links,
    boardName: (id) => names[id],
    blocks: X.noteBlocks,
  });
  return { ...c, questions: !!c.questions, boardOnly: !!c.boardOnly, order, markdown };
});
const noteBlocks = {};
for (const c of main.cards) if (c.kind === "note") noteBlocks[c.md] = X.noteBlocks(c.md);

fs.writeFileSync(
  out,
  `${JSON.stringify({ boards, assets: ["a-1x1.png", "b-1x1.png"], board: "bmain", noteBlocks, cases }, null, 2)}\n`,
);
console.log(`wrote ${path.relative(root, out)}: ${cases.length} cases`);
