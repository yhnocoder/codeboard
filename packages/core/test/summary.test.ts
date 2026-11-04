// Zoomed-out summaries (core summary.ts): the board's font size, cut and minimum zoom, the columns (anchored at the source's
// top-left, growing only right and down, aligned sources aligned, obstacles in reading order), the AI's length budget, what makes a
// summary pending, and reading the AI's answer
import { describe, expect, it } from "vitest";
import {
  SUMMARY,
  emptyBoard,
  layoutSummaries,
  readSummaryReply,
  summaryBudget,
  summaryCut,
  summaryFont,
  summaryMinZoom,
  summaryPending,
  summaryRequest,
  summarySig,
  summaryInput,
  keepsLook,
  summarySources,
  putSummary,
  cardKey,
  secKey,
  type Board,
  type NoteCard,
  type Rect,
  type SumInput,
  type SumSource,
  summaryOf,
  summaryExamples,
} from "../src";
import { editSummary, type CommandEnv } from "../src/commands";

const sec = (key: string, box: Rect, title = key): SumSource => ({
  key: secKey(key),
  box,
  own: { x: box.x, y: box.y - 30, w: box.w, h: box.h + 30 },
  title,
});
const col = (l: ReturnType<typeof layoutSummaries>, key: string) => l.cols.find((c) => c.key === key)!;

describe("summary font size and zoom", () => {
  it("grows with the log of the median column width, 56 at 400 and 80 at 1600, within 52–118", () => {
    expect(summaryFont(400)).toBe(56);
    expect(summaryFont(1600)).toBe(80);
    expect(summaryFont(800)).toBe(68);
    expect(summaryFont(50)).toBe(52);
    expect(summaryFont(1e6)).toBe(118);
  });
  it("switches to summaries at min(30 %, 32 / S)", () => {
    expect(summaryCut(56)).toBe(0.3);
    expect(summaryCut(118)).toBeCloseTo(32 / 118);
  });
  it("lets the board zoom out to fit-all ÷ 1.3, within sane bounds; an empty board keeps 10 %", () => {
    const view = { w: 1000, h: 800 };
    const fit = Math.min(1000 / 10000, 800 / 4000) * 0.96;
    expect(summaryMinZoom(view, { x: 0, y: 0, w: 10000, h: 4000 })).toBeCloseTo(fit / 1.3);
    expect(summaryMinZoom(view, null)).toBe(0.1);
    expect(summaryMinZoom(view, { x: 0, y: 0, w: 1e7, h: 1e7 })).toBe(SUMMARY.zoomFloor);
    expect(summaryMinZoom(view, { x: 0, y: 0, w: 100, h: 100 })).toBe(SUMMARY.zoomCeil);
  });
});

