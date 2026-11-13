// What the extension's packages/core/src/migrate.ts itself makes of a set of old board and card library files, for the
// tests of its Swift port (Sources/CodeBoardModel/LegacyUpgrade.swift, Tests/CodeBoardModelTests/LegacyUpgradeTests.swift)
// to compare against. Writes Tests/CodeBoardModelTests/Fixtures/upgrade.json; run it again when migrate.ts or the cases
// change (from the repository root, after npm ci):
//   node apps/macos/tools/legacy-upgrade/cases.mjs
// The cases are made up for the purpose, not taken from anyone's boards.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = import.meta.dirname;
const root = path.resolve(here, "../../../..");
const out = path.resolve(here, "../../Tests/CodeBoardModelTests/Fixtures/upgrade.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-upgrade-"));
const entry = path.join(tmp, "entry.ts");
const migrate = JSON.stringify(path.join(root, "packages/core/src/migrate.ts"));
fs.writeFileSync(entry, `export { migrateBoard, migrateSharedCard, sharedCardRefs } from ${migrate};\n`);
const bundle = path.join(tmp, "migrate.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const { migrateBoard, migrateSharedCard, sharedCardRefs } = await import(pathToFileURL(bundle).href);
fs.rmSync(tmp, { recursive: true, force: true });

/** Markdown that `<mark>` may or may not become `==` in */
const marks = [
  "a <mark>hit</mark> b",
  "<MARK>caps</MARK> and <mark> spaced </mark>",
  "two <mark>a</mark><mark>b</mark> in a row",
  "an escaped \\<mark>no</mark> and a double \\\\<mark>yes</mark>",
  "already ==x== and <mark>a==b</mark> and <mark>=lead</mark> and <mark>trail\\</mark> and =<mark>t</mark>",
  "`code <mark>no</mark>` and <mark>yes</mark> and ``two <mark>no</mark> ``",
  "math $x <mark>no</mark>$ and $$y <mark>no</mark>$$ and $5 <mark>yes</mark>",
  "dollars $5 and $6\n\nnext <mark>yes</mark> $",
  "```\n<mark>in a fence</mark>\n```\n\n<mark>after</mark>",
  "- item\n  ```\n  <mark>fenced in a list</mark>\n  ```\n- <mark>item mark</mark>",
  "> quote <mark>q</mark>\n> ```\n> <mark>fence in quote</mark>\n> ```\n<mark>out</mark>",
  "1. one\n   ~~~\n   <mark>in</mark>\n   ~~~\n2. <mark>two</mark>",
  "<div>\n<mark>html block</mark>\n</div>\n\n<mark>after html</mark>",
  "<mark>starts a line</mark> as text",
  "para\n    <mark>lazy, not code</mark>\n\n    <mark>indented code</mark>",
  "~~~~\n<mark>tilde</mark>\n~~~\nstill <mark>in</mark>\n~~~~\n<mark>out</mark>",
  "<mark></mark> empty and <mark>  </mark> blank and <mark>multi\nline</mark>",
  "unclosed `tick <mark>m</mark> and \\$ <mark>n</mark> $ open",
  "中文 <mark>高亮</mark> 混排 👍 <mark>emoji 🎉</mark>",
  "no marks at all",
];
/** An old Free Text's plain text */
const plains = [
  "Big title",
  "two lines\nof text",
  "  leading spaces and  double  spaces",
  "a\n\n\nblank lines between\n",
  "# not a heading\n- not a list\n> not a quote\n1. not a number\n2) nor this",
  "*stars* _under_ `ticks` ~tilde~ $dollar$ [link] <tag> ^sup^ {brace} |pipe| ==mark== a\\b",
  "&amp; &#123; & plain :emoji: and a:b:c and 中:文: and http://x.y",
  "trailing spaces   \n\t tab lead",
  "   ",
  "",
  "+ plus\n-dash\n>gt",
  "中文 标题\n第二行",
];
/** An old Text's Markdown, at each size */
const texts = [
  "One plain line",
  "One\n\nTwo plain paras",
  "line one\nline two",
  "# already a heading",
  "- a list",
  "has *stars* in it",
  "",
  "  padded  ",
  "| a | b |\n|---|---|",
];

let n = 0;
const note = (extra) => ({ id: `c${++n}`, kind: "note", md: "x", look: "note", ...extra });
const cards = [];
for (const md of marks) {
  cards.push(note({ md }));
  cards.push(note({ look: "text", md, desc: md }));
  cards.push(note({ look: "freetext", md }));
}
for (const md of plains)
  for (const level of [undefined, 0, 1, 2, 3])
    for (const bold of [false, true]) cards.push(note({ look: "freetext", md, ...(level !== undefined && { level }), bold }));
cards.push(note({ look: "freetext", md: "sized", level: 1, fs: 52 }));
cards.push(note({ look: "freetext", md: "small", fs: 8 }));
cards.push(note({ look: "freetext", md: "huge", level: 2, fs: 500 }));
for (const size of ["title", "heading", "body", undefined])
  for (const bold of [false, true])
    for (const md of texts) cards.push(note({ look: "text", md, ...(size && { size }), ...(bold && { bold }) }));
for (const fs of [undefined, 9, 18, 20, 24, 30.3, 300])
  cards.push(note({ look: "mark", md: "a mark", hand: "orange", weight: "bold", ...(fs && { fs }) }));
cards.push(note({ id: "box1", look: "box", md: "a box", fill: "blue" }));
cards.push(note({ id: "box2", look: "box", md: "a <mark>box</mark>", size: "title", bold: true }));
cards.push(note({ look: "note", md: "a note", size: "title", fs: 20, fill: "pink", wrap: true }));
cards.push(note({ id: "titled", look: "note", md: "# Heading **bold** `code`\n\nbody", title: "" }));
cards.push(note({ id: "untitledmark", look: "mark", md: "" }));
cards.push(note({ id: "plainnote", look: "note", md: "![shot](assets/a.png)\n\n> &nbsp;quoted \\*star\\* &amp; more" }));
cards.push({
  id: "code1",
  kind: "code",
  desc: "described <mark>here</mark>",
  tilt: false,
  bg: true,
  keepOld: false,
  segments: [
    {
      id: "s1",
      src: { kind: "repo", repo: "" },
      path: "pkg/engine.py",
      start: 10,
      end: 20,
      text: Array.from({ length: 11 }, (_, i) => `line ${10 + i}`),
      version: { kind: "git", commit: "0123456789abcdef" },
      symbol: { qual: "Engine.step", kind: "function" },
      hl: [
        [11, 12],
        [18, 19],
      ],
    },
    {
      id: "s2",
      src: { kind: "repo", repo: "" },
      path: "pkg/sched.py",
      lang: "python",
      start: 1,
      end: 3,
      text: ["a", "b", "c"],
      version: { kind: "git", commit: "fedcba9876543210" },
    },
  ],
  mergedFrom: [
    { card: { id: "m1", kind: "note", look: "note", md: "merged <mark>m</mark>" }, place: { x: 0, y: 0, w: 1 } },
    { card: { id: "m2", kind: "code", bg: true, segments: [], desc: "<mark>d</mark>" }, place: { x: 0, y: 0, w: 1 } },
  ],
});
cards.push({
  id: "code2",
  kind: "code",
  active: "v1",
  variants: [
    { id: "up", name: "Upstream", from: { kind: "upstream" } },
    {
      id: "v1",
      name: "Mine",
      from: { kind: "worktree" },
      segs: [
        {
          id: "s3",
          src: { kind: "repo", repo: "" },
          path: "x.py",
          start: 1,
          end: 9,
          text: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
          version: { kind: "none" },
          hl: [[2, 3]],
        },
      ],
    },
  ],
  segments: [
    {
      id: "s3",
      src: { kind: "repo", repo: "" },
      path: "x.py",
      lang: "python",
      start: 1,
      end: 9,
      text: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      version: { kind: "none" },
    },
  ],
});
cards.push({
  id: "code3",
  kind: "code",
  segments: [
    {
      id: "s4",
      src: { kind: "free" },
      path: "",
      lang: "plaintext",
      start: 1,
      end: 1,
      text: [""],
      version: { kind: "none" },
    },
  ],
});
cards.push({ id: "img1", kind: "image", src: "a.png", loop: false, alt: "An image" });
cards.push({ id: "web1", kind: "web", url: "https://www.example.org/page", meta: { title: "" } });
cards.push({ id: "web2", kind: "web", url: "not a url", meta: { title: "Example <mark>t</mark>" } });
cards.push({ id: "links1", kind: "links", items: [{ id: "i1", url: "https://example.org" }] });
cards.push({ id: "sub1", kind: "board", board: "bother", pcols: 1 });
cards.push({ id: "sub2", kind: "board", board: "bother", pcols: 2 });
cards.push({ id: "cmp", kind: "compare", cols: ["code1", "code2"] });
cards.push({ id: "shared1", kind: "shared" });
cards.push({ id: "shelved", kind: "note", look: "box", md: "on the shelf" });

const place = Object.fromEntries(
  cards
    .filter((c) => c.id !== "shelved")
    .map((c, i) => [c.id, { x: i * 10, y: 0, w: 300, ...((c.look === "box" || c.kind === "image") && { h: 90 }) }]),
);
place.code1.w = 500;

const segLine = (card, seg, line) => ({ kind: "line", card, seg, line });
const board = (version) => ({
  version,
  id: `b${version}`,
  name: `B${version}`,
  cards: structuredClone(cards),
  place: structuredClone(place),
  links: [
    { id: "l1", from: { card: "code1", seg: "s1", line: 14 }, to: { card: "c1" } },
    { id: "l2", from: { card: "c1", sub: "x" }, to: { card: "sub1", sub: "y" }, lost: { to: true } },
    { id: "l3", from: { card: "c1" }, to: { card: "c2" }, gen: true, call: { name: "f", col: 0 }, back: false },
    { id: "l4", from: { card: "c1" }, to: { card: "c2" }, style: { dash: false }, lost: { from: false, to: true } },
  ],
  sections: [{ id: "sec1", x: 0, y: 0, w: 10, h: 10 }, { id: "sec2", title: null, x: 0, y: 0, w: 10, h: 10 }],
  sidenotes: [
    { id: "n1", kind: "link", at: { card: "c1" }, url: "https://example.org/a b", title: "A *title* [x]" },
    { id: "n2", kind: "link", at: { card: "c1" }, url: "https://example.org/(p)" },
    { id: "n3", kind: "link", at: { card: "c1" }, url: "https://example.org", title: "" },
    { id: "n4", kind: "paste", at: { card: "c1" }, text: "x = 1\ny = 2", lang: "python", url: "https://gist" },
    { id: "n5", kind: "paste", at: { card: "c1" }, text: "plain" },
    { id: "n6", kind: "card", at: { card: "c1" }, card: "titled", why: "see this" },
    { id: "n7", kind: "card", at: { card: "c1" }, card: "untitledmark" },
    { id: "n8", kind: "card", at: { card: "c1" }, card: "shared1" },
    { id: "n9", kind: "card", at: { card: "c1" }, card: "code1" },
    { id: "n10", kind: "card", at: { card: "c1" }, card: "missing" },
    { id: "n11", kind: "text", at: { card: "code1", seg: "s1", lines: [13, 17] }, md: "on <mark>lines</mark>" },
    { id: "n12", kind: "text", at: { card: "code1", seg: "s1", lines: [19, 25] }, md: "past the end", boardOnly: false },
    { id: "n13", kind: "text", at: { card: "code2", seg: "s3", lines: [4, 4] }, md: "on v1", variant: "v1" },
    { id: "n14", kind: "text", at: { card: "code2", seg: "s3", lines: [6, 6] }, md: "upstream", variant: "up" },
    { id: "n15", kind: "code", at: { card: "c1" }, code: { id: "s9", src: { kind: "free" }, path: "", start: 1, end: 1, text: ["z"], version: { kind: "none" } } },
    { id: "n16", kind: "text", at: { card: "code1", seg: "s1", lines: [12, 12] }, md: "local", boardOnly: true },
    { id: "n17", kind: "text", at: { card: "c1" }, md: "x", q: { at: 5, done: false } },
  ],
  stickers: [
    { id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "card", card: "c1" } },
    { id: "k2", icon: { pack: "builtin", name: "flag" }, at: { kind: "card", card: "c1" } },
    { id: "k3", icon: { pack: "builtin", name: "star" }, at: { kind: "card", card: "code1" } },
    { id: "k4", icon: { pack: "emoji", name: "🔥" }, at: { kind: "card", card: "nowhere" } },
    { id: "k5", icon: { pack: "builtin", name: "check" }, at: { kind: "card", card: "code2" } },
    { id: "q1", icon: { pack: "builtin", name: "question" }, at: segLine("code1", "s1", 11), q: { md: "why <mark>this</mark>?", at: 100, answer: "titled" } },
    { id: "q2", icon: { pack: "builtin", name: "question" }, at: segLine("code1", "s1", 16), q: { md: "and this", at: 101, done: true } },
    { id: "q3", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 100.4, y: 50, size: 40 } },
    { id: "q4", icon: { pack: "emoji", name: "🤔" }, at: { kind: "canvas", x: 10, y: 10, on: { card: "c2" } }, q: { md: "on a card", at: 102, answer: "missing" } },
    { id: "q5", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 0, y: 0, on: { link: "l1", t: 0.5 } }, q: { at: 103 } },
    { id: "q6", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 7, y: 9, on: { card: "gone" } }, q: { md: "gone card", at: 104, answer: "shared1" } },
    { id: "q7", icon: { pack: "builtin", name: "question" }, at: segLine("gone", "s1", 3), q: { md: "dropped" } },
    { id: "q8", icon: { pack: "builtin", name: "question" }, at: segLine("shared1", "sx", 3), q: { md: "on a library card", at: 105 } },
    { id: "q9", icon: { pack: "builtin", name: "question" }, at: segLine("code1", "s1", 20), q: { md: "next to the end", at: 106, done: false } },
    { id: "q10", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 1, y: 2, on: { link: "nolink", t: 0 } }, q: { at: 107 } },
    { id: "k6", icon: { pack: "builtin", name: "zap" }, at: { kind: "canvas", x: 1, y: 2, on: { link: "l1", t: 0.3 } }, q: undefined },
  ],
  shelf: [
    {
      id: "e1",
      at: 1000,
      place: { shelved: { x: 0, y: 0, w: 200, h: 50, mh: 48 } },
      sections: [],
      links: [{ id: "l9", from: { card: "shelved" }, to: { card: "c1" } }],
      stickers: [
        { id: "q11", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 3, y: 3, on: { card: "shelved" } }, q: { md: "shelved <mark>q</mark>", at: 108 } },
        { id: "q12", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 3, y: 3, on: { link: "l9", t: 0.5 } }, q: { md: "on its arrow", at: 109 } },
        { id: "k7", icon: { pack: "builtin", name: "heart" }, at: { kind: "canvas", x: 3, y: 3, on: { card: "shelved" } } },
      ],
    },
  ],
  hideAllComments: null,
  cam: { x: 1, y: 2, z: 1 },
});

