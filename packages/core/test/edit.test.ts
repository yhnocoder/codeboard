import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brokenBy, danglingRefs, emptyBoard, migrateBoard, rebaseSegment, removeCards, removeLinks, replaceCards, retargetCards, shiftBy, splitCompares,
  type Board, type Card, type CodeCard, type Link, type Segment,
} from "../src";

const seg = (id: string, start: number, text: string[]): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git", commit: "x" } });
const code = (id: string, s = seg(`s${id}`, 1, ["pass"])): CodeCard => ({ id, kind: "code", segments: [s] });
const call = (from: string, to: string, line = 1): Link => ({ id: `${from}-${to}`, kind: "call", from: { card: from, seg: `s${from}`, line }, to: { card: to } });
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
        { id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "card", card: "b" } },
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
      { id: "l1", kind: "call", from: { card: "a", seg: "s1", line: 13 }, to: { card: "z" } },
      { id: "l2", kind: "plain", from: { card: "z" }, to: { card: "a", seg: "s1", line: 12 } },
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
    expect(b.sidenotes[0].at).toEqual({ card: "a", seg: "s1", lines: [23, 24] });
    expect(b.sidenotes[1].at).toEqual({ card: "a" });
    expect(b.sidenotes[1].lineRemoved).toBe(true);
    expect(b.stickers[0].at).toEqual({ kind: "line", card: "a", seg: "s1", line: 24 });
    expect(b.stickers[1].at).toEqual({ kind: "card", card: "a" });
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

describe("brokenBy (Compare stays in one flow)", () => {
  // R → X → cl, R → Y → cr; cl and cr merged into Compare k
  const board = (): Board => ({
    ...emptyBoard("b", "B"),
    cards: [code("R"), code("X"), code("Y"), code("cl"), code("cr"), compare("k", "cl", "cr")],
    links: [call("R", "X", 1), call("R", "Y", 2), call("X", "cl"), call("Y", "cr")],
  });

  it("is fine for the board as built", () => {
    expect(splitCompares(board()).size).toBe(0);
  });
  it("refuses deleting a link that would split the Compare", () => {
    const before = board();
    const after = { ...before, links: before.links.filter((l) => l.id !== "R-X") };
    expect(brokenBy(after, () => before)).toMatch(/Compare/);
  });
  it("refuses deleting the shared ancestor card", () => {
    const before = board();
    const after = structuredClone(before);
    removeCards(after, ["R"]);
    expect(brokenBy(after, () => before)).toMatch(/Compare/);
  });
  it("allows changes that keep both columns together", () => {
    const before = board();
    const after = structuredClone(before);
    removeCards(after, ["Y"]); // cr is no longer in any tree, cl still is: not counted as a split
    expect(brokenBy(after, () => before)).toBeNull();
    const after2 = { ...before, links: before.links.filter((l) => l.id !== "X-cl") };
    expect(brokenBy(after2, () => before)).toBeNull();
  });
  it("does not block edits on a board that was already split", () => {
    const before = board();
    before.links = before.links.filter((l) => l.id !== "R-X");
    const after = { ...before, links: before.links.filter((l) => l.id !== "Y-cr") };
    expect(brokenBy(before, () => before)).toBeNull();
    expect(brokenBy(after, () => before)).toBeNull();
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
      { id: "k2", icon: star, at: { kind: "card", card: "b" } },
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
      { kind: "card", card: "m" },
      { kind: "canvas", x: 0, y: 0, on: { card: "m" } },
    ]);
    delete b.place.a; delete b.place.b; b.place.m = { x: 0, y: 0, w: 1 };
    expect(danglingRefs(b)).toEqual([]);
  });

  it("falls back to the whole card when the line has no new home", () => {
    const b = board();
    retargetCards(b, ["a"], () => ({ card: "c" }));
    expect(b.stickers[0].at).toEqual({ kind: "card", card: "c" });
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
    expect(() => migrateBoard({ version: 5, id: "b", name: "B", cards: [{ id: "a", kind: "code", segments: [] }] })).toThrow(/newer/);
  });
});

// v0.1.6 S3: the board actions keep references through these primitives (see the guard test at the end)
describe("reference upkeep in board actions", () => {
  const sw = (commit: string, start: number, text: string[]): Segment => ({ ...seg("s1", start, text), version: { kind: "git", commit } });
  it("switching a card to another commit (switchCommit) rebases: hidden lines, links, sidenotes and stickers follow the content", () => {
    const b: Board = {
      ...emptyBoard("b", "B"),
      cards: [code("a", { ...sw("x", 10, ["def f():", "    x = 1", "    return x"]), hidden: [[11, 11]] }), code("z")],
      links: [{ id: "l", kind: "plain", from: { card: "z" }, to: { card: "a", seg: "s1", line: 12 } }],
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
      links: [{ id: "l1", kind: "call", from: { card: "a", seg: "s1", line: 4 }, to: { card: "z" } }, { id: "l2", kind: "plain", from: { card: "z" }, to: { card: "a" } }],
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

describe("guard: the board never drops cards or links by hand", () => {
  // 引用维护只在 core/edit.ts：删卡 removeCards、换卡 replaceCards / retargetCards、删线 removeLinks
  it("no direct b.cards / b.links filter or splice in packages/board/src", () => {
    const root = fileURLToPath(new URL("../../board/src", import.meta.url));
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
    const bad: string[] = [];
    for (const f of walk(root)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((t, i) => {
        if (/\.(cards|links)\s*=\s*[^;=]*\.filter\(|\.(cards|links)\.splice\(/.test(t)) bad.push(`${path.relative(root, f)}:${i + 1}: ${t.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