describe("summary columns", () => {
  it("anchors each column at its source's top-left and widens it only to the right, stopping before an obstacle", () => {
    const input: SumInput = {
      items: [sec("a", { x: 0, y: 0, w: 300, h: 600 })],
      keep: [{ x: 700, y: 100, w: 200, h: 200 }],
    };
    const l = layoutSummaries(input);
    const a = col(l, "sec:a");
    expect([a.x, a.y]).toEqual([0, 0]);
    expect(a.w).toBe(700 - SUMMARY.gap);
    // nothing in the way: up to 12 characters a line
    const f = layoutSummaries({ items: [sec("a", { x: 0, y: 0, w: 300, h: 600 })], keep: [] });
    expect(col(f, "sec:a").w).toBe(12 * f.S + 2 * f.P);
  });
  it("never moves or narrows a column that cannot grow", () => {
    const l = layoutSummaries({
      items: [sec("a", { x: 100, y: 50, w: 900, h: 400 }), sec("b", { x: 1010, y: 50, w: 900, h: 400 })],
      keep: [],
    });
    const a = col(l, "sec:a");
    expect([a.x, a.y, a.w]).toEqual([100, 50, 900]);
  });
  it("gives aligned sources one anchor and, at the same width, one column width", () => {
    const l = layoutSummaries({
      items: [
        sec("a", { x: 0, y: 0, w: 400, h: 300 }),
        sec("b", { x: 3, y: 600, w: 401, h: 300 }),
        { ...sec("c", { x: 700, y: 600, w: 400, h: 300 }) },
      ],
      keep: [],
    });
    const a = col(l, "sec:a"),
      b = col(l, "sec:b");
    expect(b.x).toBe(0); // the group's smallest left edge
    expect(a.w).toBe(b.w);
    expect(b.w).toBeLessThanOrEqual(700 - SUMMARY.gap); // b stops before c, so a takes b's width
  });
  it("starts the bodies of a row on one line: the row's tallest title block", () => {
    const l = layoutSummaries({
      items: [
        sec("a", { x: 0, y: 0, w: 400, h: 300 }, "短"),
        sec("b", { x: 1000, y: 2, w: 400, h: 300 }, "一个很长很长很长很长很长很长很长很长很长很长很长很长的标题"),
      ],
      keep: [],
    });
    expect(col(l, "sec:a").hd).toBe(col(l, "sec:b").hd);
    expect(col(l, "sec:a").hd).toBeGreaterThan(Math.ceil(l.S * 0.8 * 1.3));
  });
  it("grows a column down into free space only, stopping before the next column below it in reading order", () => {
    const measured = new Map([["sec:a", { hd: 60, tx: 5000 }]]);
    const l = layoutSummaries(
      { items: [sec("a", { x: 0, y: 0, w: 900, h: 300 }), sec("b", { x: 0, y: 1200, w: 900, h: 300 })], keep: [] },
      measured,
    );
    const a = col(l, "sec:a");
    expect(a.h).toBe(1200 - SUMMARY.gap);
    expect(a.lines).toBe(Math.floor((a.h - 2 * l.P - 60 - 0.3 * l.S) / (1.5 * l.S) + 1e-6));
  });
  it("puts a loose image card's summary below the image and keeps the image as an obstacle", () => {
    const b: Board = emptyBoard("b", "t");
    b.cards.push({ id: "i", kind: "image", src: "x.png", alt: "图" });
    b.place.i = { x: 10, y: 20, w: 300 };
    const rect = { x: 10, y: 20, w: 300, h: 200 };
    const input = summarySources(b, () => rect, new Map());
    expect(input.items[0].box).toEqual({ x: 10, y: 20 + 200 + SUMMARY.gap, w: 300, h: 0 });
    expect(input.items[0].image).toEqual(rect);
    expect(input.keep).toContainEqual(rect);
  });
});

/** A board: Section s (top level, nested t inside) with two Notes, a loose Note, a Mark, a Free Text and a sub-board frame */
function board(): Board {
  const b = emptyBoard("b", "t");
  const note = (id: string, md: string, look: NoteCard["look"] = "note"): NoteCard => ({ id, kind: "note", md, look });
  b.cards.push(note("n1", "# 吞吐\n多核路线保住串行速度"), note("n2", "# 延迟\nGPU 用大量小算术单元"));
  b.cards.push(note("n3", "# 松散的卡\n一句话"), note("m", "看这里", "mark"));
  b.cards.push({ id: "f", kind: "board", board: "sub" }, note("ft", "随手写的一行", "freetext"));
  b.sections.push({ id: "s", title: "异构并行", x: 0, y: 0, w: 900, h: 500 });
  b.sections.push({ id: "t", title: "子", x: 20, y: 20, w: 300, h: 300, parent: "s" });
  b.place = {
    n1: { x: 40, y: 60, w: 300, section: "s" },
    n2: { x: 400, y: 60, w: 300, section: "t" },
    n3: { x: 1200, y: 0, w: 400 },
    m: { x: 1200, y: 600, w: 200 },
    f: { x: 0, y: 900, w: 500 },
    ft: { x: 1200, y: 900, w: 300 },
  };
  return b;
}
const rects = (b: Board) => (id: string) => {
  const p = b.place[id];
  return p && { x: p.x, y: p.y, w: p.w, h: 200 };
};

