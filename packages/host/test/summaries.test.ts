// Zoomed-out summaries written by the host (summaries.ts) on a fake fetch: the request DeepSeek gets (no layout numbers, JSON, no
// thinking), what a failure turns into, and SummaryWatch's timing on vitest's fake timers: opening a board asks only for written
// summaries whose cards changed since, a pending one is written SUMMARY.regenMs after its latest change (every change restarts the
// wait), a hand-edited one too, in the style of the edit, and nothing is asked while an item's input hash is unchanged
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUMMARY,
  emptyBoard,
  putSummary,
  summaryInput,
  summarySig,
  type Board,
  type HostToBoard,
  type NoteCard,
  type Summary,
} from "@codeboard/core";
import {
  SummaryWatch,
  hostRequests,
  summarize,
  summaryChatRequest,
  summaryPrompt,
  SUMMARY_SYSTEM,
} from "../src/summaries";
import { nodeWorkspace } from "./node-workspace";
import { HostContext } from "../src/context";

type Call = { url: string; body: any };
function fakeFetch(answer: (c: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, body: JSON.parse(String(init.body)) };
    calls.push(c);
    const r = answer(c);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (content: string) => ({ status: 200, json: { choices: [{ message: { content } }] } });

let key: string | undefined;
const W = nodeWorkspace();
W.secrets = { ...W.secrets, get: async () => key };
let cx: HostContext;
beforeEach(() => {
  key = "sk-test-summary";
  cx = new HostContext(W);
});

/** Section s with two Notes, and a loose Note */
function board(): Board {
  const b = emptyBoard("b1", "t");
  const note = (id: string, md: string): NoteCard => ({ id, kind: "note", md, look: "note" });
  b.cards.push(
    note("n1", "# 吞吐\n多核路线保住串行速度"),
    note("n2", "# 延迟\nGPU 用大量小算术单元"),
    note("n3", "# 松散\n一句"),
  );
  b.sections.push({ id: "s", title: "异构并行", x: 0, y: 0, w: 900, h: 500 });
  b.place = {
    n1: { x: 40, y: 60, w: 300, section: "s" },
    n2: { x: 400, y: 60, w: 300, section: "s" },
    n3: { x: 1200, y: 0, w: 400 },
  };
  return b;
}
const written = (b: Board, k: string): Summary => ({
  text: "旧的",
  at: 1,
  sig: summarySig(b, k)!,
  input: summaryInput(b, k),
});

describe("summarize", () => {
  it("asks DeepSeek with the summary prompt filled in (title, cards), without thinking, and reads the answer", async () => {
    const b = board();
    const req = hostRequests(b).get("sec:s")!;
    const { f, calls } = fakeFetch(() => ok('{"text": "众线程押**吞吐量**，CPU 押延迟。"}'));
    const r = await summarize(cx, req, f);
    expect(r).toEqual({
      summary: { text: "众线程押**吞吐量**，CPU 押延迟。", at: expect.any(Number), sig: req.sig, input: req.input },
    });
    const body = calls[0].body;
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content).toBe(SUMMARY_SYSTEM);
    expect(body.messages[1].content).toContain(`Section 标题：${req.title}`);
    // how long follows the content: no layout numbers in the prompt
    expect(body.messages[1].content).toContain("每个独立的关键要点写一句");
    expect(body.messages[1].content).not.toMatch(/容量|每行 \d+ 个字|目标约/);
    expect(body.messages[1].content).toContain("多核路线保住串行速度");
    expect(body.messages[1].content).not.toMatch(/\{[^{}]*\}/);
    expect(summaryChatRequest({ key: "k", baseUrl: "http://x/" }, req).url).toBe("http://x/chat/completions");
    // a loose card gets the same prompt, with its own title
    expect(summaryPrompt(hostRequests(b).get("card:n3")!).user).toContain("Section 标题：松散");
  });
  it("needs a key, and turns a rejected key into badkey", async () => {
    const req = hostRequests(board()).get("card:n3")!;
    const { f, calls } = fakeFetch(() => ({ status: 401, json: { error: { message: "bad" } } }));
    key = undefined;
    expect(await summarize(cx, req, f)).toEqual({ fail: "nokey", via: "DeepSeek" });
    expect(calls).toHaveLength(0);
    key = "sk";
    expect(await summarize(cx, req, f)).toMatchObject({ fail: "badkey", message: "bad" });
  });
});

