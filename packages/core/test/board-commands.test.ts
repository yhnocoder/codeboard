// Board commands on a plain board with a scripted env: what each changes, what it asks, and that the board stays consistent
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  danglingRefs,
  emptyBoard,
  removeCards,
  removeStickers,
  type Board,
  type Card,
  type Segment,
} from "../src";
import {
  cardToSidenote,
  compare,
  deleteItems,
  dropGone,
  mergeCards,
  mergeIntoLinkList,
  moveOutOfParent,
  separate,
  setSectionColor,
  setListRich,
  toggleItemRich,
  toggleLock,
  toggleTilt,
  toggleWrap,
  writeSidenote,
  type Choice,
  type CommandEnv,
} from "../src/commands";

const seg = (id: string, start: number, text: string[]): Segment => ({
  id,
  src: { kind: "repo", repo: "" },
  path: "m.py",
  lang: "python",
  start,
  end: start + text.length - 1,
  text,
  version: { kind: "git", commit: "aaa1111" },
});

function setup(cards: Card[], o: { answer?: number | null; boards?: Record<string, string[]> } = {}) {
  const b: Board = emptyBoard("b", "B");
  cards.forEach((c, i) => {
    b.cards.push(c);
    b.place[c.id] = { x: 500 * i, y: 0, w: 400 };
  });
  const log = { edits: 0, asked: [] as Choice[], toasts: [] as string[] };
  // a fresh item is on the board without an undo step; settled, it is one (kept) or gone
  const fresh = new Set<string>();
  const env: CommandEnv = {
    board: () => b,
    edit: (fn) => {
      fn(b);
      log.edits++;
      return true;
    },
    fresh: {
      add: (id, fn) => {
        fn(b);
        fresh.add(id);
      },
      is: (id) => fresh.has(id),
      settle: (id, keep, fn) => {
        if (!fresh.delete(id)) return;
        if (!keep) {
          if (b.stickers.some((s) => s.id === id)) removeStickers(b, [id]);
          else removeCards(b, [id]);
          return;
        }
        fn?.(b);
        log.edits++;
      },
    },
    ask: (async () => null) as CommandEnv["ask"],
    choose: async (q) => {
      log.asked.push(q);
      return o.answer ?? null;
    },
    toast: (t) => {
      log.toasts.push(t);
    },
    settings: () => DEFAULT_SETTINGS,
    boardsOf: (id) => o.boards?.[id] ?? [],
  };
  return { b, env, log };
}
const code = (id: string, start = 1): Card => ({
  id,
  kind: "code",
  segments: [seg(`s${id}`, start, ["def f():", "  pass"])],
});
const note = (id: string, md: string): Card => ({ id, kind: "note", md, look: "note" });

