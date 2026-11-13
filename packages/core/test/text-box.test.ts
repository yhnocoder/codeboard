// → v16: the old Text, Free Text, Mark and Box become a Text or a Box (Markdown at a size of their own), as close to the
// pixels they had as the new looks allow; shared cards' library files and the places boards keep of them too
import { describe, expect, it } from "vitest";
import {
  cardTitle,
  checkBoard,
  emptyBoard,
  loadSharedCard,
  mapRefs,
  migrateBoard,
  readBoardFile,
  type Board,
  type NoteCard,
} from "../src";

const v13 = (cards: object[], place: Record<string, object> = {}, more: object = {}) => ({
  ...emptyBoard("b", "B"),
  version: 13,
  cards,
  place: {
    ...Object.fromEntries(cards.map((c, i) => [(c as { id: string }).id, { x: 0, y: 100 * i, w: 300 }])),
    ...place,
  },
  ...more,
});
const note = (id: string, o: object) => ({ id, kind: "note", md: "x", ...o });
const cardsOf = (b: { cards: unknown[] }) =>
  Object.fromEntries((JSON.parse(JSON.stringify(b.cards)) as NoteCard[]).map((c) => [c.id, c]));
const valid = (b: ReturnType<typeof migrateBoard>) => checkBoard({ ...b, cam: { x: 0, y: 0, z: 1 } } as Board);

describe("the old Text becomes a Text that wraps at its width", () => {
  it("a title or heading line becomes # or ## at the size that keeps its pixels; bold body text is **bold**", () => {
    const b = migrateBoard(
      v13([
        note("t", { look: "text", size: "title", md: "Scheduler step" }),
        note("h", { look: "text", size: "heading", md: "prefill\n\ndecode", bold: true }),
        note("bb", { look: "text", size: "body", md: "keep this", bold: true }),
        note("bs", { look: "text", size: "body", md: "keep **this**", bold: true }),
        note("b", { look: "text", md: "just words" }),
      ]),
    );
    const by = cardsOf(b);
    // 26 / 1.8 and 16 / 1.35, to the half pixel: the heading is 26.1 and 16.2 px, in the heading's own font and weight
    expect(by.t).toEqual({ id: "t", kind: "note", look: "text", md: "# Scheduler step", wrap: true, fs: 14.5 });
    expect(by.h).toEqual({ id: "h", kind: "note", look: "text", md: "## prefill\n\n## decode", wrap: true, fs: 12 });
    expect(by.bb).toEqual({ id: "bb", kind: "note", look: "text", md: "**keep this**", wrap: true, fs: 13.5 });
    // its own bold would nest into something else: it stays as written
    expect(by.bs).toMatchObject({ md: "keep **this**", fs: 13.5 });
    expect(by.b).toEqual({ id: "b", kind: "note", look: "text", md: "just words", wrap: true, fs: 13.5 });
    expect(b.place.t).toEqual({ x: 0, y: 0, w: 300 });
    valid(b);
  });

  it("Markdown that is more than plain lines stays as written, at the level's size", () => {
    const md = "# Plan\n\n- one\n- two";
    const by = cardsOf(
      migrateBoard(
        v13([
          note("t", { look: "text", size: "title", md }),
          note("s", { look: "text", size: "title", md: "two\nlines" }),
          note("b", { look: "text", size: "body", md, bold: true }),
        ]),
      ),
    );
    expect(by.t).toMatchObject({ md, fs: 26 });
    expect(by.s).toMatchObject({ md: "two\nlines", fs: 26 });
    expect(by.b).toMatchObject({ md, fs: 13.5 });
    expect(by.b).not.toHaveProperty("bold");
  });
});

