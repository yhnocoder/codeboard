import { describe, expect, it } from "vitest";
import { cutCrumbs, danglingRefs, emptyBoard, extractBoard, loadBoard, refTitle, skeletonOf, subBoardsOf, subCardOf, wouldCycle, type Board, type Card } from "../src";

const note = (id: string): Card => ({ id, kind: "note", md: `# ${id}\nbody`, look: "note" });
const code = (id: string, qual = id): Card => ({ id, kind: "code", segments: [{ id: `s${id}`, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start: 1, end: 10, text: Array(10).fill("x"), version: { kind: "git", commit: "bb823b3c0ffee" }, symbol: { qual, kind: "function" } }] });
function board(id: string, cards: [Card, number, number][]): Board {
  const b = emptyBoard(id, id);
  for (const [c, x, y] of cards) { b.cards.push(c); b.place[c.id] = { x, y, w: 400 }; }
  return b;
}
const call = (id: string, from: string, line: number, to: string) => ({ id, from: { card: from, seg: `s${from}`, line }, to: { card: to }, call: { name: to, col: 0 } });

describe("sub-board skeleton", () => {
  it("has card boxes from (0, 0), titles, kinds, section indexes, the links between cards, card count and main commit", () => {
    const b = board("S", [[code("a", "Scheduler.schedule"), 100, 200], [code("b", "BlockManager.allocate"), 700, 200], [note("n"), 100, 900]]);
    b.links.push(call("l1", "a", 3, "b"), { id: "l2", from: { card: "n" }, to: { card: "a" } }, { id: "l3", from: { card: "a" }, to: { card: "n" } });
    b.sections.push({ id: "s1", title: "Alloc", x: 650, y: 150, w: 500, h: 400, color: "blue" });
    b.place.b.section = "s1";
    const sk = skeletonOf(b);
    expect(sk).toMatchObject({ id: "S", name: "S", n: 3, commit: "bb823b3" });
    expect(sk.cards.map((c) => [c.id, c.t, c.k])).toEqual([["a", "Scheduler.schedule", "code"], ["b", "BlockManager.allocate", "code"], ["n", "n", "note"]]);
    expect(Math.min(...sk.cards.map((c) => c.x), ...sk.secs.map((s) => s.x))).toBe(0);
    expect(sk.cards[1].si).toBe(0);
    expect(sk.cards[0]).toMatchObject({ x: 0, y: 50, w: 400 }); // true position and size, shifted with the section's top-left
    expect(sk.secs[0]).toMatchObject({ t: "Alloc", color: "blue" });
    // one entry per pair of cards, whichever way the arrows go
    expect(sk.ln).toEqual([[0, 1], [2, 0]]);
  });

  it("keeps every card, also many branches from one dispatch line", () => {
    const b = board("O", [[code("d"), 0, 0]]);
    for (let i = 0; i < 8; i++) { b.cards.push(note(`h${i}`)); b.place[`h${i}`] = { x: 600, y: i * 200, w: 200 }; b.links.push(call(`l${i}`, "d", 5, `h${i}`)); }
    const sk = skeletonOf(b);
    expect(sk.cards.map((c) => c.id)).toEqual(["d", ...Array.from({ length: 8 }, (_, i) => `h${i}`)]);
    expect(sk.ln).toHaveLength(8);
  });

  it("draws a card as tall as the board measured it (Place.mh), else as estimated; a height set by hand wins", () => {
    const b = board("H", [[note("m"), 0, 0], [note("e"), 500, 0], [note("s"), 1000, 0]]);
    b.place.m.mh = 612;
    b.place.s.h = 240; b.place.s.mh = 999;
    const h = Object.fromEntries(skeletonOf(b).cards.map((c) => [c.id, c.h]));
    expect(h).toEqual({ m: 612, e: 160, s: 240 });
    // the field survives a save and load (the schema knows it)
    expect(loadBoard(JSON.parse(JSON.stringify(b))).place.m.mh).toBe(612);
  });

  it("names nested sub-boards", () => {
    const b = board("P", [[{ id: "f", kind: "board", board: "C" }, 0, 0]]);
    b.place.f.h = 300;
    expect(skeletonOf(b, (id) => (id === "C" ? emptyBoard("C", "Child") : undefined)).cards[0]).toMatchObject({ t: "Child", k: "board", h: 300 });
    expect(subBoardsOf(b)).toEqual(["C"]);
  });

  it("gives the map what it draws: the look of frameless notes, pictures and their names (alt, else the caption right below)", () => {
    const b = board("M", [[note("n"), 500, 0]]);
    b.cards.push({ id: "tx", kind: "note", md: "Heading words", look: "text" }, { id: "h", kind: "note", md: "check\nthis", look: "mark", hand: "orange" },
      { id: "i", kind: "image", src: "pic-120x80.png" }, { id: "cap", kind: "note", md: "BLUR_SIZE = 1", look: "text" },
      { id: "alt", kind: "image", src: "a.png", alt: "Grid of blocks" }, { id: "far", kind: "image", src: "b.png" },
      { id: "big", kind: "image", src: `data:image/png;base64,${"A".repeat(20_000)}` });
    b.place.tx = { x: 0, y: 600, w: 200 }; b.place.h = { x: 300, y: 600, w: 200 };
    b.place.i = { x: 0, y: 1000, w: 200, h: 130 }; b.place.cap = { x: 0, y: 1000 + 134, w: 200 };
    b.place.alt = { x: 600, y: 1000, w: 200 }; b.place.far = { x: 1200, y: 1000, w: 200 }; b.place.big = { x: 1600, y: 1000, w: 200 };
    const by = Object.fromEntries(skeletonOf(b).cards.map((c) => [c.id, c]));
    expect(by.n.lk).toBeUndefined();
    expect(by.tx).toMatchObject({ lk: "text", t: "Heading words" });
    expect(by.h).toMatchObject({ lk: "mark", t: "check this" });
    expect(by.i).toMatchObject({ img: "pic-120x80.png", t: "BLUR_SIZE = 1" });
    expect(by.alt.t).toBe("Grid of blocks");
    expect(by.far.t).toBe("");
    expect(by.big.img).toBeUndefined();
  });

  it("hands out one card's whole content for its preview, a Compare with its two columns", () => {
    const b = board("C", [[note("n"), 0, 0], [code("x"), 0, 400], [code("y"), 500, 400]]);
    b.cards.push({ id: "cmp", kind: "compare", cols: ["x", "y"] });
    b.place.cmp = { x: 0, y: 900, w: 800 };
    expect(subCardOf(b, "n")?.card).toMatchObject({ id: "n", md: "# n\nbody" });
    expect(subCardOf(b, "cmp")?.cols?.map((c) => c.id)).toEqual(["x", "y"]);
    expect(subCardOf(b, "gone")).toBeNull();
  });

  it("lists the cards [[ can link to, down through nested sub-boards, but no pictures or first-line names", () => {
    const deep = board("D", [[note("deep"), 0, 0]]);
    const mid = board("C", [[code("c", "BlockManager.allocate"), 0, 0], [{ id: "fd", kind: "board", board: "D" }, 0, 400]]);
    mid.name = "Child"; deep.name = "Deep";
    mid.cards.push({ id: "plain", kind: "note", md: "1. 3", look: "note" }, { id: "img", kind: "image", src: "x.png", title: "Named picture" }, { id: "free", kind: "code", segments: [{ ...(code("z") as Extract<Card, { kind: "code" }>).segments[0], symbol: undefined, start: 3, end: 4 }] });
    for (const id of ["plain", "img", "free"]) mid.place[id] = { x: 0, y: 900, w: 200 };
    const all: Record<string, Board> = { C: mid, D: deep };
    expect(skeletonOf(mid, (id) => all[id]).refs).toEqual([
      { id: "c", t: "BlockManager.allocate", k: "code" },
      { id: "fd", t: "Deep", k: "board" },
      { id: "deep", t: "deep", k: "note", via: [{ f: "fd", b: "D", n: "Deep" }] },
    ]);
    expect(refTitle({ id: "x", kind: "note", md: "big words", look: "text", size: "title" })).toBe("big words");
    expect(refTitle({ id: "x", kind: "note", md: "1. 增加 shape(圆角矩形、圆形等)", look: "note" })).toBeUndefined();
  });
});

