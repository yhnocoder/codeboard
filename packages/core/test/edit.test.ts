import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  danglingRefs, emptyBoard, migrateBoard, rebaseSegment, removeCards, removeLinks, replaceCards, retargetCards, shiftBy, stampBorn,
  placeCards, unlinkCard, mergeCodeCards, removeLostCalls, unmergeCard, removeSidenotes, removeStickers, notesOnChangedLines, sidenoteCard, sidenoteToCard,
  arrangeCards, cardIntoSidenote, joinLinks, makeCompare, removeSections, renameTitleRefs, splitLink,
  type Board, type Card, type CodeCard, type Link, type Segment,
} from "../src";

const seg = (id: string, start: number, text: string[]): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git", commit: "x" } });
const code = (id: string, s = seg(`s${id}`, 1, ["pass"])): CodeCard => ({ id, kind: "code", segments: [s] });
const call = (from: string, to: string, line = 1): Link => ({ id: `${from}-${to}`, call: { name: "f", col: 0 }, from: { card: from, seg: `s${from}`, line }, to: { card: to } });
const compare = (id: string, a: string, b: string): Card => ({ id, kind: "compare", cols: [a, b] });

describe("removeCards", () => {
  it("takes links, sidenotes on the card and Card sidenotes pointing at it", () => {
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [code("a"), code("b"), code("p"), code("q"), compare("k", "p", "q")],
      place: { a: { x: 0, y: 0, w: 1 }, b: { x: 0, y: 0, w: 1 }, k: { x: 0, y: 0, w: 1 } },
      links: [call("a", "b"), call("p", "a")],
      sidenotes: [
        { id: "n1", at: { card: "b" }, kind: "text", md: "on b" },
        { id: "n2", at: { card: "a" }, kind: "card", card: "b" },
        { id: "n3", at: { card: "a" }, kind: "text", md: "stays" },
        { id: "n4", at: { card: "q" }, kind: "text", md: "on a Compare column" },
      ],
      stickers: [
        { id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0, on: { card: "b" } } },
        { id: "k2", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0 } },
      ],
    };
    removeCards(b, ["b", "k"]);
    expect(b.cards.map((c) => c.id)).toEqual(["a"]);
    expect(b.links).toEqual([]);
    expect(b.sidenotes.map((n) => n.id)).toEqual(["n3"]);
    expect(Object.keys(b.place)).toEqual(["a"]);
    expect(b.stickers.map((k) => k.id)).toEqual(["k2"]);
  });
});

describe("rebaseSegment", () => {
  const old = seg("s1", 10, ["def f():", "    x = 1", "    y = 2", "    return x + y"]);
  const board = (): Board => ({
    ...emptyBoard("b", "B"),
    cards: [{ ...code("a", { ...old, hidden: [[11, 11]], hl: [12, 13] }) }, code("z")],
    links: [
      { id: "l1", call: { name: "f", col: 0 }, from: { card: "a", seg: "s1", line: 13 }, to: { card: "z" } },
      { id: "l2", from: { card: "z" }, to: { card: "a", seg: "s1", line: 12 } },
    ],
    sidenotes: [
      { id: "n1", at: { card: "a", seg: "s1", lines: [12, 13] }, kind: "text", md: "" },
      { id: "n2", at: { card: "a", seg: "s1", lines: [11, 11] }, kind: "text", md: "" },
    ],
    stickers: [
      { id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: "a", seg: "s1", line: 13 } },
      { id: "k2", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: "a", seg: "s1", line: 11 } },
    ],
  });

  it("moves hidden ranges, highlights, both link ends and sidenotes with the content", () => {
    const b = board();
    // New version: two lines added at the top, x = 1 removed
    rebaseSegment(b, "a", seg("s1", 20, ["import os", "", "def f():", "    y = 2", "    return x + y"]));
    const s = (b.cards[0] as CodeCard).segments[0];
    expect([s.start, s.end]).toEqual([20, 24]);
    expect(s.hidden).toBeUndefined(); // the hidden line is gone
    expect(s.hl).toEqual([23, 24]);
    expect(b.links[0].from).toEqual({ card: "a", seg: "s1", line: 24 });
    expect(b.links[1].to).toEqual({ card: "a", seg: "s1", line: 23 });
    expect(b.links.some((l) => l.lost)).toBe(false);
    expect(b.sidenotes[0].at).toEqual({ card: "a", seg: "s1", lines: [23, 24] });
    expect(b.sidenotes[1].at).toEqual({ card: "a" });
    expect(b.sidenotes[1].lineRemoved).toBe(true);
    expect(b.stickers[0].at).toEqual({ kind: "line", card: "a", seg: "s1", line: 24 });
    expect(b.stickers[1].at).toMatchObject({ kind: "canvas", y: -11, on: { card: "a" } }); // 行没了：挪到卡的右上角
  });

  it("shifts everything when only the position changed", () => {
    const b = board();
    rebaseSegment(b, "a", { ...old, start: 15, end: 18 }, shiftBy(5));
    const s = (b.cards[0] as CodeCard).segments[0];
    expect(s.hidden).toEqual([[16, 16]]);
    expect(s.hl).toEqual([17, 18]);
    expect(b.links[0].from.line).toBe(18);
    expect(b.sidenotes[1].at.lines).toEqual([16, 16]);
  });

  it("works on a Compare column", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a", old), code("c"), { id: "k", kind: "compare", cols: ["a", "c"] }] };
    rebaseSegment(b, "a", { ...old, start: 11, end: 14 }, shiftBy(1));
    expect((b.cards[0] as CodeCard).segments[0].start).toBe(11);
  });
});

