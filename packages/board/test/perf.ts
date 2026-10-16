// 性能基准：用 nano-vllm 拼一块大白板，在浏览器里量镜头、拖动、修改、展开、撤销、加载的耗时。
// 用法：node packages/board/test/run-perf.mjs [--cards 240] [--runs 3] [--json out.json]
// 每个场景报两样：墙钟（操作 → 下一帧画出来）和主线程忙的时间（CDP 的 TaskDuration）。
import * as fs from "node:fs";
import { ready, open, symCard, files, type Host } from "./harness";
import { emptyBoard, uid, type Board, type CodeCard, type Link, type Section, type Sidenote } from "@codeboard/core";
import type { CDPSession } from "playwright-core";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NCARDS = +arg("cards", "240"), RUNS = +arg("runs", "3"), JSON_OUT = arg("json", ""), PROFILE = arg("profile", "");

/** 一块大白板：nano-vllm 的函数（不够就重复），按调用连成树，每 12 张一个 Section（两层嵌套），一些 Sidenote */
export function bigBoard(n: number): Board {
  const b = emptyBoard("perf", `perf · ${n} cards`);
  const defs = [...files.entries()].flatMap(([f, x]) => x.a.symbols.filter((s) => s.kind === "def").map((s) => ({ f, s, calls: x.a.calls.filter((c) => c.line >= s.start && c.line <= s.end && !c.dispatch) })));
  const cards: { c: CodeCard; d: (typeof defs)[number] }[] = [];
  for (let i = 0; cards.length < n; i++) { const d = defs[i % defs.length]; cards.push({ c: symCard(d.f, d.s), d }); }
  // 第 0 张是 LLMEngine.step 且不连线，留给「展开」场景点
  const step = defs.find((d) => d.s.qual === "LLMEngine.step")!;
  cards.unshift({ c: symCard(step.f, step.s), d: { ...step, calls: [] } });
  const COLS = 12;
  cards.forEach(({ c }, i) => { b.cards.push(c); b.place[c.id] = { x: (i % COLS) * 620, y: Math.floor(i / COLS) * 700, w: 560 }; });
  const hasIn = new Set<string>();
  cards.forEach(({ c, d }, i) => {
    for (const call of d.calls) {
      const j = cards.findIndex((t, k) => k > i && !hasIn.has(t.c.id) && t.d.s.name === call.name);
      if (j < 0) continue;
      hasIn.add(cards[j].c.id);
      const L: Link = { id: uid("l"), kind: "call", from: { card: c.id, seg: c.segments[0].id, line: call.line }, to: { card: cards[j].c.id }, call: { name: call.name, col: call.col }, loop: call.loop || undefined };
      b.links.push(L);
    }
  });
  // 再加些 Plain link，凑够和卡差不多的数量
  for (let i = 1; b.links.length < n && i + 7 < cards.length; i += 3) b.links.push({ id: uid("l"), kind: "plain", from: { card: cards[i].c.id }, to: { card: cards[i + 7].c.id }, arrow: "end" });
  const rows = Math.ceil(cards.length / COLS);
  for (let r = 0; r < rows; r++) {
    const outer: Section = { id: uid("x"), title: `Row ${r}`, x: -40, y: r * 700 - 60, w: COLS * 620 + 40, h: 640 };
    const inner: Section = { id: uid("x"), title: `Row ${r} left`, x: -20, y: r * 700 - 40, w: 6 * 620, h: 600, parent: outer.id };
    b.sections.push(outer, inner);
    cards.slice(r * COLS, r * COLS + COLS).forEach(({ c }, k) => { b.place[c.id].section = k < 6 ? inner.id : outer.id; });
  }
  cards.forEach(({ c }, i) => {
    if (i % 3) return;
    const s = c.segments[0];
    const n: Sidenote = { id: uid("n"), at: { card: c.id, seg: s.id, lines: [s.start + 1, s.start + 1] }, kind: "text", md: `Note on ${s.symbol?.qual}` };
    b.sidenotes.push(n);
  });
  b.cam = { x: 80, y: 80, z: 1 };
  return b;
}

