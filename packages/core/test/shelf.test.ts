// The Shelf: what putting cards and Sections aside takes along, what comes back, and that the board stays consistent meanwhile
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  applyPatch,
  checkBoard,
  clone,
  computeFlows,
  danglingRefs,
  deflate,
  diffBoards,
  emptyBoard,
  removeCards,
  removeSections,
  renameCard,
  shelvedCards,
  type Board,
  type Card,
} from "../src";
import { putBack, removeFromShelf, shelfLabel, shelve, type CommandEnv } from "../src/commands";

const note = (id: string, md = `# ${id}`): Card => ({ id, kind: "note", md, look: "note" });
const code = (id: string, path = "nanovllm/engine/model_runner.py"): Card => ({
  id,
  kind: "code",
  segments: [
    {
      id: `s${id}`,
      src: { kind: "repo", repo: "" },
      path,
      lang: "python",
      start: 1,
      end: 2,
      text: ["def f():", "  pass"],
      version: { kind: "git", commit: "aaa1111" },
    },
  ],
});

/** Section S (with inner Section T) holding a and b; c outside; arrows a → b (inside), b → c (out), c → d; stickers on a and a → b */
function board(): Board {
  const b = emptyBoard("b", "B");
  for (const [c, x, y] of [
    [code("a"), 100, 100],
    [note("b"), 100, 400],
    [note("c"), 900, 100],
    [note("d"), 900, 500],
  ] as const) {
    b.cards.push(c);
    b.place[c.id] = { x, y, w: 300 };
  }
  b.sections.push({ id: "S", title: "Block manager", x: 60, y: 60, w: 400, h: 600 });
  b.sections.push({ id: "T", title: "Inner", x: 80, y: 360, w: 360, h: 280, parent: "S" });
  b.place.a.section = "S";
  b.place.b.section = "T";
  b.links.push({ id: "ab", from: { card: "a", seg: "sa", line: 1 }, to: { card: "b" }, call: { name: "b", col: 4 } });
  b.links.push({ id: "bc", from: { card: "b" }, to: { card: "c" } });
  b.links.push({ id: "cd", from: { card: "c" }, to: { card: "d" } });
  b.stickers.push({
    id: "k1",
    icon: { pack: "builtin", name: "star" },
    at: { kind: "line", card: "a", seg: "sa", line: 2 },
  });
  b.stickers.push({
    id: "k2",
    icon: { pack: "builtin", name: "star" },
    at: { kind: "canvas", x: 0, y: -10, on: { link: "ab", t: 0.5 } },
  });
  b.stickers.push({ id: "k3", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 5, y: 5 } });
  b.sidenotes.push({ id: "n1", at: { card: "a" }, kind: "text", md: "why" });
  return b;
}

function envOf(b: Board) {
  let edits = 0;
  const env: CommandEnv = {
    board: () => b,
    edit: (fn) => {
      fn(b);
      edits++;
      return true;
    },
    fresh: { add: (_id, fn) => fn(b), is: () => false, settle: () => {} },
    ask: (async () => null) as CommandEnv["ask"],
    choose: async () => null,
    toast: () => {},
    settings: () => DEFAULT_SETTINGS,
    boardsOf: () => [],
  };
  return { env, edits: () => edits };
}