describe("lost line ends", () => {
  const old = seg("s1", 10, ["def f():", "    x = 1", "    return x"]);
  it("keeps the end on the card heading and flags it lost when its line is gone; other ends follow the diff", () => {
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [code("a", old), code("z")],
      links: [
        { id: "l1", from: { card: "a", seg: "s1", line: 11 }, to: { card: "z" }, call: { name: "g", col: 4 } },
        { id: "l2", from: { card: "z" }, to: { card: "a", seg: "s1", line: 11 } },
        { id: "l3", from: { card: "z" }, to: { card: "a", seg: "s1", line: 12 } },
      ],
    };
    rebaseSegment(b, "a", seg("s1", 20, ["def f():", "    return x"])); // x = 1 deleted, the rest moved down 10 lines
    expect(b.links[0]).toMatchObject({ from: { card: "a" }, lost: { from: true }, call: { name: "g" } });
    expect(b.links[0].from.line).toBeUndefined();
    expect(b.links[1]).toMatchObject({ to: { card: "a" }, lost: { to: true } });
    expect(b.links[2].to).toEqual({ card: "a", seg: "s1", line: 21 }); // followed by the diff, not by line number
    expect(b.links[2].lost).toBeUndefined();
    expect(danglingRefs(b)).toEqual([]);
  });
});

describe("creation order and graph marks upkeep", () => {
  it("stampBorn numbers new cards in order and never renumbers", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a"), code("b")] };
    stampBorn(b);
    expect([b.born, b.seq]).toEqual([{ a: 0, b: 1 }, 2]);
    b.cards = [code("c"), ...b.cards.reverse()];
    stampBorn(b);
    expect(b.born).toEqual({ a: 0, b: 1, c: 2 });
  });
  it("continues after the highest number when seq is missing", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a"), code("n")], born: { a: 7 }, seq: undefined };
    stampBorn(b);
    expect(b.born).toEqual({ a: 7, n: 8 });
  });
  it("removeCards forgets the order and the mark; replaceCards hands them to the card that takes over", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a"), code("b"), code("m")], born: { a: 0, b: 1 }, seq: 2, marks: { a: { icon: "star" }, b: { letter: "Q" } } };
    replaceCards(b, ["a", "b"], () => ({ card: "m" }));
    expect(b.born).toEqual({ m: 0 });
    expect(b.marks).toEqual({ m: { icon: "star" } });
    removeCards(b, ["m"]);
    expect(b.born).toEqual({});
    expect(b.marks).toBeUndefined();
  });
  it("danglingRefs reports marks and orders of missing cards", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a")], born: { a: 0, x: 1 }, marks: { y: { letter: "B" } } };
    expect(danglingRefs(b)).toEqual(["graph mark for missing card y", "creation order for missing card x"]);
  });
});