type M = { wall: number[]; busy: number; parts?: Record<string, number> };
const PARTS = ["ScriptDuration", "RecalcStyleDuration", "LayoutDuration"];
async function metrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
const raf = (h: Host) => h.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function busy(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
}
/** 跑 n 步，每步一次操作再等它画出来 */
async function steps(h: Host, cdp: CDPSession, n: number, step: (i: number) => Promise<void>, name = ""): Promise<M> {
  const wall: number[] = [];
  const prof = name && name === PROFILE;
  const tr = name && name === arg("trace", "");
  const events: any[] = [];
  if (tr) { cdp.on("Tracing.dataCollected", (e: any) => events.push(...e.value)); await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" } as any); }
  if (prof) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  const b0 = await busy(cdp);
  const m0 = await metrics(cdp);
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await step(i);
    await raf(h);
    wall.push(performance.now() - t);
  }
  const bz = (await busy(cdp)) - b0;
  const m1 = await metrics(cdp);
  const parts = Object.fromEntries(PARTS.map((k) => [k.replace("Duration", ""), +(((m1[k] - m0[k]) * 1000) / n).toFixed(2)]));
  if (prof) top((await cdp.send("Profiler.stop")).profile as any);
  if (tr) {
    const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
    await cdp.send("Tracing.end"); await done;
    const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
    const by = new Map<string, number>();
    for (const e of events) if (e.ph === "X" && e.dur && (!main || (e.pid === main.pid && e.tid === main.tid))) by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
    console.log("-- trace (main thread, inclusive ms)");
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(0).padStart(8)}  ${k}`);
  }
  return { wall, busy: bz, parts };
}
/** 剖析结果：按函数的自身时间和总时间排前 30 */
function top(p: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] }) {
  const self = new Map<number, number>();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n: (typeof p.nodes)[number]) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
  const selfBy = new Map<string, number>(), totBy = new Map<string, number>();
  for (const [id, t] of self) {
    const k = key(byId.get(id)!);
    selfBy.set(k, (selfBy.get(k) ?? 0) + t);
    const seen = new Set<string>();
    for (let q: number | undefined = id; q !== undefined; q = parent.get(q)) { const kk = key(byId.get(q)!); if (seen.has(kk)) continue; seen.add(kk); totBy.set(kk, (totBy.get(kk) ?? 0) + t); }
  }
  const pr = (m: Map<string, number>, t: string) => { console.log(`-- ${t}`); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${(v / 1000).toFixed(0).padStart(7)}ms  ${k}`); };
  pr(selfBy, "self"); pr(totBy, "total");
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const sum = (m: M) => ({ median: +med(m.wall).toFixed(1), p95: +p95(m.wall).toFixed(1), busyPerStep: +(m.busy / m.wall.length).toFixed(2), ...m.parts });

async function profiled<T>(cdp: CDPSession, name: string, fn: () => Promise<T>): Promise<T> {
  if (name !== PROFILE) return fn();
  await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start");
  const r = await fn();
  top((await cdp.send("Profiler.stop")).profile as any);
  return r;
}
async function idle(h: Host, cdp: CDPSession, ms: number) { const b0 = await busy(cdp); await h.page.waitForTimeout(ms); return (await busy(cdp)) - b0; }

