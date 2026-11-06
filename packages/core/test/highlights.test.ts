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
  DEFAULT_SETTINGS,
  makeTwin,
  mergeCodeCards,
  rebaseSegment,
  removeHighlights,
  shownRanges,
  switchVariant,
  addVariant,
  unmergeCard,
  unionRanges,
  WIDENED,
  UPSTREAM,
  type Board,
  type CodeCard,
  type Segment,
  type Sidenote,
} from "../src";
import { splitSegment, toggleBoardOnly, toggleVariantOnly, type CommandEnv } from "../src/commands";

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

  it("upgrades a shared card's library file; a board's board-only sidenote on it stays a Highlight of its own", () => {
    const sc = loadSharedCard({ version: 12, card: code("k", [2, 3]), sidenotes: [note("a", "k", [3, 5])] });
    expect(sc.version).toBe(13);
    expect((sc.card as CodeCard).segments[0].hl).toEqual([[2, 5]]);
    expect(sc.sidenotes?.[0].at.lines).toEqual([2, 5]);

    const raw = v12([{ id: "k", kind: "shared" }], [{ ...note("own", "k", [10, 11]), boardOnly: true }]);
    const { file } = readBoardFile(raw);
    // Storage puts the library's card in: its Highlights stay the shared ones, the board shows its own note's lines too
    const b = { ...file, cards: [sc.card], sidenotes: [...file.sidenotes, ...sc.sidenotes] } as Board;
    const s = (b.cards[0] as CodeCard).segments[0];
    expect(s.hl).toEqual([[2, 5]]);
    expect(shownRanges(b, s)).toEqual([
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

/** Commands on a plain board: every edit applied at once */
const envOf = (b: Board): CommandEnv => ({
  board: () => b,
  edit: (fn) => {
    fn(b);
    return true;
  },
  fresh: { add: (_id, fn) => fn(b), is: () => false, settle: () => {} },
  ask: (async () => null) as CommandEnv["ask"],
  choose: async () => null,
  toast: () => {},
  settings: () => DEFAULT_SETTINGS,
  boardsOf: () => [],
});
const segAt = (id: string, start: number, end: number, hl?: [number, number][]): Segment => ({
  ...seg(id),
  start,
  end,
  text: Array.from({ length: end - start + 1 }, (_, i) => `x${start + i} = ${start + i}`),
  ...(hl ? { hl } : {}),
});

describe("Highlights through card edits", () => {
  const s0 = (b: Board) => (b.cards[0] as CodeCard).segments[0];
  const one = (hl: [number, number][], notes: Sidenote[]) => {
    const b = emptyBoard("b", "b");
    b.cards.push(code("k", hl));
    b.place.k = { x: 0, y: 0, w: 500 };
    b.sidenotes.push(...notes);
    return b;
  };

  it("a split cuts a Highlight at the parts' ends, and its note to the part with its first line", () => {
    for (const merge of [false, true]) {
      // segment 1–30 (seg()), Highlight 5–12 with a note; parts 1–8 and 9–30
      const b = one([[5, 12]], [note("a", "k", [5, 12])]);
      const parts = [segAt("p1", 1, 8), segAt("p2", 9, 30)];
      splitSegment(
        envOf(b),
        "k",
        parts,
        merge ? { merge: true } : { merge: false, at: { x: 0, y: 0, w: 500, h: 300 } },
      );
      const segs = b.cards.flatMap((c) => (c.kind === "code" ? c.segments : []));
      expect(segs.map((s) => s.hl)).toEqual([[[5, 8]], [[9, 12]]]);
      const n = b.sidenotes[0];
      expect(n.at.lines).toEqual([5, 8]);
      expect(n.at.seg).toBe(segs[0].id);
      expect(danglingRefs(b)).toEqual([]);
    }
  });

  it("unmerging gives each card the Highlights on its lines, and the notes are cut to them", () => {
    const b = emptyBoard("b", "b");
    b.cards.push(
      { id: "a", kind: "code", segments: [segAt("sa", 1, 10, [[3, 6]])] } as CodeCard,
      { id: "c", kind: "code", segments: [segAt("sc", 20, 30, [[22, 25]])] } as CodeCard,
    );
    b.place.a = { x: 0, y: 0, w: 400 };
    b.place.c = { x: 500, y: 0, w: 400 };
    b.sidenotes.push(
      { id: "na", kind: "text", md: "a", at: { card: "a", seg: "sa", lines: [3, 6] } },
      { id: "nc", kind: "text", md: "c", at: { card: "c", seg: "sc", lines: [22, 25] } },
    );
    const m = mergeCodeCards(b, ["a", "c"], "a")!;
    expect(danglingRefs(b)).toEqual([]);
    const out = unmergeCard(b, m.id)!;
    const cards = out.made.map((id) => b.cards.find((c) => c.id === id) as CodeCard);
    expect(cards.map((c) => c.segments[0].hl)).toEqual([[[3, 6]], [[22, 25]]]);
    expect(b.sidenotes.map((n) => n.at.lines)).toEqual([
      [3, 6],
      [22, 25],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("a Highlight outside its segment is cut to it, and the self-check names one", () => {
    const b = one([[25, 40]], [note("a", "k", [25, 40])]);
    expect(danglingRefs(b).join("\n")).toMatch(/outside/);
    fixHighlights(b);
    expect(s0(b).hl).toEqual([[25, 30]]);
    expect(b.sidenotes[0].at.lines).toEqual([25, 30]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("notes widened by a merge of Highlights are marked for review, outside of reading an old file", () => {
    const b = one([[2, 8]], [note("a", "k", [2, 8]), note("b", "k", [6, 10]), note("c", "k", [20, 20])]);
    // b's lines came from elsewhere (a version update moved them onto a's): fixing merges the two
    fixHighlights(b);
    expect(s0(b).hl).toEqual([
      [2, 10],
      [20, 20],
    ]);
    expect(b.sidenotes.map((n) => [n.at.lines, n.review])).toEqual([
      [[2, 10], WIDENED],
      [[2, 10], WIDENED],
      [[20, 20], undefined],
    ]);
    const old = loadBoardFile(v12([code("k", [2, 3, 4, 5, 6, 7, 8])], [note("b", "k", [6, 10])]));
    expect(old.sidenotes[0].at.lines).toEqual([2, 10]);
    expect(old.sidenotes[0].review).toBeUndefined();
  });

  it("the places of a twin all carry the copy's Highlights, with its notes on them", () => {
    const b = one([[2, 3]], [note("a", "k", [2, 3])]);
    b.cards.push(code("t"));
    b.place.t = { x: 600, y: 0, w: 500 };
    b.sidenotes.push(note("b", "t", [7, 9]));
    expect(makeTwin(b, "t", "k")).toBe(true);
    const [k, t] = b.cards as CodeCard[];
    expect(k.segments[0].hl).toEqual([
      [2, 3],
      [7, 9],
    ]);
    expect(t.segments[0].hl).toEqual(k.segments[0].hl);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("switching Variants keeps each one's Highlights; a note only in a Variant counts in its segments", () => {
    const b = one([[2, 3]], [note("a", "k", [2, 3])]);
    // the Variant's code has 2 lines more at the top: line 2 there is line 4
    const mine = { ...seg("s-k"), text: ["# a", "# b", ...seg("s-k").text], end: 32 };
    addVariant(b, "k", { id: "v1", name: "mine", from: { kind: "worktree", path: "/wt" }, segs: [mine] } as never);
    expect(switchVariant(b, "k", "v1")).toBe(true);
    expect(s0(b).hl).toEqual([[4, 5]]);
    expect(b.sidenotes[0].at.lines).toEqual([4, 5]);
    expect(danglingRefs(b)).toEqual([]);
    // a note on this Variant only: its Highlight goes with the Variant's segments when switching back
    b.sidenotes.push(note("v", "k", [20, 21]));
    fixHighlights(b);
    toggleVariantOnly(envOf(b), "v");
    expect(b.sidenotes[1].variant).toBe("v1");
    expect(switchVariant(b, "k", UPSTREAM)).toBe(true);
    const v1 = (b.cards[0] as CodeCard).variants!.find((v) => v.id === "v1")!;
    expect(v1.segs![0].hl?.some((r) => r[0] === 20)).toBe(true);
    expect(danglingRefs(b)).toEqual([]);
  });
});

describe("local sidenotes (board-only, Card)", () => {
  const shared = () => {
    const b = emptyBoard("b", "b");
    b.cards.push(code("k", [[2, 4]]));
    b.place.k = { x: 0, y: 0, w: 500 };
    b.sidenotes.push(note("a", "k", [2, 4]), { ...note("own", "k", [3, 8]), boardOnly: true });
    return b;
  };
  const s0 = (b: Board) => (b.cards[0] as CodeCard).segments[0];

  it("never write their lines into the segment's Highlights, which the card carries to other boards", () => {
    const b = shared();
    fixHighlights(b);
    onHighlight(b, b.sidenotes[1]);
    expect(s0(b).hl).toEqual([[2, 4]]);
    expect(shownRanges(b, s0(b))).toEqual([[2, 8]]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("stay when another board removes or changes the shared Highlight", () => {
    // another board's edit, as it reaches this one: the shared range and note gone, or the range grown
    const b = shared();
    s0(b).hl = undefined;
    b.sidenotes = b.sidenotes.filter((n) => n.id !== "a");
    expect(danglingRefs(b)).toEqual([]);
    expect(shownRanges(b, s0(b))).toEqual([[3, 8]]);
    const c = shared();
    s0(c).hl = [[1, 12]];
    c.sidenotes[0].at.lines = [1, 12];
    expect(danglingRefs(c)).toEqual([]);
    expect(shownRanges(c, s0(c))).toEqual([[1, 12]]);
  });

  it("made board-only, a note takes along the shared Highlight that was only its own; going along again brings it back", () => {
    const b = shared();
    b.sidenotes.push(note("x", "k", [10, 12]));
    fixHighlights(b);
    expect(s0(b).hl).toEqual([
      [2, 4],
      [10, 12],
    ]);
    toggleBoardOnly(envOf(b), "x");
    expect(s0(b).hl).toEqual([[2, 4]]);
    expect(shownRanges(b, s0(b))).toEqual([
      [2, 8],
      [10, 12],
    ]);
    // a's Highlight has another note that goes along: it stays when a is made board-only
    b.sidenotes.push(note("a2", "k", [2, 4]));
    toggleBoardOnly(envOf(b), "a");
    expect(s0(b).hl).toEqual([[2, 4]]);
    toggleBoardOnly(envOf(b), "x");
    expect(s0(b).hl).toEqual([
      [2, 4],
      [10, 12],
    ]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("removing a Highlight as shown takes the shared range and every note in it, local ones too", () => {
    const b = shared();
    expect(removeHighlights(b, s0(b), [[2, 8]])).toBe(2);
    expect(s0(b).hl).toBeUndefined();
    expect(b.sidenotes).toEqual([]);
  });
});