describe("retargetCards", () => {
  const star = { pack: "builtin", name: "star" };
  const board = (): Board => ({
    ...emptyBoard("b", "B"),
    cards: [code("a"), code("b"), code("c")],
    place: { a: { x: 0, y: 0, w: 1 }, b: { x: 0, y: 0, w: 1 }, c: { x: 0, y: 0, w: 1 } },
    links: [call("a", "b"), call("c", "a")],
    sidenotes: [
      { id: "n1", at: { card: "a", seg: "sa", lines: [1, 1] }, kind: "text", md: "on a line" },
      { id: "n2", at: { card: "c" }, kind: "card", card: "b" },
    ],
    stickers: [
      { id: "k1", icon: star, at: { kind: "line", card: "a", seg: "sa", line: 1 } },
      { id: "k2", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { card: "b" } } },
      { id: "k3", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { card: "a" } } },
      { id: "k4", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { link: "a-b", t: 0.5 } } },
    ],
  });

  it("moves link ends, every sidenote kind and every sticker kind to the new card (merge a+b → m)", () => {
    const b = board();
    b.cards.push({ id: "m", kind: "code", segments: [seg("sm", 1, ["pass"])] });
    retargetCards(b, ["a", "b"], (at) => ({ card: "m", seg: at.seg ? "sm" : undefined }));
    b.cards = b.cards.filter((c) => c.id !== "a" && c.id !== "b");
    // a→b became m→m and is dropped, together with the sticker bound to it
    expect(b.links.map((l) => [l.from.card, l.to.card])).toEqual([["c", "m"]]);
    expect(b.sidenotes[0].at).toEqual({ card: "m", seg: "sm", lines: [1, 1] });
    expect(b.sidenotes[1]).toMatchObject({ kind: "card", card: "m" });
    expect(b.stickers.map((k) => k.at)).toEqual([
      { kind: "line", card: "m", seg: "sm", line: 1 },
      { kind: "canvas", x: 0, y: 0, on: { card: "m" } },
      { kind: "canvas", x: 0, y: 0, on: { card: "m" } },
    ]);
    delete b.place.a; delete b.place.b; b.place.m = { x: 0, y: 0, w: 1 };
    expect(danglingRefs(b)).toEqual([]);
  });

  it("falls back to the whole card when the line has no new home", () => {
    const b = board();
    retargetCards(b, ["a"], () => ({ card: "c" }));
    expect(b.stickers[0].at).toMatchObject({ kind: "canvas", on: { card: "c" } });
    expect(b.sidenotes[0].at).toEqual({ card: "c", seg: undefined, lines: undefined });
  });
});

describe("danglingRefs", () => {
  it("is empty for a sound board and names every broken reference", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a"), code("a")], place: { a: { x: 0, y: 0, w: 1 }, z: { x: 0, y: 0, w: 1 } }, links: [call("a", "x")] };
    b.stickers = [{ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0, on: { link: "gone", t: 0 } } }];
    expect(danglingRefs(b)).toEqual(["duplicate card id a", "link a-x → missing x", "sticker k on missing gone", "place for missing card z"]);
    expect(danglingRefs({ ...emptyBoard("b", "B"), cards: [code("a")], place: { a: { x: 0, y: 0, w: 1 } } })).toEqual([]);
  });
});

describe("migrateBoard", () => {
  it("refuses a board written by a newer CodeBoard instead of wiping it", () => {
    expect(() => migrateBoard({ version: 7, id: "b", name: "B", cards: [{ id: "a", kind: "code", segments: [] }] })).toThrow(/newer/);
  });
});