describe("SummaryWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function watch(b: Board) {
    const posts: HostToBoard[] = [];
    const { f, calls } = fakeFetch(() => ok('{"text": "新的**摘要**。", "title": "导读"}'));
    const w = new SummaryWatch(cx, { board: () => b, boards: () => [b], post: (_id, m) => (posts.push(m), true) }, f);
    return { w, posts, calls };
  }
  const keys = (posts: HostToBoard[]) =>
    posts.flatMap((m) => (m.type === "summaries" ? Object.keys(m.items) : [])).sort();

  it("asks for nothing when a board opens but the written summaries whose cards changed since, never the whole board", async () => {
    const b = board();
    const { w, posts, calls } = watch(b);
    w.opened(b);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs);
    await w.idle();
    expect(calls).toHaveLength(0);
    putSummary(b, "sec:s", written(b, "sec:s"));
    putSummary(b, "card:n3", written(b, "card:n3"));
    // reopened after a session that added a card to the Section: only that Section is rewritten
    b.cards.push({ id: "n4", kind: "note", md: "# 新卡", look: "note" });
    b.place.n4 = { x: 40, y: 300, w: 300, section: "s" };
    w.opened(b);
    expect(w.waiting("b1")).toEqual(["sec:s"]);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs);
    await w.idle();
    expect(calls).toHaveLength(1);
    expect(keys(posts)).toEqual(["sec:s"]);
    w.dispose();
  });
  it("sends no request while an item's input hash is unchanged: a change and its reverse, a reopen", async () => {
    const b = board();
    putSummary(b, "sec:s", written(b, "sec:s"));
    putSummary(b, "card:n3", written(b, "card:n3"));
    const { w, calls } = watch(b);
    w.opened(b);
    const n1 = b.cards[0] as NoteCard;
    n1.md = "# 带宽\n";
    w.saw(b);
    expect(w.waiting("b1")).toEqual(["sec:s"]);
    // undone: the same title back, so the wait stops
    n1.md = "# 吞吐\n多核路线保住串行速度";
    w.saw(b);
    expect(w.waiting("b1")).toEqual([]);
    // a pending summary whose inputs are back to the ones it was written from (the stored sig is stale) asks nothing either
    putSummary(b, "sec:s", { ...written(b, "sec:s"), sig: "stale" });
    w.opened(b);
    w.saw(b);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs);
    b.cards.push({ id: "n5", kind: "note", md: "# 又一张", look: "note" });
    b.place.n5 = { x: 40, y: 300, w: 300, section: "s" };
    w.saw(b);
    b.cards.pop();
    delete b.place.n5;
    w.saw(b);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs);
    await w.idle();
    expect(calls).toHaveLength(0);
    w.dispose();
  });
  it("rewrites a pending summary SUMMARY.regenMs after the latest change, each change restarting the wait", async () => {
    const b = board();
    putSummary(b, "sec:s", written(b, "sec:s"));
    putSummary(b, "card:n3", written(b, "card:n3"));
    const { w, posts, calls } = watch(b);
    w.opened(b);
    expect(w.waiting("b1")).toEqual([]);
    (b.cards[0] as NoteCard).md = "# 带宽\n";
    w.saw(b);
    expect(w.waiting("b1")).toEqual(["sec:s"]);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs - 1000);
    // another change: the wait starts again
    b.cards.push({ id: "n4", kind: "note", md: "# 新卡", look: "note" });
    b.place.n4 = { x: 40, y: 300, w: 300, section: "s" };
    w.saw(b);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs - 1000);
    expect(calls).toHaveLength(0);
    // a save with nothing new does not restart it
    w.saw(b);
    await vi.advanceTimersByTimeAsync(1000);
    await w.idle();
    expect(calls).toHaveLength(1);
    expect(keys(posts)).toEqual(["sec:s"]);
    w.dispose();
  });
  it("rewrites a hand-edited summary too, with the user's edits, and writes nothing without a key", async () => {
    const b = board();
    putSummary(b, "sec:s", { ...written(b, "sec:s"), edited: true, pairs: [{ ai: "旧的", user: "我改的", at: 2 }] });
    const { w, posts, calls } = watch(b);
    w.opened(b);
    (b.cards[0] as NoteCard).md = "# 带宽\n";
    w.saw(b);
    expect(w.waiting("b1")).toEqual(["sec:s"]);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs);
    await w.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.messages[1].content).toContain("用户改成：\n我改的");
    const sent = posts.flatMap((m) => (m.type === "summaries" ? [m.items["sec:s"]] : [])).find(Boolean);
    expect(sent?.pairs).toEqual([{ ai: "旧的", user: "我改的", at: 2 }]);
    key = undefined;
    (b.cards[0] as NoteCard).md = "# 又变了\n";
    w.saw(b);
    await vi.advanceTimersByTimeAsync(SUMMARY.regenMs);
    await w.idle();
    expect(calls).toHaveLength(1);
    w.dispose();
  });
});

