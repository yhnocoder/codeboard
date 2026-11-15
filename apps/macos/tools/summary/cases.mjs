// What the extension's zoomed-out summaries (packages/core/src/summary.ts, commands/summaries.ts and the prompt of
// packages/host/src/summaries.ts) make of a set of boards and layout inputs, for the tests of their Swift port
// (Sources/CodeBoardModel/Summaries.swift and SummaryPrompt.swift, Tests/CodeBoardModelTests/SummaryTests.swift) to
// compare against. Writes Tests/CodeBoardModelTests/Fixtures/summary.json; run it again when those files or the cases
// change (from the repository root, after npm ci):
//   node apps/macos/tools/summary/cases.mjs
// Boards are written as small card specs both sides build their own model from. The content is made up.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = import.meta.dirname;
const root = path.resolve(here, "../../../..");
const out = path.resolve(here, "../../Tests/CodeBoardModelTests/Fixtures/summary.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "summary-cases-"));
const entry = path.join(tmp, "entry.ts");
const file = (p) => JSON.stringify(path.join(root, p));
fs.writeFileSync(
  entry,
  `export * from ${file("packages/core/src/summary.ts")};\n` +
    `export { editSummary, keepSummary } from ${file("packages/core/src/commands/summaries.ts")};\n` +
    `export { summaryPrompt } from ${file("packages/host/src/summaries.ts")};\n`,
);
const bundle = path.join(tmp, "summary.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const S = await import(pathToFileURL(bundle).href);
fs.rmSync(tmp, { recursive: true, force: true });

const NOW = 1_700_000_000_000;
Date.now = () => NOW;
const clone = (x) => JSON.parse(JSON.stringify(x));
// undefined → null, so every field is in the file
const nul = (x) => JSON.parse(JSON.stringify(x ?? null, (_, v) => (v === undefined ? null : v)));

// ---- boards from specs --------------------------------------------------------------------------------------------
// card spec: { id, kind: note|text|box|code|image|web|links|board, title?, md?, alt?, url?, meta?: {title?, desc?},
//   items?: [{url, title?}], segs?: [{path, start, lines, free?, symbol?: {name, kind}, scope?}], section?, unplaced?,
//   summary?, r?: rect }
// section spec: { id, title, parent?, collapsed?, summary?, directSummary?, f?: frame }
function webCard(c) {
  const base = { id: c.id, ...(c.title !== undefined ? { title: c.title } : {}) };
  switch (c.kind) {
    case "note":
    case "text":
    case "box":
      return { ...base, kind: "note", look: c.kind, md: c.md ?? "" };
    case "code":
      return {
        ...base,
        kind: "code",
        segments: (c.segs ?? []).map((s, i) => ({
          id: `${c.id}-s${i}`,
          path: s.free ? "" : s.path,
          start: s.start,
          end: s.start + s.lines.length - 1,
          text: s.lines,
          src: { kind: s.free ? "free" : "git" },
          ...(s.symbol ? { symbol: { kind: s.symbol.kind, qual: s.symbol.name } } : {}),
          ...(s.scope ? { scope: s.scope } : {}),
        })),
      };
    case "image":
      return { ...base, kind: "image", src: "a.png", ...(c.alt !== undefined ? { alt: c.alt } : {}) };
    case "web":
      return { ...base, kind: "web", url: c.url, ...(c.meta ? { meta: { ...c.meta } } : {}) };
    case "links":
      return { ...base, kind: "links", items: c.items.map((it, i) => ({ id: `i${i}`, ...it })) };
    case "board":
      return { ...base, kind: "board", board: "elsewhere" };
  }
  throw new Error(c.kind);
}
function webBoard(spec) {
  const place = {};
  for (const c of spec.cards)
    if (!c.unplaced)
      place[c.id] = {
        x: c.r?.x ?? 0,
        y: c.r?.y ?? 0,
        w: c.r?.w ?? 100,
        ...(c.section ? { section: c.section } : {}),
        ...(c.summary ? { summary: clone(c.summary) } : {}),
      };
  return {
    id: spec.id,
    cards: spec.cards.map(webCard),
    place,
    links: [],
    sections: spec.sections.map((s) => ({
      id: s.id,
      title: s.title,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      ...(s.parent ? { parent: s.parent } : {}),
      ...(s.collapsed ? { collapsed: true } : {}),
      ...(s.summary ? { summary: clone(s.summary) } : {}),
      ...(s.directSummary ? { directSummary: clone(s.directSummary) } : {}),
    })),
    sidenotes: [],
    stickers: [],
  };
}
const rectOf = (spec) => (id) => spec.cards.find((c) => c.id === id && !c.unplaced)?.r;
const framesOf = (spec) => new Map(spec.sections.filter((s) => s.f).map((s) => [s.id, s.f]));
// every Section a frame and every card a box, for the requests (main asks only for items that have a column)
const fullRect = (spec) => (id) => rectOf(spec)(id) ?? { x: 5000, y: 5000, w: 300, h: 200 };
const fullFrames = (spec) => new Map(spec.sections.map((s, i) => [s.id, s.f ?? { x: 9000 + i * 900, y: 0, w: 800, h: 600 }]));

const R = (x, y, w, h) => ({ x, y, w, h });
const sum = (text, extra = {}) => ({ text, at: 1_600_000_000_000, sig: "old", ...extra });
const note = (id, md, extra = {}) => ({ id, kind: "note", md, ...extra });
const code = (id, path, start, lines, extra = {}) => ({ id, kind: "code", segs: [{ path, start, lines, ...extra.seg }], ...extra });

const longLines = Array.from({ length: 95 }, (_, i) => `    step_${i} = run(batch, ${i})`);
const boards = {
  a: {
    id: "a",
    sections: [{ id: "A", title: "Scheduler", f: R(0, 0, 800, 600), summary: sum("Picks **waiting** requests.") }],
    cards: [
      note("n1", "# Queue order\nRequests wait in **FIFO** order.\n![shot](assets/x.png) <b>bold</b>", { section: "A", r: R(20, 20, 300, 200) }),
      code("c1", "nano/engine/scheduler.py", 42, ["def schedule(self):", "    return self.waiting"], {
        section: "A",
        seg: { symbol: { name: "Scheduler.schedule", kind: "function" } },
        r: R(400, 20, 360, 220),
      }),
    ],
  },
  b: {
    id: "b",
    sections: [
      { id: "A", title: "Engine", f: R(0, 0, 1400, 1000) },
      { id: "B", title: "Step", parent: "A", f: R(40, 60, 1300, 900) },
      { id: "C", title: "Prefill", parent: "B", f: R(80, 120, 1200, 800), summary: sum("Fills the **KV cache**.") },
    ],
    cards: [
      note("n1", "## Chunked prefill\nLong prompts go in pieces.", { section: "C", r: R(100, 150, 400, 300) }),
      note("n2", "Batches mix prefill and decode.", { section: "C", r: R(600, 150, 400, 300) }),
      note("n3", "# Loose idea", { r: R(1600, 0, 300, 200) }),
    ],
  },
  c: {
    id: "c",
    sections: [
      { id: "A", title: "Memory", f: R(0, 0, 2000, 1400), summary: sum("How **memory** is split.") },
      { id: "B", title: "Blocks", parent: "A", f: R(40, 80, 1200, 1000) },
      { id: "C", title: "Swap", parent: "A", f: R(1300, 80, 600, 600), summary: sum("Moves blocks to **host**.") },
      { id: "D", title: "Allocate", parent: "B", f: R(80, 160, 500, 400), summary: sum("Hands out **free blocks**.") },
      { id: "E", title: "Free", parent: "B", f: R(620, 160, 500, 400) },
    ],
    cards: [
      note("a1", "# Overview\nMemory is cut into blocks.", { section: "A", r: R(40, 1200, 400, 150) }),
      note("b1", "Blocks are 16 tokens each.", { section: "B", r: R(80, 700, 300, 200) }),
      code("d1", "nano/engine/block_manager.py", 10, ["def allocate(self, seq):", "    pass"], {
        section: "D",
        seg: { symbol: { name: "BlockManager.allocate", kind: "function" } },
        r: R(100, 200, 400, 300),
      }),
      note("e1", "# Freeing\nRefcounts drop to zero.", { section: "E", r: R(640, 200, 400, 300) }),
      note("c1", "# Swap out\nTo host memory.", { section: "C", r: R(1320, 120, 400, 300) }),
    ],
  },
  d: {
    id: "d",
    sections: [
      { id: "A", title: "Outer", f: R(0, 0, 1000, 800) },
      { id: "B", title: "Inner", parent: "A", f: R(20, 40, 600, 500) },
    ],
    cards: [
      note("a1", "# Direct", { section: "A", r: R(700, 100, 250, 200) }),
      note("b1", "# In inner", { section: "B", r: R(40, 80, 300, 200) }),
    ],
  },
  e: {
    id: "e",
    sections: [
      { id: "A", title: "Parent", f: R(0, 0, 1000, 800) },
      { id: "B", title: "Folded", parent: "A", collapsed: true, f: R(20, 40, 200, 40) },
      { id: "R", title: "Folded root", collapsed: true, f: R(2000, 0, 200, 40) },
    ],
    cards: [
      note("a1", "# Parent card", { section: "A", r: R(20, 100, 300, 200) }),
      note("b1", "# Folded card", { section: "B", r: R(20, 40, 300, 200) }),
      note("r1", "# Root folded card", { section: "R", r: R(2000, 0, 300, 200) }),
    ],
  },
  f: {
    id: "f",
    sections: [{ id: "A", title: "Orphan", parent: "gone", f: R(0, 0, 600, 400) }],
    cards: [note("n1", "# Kept", { section: "A", r: R(10, 10, 200, 100) })],
  },
  g: {
    id: "g",
    sections: [],
    cards: [
      note("n1", "# Heading note\nbody", { r: R(0, 0, 300, 200) }),
      note("n2", "plain first line", { r: R(400, 0, 300, 200), summary: sum("A **plain** note.", { title: "AI title" }) }),
      note("n3", "", { r: R(800, 0, 300, 200) }),
      note("n4", "#nospace", { title: "Own title", r: R(1200, 0, 300, 200) }),
      code("c1", "nano/llm.py", 42, ["class LLM:", "    pass"], { seg: { symbol: { name: "llm.py", kind: "module" } }, r: R(0, 400, 400, 300) }),
      code("c2", "", 1, ["print(1)"], { seg: { free: true }, r: R(500, 400, 300, 100) }),
      code("c3", "src\\win\\path.cu", 7, ["__global__ void k() {}"], { seg: { scope: "k" }, r: R(900, 400, 300, 100) }),
      code("c4", "lib/x.py", 3, ["a = 1", "b = 2"], { r: R(1300, 400, 300, 100) }),
      { id: "c5", kind: "code", segs: [], r: R(1700, 400, 300, 100) },
      { id: "i1", kind: "image", alt: "A diagram of blocks", r: R(0, 800, 400, 300) },
      { id: "i2", kind: "image", r: R(500, 800, 400, 300) },
      { id: "i3", kind: "image", alt: "", title: "Titled picture", r: R(1000, 800, 400, 300) },
      { id: "w1", kind: "web", url: "https://www.example.com/page", meta: { title: "Example page", desc: "About it" }, r: R(0, 1300, 400, 200) },
      { id: "w2", kind: "web", url: "https://docs.example.org/a/b", r: R(500, 1300, 400, 200) },
      { id: "w3", kind: "web", url: "not a url", r: R(1000, 1300, 400, 200) },
      { id: "l1", kind: "links", items: [{ url: "https://a.example", title: "First" }, { url: "https://b.example" }], r: R(0, 1600, 300, 200) },
      { id: "s1", kind: "board", r: R(500, 1600, 300, 200) },
      { id: "t1", kind: "text", md: "Big words", r: R(900, 1600, 300, 80) },
      { id: "x1", kind: "box", md: "", r: R(1300, 1600, 300, 80) },
      note("n5", "\n\n## Late heading\nmore", { r: R(1700, 0, 300, 200) }),
    ],
  },
  h: {
    id: "h",
    sections: [{ id: "A", title: "Present", f: R(0, 0, 500, 400) }],
    cards: [
      note("n1", "# Points nowhere", { section: "missing", r: R(800, 0, 300, 200) }),
      note("n2", "# In present", { section: "A", r: R(10, 10, 300, 200) }),
    ],
  },
  i: {
    id: "i",
    sections: [{ id: "A", title: "Has unplaced", f: R(0, 0, 500, 400) }],
    cards: [
      note("n1", "# Unplaced in A", { section: "A", unplaced: true }),
      note("n2", "# Unplaced loose", { unplaced: true }),
      note("n3", "# Placed", { section: "A", r: R(10, 10, 200, 100) }),
      note("n4", "# Placed but no box", {}),
    ],
  },
  big: {
    id: "big",
    sections: [{ id: "A", title: "Budget", f: R(0, 0, 900, 900) }],
    cards: [
      code("c1", "nano/big.py", 100, longLines, { section: "A", r: R(10, 10, 400, 600) }),
      note("n1", `# Long\n${"word ".repeat(1400)}`, { section: "A", r: R(450, 10, 400, 300) }),
      note("n2", `# Cut\n${"调度".repeat(800)}😀tail`, { section: "A", r: R(450, 400, 400, 300) }),
      note("n3", "# Starved\nnothing left", { section: "A", r: R(450, 750, 400, 100) }),
    ],
  },
};

// ---- variants for sig / input / pending --------------------------------------------------------------------------
function withSigs(spec) {
  // every item written from the board as it is (texts first: a header's sig holds its children's), so a change makes
  // it pending
  const s = clone(spec);
  const keys = S.summaryKeys(webBoard(s));
  const slot = (key, f) => {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (kind === "card") f(s.cards.find((c) => c.id === id), "summary");
    else f(s.sections.find((x) => x.id === id), kind === "own" ? "directSummary" : "summary");
  };
  for (const key of keys) slot(key, (o, k) => (o[k] = { text: o[k]?.text ?? `Summary of ${key}`, at: 1_650_000_000_000, sig: "" }));
  const b = webBoard(s);
  for (const key of keys) slot(key, (o, k) => Object.assign(o[k], { sig: S.summarySig(b, key), input: S.summaryInput(b, key) }));
  return s;
}
const variant = (spec, name, f) => {
  const s = clone(spec);
  s.id = `${spec.id}-${name}`;
  f(s);
  return s;
};
const card = (s, id) => s.cards.find((c) => c.id === id);
const sigBase = { b: withSigs(boards.b), c: withSigs(boards.c), g: withSigs(boards.g) };
const sigBoards = [
  sigBase.b,
  variant(sigBase.b, "retitled", (s) => (card(s, "n1").md = "## Chunked prefill v2\nLong prompts go in pieces.")),
  variant(sigBase.b, "added", (s) => s.cards.push(note("n9", "# Extra", { section: "C", r: R(0, 0, 10, 10) }))),
  variant(sigBase.b, "moved", (s) => (card(s, "n2").r = R(700, 500, 400, 300))),
  variant(sigBase.b, "edited", (s) => (card(s, "n2").md = "Batches mix prefill and decode, mostly.")),
  variant(sigBase.b, "loose", (s) => (card(s, "n3").md = "# Loose idea, renamed")),
  sigBase.c,
  variant(sigBase.c, "kidsum", (s) => (s.sections.find((x) => x.id === "D").summary.text = "Hands out **blocks** fast.")),
  variant(sigBase.c, "kidtitle", (s) => (s.sections.find((x) => x.id === "C").title = "Swapping")),
  variant(sigBase.c, "direct", (s) => (card(s, "b1").md = "# Block size\nBlocks are 16 tokens each.")),
  variant(sigBase.c, "nodsum", (s) => {
    delete s.sections.find((x) => x.id === "B").directSummary;
    s.sections.find((x) => x.id === "B").summary = undefined;
  }),
  variant(sigBase.c, "cjk", (s) => (card(s, "e1").md = "# 释放显存块\n引用计数归零。")),
  variant(sigBase.c, "emoji", (s) => (card(s, "c1").title = "😀 Swap out")),
  variant(sigBase.c, "order", (s) => {
    const titles = ["a", "B", "_", "é", "调", "😀", "�", "é", "Z"];
    titles.forEach((t, i) => s.cards.push(note(`o${i}`, `# ${t}`, { section: "D", r: R(i * 10, 0, 10, 10) })));
  }),
  sigBase.g,
  variant(sigBase.g, "retitled", (s) => {
    card(s, "c1").segs[0].symbol.name = "llm.py";
    card(s, "c1").segs[0].symbol.kind = "function";
    card(s, "i1").alt = "Another diagram";
    card(s, "w1").meta.title = "";
  }),
];
const extraKeys = ["sec:B", "own:A", "card:missing", "sec:missing", "own:C", "card:t1"];

// ---- the cases ----------------------------------------------------------------------------------------------------
const planOf = (b) =>
  [...S.sectionPlan(b)].map(([id, p]) => ({
    id,
    role: p.role,
    depth: p.depth,
    lines: p.lines,
    kick: p.kick ?? null,
    kids: p.kids.map((k) => k.id),
    direct: p.direct.map((c) => c.id),
  }));
const srcOut = (it) => ({
  key: it.key,
  box: it.box,
  own: it.own,
  title: it.title,
  code: it.code ?? null,
  image: it.image ?? null,
  text: it.text ?? null,
  kick: it.kick ?? null,
  head: it.head ?? null,
  group: !!it.group,
});
const colOut = (c) => ({
  x: c.x,
  y: c.y,
  w: c.w,
  h: c.h,
  key: c.key,
  hd: c.hd,
  full: c.full,
  title: c.title,
  code: c.code ?? null,
  image: c.image ?? null,
  kick: c.kick ?? null,
  group: !!c.group,
  head: c.head ?? null,
});
const layoutOut = (l) => ({ font: l.S, padding: l.P, cut: l.cut, median: l.med, cols: l.cols.map(colOut) });

// hand-made layout inputs
const src = (key, box, title, extra = {}) => ({
  key,
  box,
  own: key.startsWith("sec:") ? { x: box.x, y: box.y - 30, w: box.w, h: box.h + 30 } : { ...box },
  title,
  ...extra,
});
const head = (key, frame, depth, title, extra = {}) => ({
  key,
  box: { x: frame.x, y: frame.y, w: frame.w, h: 0 },
  own: { x: frame.x, y: frame.y, w: frame.w, h: 0 },
  title,
  head: { frame, level: depth === 1 ? 1 : 2, lines: depth === 1 ? 2 : 1, depth },
  ...extra,
});
const cjkLong = "调度器按照先来先服务的顺序挑选等待中的请求，".repeat(9) + "**关键**在于显存。";
const layouts = {
  a: {
    input: {
      items: [
        src("sec:a", R(0, 0, 500, 300), "Scheduler", { text: cjkLong }),
        src("sec:b", R(0, 500, 500, 300), "Memory", { text: "Short **one**." }),
        src("card:x", R(700, 2, 300, 200), "KV cache"),
      ],
      keep: [R(1300, 0, 400, 400)],
    },
    measured: { "sec:a": { hd: 90, tx: 1400 }, "sec:b": { hd: 90, tx: 60 }, "card:x": { hd: 120, tx: 0 } },
  },
  b: {
    input: {
      items: [
        src("sec:l", R(0, 0, 600, 400), "Left", { text: "Left body text." }),
        src("sec:m", R(3, 600, 598, 400), "Below, almost aligned", { text: "Second." }),
        src("card:r1", R(1400, 150, 300, 200), "Row with 150", { text: "One row." }),
        src("card:r2", R(2000, 250, 300, 200), "Row with 250", { text: "Next row." }),
        src("card:r3", R(2600, 2, 300, 200), "Top-aligned", { text: "Top." }),
      ],
      keep: [],
    },
    measured: { "sec:l": { hd: 70, tx: 120 }, "card:r2": { hd: 50, tx: 300 } },
  },
  c: {
    input: { items: [src("card:c", R(0, 0, 400, 300), "Blocked", { text: "No room." })], keep: [R(410, 0, 400, 300)] },
    measured: { "card:c": { hd: 40, tx: 2000 } },
  },
  d: {
    input: { items: [src("sec:wide", R(0, 0, 5000, 600), "Very wide section", { text: "word ".repeat(300) })], keep: [] },
    measured: { "sec:wide": { hd: 80, tx: 500 } },
  },
  e: {
    input: { items: [src("card:huge", R(0, 0, 300, 200), "Huge body", { text: "lorem ipsum ".repeat(900) })], keep: [] },
    measured: { "card:huge": { hd: 60, tx: 9000 } },
  },
  f: {
    input: { items: [src("card:f", R(0, 0, 400, 300), "Covered", { text: "Under an obstacle." })], keep: [R(0, -10, 400, 50)] },
    measured: {},
  },
  g: {
    input: {
      items: [
        head("sec:h1", R(0, 0, 3000, 2000), 1, "Top level header with a long title", { text: cjkLong }),
        head("sec:h2", R(50, 100, 2000, 1500), 2, "Second", { text: "One **line** overview of the second level that goes on." }),
        head("sec:h3", R(100, 200, 1000, 1000), 3, "Third", { kick: "Pass › Through" }),
        head("sec:h4", R(4000, 600, 800, 600), 1, "Under an obstacle", { text: "Short." }),
        src("sec:leaf", R(120, 300, 900, 800), "Leaf", { text: "Leaf body.", kick: "Kick" }),
        src("own:h1", R(2200, 300, 600, 400), "", { text: "Direct cards.", group: true }),
        src("card:i", R(4000, 0, 300, 200), "Img", { image: R(4000, 0, 300, 200) }),
        src("card:k", R(5000, 0, 400, 300), "Engine.step", { code: { name: "Engine.step", at: "engine.py:42" } }),
        src("card:k2", R(5500, 0, 400, 300), "Code", { code: { name: "Code", at: "" } }),
      ],
      keep: [R(4000, 300, 800, 150)],
    },
    measured: { "sec:h2": { hd: 100, tx: 400 }, "sec:h3": { hd: 90, tx: 0 }, "card:k": { hd: 99, tx: 33 } },
  },
  h: { input: { items: [], keep: [] }, measured: {} },
  i: {
    input: {
      items: [
        src("sec:en", R(0, 0, 400, 300), "A rather long English title that wraps over two or three lines of text"),
        src("sec:zh", R(600, 0, 400, 300), "一个很长的中文标题需要折成两到三行才能放得下这么多字"),
        src("sec:mix", R(1200, 0, 400, 300), "混合 Mixed 标题 with ＦＵＬＬ width 한국어"),
      ],
      keep: [],
    },
    measured: { "sec:zh": { hd: 200, tx: 0 } },
  },
};
for (const [n, ws] of [
  [1, [300]],
  [2, [300, 900]],
  [3, [300, 900, 1500]],
  [4, [300, 700, 1100, 2000]],
]) {
  layouts[`j${n}`] = {
    input: { items: ws.map((w, i) => src(`card:j${i}`, R(i * 4000, i * 1000, w, 200), `J${i}`)), keep: [] },
    measured: {},
  };
}

const reqOut = (r) => (r ? nul({ ...r, lang: undefined }) : null);
function requests(spec) {
  const b = webBoard(spec);
  const layout = S.layoutSummaries(S.summarySources(b, fullRect(spec), fullFrames(spec)));
  return [...S.summaryKeys(b), ...extraKeys].map((key) => ({ key, req: reqOut(S.summaryRequest(b, key, layout)) }));
}

// edits
const editSpec = {
  id: "ed",
  sections: [
    { id: "A", title: "Fresh" },
    { id: "B", title: "Three pairs", summary: sum("AI text B", { pairs: [1, 2, 3].map((i) => ({ ai: `ai${i}`, user: `u${i}`, at: i })) }) },
    { id: "P", title: "Parent" },
    { id: "K", title: "Kid one", parent: "P" },
    { id: "L", title: "Kid two", parent: "P" },
  ],
  cards: [
    note("n0", "# In A", { section: "A" }),
    note("n1", "# AI written", { summary: sum("AI text", { title: "T" }) }),
    note("n2", "plain", { summary: sum("Mine", { edited: true, pairs: [{ ai: "first ai", user: "Mine", at: 5 }], title: "Kept" }) }),
    note("b1", "# In B", { section: "B" }),
    note("p1", "# Direct in P", { section: "P" }),
    note("k1", "# In K", { section: "K" }),
  ],
};
const editOps = [];
for (const key of ["sec:A", "card:n1", "card:n2", "sec:B", "own:P", "sec:P", "card:gone", "sec:K"])
  for (const text of ["", "  ", key === "card:n1" ? "AI text" : key === "card:n2" ? " Mine " : "AI text B", "New **key** text", "  第二版　"])
    editOps.push([{ op: "edit", key, text }]);
editOps.push([
  { op: "edit", key: "card:n1", text: "First edit" },
  { op: "edit", key: "card:n1", text: "Second edit" },
]);
editOps.push([
  { op: "edit", key: "sec:B", text: "x1" },
  { op: "keep", key: "sec:B" },
]);
const keepSpec = withSigs(boards.b);
card(keepSpec, "n1").md = "## Renamed\nso C is pending";
keepSpec.sections.find((s) => s.id === "C").summary.edited = true;
keepSpec.sections.find((s) => s.id === "C").summary.pairs = [{ ai: "a", user: "b", at: 1 }];
const keepOps = ["sec:C", "card:n3", "sec:A", "sec:B", "card:n1", "card:missing"].map((key) => [{ op: "keep", key }]);
function runOps(spec, ops) {
  const b = webBoard(spec);
  const env = { board: () => b, edit: (fn) => (fn(b), true) };
  const after = [];
  for (const o of ops) {
    const before = JSON.stringify(b);
    if (o.op === "edit") S.editSummary(env, o.key, o.text);
    else S.keepSummary(env, o.key);
    after.push({ changed: JSON.stringify(b) !== before, summary: nul(S.summaryOf(b, o.key)) });
  }
  return { ops, after };
}

// requests for the prompt, by hand
const baseReq = { lang: "zh", sig: "s1", input: "i1" };
const cardsM = [
  { title: "调度顺序", text: "  请求按先来先服务排队。\n " },
  { title: "Engine.step", text: "// nano/engine.py:10\ndef step(self):\n    pass" },
];
const pairs3 = [
  { ai: "AI 一", user: "用户 一", at: 3 },
  { ai: "AI 二", user: "用户 二", at: 2 },
  { ai: "AI 三", user: "用户 三", at: 1 },
];
const userExamples = [
  { title: "例子一", content: "内容一", summary: "摘要**一**" },
  { title: "Example {标题} two", content: "has {卡片内容，笔记卡去掉图片和标签，代码卡前 80 行，共最多 6000 字} and {unknown}", summary: "s2" },
];
const promptReqs = [
  { key: "sec:A", title: "调度器", cards: cardsM, ...baseReq },
  { key: "sec:A", title: "调度器", cards: [], ...baseReq },
  { key: "sec:A", title: "With {标题} braces {} {x{y}}", cards: [{ title: "{a}", text: "{标题}" }], ...baseReq },
  { key: "sec:A", title: "Pairs 1", cards: cardsM, pairs: pairs3.slice(0, 1), ...baseReq },
  { key: "sec:A", title: "Pairs 2", cards: cardsM, pairs: pairs3.slice(0, 2), ...baseReq },
  { key: "sec:A", title: "Pairs 3", cards: cardsM, pairs: pairs3, ...baseReq },
  { key: "card:n1", title: "（无标题）", card: "note", untitled: true, cards: [{ title: "（无标题）", text: "Body only" }], ...baseReq },
  { key: "card:n1", title: "（无标题）", card: "note", untitled: true, pairs: pairs3.slice(0, 2), cards: cardsM.slice(0, 1), ...baseReq },
  { key: "card:c1", title: "Engine.step", card: "code", cards: cardsM.slice(1), ...baseReq },
  { key: "own:A", title: "外层", group: true, cards: cardsM, ...baseReq },
  { key: "sec:A", title: "Examples 1", cards: cardsM, examples: userExamples.slice(0, 1), ...baseReq },
  { key: "sec:A", title: "Examples many", cards: cardsM, examples: [...userExamples, ...userExamples, ...userExamples], ...baseReq },
  {
    key: "sec:P",
    title: "外层 Section",
    overview: [
      { title: "子一", text: "  第一个子 Section 的**摘要**。 " },
      { title: "子二", text: "   " },
    ],
    cards: [],
    ...baseReq,
  },
  { key: "sec:P", title: "外层 Section", overview: [{ title: "子一", text: "x" }], cards: cardsM, ...baseReq },
  { key: "sec:P", title: "外层", overview: [{ title: "子一", text: "x" }], cards: [], pairs: pairs3.slice(0, 2), ...baseReq },
];
for (const spec of [boards.c, boards.g, boards.big]) {
  const b = webBoard(spec);
  const layout = S.layoutSummaries(S.summarySources(b, fullRect(spec), fullFrames(spec)));
  for (const key of S.summaryKeys(b)) promptReqs.push(S.summaryRequest(b, key, layout));
}

// replies
const bold5 = (len) => {
  const parts = Array.from({ length: 5 }, (_, i) => `**k${i}**`);
  let t = parts.join(" ");
  while (t.replace(/\*\*/g, "").length < len) t += "x";
  return t;
};
const raws = [
  '{"text":"A **key** idea here.","title":"  Short title "}',
  '```json\n{"text":"Fenced **text**.","title":"Fenced"}\n```',
  "```\nplain fenced\n```",
  "plain text answer with **bold**",
  "",
  "   \n ",
  '{"text":"","title":"Only title"}',
  '{"title":"No text field"}',
  '{"text":42}',
  "null",
  "[1,2]",
  '{"text":"**a** **b**\\n**c**","title":""}',
  bold5(30),
  bold5(120),
  bold5(400),
  bold5(49),
  bold5(50),
  bold5(100),
  "**unclosed and **closed** and ****",
];
const replyReqs = [
  { key: "card:n1", title: "t", card: "note", cards: [], ...baseReq },
  { key: "card:c1", title: "t", card: "code", cards: [], ...baseReq },
  { key: "own:A", title: "t", group: true, cards: [], pairs: pairs3.slice(0, 1), ...baseReq },
  { key: "sec:A", title: "t", cards: [], ...baseReq, input: "" },
  { key: "card:w1", title: "t", card: "other", untitled: true, cards: [], ...baseReq },
];

const allSpecs = Object.values(boards);
const exampleSpecs = [
  {
    id: "x1",
    sections: [
      { id: "A", title: "Edited old", summary: sum("u", { pairs: [{ ai: "a", user: "Old user text", at: 10 }] }) },
      { id: "B", title: "Edited new", summary: sum("u", { pairs: [{ ai: "a", user: "New user text", at: 30 }, { ai: "b", user: "older", at: 1 }] }) },
      { id: "P", title: "Head", summary: sum("u", { pairs: [{ ai: "a", user: "Head text", at: 99 }] }) },
      { id: "K", title: "Kid", parent: "P" },
      { id: "L", title: "Kid 2", parent: "P", summary: sum("u", { pairs: [{ ai: "a", user: "Kid two text", at: 20 }] }) },
      { id: "N", title: "No pairs", summary: sum("u") },
    ],
    cards: [
      note("a1", "# Alpha\n  lots   of\n\nspace\t here  ", { section: "A" }),
      code("a2", "x/y.py", 5, ["x = 1", "  y  =  2"], { section: "A" }),
      note("b1", `# Long\n${"long words ".repeat(60)}`, { section: "B" }),
      note("k1", "# In kid", { section: "K" }),
    ],
  },
  {
    id: "x2",
    sections: [
      { id: "A", title: "Same at", summary: sum("u", { pairs: [{ ai: "a", user: "Tie one", at: 30 }] }) },
      { id: "B", title: "Same at too", summary: sum("u", { pairs: [{ ai: "a", user: "Tie two", at: 30 }] }) },
      { id: "C", title: "Newest", summary: sum("u", { pairs: [{ ai: "a", user: "Newest text", at: 50 }] }) },
    ],
    cards: [note("c1", "# Emoji 😀 title\nbody", { section: "C" })],
  },
];

const cases = {
  now: NOW,
  font: [0, 1, 50, 200, 399, 400, 401, 800, 1190, 1416, 1600, 3000, 10000, 1e6].map((w) => ({ w, font: S.summaryFont(w) })),
  cut: [52, 56, 57, 64, 75, 80, 106.7, 118].map((s) => ({ font: s, cut: S.summaryCut(s) })),
  minZoom: [R(0, 0, 1600, 1000), R(0, 0, 800, 600)].flatMap((v) =>
    [null, R(0, 0, 0, 10), R(0, 0, 100, 100), R(0, 0, 8000, 5000), R(-5e4, -5e4, 1e5, 1e5)].map((c) => ({
      view: { w: v.w, h: v.h },
      content: c,
      zoom: S.summaryMinZoom({ w: v.w, h: v.h }, c),
    })),
  ),
  lang: ["", "abc", "调度", "调度 scheduler", "a 调 bcdefghijklmnop", "Prefill 预填 Decode", "ひらがな", "😀", "㐀x"].map((t) => ({
    text: t,
    lang: S.boardLang(t),
  })),
  cardKinds: boards.g.cards
    .concat(
      [
        note("q1", "\n## H\nbody"),
        note("q2", "  # spaced"),
        note("q3", "####### seven"),
        { id: "q4", kind: "text", md: "# Text heading" },
        { id: "q5", kind: "box", md: "plain box" },
      ],
      boards.a.cards,
    )
    .map((c) => {
      const w = webCard(c);
      return { card: c, untitled: S.untitled(w), unsummarized: S.unsummarized(w) };
    }),
  boards: allSpecs.map((spec) => {
    const b = webBoard(spec);
    const input = S.summarySources(b, rectOf(spec), framesOf(spec));
    return {
      spec,
      plan: planOf(b),
      keys: S.summaryKeys(b),
      sources: { items: input.items.map(srcOut), keep: input.keep },
      requests: requests(spec),
    };
  }),
  sigs: sigBoards.map((spec) => {
    const b = webBoard(spec);
    return {
      spec,
      items: [...S.summaryKeys(b), ...extraKeys].map((key) => ({
        key,
        sig: S.summarySig(b, key) ?? null,
        input: S.summaryInput(b, key) ?? null,
        pending: S.summaryPending(b, key),
      })),
    };
  }),
  layouts: Object.entries(layouts).map(([name, { input, measured }]) => ({
    name,
    input,
    measured,
    plain: layoutOut(S.layoutSummaries(input)),
    withMeasured: layoutOut(S.layoutSummaries(input, new Map(Object.entries(measured)))),
  })),
  edits: { spec: editSpec, runs: editOps.map((ops) => runOps(editSpec, ops)) },
  keeps: { spec: keepSpec, runs: keepOps.map((ops) => runOps(keepSpec, ops)) },
  examples: {
    specs: exampleSpecs,
    runs: [
      { n: 4, but: null },
      { n: 2, but: null },
      { n: 10, but: { board: "x1", key: "sec:B" } },
      { n: 10, but: { board: "x2", key: "sec:B" } },
      { n: 0, but: null },
    ].map((r) => ({
      ...r,
      out: S.summaryExamples(exampleSpecs.map(webBoard), r.n, r.but ?? undefined),
    })),
  },
  prompts: promptReqs.map((r) => ({ req: reqOut(r), ...S.summaryPrompt(r) })),
  replies: replyReqs.flatMap((r) => raws.map((raw) => ({ req: reqOut(r), raw, out: nul(S.readSummaryReply(raw, r, NOW)) }))),
};
fs.writeFileSync(out, `${JSON.stringify(cases, null, 1)}\n`);
console.log(`wrote ${path.relative(root, out)}`);
