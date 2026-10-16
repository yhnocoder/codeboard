import { describe, expect, it } from "vitest";
import {
  brokenBy, emptyBoard, rebaseSegment, removeCards, shiftBy, splitCompares,
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