async function once() {
  await ready();
  const board = bigBoard(NCARDS);
  const res: Record<string, unknown> = { cards: board.cards.length, links: board.links.length, sections: board.sections.length, sidenotes: board.sidenotes.length };
  const t0 = performance.now();
  let cdp!: CDPSession;
  const h = await open({ board, beforeLoad: async (page) => {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    if (PROFILE === "load") { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  } });
  // 加载：收到 init → 所有卡都画出来（页面里量）
  const ld = await h.page.waitForFunction((n) => document.querySelectorAll(".card").length >= n && performance.now() - (window as any).__tInit, board.cards.length, { timeout: 60000 });
  res.load = +(+(await ld.jsonValue())).toFixed(0);
  res.openTotal = +(performance.now() - t0).toFixed(0);
  if (PROFILE === "load") top((await cdp.send("Profiler.stop")).profile as any);
  if (arg("css", "")) await h.page.addStyleTag({ content: arg("css", "") });
  await h.page.waitForTimeout(1500);
  if (arg("shot", "")) {
    for (const z of [1, 2.5]) { await h.post({ type: "reveal", card: board.links[0].to.card }); await h.page.waitForTimeout(1000); if (z > 1) { await h.page.keyboard.down("Control"); for (let i = 0; i < 12; i++) await h.page.mouse.wheel(0, -40); await h.page.keyboard.up("Control"); await h.page.waitForTimeout(800); } await h.page.screenshot({ path: `${arg("shot", "")}-${z}.png` }); }
    await h.page.context().browser()!.close(); return res;
  }
  res.idleBusy1s = +(await idle(h, cdp, 1000)).toFixed(1);

  await h.page.mouse.move(700, 450);
  res.pan = sum(await steps(h, cdp, 60, async () => { await h.page.mouse.wheel(0, 40); }, "pan"));
  res.zoom = sum(await steps(h, cdp, 40, async (i) => { await h.page.keyboard.down("Control"); await h.page.mouse.wheel(0, i < 20 ? 30 : -30); await h.page.keyboard.up("Control"); }, "zoom"));
  await h.page.waitForTimeout(800);

  // 拖动：连线最多的那张卡（端点每帧跟着走）
  const deg = new Map<string, number>();
  for (const L of board.links) for (const id of [L.from.card, L.to.card]) deg.set(id, (deg.get(id) ?? 0) + 1);
  const hub = [...deg.entries()].sort((a, b) => b[1] - a[1])[0][0];
  res.hubLinks = deg.get(hub);
  await focusCard(h, hub);
  const head = h.page.locator(`.card[data-id="${hub}"] .chead .kind`);
  const bx = (await head.boundingBox())!;
  await h.page.mouse.move(bx.x + 4, bx.y + 4);
  await h.page.mouse.down();
  res.drag = sum(await steps(h, cdp, 60, async (i) => { await h.page.mouse.move(bx.x + 4 + i * 4, bx.y + 4 + i * 2, { steps: 1 }); }, "drag"));
  const tUp = performance.now();
  const bUp = await busy(cdp);
  await profiled(cdp, "dragEnd", async () => { await h.page.mouse.up(); await raf(h); });
  res.dragEndBusy = +((await busy(cdp)) - bUp).toFixed(1);
  res.dragEnd = +(performance.now() - tUp).toFixed(1);
  await h.page.waitForTimeout(1200);

  // 修改：方向键挪选中的卡（每次一次 mutate：撤销快照 + 不变量 + 自动保存的依赖）
  res.nudge = sum(await steps(h, cdp, 30, async () => { await h.page.keyboard.press("ArrowRight"); }, "nudge"));
  res.boardKB = Math.round(JSON.stringify(board).length / 1024);
  // 再挪 120 次，看撤销栈让堆长了多少（先强制 GC）
  const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); return ((await cdp.send("Runtime.getHeapUsage")) as any).usedSize / 2 ** 20; };
  const h0 = await heap();
  for (let i = 0; i < 120; i++) await h.page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowDown");
  await h.page.waitForTimeout(300);
  res.heapPer100Edits = +(((await heap()) - h0) / 1.2).toFixed(1);
  res.saveAfterNudge = +(await idle(h, cdp, 1500)).toFixed(1);
  res.undo = sum(await steps(h, cdp, 15, async () => { await h.page.keyboard.press("Meta+z"); }, "undo"));
  res.redo = sum(await steps(h, cdp, 15, async () => { await h.page.keyboard.press("Meta+Shift+z"); }, "redo"));
  await h.page.waitForTimeout(1200);

  if (process.argv.includes("--quick")) { await h.page.context().browser()!.close(); return res; }
  // 展开：点第 0 张卡里的调用，等新卡出来
  const ex: number[] = [];
  for (const name of ["schedule", "postprocess"]) {
    await focusCard(h, board.cards[0].id);
    const n0 = await h.page.locator(".card").count();
    const el = h.page.locator(`.card[data-id="${board.cards[0].id}"] .src .call:text-is("${name}")`).first();
    // 按下 → 新卡出现在 DOM 里（页面里量，含宿主回答的往返）
    await profiled(cdp, "expand", async () => {
      await el.click();
      const r = await h.page.waitForFunction((n) => document.querySelectorAll(".card").length > n && performance.now() - (window as any).__tDown, n0);
      ex.push(+(await r.jsonValue()));
    });
    await h.page.waitForTimeout(900);
  }
  res.expand = ex.map((x) => +x.toFixed(1));

  // 版本：宿主推一批「新版本」，再 Update All
  const stale: Record<string, unknown> = {};
  for (const c of board.cards) for (const s of (c as CodeCard).segments ?? []) stale[s.id] = { state: "changed", hiddenOnly: false, head: "f64d821" };
  let t = performance.now();
  await profiled(cdp, "stale", async () => { await h.post({ type: "stale", stale: stale as any }); await raf(h); });
  res.staleMsg = +(performance.now() - t).toFixed(1);
  await h.page.context().browser()!.close();
  return res;
}

async function focusCard(h: Host, id: string) {
  // 宿主的 Reveal on Board：镜头移到这张卡并选中它
  await h.post({ type: "reveal", card: id });
  await h.page.waitForTimeout(1200);
}

void (async () => {
  const all: Record<string, unknown>[] = [];
  for (let i = 0; i < RUNS; i++) { const r = await once(); console.log(JSON.stringify(r)); all.push(r); }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
})();
