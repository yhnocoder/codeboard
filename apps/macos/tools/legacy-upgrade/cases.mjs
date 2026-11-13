// The importer's upgrade of old board files (Sources/CodeBoardModel/LegacyUpgrade.swift) is a port of the extension's
// migrate.ts from version 13 on. This writes what migrate.ts itself makes of a set of old files, as pairs the Swift tests
// (LegacyUpgradeTests) compare the port against: Tests/CodeBoardModelTests/Fixtures/upgrade.json. Run it again when
// migrate.ts or the cases change:
//   node apps/macos/tools/legacy-upgrade/cases.mjs
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
fs.writeFileSync(
  entry,
  `export { migrateBoard, migrateSharedCard } from ${JSON.stringify(path.join(root, "packages/core/src/migrate.ts"))};\n`,
);
const bundle = path.join(tmp, "migrate.mjs");
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const { migrateBoard, migrateSharedCard } = await import(pathToFileURL(bundle).href);

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
  "<div>\n<mark>html block</mark>\n</div>\n\n<mark>after html</mark>",
  "<mark>starts a line</mark> as text",
  "para\n    <mark>lazy, not code</mark>\n\n    <mark>indented code</mark>",
  "~~~~\n<mark>tilde</mark>\n~~~\nstill <mark>in</mark>\n~~~~\n<mark>out</mark>",
  "<mark></mark> empty and <mark>  </mark> blank and <mark>multi\nline</mark>",
  "中文 <mark>高亮</mark> 混排",
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
  "&amp; &#123; & plain :emoji: and a:b:c and http://x.y",
  "   ",
  "",
  "+ plus\n-dash\n>gt",
  "中文 标题\n第二行",
];

let n = 0;
const card = (extra) => ({ id: `c${++n}`, kind: "note", md: "x", look: "note", ...extra });
const cards = [];
for (const md of marks) {
  cards.push(card({ md }));
  cards.push(card({ look: "text", md, desc: md }));
}
for (const md of plains)
  for (const level of [0, 1, 2, 3]) for (const bold of [false, true]) cards.push(card({ look: "freetext", md, level, bold }));
cards.push(card({ look: "freetext", md: "sized", level: 1, fs: 52 }));
cards.push(card({ look: "freetext", md: "small", fs: 8 }));
for (const size of ["title", "heading", "body", undefined])
  for (const bold of [false, true])
    for (const md of [
      "One plain line",
      "One\n\nTwo plain paras",
      "line one\nline two",
      "# already a heading",
      "- a list",
      "has *stars* in it",
      "",
      "  padded  ",
    ])
      cards.push(card({ look: "text", md, ...(size && { size }), ...(bold && { bold }) }));
for (const fs of [undefined, 9, 18, 24, 30.3, 300]) cards.push(card({ look: "mark", md: "a mark", hand: "orange", ...(fs && { fs }) }));
cards.push(card({ look: "box", md: "a box", fill: "blue" }));
cards.push(card({ look: "box", md: "a <mark>box</mark>", size: "title", bold: true }));
cards.push(card({ look: "note", md: "a note", size: "title", fs: 20 }));
cards.push({
  id: "code1",
  kind: "code",
  desc: "described <mark>here</mark>",
  segments: [],
  mergedFrom: [{ card: { id: "m1", kind: "note", look: "note", md: "merged <mark>m</mark>" } }],
});

const place = Object.fromEntries(cards.map((c, i) => [c.id, { x: i * 10, y: 0, w: 300, ...(c.look === "box" && { h: 90 }) }]));
const boardAt = (version) => ({
  version,
  id: `b${version}`,
  name: `B${version}`,
  cards: structuredClone(cards),
  place: structuredClone(place),
  links: [],
  sections: [],
  sidenotes: [],
  stickers: [],
});

const result = { boards: [], shared: [] };
for (const version of [13, 14, 15, 16]) {
  const input = boardAt(version);
  // fields the importer reads off a card and its place, as migrate.ts leaves them
  const b = migrateBoard(structuredClone(input));
  result.boards.push({
    from: version,
    input,
    cards: b.cards.map((c) => pick(c, ["id", "kind", "look", "md", "desc", "fs", "wrap", "fill", "mergedFrom"])),
    place: Object.fromEntries(Object.entries(b.place).map(([id, p]) => [id, { h: p.h ?? null }])),
  });
}
for (const version of [13, 15]) {
  for (const c of [card({ look: "box", md: "shared <mark>box</mark>" }), card({ look: "text", md: "Shared title", size: "title" })]) {
    const input = { version, card: c };
    const sc = migrateSharedCard(structuredClone(input));
    result.shared.push({ from: version, input, card: pick(sc.card, ["id", "kind", "look", "md", "fs", "wrap", "fill"]) });
  }
}
fs.writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${path.relative(root, out)}: ${result.boards.length} boards of ${cards.length} cards, ${result.shared.length} shared`);

function pick(o, keys) {
  const r = {};
  for (const k of keys) r[k] = o[k] === undefined ? null : k === "mergedFrom" ? o[k].map((m) => ({ md: m.card?.md ?? null })) : o[k];
  return r;
}
