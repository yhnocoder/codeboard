// The rules a board button or key applies, as core commands on a plain board with a scripted env (env.fresh included): what each
// changes, what it keeps out of the stored board, and when it changes nothing
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MARK_SIZES,
  TEXT_FS,
  FREE_TEXT_FS,
  migrateBoard,
  migrateSharedCard,
  markSizeOf,
  cardTitle,
  scaleText,
  scalesText,
  textSizeOf,
  danglingRefs,
  emptyBoard,
  removeCards,
  removeStickers,
  type Board,
  type Card,
  type CodeCard,
  type Segment,
} from "../src";
import * as C from "../src/commands";

const seg = (id: string, text: string[], src: Segment["src"] = { kind: "repo", repo: "" }): Segment => ({
  id,
  src,
  path: "m.py",
  lang: "python",
  start: 1,
  end: text.length,
  text,
  version: { kind: "none" },
});
const code = (id: string, text = ["def f():", "  pass"]): CodeCard => ({
  id,
  kind: "code",
  segments: [seg(`s${id}`, text)],
});
const note = (id: string, md: string): Card => ({ id, kind: "note", md, look: "note" });

function setup(cards: Card[] = []) {
  const b: Board = emptyBoard("b", "B");
  cards.forEach((c, i) => {
    b.cards.push(c);
    b.place[c.id] = { x: 500 * i, y: 0, w: 400 };
  });
  const log = { edits: 0 };
  const fresh = new Set<string>();
  const env: C.CommandEnv = {
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
    ask: (async () => null) as C.CommandEnv["ask"],
    choose: async () => null,
    toast: () => {},
    settings: () => DEFAULT_SETTINGS,
    boardsOf: () => [],
  };
  return { b, env, log };
}
const segOf = (b: Board, id: string) => (b.cards.find((c) => c.id === id) as CodeCard).segments[0];
const noSettle = () => {};

