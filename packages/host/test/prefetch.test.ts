// Hover prefetch: the definition request is shared with the click, keyed by file + position + content; the hover queue and the
// board-open warm-up keep the language service from being flooded
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import type { ExpandResult, Segment } from "@codeboard/core";
import { analysisOf } from "../src/analysis";
import { expand } from "../src/resolve";
import { forgetDefs } from "../src/defcache";
import { prefetchCall, warmBoard } from "../src/prefetch";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { at, card, sleep, startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const schAbs = path.join(WS, "nanovllm/engine/scheduler.py"), llmAbs = path.join(WS, "nanovllm/engine/llm_engine.py");
let step: Segment, req: { seg: Segment; line: number; col: number; name: string };
// the stub language service: counts requests and how many run at once
let calls = 0, live = 0, maxLive = 0, delay = 60, empty = false;
const isSchedule = (r: ExpandResult) => "card" in r && r.card.segments[0].symbol?.qual === "Scheduler.schedule";
const orig = W.language.definitions;

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  const defLine = analysisOf("python", fs.readFileSync(schAbs, "utf8")).symbols.find((x) => x.qual === "Scheduler.schedule")!.defLine;
  W.language.definitions = async () => {
    calls++; live++; maxLive = Math.max(maxLive, live);
    await sleep(delay);
    live--;
    return empty ? [] : [{ abs: schAbs, line: defLine, col: 8 }];
  };
  step = (await card(llmAbs, "LLMEngine.step")).seg;
  req = { ...at(step, /self\.scheduler\.schedule\(\)/, "schedule("), name: "schedule" };
});
afterAll(() => { W.language.definitions = orig; W.open.clear(); });
beforeEach(() => { forgetDefs(); calls = 0; maxLive = 0; delay = 60; empty = false; });

describe("hover prefetch", () => {
  it("is reused by a click while in flight and cached for the next click, each click still building a fresh card", async () => {
    prefetchCall(req);
    await sleep(5);
    const r1 = await expand(req);
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
    await sleep(delay + 30);
    empty = false;
    expect(isSchedule(await expand(req))).toBe(true);
    expect(calls).toBe(2);
  });
  it("runs at most 2 requests at a time and drops older queued hovers", async () => {
    delay = 80;
    const sites = analysisOf("python", fs.readFileSync(llmAbs, "utf8")).calls.filter((c) => c.line >= step.start && c.line <= step.end);
    for (let i = 0; i < 12; i++) { const c = sites[i % sites.length]; prefetchCall({ seg: step, line: c.line, col: c.col, name: c.name }); }
    await sleep(800);
    expect(maxLive).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(6);
  });
});

describe("board-open warm-up", () => {
  it("returns at once, then asks once per distinct file, one at a time", async () => {
    delay = 20;
    const segs = await Promise.all([
      card(llmAbs, "LLMEngine.__init__"), card(path.join(WS, "nanovllm/engine/model_runner.py"), "ModelRunner.__init__"), card(schAbs, "Scheduler.schedule"),
    ]);
    const t0 = Date.now();
    warmBoard([step, ...segs.map((c) => c.seg)], () => true);
    expect(calls).toBe(0);
    expect(Date.now() - t0).toBeLessThan(50);
    await sleep(2500);
    expect(calls).toBe(3);
    expect(maxLive).toBe(1);
  });
});
