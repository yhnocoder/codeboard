import { describe, expect, it } from "vitest";
import {
  applyPatch, deflate, emptyBoard, homeCam, mergeById, inflate, loadBoard, loadBoardFile, loadSharedCard, putShared, renameCard, sharedOf, travels, applySharedUpdate, followShared,
  type Board, type Card, type Sidenote,
} from "../src";

const note = (id: string, md = id): Card => ({ id, kind: "note", md, look: "note" });
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
    expect(b.version).toBe(9);
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
    const r = inflate(f, b.cam, (id) => (id === "b" ? structuredClone(shared[0]) : undefined));
    expect(r.refs).toEqual(["b"]);
    expect(r.board.cards).toEqual(b.cards);
    expect(new Set(r.board.sidenotes.map((n) => n.id))).toEqual(new Set(["n1", "n2", "n3", "n4"]));
  });

  it("a missing shared card becomes a placeholder note so links and places do not dangle", () => {
    const { file } = deflate(board(), new Set(["a"]));
    const r = inflate(file, homeCam(), () => undefined);
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
    expect(() => loadSharedCard({ version: 6, card: { id: "a", kind: "nope" }, sidenotes: [] })).toThrow(/Invalid shared card/);
  });
});

describe("board format v6 and v7", () => {
  it("v5 → v8 only bumps the version and turns bg into look when no Markdown has escaped dollars; boards keep sidenote boardOnly", () => {
    const v5 = { ...board(), version: 5, cards: board().cards.map(({ look: _, ...c }: any) => ({ ...c, bg: true })) } as any;
    const b = loadBoard(structuredClone(v5));
    expect(b).toEqual(board());
    const c = board();
    c.sidenotes[0].boardOnly = true;
    expect(loadBoard(structuredClone(c)).sidenotes[0].boardOnly).toBe(true);
  });

  // Board files v5 and v6 may hold formulas the old editor wrote as \$…\$; \$ is now always a literal $, so v6 → v7 rewrites them to $…$ once.
  const oldMath = (version: number) => {
    const b = board() as any;
    b.version = version;
    b.cards[0].md = "a \\$x^2\\$ b, \\$\\frac{a}{b}\\$ and \\$\\{n\\}\\$";
    b.cards[1].desc = "cost \\$O(n)\\$";
    b.cards.push({ id: "m", kind: "code", segments: [], mergedFrom: [{ card: { id: "o", kind: "code", segments: [], desc: "\\$y\\$" }, place: { x: 0, y: 0, w: 1 } }] });
    b.place.m = { x: 0, y: 0, w: 100 };
    b.sidenotes[0].md = "\\$z\\$";
    b.stickers.push({ id: "q", icon: { pack: "builtin", name: "question" }, at: { kind: "canvas", x: 0, y: 0 }, q: { md: "why \\$k\\$?" } });
    b.cards[2].md = [
      "`\\$a\\$` code, \\$x$ half escaped, costs \\$5 or \\$6, \\$**b**\\$ split by bold, [t](http://x/\\$y\\$)",
      "```", "\\$c\\$", "```",
      "    \\$indented\\$",
      "$a\\$b$ math with an escaped dollar, \\\\\\$e\\$ after an escaped backslash",
    ].join("\n");
    return b;
  };
  it("v6 → v7: an old board's \\$a\\$ becomes math once; code, half-escaped and unsure text stay as written", () => {
    const b = loadBoard(oldMath(6));
    expect(b.version).toBe(9);
    expect((b.cards[0] as any).md).toBe("a $x^2$ b, $\\frac{a}{b}$ and ${n}$");
    expect(b.cards[1].desc).toBe("cost $O(n)$");
    expect((b.cards[3] as any).mergedFrom[0].card.desc).toBe("$y$");
    expect((b.sidenotes[0] as any).md).toBe("$z$");
    expect(b.stickers[0].q!.md).toBe("why $k$?");
    expect((b.cards[2] as any).md).toBe(oldMath(6).cards[2].md);
    // once: the upgraded board is read as is
    expect(loadBoard(structuredClone(b))).toEqual(b);
    // v5 files were written by the same editor
    expect((loadBoard(oldMath(5)).cards[0] as any).md).toBe("a $x^2$ b, $\\frac{a}{b}$ and ${n}$");
  });
  it("v6 → v7 leaves boards from before the WYSIWYG editor alone: their \\$ was always literal", () => {
    const raw = { ...oldMath(6), version: 4 };
    delete raw.born; delete raw.seq;
    expect((loadBoard(raw).cards[0] as any).md).toBe(oldMath(6).cards[0].md);
  });
  it("a v8 board's escaped \\$a\\$ is literal text and stays as written", () => {
    const b = board();
    (b.cards[0] as any).md = "\\$a\\$";
    const again = loadBoard(structuredClone(loadBoard(structuredClone(b))));
    expect((again.cards[0] as any).md).toBe("\\$a\\$");
  });
  it("v6 → v8 upgrades shared card files (the card and its travelling sidenotes) once, and refuses newer ones", () => {
    const sc = loadSharedCard({ version: 6, card: { ...note("s", "\\$a\\$"), desc: "\\$d\\$" }, sidenotes: [text("n", "s", { md: "\\$t\\$" } as any)] });
    expect(sc.version).toBe(9);
    expect(sc.card).toMatchObject({ md: "$a$", desc: "$d$" });
    expect((sc.sidenotes[0] as any).md).toBe("$t$");
    expect((loadSharedCard({ version: 8, card: note("s", "\\$a\\$"), sidenotes: [] }).card as any).md).toBe("\\$a\\$");
    expect(() => loadSharedCard({ version: 10, card: note("s"), sidenotes: [] })).toThrow(/newer/);
  });
});