describe("code card rules", () => {
  it("hiding lines merges the hidden ranges they overlap or touch, in line order", () => {
    const { b, env } = setup([
      code(
        "a",
        Array.from({ length: 20 }, (_, i) => `l${i}`),
      ),
    ]);
    segOf(b, "a").hidden = [
      [2, 3],
      [10, 12],
      [15, 16],
    ];
    C.hideLines(env, { card: "a", seg: "sa", start: 4, end: 9 });
    expect(segOf(b, "a").hidden).toEqual([
      [2, 12],
      [15, 16],
    ]);
  });

  it("highlighting removes the Highlights only when all the lines are highlighted already, else grows one over them", () => {
    const { b, env } = setup([code("a", ["a", "b", "c", "d"])]);
    segOf(b, "a").hl = [[1, 1]];
    b.sidenotes.push({ id: "n1", at: { card: "a", seg: "sa", lines: [1, 1] }, kind: "text", md: "x" });
    C.toggleHighlight(env, { card: "a", seg: "sa", start: 1, end: 2 });
    expect(segOf(b, "a").hl).toEqual([[1, 2]]);
    expect(b.sidenotes[0].at.lines).toEqual([1, 2]); // the note moves with its Highlight
    // lines next to a Highlight make one of their own
    C.toggleHighlight(env, { card: "a", seg: "sa", start: 3, end: 3 });
    expect(segOf(b, "a").hl).toEqual([
      [1, 2],
      [3, 3],
    ]);
    // one line of a Highlight: the whole Highlight goes, its notes with it
    expect(C.toggleHighlight(env, { card: "a", seg: "sa", start: 2, end: 2 })).toBe(1);
    expect(segOf(b, "a").hl).toEqual([[3, 3]]);
    expect(b.sidenotes).toEqual([]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("Free code's language follows its text until picked by hand, and again when set back to auto", () => {
    const { b, env } = setup([
      { ...code("a", [""]), segments: [{ ...seg("sa", [""], { kind: "free" }), lang: "cpp" }] },
    ]);
    const py = "import triton\n@triton.jit\ndef k(x):\n    tl.load(x)";
    expect(C.writeFreeCode(env, "a", py)?.lang).toBe("triton");
    expect(segOf(b, "a").end).toBe(4);
    C.setCodeLang(env, "a", "cuda");
    C.writeFreeCode(env, "a", "def f():\n    return 1");
    expect(segOf(b, "a").lang).toBe("cuda");
    expect(C.setCodeLang(env, "a", null)?.lang).toBe("python");
    // text that looks like no language leaves it as it is
    C.writeFreeCode(env, "a", "hello");
    expect(segOf(b, "a").lang).toBe("python");
  });

  it("editing Free code moves its Highlights and the sidenotes on them with their lines", () => {
    // the user's vecAdd card: Highlights on 5-7 and 9-10 (with notes), 14 and 16-18; blank line 8 deleted
    const text = [
      "void vecAdd(float* A_h, float* B_h, float* C_h, int n) {",
      "    int size = n * sizeof(float);",
      "    float *A_d, *B_d, *C_d;",
      "",
      "    cudaMalloc((void **)&A_d, size);",
      "    cudaMalloc((void **)&B_d, size);",
      "    cudaMalloc((void **)&C_d, size);",
      "",
      "    cudaMemcpy(A_d, A_h, size, cudaMemcpyHostToDevice);",
      "    cudaMemcpy(B_d, B_h, size, cudaMemcpyHostToDevice);",
      "    // Part2: Call kernel - to launch a grid of kernel",
      "    // to perform the actual vector addition",
      "",
      "    cudaMemcpy(C_h, C_d, size, cudaMemcpyDeviceToHost);",
      "",
      "    cudaFree(A_d);",
      "    cudaFree(B_d);",
      "    cudaFree(C_d);",
      "}",
    ];
    const { b, env } = setup([{ ...code("a"), segments: [{ ...seg("sa", text, { kind: "free" }), lang: "cuda" }] }]);
    segOf(b, "a").hl = [
      [5, 7],
      [9, 10],
      [14, 14],
      [16, 18],
    ];
    segOf(b, "a").hidden = [[19, 19]];
    b.sidenotes.push(
      { id: "n1", at: { card: "a", seg: "sa", lines: [5, 7] }, kind: "text", md: "size" },
      { id: "n2", at: { card: "a", seg: "sa", lines: [9, 10] }, kind: "text", md: "Host -> Device" },
    );
    C.writeFreeCode(env, "a", text.filter((_, i) => i !== 7).join("\n"));
    expect(segOf(b, "a").hl).toEqual([
      [5, 7],
      [8, 9],
      [13, 13],
      [15, 17],
    ]);
    expect(segOf(b, "a").hidden).toEqual([[18, 18]]);
    expect(b.sidenotes.map((n) => n.at.lines)).toEqual([
      [5, 7],
      [8, 9],
    ]);
    // a line added above them moves them all down; lines added inside a Highlight widen it
    C.writeFreeCode(env, "a", ["// vecAdd", ...text.filter((_, i) => i !== 7)].join("\n"));
    expect(segOf(b, "a").hl).toEqual([
      [6, 8],
      [9, 10],
      [14, 14],
      [16, 18],
    ]);
    const now = segOf(b, "a").text;
    C.writeFreeCode(env, "a", [...now.slice(0, 9), "    // B too", ...now.slice(9)].join("\n"));
    expect(segOf(b, "a").hl?.slice(1, 2)).toEqual([[9, 11]]);
    expect(b.sidenotes[1].at.lines).toEqual([9, 11]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("the card frame is off by default on images and on by default on code, and the default is not stored", () => {
    const img: Card = { id: "i", kind: "image", src: "x.png" };
    const { b, env } = setup([code("a"), img]);
    C.toggleBackground(env, "a");
    C.toggleBackground(env, "i");
    expect(b.cards.map((c) => (c.kind === "code" || c.kind === "image" ? c.bg : null))).toEqual([false, true]);
    C.toggleBackground(env, "a");
    C.toggleBackground(env, "i");
    expect(b.cards.map((c) => (c.kind === "code" || c.kind === "image" ? c.bg : null))).toEqual([undefined, undefined]);
  });

  it("an animated image card's frame and always-play are stored only when not the default, each change one step", () => {
    const { b, env, log } = setup([code("a"), { id: "i", kind: "image", src: "x.gif" }]);
    const img = () => b.cards[1] as Extract<Card, { kind: "image" }>;
    C.setImageFrame(env, "i", 4);
    expect([img().frame, log.edits]).toEqual([4, 1]);
    // the same frame again, or a card that is not an image: nothing changes, no step
    C.setImageFrame(env, "i", 4);
    C.setImageFrame(env, "a", 2);
    expect(log.edits).toBe(1);
    expect("frame" in b.cards[0]).toBe(false);
    C.setImageLoop(env, "i", true);
    expect([img().loop, img().frame, log.edits]).toEqual([true, 4, 2]);
    // turning it off stands it on the frame it stopped on, in the same step
    C.setImageLoop(env, "i", false, 7);
    expect([img().loop, img().frame, log.edits]).toEqual([undefined, 7, 3]);
    // the first frame is the default: not written
    C.setImageFrame(env, "i", 1);
    expect(img()).toEqual({ id: "i", kind: "image", src: "x.gif", loop: undefined, frame: undefined });
    expect(JSON.parse(JSON.stringify(img()))).toEqual({ id: "i", kind: "image", src: "x.gif" });
    // another picture: the old frame goes, always-play stays
    C.setImageFrame(env, "i", 3);
    C.setImageLoop(env, "i", true);
    C.replaceImage(env, { card: "i" }, "y.gif");
    expect([img().src, img().frame, img().loop]).toEqual(["y.gif", undefined, true]);
  });

  it("a new annotation replaces the ones it overlaps on its line and takes the segment's last colour", () => {
    const { b, env } = setup([code("a")]);
    segOf(b, "a").annots = [
      { line: 1, from: 0, to: 3, text: "old", color: "orange" },
      { line: 1, from: 5, to: 8, text: "keep" },
      { line: 2, from: 0, to: 3, text: "other", color: "green" },
    ];
    C.addAnnot(env, { card: "a", seg: "sa", line: 1, from: 2, to: 4 }, "  new ");
    expect(segOf(b, "a").annots).toEqual([
      { line: 1, from: 5, to: 8, text: "keep" },
      { line: 2, from: 0, to: 3, text: "other", color: "green" },
      { line: 1, from: 2, to: 4, text: "new", color: "green" },
    ]);
    C.addAnnot(env, { card: "a", seg: "sa", line: 3, from: 0, to: 1 }, "   ");
    expect(segOf(b, "a").annots).toHaveLength(3);
  });

  it("an annotation keeps no default colour or place, and goes when its text is emptied", () => {
    const { b, env } = setup([code("a")]);
    segOf(b, "a").annots = [{ line: 1, from: 0, to: 3, text: "x", color: "orange", below: true }];
    C.editAnnot(env, "a", "sa", 0, { color: "blue" });
    C.editAnnot(env, "a", "sa", 0, { below: false });
    expect(segOf(b, "a").annots).toEqual([{ line: 1, from: 0, to: 3, text: "x" }]);
    C.editAnnot(env, "a", "sa", 0, { text: " " });
    expect(segOf(b, "a").annots).toBeUndefined();
  });
});

describe("new cards and questions with nothing written yet", () => {
  it("a new Note is no undo step until written; written empty it goes as if it never was", () => {
    const { b, env, log } = setup();
    const at = () => ({ x: 0, y: 0 });
    const kept = C.newWriting(env, "note", "", { at, settle: noSettle });
    const gone = C.newWriting(env, "text", "", { at, settle: noSettle });
    expect(log.edits).toBe(0);
    C.writeNote(env, kept, "hello");
    C.writeNote(env, gone, "  ");
    expect(log.edits).toBe(1);
    expect(b.cards).toMatchObject([{ id: kept, md: "hello" }]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("a Box is a step right away, a Text is body-sized and a Mark takes the colour of the last Mark", () => {
    const { b, env, log } = setup();
    const at = () => ({ x: 10.4, y: 20.6 });
    const box = C.newWriting(env, "box", "", { at, settle: noSettle });
    expect(log.edits).toBe(1);
    expect(b.place[box]).toEqual({ x: 10, y: 21, w: expect.any(Number), h: 60 });
    expect(b.cards[0]).toMatchObject({ look: "box", fill: "yellow" });
    const t = C.newWriting(env, "text", "x", { at, settle: noSettle });
    expect(b.cards.find((c) => c.id === t)).toMatchObject({ size: "body" });
    const m1 = C.newWriting(env, "mark", "", { at, settle: noSettle });
    expect(b.cards.find((c) => c.id === m1)).toMatchObject({ hand: "blue" });
    const k = b.cards.find((c) => c.id === m1)!;
    if (k.kind === "note") k.hand = "orange";
    const m2 = C.newWriting(env, "mark", "", { at, settle: noSettle });
    expect(b.cards.find((c) => c.id === m2)).toMatchObject({ hand: "orange" });
  });

  it("a new Free Text is plain text at its look's default size, fresh until written, and goes written empty", () => {
    const { b, env, log } = setup();
    const at = () => ({ x: 0, y: 0 });
    const kept = C.newWriting(env, "freetext", "", { at, settle: noSettle });
    const gone = C.newWriting(env, "freetext", "", { at, settle: noSettle });
    expect(log.edits).toBe(0);
    C.writeNote(env, kept, "Scheduler\n**not bold**");
    C.writeNote(env, gone, " \n ");
    expect(log.edits).toBe(1);
    expect(b.cards).toEqual([{ id: kept, kind: "note", look: "freetext", md: "Scheduler\n**not bold**" }]);
    // its title is its first line as written (no Markdown read out of it)
    expect(cardTitle(b.cards[0], b)).toBe("Scheduler");
    expect(danglingRefs(b)).toEqual([]);
  });

  it("a Mark's weight is one step, regular is not written, and only a Mark takes one", () => {
    const { b, env, log } = setup([
      { id: "m", kind: "note", md: "x", look: "mark", hand: "blue" },
      { id: "t", kind: "note", md: "x", look: "text" },
    ]);
    C.setMarkWeight(env, "m", "bold");
    expect(b.cards[0]).toMatchObject({ weight: "bold" });
    C.setMarkWeight(env, "m", "bold");
    expect(log.edits).toBe(1);
    C.setMarkWeight(env, "m", "light");
    C.setMarkWeight(env, "m", "regular");
    expect(JSON.parse(JSON.stringify(b.cards[0]))).toEqual({
      id: "m",
      kind: "note",
      md: "x",
      look: "mark",
      hand: "blue",
    });
    C.setMarkWeight(env, "t", "bold");
    expect(b.cards[1]).not.toHaveProperty("weight");
    expect(log.edits).toBe(3);
  });

  it("a Mark's size from its toolbar is one step that scales its width with it; S is the default and is not written", () => {
    const { b, env, log } = setup([
      { id: "m", kind: "note", md: "x", look: "mark", hand: "blue" },
      { id: "t", kind: "note", md: "x", look: "freetext", fs: 30 },
    ]);
    const m = () => b.cards[0] as Extract<Card, { kind: "note" }> & { look: "mark" };
    expect(MARK_SIZES).toEqual({ s: TEXT_FS.mark, m: 24, l: 32, xl: 48 });
    expect(markSizeOf(m())).toBe("s");
    C.setMarkSize(env, "m", "s");
    expect(log.edits).toBe(0);
    C.setMarkSize(env, "m", "xl");
    expect(log.edits).toBe(1);
    expect(m().fs).toBe(48);
    expect(markSizeOf(m())).toBe("xl");
    // the width follows as a corner drag's does, so the Mark wraps where it did
    expect(b.place.m.w).toBe(Math.round((400 * 48) / TEXT_FS.mark));
    C.setMarkSize(env, "m", "m");
    expect(m().fs).toBe(24);
    expect(b.place.m.w).toBe(Math.round((1067 * 24) / 48));
    // a size dragged off the steps has none
    m().fs = 27.5;
    expect(markSizeOf(m())).toBeUndefined();
    C.setMarkSize(env, "m", "s");
    expect(JSON.parse(JSON.stringify(m()))).toEqual({ id: "m", kind: "note", md: "x", look: "mark", hand: "blue" });
    // only a Mark takes one
    C.setMarkSize(env, "t", "xl");
    expect(b.cards[1]).toMatchObject({ fs: 30 });
    expect(log.edits).toBe(3);
  });

  it("a Free Text's level is one step back at the level's preset size (width scaled with it); plain is the default and not written", () => {
    const { b, env, log } = setup([
      { id: "t", kind: "note", md: "x", look: "freetext" },
      { id: "m", kind: "note", md: "x", look: "mark", hand: "blue" },
    ]);
    const t = () => b.cards[0] as Extract<Card, { kind: "note" }> & { look: "freetext" };
    expect(FREE_TEXT_FS).toEqual({ 0: 20, 1: TEXT_FS.freetext, 2: 30, 3: 24 });
    expect(textSizeOf(t())).toBe(20);
    C.setFreeTextLevel(env, "t", 0);
    expect(log.edits).toBe(0);
    C.setFreeTextLevel(env, "t", 1);
    expect(log.edits).toBe(1);
    expect(t().level).toBe(1);
    expect(textSizeOf(t())).toBe(40);
    expect(b.place.t.w).toBe(Math.round((400 * 40) / 20));
    // a dragged size goes back to the level's preset, even at the same level
    t().fs = 64;
    C.setFreeTextLevel(env, "t", 1);
    expect(t()).not.toHaveProperty("fs");
    C.setFreeTextLevel(env, "t", 3);
    expect(textSizeOf(t())).toBe(24);
    C.setFreeTextLevel(env, "t", 0);
    expect(JSON.parse(JSON.stringify(t()))).toEqual({ id: "t", kind: "note", md: "x", look: "freetext" });
    // bold: written only when on; only a Free Text takes either
    C.setFreeTextBold(env, "t", false);
    expect(log.edits).toBe(4);
    C.setFreeTextBold(env, "t", true);
    expect(t().bold).toBe(true);
    C.setFreeTextBold(env, "t", false);
    expect(t()).not.toHaveProperty("bold");
    C.setFreeTextLevel(env, "m", 2);
    C.setFreeTextBold(env, "m", true);
    expect(b.cards[1]).not.toHaveProperty("level");
    expect(b.cards[1]).not.toHaveProperty("bold");
    expect(log.edits).toBe(6);
  });

  it("an old board's Free Text (always a heading) opens as H1, its look and size kept; a shared one too", () => {
    const old = {
      ...emptyBoard("b", "old"),
      version: 11,
      cards: [
        { id: "f", kind: "note", md: "Scheduler", look: "freetext" },
        { id: "g", kind: "note", md: "Big", look: "freetext", fs: 64 },
        { id: "m", kind: "note", md: "x", look: "mark", hand: "blue" },
      ],
      place: { f: { x: 0, y: 0, w: 200 }, g: { x: 0, y: 100, w: 200 }, m: { x: 0, y: 200, w: 200 } },
    };
    const b = migrateBoard(old);
    expect(b.cards.map((c) => (c.kind === "note" ? [c.level, c.fs] : []))).toEqual([
      [1, undefined],
      [1, 64],
      [undefined, undefined],
    ]);
    expect(textSizeOf(b.cards[0] as Extract<Card, { kind: "note" }> & { look: "freetext" })).toBe(TEXT_FS.freetext);
    const sc = migrateSharedCard({
      version: 11,
      card: { id: "f", kind: "note", md: "x", look: "freetext" },
      sidenotes: [],
    });
    expect(sc.card).toMatchObject({ level: 1 });
  });

  it("dragging a Mark's or Free Text's corner scales its text size and width together, within the limits", () => {
    expect(scaleText(18, 200, 2)).toEqual({ fs: 36, w: 400 });
    expect(scaleText(18, 200, 1.31)).toEqual({ fs: 23.5, w: 261 });
    // past a limit the size stops, and the width stops with it
    expect(scaleText(18, 200, 0.1)).toEqual({ fs: TEXT_FS.min, w: Math.round((200 * TEXT_FS.min) / 18) });
    expect(scaleText(40, 300, 100)).toEqual({ fs: TEXT_FS.max, w: Math.round((300 * TEXT_FS.max) / 40) });
    const mark = { id: "m", kind: "note", md: "x", look: "mark" } as const,
      ft = { id: "f", kind: "note", md: "x", look: "freetext" } as const;
    // a Free Text with no size of its own is at its level's (plain: 20px, H1: 40px)
    expect([textSizeOf(mark), textSizeOf(ft), textSizeOf({ ...ft, level: 1 }), textSizeOf({ ...ft, fs: 72 })]).toEqual([
      18, 20, 40, 72,
    ]);
    expect([scalesText(mark), scalesText(ft), scalesText({ ...mark, look: "text" })]).toEqual([true, true, false]);
  });

  it("a Note written empty goes, in the same step, while an empty Box stays", () => {
    const { b, env } = setup([note("n", "x"), { id: "x", kind: "note", md: "x", look: "box" }]);
    C.writeNote(env, "n", "");
    C.writeNote(env, "x", "");
    expect(b.cards.map((c) => c.id)).toEqual(["x"]);
  });

  it("a new card or question closed without writing goes when still empty, and stays when it has content after all", () => {
    const { b, env, log } = setup();
    const empty = C.newWriting(env, "note", "", { at: () => ({ x: 0, y: 0 }), settle: noSettle });
    const filled = C.newWriting(env, "note", "", { at: () => ({ x: 0, y: 0 }), settle: noSettle });
    const n = b.cards.find((c) => c.id === filled)!;
    if (n.kind === "note") n.md = "pasted";
    const q = C.newQuestion(env, { pack: "builtin", name: "question" }, { kind: "canvas", x: 0, y: 0, size: 32 });
    for (const id of [empty, filled, q]) C.settleUnwritten(env, id);
    expect(b.cards.map((c) => c.id)).toEqual([filled]);
    expect(b.stickers).toEqual([]);
    expect(log.edits).toBe(1);
    // settled already: nothing more happens
    C.settleUnwritten(env, filled);
    expect(log.edits).toBe(1);
  });

  it("a new blank Free code card goes when written empty and is one step when written", () => {
    const { b, env, log } = setup();
    C.newBlankCode(env, "c", seg("s", [""], { kind: "free" }), { x: 0, y: 0, w: 480 }, noSettle);
    C.newBlankCode(env, "d", seg("t", [""], { kind: "free" }), { x: 0, y: 0, w: 480 }, noSettle);
    expect(C.writeFreeCode(env, "c", " \n")).toBeUndefined();
    expect(C.writeFreeCode(env, "d", "x = 1")?.text).toEqual(["x = 1"]);
    expect(b.cards.map((c) => c.id)).toEqual(["d"]);
    expect(log.edits).toBe(1);
  });

  it("a question written empty is never asked; a written one is trimmed", () => {
    const { b, env } = setup();
    const at = { kind: "canvas", x: 0, y: 0, size: 32 } as const;
    const icon = { pack: "builtin", name: "question" };
    const a = C.newQuestion(env, icon, at);
    const q = C.newQuestion(env, icon, at);
    C.writeQuestion(env, a, " ");
    C.writeQuestion(env, q, " Why? ");
    expect(b.stickers).toMatchObject([{ id: q, q: { md: "Why?" } }]);
  });
});

describe("stickers and questions", () => {
  it("a sticker keeps no colour that is its icon's own", () => {
    const { b, env } = setup();
    const at = { kind: "canvas", x: 0, y: 0, size: 32 } as const;
    const s = C.addSticker(env, { pack: "builtin", name: "star" }, at, { pick: "gold", def: "gold" });
    expect(s.q).toBe(false);
    expect(b.stickers[0].color).toBeUndefined();
    C.setStickerColor(env, s.id, "orange", "gold");
    expect(b.stickers[0].color).toBe("orange");
    C.setStickerColor(env, s.id, "gold", "gold");
    expect(b.stickers[0].color).toBeUndefined();
  });

  it("reopening a question drops its linked answer", () => {
    const { b, env } = setup([note("n", "because")]);
    const s = C.addSticker(
      env,
      { pack: "builtin", name: "question" },
      { kind: "line", card: "n", seg: "", line: 1 },
      {},
    );
    expect(s.q).toBe(true);
    C.linkAnswer(env, s.id, "n");
    expect(b.stickers[0].q).toMatchObject({ done: true, answer: "n" });
    C.setAnswered(env, s.id, false);
    expect(b.stickers[0].q).toEqual({ md: "", at: expect.any(Number) });
  });
});

describe("arrow rules", () => {
  it("draws no arrow from a place of a card to itself, and gives a block end its own copy", () => {
    const { b, env } = setup([code("a"), note("n", "# x")]);
    expect(C.addLink(env, { card: "a" }, { card: "a" })).toBeNull();
    const block = { i: 0, h: "x" };
    const id = C.addLink(env, { card: "a", seg: "sa", line: 1 }, { card: "n", block }, "right");
    expect(b.links).toMatchObject([{ id, sides: { from: "right" }, to: { block: { i: 0 } } }]);
    expect(b.links[0].to.block).not.toBe(block);
  });

  it("keeps no default look on an arrow", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.links.push({ id: "l", from: { card: "a" }, to: { card: "b" } });
    C.setLinkStyle(env, "l", (s) => {
      s.width = 3;
      s.head = { start: true };
    });
    expect(b.links[0].style).toEqual({ width: 3, head: { start: true } });
    C.setLinkStyle(env, "l", (s) => {
      s.width = 2;
      s.head = { start: false, end: true };
    });
    expect(b.links[0].style).toBeUndefined();
  });

  it("an arrow's sides back on auto leave no sides", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.links.push({ id: "l", from: { card: "a" }, to: { card: "b" } });
    C.setLinkSides(env, "l", "left", "top");
    expect(b.links[0].sides).toEqual({ from: "left", to: "top" });
    C.setLinkSides(env, "l", undefined, "auto");
    expect(b.links[0].sides).toEqual({ from: "left" });
    C.setLinkSides(env, "l", "auto", "auto");
    expect(b.links[0].sides).toBeUndefined();
  });

  it("the last argument chip turned off leaves no list", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.links.push({ id: "l", from: { card: "a", seg: "sa", line: 1 }, to: { card: "b" }, call: { name: "f", col: 0 } });
    const v = { a: "x", b: "y" };
    C.toggleCallVar(env, "l", v);
    expect(b.links[0].call?.vars).toEqual([v]);
    C.toggleCallVar(env, "l", { ...v });
    expect(b.links[0].call?.vars).toBeUndefined();
  });

  it("an RPC mark starts as shared memory and keeps no empty fields", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.links.push({ id: "l", from: { card: "a" }, to: { card: "b" } });
    C.markRpc(env, "l");
    expect(b.links[0].rpc).toEqual({ mech: "shm" });
    C.editRpc(env, "l", (r) => {
      r.msg = "";
      r.custom = "zmq";
    });
    expect(b.links[0].rpc).toEqual({ mech: "shm", custom: "zmq" });
  });

  it("a manual call to the calling card itself is refused", () => {
    const { b, env } = setup([code("a"), code("b")]);
    const call = { line: 1, col: 0, end: 0, name: "f", loop: false };
    expect(C.manualCall(env, { card: "a", seg: "sa", line: 1, call }, "a")).toEqual({
      why: "A card cannot call itself.",
    });
    expect(C.manualCall(env, { card: "a", seg: "sa", line: 1, call }, "b")).toHaveProperty("id");
    expect(b.links[0].call?.ev).toEqual({ kind: "manual" });
  });
});

describe("call rules", () => {
  it("a late dispatch adds only the implementations the arrow doesn't list yet", () => {
    const { b, env } = setup([code("a"), code("b")]);
    const impl = (qual: string, base?: true) => ({
      label: qual,
      detail: "",
      path: "m.py",
      line: 1,
      qual,
      ...(base ? { base } : {}),
    });
    b.links.push({
      id: "l",
      from: { card: "a", seg: "sa", line: 1 },
      to: { card: "b" },
      call: { name: "f", col: 0, alts: [{ label: "A.f", qual: "A.f" }] },
    });
    C.addCallAlts(env, "l", [impl("Base.f", true), impl("A.f"), impl("B.f")]);
    expect(b.links[0].call).toMatchObject({ impls: 3, alts: [{ qual: "A.f" }, { qual: "B.f" }] });
  });

  it("a template instance's title follows its values only while it is still the title made for them", () => {
    const k = code("k");
    k.segments[0].symbol = { qual: "ops::gemm", kind: "function" };
    k.title = "gemm<64>";
    const { b, env } = setup([code("a"), k]);
    b.links.push({
      id: "l",
      from: { card: "a", seg: "sa", line: 1 },
      to: { card: "k" },
      call: {
        name: "gemm",
        col: 0,
        vals: [{ name: "N", value: "64", opts: ["64", "128"] }],
        alts: [{ label: "fp8", vals: [{ name: "N", value: "32" }] }],
      },
    });
    C.setCallValue(env, "l", 0, "128");
    expect(b.cards[1].title).toBe("gemm<128>");
    C.swapValues(env, "l", [{ name: "N", value: "32" }], 0);
    expect(b.cards[1].title).toBe("gemm<32>");
    expect(b.links[0].call?.alts).toEqual([
      { label: "config · N=128", vals: [{ name: "N", value: "128", opts: ["64", "128"] }] },
    ]);
    b.cards[1].title = "My kernel";
    C.setCallValue(env, "l", 0, "64");
    expect(b.cards[1].title).toBe("My kernel");
  });

  it("a legend name set back to its default, and a call graph mark set back to auto, are not stored", () => {
    const { b, env } = setup();
    C.renameLegend(env, "rpc", "IPC");
    expect(b.legend).toEqual({ rpc: "IPC" });
    C.renameLegend(env, "rpc", "");
    expect(b.legend).toBeUndefined();
    C.setGraphMark(env, "g", { letter: "Q" });
    expect(b.marks).toEqual({ g: { letter: "Q" } });
    C.setGraphMark(env, "g", null);
    expect(b.marks).toBeUndefined();
  });

  it("the last process tag removed leaves no list, and a column's start mark goes on its Compare", () => {
    const { b, env } = setup([code("a"), code("b")]);
    C.addProcTag(env, "a", "rank 0");
    C.addProcTag(env, "a", "stream 1", true);
    expect(b.cards[0].procs).toEqual([{ text: "rank 0" }, { text: "stream 1", light: true }]);
    C.removeProcTag(env, "a", 0);
    C.removeProcTag(env, "a", 0);
    expect(b.cards[0].procs).toBeUndefined();
    const k = C.compare(env, ["a", "b"])!;
    C.toggleStart(env, "a");
    expect(b.place[k].start).toBe(true);
  });

  it("a Generated card goes in the Section of the card it came from, with an arrow back to the line", () => {
    const { b, env } = setup([code("a")]);
    b.sections.push({ id: "g", title: "S", x: 0, y: 0, w: 900, h: 900 });
    b.place.a.section = "g";
    const card = code("gen");
    C.addGenerated(env, card, { card: "a", seg: "sa", line: 2 }, { x: 40, y: 300, w: 520 });
    expect(b.place.gen).toEqual({ x: 40, y: 300, w: 520, section: "g" });
    expect(b.links).toMatchObject([{ from: { card: "gen" }, to: { card: "a", seg: "sa", line: 2 }, gen: true }]);
    expect(danglingRefs(b)).toEqual([]);
  });
});

describe("Sections and places", () => {
  it("Tidy Up moves a Section with its inner Sections and every card in them, and loose cards to their place, in one step", () => {
    const { b, env, log } = setup([code("a"), code("b"), code("c")]);
    b.sections.push(
      { id: "s", title: "", x: 0, y: 0, w: 900, h: 500 },
      { id: "in", title: "", x: 10, y: 10, w: 300, h: 300, parent: "s" },
      { id: "other", title: "", x: 2000, y: 0, w: 100, h: 100 },
    );
    b.place.a.section = "s";
    b.place.b.section = "in";
    expect(C.tidyMove(env, { c: { x: 7, y: 8 } }, { s: { dx: 100, dy: -50 } })).toBe(true);
    expect(log.edits).toBe(1);
    expect(b.sections.map((q) => [q.x, q.y])).toEqual([
      [100, -50],
      [110, -40],
      [2000, 0],
    ]);
    expect([b.place.a.x, b.place.a.y, b.place.b.x, b.place.b.y]).toEqual([100, -50, 600, -50]);
    expect([b.place.c.x, b.place.c.y]).toEqual([7, 8]);
  });

  it("Fit Content leaves folded and locked Sections, a Section in a locked one too", () => {
    const { b, env } = setup();
    const frame = { x: 0, y: 0, w: 100, h: 100 };
    b.sections.push(
      { id: "open", title: "", ...frame },
      { id: "shut", title: "", ...frame, collapsed: true },
      { id: "lock", title: "", ...frame, locked: true },
      { id: "inner", title: "", ...frame, parent: "lock" },
    );
    let before: string[] = [];
    const fit = { x: 5, y: 5, w: 50, h: 50 };
    expect(
      C.fitSections(
        env,
        ["open", "shut", "lock", "inner"],
        () => fit,
        (ids) => (before = ids),
      ),
    ).toBe(true);
    expect(before).toEqual(["open"]);
    expect(b.sections.map((s) => s.w)).toEqual([50, 100, 100, 100]);
    expect(C.fitSections(env, ["shut"], () => fit)).toBe(false);
  });

  it("folding a Section keeps its open frame, and does nothing once it was folded meanwhile", () => {
    const { b, env } = setup();
    b.sections.push({ id: "s", title: "", x: 0, y: 0, w: 100, h: 100 });
    C.setSectionFolded(env, "s", true, { was: false, open: { x: 1.4, y: 2.6, w: 300.2, h: 200 } });
    expect(b.sections[0]).toMatchObject({ x: 1, y: 3, w: 300, h: 200, collapsed: true });
    C.setSectionFolded(env, "s", true, { was: false, open: { x: 9, y: 9, w: 9, h: 9 } });
    expect(b.sections[0].x).toBe(1);
    C.setSectionFolded(env, "s", false, { was: true, open: { x: 9, y: 9, w: 9, h: 9 } });
    expect(b.sections[0]).toMatchObject({ x: 1, w: 300, collapsed: undefined });
  });

  it("revealing a card unfolds its folded callers and every folded Section around it", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.sections.push(
      { id: "out", title: "", x: 0, y: 0, w: 9, h: 9, collapsed: true },
      { id: "in", title: "", x: 0, y: 0, w: 9, h: 9, parent: "out", collapsed: true },
    );
    b.place.b.section = "in";
    b.place.a.collapsed = true;
    C.unfoldTo(env, "b", ["a"]);
    expect(b.place.a.collapsed).toBeUndefined();
    expect(b.sections.map((s) => s.collapsed)).toEqual([undefined, undefined]);
  });

  it("aligning moves only the cards that aren't locked, nor in a locked Section", () => {
    const { b, env } = setup([code("a"), code("b"), code("c")]);
    b.place.b.locked = true;
    b.sections.push({ id: "g", title: "", x: 0, y: 0, w: 9, h: 9, locked: true });
    b.place.c.section = "g";
    b.place.a.y = 100;
    C.alignCards(
      env,
      ["a", "b", "c"].map((id, i) => ({ id, x: 500 * i, y: b.place[id].y, w: 400, h: 50 })),
      "top",
    );
    expect(["a", "b", "c"].map((id) => b.place[id].y)).toEqual([0, 0, 0]);
    b.place.a.y = 100;
    b.place.b.y = 50;
    C.alignCards(
      env,
      ["a", "b"].map((id, i) => ({ id, x: 500 * i, y: b.place[id].y, w: 400, h: 50 })),
      "top",
    );
    expect([b.place.a.y, b.place.b.y]).toEqual([50, 50]);
  });

  it("Fit Content of cards stores a height only for code taller than the limit, and keeps widths in range", () => {
    const { b, env } = setup([code("a"), code("b"), note("n", "x")]);
    for (const id of ["a", "b", "n"]) b.place[id].h = 999;
    C.fitCardSizes(
      env,
      new Map([
        ["a", { w: 100, h: 300, body: 260, chrome: 40 }],
        ["b", { w: 5000, h: 900, body: 860, chrome: 40 }],
        ["n", { h: 120, chrome: 0 }],
      ]),
      460,
    );
    expect(["a", "b", "n"].map((id) => [b.place[id].w, b.place[id].h])).toEqual([
      [240, undefined],
      [1600, 860],
      [400, undefined],
    ]);
  });

  it("Fit Content of a Text keeps its width between 80 and 720 and its height following the text", () => {
    const { b, env } = setup([note("s", "x"), note("l", "x")]);
    for (const id of ["s", "l"]) Object.assign(b.cards.find((c) => c.id === id)!, { look: "text" });
    C.fitCardSizes(
      env,
      new Map([
        ["s", { w: 30, h: 20, chrome: 0 }],
        ["l", { w: 3000, h: 20, chrome: 0 }],
      ]),
      460,
    );
    expect(["s", "l"].map((id) => [b.place[id].w, b.place[id].h])).toEqual([
      [80, undefined],
      [720, undefined],
    ]);
  });

  it("Move to Section moves the cards together into it", () => {
    const { b, env } = setup([code("a"), code("b")]);
    b.sections.push({ id: "g", title: "", x: 0, y: 0, w: 9, h: 9 });
    C.moveIntoSection(env, ["a", "b"], "g", 10, -5);
    expect([b.place.a, b.place.b]).toMatchObject([
      { x: 10, y: -5, section: "g" },
      { x: 510, y: -5, section: "g" },
    ]);
  });
});

describe("Link List rows and boards", () => {
  it("a row's own look, and its own title, are kept only when they differ from the list's and the page's", () => {
    const list: Card = {
      id: "L",
      kind: "links",
      rich: true,
      items: [
        { id: "a", url: "https://a", meta: { title: "Page A" } },
        { id: "b", url: "https://b" },
        { id: "c", url: "https://c" },
      ],
    };
    const { b, env } = setup([list]);
    const items = () => (b.cards[0].kind === "links" ? b.cards[0].items : []);
    C.toggleItemRich(env, "L", "a");
    expect(items()[0].rich).toBe(false);
    C.toggleItemRich(env, "L", "a");
    expect(items()[0].rich).toBeUndefined();
    C.renameLinkItem(env, "L", "a", " Mine ");
    expect(items()[0].title).toBe("Mine");
    C.renameLinkItem(env, "L", "a", "Page A");
    expect(items()[0].title).toBeUndefined();
    C.moveLinkItem(env, "L", "a", 3);
    expect(items().map((x) => x.id)).toEqual(["b", "c", "a"]);
    C.moveLinkItem(env, "L", "a", 0);
    expect(items().map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("a board can't be inserted into itself or into a board inside it", () => {
    const { b, env } = setup();
    const subs = (id: string) => ({ child: ["grand"] })[id];
    const o = { subs, settle: noSettle };
    expect(C.insertBoard(env, "b", { x: 0, y: 0 }, o)).toBe("cycle");
    b.id = "grand";
    expect(C.insertBoard(env, "child", { x: 0, y: 0 }, o)).toBe("cycle");
    b.id = "b";
    const id = C.insertBoard(env, "child", { x: 1.6, y: 2 }, o);
    expect(b.place[id!]).toEqual({ x: 2, y: 2, w: 560, h: 360 });
  });
});
