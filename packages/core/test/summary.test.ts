// Zoomed-out summaries (core summary.ts): the board's font size, cut and minimum zoom, the columns (anchored at the source's
// top-left, growing only right and down, aligned sources aligned, obstacles in reading order), the AI's prompt, what makes a
// summary pending, and reading the AI's answer
import { describe, expect, it } from "vitest";
import {
  SUMMARY,
  emptyBoard,
  layoutSummaries,
  readSummaryReply,
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
  untitled,
  sectionPlan,
  sectionFrames,
  summaryKeys,
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
    expect(a.full).toBe(Math.ceil(2 * l.P + 60 + 0.3 * l.S + 5000));
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

/** A board: Section s (top level, a collapsed Section t inside: s is still innermost, with t's cards) with two Notes, a loose
 *  Note, a Mark, a Free Text and a sub-board frame */
function board(): Board {
  const b = emptyBoard("b", "t");
  const note = (id: string, md: string, look: NoteCard["look"] = "note"): NoteCard => ({ id, kind: "note", md, look });
  b.cards.push(note("n1", "# 吞吐\n多核路线保住串行速度"), note("n2", "# 延迟\nGPU 用大量小算术单元"));
  b.cards.push(note("n3", "# 松散的卡\n一句话"), note("m", "看这里", "mark"));
  b.cards.push({ id: "f", kind: "board", board: "sub" }, note("ft", "随手写的一行", "freetext"));
  b.sections.push({ id: "s", title: "异构并行", x: 0, y: 0, w: 900, h: 500 });
  b.sections.push({ id: "t", title: "子", x: 20, y: 20, w: 300, h: 300, parent: "s", collapsed: true });
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
  it("summarizes innermost open Sections and loose cards, not collapsed Sections, sub-board frames, Marks or Free Text", () => {
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

describe("a card with no title of its own", () => {
  it("is a Note with no heading or an image with no alt; it shows no title until the AI wrote one, and its own wins once it has one", () => {
    const b = board();
    const n3 = b.cards.find((c) => c.id === "n3") as NoteCard;
    n3.md = "第一段讲 [[吞吐]] 和 ==延迟==，不是标题\n# 后面的标题不算";
    expect(untitled(n3)).toBe(true);
    expect(untitled({ id: "i", kind: "image", src: "a.png" })).toBe(true);
    expect(untitled({ id: "i", kind: "image", src: "a.png", alt: "流水线" })).toBe(false);
    expect(untitled({ ...n3, md: "\n## 有标题\n正文" })).toBe(false);
    const frames = new Map(b.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    const title = () => summarySources(b, rects(b), frames).items.find((i) => i.key === cardKey("n3"))!.title;
    // never its first paragraph
    expect(title()).toBe("");
    const r = summaryRequest(b, cardKey("n3"), layoutSummaries(summarySources(b, rects(b), frames)))!;
    expect(r.untitled).toBe(true);
    expect(r.title).toBe("（无标题）");
    const s = readSummaryReply('{"title": "吞吐与延迟", "text": "**吞吐**先于延迟。"}', r, 5)!;
    putSummary(b, cardKey("n3"), s);
    expect(title()).toBe("吞吐与延迟");
    n3.md = "# 自己的标题\n正文";
    expect(title()).toBe("自己的标题");
    expect(
      summaryRequest(b, cardKey("n3"), layoutSummaries(summarySources(b, rects(b), frames)))!.untitled,
    ).toBeUndefined();
  });
});

describe("a wide Section's column", () => {
  it("keeps its anchor and stops at 28 S of text, however wide the Section", () => {
    const l = layoutSummaries({ items: [sec("wide", { x: 100, y: 200, w: 6000, h: 900 })], keep: [] });
    const c = col(l, secKey("wide"));
    expect(c.x).toBe(100);
    expect(c.y).toBe(200);
    expect(c.w).toBe(SUMMARY.maxLine * l.S + 2 * l.P);
  });
});

describe("columns at rest", () => {
  const card = (id: string, x: number, y: number, text: string): SumSource => ({
    key: cardKey(id),
    box: { x, y, w: 400, h: 100 },
    own: { x, y, w: 400, h: 100 },
    title: `合并访存：${id}`,
    text,
  });
  it("two loose cards stacked close together never overlap: the upper column stops the gap above the lower, its full text is longer", () => {
    const long = "合并访存要求同一 warp 的线程访问连续的地址，".repeat(6);
    for (const dy of [160, 300, 600, 1200]) {
      const l = layoutSummaries({ items: [card("a", 0, 0, long), card("b", 0, dy, long)], keep: [] });
      const a = col(l, cardKey("a")),
        b = col(l, cardKey("b"));
      expect(a.y + a.h).toBeLessThanOrEqual(b.y - SUMMARY.gap);
      // the text it holds is taller than its room: the board fades its last lines and shows it all on hover
      if (dy < 1200) expect(a.full).toBeGreaterThan(a.h);
    }
  });
  it("a short text takes only the height it needs", () => {
    const l = layoutSummaries({ items: [card("a", 0, 0, "短。"), card("b", 0, 1500, "短。")], keep: [] });
    const a = col(l, cardKey("a"));
    expect(a.h).toBeLessThan(1500 - SUMMARY.gap);
    expect(a.full).toBeLessThanOrEqual(Math.ceil(a.h));
  });
});

describe("the AI's prompt", () => {
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
  it("reads the JSON answer, keeps about one bold key phrase per 40 chars (one under 50, three at most) and a card's title", () => {
    const b = board();
    const frames = new Map(b.sections.map((s) => [s.id, { x: s.x, y: s.y, w: s.w, h: s.h }]));
    const r = summaryRequest(b, cardKey("n3"), layoutSummaries(summarySources(b, rects(b), frames)))!;
    const s = readSummaryReply('```json\n{"text": "**吞吐**优先，**延迟**其次。", "title": "导读"}\n```', r, 5)!;
    // under 50 chars: exactly one bold key phrase, the first
    expect(s).toEqual({ text: "**吞吐**优先，延迟其次。", title: "导读", at: 5, sig: r.sig, input: r.input });
    // about one per 40 chars, at most three: later ones stay as plain text
    const long = (n: number) => Array.from({ length: n }, (_, i) => `**要点${i}**${"字".repeat(36)}。`).join("");
    const bolds = (t: string) => (readSummaryReply(t, r, 5)!.text.match(/\*\*/g) ?? []).length / 2;
    expect(bolds(long(2))).toBe(2);
    expect(bolds(long(5))).toBe(3);
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

/**
 * Nested Sections (option G, feedback/demo/nested-sections.html): P holds Q (which holds L1 and L2), A, B, L3 and two cards of its
 * own (d1, d2); O1 holds only O2, which holds only C; a loose card z sits above P
 */
function nested(): { b: Board; frames: Map<string, Rect>; rect: (id: string) => Rect | undefined } {
  const b = emptyBoard("bn", "计算架构");
  const note = (id: string, title: string): NoteCard => ({
    id,
    kind: "note",
    md: `# ${title}\n正文 ${id}`,
    look: "note",
  });
  const at: Record<string, [string | undefined, number, number, number, number]> = {
    l1: ["L1", 100, 100, 400, 300],
    l2: ["L2", 550, 100, 400, 300],
    l3: ["L3", 1100, 100, 400, 300],
    d1: ["P", 1600, 100, 300, 150],
    d2: ["P", 1600, 300, 300, 150],
    a1: ["A", 100, 800, 400, 300],
    a2: ["A", 550, 800, 400, 300],
    b1: ["B", 1100, 800, 400, 500],
    c1: ["C", 3000, 100, 400, 300],
    z: [undefined, 100, -900, 500, 200],
  };
  for (const [id, [s, x, y, w]] of Object.entries(at)) {
    b.cards.push(note(id, `卡 ${id}`));
    b.place[id] = { x, y, w, ...(s ? { section: s } : {}) };
  }
  const S = (id: string, parent?: string) => ({
    id,
    title: `节 ${id}`,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    ...(parent ? { parent } : {}),
  });
  b.sections.push(S("P"), S("Q", "P"), S("L1", "Q"), S("L2", "Q"), S("L3", "P"), S("A", "P"), S("B", "P"));
  b.sections.push(S("O1"), S("O2", "O1"), S("C", "O2"));
  const rs = new Map(Object.entries(at).map(([id, [, x, y, w, h]]) => [id, { x, y, w, h }]));
  // a frame is its stored box grown to what it holds: store a point inside it (a card's corner)
  const first = (sid: string): string =>
    Object.keys(at).find((id) => at[id][0] === sid) ?? first(b.sections.find((x) => x.parent === sid)!.id);
  for (const s of b.sections) Object.assign(s, { x: rs.get(first(s.id))!.x, y: rs.get(first(s.id))!.y });
  return { b, frames: sectionFrames(b, rs), rect: (id) => rs.get(id) };
}
const overlap = (a: Rect, c: Rect) => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;

describe("nested Sections", () => {
  it("plans innermost Sections, headers (overview on the outermost only), one-child Sections as a kick line, direct cards", () => {
    const { b } = nested();
    const plan = sectionPlan(b);
    const role = (id: string) => {
      const p = plan.get(id)!;
      return [p.role, p.lines, p.kick ?? ""];
    };
    expect(role("P")).toEqual(["head", 2, ""]);
    expect(role("Q")).toEqual(["head", 0, ""]);
    expect(["L1", "L2", "L3", "A", "B"].map((id) => plan.get(id)!.role)).toEqual(Array(5).fill("leaf"));
    expect(role("O1")).toEqual(["pass", 0, ""]);
    expect(role("O2")).toEqual(["pass", 0, "节 O1"]);
    expect(role("C")).toEqual(["leaf", 0, "节 O1 › 节 O2"]);
    expect(plan.get("P")!.direct.map((c) => c.id)).toEqual(["d1", "d2"]);
    expect(summaryKeys(b).sort()).toEqual(
      ["card:z", "own:P", "sec:A", "sec:B", "sec:C", "sec:L1", "sec:L2", "sec:L3", "sec:P"].sort(),
    );
  });
  it("a depth-2 header with one line: an outer Section whose parent has one child", () => {
    const b = emptyBoard("b2", "t");
    b.sections.push({ id: "T", title: "T", x: 0, y: 0, w: 0, h: 0 });
    b.sections.push({ id: "M", title: "M", x: 0, y: 0, w: 0, h: 0, parent: "T" });
    b.sections.push({ id: "X", title: "X", x: 0, y: 0, w: 0, h: 0, parent: "M" });
    b.sections.push({ id: "Y", title: "Y", x: 0, y: 0, w: 0, h: 0, parent: "M" });
    const p = sectionPlan(b);
    expect([p.get("T")!.role, p.get("M")!.role, p.get("M")!.lines, p.get("M")!.kick]).toEqual(["pass", "head", 1, "T"]);
  });
  it("lays headers above their frames, stacked deepest at the bottom, the direct cards as one column, nothing overlapping", () => {
    const { b, frames, rect } = nested();
    const l = layoutSummaries(summarySources(b, rect, frames));
    const P = col(l, "sec:P"),
      Q = col(l, "sec:Q"),
      own = col(l, "own:P"),
      C = col(l, "sec:C"),
      z = col(l, "card:z");
    const fP = frames.get("P")!,
      fQ = frames.get("Q")!;
    expect(P.head).toEqual({ level: 1, lines: 2 });
    expect(Q.head).toEqual({ level: 2, lines: 0 });
    // Q's header ends just above Q's frame; P's sits on top of Q's (Q's frame is P's top row)
    expect(Q.y + Q.h).toBe(fQ.y - SUMMARY.headGap);
    expect(Q.y).toBeLessThan(fP.y);
    expect(P.y + P.h).toBe(Q.y - SUMMARY.headGap);
    expect([P.x, P.w]).toEqual([fP.x, Math.min(fP.w, SUMMARY.maxLine * l.S + 2 * l.P)]);
    // the direct cards: one column at their top-left; the one-child chain: the leaf's column with the kick
    expect([own.x, own.y, own.group]).toEqual([1600, 100, true]);
    expect([C.kick, C.x, C.y]).toEqual(["节 O1 › 节 O2", frames.get("C")!.x, frames.get("C")!.y]);
    expect(l.cols.some((c) => c.key === "sec:O1" || c.key === "sec:O2")).toBe(false);
    // the column above the header runs down to it
    expect(z.y + z.h).toBeLessThanOrEqual(P.y - SUMMARY.gap);
    expect(z.h).toBeGreaterThan(0);
    for (const a of l.cols)
      for (const c of l.cols) if (a !== c) expect(overlap(a, c), `${a.key} / ${c.key}`).toBe(false);
  });
  it("writes the overview from the children's titles and summaries and the direct cards; the direct cards' summary apart", () => {
    const { b, frames, rect } = nested();
    const l = layoutSummaries(summarySources(b, rect, frames));
    putSummary(b, "sec:A", { text: "A 的**摘要**", at: 1, sig: summarySig(b, "sec:A")! });
    const r = summaryRequest(b, "sec:P", l)!;
    expect(r.overview?.map((k) => k.title)).toEqual(["节 Q", "节 L3", "节 A", "节 B"]);
    expect(r.overview?.find((k) => k.title === "节 A")?.text).toBe("A 的**摘要**");
    expect(r.cards.map((c) => c.title)).toEqual(["卡 d1", "卡 d2"]);
    // a header under another header writes nothing
    expect(summaryRequest(b, "sec:Q", l)).toBeUndefined();
    expect(summarySig(b, "sec:Q")).toBeUndefined();
    const g = summaryRequest(b, "own:P", l)!;
    expect([g.group, g.title, g.cards.map((c) => c.title)]).toEqual([true, "节 P", ["卡 d1", "卡 d2"]]);
    // its answer keeps the AI's short title, stored on the Section, apart from the overview
    const s = readSummaryReply('{"title": "同步层次", "text": "barrier 分**三层**。"}', g, 3)!;
    expect(s.title).toBe("同步层次");
    putSummary(b, "own:P", s);
    putSummary(b, "sec:P", { text: "概述", at: 3, sig: summarySig(b, "sec:P")!, input: summaryInput(b, "sec:P") });
    const P = b.sections.find((x) => x.id === "P")!;
    expect([P.directSummary?.text, P.summary?.text]).toEqual(["barrier 分**三层**。", "概述"]);
    expect(summaryOf(b, "own:P")?.title).toBe("同步层次");
    expect(summarySources(b, rect, frames).items.find((i) => i.key === "own:P")?.title).toBe("同步层次");
  });
  it("hashes an overview over its children's summaries and its direct cards; moving cards changes nothing", () => {
    const { b } = nested();
    const h0 = summaryInput(b, "sec:P"),
      g0 = summaryInput(b, "own:P"),
      s0 = summarySig(b, "sec:P");
    b.place.d1.x += 80;
    expect([summaryInput(b, "sec:P"), summaryInput(b, "own:P")]).toEqual([h0, g0]);
    putSummary(b, "sec:B", { text: "B 写好了", at: 1, sig: summarySig(b, "sec:B")! });
    expect(summaryInput(b, "sec:P")).not.toBe(h0);
    expect(summarySig(b, "sec:P")).not.toBe(s0);
    expect(summaryInput(b, "own:P")).toBe(g0);
    (b.cards.find((c) => c.id === "d2") as NoteCard).md = "# 换了标题\n正文";
    expect(summaryInput(b, "own:P")).not.toBe(g0);
  });
});
