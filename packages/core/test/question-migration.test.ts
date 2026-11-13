// 16 → 17: question stickers become question sidenotes where they were (migrate.ts questionStickers)
import { describe, expect, it } from "vitest";
import { danglingRefs, migrateBoard, type CodeCard, type Segment } from "../src";
import { upgraded } from "./upgrade";

const seg = (id: string): Segment => ({
  id,
  src: { kind: "repo", repo: "" },
  path: "a/m.py",
  lang: "python",
  start: 1,
  end: 20,
  text: Array.from({ length: 20 }, (_, i) => `l${i + 1}`),
  version: { kind: "git", commit: "abc1234" },
});
const code = (id: string): CodeCard => ({ id, kind: "code", segments: [seg(`s${id}`)], title: id });
const Q = { pack: "builtin", name: "question" };

const v16 = () => ({
  version: 16,
  id: "b",
  name: "B",
  cards: [code("a"), { id: "n", kind: "note", look: "note", md: "# Why\n\nbecause" }],
  place: { a: { x: 0, y: 0, w: 400 }, n: { x: 600, y: 0, w: 300 } },
  links: [{ id: "l", from: { card: "a", seg: "sa", line: 7 }, to: { card: "n" } }],
  sections: [],
  sidenotes: [],
  stickers: [
    { id: "q1", icon: Q, at: { kind: "line", card: "a", seg: "sa", line: 3 }, q: { md: "why 3?", at: 30 } },
    {
      id: "q2",
      icon: { pack: "emoji", name: "🤔" },
      at: { kind: "canvas", x: 10, y: -10, on: { card: "n" } },
      q: { md: "and this?", done: true, answer: "n", at: 20 },
    },
    { id: "q3", icon: Q, at: { kind: "canvas", x: 100, y: 200, size: 40 } },
    { id: "q4", icon: Q, at: { kind: "canvas", x: 0, y: 0, on: { link: "l", t: 0.5 } }, q: { md: "this call?" } },
    { id: "star", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 5, y: 5, on: { card: "a" } } },
    { id: "think", icon: { pack: "emoji", name: "❓" }, at: { kind: "canvas", x: 9, y: 9 } },
  ],
});

describe("question stickers become question sidenotes (16 → 17)", () => {
  it("each sits where its sticker was, with its text, done state and answer; other stickers stay stickers", () => {
    const b = upgraded(v16());
    expect(b.version).toBe(17);
    expect(b.stickers.map((k) => k.id)).toEqual(["star", "think"]);
    const by = (id: string) => b.sidenotes.find((n) => n.id === id)!;
    expect(by("q1")).toEqual({
      id: "q1",
      kind: "text",
      md: "why 3?",
      at: { card: "a", seg: "sa", lines: [3, 3] },
      q: { at: 30 },
    });
    expect(by("q2")).toEqual({
      id: "q2",
      kind: "text",
      md: "and this?",
      at: { card: "n" },
      q: { at: 20, done: true, answers: [{ id: expect.any(String), md: "[[Why#^n]]", at: 20 }] },
    });
    // free on the canvas: the badge is centred where the sticker was drawn
    expect(by("q3")).toEqual({ id: "q3", kind: "text", md: "", at: { x: 120, y: 220 }, q: { at: 0 } });
    // on an arrow: the line the arrow leaves
    expect(by("q4").at).toEqual({ card: "a", seg: "sa", lines: [7, 7] });
    // their lines are Highlights, as adding a sidenote there makes them
    expect((b.cards[0] as CodeCard).segments[0].hl).toEqual([
      [3, 3],
      [7, 7],
    ]);
    expect(danglingRefs(b)).toEqual([]);
    // once: the upgraded board is read as is
    expect(upgraded(structuredClone(b))).toEqual(b);
  });

  it("one on a library card stays on this board (Board-only); those on the Shelf become their cards' sidenotes", () => {
    const raw: any = v16();
    raw.cards = [{ id: "a", kind: "shared" }, raw.cards[1]];
    raw.place.s = { x: 0, y: 900, w: 300 };
    raw.cards.push({ id: "s", kind: "note", look: "note", md: "shelved" });
    delete raw.place.s;
    raw.shelf = [
      {
        id: "e",
        at: 1,
        place: { s: { x: 0, y: 900, w: 300 } },
        sections: [],
        links: [],
        stickers: [{ id: "q5", icon: Q, at: { kind: "canvas", x: 0, y: 0, on: { card: "s" } }, q: { md: "later" } }],
      },
    ];
    raw.stickers = raw.stickers.slice(0, 1);
    const f = migrateBoard(raw);
    expect(f.sidenotes).toEqual([
      {
        id: "q1",
        kind: "text",
        md: "why 3?",
        at: { card: "a", seg: "sa", lines: [3, 3] },
        q: { at: 30 },
        boardOnly: true,
      },
      { id: "q5", kind: "text", md: "later", at: { card: "s" }, q: { at: 0 } },
    ]);
    expect(f.stickers).toEqual([]);
    expect(f.shelf?.[0].stickers).toEqual([]);
  });
});