/** A library file: a card and the sidenotes that travel with it */
const shared = (version, card) => ({
  version,
  card: structuredClone(card),
  sidenotes: [
    { id: "sn1", kind: "link", at: { card: card.id }, url: "https://example.org", title: "T" },
    { id: "sn2", kind: "paste", at: { card: card.id }, text: "a\nb" },
    { id: "sn3", kind: "card", at: { card: card.id }, card: "elsewhere" },
    { id: "sn4", kind: "text", at: { card: card.id }, md: "<mark>m</mark>", boardOnly: false },
  ],
});
const sharedCards = [
  note({ id: "shared1", look: "mark", md: "Library <mark>mark</mark>", fs: 30 }),
  note({ id: "shared2", look: "freetext", md: "Free\ntext", level: 2 }),
  note({ id: "shared3", look: "note", md: "# The title\n\n<mark>body</mark>", desc: "<mark>d</mark>" }),
  { id: "shared4", kind: "code", bg: true, tilt: false, segments: [{ id: "s1", src: { kind: "free" }, path: "", start: 1, end: 1, text: ["x"], version: { kind: "none" } }] },
];

/** The ids migrate.ts makes up at random are made from the ids next to them in the port: the answer to question sticker
 *  <k> is a-<k>, and the code of pasted sidenote <n> is s-<n> */