// v0.1.6 S3: the board actions keep references through these primitives (see the guard test at the end)
describe("reference upkeep in board actions", () => {
  const sw = (commit: string, start: number, text: string[]): Segment => ({ ...seg("s1", start, text), version: { kind: "git", commit } });
  it("switching a card to another commit (switchCommit) rebases: hidden lines, links, sidenotes and stickers follow the content", () => {
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [code("a", { ...sw("x", 10, ["def f():", "    x = 1", "    return x"]), hidden: [[11, 11]] }), code("z")],
      links: [{ id: "l", from: { card: "z" }, to: { card: "a", seg: "s1", line: 12 } }],
      sidenotes: [{ id: "n", at: { card: "a", seg: "s1", lines: [11, 11] }, kind: "text", md: "" }],
      stickers: [{ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: "a", seg: "s1", line: 12 } }],
    };
    rebaseSegment(b, "a", sw("y", 30, ["# moved", "def f():", "    x = 1", "    return x"]));
    const s = (b.cards[0] as CodeCard).segments[0];
    expect([s.start, s.version]).toEqual([30, { kind: "git", commit: "y" }]);
    expect(s.hidden).toEqual([[32, 32]]);
    expect(b.links[0].to.line).toBe(33);
    expect(b.sidenotes[0].at.lines).toEqual([32, 32]);
    expect(b.stickers[0].at).toMatchObject({ kind: "line", line: 33 });
  });
  it("splitting a snippet into cards (splitSnippet) moves line references to the part holding the line", () => {
    const s = seg("s1", 1, ["def f():", "    pass", "def g():", "    pass"]);
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [code("a", s), code("z")],
      place: { a: { x: 0, y: 0, w: 1 }, z: { x: 0, y: 0, w: 1 } },
      links: [{ id: "l1", call: { name: "f", col: 0 }, from: { card: "a", seg: "s1", line: 4 }, to: { card: "z" } }, { id: "l2", from: { card: "z" }, to: { card: "a" } }],
      sidenotes: [{ id: "n", at: { card: "a", seg: "s1", lines: [2, 2] }, kind: "text", md: "" }],
    };
    const parts = [seg("p1", 1, s.text.slice(0, 2)), seg("p2", 3, s.text.slice(2))];
    const ids = ["c1", "c2"];
    const i = (line?: number) => Math.max(0, parts.findIndex((p) => line !== undefined && line >= p.start && line <= p.end));
    retargetCards(b, ["a"], (at) => ({ card: ids[i(at.line)], seg: at.seg === "s1" && at.line ? parts[i(at.line)].id : undefined }));
    removeCards(b, ["a"]);
    parts.forEach((p, k) => { b.cards.push(code(ids[k], p)); b.place[ids[k]] = { x: 0, y: 0, w: 1 }; });
    expect(b.links.map((l) => [l.from, l.to])).toEqual([[{ card: "c2", seg: "p2", line: 4 }, { card: "z" }], [{ card: "z" }, { card: "c1", seg: undefined, line: undefined }]]);
    expect(b.sidenotes[0].at).toEqual({ card: "c1", seg: "p1", lines: [2, 2] });
    expect(danglingRefs(b)).toEqual([]);
  });
  it("updating a merged card also updates its mergedFrom snapshot, so Unmerge still finds the lines", () => {
    const a = seg("sa", 10, ["def f():", "    return 1"]), c = { ...seg("sc", 12, ["def g():", "    return 2"]) };
    const merged = seg("m1", 10, [...a.text, ...c.text]);
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [{ id: "m", kind: "code", segments: [merged], mergedFrom: [{ card: code("a", a), place: { x: 0, y: 0, w: 1 } }, { card: code("c", c), place: { x: 0, y: 0, w: 1 } }] }],
      place: { m: { x: 0, y: 0, w: 1 } },
    };
    // New version: one line added on top
    rebaseSegment(b, "m", { ...seg("m1", 20, ["import os", ...merged.text]), version: { kind: "git", commit: "y" } });
    const snap = (b.cards[0] as CodeCard).mergedFrom!.map((o) => o.card.segments[0]);
    expect(snap.map((s) => [s.start, s.end, s.version, s.text])).toEqual([
      [21, 22, { kind: "git", commit: "y" }, a.text],
      [23, 24, { kind: "git", commit: "y" }, c.text],
    ]);
  });
  it("removeLinks takes stickers bound to the links; replaceCards keeps Compare columns", () => {
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [code("a"), code("p"), code("q"), compare("k", "p", "q")],
      place: { a: { x: 0, y: 0, w: 1 }, k: { x: 0, y: 0, w: 1 } },
      links: [call("a", "k")],
      stickers: [{ id: "s", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0, on: { link: "a-k", t: 0 } } }],
    };
    const c = structuredClone(b);
    removeLinks(b, ["a-k"]);
    expect([b.links, b.stickers]).toEqual([[], []]);
    replaceCards(c, ["k"], () => ({ card: "p" }));
    c.place.p = { x: 0, y: 0, w: 1 };
    expect(c.cards.map((x) => x.id)).toEqual(["a", "p", "q"]);
    expect(c.links[0].to).toEqual({ card: "p", seg: undefined, line: undefined });
    expect(c.place.k).toBeUndefined();
  });
});

