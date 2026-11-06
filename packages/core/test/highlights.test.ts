import { describe, expect, it } from "vitest";
import {
  addHighlight,
  danglingRefs,
  emptyBoard,
  fixHighlights,
  loadBoardFile,
  loadSharedCard,
  onHighlight,
  readBoardFile,
  rebaseSegment,
  removeHighlights,
  unionRanges,
  type Board,
  type CodeCard,
  type Segment,
  type Sidenote,
} from "../src";

const seg = (id: string, hl?: unknown): Segment =>
  ({
    id,
    src: { kind: "free" },
    path: "",
    lang: "python",
    start: 1,
    end: 30,
    text: Array.from({ length: 30 }, (_, i) => `x${i + 1} = ${i + 1}`),
    version: { kind: "none" },
    ...(hl ? { hl } : {}),
  }) as Segment;
const code = (id: string, hl?: unknown): CodeCard => ({ id, kind: "code", segments: [seg(`s-${id}`, hl)] }) as CodeCard;
const note = (id: string, card: string, lines: [number, number]): Sidenote => ({
  id,
  kind: "text",
  md: id,
  at: { card, seg: `s-${card}`, lines },
});

/** A v12 board file: Highlights as a list of single lines */
function v12(cards: unknown[], sidenotes: unknown[] = []) {
  const place = Object.fromEntries((cards as { id: string }[]).map((c, i) => [c.id, { x: i * 600, y: 0, w: 500 }]));
  return { version: 12, name: "b", cards, links: [], sections: [], sidenotes, stickers: [], place };
}