function portIds(sidenotes, input) {
  const pasted = new Set(input.filter((x) => x.kind === "paste").map((x) => x.id));
  for (const s of sidenotes) {
    for (const a of s.q?.answers ?? []) a.id = `a-${s.id}`;
    if (pasted.has(s.id) && s.kind === "code") s.code.id = `s-${s.id}`;
  }
}

const result = { boards: [], shared: [], titled: [] };
for (const version of [13, 14, 15, 16, 17]) {
  const input = board(version);
  const output = migrateBoard(structuredClone(input));
  portIds(output.sidenotes, input.sidenotes);
  result.boards.push({ name: `board v${version}`, input, output });
  for (const card of sharedCards) {
    const sc = shared(version, card);
    const o = migrateSharedCard(structuredClone(sc));
    portIds(o.sidenotes, sc.sidenotes);
    result.shared.push({ name: `${card.id} v${version}`, input: sc, output: o });
  }
  // the references the upgrade could only write with a placeholder title, once the library cards are in
  const files = Object.fromEntries(sharedCards.map((c) => [c.id, migrateSharedCard(shared(version, c))]));
  const b = migrateBoard(structuredClone(input));
  portIds(b.sidenotes, input.sidenotes);
  const inflated = { ...b, cards: b.cards.map((c) => (c.kind === "shared" ? (files[c.id]?.card ?? c) : c)) };
  sharedCardRefs(structuredClone(input))?.(inflated);
  // its board and library files are the cases above of the same version
  result.titled.push({ name: `board v${version}`, sidenotes: inflated.sidenotes });
}
// one case to a line
const lines = Object.entries(result).map(([k, list]) => `"${k}": [\n${list.map((c) => JSON.stringify(c)).join(",\n")}\n]`);
fs.writeFileSync(out, `{\n${lines.join(",\n")}\n}\n`);
console.log("wrote", path.relative(process.cwd(), out));