describe("a Free Text becomes a Text as wide as its text", () => {
  it("its plain text becomes Markdown that shows the same: a paragraph a line, markup escaped, spaces kept", () => {
    const text =
      "  # not a heading *or* `code`\n\n- 1. $5 [x](y) <b> ==hi== ^2^ {a} :smile: &amp;\nblock_manager   wide";
    const b = migrateBoard(v13([note("f", { look: "freetext", md: text })]));
    expect(cardsOf(b).f).toEqual({
      id: "f",
      kind: "note",
      look: "text",
      md: [
        "  \\# not a heading \\*or\\* \\`code\\`",
        "&nbsp;",
        "\\- 1. \\$5 \\[x\\](y) \\<b> \\==hi\\== \\^2\\^ \\{a} \\:smile: &amp;amp;",
        "block\\_manager   wide",
      ].join("\n\n"),
    });
    valid(b);
  });

  it("every Markdown special in its text is escaped, so it reads as typed", () => {
    const lines = [
      "_word_ and __strong__",
      "*star* and `tick` and [link](u)",
      "# hash",
      "> quote",
      "- dash",
      "+ plus",
      "1. one",
      "$x$ math",
      "==hl==",
      "back\\slash",
      "<b>tag</b>",
      "a | b | c",
    ];
    const md = cardsOf(migrateBoard(v13([note("f", { look: "freetext", md: lines.join("\n") })]))).f.md;
    expect(md.split("\n\n")).toEqual([
      "\\_word\\_ and \\_\\_strong\\_\\_",
      "\\*star\\* and \\`tick\\` and \\[link\\](u)",
      "\\# hash",
      "\\> quote",
      "\\- dash",
      "\\+ plus",
      "1\\. one",
      "\\$x\\$ math",
      "\\==hl\\==",
      "back\\\\slash",
      "\\<b>tag\\</b>",
      "a \\| b \\| c",
    ]);
  });

  it("H1 and H2 become #, H3 ##, at the size that keeps their pixels; bold lines are **bold**", () => {
    const by = cardsOf(
      migrateBoard(
        v13([
          note("h1", { look: "freetext", md: "Big", level: 1 }),
          note("h2", { look: "freetext", md: "Sub\nline", level: 2, fs: 64 }),
          note("h3", { look: "freetext", md: "Small", level: 3, bold: true }),
          note("p", { look: "freetext", md: "Plain", fs: 30, bold: true }),
          note("one", { look: "freetext", md: "1) first" }),
        ]),
      ),
    );
    expect(by.h1).toEqual({ id: "h1", kind: "note", look: "text", md: "# Big", fs: 22 });
    expect(by.h2).toEqual({ id: "h2", kind: "note", look: "text", md: "# Sub\n\n# line", fs: 35.5 });
    expect(by.h3).toEqual({ id: "h3", kind: "note", look: "text", md: "## **Small**", fs: 18 });
    expect(by.p).toEqual({ id: "p", kind: "note", look: "text", md: "**Plain**", fs: 30 });
    // the plain level at its 20 px is the new Text's default size: none is written
    expect(by.one).toEqual({ id: "one", kind: "note", look: "text", md: "1\\) first" });
  });

  it("one from before levels (always a heading) is H1 at 40 px", () => {
    const old = { ...v13([note("f", { look: "freetext", md: "Scheduler" })]), version: 11 };
    expect(cardsOf(migrateBoard(old)).f).toEqual({ id: "f", kind: "note", look: "text", md: "# Scheduler", fs: 22 });
  });
});

describe("with the v15 Sidenote step before it", () => {
  const seg = {
    id: "sk",
    src: { kind: "repo", repo: "" },
    path: "a.py",
    lang: "python",
    start: 1,
    end: 3,
    text: ["a", "b", "c"],
    version: { kind: "git", commit: "c0ffee" },
    hl: [[2, 2]],
  };
  const at = { card: "k", seg: "sk", lines: [2, 2] };

  it("a literal [[ in a Free Text stays text, not a reference, and its title reads as typed", () => {
    const b = migrateBoard(v13([note("f", { look: "freetext", md: "see [[Scheduler]] and [docs](u) & a*b*" })]));
    const f = cardsOf(b).f;
    const refs: string[] = [];
    mapRefs(f.md, (r) => void refs.push(r.label));
    expect(f.md).toBe("see \\[\\[Scheduler\\]\\] and \\[docs\\](u) & a\\*b\\*");
    expect(refs).toEqual([]);
    expect(cardTitle(f)).toBe("see [[Scheduler]] and [docs](u) & a*b*");
    valid(b);
  });

  it("a Card sidenote on a Free Text or a Mark becomes a Text sidenote with a [[reference]] to the Text it became", () => {
    const b = migrateBoard(
      v13(
        [
          { id: "k", kind: "code", segments: [seg] },
          note("f", { look: "freetext", level: 1, md: "Attention" }),
          note("m", { look: "mark", md: "picks **this**" }),
        ],
        {},
        {
          sidenotes: [
            { id: "s1", kind: "card", card: "f", at },
            { id: "s2", kind: "card", card: "m", at },
          ],
        },
      ),
    );
    const by = cardsOf(b);
    expect(by.f).toMatchObject({ look: "text", md: "# Attention" });
    expect(by.m).toMatchObject({ look: "text", md: "picks **this**" });
    expect(b.sidenotes.map((n) => (n.kind === "text" ? [n.md, n.boardOnly] : n.kind))).toEqual([
      ["[[Attention#^f]]", true],
      ["[[picks this#^m]]", true],
    ]);
    expect([cardTitle(by.f), cardTitle(by.m)]).toEqual(["Attention", "picks this"]);
    valid(b);
  });

  it("an empty Free Text stays empty", () => {
    expect(cardsOf(migrateBoard(v13([note("e", { look: "freetext", md: "  \n " })]))).e.md).toBe("");
  });
});