describe("sub-board cycles", () => {
  it("refuses a board inside itself, directly or further down", () => {
    const subs: Record<string, string[]> = { E: ["S"], S: ["B"], B: [] };
    const f = (id: string) => subs[id];
    expect(wouldCycle(f, "S", "E")).toBe(true); // Engine inside Scheduler: Scheduler is already inside Engine
    expect(wouldCycle(f, "B", "E")).toBe(true);
    expect(wouldCycle(f, "E", "E")).toBe(true);
    expect(wouldCycle(f, "E", "B")).toBe(false);
    expect(wouldCycle(f, "X", "E")).toBe(false);
  });
});

describe("Turn into Board", () => {
  it("moves the selection into a new board and leaves a frame; arrows in and out attach to the frame itself", () => {
    const p = board("E", [[code("step"), 0, 0], [code("sch"), 800, 0], [code("can"), 1400, 0], [note("out"), 0, 900]]);
    p.links.push(call("in", "step", 2, "sch"), call("inner", "sch", 4, "can"), { id: "back", from: { card: "can", seg: "scan", line: 5 }, to: { card: "out" } });
    p.sections.push({ id: "sec", title: "Scheduling", x: 780, y: -30, w: 1100, h: 500, color: "sand" });
    p.place.sch.section = "sec"; p.place.can.section = "sec";
    p.sidenotes.push({ id: "sn", kind: "text", md: "why", at: { card: "sch" } });
    p.stickers.push({ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0, on: { card: "can" } } });
    p.born = { step: 0, sch: 1, can: 2, out: 3 }; p.seq = 4;
    const rects = (id: string) => ({ ...p.place[id], h: 300 });
    const r = extractBoard(p, ["sch", "can"], rects, { id: "S", name: "Scheduler", frame: "fr" })!;
    expect(r.frame).toBe("fr");
    expect(r.child.cards.map((c) => c.id)).toEqual(["sch", "can"]);
    expect(r.child.place.sch).toMatchObject({ x: 80, y: 80, section: "sec" });
    expect(r.child.links.map((l) => l.id)).toEqual(["inner"]);
    expect(r.child.sections.map((s) => s.id)).toEqual(["sec"]);
    expect(r.child.sidenotes.map((n) => n.id)).toEqual(["sn"]);
    expect(r.child.stickers.map((k) => k.id)).toEqual(["k"]);
    expect(r.child.born).toEqual({ sch: 0, can: 1 });
    expect(p.cards.map((c) => c.id)).toEqual(["step", "fr", "out"]);
    expect(p.cards[1]).toEqual({ id: "fr", kind: "board", board: "S" });
    expect(p.place.fr).toMatchObject({ x: 800, y: 0 });
    expect(p.place.fr.h).toBeGreaterThan(200);
    expect(p.links.find((l) => l.id === "in")!.to).toEqual({ card: "fr" });
    expect(p.links.find((l) => l.id === "in")!.call?.name).toBe("sch");
    expect(p.links.find((l) => l.id === "back")!.from).toEqual({ card: "fr" });
    expect(p.sections).toEqual([]);
    expect(danglingRefs(p)).toEqual([]);
    expect(danglingRefs(r.child)).toEqual([]);
    // both load back through the schema
    expect(() => loadBoard(structuredClone(p))).not.toThrow();
    expect(() => loadBoard(structuredClone(r.child))).not.toThrow();
  });
});