describe("summaryPrompt", () => {
  const base = () => hostRequests(board()).get("sec:s")!;
  it("fills the prompt's own four examples when the user has edited nothing", () => {
    const u = summaryPrompt(base()).user;
    expect(u.match(/^例 \d$/gm)).toEqual(["例 1", "例 2", "例 3", "例 4"]);
    expect(u).toContain("标题：使用 Kogge–Stone 算法进行 parallel scan");
    expect(u).not.toContain("用户改");
  });
  it("asks for a bold key phrase per important sentence, and its own examples show 2–3 short ones, no numbers", () => {
    const u = summaryPrompt(base()).user;
    expect(u).toContain(
      "大约每 40 字一处，最多 3 处；不到 50 字的摘要正好一处。每处 2–10 个字；加粗的字合起来不超过全文的四分之一",
    );
    const sums = [...u.matchAll(/^摘要：(.*)$/gm)].map((m) => m[1]);
    expect(sums).toHaveLength(4);
    for (const t of sums) {
      const bold = [...t.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
      expect(bold.length).toBeGreaterThanOrEqual(2);
      expect(bold.length).toBeLessThanOrEqual(3);
      for (const b of bold) {
        // CJK characters count one, Latin letters and spaces half
        const n = [...b].reduce((a, ch) => a + (/[\u4e00-\u9fff]/.test(ch) ? 1 : 0.5), 0);
        expect(n).toBeGreaterThanOrEqual(2);
        expect(n).toBeLessThanOrEqual(10);
        expect(b).not.toMatch(/\d/);
      }
      expect(bold.join("").length).toBeLessThanOrEqual(t.replace(/\*\*/g, "").length / 4);
    }
  });
  it("puts the user's edited summaries in the first example slots, the prompt's own in the rest", () => {
    const u = summaryPrompt({
      ...base(),
      examples: [
        { title: "我的 Section", content: "卡片浓缩", summary: "我写的摘要" },
        { title: "另一个", content: "内容", summary: "另一段" },
      ],
    }).user;
    expect(u).toContain("例 1\n标题：我的 Section\n内容：卡片浓缩\n摘要：我写的摘要");
    expect(u).toContain("例 2\n标题：另一个");
    expect(u).toContain("例 3\n标题：使用 Kogge–Stone 算法进行 parallel scan");
    expect(u).toContain("例 4\n标题：并行 radix sort");
    expect(u).not.toContain("Floyd-Warshall");
  });
  it("sends a Section's edits over two rounds newest first, the newer winning where they conflict", () => {
    const u = summaryPrompt({
      ...base(),
      pairs: [
        { ai: "AI 第二版", user: "我的第二版", at: 2 },
        { ai: "AI 第一版", user: "我的第一版", at: 1 },
      ],
    }).user;
    expect(u).toContain("以较新的为准");
    expect(u.indexOf("我的第二版")).toBeLessThan(u.indexOf("我的第一版"));
    expect(u).toContain("第 1 次（最新）AI 原来写的：\nAI 第二版\n用户改成：\n我的第二版");
    expect(u).toContain("第 2 次（最旧）");
    expect(u.trimEnd().endsWith("只输出摘要正文。")).toBe(true);
  });
});