describe("shared card updates on a board (followShared / applySharedUpdate)", () => {
  const seg = (start: number, text: string[], commit: string) => ({ id: "g", src: { kind: "repo" as const, repo: "" }, path: "a.py", lang: "python", start, end: start + text.length - 1, text, version: { kind: "git" as const, commit } });
  const code = (s: ReturnType<typeof seg>): Card => ({ id: "s", kind: "code", segments: [s] });
  function withCode(): Board {
    const b = board();
    b.cards.push(code(seg(10, ["def f():", "    x = 1", "    return x"], "a")));
    b.links.push({ id: "l2", from: { card: "a" }, to: { card: "s", seg: "g", line: 12 } });
    b.sidenotes.push(text("own", "s", { at: { card: "s", seg: "g", lines: [11, 11] }, boardOnly: true }), text("tr", "s", { at: { card: "s", seg: "g", lines: [11, 11] } }));
    return b;
  }
  const now = seg(10, ["# new", "def f():", "    x = 2", "    return x"], "b");
  it("moves this board's own line references and marks its own sidenotes on changed lines; travelling sidenotes come from the update", () => {
    const b = withCode();
    const tr = text("tr", "s", { at: { card: "s", seg: "g", lines: [12, 12] }, review: "b" });
    applySharedUpdate(b, { card: code(now), sidenotes: [tr], items: ["s", "tr"] });
    expect(b.links[1].to).toEqual({ card: "s", seg: "g", line: 13 });
    expect(b.sidenotes.find((n) => n.id === "own")).toMatchObject({ at: { lines: [12, 12] }, review: "b" });
    expect(b.sidenotes.find((n) => n.id === "tr")).toEqual(tr);
    // Replaying on the updated board changes nothing (undo replays syncs)
    const again = structuredClone(b);
    applySharedUpdate(again, { card: code(now), sidenotes: [tr], items: ["s", "tr"] });
    expect(again).toEqual(b);
  });
  it("putShared reports whether this board's own references moved", () => {
    const b = withCode();
    const o: { moved?: boolean } = {};
    expect(putShared(b, { card: code(now), sidenotes: [] }, o)).toBe(true);
    expect(o.moved).toBe(true);
    const o2: { moved?: boolean } = {};
    putShared(b, { card: code(now), sidenotes: [] }, o2);
    expect(o2.moved).toBe(false);
  });
  it("followShared ignores non-code cards and unchanged segments", () => {
    const b = withCode();
    expect(followShared(b, note("a"), note("a", "x"))).toBe(false);
    expect(followShared(b, b.cards[3], structuredClone(b.cards[3]))).toBe(false);
  });
});

describe("mergeById", () => {
  const x = (id: string, v = id) => ({ id, v });
  it("takes this side's changes and deletes, the other side's untouched items and additions", () => {
    const r = mergeById([x("a"), x("b"), x("c")], [x("a", "a2"), x("b"), x("c"), x("d")], [x("a"), x("b", "b1"), x("e")]);
    expect(r.items).toEqual([x("a", "a2"), x("b", "b1"), x("e"), x("d")]);
    expect(r.changed).toEqual(["b", "e", "c"]);
  });
  it("without a base it never deletes: every item of this side counts as changed, the other side's stay", () => {
    const r = mergeById(undefined, [x("a", "disk"), x("z")], [x("a", "mine")]);
    expect(r.items).toEqual([x("a", "mine"), x("z")]);
    expect(r.changed).toEqual(["a"]);
  });
});
