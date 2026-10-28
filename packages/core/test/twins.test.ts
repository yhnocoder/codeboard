import { describe, expect, it } from "vitest";
import {
  applySharedUpdate, danglingRefs, detachTwin, emptyBoard, loadBoard, makeTwin, placeCards, syncTwins, twinContent,
  type Board, type CodeCard, type NoteCard, type Segment,
} from "../src";

const seg = (id: string, start: number, text: string[]): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "a.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git", commit: "x" } });
const code = (id: string, sid = `s${id}`): CodeCard => ({ id, kind: "code", segments: [seg(sid, 1, ["def f():", "    g()"])] });
const note = (id: string, md: string): NoteCard => ({ id, kind: "note", md, look: "note" });
const board = (b: Partial<Board>): Board => ({ ...emptyBoard("b", "B"), ...b });

describe("makeTwin", () => {
  it("turns a pasted copy into another place of the same card: same content and segment ids, own place, arrows and sidenotes", () => {
    const b = board({
      cards: [code("a"), code("c", "sc"), note("n", "x")],
      place: { a: { x: 0, y: 0, w: 300 }, c: { x: 400, y: 0, w: 300 }, n: { x: 0, y: 400, w: 200 } },
      links: [{ id: "l1", from: { card: "c", seg: "sc", line: 2 }, to: { card: "n" } }],
      sidenotes: [{ id: "sn", at: { card: "c", seg: "sc", lines: [1, 1] }, kind: "text", md: "why" }],
      stickers: [{ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: "c", seg: "sc", line: 1 } }],
    });
    (b.cards[1] as CodeCard).tilt = true;
    expect(makeTwin(b, "c", "a")).toBe(true);
    const [a, c] = b.cards as CodeCard[];
    expect(a.same).toBeTruthy();
    expect(c.same).toBe(a.same);
    expect(twinContent(c)).toBe(twinContent(a));
    expect(c.segments[0].id).toBe("sa");
    expect(c.tilt).toBe(true); // tilt goes with the place
    expect(b.links[0].from).toEqual({ card: "c", seg: "sa", line: 2 });
    expect(b.sidenotes[0].at).toEqual({ card: "c", seg: "sa", lines: [1, 1] });
    expect(b.stickers[0].at).toEqual({ kind: "line", card: "c", seg: "sa", line: 1 });
    expect(b.place.c.x).toBe(400);
    expect(danglingRefs(b)).toEqual([]);
    expect(makeTwin(b, "c", "a")).toBe(false); // already the same card
  });

  it("joins the group the original is already in", () => {
    const b = board({ cards: [note("a", "x"), note("b", "y"), note("c", "z")], place: {} });
    makeTwin(b, "b", "a");
    makeTwin(b, "c", "b");
    expect(new Set(b.cards.map((c) => c.same)).size).toBe(1);
    expect(b.cards.map((c) => (c as NoteCard).md)).toEqual(["x", "x", "x"]);
  });

  it("leaves Compare cards alone", () => {
    const b = board({ cards: [code("p"), code("q"), { id: "k", kind: "compare", cols: ["p", "q"] }, note("n", "x")], place: {} });
    expect(makeTwin(b, "n", "k")).toBe(false);
  });
});

