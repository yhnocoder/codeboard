import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExpandResult, Segment } from "@codeboard/core";
import { analysisOf } from "../src/analysis";
import { expand } from "../src/resolve";
import { forgetDefs } from "../src/defcache";
import { WARM_DELAY, WARM_GAP, prefetchCall, prefetchIdle, warmBoard } from "../src/prefetch";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const schAbs = path.join(WS, "nanovllm/engine/scheduler.py"), llmAbs = path.join(WS, "nanovllm/engine/llm_engine.py");
let step: Segment, req: { seg: Segment; line: number; col: number; name: string };
// the stub language service: counts requests, how many run at once and where each one asked; with hold, each request waits until
// the test releases it (otherwise it answers at once)
let calls = 0, live = 0, maxLive = 0, hold = false, empty = false, asked: string[] = [];
const held: (() => void)[] = [];
const release = () => { for (const r of held.splice(0)) r(); };
const idle = () => vi.waitFor(() => expect(prefetchIdle()).toBe(true), { timeout: 10000, interval: 5 });
const isSchedule = (r: ExpandResult) => "card" in r && r.card.segments[0].symbol?.qual === "Scheduler.schedule";
const orig = W.language.definitions;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  const defLine = analysisOf("python", fs.readFileSync(schAbs, "utf8")).symbols.find((x) => x.qual === "Scheduler.schedule")!.defLine;
  W.language.definitions = async (abs, line, col) => {
    calls++; live++; maxLive = Math.max(maxLive, live); asked.push(`${abs}:${line}:${col}`);
    await new Promise<void>((r) => (hold ? held.push(r) : r()));
    live--;
    return empty ? [] : [{ abs: schAbs, line: defLine, col: 8 }];
  };
  step = (await card(llmAbs, "LLMEngine.step")).seg;
  req = { ...at(step, /self\.scheduler\.schedule\(\)/, "schedule("), name: "schedule" };
});
afterAll(() => { W.language.definitions = orig; W.open.clear(); });
beforeEach(() => { forgetDefs(); calls = 0; maxLive = 0; hold = false; empty = false; asked = []; });
afterEach(async () => { hold = false; release(); await idle(); });

describe("hover prefetch", () => {
  it("is reused by a click while in flight and cached for the next click, each click still building a fresh card", async () => {
    hold = true;
    prefetchCall(req);
    // the hover's request is in flight before the click (the stub answers only once released)
    await vi.waitFor(() => expect({ calls, live }).toEqual({ calls: 1, live: 1 }), { timeout: 5000, interval: 1 });
    const click = expand(req);
    hold = false;
    release();
    const r1 = await click;
    expect(isSchedule(r1)).toBe(true);
    expect(calls).toBe(1);
    const r2 = await expand(req);
    expect(isSchedule(r2)).toBe(true);
    expect(calls).toBe(1);
    expect("card" in r1 && "card" in r2 && r1.card.id !== r2.card.id).toBe(true);
  });
  it("is dropped by forgetDefs (a file changed)", async () => {
    await expand(req);
    forgetDefs();
    await expand(req);
    expect(calls).toBe(2);
  });
  it("misses when the calling file's content changed (unsaved edits)", async () => {
    await expand(req);
    W.open.set(llmAbs, fs.readFileSync(llmAbs, "utf8") + "\n# edited\n");
    expect(isSchedule(await expand(req))).toBe(true);
    expect(calls).toBe(2);
    W.open.clear();
  });
  it("is not reused by the click when the answer was empty (language server still starting)", async () => {
    empty = true;
    prefetchCall(req);
    await vi.waitFor(() => expect({ calls, live }).toEqual({ calls: 1, live: 0 }), { timeout: 5000, interval: 1 }); // answered (empty)
    empty = false;
    expect(isSchedule(await expand(req))).toBe(true);
    expect(calls).toBe(2);
  });
  it("runs at most 2 requests at a time and drops older queued hovers", async () => {
    hold = true;
    const cls = (await card(llmAbs, "LLMEngine")).seg;
    const sites = analysisOf("python", fs.readFileSync(llmAbs, "utf8")).calls.filter((c) => c.line >= cls.start && c.line <= cls.end);
    expect(sites.length).toBeGreaterThanOrEqual(12); // 12 different positions: no hover shares another's request
    for (let i = 0; i < 12; i++) { const c = sites[i]; prefetchCall({ seg: cls, line: c.line, col: c.col, name: c.name }); }
    // the first 2 start at once, the newest 4 wait (MAX_RUN, MAX_WAIT in prefetch.ts); the 6 older queued ones are dropped.
    // Release the requests two by two: never more than 2 at the language server
    for (const n of [2, 4, 6]) {
      await vi.waitFor(() => expect({ calls, live }).toEqual({ calls: n, live: 2 }), { timeout: 10000, interval: 2 });
      release();
    }
    hold = false;
    await idle(); // nothing else was queued: no 7th request
    expect(calls).toBe(6);
    expect(maxLive).toBe(2);
    const at = (i: number) => `${llmAbs}:${sites[i].line}:${sites[i].col}`;
    // the 2 that start at once run side by side, so either can reach the language server first
    expect([...asked.slice(0, 2)].sort()).toEqual([0, 1].map(at).sort());
    expect([...asked.slice(2)].sort()).toEqual([8, 9, 10, 11].map(at).sort());
  });
});

describe("board-open warm-up", () => {
  it("returns at once, then asks once per distinct file, one at a time", async () => {
    const segs = await Promise.all([
      card(llmAbs, "LLMEngine.__init__"), card(path.join(WS, "nanovllm/engine/model_runner.py"), "ModelRunner.__init__"), card(schAbs, "Scheduler.schedule"),
    ]);
    // the warm-up's own waits (before it starts, between files) on a fake clock
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // returns at once: no promise for the board's open to wait on, and nothing asked before it returned (the asks start on its timer)
      expect(warmBoard([step, ...segs.map((c) => c.seg)], () => true)).toBeUndefined();
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(WARM_DELAY - 1);
      expect(calls).toBe(0);
      // reading and analysing the files is real work: let the clock run a gap at a time until all 3 were asked
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(WARM_GAP); expect(calls).toBe(3); }, { timeout: 10000, interval: 5 });
    } finally { vi.useRealTimers(); }
    expect(new Set(asked.map((a) => a.split(":")[0])).size).toBe(3); // one request per file: step and LLMEngine.__init__ share llm_engine.py
    expect(maxLive).toBe(1);
  });
});