describe("the Shelf", () => {
  it("takes a Section with its inner Sections, cards, their arrows and stickers off the canvas as one entry", () => {
    const b = board();
    const { env, edits } = envOf(b);
    const id = shelve(env, { sections: ["S"] });
    expect(id).toBeTruthy();
    expect(edits()).toBe(1);
    expect(Object.keys(b.place)).toEqual(["c", "d"]);
    expect(b.sections).toEqual([]);
    expect(b.links.map((l) => l.id)).toEqual(["cd"]);
    expect(b.stickers.map((k) => k.id)).toEqual(["k3"]);
    // content stays: the cards and the sidenote on a
    expect(b.cards.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(b.sidenotes.map((n) => n.id)).toEqual(["n1"]);
    const e = b.shelf![0];
    expect(Object.keys(e.place)).toEqual(["a", "b"]);
    expect(e.sections.map((s) => s.id)).toEqual(["S", "T"]);
    expect(e.links.map((l) => l.id)).toEqual(["ab", "bc"]);
    expect(e.stickers.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect([...shelvedCards(b)].sort()).toEqual(["a", "b"]);
    expect(danglingRefs(b)).toEqual([]);
    expect(() => checkBoard(b)).not.toThrow();
    // the call graph no longer sees the shelved call
    expect(computeFlows(b).byId.has("a")).toBe(false);
  });

  it("puts everything back where it was (the board is as before), and nothing is shelved twice", () => {
    const b = board();
    const before = clone(b);
    const { env } = envOf(b);
    const id = shelve(env, { cards: ["c"], sections: ["S"] })!;
    expect(shelve(env, { cards: ["a"] })).toBeNull(); // already on the Shelf
    expect(putBack(env, id)).toEqual({ cards: ["a", "b", "c"], sections: ["S", "T"] });
    expect(b.shelf).toBeUndefined();
    expect(b.place).toEqual(before.place);
    expect(b.sections).toEqual(before.sections);
    expect(b.links.map((l) => l.id).sort()).toEqual(["ab", "bc", "cd"]);
    expect(b.stickers.map((k) => k.id).sort()).toEqual(["k1", "k2", "k3"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("keeps an arrow hidden while its other card is on the Shelf in another entry, with the stickers on it", () => {
    const b = board();
    b.stickers.push({
      id: "k4",
      icon: { pack: "builtin", name: "star" },
      at: { kind: "canvas", x: 0, y: 0, on: { link: "bc", t: 0.5 } },
    });
    const { env } = envOf(b);
    const s = shelve(env, { sections: ["S"] })!;
    const c = shelve(env, { cards: ["c"] })!;
    putBack(env, s);
    expect(b.links.map((l) => l.id)).toEqual(["ab"]);
    expect(b.stickers.map((k) => k.id).sort()).toEqual(["k1", "k2", "k3"]);
    expect(b.shelf!.map((e) => e.id)).toEqual([c]);
    expect(b.shelf![0].links.map((l) => l.id).sort()).toEqual(["bc", "cd"]);
    expect(b.shelf![0].stickers.map((k) => k.id)).toEqual(["k4"]);
    expect(danglingRefs(b)).toEqual([]);
    putBack(env, c);
    expect(b.shelf).toBeUndefined();
    expect(b.links.map((l) => l.id).sort()).toEqual(["ab", "bc", "cd"]);
    expect(b.stickers.map((k) => k.id).sort()).toEqual(["k1", "k2", "k3", "k4"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("drops an entry elsewhere with its layout, out of the Section it came from unless the shell found one", () => {
    const b = board();
    const { env } = envOf(b);
    const id = shelve(env, { cards: ["b"] })!; // b alone: it was in T, which stays on the board
    expect(b.shelf![0].place.b.section).toBe("T");
    putBack(env, id, { dx: 1000, dy: 20 });
    expect(b.place.b).toMatchObject({ x: 1100, y: 420 });
    expect(b.place.b.section).toBeUndefined();
    const again = shelve(env, { cards: ["b"] })!;
    putBack(env, again, { dx: 10, dy: 0, into: { b: "S" } });
    expect(b.place.b.section).toBe("S");
    // a nested Section alone: back where it was it is in its parent again; dropped elsewhere it is on the board
    const t = shelve(env, { sections: ["T"] })!;
    putBack(env, t);
    expect(b.sections.find((s) => s.id === "T")?.parent).toBe("S");
    putBack(env, shelve(env, { sections: ["T"] })!, { dx: 2000, dy: 0 });
    expect(b.sections.find((s) => s.id === "T")?.parent).toBeUndefined();
    expect(danglingRefs(b)).toEqual([]);
  });

  it("keeps the hidden arrows up to date while shelved: a card deleted on the board takes its arrow along", () => {
    const b = board();
    const { env } = envOf(b);
    const id = shelve(env, { sections: ["S"] })!;
    removeCards(b, ["c"]);
    expect(b.shelf![0].links.map((l) => l.id)).toEqual(["ab"]);
    expect(danglingRefs(b)).toEqual([]);
    putBack(env, id);
    expect(b.links.map((l) => l.id)).toEqual(["ab"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("follows a Section deleted on the board and a renamed card", () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { sections: ["T"] });
    expect(b.shelf![0].sections[0].parent).toBe("S");
    removeSections(b, ["S"]);
    expect(b.shelf![0].sections[0].parent).toBeUndefined();
    renameCard(b, "b", "b2");
    expect(Object.keys(b.shelf![0].place)).toEqual(["b2"]);
    expect(b.shelf![0].links.map((l) => [l.from.card, l.to.card])).toEqual([
      ["a", "b2"],
      ["b2", "c"],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("deleting an entry deletes its cards, their sidenotes and arrows; deleting its last card deletes the entry", () => {
    const b = board();
    const { env } = envOf(b);
    const id = shelve(env, { sections: ["S"] })!;
    expect(removeFromShelf(env, id)).toBe(true);
    expect(b.cards.map((c) => c.id)).toEqual(["c", "d"]);
    expect(b.sidenotes).toEqual([]);
    expect(b.shelf).toBeUndefined();
    expect(danglingRefs(b)).toEqual([]);
    shelve(env, { cards: ["d"] });
    removeCards(b, ["d"]);
    expect(b.shelf).toBeUndefined();
    expect(b.links).toEqual([]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("finds what is off: a card both on the board and on the Shelf, an arrow on the board to a shelved card", () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { cards: ["d"] });
    b.links.push({ id: "x", from: { card: "c" }, to: { card: "d" } });
    b.place.d = { x: 0, y: 0, w: 100 };
    expect(danglingRefs(b)).toEqual(
      expect.arrayContaining([
        "card d is both on the board and on the shelf",
        "link x on the board touches a shelved card",
      ]),
    );
  });

  it("travels with the board's patches and files (a shared card stays a reference)", () => {
    const b = board();
    const before = clone(b);
    const { env } = envOf(b);
    shelve(env, { sections: ["S"] });
    const p = diffBoards(before, b)!;
    const replay = clone(before);
    applyPatch(replay, p);
    expect(replay).toEqual(b);
    const { file, shared } = deflate(b, new Set(["a"]));
    expect(file.cards[0]).toEqual({ id: "a", kind: "shared" });
    expect(shared[0].sidenotes.map((n) => n.id)).toEqual(["n1"]);
    expect(file.shelf![0].place.a).toBeDefined();
  });

  it("labels its rows", () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { sections: ["S"] });
    shelve(env, { cards: ["c"] });
    b.cards.push(code("m"));
    b.place.m = { x: 0, y: 900, w: 300 };
    shelve(env, { cards: ["m"] });
    expect(b.shelf!.map((e) => shelfLabel(b, e))).toEqual([
      { title: "Block manager", kind: "Section · 2 cards · 1 arrow" },
      { title: "c", kind: "Note" },
      { title: "model_runner.py 1–2", kind: "Code · model_runner.py" },
    ]);
  });
});