describe("Turn into Board: references that cross the selection", () => {
  const star = { pack: "builtin", name: "star" } as const;
  const q = (id: string, at: Board["stickers"][number]["at"], answer: string): Board["stickers"][number] => ({ id, icon: { pack: "builtin", name: "question" }, at, q: { md: "why?", answer } });
  const setup = () => {
    const p = board("E", [[code("a"), 0, 0], [code("b"), 800, 0], [note("out"), 0, 900]]);
    p.links.push(call("ab", "a", 2, "b"), call("aout", "a", 3, "out"));
    return p;
  };
  const rects = (p: Board) => (id: string) => ({ ...p.place[id], h: 300 });

  it("a question whose answer moved keeps the question and drops the answer on the side that lost the card", () => {
    const p = setup();
    p.stickers.push(
      q("qp", { kind: "canvas", x: 0, y: 0 }, "a"), // stays on the parent; its answer moves
      q("qc", { kind: "line", card: "b", seg: "sb", line: 1 }, "out"), // moves; its answer stays
      q("qin", { kind: "line", card: "a", seg: "sa", line: 1 }, "b"), // moves with its answer
    );
    const r = extractBoard(p, ["a", "b"], rects(p), { id: "S", name: "S", frame: "fr" })!;
    expect(p.stickers.map((k) => [k.id, k.q?.answer])).toEqual([["qp", undefined]]);
    expect(r.child.stickers.map((k) => [k.id, k.q?.answer])).toEqual([["qc", undefined], ["qin", "b"]]);
    expect(danglingRefs(p)).toEqual([]);
    expect(danglingRefs(r.child)).toEqual([]);
  });

  it("stickers bound to moved cards and to links go with what they are bound to", () => {
    const p = setup();
    p.stickers.push(
      { id: "onB", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { card: "b" } } },
      { id: "onOut", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { card: "out" } } },
      { id: "onAB", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { link: "ab", t: 0.5 } } }, // link inside the selection
      { id: "onAOut", icon: star, at: { kind: "canvas", x: 0, y: 0, on: { link: "aout", t: 0.5 } } }, // link leaving it: stays on the parent, from the frame
      { id: "line", icon: star, at: { kind: "line", card: "a", seg: "sa", line: 2 } },
      { id: "free", icon: star, at: { kind: "canvas", x: 5, y: 5 } },
    );
    const r = extractBoard(p, ["a", "b"], rects(p), { id: "S", name: "S", frame: "fr" })!;
    expect(r.child.stickers.map((k) => k.id)).toEqual(["onB", "onAB", "line"]);
    expect(p.stickers.map((k) => k.id)).toEqual(["onOut", "onAOut", "free"]);
    expect(p.links.map((l) => [l.id, l.from.card])).toEqual([["aout", "fr"]]);
    expect(danglingRefs(p)).toEqual([]);
    expect(danglingRefs(r.child)).toEqual([]);
  });
});

describe("breadcrumbs", () => {
  it("cutCrumbs drops a deleted board and the levels above it, keeping the ones below with their cameras", () => {
    const crumbs = [{ id: "A", name: "A", frame: "fa" }, { id: "B", name: "B", frame: "fb" }, { id: "C", name: "C", frame: "fc" }];
    expect(cutCrumbs(crumbs, [1, 2, 3], "B")).toEqual({ crumbs: [crumbs[2]], cams: [3] });
    expect(cutCrumbs(crumbs, [1, 2, 3], "C")).toEqual({ crumbs: [], cams: [] });
    expect(cutCrumbs(crumbs, [1, 2, 3], "X")).toBeNull();
  });
});
