import { describe, expect, it } from "vitest";
import { cutCrumbs, danglingRefs, emptyBoard, extractBoard, loadBoard, skeletonOf, skelHas, subBoardsOf, wouldCycle, FAN_KEEP, type Board, type Card } from "../src";

const note = (id: string): Card => ({ id, kind: "note", md: `# ${id}\nbody`, bg: true });
const code = (id: string, qual = id): Card => ({ id, kind: "code", segments: [{ id: `s${id}`, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start: 1, end: 10, text: Array(10).fill("x"), version: { kind: "git", commit: "bb823b3c0ffee" }, symbol: { qual, kind: "function" } }] });
function board(id: string, cards: [Card, number, number][]): Board {
  const b = emptyBoard(id, id);
  for (const [c, x, y] of cards) { b.cards.push(c); b.place[c.id] = { x, y, w: 400 }; }
  return b;
}
const call = (id: string, from: string, line: number, to: string) => ({ id, from: { card: from, seg: `s${from}`, line }, to: { card: to }, call: { name: to, col: 0 } });

describe("sub-board skeleton", () => {
  it("has card boxes from (0, 0), titles, call graph marks, section colours, links, card count and main commit", () => {
    const b = board("S", [[code("a", "Scheduler.schedule"), 100, 200], [code("b", "BlockManager.allocate"), 700, 200], [note("n"), 100, 900]]);
    b.links.push(call("l1", "a", 3, "b"), { id: "l2", from: { card: "n" }, to: { card: "a" } });
    b.sections.push({ id: "s1", title: "Alloc", x: 650, y: 150, w: 500, h: 400, color: "blue" });
    b.place.b.section = "s1";
    const sk = skeletonOf(b);
    expect(sk).toMatchObject({ id: "S", name: "S", n: 3, commit: "bb823b3" });
    expect(sk.cards.map((c) => [c.id, c.t, c.k, c.m])).toEqual([["a", "Scheduler.schedule", "code", "A"], ["b", "BlockManager.allocate", "code", "A"], ["n", "n", "note", undefined]]);
    expect(Math.min(...sk.cards.map((c) => c.x), ...sk.secs.map((s) => s.x))).toBe(0);
    expect(sk.cards[1].sec).toBe("blue");
    expect(sk.secs[0]).toMatchObject({ t: "Alloc", color: "blue" });
    expect(sk.links).toEqual([0, 1, 1, 2, 0, 0]);
    expect(skelHas(sk, "b") && !skelHas(sk, "zz")).toBe(true);
  });

  it("folds many branches from one dispatch line into +N (only cards nothing else links to)", () => {
    const b = board("O", [[code("d"), 0, 0]]);
    for (let i = 0; i < 8; i++) { b.cards.push(note(`h${i}`)); b.place[`h${i}`] = { x: 600, y: i * 200, w: 200 }; b.links.push(call(`l${i}`, "d", 5, `h${i}`)); }
    b.links.push({ id: "x", from: { card: "h0" }, to: { card: "h7" } }); // h7 has a second way in: stays
    const sk = skeletonOf(b);
    const more = sk.cards.find((c) => c.k === "more")!;
    expect(more.t).toBe("+4 more");
    expect(more.ids).toEqual(["h3", "h4", "h5", "h6"]);
    expect(sk.cards.filter((c) => c.k === "note").map((c) => c.id)).toEqual(["h0", "h1", "h2", "h7"].slice(0, FAN_KEEP).concat("h7"));
    expect(skelHas(sk, "h5")).toBe(true);
    // the folded links collapse into one link to the chip
    const at = sk.cards.indexOf(more);
    expect(sk.links.filter((_, i) => i % 3 === 1 && sk.links[i] === at).length).toBe(1);
  });

  it("names nested sub-boards", () => {
    const b = board("P", [[{ id: "f", kind: "board", board: "C" }, 0, 0]]);
    b.place.f.h = 300;
    expect(skeletonOf(b, (id) => (id === "C" ? "Child" : undefined)).cards[0]).toMatchObject({ t: "Child", k: "board", h: 300 });
    expect(subBoardsOf(b)).toEqual(["C"]);
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
  it("moves the selection into a new board and leaves a frame; arrows in land on the card inside, arrows out leave from the frame", () => {
    const p = board("E", [[code("step"), 0, 0], [code("sch"), 800, 0], [code("can"), 1400, 0], [note("out"), 0, 900]]);
    p.links.push(call("in", "step", 2, "sch"), call("inner", "sch", 4, "can"), { id: "back", from: { card: "can", seg: "scan", line: 5 }, to: { card: "out" } });
    p.sections.push({ id: "sec", title: "Scheduling", x: 780, y: -30, w: 1100, h: 500, color: "sand" });
    p.place.sch.section = "sec"; p.place.can.section = "sec";
    p.sidenotes.push({ id: "sn", kind: "text", md: "why", at: { card: "sch" } });
    p.stickers.push({ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "card", card: "can" } });
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
    expect(p.links.find((l) => l.id === "in")!.to).toEqual({ card: "fr", sub: "sch" });
    expect(p.links.find((l) => l.id === "in")!.call?.name).toBe("sch");
    expect(p.links.find((l) => l.id === "back")!.from).toEqual({ card: "fr" });
    expect(p.sections).toEqual([]);
    expect(danglingRefs(p)).toEqual([]);
    expect(danglingRefs(r.child)).toEqual([]);
    // both load back through the schema (board card, End.sub)
    expect(() => loadBoard(structuredClone(p))).not.toThrow();
    expect(() => loadBoard(structuredClone(r.child))).not.toThrow();
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