describe("with the v14 step before it", () => {
  it("a v13 file goes through both: <mark> becomes == in Markdown looks, a Free Text's plain text stays literal", () => {
    const by = cardsOf(
      migrateBoard(
        v13([
          note("f", { look: "freetext", md: "<mark>as typed</mark> and ==this==" }),
          note("t", { look: "text", size: "title", md: "<mark>hot</mark> path" }),
          note("m", { look: "mark", hand: "blue", md: "<mark>see</mark>" }),
        ]),
      ),
    );
    expect(by.f.md).toBe("\\<mark>as typed\\</mark> and \\==this\\==");
    // a literal <mark>x</mark> in a Free Text's plain text: v14 leaves it, v16 escapes it, so it shows as typed
    const lit = cardsOf(migrateBoard(v13([note("x", { look: "freetext", md: "<mark>x</mark>" })]))).x;
    expect(lit).toEqual({ id: "x", kind: "note", look: "text", md: "\\<mark>x\\</mark>" });
    expect(by.t).toMatchObject({ md: "# ==hot== path", fs: 14.5 });
    expect(by.m).toMatchObject({ md: "==see==", fs: 18 });
  });
});

describe("a Mark becomes a Text, a Box stays a Box", () => {
  it("a Mark keeps its Markdown, size and width; its colour and weight go", () => {
    const by = cardsOf(
      migrateBoard(
        v13([
          note("m", { look: "mark", hand: "orange", weight: "bold", md: "picks **this**" }),
          note("l", { look: "mark", hand: "blue", fs: 32 }),
        ]),
      ),
    );
    expect(by.m).toEqual({ id: "m", kind: "note", look: "text", md: "picks **this**", wrap: true, fs: 18 });
    expect(by.l).toEqual({ id: "l", kind: "note", look: "text", md: "x", wrap: true, fs: 32 });
  });

  it("a Box keeps its fill and width at its old text size; the least height it had goes, here and on the Shelf", () => {
    const shelf = [
      { id: "e", at: 1, place: { s: { x: 0, y: 0, w: 120, h: 90 } }, sections: [], links: [], stickers: [] },
    ];
    const b = migrateBoard(
      v13(
        [note("x", { look: "box", fill: "blue", md: "prefill" }), note("s", { look: "box" })],
        { x: { x: 5, y: 6, w: 140, h: 60 } },
        { shelf },
      ),
    );
    delete b.place.s;
    expect(cardsOf(b).x).toEqual({
      id: "x",
      kind: "note",
      look: "box",
      fill: "blue",
      md: "prefill",
      wrap: true,
      fs: 13.5,
    });
    expect(b.place.x).toEqual({ x: 5, y: 6, w: 140 });
    expect(b.shelf?.[0].place.s).toEqual({ x: 0, y: 0, w: 120 });
    valid(b);
  });

  it("leaves Notes and v16 boards as they are", () => {
    const raw = v13([note("n", { look: "note", md: "# Note" })], { n: { x: 0, y: 0, w: 300, h: 200 } });
    const b = migrateBoard(raw);
    expect(cardsOf(b).n).toEqual({ id: "n", kind: "note", look: "note", md: "# Note" });
    expect(b.place.n.h).toBe(200);
    const now = migrateBoard(v13([note("t", { look: "freetext", md: "a*b" })]));
    expect(migrateBoard(structuredClone(now))).toEqual(now);
  });
});

describe("shared cards", () => {
  it("a library file's card is upgraded, and a board's height for a shared Box goes once the card is in", () => {
    const sc = loadSharedCard({ version: 13, card: note("x", { look: "box", fill: "pink" }), sidenotes: [] });
    expect(sc).toEqual({
      version: 16,
      card: { id: "x", kind: "note", look: "box", fill: "pink", md: "x", wrap: true, fs: 13.5 },
      sidenotes: [],
    });
    const raw = v13([{ kind: "shared", id: "x" }, note("n", { look: "note" })], {
      x: { x: 0, y: 0, w: 200, h: 80 },
      n: { x: 0, y: 0, w: 200, h: 80 },
    });
    const { file, inflated } = readBoardFile(raw);
    const b = { ...file, cam: { x: 0, y: 0, z: 1 }, cards: [sc.card, ...file.cards.slice(1)] } as Board;
    inflated?.(b);
    expect(b.place.x).toEqual({ x: 0, y: 0, w: 200 });
    expect(b.place.n.h).toBe(80);
  });
});