describe("syncTwins", () => {
  it("copies the edited place into the others, whichever one was edited", () => {
    const b = board({ cards: [note("a", "one"), note("b", "one"), note("c", "other")], place: {} });
    makeTwin(b, "b", "a");
    const seen = new Map<string, string>();
    syncTwins(b, seen);
    (b.cards[1] as NoteCard).md = "edited in b";
    (b.cards[1] as NoteCard).title = "T";
    syncTwins(b, seen);
    expect((b.cards[0] as NoteCard).md).toBe("edited in b");
    expect(b.cards[0].title).toBe("T");
    delete b.cards[0].title;
    syncTwins(b, seen);
    expect(b.cards[1].title).toBeUndefined();
    expect((b.cards[2] as NoteCard).md).toBe("other");
    expect(danglingRefs(b)).toEqual([]);
  });

  it("a card that comes back into the group follows the ones that were there", () => {
    const b = board({ cards: [note("a", "now"), note("b", "now")], place: {} });
    makeTwin(b, "b", "a");
    const seen = new Map<string, string>();
    syncTwins(b, seen);
    b.cards.push({ ...note("c", "old"), same: b.cards[0].same });
    syncTwins(b, seen);
    expect((b.cards[2] as NoteCard).md).toBe("now");
    expect((b.cards[0] as NoteCard).md).toBe("now");
  });

  it("danglingRefs reports places of one card that differ", () => {
    const b = board({ cards: [note("a", "x"), note("b", "x")], place: {} });
    makeTwin(b, "b", "a");
    (b.cards[1] as NoteCard).md = "y";
    expect(danglingRefs(b)).toEqual(["card b differs from the other places of the same card"]);
  });
});

describe("detachTwin", () => {
  it("makes this place its own copy with new segment ids; the last place left is a plain card again", () => {
    const b = board({
      cards: [code("a"), code("c", "sc")], place: { a: { x: 0, y: 0, w: 1 }, c: { x: 0, y: 0, w: 1 } },
      links: [{ id: "l1", from: { card: "c", seg: "sc", line: 2 }, to: { card: "a", seg: "sa", line: 1 } }],
    });
    makeTwin(b, "c", "a");
    const segs = detachTwin(b, "c");
    const [a, c] = b.cards as CodeCard[];
    expect(a.same).toBeUndefined();
    expect(c.same).toBeUndefined();
    expect(Object.keys(segs)).toEqual(["sa"]);
    expect(c.segments[0].id).toBe(segs.sa);
    expect(c.segments[0].id).not.toBe("sa");
    expect(b.links[0].from.seg).toBe(segs.sa);
    expect(b.links[0].to.seg).toBe("sa");
    expect(danglingRefs(b)).toEqual([]);
  });
});

describe("copies and shared updates", () => {
  it("a copy of a place is a separate card, and arrows between two places of one card get each card's own new segments", () => {
    const b = board({
      cards: [code("a"), code("c", "sc")], place: { a: { x: 0, y: 0, w: 1 }, c: { x: 0, y: 0, w: 1 } },
      links: [{ id: "l1", from: { card: "a", seg: "sa", line: 2 }, to: { card: "c", seg: "sc", line: 1 } }],
    });
    makeTwin(b, "c", "a");
    const items = b.cards.map((c) => ({ card: structuredClone(c), place: b.place[c.id] }));
    const m = placeCards(b, items, { copy: true, links: structuredClone(b.links) });
    const copies = b.cards.slice(2) as CodeCard[];
    expect(copies.every((c) => !c.same)).toBe(true);
    const l = b.links[1];
    expect(l.from).toEqual({ card: m.cards.a, seg: copies[0].segments[0].id, line: 2 });
    expect(l.to).toEqual({ card: m.cards.c, seg: copies[1].segments[0].id, line: 1 });
    expect(copies[0].segments[0].id).not.toBe(copies[1].segments[0].id);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("a shared card updated from another board updates its other places here", () => {
    const b = board({ cards: [note("a", "x"), note("b", "x")], place: {} });
    makeTwin(b, "b", "a");
    applySharedUpdate(b, { card: { ...structuredClone(b.cards[0]), md: "from elsewhere" } as NoteCard, sidenotes: [], items: ["a"] });
    expect((b.cards[1] as NoteCard).md).toBe("from elsewhere");
    expect(danglingRefs(b)).toEqual([]);
  });

  it("the board file keeps which cards are the same card", () => {
    const b = board({ cards: [note("a", "x"), note("b", "x")], place: { a: { x: 0, y: 0, w: 1 }, b: { x: 0, y: 0, w: 1 } } });
    makeTwin(b, "b", "a");
    const back = loadBoard(JSON.parse(JSON.stringify(b)));
    expect(back.cards[1].same).toBe(b.cards[0].same);
  });
});