describe("board commands", () => {
  it("deleting a card takes its arrows and sidenotes along", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.links.push({ id: "l", from: { card: "a" }, to: { card: "b" } });
    b.sidenotes.push({ id: "n", at: { card: "a" }, kind: "text", md: "x" });
    expect(deleteItems(env, { cards: ["a"] })).toBe(true);
    expect(b.cards.map((c) => c.id)).toEqual(["b"]);
    expect(b.links).toEqual([]);
    expect(b.sidenotes).toEqual([]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("puts the left card first in a Compare and back where the Compare was when separated", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.place.a.x = 900;
    const id = compare(env, ["a", "b"])!;
    const k = b.cards.find((c) => c.id === id);
    expect(k?.kind === "compare" && k.cols).toEqual(["b", "a"]);
    expect(b.place[id]).toMatchObject({ x: 500, y: 0, w: 800 });
    expect(separate(env, id)).toEqual(["b", "a"]);
    expect(b.place.b.x).toBe(500);
    expect(b.place.a.x).toBeGreaterThan(b.place.b.x);
    expect(b.cards.some((c) => c.id === id)).toBe(false);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("merges code cards, making shared ones copies here first", () => {
    const { b, env } = setup([code("a", 1), code("b", 10)], { boards: { b: ["B", "Other"] } });
    const m = mergeCards(env, ["a", "b"], "a")!;
    expect(m.linked).toBe(1);
    expect(m.segments).toHaveLength(2);
    expect(b.cards.map((c) => c.id)).toEqual([m.id]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("asks before a card with arrows becomes a sidenote, and leaves it when cancelled", async () => {
    const t = () => setup([code("a"), note("n", "hello")]);
    const no = t();
    no.b.links.push({ id: "l", from: { card: "n" }, to: { card: "a" } });
    expect(await cardToSidenote(no.env, "n", { card: "a" })).toBe(false);
    expect(no.log.asked[0].text).toBe("1 link on this card will be deleted.");
    expect(no.b.cards).toHaveLength(2);
    const yes = setup([code("a"), note("n", "hello")], { answer: 0 });
    yes.b.links.push({ id: "l", from: { card: "n" }, to: { card: "a" } });
    expect(await cardToSidenote(yes.env, "n", { card: "a", seg: "sa", lines: [1, 1] })).toBe(true);
    expect(yes.b.cards.map((c) => c.id)).toEqual(["a"]);
    expect(yes.b.sidenotes).toMatchObject([{ kind: "text", md: "hello", at: { card: "a", lines: [1, 1] } }]);
    expect(danglingRefs(yes.b)).toEqual([]);
  });

  it("merges Web cards into the top-left one as a Link List", () => {
    const web = (id: string): Card => ({ id, kind: "web", url: `https://${id}.example` });
    const { b, env } = setup([web("w1"), web("w2"), note("n", "x")]);
    b.place.w2.y = -100;
    expect(mergeIntoLinkList(env, ["w1", "n"])).toEqual({
      why: "Only Web cards and Link Lists can be merged into a Link List",
    });
    expect(mergeIntoLinkList(env, ["w1", "w2"])).toEqual({ id: "w2", links: 2 });
    const l = b.cards.find((c) => c.id === "w2");
    expect(l?.kind === "links" && l.items.map((i) => i.url)).toEqual(["https://w2.example", "https://w1.example"]);
    expect(b.cards.some((c) => c.id === "w1")).toBe(false);
  });

  it("moves a Section out of its parent one level up", () => {
    const { b, env, log } = setup([]);
    const sec = (id: string, parent?: string) => ({ id, title: id, x: 0, y: 0, w: 100, h: 100, parent });
    b.sections.push(sec("top"), sec("mid", "top"), sec("low", "mid"));
    moveOutOfParent(env, "low");
    expect(b.sections.find((s) => s.id === "low")?.parent).toBe("top");
    moveOutOfParent(env, "mid");
    expect(b.sections.find((s) => s.id === "mid")?.parent).toBeUndefined();
    expect(log.edits).toBe(2);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("colours several Sections in one step, and makes no step when none changes", () => {
    const { b, env, log } = setup([]);
    const sec = (id: string, color?: string) => ({ id, title: id, x: 0, y: 0, w: 100, h: 100, color });
    b.sections.push(sec("a"), sec("b", "blue"), sec("c", "pink"));
    setSectionColor(env, ["a", "b", "gone"], "green");
    expect(b.sections.map((s) => s.color)).toEqual(["green", "green", "pink"]);
    expect(log.edits).toBe(1);
    setSectionColor(env, ["a", "b"], "green");
    expect(log.edits).toBe(1);
    setSectionColor(env, ["a", "c"], undefined);
    expect(b.sections.map((s) => s.color)).toEqual([undefined, "green", undefined]);
    expect(log.edits).toBe(2);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("writes a Text sidenote, removes it written empty, and makes no step when unchanged", () => {
    const { b, env, log } = setup([code("a")]);
    b.sidenotes.push({ id: "n", at: { card: "a" }, kind: "text", md: "x" });
    writeSidenote(env, "n", "x");
    expect(log.edits).toBe(0);
    writeSidenote(env, "n", "y");
    expect(b.sidenotes).toMatchObject([{ id: "n", md: "y" }]);
    writeSidenote(env, "n", "  ");
    expect(b.sidenotes).toEqual([]);
    expect(log.edits).toBe(2);
  });

  it("drops a Link List row's own look once the list's default matches it", () => {
    const { b, env } = setup([
      {
        id: "l",
        kind: "links",
        items: [
          { id: "a", url: "https://a.example" },
          { id: "b", url: "https://b.example" },
        ],
      },
    ]);
    const list = () => b.cards[0] as Extract<Card, { kind: "links" }>;
    toggleItemRich(env, "l", "a");
    expect(list().items[0].rich).toBe(true);
    setListRich(env, "l", true);
    expect(list().rich).toBe(true);
    expect(list().items.map((i) => i.rich)).toEqual([undefined, undefined]);
    toggleItemRich(env, "l", "b");
    expect(list().items[1].rich).toBe(false);
    setListRich(env, "l", false);
    expect(list().rich).toBeUndefined();
    expect(list().items.map((i) => i.rich)).toEqual([undefined, undefined]);
  });

  it("locks cards and Sections together, a Compare's column as the Compare, and unlocks them once all are locked", () => {
    const { b, env } = setup([code("a"), code("b")]);
    const id = compare(env, ["a", "b"])!;
    b.sections.push({ id: "s", title: "S", x: 0, y: 0, w: 100, h: 100 });
    expect(toggleLock(env, ["nope"], ["gone"])).toBeNull();
    expect(toggleLock(env, ["a"], ["s"])).toBe(true);
    expect(b.place[id].locked).toBe(true);
    expect(b.sections[0].locked).toBe(true);
    b.sections[0].locked = undefined;
    expect(toggleLock(env, [id], ["s"])).toBe(true);
    expect(toggleLock(env, [id], ["s"])).toBe(false);
    expect(b.place[id].locked).toBeUndefined();
    expect(b.sections[0].locked).toBeUndefined();
  });

  it("tilts and wraps all the cards unless all are already", () => {
    const { b, env } = setup([code("a"), code("b"), note("n", "x")]);
    const card = (id: string) => b.cards.find((c) => c.id === id) as Card & { wrap?: boolean };
    card("a").tilt = true;
    toggleTilt(env, ["a", "b"]);
    expect([card("a").tilt, card("b").tilt]).toEqual([true, true]);
    toggleTilt(env, ["a", "b"]);
    expect([card("a").tilt, card("b").tilt]).toEqual([undefined, undefined]);
    toggleWrap(env, ["a", "n"]);
    expect([card("a").wrap, card("n").wrap]).toEqual([true, undefined]);
    toggleWrap(env, ["a", "b"]);
    expect([card("a").wrap, card("b").wrap]).toEqual([true, true]);
    toggleWrap(env, ["a", "b"]);
    expect([card("a").wrap, card("b").wrap]).toEqual([undefined, undefined]);
  });

  it("drops the cards another board deleted everywhere, with their arrows", () => {
    const { b } = setup([code("a"), code("b")]);
    b.links.push({ id: "l", from: { card: "a" }, to: { card: "b" } });
    dropGone(b, ["a", "elsewhere"]);
    expect(b.cards.map((c) => c.id)).toEqual(["b"]);
    expect(b.links).toEqual([]);
    expect(danglingRefs(b)).toEqual([]);
  });
});