describe("v12 → v13 Highlights", () => {
  it("turns highlighted lines into their consecutive runs, in any order and with repeats", () => {
    const b = loadBoardFile(v12([code("k", [9, 3, 4, 5, 5, 12, 10])]));
    expect(b.version).toBe(13);
    expect((b.cards[0] as CodeCard).segments[0].hl).toEqual([
      [3, 5],
      [9, 10],
      [12, 12],
    ]);
  });

  it("gives every sidenote on lines a Highlight of exactly its lines", () => {
    const b = loadBoardFile(v12([code("k")], [note("a", "k", [4, 6]), note("b", "k", [20, 20])]));
    expect((b.cards[0] as CodeCard).segments[0].hl).toEqual([
      [4, 6],
      [20, 20],
    ]);
    expect(b.sidenotes.map((n) => n.at.lines)).toEqual([
      [4, 6],
      [20, 20],
    ]);
    expect(danglingRefs(b as Board)).toEqual([]);
  });

  it("merges overlapping and nested ranges into their union and moves the sidenotes on them to it", () => {
    // lines 3–5 highlighted; a note on 5–8 crosses them, one on 4–4 is inside, one on 7 nests in the note's range
    const b = loadBoardFile(
      v12([code("k", [3, 4, 5, 15])], [note("a", "k", [5, 8]), note("b", "k", [4, 4]), note("c", "k", [7, 7])]),
    );
    expect((b.cards[0] as CodeCard).segments[0].hl).toEqual([
      [3, 8],
      [15, 15],
    ]);
    expect(b.sidenotes.map((n) => n.at.lines)).toEqual([
      [3, 8],
      [3, 8],
      [3, 8],
    ]);
    expect(danglingRefs(b as Board)).toEqual([]);
  });

  it("keeps adjacent ranges apart", () => {
    const b = loadBoardFile(v12([code("k")], [note("a", "k", [2, 4]), note("b", "k", [5, 6])]));
    expect((b.cards[0] as CodeCard).segments[0].hl).toEqual([
      [2, 4],
      [5, 6],
    ]);
  });

  it("upgrades a shared card's library file, and a board's board-only sidenotes on it once the card is in", () => {
    const sc = loadSharedCard({ version: 12, card: code("k", [2, 3]), sidenotes: [note("a", "k", [3, 5])] });
    expect(sc.version).toBe(13);
    expect((sc.card as CodeCard).segments[0].hl).toEqual([[2, 5]]);
    expect(sc.sidenotes?.[0].at.lines).toEqual([2, 5]);

    const raw = v12([{ id: "k", kind: "shared" }], [{ ...note("own", "k", [10, 11]), boardOnly: true }]);
    const { file, inflated } = readBoardFile(raw);
    expect(inflated).toBeTypeOf("function");
    // Storage puts the library's card in, then runs the hook
    const b = { ...file, cards: [sc.card] } as Board;
    inflated!(b);
    expect((b.cards[0] as CodeCard).segments[0].hl).toEqual([
      [2, 5],
      [10, 11],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });
});

describe("Highlight upkeep", () => {
  const board = (hl?: [number, number][], notes: Sidenote[] = []) => {
    const b = emptyBoard("b", "b");
    b.cards.push(code("k", hl));
    b.place.k = { x: 0, y: 0, w: 500 };
    b.sidenotes.push(...notes);
    return b;
  };
  const s0 = (b: Board) => (b.cards[0] as CodeCard).segments[0];

  it("unionRanges sorts, merges overlaps and nesting, keeps neighbours", () => {
    expect(
      unionRanges([
        [10, 12],
        [1, 3],
        [2, 5],
        [11, 11],
        [6, 6],
      ]),
    ).toEqual([
      [1, 5],
      [6, 6],
      [10, 12],
    ]);
  });

  it("adding lines that touch Highlights makes one Highlight, and the notes on them move with it", () => {
    const b = board(
      [
        [2, 3],
        [6, 7],
        [20, 21],
      ],
      [note("a", "k", [2, 3]), note("b", "k", [6, 7])],
    );
    expect(addHighlight(b, s0(b), [3, 6])).toEqual([2, 7]);
    expect(s0(b).hl).toEqual([
      [2, 7],
      [20, 21],
    ]);
    expect(b.sidenotes.map((n) => n.at.lines)).toEqual([
      [2, 7],
      [2, 7],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("a new note on lines inside a Highlight takes the Highlight's lines; on new lines it makes one", () => {
    const b = board([[4, 9]]);
    const inside = note("a", "k", [5, 5]),
      outside = note("b", "k", [12, 13]);
    b.sidenotes.push(inside, outside);
    onHighlight(b, inside);
    onHighlight(b, outside);
    expect(inside.at.lines).toEqual([4, 9]);
    expect(s0(b).hl).toEqual([
      [4, 9],
      [12, 13],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("removing a Highlight removes the notes on it and leaves the others", () => {
    const b = board(
      [
        [2, 3],
        [8, 8],
      ],
      [note("a", "k", [2, 3]), note("b", "k", [2, 3]), note("c", "k", [8, 8])],
    );
    expect(removeHighlights(b, s0(b), [[2, 3]])).toBe(2);
    expect(s0(b).hl).toEqual([[8, 8]]);
    expect(b.sidenotes.map((n) => n.id)).toEqual(["c"]);
  });

  it("danglingRefs finds a line sidenote with no Highlight, and Highlights that overlap", () => {
    const b = board([[2, 3]], [note("a", "k", [5, 6])]);
    expect(danglingRefs(b).join("\n")).toMatch(/no Highlight/);
    const c = board([
      [2, 5],
      [4, 8],
    ]);
    expect(danglingRefs(c).join("\n")).toMatch(/overlap/);
    fixHighlights(c);
    expect(s0(c).hl).toEqual([[2, 8]]);
    expect(danglingRefs(c)).toEqual([]);
  });

  it("when lines move in a new version, a Highlight and its notes move with them", () => {
    const b = board(
      [
        [3, 4],
        [8, 9],
      ],
      [note("a", "k", [3, 4]), note("b", "k", [8, 9])],
    );
    // lines 5–7 deleted: 8–9 become 5–6, next to 3–4 (adjacent, still apart)
    const old = s0(b);
    const text = old.text.filter((_, i) => i < 4 || i > 6);
    rebaseSegment(b, "k", { ...old, text, end: text.length });
    expect(s0(b).hl).toEqual([
      [3, 4],
      [5, 6],
    ]);
    expect(b.sidenotes.map((n) => n.at.lines)).toEqual([
      [3, 4],
      [5, 6],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });
});
