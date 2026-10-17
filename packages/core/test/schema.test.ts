import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BoardError, BoardSchema, emptyBoard, loadBoard, migrateBoard, type Segment } from "../src";
import * as v from "valibot";

const seg = (id: string): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start: 1, end: 3, text: ["a", "b", "c"], version: { kind: "git", commit: "x" } });
const e2e = () => JSON.parse(readFileSync(new URL("./fixtures/board-e2e.json", import.meta.url), "utf8"));

/** 每种卡、连线、Section、Sidenote、Sticker 都有的第 3 版白板 */
function full() {
  const b = emptyBoard("b", "All");
  const code = { id: "c", kind: "code" as const, segments: [{ ...seg("s1"), hidden: [[2, 2]] as [number, number][], hl: [1], symbol: { qual: "f", kind: "function" as const } }], hide: { comments: true }, wrap: true, members: { shown: ["A.f"] } };
  b.cards.push(
    { ...code, mergedFrom: [{ card: { ...code, id: "old" }, place: { x: 0, y: 0, w: 300 } }] },
    { id: "n", kind: "note", md: "# hi", bg: false, size: "title", bold: true },
    { id: "i", kind: "image", src: "a.png", bg: true },
    { id: "w", kind: "web", url: "https://x.org", meta: { title: "X", at: 1, failed: false }, style: "side" },
    { id: "l", kind: "links", items: [{ id: "i1", url: "https://y.org", rich: true }] },
    { id: "p", kind: "code", segments: [{ ...seg("s2"), src: { kind: "github", owner: "o", name: "n", ref: "main" }, version: { kind: "pkg", name: "torch", version: "2" } }] },
    { id: "q", kind: "code", segments: [{ ...seg("s3"), src: { kind: "free" }, version: { kind: "none" } }] },
    { id: "k", kind: "compare", cols: ["p", "q"], swap: true },
  );
  b.place = { c: { x: 1, y: 2, w: 400, h: 90, section: "g", locked: true, collapsed: true }, n: { x: 0, y: 0, w: 200 }, k: { x: 0, y: 0, w: 900 } };
  b.links.push({ id: "L1", kind: "call", from: { card: "c", seg: "s1", line: 2 }, to: { card: "n" }, vars: [{ a: "x", b: "y" }, { a: "r", ret: true }], loop: true, call: { name: "f", col: 4 } });
  b.links.push({ id: "L2", kind: "plain", from: { card: "n" }, to: { card: "w" }, arrow: "both", solid: false, color: "#f00", label: "hi", at: 0.3, side: "left" });
  b.sections.push({ id: "g", title: "G", x: 0, y: 0, w: 10, h: 10, color: "blue", parent: undefined });
  b.sidenotes.push(
    { id: "s1", kind: "code", at: { card: "c", seg: "s1", lines: [1, 2] }, code: { ...seg("x"), src: { kind: "external", root: "/usr/lib" }, version: { kind: "hash", hash: "abcd" } } },
    { id: "s2", kind: "paste", at: { card: "c" }, text: "x", lang: "python" },
    { id: "s3", kind: "text", at: { card: "c" }, md: "x", alwaysShow: true },
    { id: "s4", kind: "link", at: { card: "c" }, url: "https://z" },
    { id: "s5", kind: "card", at: { card: "c" }, card: "n", lineRemoved: true },
  );
  b.stickers.push(
    { id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: "c", seg: "s1", line: 2 } },
    { id: "k2", icon: { pack: "emoji", name: "🔥" }, at: { kind: "card", card: "c" } },
    { id: "k3", icon: { pack: "p", name: "x" }, color: "#fff", at: { kind: "canvas", x: 1, y: 2, size: 30, on: { link: "L1", t: 0.5 } } },
  );
  return b;
}

describe("loadBoard", () => {
  it("accepts every kind of content a v3 board holds, unchanged", () => {
    const b = full();
    expect(loadBoard(structuredClone(b))).toEqual(b);
    expect(v.is(BoardSchema, emptyBoard("e", "E"))).toBe(true);
  });
  it("accepts a board saved by the extension (e2e run)", () => {
    const raw = e2e();
    expect(loadBoard(raw).cards.length).toBeGreaterThan(0);
  });
  it("migrates v1 and v2 boards and validates the result", () => {
    const v1 = loadBoard({ id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, version: 1,
      cards: [{ id: "c1", type: "code", x: 0, y: 0, w: 500, path: "a.py", start: 1, end: 2, lang: "python", snapshot: ["a", "b"], commit: "abc", hl: [2], symbol: "f" }, { id: "g", type: "group", x: 0, y: 0, w: 9, h: 9, label: "G" }],
      edges: [{ id: "e", from: { card: "c1", line: 2 }, to: { card: "c1" }, kind: "call" }] });
    expect(v1.version).toBe(4);
    const col = (id: string) => ({ id, kind: "code", x: 5, y: 6, w: 300, segments: [seg(`s${id}`)] });
    const v2 = loadBoard({ version: 2, id: "b", name: "x", cam: { x: 0, y: 0, z: 1 }, sidenotes: [],
      cards: [{ id: "k", kind: "compare", x: 10, y: 20, w: 900, cols: [col("p"), col("q")] }, { id: "w", kind: "web", x: 0, y: 0, w: 300, url: "https://x.org", pageTitle: "X" }],
      links: [{ id: "l", kind: "plain", from: { card: "k" }, to: { card: "w" } }] });
    expect(v2.cards.map((c) => c.id)).toEqual(["p", "q", "k", "w"]);
  });
  it("leaves id to the caller (storage names it after the file)", () => {
    const b: any = full(); delete b.id;
    expect(loadBoard(b).id).toBeUndefined();
  });
  it("names the bad path", () => {
    const b: any = full(); b.cards[0].segments[0].text = "oops";
    expect(() => loadBoard(b)).toThrow(BoardError);
    expect(() => loadBoard(b)).toThrow(/cards\.0\.segments\.0\.text/);
    const c: any = full(); c.place.n.x = "1";
    expect(() => loadBoard(c)).toThrow(/place\.n\.x/);
    const d: any = full(); d.cards[1].kind = "chart";
    expect(() => loadBoard(d)).toThrow(/cards\.1\.kind/);
    const e: any = full(); e.stickers[2].at.on = { link: 3 };
    expect(() => loadBoard(e)).toThrow(/stickers\.2\.at\.on/);
  });
  it("rejects non-boards and newer versions", () => {
    expect(() => loadBoard(null)).toThrow(/Not a board file/);
    expect(() => loadBoard([1])).toThrow(BoardError);
    expect(() => loadBoard({ version: "3" })).toThrow(/version/);
    expect(() => loadBoard({ version: 99, id: "b", name: "B", cards: [] })).toThrow(/newer/);
  });
  it("keeps fields it does not know", () => {
    const b: any = full(); b.cards[1].future = { x: 1 }; b.extra = true;
    const r: any = loadBoard(b);
    expect(r.cards[1].future).toEqual({ x: 1 });
    expect(r.extra).toBe(true);
  });
  it("matches migrateBoard on valid input", () => {
    expect(loadBoard(structuredClone(e2e()))).toEqual(migrateBoard(e2e()));
  });
});
