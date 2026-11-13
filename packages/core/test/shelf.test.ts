// The Shelf: what putting cards and Sections aside takes along, what comes back, and that the board stays consistent meanwhile
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SETTINGS,
  applyPatch,
  cardsToFrame,
  checkBoard,
  clone,
  computeFlows,
  danglingRefs,
  deflate,
  diffBoards,
  emptyBoard,
  placeCards,
  removeCards,
  removeLostCalls,
  removeSections,
  renameCard,
  shelvedCards,
  swapCallTarget,
  type Board,
  type Card,
  type ShelfEntry,
} from "../src";
import {
  cardToSidenote,
  putBack,
  removeFromShelf,
  shelfLabel,
  shelfOrder,
  shelve,
  type CommandEnv,
} from "../src/commands";

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

  it("counts a card's hidden arrows when asking before it turns into a sidenote", async () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { sections: ["S"] });
    const asked: string[] = [];
    env.choose = async (o) => {
      asked.push(o.text ?? "");
      return 1;
    };
    await cardToSidenote(env, "c", { card: "a" });
    expect(asked).toEqual(["2 links on this card will be deleted."]);
  });

  it("keeps a call's old target when its only other arrow is hidden on the Shelf", () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { sections: ["S"] });
    b.cards.push(code("z"));
    b.place.z = { x: 900, y: 900, w: 300 };
    b.links = [{ id: "zc", from: { card: "z", seg: "sz", line: 1 }, to: { card: "c" }, call: { name: "c", col: 4 } }];
    expect(swapCallTarget(b, "zc", code("n"), { alt: 0, w: 300 })).toEqual({ kept: true });
    expect(b.cards.some((c) => c.id === "c")).toBe(true);
    expect(b.shelf![0].links.find((l) => l.id === "bc")!.to.card).toBe("c");
    expect(danglingRefs(b)).toEqual([]);
  });

  it("Turn into Board moves a hidden arrow to the frame like the arrows on the canvas", () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { sections: ["S"] });
    cardsToFrame(b, ["c"], { id: "f", kind: "board", board: "child" } as Card, { x: 900, y: 100, w: 300 }, []);
    expect(b.links.map((l) => [l.id, l.from.card, l.to.card])).toEqual([["cd", "f", "d"]]);
    expect(b.shelf![0].links.map((l) => [l.id, l.from.card, l.to.card])).toEqual([
      ["ab", "a", "b"],
      ["bc", "b", "f"],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("an expanded call replaces its lost arrow to a shelved card too", () => {
    const b = board();
    const { env } = envOf(b);
    b.cards.push(code("z"));
    b.place.z = { x: 900, y: 900, w: 300 };
    b.links.push({
      id: "zd",
      from: { card: "z", seg: "sz", line: 1 },
      to: { card: "d" },
      call: { name: "d", col: 4 },
      lost: { to: true },
    });
    shelve(env, { cards: ["d"] });
    expect(b.shelf![0].links.map((l) => l.id)).toEqual(["cd", "zd"]);
    removeLostCalls(b, { card: "z", seg: "sz", line: 1 }, "d");
    expect(b.shelf![0].links.map((l) => l.id)).toEqual(["cd"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("placing cards with an arrow the Shelf already holds does not add it again on the canvas", () => {
    const b = board();
    const { env } = envOf(b);
    shelve(env, { sections: ["S"] });
    const cards = b.cards.filter((c) => c.id === "b" || c.id === "c").map((card) => ({ card: clone(card) }));
    placeCards(b, cards, { copy: false, links: [{ id: "q", from: { card: "b" }, to: { card: "c" } }] });
    expect(b.links.map((l) => l.id)).toEqual(["cd"]);
    expect(danglingRefs(b)).toEqual([]);
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

  it("puts the cards back in front of the cards on the board, and keeps the heights the shell measured", () => {
    const b = board();
    const { env } = envOf(b);
    b.place.c.h = 200;
    const id = shelve(env, { cards: ["a", "c"], keep: (c) => (c.id === "a" ? 333 : 444) })!;
    // c has a height of its own: nothing kept for it
    expect(b.shelf![0].place.a.mh).toBe(333);
    expect(b.shelf![0].place.c.mh).toBeUndefined();
    putBack(env, id);
    expect(b.cards.map((c) => c.id)).toEqual(["b", "d", "a", "c"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("orders the entries as the board is read: rows from the top, each from the left", () => {
    const at = (id: string, x: number, y: number, h = 100) => ({
      e: { id, at: 0, place: {}, sections: [], links: [], stickers: [] } as ShelfEntry,
      r: { x, y, w: 100, h },
    });
    const all = [at("low", 0, 400), at("right", 500, 30), at("left", 0, 0, 200), at("next", 300, 260)];
    const boxes = new Map(all.map((x) => [x.e, x.r]));
    const order = shelfOrder(
      all.map((x) => x.e),
      (e) => boxes.get(e),
    );
    // right's top is above the middle of left (row 1); next's is below it, so it starts row 2
    expect(order.map((e) => e.id)).toEqual(["left", "right", "next", "low"]);
  });
});

// A shelved card's arrows and stickers live in its Shelf entry, not in Board.links / Board.stickers: code that walks or rewrites
// the board's arrows or stickers takes allLinks / allStickers. Reading the canvas collection itself is checked here by shape:
// adding to it (push), replacing it (=) and finding one item by its id (what the user picked on the canvas) are not reads, and
// neither is an options parameter's (o.links: arrows or ids handed in).
describe("arrows and stickers on the Shelf are not missed by edit/ and commands/", () => {
  /** [file, top-level function, why reading the canvas collection (or something else's links / stickers) is right there] */
  const ALLOW: [string, string, string][] = [
    ["edit/refs.ts", "allLinks", "the canvas and every Shelf entry, the walk itself"],
    ["edit/refs.ts", "allStickers", "the canvas and every Shelf entry, the walk itself"],
    ["edit/refs.ts", "removeCards", "filters the canvas and each entry on their own: an item stays where it is"],
    ["edit/refs.ts", "pruneRefs", "prunes the canvas and each entry on their own: an item stays where it is"],
    ["edit/refs.ts", "removeLinks", "filters the canvas and each entry on their own: an item stays where it is"],
    ["edit/refs.ts", "pruneStickers", "a shelved sticker is bound within its own entry, so each is pruned on its own"],
    ["edit/refs.ts", "retargetCards", "drops looped arrows from the canvas and each entry on their own"],
    ["edit/refs.ts", "removeStickers", "filters the canvas and each entry on their own: an item stays where it is"],
    ["edit/check.ts", "danglingRefs", "checks the canvas and each entry on their own (what may be where differs)"],
    ["edit/shelf.ts", "shelveItems", "moves items from the canvas into the new entry"],
    ["edit/shelf.ts", "unshelve", "moves an entry's items back onto the canvas or into another entry"],
    [
      "edit/ops.ts",
      "makeCompare",
      "both columns are on the canvas; a shelved sticker is only on a shelved card or arrow",
    ],
    ["commands/shelf.ts", "shelfLabel", "counts one entry's own arrows"],
  ];
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const DECL = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gm;
  const USE = /(?<!(?<![\w$.])o)(?<=[\w$)\]])\s*\??\.\s*(links|stickers)\b/g;
  const NOT_READ = [
    /^\s*\.\s*(?:push|unshift)\s*\(/,
    /^\s*=(?![=>])/,
    /^\s*\.\s*(?:find|findIndex|some)\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\1\.id\s*===/,
  ];
  type Hit = { fn: string; at: string };
  const scan = (file: string, text: string): Hit[] => {
    // comments blanked, line numbers kept
    const src = text
      .replace(/^[ \t]*(\/\/|\/?\*).*$/gm, (m) => " ".repeat(m.length))
      .replace(/(^|\s)\/\/.*$/gm, (m) => " ".repeat(m.length));
    const decls = [...src.matchAll(DECL)].map((m) => ({ at: m.index, name: m[1] ?? m[2] }));
    const out: Hit[] = [];
    for (const m of src.matchAll(USE)) {
      const end = m.index + m[0].length;
      if (NOT_READ.some((re) => re.test(src.slice(end, end + 200)))) continue;
      const fn = decls.filter((d) => d.at < m.index).pop()?.name ?? "";
      out.push({ fn, at: `${file}:${src.slice(0, m.index).split("\n").length}` });
    }
    return out;
  };

  it("reads Board.links / Board.stickers directly only where the canvas alone is meant", () => {
    const bad: string[] = [];
    const used = new Set<number>();
    for (const dir of ["edit", "commands"])
      for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith(".ts"))) {
        const rel = `${dir}/${f}`;
        for (const h of scan(rel, fs.readFileSync(path.join(root, rel), "utf8"))) {
          const i = ALLOW.findIndex(([file, fn]) => file === rel && fn === h.fn);
          if (i < 0) bad.push(`${h.at} (${h.fn}): use allLinks / allStickers, or allow-list it with the reason`);
          else used.add(i);
        }
      }
    expect(bad).toEqual([]);
    expect(ALLOW.filter((_, i) => !used.has(i)).map(([f, fn]) => `${f} ${fn}`)).toEqual([]);
  });

  it("tells a read from adding, replacing and finding by id", () => {
    const hits = scan(
      "x.ts",
      [
        "export function f(b: Board) {",
        "  for (const l of b.links) l.at = 0;",
        "  const n = b.stickers",
        "    .filter((k) => k.q).length; // b.links in a comment",
        "  b.links.push(l); b.stickers = []; const k = b.stickers.find((s) => s.id === id);",
        "  if (env.board().links.some((k) => k.id === id && k.rpc)) {}",
        "  const s = new Set(b.links.map(key)); return [...b.stickers];",
        "}",
        "const g = (b: Board, o: { links: Link[] }) => b.links.find((l) => l.from.card === id) ?? o.links[0];",
      ].join("\n"),
    );
    expect(hits.map((h) => `${h.fn}:${h.at.split(":")[1]}`)).toEqual(["f:2", "f:3", "f:7", "f:7", "g:9"]);
  });
});
