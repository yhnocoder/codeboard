import { describe, expect, it } from "vitest";
import {
  applyPatch, deflate, emptyBoard, inflate, loadBoard, loadBoardFile, loadSharedCard, putShared, renameCard, sharedOf, travels,
  type Board, type Card, type Sidenote,
} from "../src";

const note = (id: string, md = id): Card => ({ id, kind: "note", md, bg: true });
const text = (id: string, card: string, extra: Partial<Sidenote> = {}): Sidenote => ({ id, kind: "text", md: id, at: { card }, ...extra } as Sidenote);

function board(): Board {
  const b = emptyBoard("b", "B");
  for (const id of ["a", "b", "c"]) { b.cards.push(note(id)); b.place[id] = { x: 0, y: 0, w: 100 }; }
  b.links.push({ id: "l1", from: { card: "a" }, to: { card: "b" } });
  b.sidenotes.push(text("n1", "a"), text("n2", "b"));
  return b;
}

describe("applyPatch", () => {
  it("sets, adds and removes items per collection and keeps order unless told", () => {
    const b = board();
    applyPatch(b, {
      cards: { set: [note("b", "B!"), note("d")], del: ["c"] },
      place: { set: { d: { x: 5, y: 5, w: 100 } }, del: ["c"] },
      links: { del: ["l1"] },
      sidenotes: { set: [text("n3", "d")] },
    });
    expect(b.cards.map((c) => c.id)).toEqual(["a", "b", "d"]);
    expect((b.cards[1] as any).md).toBe("B!");
    expect(Object.keys(b.place).sort()).toEqual(["a", "b", "d"]);
    expect(b.links).toEqual([]);
    expect(b.sidenotes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("reorders by the full order; ids the sender did not know stay, at the end", () => {
    const b = board();
    applyPatch(b, { cards: { order: ["c", "a"] } });
    expect(b.cards.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("replaces the head (missing fields are removed) and the camera, never the id or version", () => {
    const b = board();
    b.hideNumbers = true;
    applyPatch(b, { head: { name: "New", born: { a: 0 }, seq: 1, id: "evil", version: 1 } as any, cam: { x: 1, y: 2, z: 3 } });
    expect(b.name).toBe("New");
    expect(b.hideNumbers).toBeUndefined();
    expect(b.id).toBe("b");
    expect(b.version).toBe(6);
    expect(b.cam).toEqual({ x: 1, y: 2, z: 3 });
    expect(b.cards.length).toBe(3);
  });

  it("full patches replace every collection", () => {
    const b = board();
    applyPatch(b, { full: true, head: { name: "F" } as any, cards: { set: [note("z")] }, place: { set: { z: { x: 0, y: 0, w: 1 } } } });
    expect(b.cards.map((c) => c.id)).toEqual(["z"]);
    expect(Object.keys(b.place)).toEqual(["z"]);
    expect(b.links).toEqual([]);
    expect(b.sidenotes).toEqual([]);
  });
});

describe("shared cards: inflate / deflate / putShared", () => {
  it("deflate turns shared cards into refs in place and takes their travelling sidenotes; inflate puts them back", () => {
    const b = board();
    b.sidenotes.push(text("n3", "b", { boardOnly: true }), { id: "n4", kind: "card", card: "c", at: { card: "b" } } as Sidenote);
    const { file, shared } = deflate(b, new Set(["b"]));
    expect(file.cards.map((c) => c.kind)).toEqual(["note", "shared", "note"]);
    expect(file.sidenotes.map((n) => n.id)).toEqual(["n1", "n3", "n4"]); // board-only and card-kind sidenotes stay on the board
    expect(shared).toEqual([{ card: b.cards[1], sidenotes: [b.sidenotes[1]] }]);
    expect(() => loadBoard(structuredClone(file))).toThrow(); // a board with refs is not a full board
    const f = loadBoardFile(JSON.parse(JSON.stringify(file)));
    const r = inflate(f, (id) => (id === "b" ? structuredClone(shared[0]) : undefined));
    expect(r.refs).toEqual(["b"]);
    expect(r.board.cards).toEqual(b.cards);
    expect(new Set(r.board.sidenotes.map((n) => n.id))).toEqual(new Set(["n1", "n2", "n3", "n4"]));
  });

  it("a missing shared card becomes a placeholder note so links and places do not dangle", () => {
    const { file } = deflate(board(), new Set(["a"]));
    const r = inflate(file, () => undefined);
    expect(r.missing).toEqual(["a"]);
    expect(r.refs).toEqual([]);
    expect(r.board.cards[0]).toMatchObject({ id: "a", kind: "note" });
  });

  it("putShared replaces the card and its travelling sidenotes in place, keeps board-only ones", () => {
    const b = board();
    b.sidenotes.push(text("n5", "a", { boardOnly: true }), text("n6", "a"));
    const ok = putShared(b, { card: note("a", "new"), sidenotes: [text("n6", "a", { md: "edited" } as any), text("n7", "a")] });
    expect(ok).toBe(true);
    expect((b.cards[0] as any).md).toBe("new");
    expect(b.sidenotes.map((n) => n.id)).toEqual(["n2", "n5", "n6", "n7"]); // n1 left the shared card
    expect((b.sidenotes[2] as any).md).toBe("edited");
    expect(putShared(b, { card: note("zz"), sidenotes: [] })).toBe(false);
    expect(sharedOf(b, "a")!.sidenotes.map((n) => n.id)).toEqual(["n6", "n7"]);
    expect(travels(b.sidenotes[1], "a")).toBe(false);
  });

  it("renameCard moves every reference", () => {
    const b = board();
    b.born = { a: 0, b: 1, c: 2 };
    b.stickers.push({ id: "k", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 0, y: 0, on: { card: "a" } } });
    renameCard(b, "a", "a2");
    expect(b.cards[0].id).toBe("a2");
    expect(b.place.a2 && !b.place.a).toBeTruthy();
    expect(b.links[0].from.card).toBe("a2");
    expect(b.sidenotes[0].at.card).toBe("a2");
    expect((b.stickers[0].at as any).on.card).toBe("a2");
    expect(b.born).toEqual({ b: 1, c: 2, a2: 0 });
  });

  it("validates shared card files", () => {
    expect(loadSharedCard({ version: 6, card: note("a"), sidenotes: [text("n", "a")], rev: { a: 1 } }).card.id).toBe("a");
    expect(() => loadSharedCard({ version: 6, card: { id: "a", kind: "nope" }, sidenotes: [], rev: {} })).toThrow(/Invalid shared card/);
  });
});

describe("board format v6", () => {
  it("v5 → v6 only bumps the version; v6 boards keep sidenote boardOnly", () => {
    const v5 = { ...board(), version: 5 } as any;
    const b = loadBoard(structuredClone(v5));
    expect(b.version).toBe(6);
    expect({ ...b, version: 5 }).toEqual(v5);
    const c = board();
    c.sidenotes[0].boardOnly = true;
    expect(loadBoard(structuredClone(c)).sidenotes[0].boardOnly).toBe(true);
  });
});