describe("guard: reference upkeep only in core/src/edit.ts", () => {
  // 删卡、删线、换卡、删 Section / Sidenote / Sticker、改叠放顺序都得走 edit.ts 里的操作（removeCards、replaceCards、removeSections、arrangeCards……），
  // 它们一起维护指着这些东西的引用（Link 两端、Sidenote、贴纸、问题的解答、创建顺序、调用图标记）。
  // 规则按「改动的形状」查，不按写法：在 core、白板、插件三处源码里（去掉整行注释后，跨行匹配）找
  //   1. 整个换掉一类东西：x.cards / links / sections / sidenotes / stickers / place = …（含 filter 之后的临时变量再赋回去、换顺序）
  //   2. 原地删、原地换顺序：x.<集合>.splice / pop / shift / sort / reverse / fill / copyWithin(…)，x.<集合>.length = …
  //   3. 删摆放：delete x.place[…]；Object.assign 到这些集合上
  // 不拦：push / unshift（加新东西不会让别的引用悬空；新东西自己的引用由每次 mutate 之后的 danglingRefs 自检、harness 守着），
  // 同一个 id 原地换内容（b.cards[i] = …），以及改单个对象的字段（换 Link 的一端是用户的操作本身）。
  // 允许的文件：edit.ts（引用维护）、migrate.ts（旧文件）、patch.ts（存盘的传输层：按快照的差应用改动、换共享卡的内容，差本身已经是 edit 算好的）
  const ALLOW = new Set(["core/src/edit.ts", "core/src/migrate.ts", "core/src/patch.ts"]);
  const LISTS = "cards|links|sections|sidenotes|stickers";
  const RULES = [
    new RegExp(`\\.(?:${LISTS}|place)\\s*=(?![=>])`, "g"),
    new RegExp(`\\.(?:${LISTS})\\s*\\.\\s*(?:splice|pop|shift|sort|reverse|fill|copyWithin)\\s*\\(`, "g"),
    new RegExp(`\\.(?:${LISTS})\\s*\\.\\s*length\\s*=(?!=)`, "g"),
    /\bdelete\s+[\w$.]*\.place\s*\[/g,
    new RegExp(`Object\\.assign\\(\\s*[\\w$.]+\\.(?:${LISTS}|place)\\b`, "g"),
  ];
  const roots = ["../../core/src", "../../board/src", "../../../extensions/vscode/src"].map((r) => fileURLToPath(new URL(r, import.meta.url)));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const scan = (file: string, text: string): string[] => {
    const src = text.replace(/^\s*(\/\/|\/?\*).*$/gm, (m) => " ".repeat(m.length)); // 整行注释换成空白，行号不变
    const out: string[] = [];
    for (const re of RULES) for (const m of src.matchAll(re)) out.push(`${file}:${src.slice(0, m.index).split("\n").length}: ${m[0].trim()}`);
    return out;
  };
  it("no other file replaces, filters, reorders or deletes from a board's collections", () => {
    const bad: string[] = [];
    for (const r of roots) for (const f of walk(r)) {
      const rel = path.relative(repo, f).split(path.sep).join("/").replace(/^packages\//, "");
      if (!ALLOW.has(rel)) bad.push(...scan(rel, fs.readFileSync(f, "utf8")));
    }
    expect(bad).toEqual([]);
  });
  it("catches the shapes it is meant to catch", () => {
    const hits = scan("x.ts", [
      "b.cards = b.cards.filter((c) => c.id !== id);",
      "const keep = b.links.filter(ok);\nb.links =\n  keep;",
      "parent.sections.splice(0, 1); b.stickers.sort(byId); b.sidenotes.length = 0;",
      "delete b.place[id]; Object.assign(b.place, more);",
      "// b.cards = [] in a comment",
      "b.cards.push(c); b.cards[i] = next; if (b.cards == x) {}",
    ].join("\n"));
    expect(hits.map((h) => h.split(": ")[0])).toEqual(["x.ts:1", "x.ts:3", "x.ts:5", "x.ts:5", "x.ts:5", "x.ts:6", "x.ts:6"]);
  });
  it("no hand-made card copies or merges in packages/board/src: new ids for a copied card come from placeCards / unlinkCard", () => {
    const root = fileURLToPath(new URL("../../board/src", import.meta.url));
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
    const bad: string[] = [];
    for (const f of walk(root)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((t, i) => {
        if (/mergedFrom:\s*orig|mergeOverlapping\(|\bd\.segments\.forEach\(\(s\) => \(s\.id = uid/.test(t)) bad.push(`${path.relative(root, f)}:${i + 1}: ${t.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});


// v0.2 共享卡 / D2：拷卡、拆成副本、合并 / 拆开、删 Sidenote / Sticker、Update 后的复查标记
describe("card copies, unlink, merge and unmerge (core edit, D2)", () => {
  const two = (): Board => ({
    ...emptyBoard("b", "B"),
    cards: [code("a", seg("sa", 1, ["def f():", "    g()"])), code("z")],
    place: { a: { x: 10, y: 20, w: 300, section: "g1", locked: true }, z: { x: 0, y: 0, w: 1 } },
    sections: [{ id: "g1", title: "S", x: 0, y: 0, w: 900, h: 900 }],
    links: [call("a", "z", 2)],
    sidenotes: [{ id: "n1", at: { card: "a", seg: "sa", lines: [2, 2] }, kind: "text", md: "why" }],
  });
  it("placeCards copy: new ids for card, segments and sidenotes; drops section and lock; links stay behind", () => {
    const src = two(), b = emptyBoard("t", "T");
    const r = placeCards(b, [{ card: src.cards[0], place: src.place.a, sidenotes: src.sidenotes }], { copy: true, at: (p) => ({ ...p, x: p.x + 5 }) });
    const id = r.cards.a, c = b.cards[0] as CodeCard;
    expect(id).not.toBe("a");
    expect(c.id).toBe(id);
    expect(c.segments[0].id).toBe(r.segs.sa);
    expect(r.segs.sa).not.toBe("sa");
    expect(b.place[id]).toEqual({ x: 15, y: 20, w: 300 });
    expect(b.sidenotes.map((n) => [n.id !== "n1", n.at])).toEqual([[true, { card: id, seg: r.segs.sa, lines: [2, 2] }]]);
    expect(b.links).toEqual([]);
    expect(danglingRefs(b)).toEqual([]);
    expect((src.cards[0] as CodeCard).segments[0].id).toBe("sa"); // the source is not touched
  });
  it("placeCards linked: same ids, skips cards already on the board", () => {
    const src = two(), b = emptyBoard("t", "T");
    const it = [{ card: src.cards[0], place: src.place.a, sidenotes: src.sidenotes }];
    expect(placeCards(b, it, { copy: false }).cards).toEqual({ a: "a" });
    expect(b.sidenotes.map((n) => n.id)).toEqual(["n1"]);
    expect(placeCards(b, it, { copy: false }).cards).toEqual({});
    expect(b.cards.length).toBe(1);
  });
  it("placeCards brings the links between the placed cards: copies get new link ids and ends, linked cards keep their ids", () => {
    const src = two();
    src.links.push({ id: "out", from: { card: "a" }, to: { card: "elsewhere" } });
    const items = [{ card: src.cards[0], place: src.place.a }, { card: src.cards[1], place: src.place.z }];
    const c = emptyBoard("t", "T");
    const r = placeCards(c, items, { copy: true, links: src.links });
    expect(c.links.map((l) => [l.id !== "a-z", l.from, l.to, l.call?.name])).toEqual([[true, { card: r.cards.a, seg: r.segs.sa, line: 2 }, { card: r.cards.z }, "f"]]);
    expect(danglingRefs(c)).toEqual([]);
    const s = emptyBoard("t", "T");
    placeCards(s, items, { copy: false, links: src.links });
    expect(s.links.map((l) => [l.from, l.to])).toEqual([[{ card: "a", seg: "sa", line: 2 }, { card: "z" }]]);
    // pasting the same linked cards again adds no second arrow
    placeCards(s, items, { copy: false, links: src.links });
    expect(s.links.length).toBe(1);
    expect(src.links.map((l) => l.id)).toEqual(["a-z", "out"]); // the source is not touched
  });
  it("removeLostCalls removes only the call arrows of that call and line whose target is gone", () => {
    const b = two();
    b.links = [
      { ...call("a", "z", 2), id: "gone", lost: { to: true } },
      { ...call("a", "z", 2), id: "live" },
      { ...call("a", "z", 3), id: "otherLine", lost: { to: true } },
      { ...call("a", "z", 2), id: "otherCall", call: { name: "g", col: 0 }, lost: { to: true } },
    ];
    removeLostCalls(b, { card: "a", seg: "sa", line: 2 }, "f");
    expect(b.links.map((l) => l.id)).toEqual(["live", "otherLine", "otherCall"]);
  });
  it("placeCards keeps a Compare with its columns", () => {
    const b = emptyBoard("t", "T");
    const r = placeCards(b, [{ card: code("p") }, { card: code("q") }, { card: compare("k", "p", "q"), place: { x: 0, y: 0, w: 1 } }], { copy: true });
    expect((b.cards[2] as any).cols).toEqual([r.cards.p, r.cards.q]);
    expect(Object.keys(b.place)).toEqual([r.cards.k]);
    expect(danglingRefs(b)).toEqual([]);
  });
  it("unlinkCard gives the card a new id and carries every reference on this board", () => {
    const b = two();
    b.stickers = [{ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: "a", seg: "sa", line: 2 } }];
    b.born = { a: 0, z: 1 }; b.marks = { a: { letter: "Q" } };
    const to = unlinkCard(b, "a");
    expect(b.cards[0].id).toBe(to);
    expect(b.links[0].from.card).toBe(to);
    expect(b.sidenotes[0].at.card).toBe(to);
    expect(b.stickers[0].at).toMatchObject({ card: to });
    expect([b.born[to], b.marks[to]]).toEqual([0, { letter: "Q" }]);
    expect(danglingRefs(b)).toEqual([]);
  });
  it("mergeCodeCards merges into one card, links follow the lines; linked cards are unlinked first so mergedFrom holds the copy", () => {
    const b = two();
    b.cards.push(code("c", seg("sc", 10, ["def h():", "    pass"])));
    b.place.c = { x: 400, y: 0, w: 200 };
    b.links.push({ id: "l2", from: { card: "z" }, to: { card: "c", seg: "sc", line: 11 } });
    const r = mergeCodeCards(b, ["a", "c"], "a", { id: "m", unlink: (id) => id === "c" })!;
    expect(r.id).toBe("m");
    const m = b.cards.find((x) => x.id === "m") as CodeCard;
    expect(m.segments.map((s) => [s.start, s.end])).toEqual([[1, 2], [10, 11]]);
    expect(m.mergedFrom!.map((o) => o.card.id)).toEqual(["a", expect.not.stringMatching(/^c$/)]);
    expect(b.links.map((l) => [l.from.card, l.to.card])).toEqual([["m", "z"], ["z", "m"]]);
    expect(b.cards.some((x) => x.id === "c" || x.id === "a")).toBe(false);
    expect(danglingRefs(b)).toEqual([]);
    // Unmerge brings the originals back, links go back to their cards
    const u = unmergeCard(b, "m")!;
    expect(u.made.length).toBe(2);
    expect(b.links.map((l) => [l.from.card === u.made[0], l.to.card === u.made[1]])).toEqual([[true, false], [false, true]]);
    expect(danglingRefs(b)).toEqual([]);
  });
  it("removeSidenotes / removeStickers", () => {
    const b = two();
    b.stickers = [{ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0 } }];
    removeSidenotes(b, ["n1"]); removeStickers(b, ["k"]);
    expect([b.sidenotes, b.stickers]).toEqual([[], []]);
  });
  it("rebaseSegment with review marks sidenotes on changed lines; notesOnChangedLines counts them beforehand", () => {
    const b = two();
    b.sidenotes.push({ id: "n2", at: { card: "a", seg: "sa", lines: [1, 1] }, kind: "text", md: "same line" });
    const ns = { ...seg("sa", 1, ["def f():", "    g(1)"]), version: { kind: "git" as const, commit: "y" } };
    expect(notesOnChangedLines(b, "a", ns).map((n) => n.id)).toEqual(["n1"]);
    rebaseSegment(b, "a", ns, undefined, { review: "y" });
    expect(b.sidenotes.map((n) => [n.id, n.review])).toEqual([["n1", "y"], ["n2", undefined]]);
  });
});

describe("placing a sidenote on the board", () => {
  const at = { card: "a", seg: "sa", lines: [2, 2] as [number, number] };
  it("makes the matching card: code, paste, text, link; a Card sidenote has none", () => {
    const c = sidenoteCard({ id: "n", at, kind: "code", code: seg("s1", 5, ["x = 1"]), why: "because" }, "c1") as CodeCard;
    expect([c.id, c.kind, c.desc, c.segments[0].text, c.segments[0].id === "s1"]).toEqual(["c1", "code", "because", ["x = 1"], false]);
    const p = sidenoteCard({ id: "n", at, kind: "paste", text: "a\nb", lang: "python", url: "https://x.y" }) as CodeCard;
    expect([p.segments[0].src, p.segments[0].start, p.segments[0].end, p.segments[0].text]).toEqual([{ kind: "free", url: "https://x.y" }, 1, 2, ["a", "b"]]);
    expect(sidenoteCard({ id: "n", at, kind: "text", md: "hi" }, "c2")).toEqual({ id: "c2", kind: "note", md: "hi", bg: true });
    expect(sidenoteCard({ id: "n", at, kind: "link", url: "https://x.y", title: "T" })).toMatchObject({ kind: "web", url: "https://x.y", meta: { title: "T" } });
    expect(sidenoteCard({ id: "n", at, kind: "card", card: "b" })).toBeNull();
  });
  it("swaps the sidenote for an arrow from its line to the new card", () => {
    const b: Board = { ...emptyBoard("b", "B"), cards: [code("a", seg("sa", 1, ["def f():", "    g()"])), code("b")], sidenotes: [{ id: "n9", at, kind: "text", md: "hi" }] };
    sidenoteToCard(b, "n9", "b");
    expect(b.sidenotes).toEqual([]);
    expect(b.links.at(-1)).toMatchObject({ from: { card: "a", seg: "sa", line: 2 }, to: { card: "b" } });
    expect(danglingRefs(b)).toEqual([]);
  });
});

describe("board action edits (core edit)", () => {
  const base = (cards: Card[]): Board => ({ ...emptyBoard("b", "B"), cards, place: Object.fromEntries(cards.map((c, i) => [c.id, { x: i * 10, y: 0, w: 100 }])) });

  it("removeSections hands children and members to the nearest surviving parent", () => {
    const b = base([code("a"), code("c")]);
    const sec = (id: string, parent?: string) => ({ id, title: id, x: 0, y: 0, w: 10, h: 10, ...(parent ? { parent } : {}) });
    b.sections = [sec("top"), sec("mid", "top"), sec("low", "mid"), sec("solo")];
    b.place.a.section = "low";
    b.place.c.section = "solo";
    removeSections(b, ["mid", "low", "solo"]);
    expect(b.sections.map((s) => [s.id, s.parent])).toEqual([["top", undefined]]);
    expect(b.place.a.section).toBe("top");
    expect(b.place.c.section).toBeUndefined();
  });

  it("arrangeCards moves to front/back, and forward/backward past one overlapping card", () => {
    const b = base([code("a"), code("b"), code("c"), code("d")]);
    const ids = () => b.cards.map((c) => c.id).join("");
    arrangeCards(b, ["a"], "forward", (id) => id === "c");
    expect(ids()).toBe("bcad");
    arrangeCards(b, ["a"], "front", () => true);
    expect(ids()).toBe("bcda");
    arrangeCards(b, ["a"], "backward", (id) => id === "b");
    expect(ids()).toBe("abcd");
    arrangeCards(b, ["c"], "back", () => true);
    expect(ids()).toBe("cabd");
  });

  it("splitLink and joinLinks are inverses", () => {
    const b = base([code("a"), code("b")]);
    b.links = [{ id: "l", from: { card: "a" }, to: { card: "b" }, rpc: { mech: "shm" } }];
    placeCards(b, [{ card: { id: "m", kind: "note", md: "m", bg: true, msg: {} }, place: { x: 0, y: 0, w: 50 } }], { copy: false });
    splitLink(b, "l", "m", "l2");
    expect(b.links.map((l) => [l.id, l.from.card, l.to.card, l.style?.head?.end, !!l.rpc])).toEqual([["l", "a", "m", false, true], ["l2", "m", "b", undefined, true]]);
    expect(danglingRefs(b)).toEqual([]);
    joinLinks(b, "l", "l2", "m");
    expect(b.links.map((l) => [l.id, l.from.card, l.to.card, l.style])).toEqual([["l", "a", "b", undefined]]);
    expect(b.cards.map((c) => c.id)).toEqual(["a", "b"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("sidenoteToCard swaps the note for a linked card; cardIntoSidenote goes back", () => {
    const b = base([code("a")]);
    b.sidenotes = [{ id: "n", at: { card: "a", seg: "sa", lines: [1, 1] }, kind: "text", md: "hi" }];
    placeCards(b, [{ card: { id: "t", kind: "note", md: "hi", bg: false }, place: { x: 0, y: 0, w: 50 } }], { copy: false });
    sidenoteToCard(b, "n", "t");
    expect(b.sidenotes).toEqual([]);
    expect(b.links).toMatchObject([{ from: { card: "a", seg: "sa", line: 1 }, to: { card: "t" } }]);
    cardIntoSidenote(b, "t", { id: "n2", at: { card: "a" }, kind: "text", md: "hi" });
    expect(b.cards.map((c) => c.id)).toEqual(["a"]);
    expect(b.links).toEqual([]);
    expect(b.sidenotes.map((n) => n.id)).toEqual(["n2"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("makeCompare unplaces the columns and moves their card stickers onto the compare", () => {
    const b = base([code("p"), code("q")]);
    b.stickers = [{ id: "s", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 1, y: 2, on: { card: "q" } } }];
    makeCompare(b, "k", ["p", "q"], { x: 0, y: 0, w: 300 });
    expect(Object.keys(b.place)).toEqual(["k"]);
    expect(b.stickers[0].at).toEqual({ kind: "canvas", x: 1, y: 2, on: { card: "k" } });
    expect(danglingRefs(b)).toEqual([]);
  });

  it("renameTitleRefs rewrites [[old]] in notes, descriptions and text sidenotes", () => {
    const b = base([{ id: "n", kind: "note", md: "see [[ Foo ]] and [[foo.bar]]", bg: false }, { ...code("a"), desc: "[[foo]]" }]);
    b.sidenotes = [{ id: "s", at: { card: "a" }, kind: "text", md: "[[FOO]]" }];
    renameTitleRefs(b, "foo", "Baz");
    expect((b.cards[0] as { md: string }).md).toBe("see [[Baz]] and [[foo.bar]]");
    expect(b.cards[1].desc).toBe("[[Baz]]");
    expect((b.sidenotes[0] as { md: string }).md).toBe("[[Baz]]");
  });
});