describe("what a board summarizes", () => {
  it("summarizes top-level Sections and loose cards, not nested Sections, sub-board frames, Marks or Free Text", () => {
    const b = board();
    const frames = new Map(b.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    const input = summarySources(b, rects(b), frames);
    expect(input.items.map((i) => i.key).sort()).toEqual(["card:n3", "sec:s"]);
    // the frame and the Free Text stay on the summary level as they are (obstacles); a Mark hides with the cards
    const r = rects(b);
    expect(input.keep).toEqual([r("f"), r("ft")]);
    expect(keepsLook(b.cards.find((c) => c.id === "m")!)).toBe(false);
  });
  it("makes a Section pending when its card count or a card title changes, not when a card's body changes", () => {
    const b = board();
    const sig = summarySig(b, "sec:s")!;
    putSummary(b, "sec:s", { text: "x", at: 1, sig });
    expect(summaryPending(b, "sec:s")).toBe(false);
    (b.cards[0] as NoteCard).md += "\n更多正文";
    expect(summaryPending(b, "sec:s")).toBe(false);
    (b.cards[1] as NoteCard).md = "# 带宽\nGPU";
    expect(summaryPending(b, "sec:s")).toBe(true);
    putSummary(b, "sec:s", { text: "x", at: 1, sig: summarySig(b, "sec:s")! });
    b.place.n3.section = "s";
    expect(summaryPending(b, "sec:s")).toBe(true);
    expect(summarySig(b, cardKey("n3"))).toBeDefined();
  });
});

describe("the AI's length budget and prompt", () => {
  it("asks for about 0.6 of the column's capacity, never under two full lines; Sections 2–4 sentences, cards one", () => {
    expect(summaryBudget({ cpl: 10, lines: 8 }, false)).toEqual({
      cpl: 10,
      lines: 8,
      capacity: 80,
      target: 48,
      sentences: [2, 2],
    });
    expect(summaryBudget({ cpl: 12, lines: 1 }, false).target).toBe(24); // two full lines
    expect(summaryBudget({ cpl: 12, lines: 40 }, false).sentences).toEqual([3, 4]);
    expect(summaryBudget({ cpl: 12, lines: 6 }, true).sentences).toEqual([1, 1]);
  });
  it("builds a Chinese request for a Chinese board, from the Section's cards and nested Sections", () => {
    const b = board();
    const frames = new Map(b.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    const l = layoutSummaries(summarySources(b, rects(b), frames));
    const r = summaryRequest(b, secKey("s"), l)!;
    expect(r.lang).toBe("zh");
    expect(r.cards.map((c) => c.title)).toEqual(["吞吐", "延迟"]);
    expect(r.card).toBeUndefined();
    expect(r.cards[0].text).toContain("多核路线保住串行速度");
    const loose = summaryRequest(b, cardKey("n3"), l)!;
    expect(loose.card).toBe("note");
  });
  it("hashes an item's inputs: card ids, titles and contents, and a Section's title; positions do not count", () => {
    const b = board();
    const k = secKey(b.sections[0].id);
    const h0 = summaryInput(b, k);
    const md = (b.cards[0] as NoteCard).md;
    (b.cards[0] as NoteCard).md = `${md}多一句`;
    const h1 = summaryInput(b, k);
    (b.cards[0] as NoteCard).md = md;
    b.place[b.cards[0].id].x += 50;
    expect(summaryInput(b, k)).toBe(h0);
    b.sections[0].title += "!";
    expect(new Set([h0, h1, summaryInput(b, k)]).size).toBe(3);
  });
  it("reads the JSON answer, keeps one bold key phrase and a card's title", () => {
    const b = board();
    const frames = new Map(b.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    const r = summaryRequest(b, cardKey("n3"), layoutSummaries(summarySources(b, rects(b), frames)))!;
    const s = readSummaryReply('```json\n{"text": "**吞吐**优先，**延迟**其次。", "title": "导读"}\n```', r, 5)!;
    expect(s).toEqual({ text: "**吞吐**优先，延迟其次。", title: "导读", at: 5, sig: r.sig, input: r.input });
    expect(r.input).toBe(summaryInput(b, cardKey("n3")));
    expect(readSummaryReply("纯文字的回答", r, 5)?.text).toBe("纯文字的回答");
    expect(readSummaryReply("  ", r, 5)).toBeUndefined();
  });
});

describe("the user's edits of a summary", () => {
  const env = (b: Board): CommandEnv =>
    ({
      board: () => b,
      edit: (fn: (x: Board) => void) => (fn(b), true),
      ask: (async () => ({
        summary: { text: "AI 第二版：**新的**结论。", at: 9, sig: "x" },
      })) as unknown as CommandEnv["ask"],
    }) as unknown as CommandEnv;
  it("pairs each round's edit with the AI text it replaced, newest first, updating the newest pair until the next rewrite", async () => {
    const b = board();
    putSummary(b, "sec:s", { text: "AI 第一版", at: 1, sig: summarySig(b, "sec:s")! });
    const e = env(b);
    // round 1: two edits with no rewrite in between make one pair
    editSummary(e, "sec:s", "我的第一版");
    editSummary(e, "sec:s", "我的第一版，改短");
    expect(summaryOf(b, "sec:s")!.pairs!.map((p) => [p.ai, p.user])).toEqual([["AI 第一版", "我的第一版，改短"]]);
    expect(summaryOf(b, "sec:s")!.edited).toBe(true);
    // the cards change; the rewrite is asked with the pairs, and keeps them
    (b.cards[1] as NoteCard).md = "# 带宽\nGPU";
    const frames = new Map(b.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    const req = summaryRequest(b, secKey("s"), layoutSummaries(summarySources(b, rects(b), frames)))!;
    expect(req.pairs?.[0].user).toBe("我的第一版，改短");
    putSummary(b, "sec:s", readSummaryReply("AI 第二版：**新的**结论。", req, 9)!);
    expect(summaryOf(b, "sec:s")!.edited).toBeUndefined();
    // round 2: the new edit pairs with the AI text showing now
    editSummary(e, "sec:s", "我的第二版");
    expect(summaryOf(b, "sec:s")!.pairs!.map((p) => [p.ai, p.user])).toEqual([
      ["AI 第二版：**新的**结论。", "我的第二版"],
      ["AI 第一版", "我的第一版，改短"],
    ]);
    // at most three
    for (let i = 3; i <= 5; i++) {
      putSummary(b, "sec:s", { ...summaryOf(b, "sec:s")!, text: `AI 第 ${i} 版`, edited: undefined });
      editSummary(e, "sec:s", `我的第 ${i} 版`);
    }
    expect(summaryOf(b, "sec:s")!.pairs!.map((p) => p.user)).toEqual(["我的第 5 版", "我的第 4 版", "我的第 3 版"]);
    // the examples use each Section's newest edit, most recent first, not the one being written
    const other = board();
    other.id = "b2";
    other.sections[0].summary = { text: "x", at: 1, sig: "", pairs: [{ ai: "a", user: "别处的改法", at: 1e15 }] };
    const ex = summaryExamples([b, other], 4);
    expect(ex.map((x) => x.summary)).toEqual(["别处的改法", "我的第 5 版"]);
    expect(ex[0].title).toBe("异构并行");
    expect(ex[0].content).toContain("吞吐");
    expect(summaryExamples([b], 4, { board: "b", key: "sec:s" })).toEqual([]);
  });
});
