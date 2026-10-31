// Usage: node packages/board/test/run-perf.mjs [--cards 240] [--notes 200] (a board of Notes with realistic Markdown: open, pan, zoom, enter edit, type) [--runs 3] [--json out.json] [--quick] [--theme ink-wash] [--light] [--traffic] (City: green light, cars driving) [--profile <step>] [--trace <step>] [--steps <step>] [--long <step>] [--stop pinch] [--inval <step>] [--anim] (--anim: the line and corner stickers are animated GIFs from a sticker pack; --inval counts what invalidated style and layout; --stop pinch: end each run after the camera steps; --long breaks down each dropped frame, LONG_OVER=8.3 each frame over that many ms; --steps prints each step's time, LOD class and camera)
// Each scenario reports wall clock (action → next frame painted), main-thread busy time (CDP TaskDuration) and frame times
// (frameP95 / frameMax / over16 / over8: main-thread task durations; the 60 fps budget is 16.7 ms, 120 fps 8.3 ms).
import * as fs from "node:fs";
import { ready, openBoard, launch, symCard, files, type Host } from "./harness";
import { emptyBoard, skeletonOf, stampBorn, uid, type Board, type BoardCard, type CodeCard, type Link, type Section, type Sidenote, type Skeleton } from "@codeboard/core";
import type { CDPSession } from "playwright-core";
import { faceFrames, gif } from "@codeboard/host/test/images";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NCARDS = +arg("cards", "240"), NNOTES = +arg("notes", "0"), NFRAMES = +arg("frames", "0"), RUNS = +arg("runs", "3"), JSON_OUT = arg("json", ""), PROFILE = arg("profile", ""), THEME = arg("theme", "");

/** A large board: nano-vllm functions (repeated if too few), linked into trees by calls, a Section every 12 cards (two levels nested), some Sidenotes */
export function bigBoard(n: number): Board {
  const b = emptyBoard("perf", `perf · ${n} cards`);
  const defs = [...files.entries()].flatMap(([f, x]) => x.a.symbols.filter((s) => s.kind === "def").map((s) => ({ f, s, calls: x.a.calls.filter((c) => c.line >= s.start && c.line <= s.end && !c.dispatch) })));
  const cards: { c: CodeCard; d: (typeof defs)[number] }[] = [];
  for (let i = 0; cards.length < n; i++) { const d = defs[i % defs.length]; cards.push({ c: symCard(d.f, d.s), d }); }
  // Card 0 is LLMEngine.step with no links, reserved for the expand scenario to click
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
      const L: Link = { id: uid("l"), from: { card: c.id, seg: c.segments[0].id, line: call.line }, to: { card: cards[j].c.id }, call: { name: call.name, col: call.col, ...(call.loop ? { loop: true } : {}) } };
      b.links.push(L);
    }
  });
  // Add arrows without a Call mark until there are about as many as cards
  for (let i = 1; b.links.length < n && i + 7 < cards.length; i += 3) b.links.push({ id: uid("l"), from: { card: cards[i].c.id }, to: { card: cards[i + 7].c.id } });
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
  // Stickers like a studied board has: on a code line every 4th card, in the corner every 6th
  cards.forEach(({ c }, i) => {
    const s = c.segments[0];
    if (i % 4 === 1) b.stickers.push({ id: uid("k"), icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: c.id, seg: s.id, line: s.start + 1 } });
    if (i % 6 === 2) b.stickers.push({ id: uid("k"), icon: { pack: "builtin", name: "flag" }, at: { kind: "card", card: c.id } });
  });
  b.cam = { x: 80, y: 80, z: 1 };
  // Creation order, like every saved or migrated board: without it the first edit numbers all 241 cards at once
  stampBorn(b);
  return b;
}

/**
 * --frames N：把镜头附近的 N 张卡原地换成子白板框（骨架 = 一块 12 张卡的白板），连进来的箭头改连到整个框（去掉行），
 * 连出去的改成从框出。宿主那边的 skeletons 请求由 open 的 on 回答
 */
export function withFrames(b: Board, n: number): Skeleton {
  const child = bigBoard(12);
  child.id = "perf-sub"; child.name = "Sub board";
  const sk = skeletonOf(child);
  const ids = new Set<string>();
  // 第 0 张（LLMEngine.step）留给 expand；从第一、二行里隔着挑
  for (let i = 2; ids.size < n && i < b.cards.length; i += 5) ids.add(b.cards[i].id);
  b.cards = b.cards.map((c) => (ids.has(c.id) ? ({ id: c.id, kind: "board", board: child.id } satisfies BoardCard) : c));
  for (const id of ids) b.place[id] = { ...b.place[id], h: 360 };
  for (const l of b.links) {
    if (ids.has(l.to.card)) l.to = { card: l.to.card };
    if (ids.has(l.from.card)) { l.from = { card: l.from.card }; delete l.call; }
  }
  b.sidenotes = b.sidenotes.filter((s) => !ids.has(s.at.card));
  return sk;
}

/** A board of Notes with the Markdown people write: headings, lists and tasks, code, math, tables, links, quotes */
export function notesBoard(n: number): Board {
  const b = emptyBoard("perf", `perf · ${n} notes`);
  const fns = ["Scheduler.schedule", "BlockManager.allocate", "ModelRunner.run", "LLMEngine.step", "Sequence.append_token", "Sampler.forward"];
  const COLS = 10;
  for (let i = 0; i < n; i++) {
    const f = fns[i % fns.length], k = i % 4;
    const md = [
      `## ${i}. ${f}`, "",
      `prefill 时先调 **${f.split(".")[1]}**，见 [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm) 和 \`seq.block_table\`。复杂度 $O(n^2)$，每步 $b \\cdot t$ 个 token。`, "",
      "- [ ] check `can_allocate(seq)`", "- [x] 按 hash 复用前缀块", "  - 命中就 `ref_count += 1`", "- waiting → running", "",
      ...(k === 0 ? ["```python", `def ${f.split(".")[1]}(self, seq):`, "    # 先找空闲块", "    block = self._allocate_block(self.free_block_ids[0])", "    for i in range(len(seq)):", "        seq.block_table.append(block.block_id)", "    return len(seq) * 2", "```", ""] : []),
      ...(k === 1 ? ["$$", "\\mathrm{softmax}(x)_i = \\frac{e^{x_i}}{\\sum_j e^{x_j}}", "$$", ""] : []),
      ...(k === 2 ? ["| 阶段 | 每步 token | 显存 |", "| --- | --- | --- |", "| prefill | 整个 prompt | 高 |", "| decode | 1 | 低 |", ""] : []),
      ...(k === 3 ? ["> 抢占时把最后一个 running 的序列放回 waiting，释放它的块", "", "1. schedule", "2. run", "3. postprocess", ""] : []),
      `See also the next note, ${fns[(i + 1) % fns.length]}, and the decode path.`,
    ].join("\n");
    const c = { id: `n${i}`, kind: "note", md, look: i % 3 ? "note" : "text" } as Board["cards"][number];
    b.cards.push(c);
    // n10 has a fixed height its Markdown does not fit in: the scrollNote scenario scrolls inside it
    b.place[c.id] = { x: (i % COLS) * 480, y: Math.floor(i / COLS) * 620, w: 420, ...(i === 10 ? { h: 220 } : {}) };
  }
  b.cam = { x: 80, y: 80, z: 1 };
  stampBorn(b);
  return b;
}

type M = { wall: number[]; busy: number; parts?: Record<string, number>; tasks?: number[]; frames?: number[] };
const PARTS = ["ScriptDuration", "RecalcStyleDuration", "LayoutDuration"];
async function metrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
/** Trace marker at the start of each step (console.timeStamp) */
const STEP_MARK = "perf-step";
const raf = (h: Host) => h.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function busy(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
}
/** Run n steps, each one action followed by waiting for it to paint; perStep: also each step's frame (sum's frameP95 is then over the steps) */
async function steps(h: Host, cdp: CDPSession, n: number, step: (i: number) => Promise<void>, name = "", perStep = false): Promise<M> {
  const wall: number[] = [];
  const prof = name && name === PROFILE;
  const tr = name && name === arg("trace", "");
  // Start every scenario from a collected heap: otherwise a major GC owed by earlier work (load, drag, the autosave) lands in
  // whichever scenario happens to cross V8's threshold, and that scenario's work per step jumps by its cost (seen as a 1.5x nudge "regression")
  await cdp.send("HeapProfiler.collectGarbage");
  await raf(h);
  // Always trace: each main-thread task is the work for one frame; a task over 16.7 ms drops a frame
  const events: any[] = [];
  const onData = (e: any) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  const inval = name && name === arg("inval", "");
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline" + (inval ? ",disabled-by-default-devtools.timeline.invalidationTracking" : "") + (name && name === arg("selstats", "") ? ",disabled-by-default-blink.debug" : ""), transferMode: "ReportEvents" } as any);
  if (prof) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  const b0 = await busy(cdp);
  const m0 = await metrics(cdp);
  let bPrev = b0;
  for (let i = 0; i < n; i++) {
    if (perStep) await h.page.evaluate((m) => console.timeStamp(m), STEP_MARK);
    const t = performance.now();
    await step(i);
    await raf(h);
    wall.push(performance.now() - t);
    let bs = "";
    if (name && name === arg("steps", "")) { const bn = await busy(cdp); bs = `busy ${(bn - bPrev).toFixed(0)}`; bPrev = bn; }
    if (name && name === arg("steps", "")) console.log(`  ${name} #${i} ${wall[i].toFixed(0)}ms ${bs}`, await h.page.evaluate(() => `${document.querySelector(".board")?.className} ${(document.querySelector(".world") as HTMLElement)?.style.transform}`));
  }
  const bz = (await busy(cdp)) - b0;
  const m1 = await metrics(cdp);
  const parts = Object.fromEntries(PARTS.map((k) => [k.replace("Duration", ""), +(((m1[k] - m0[k]) * 1000) / n).toFixed(2)]));
  if (prof) { const pr = (await cdp.send("Profiler.stop")).profile as any; if (process.env.PROFILE_OUT) fs.writeFileSync(process.env.PROFILE_OUT, JSON.stringify(pr)); top(pr); }
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end"); await done;
  cdp.off("Tracing.dataCollected", onData);
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const onMain = (e: any) => !!main && e.pid === main.pid && e.tid === main.tid;
  const runTasks = events.filter((e) => e.ph === "X" && e.name === "RunTask" && onMain(e) && e.dur > 1000);
  const tasks = runTasks.map((e) => e.dur / 1000);
  // Each step's frame: its longest main-thread task, from its mark to the next step's
  const marks = events.filter((e) => e.name === "TimeStamp" && e.args?.data?.message === STEP_MARK && onMain(e)).map((e) => e.ts as number).sort((a, b) => a - b);
  const frames = perStep && marks.length === n ? marks.map((ts, i) => Math.max(0, ...runTasks.filter((e) => e.ts >= ts && e.ts < (marks[i + 1] ?? Infinity)).map((e) => e.dur / 1000))) : undefined;
  if (name && name === arg("long", "")) {
    // What each dropped frame spent its time on (events inside the task, >1.5 ms); LONG_OVER=8.3: the frames dropped at 120 fps
    for (const t of events.filter((e) => e.ph === "X" && e.name === "RunTask" && main && e.pid === main.pid && e.tid === main.tid && e.dur > +(process.env.LONG_OVER ?? 16.7) * 1000))
      console.log(`  long ${(t.dur / 1000).toFixed(0)}ms:`, events.filter((e) => e.ph === "X" && e.pid === main.pid && e.tid === main.tid && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e.dur > +(process.env.LONG_MIN ?? 1500) && e.name !== "RunTask")
        .map((e) => `${e.name}${e.args?.data?.functionName ? "(" + e.args.data.functionName + ")" : ""} ${(e.dur / 1000).toFixed(1)}`).join(" > "));
  }
  if (name && name === arg("selstats", "")) {
    // CSS selector stats (DevTools "Enable CSS selector stats"): the selectors that cost the most in this step
    const by = new Map<string, { t: number; att: number; m: number }>();
    for (const e of events) for (const x of e.args?.selector_stats?.selector_timings ?? []) {
      const o = by.get(x.selector) ?? { t: 0, att: 0, m: 0 };
      o.t += x.elapsed ?? x["elapsed (us)"] ?? 0; o.att += x.match_attempts; o.m += x.match_count; by.set(x.selector, o);
    }
    const tot = [...by.values()].reduce((s, o) => s + o.t, 0);
    console.log(`-- selector stats: ${by.size} selectors, ${(tot / 1000).toFixed(0)} ms`);
    for (const [k, o] of [...by].sort((a, b) => b[1].t - a[1].t).slice(0, 50)) console.log(`${(o.t / 1000).toFixed(1).padStart(7)}ms ${String(o.att).padStart(8)} ${String(o.m).padStart(7)}  ${k.slice(0, 140)}`);
  }
  if (inval) {
    // What invalidated style / layout: count by event, reason and node (--inval <step>)
    const by = new Map<string, number>();
    for (const e of events) if (e.name.includes("Invalidat") && e.args?.data) {
      const d = e.args.data;
      const k = `${e.name.replace("InvalidationTracking", "")} ${d.reason ?? d.invalidationList?.[0]?.classes?.join(".") ?? ""} ${d.nodeName ?? ""}`;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    console.log("-- invalidations");
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`${String(v).padStart(8)}  ${k}`);
  }
  if (tr) {
    const by = new Map<string, number>();
    for (const e of events) if (e.ph === "X" && e.dur && (!main || (e.pid === main.pid && e.tid === main.tid))) by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
    console.log("-- trace (main thread, inclusive ms)");
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(0).padStart(8)}  ${k}`);
  }
  return { wall, busy: bz, parts, tasks, frames };
}
/** Profile results: top 30 functions by self time and total time */
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
/**
 * Frames: main-thread task durations (>1 ms); frameMax over 16.7 means a dropped frame, over16 counts such tasks (over8: over 8.3 ms, a dropped frame at 120 fps). frameP95 is the 95th
 * percentile of all the tasks, or after steps(..., perStep) (frameOf "step") of each step's frame, its longest task: for steps that wait, where
 * the waits' own frames outnumber the steps' (hover: 12 steps that wait 250–500 ms each for the cross-fades, ~125 tasks of which the
 * 6 lifts are 5%, so p95 fell on either side of them by how many fade frames the runner drew: 12.7 → 19.6 ms, same code)
 */
const sum = (m: M) => ({ median: +med(m.wall).toFixed(1), p95: +p95(m.wall).toFixed(1), busyPerStep: +(m.busy / m.wall.length).toFixed(2), ...m.parts,
  ...(m.frames ? { frameOf: "step" } : {}),
  frameP95: +p95(m.frames ?? (m.tasks?.length ? m.tasks : [0])).toFixed(1), frameMax: +Math.max(0, ...(m.tasks ?? [])).toFixed(1), over16: (m.tasks ?? []).filter((t) => t > 16.7).length,
  over8: (m.tasks ?? []).filter((t) => t > 8.3).length });

async function profiled<T>(cdp: CDPSession, name: string, fn: () => Promise<T>): Promise<T> {
  if (name !== PROFILE) return fn();
  await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start");
  const r = await fn();
  const pr = (await cdp.send("Profiler.stop")).profile as any;
  if (process.env.PROFILE_OUT) fs.writeFileSync(process.env.PROFILE_OUT, JSON.stringify(pr));
  top(pr);
  return r;
}
async function idle(h: Host, cdp: CDPSession, ms: number) { const b0 = await busy(cdp); await h.page.waitForTimeout(ms); return (await busy(cdp)) - b0; }

async function once() {
  await ready();
  const board = NNOTES ? notesBoard(NNOTES) : bigBoard(NCARDS);
  const sk = NFRAMES ? withFrames(board, NFRAMES) : null;
  // A sticker bound to the hub card (the card the drag scenario grabs), for the stickerDrag scenario
  const STK = "kperf";
  if (!NNOTES) board.stickers.push({ id: STK, icon: { pack: "builtin", name: "zap" }, at: { kind: "canvas", x: 24, y: -48, size: 32, on: { card: hubOf(board) } } });
  // --anim: every star / flag sticker becomes an animated 64px GIF (2 frames, 200 ms), like a pack of downloaded animated emoji
  const ANIM = process.argv.includes("--anim");
  const pack = ANIM ? [{ id: "perf", name: "perf", icons: [{ name: "wink", anim: true, img: `data:image/gif;base64,${gif(64, 64, [[0, 0, 0], [236, 120, 160], [60, 40, 30]], faceFrames(64, [236, 120, 160, 255]).map((f) => (x: number, y: number) => { const c = f(x, y); return c[3] === 0 ? 0 : c[0] === 60 ? 2 : 1; }), 200, 0).toString("base64")}` }] }] : [];
  if (ANIM) for (const k of board.stickers) if (k.icon.pack === "builtin" && k.id !== STK) k.icon = { pack: "perf", name: "wink" };
  const res: Record<string, unknown> = { cards: board.cards.length, links: board.links.length, sections: board.sections.length, sidenotes: board.sidenotes.length, ...(ANIM ? { animStickers: board.stickers.filter((k) => k.icon.pack === "perf").length } : {}), ...(sk ? { frames: NFRAMES } : {}) };
  const t0 = performance.now();
  let cdp!: CDPSession;
  const h = await openBoard(await launch(), { until: "shown", board, light: process.argv.includes("--light"), settings: THEME ? { theme: THEME } as any : undefined, on: (m, reply) => (sk && m.type === "skeletons" ? (void reply(m.req!, Object.fromEntries(m.ids.map((id) => [id, sk]))), true) : ANIM && m.type === "stickerPacks" ? (void reply(m.req!, pack), true) : false), beforeLoad: async (page) => {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    if (PROFILE === "load") { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  } });
  // Load: init received → all cards painted (measured in the page)
  const ld = await h.page.waitForFunction((n) => document.querySelectorAll(".card").length >= n && performance.now() - (window as any).__tInit, board.cards.length, { timeout: 60000 });
  res.load = +(+(await ld.jsonValue())).toFixed(0);
  res.openTotal = +(performance.now() - t0).toFixed(0);
  if (PROFILE === "load") top((await cdp.send("Profiler.stop")).profile as any);
  if (arg("css", "")) await h.page.addStyleTag({ content: arg("css", "") });
  if (process.argv.includes("--traffic")) { await h.page.locator(".dock .traffic").click(); res.movers = await h.page.locator(".movers .mover").count(); }
  await h.page.waitForTimeout(1500);
  if (arg("shot", "")) {
    const still = () => h.page.waitForFunction(() => !document.querySelector(".world")?.matches(".moving, .settle"), null, { timeout: 30000 });
    for (const z of [1, 2.5]) { await h.post({ type: "reveal", card: board.links[0].to.card }); await h.page.waitForTimeout(1000); await still(); if (z > 1) { await h.page.keyboard.down("Control"); for (let i = 0; i < 12; i++) await h.page.mouse.wheel(0, -40); await h.page.keyboard.up("Control"); await h.page.waitForTimeout(800); await still(); } await h.page.screenshot({ path: `${arg("shot", "")}-${z}.png` }); }
    // After a wheel pan across two rows of cards that were hidden off screen (state/cull.ts), at rest
    await h.post({ type: "reveal", card: board.links[0].to.card }); await h.page.waitForTimeout(1000); await still();
    await h.page.mouse.move(700, 450);
    for (let i = 0; i < 35; i++) { await h.page.mouse.wheel(i % 3 ? 0 : 60, 40); await h.page.waitForTimeout(16); }
    await h.page.waitForTimeout(1500); await h.page.mouse.move(5, 5); await h.page.waitForTimeout(500); await still();
    await h.page.screenshot({ path: `${arg("shot", "")}-pan.png` });
    await h.page.context().browser()!.close(); return res;
  }
  if (arg("stop", "") === "lod") {
    const sstats = process.argv.includes("--selstats");
    const evs: any[] = [];
    if (sstats) { cdp.on("Tracing.dataCollected", (e: any) => evs.push(...e.value)); await cdp.send("Tracing.start", { categories: "disabled-by-default-blink.debug", transferMode: "ReportEvents" } as any); }
    // Style + layout cost of switching every card's LOD class at once (no script): full → overview → map → full, 5 rounds
    if (process.argv.includes("--nohue")) await h.page.evaluate(() => { (window as any).__nohue = true; });
    res.lodSwitch = await h.page.evaluate(async (strip) => {
      if (strip) {
        const re = new RegExp(strip);
        let n = 0;
        for (const sh of [...document.styleSheets]) { const walk = (list: CSSRuleList, del: (i: number) => void) => { for (let i = list.length - 1; i >= 0; i--) { const r = list[i] as any; if (r.selectorText && re.test(r.selectorText)) { del(i); n++; } else if (r.cssRules) walk(r.cssRules, (j) => r.deleteRule(j)); } }; walk(sh.cssRules, (i) => sh.deleteRule(i)); }
        console.log("stripped", n);
      }
      const cards = [...document.querySelectorAll(".card")] as HTMLElement[];
      if ((window as any).__nohue) for (const c of cards) c.style.removeProperty("--file-hue");
      const set = (ov: boolean, map: boolean) => { for (const c of cards) { c.classList.toggle("lo-ov", ov); c.classList.toggle("lo-map", map); } };
      const out: Record<string, number[]> = { ov: [], map: [], full: [] };
      for (let k = 0; k < 7; k++) for (const [n, ov, map] of [["ov", true, false], ["map", false, true], ["full", false, false]] as const) {
        await new Promise((r) => requestAnimationFrame(() => r(0)));
        const t = performance.now(); set(ov, map); document.body.getBoundingClientRect(); (document.querySelector(".world") as HTMLElement).offsetHeight; out[n].push(performance.now() - t);
      }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +med(v.slice(1)).toFixed(1)]));
    }, arg("strip", ""));
    if (sstats) {
      // Selector stats (DevTools "Enable CSS selector stats"): which selectors cost the most during the LOD switches
      const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
      await cdp.send("Tracing.end"); await done;
      const by = new Map<string, { t: number; att: number; m: number }>();
      for (const e of evs) for (const x of e.args?.selector_stats?.selector_timings ?? []) {
        const k = x.selector, o = by.get(k) ?? { t: 0, att: 0, m: 0 };
        o.t += x.elapsed ?? x["elapsed (us)"] ?? 0; o.att += x.match_attempts; o.m += x.match_count; by.set(k, o);
      }
      const tot = [...by.values()].reduce((s, o) => s + o.t, 0);
      console.log(`-- selector stats: ${by.size} selectors, ${(tot / 1000).toFixed(0)} ms`);
      for (const [k, o] of [...by].sort((a, b) => b[1].t - a[1].t).filter(([k, o]) => o.att > 50000 || by.size < 0).slice(0, 200)) console.log(`${(o.t / 1000).toFixed(1).padStart(7)}ms ${String(o.att).padStart(8)} ${String(o.m).padStart(7)}  ${k.slice(0, 140)}`);
    }
    await h.page.context().browser()!.close(); return res;
  }
  if (arg("stop", "") === "dom") {
    res.dom = await h.page.evaluate(() => { const by: Record<string, number> = {}; for (const e of document.querySelectorAll(".world *")) { const k = e.tagName + "." + (typeof e.className === "string" ? e.className.split(" ")[0] : ""); by[k] = (by[k] ?? 0) + 1; } return { total: document.querySelectorAll("*").length, top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 45) }; });
    await h.page.context().browser()!.close(); return res;
  }
  if (arg("stop", "") === "switch") {
    // Cross LOD thresholds in one wheel step and wait until every card has switched and the camera has stopped: full ↔ overview, full ↔ map
    const spot = await h.page.evaluate(() => { for (let y = 120; y < 860; y += 20) for (let x = 80; x < 1350; x += 20) { const e = document.elementFromPoint(x, y); if (e && (e.classList.contains("board") || e.classList.contains("world"))) return [x, y]; } return [700, 450]; });
    await h.page.mouse.move(spot[0], spot[1]);
    const wheel = async (d: number) => { await h.page.keyboard.down("Control"); await h.page.mouse.wheel(0, d); await h.page.keyboard.up("Control"); };
    for (const [lvl, d] of [["Ov", 90], ["Map", 150]] as const) {
      res["switch" + lvl] = sum(await steps(h, cdp, 6, async (i) => { await wheel(i % 2 ? -d : d); await h.page.waitForTimeout(1500); }, "switch" + lvl));
    }
    await h.page.context().browser()!.close(); return res;
  }
  if (arg("stop", "") === "collapse") {
    // Collapse and expand the Section of the row in view (12 cards: its inner Section and 6 direct members), from the toolbar caret
    const b = h.board(), row = b.sections.find((x) => !x.parent && b.sections.some((y) => y.parent === x.id))!;
    await h.post({ type: "reveal", card: Object.entries(b.place).find(([, p]) => p.section === row.id)![0] });
    await h.page.waitForTimeout(1200);
    const chev = h.page.locator(`.slabel[data-sect="${row.id}"] .chev2`);
    res.collapse = sum(await steps(h, cdp, 6, async () => { await chev.evaluate((e) => (e as HTMLElement).click()); await h.page.waitForTimeout(900); }, "collapse"));
    await h.page.context().browser()!.close(); return res;
  }
  if (arg("stop", "") === "settle") {
    // One small zoom step, then wait until the camera has stopped and the world is redrawn at the new scale: what one stop costs, per LOD level
    const spot = await h.page.evaluate(() => { for (let y = 120; y < 860; y += 20) for (let x = 80; x < 1350; x += 20) { const e = document.elementFromPoint(x, y); if (e && (e.classList.contains("board") || e.classList.contains("world"))) return [x, y]; } return [700, 450]; });
    await h.page.mouse.move(spot[0], spot[1]);
    const wheel = async (d: number) => { await h.page.keyboard.down("Control"); await h.page.mouse.wheel(0, d); await h.page.keyboard.up("Control"); };
    for (const [lvl, n] of [["Full", 0], ["Ov", 3], ["Map", 2]] as const) {
      for (let i = 0; i < n; i++) { await wheel(30); await h.page.waitForTimeout(150); }
      await h.page.waitForTimeout(1500);
      res["settle" + lvl] = sum(await steps(h, cdp, 12, async (i) => { await wheel(i % 2 ? 4 : -4); await h.page.waitForTimeout(500); }, "settle" + lvl));
    }
    await h.page.context().browser()!.close(); return res;
  }
  res.idleBusy1s = +(await idle(h, cdp, 1000)).toFixed(1);

  // Pan the canvas (gesture starts over empty canvas, so the board pans instead of a card scrolling); the first pan after opening
  const spot = await h.page.evaluate(() => { for (let y = 120; y < 860; y += 20) for (let x = 80; x < 1350; x += 20) { const e = document.elementFromPoint(x, y); if (e && (e.classList.contains("board") || e.classList.contains("world"))) return [x, y]; } return [700, 450]; });
  await h.page.mouse.move(spot[0], spot[1]);
  res.panCanvas = sum(await steps(h, cdp, 30, async (i) => { await h.page.mouse.wheel(i % 2 ? 25 : -25, 0); }, "panCanvas"));
  await h.page.waitForTimeout(600);

  await h.page.mouse.move(700, 450);
  res.pan = sum(await steps(h, cdp, 60, async () => { await h.page.mouse.wheel(0, 40); }, "pan"));
  res.zoom = sum(await steps(h, cdp, 40, async (i) => { await h.page.keyboard.down("Control"); await h.page.mouse.wheel(0, i < 20 ? 30 : -30); await h.page.keyboard.up("Control"); }, "zoom"));
  // Trackpad pinch: many small steps from 100% down to the map level and back (passes every level and every switch)
  res.pinch = sum(await steps(h, cdp, 100, async (i) => { await h.page.keyboard.down("Control"); await h.page.mouse.wheel(0, i < 50 ? 5 : -5); await h.page.keyboard.up("Control"); }, "pinch"));
  await h.page.waitForTimeout(800);
  // Scroll inside a card: the wheel over a selected card's long body scrolls the body itself (the card owns the gesture), down then up
  // (the code card whose code overflows its body the most: the longest function, capped at CODE_MAX)
  const scrolled = NNOTES ? "n10" : await h.page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card.ccard")].map((c) => { const b = c.querySelector<HTMLElement>(".cbody"); return { id: c.dataset.id!, over: b ? b.scrollHeight - b.clientHeight : 0 }; }).sort((a, b) => b.over - a.over)[0]?.id);
  if (scrolled) res[NNOTES ? "scrollNote" : "scrollCode"] = await scrollIn(h, cdp, scrolled, NNOTES ? ".nbody" : ".cbody", NNOTES ? "scrollNote" : "scrollCode");
  if (arg("stop", "") === "pinch") { await h.page.context().browser()!.close(); return res; }
  if (NNOTES) { await notesEdit(h, cdp, board, res); await h.page.context().browser()!.close(); return res; }

  // Drag: the card with the most links (endpoints follow every frame)
  const hub = hubOf(board);
  res.hubLinks = board.links.filter((L) => L.from.card === hub || L.to.card === hub).length;
  await focusCard(h, hub);
  // Grab the header at a point that really is the header: arrows are drawn above the cards, and a long arrow between two other
  // cards of the same row runs along the heading row (card ends attach there), so the kind glyph can be under its hit area (City).
  // Take the glyph when it is free, so drag numbers stay comparable with earlier runs; otherwise scan the header for a draggable
  // point that is not a button and not covered
  const bx = await h.page.evaluate((id) => {
    const free = (x: number, y: number) => {
      const e = document.elementFromPoint(x, y);
      return e?.closest(".card")?.getAttribute("data-id") === id && !!e.closest("[data-drag]") && !e.closest("button, .step, [contenteditable]");
    };
    const k = document.querySelector(`.card[data-id="${id}"] .chead .kind`)?.getBoundingClientRect();
    if (k && free(k.left + 4, k.top + 4)) return { x: k.left, y: k.top, at: "kind" };
    const head = document.querySelector(`.card[data-id="${id}"] [data-drag]`)!.getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7]) for (let x = head.left + 6; x < head.right - 6; x += 6) {
      const y = head.top + head.height * fy;
      if (free(x, y)) return { x: x - 4, y: y - 4, at: `${(document.elementFromPoint(x, y) as Element).tagName}` };
    }
    throw new Error("no free spot on the header to grab");
  }, hub);
  if (process.argv.includes("--steps")) console.log("  drag grab", JSON.stringify(bx));
  const hubX = () => h.page.evaluate((id) => parseFloat((document.querySelector(`.card[data-id="${id}"]`) as HTMLElement).style.left), hub);
  const x0 = await hubX();
  await h.page.mouse.move(bx.x + 4, bx.y + 4);
  await h.page.mouse.down();
  res.drag = sum(await steps(h, cdp, 60, async (i) => { await h.page.mouse.move(bx.x + 4 + i * 4, bx.y + 4 + i * 2, { steps: 1 }); }, "drag"));
  const tUp = performance.now();
  const bUp = await busy(cdp);
  await profiled(cdp, "dragEnd", async () => { await h.page.mouse.up(); await raf(h); });
  res.dragEndBusy = +((await busy(cdp)) - bUp).toFixed(1);
  res.dragEnd = +(performance.now() - tUp).toFixed(1);
  // The drag must have moved the card (60 steps × 4 px on screen), or drag / nudge / undo numbers measure nothing
  res.dragMoved = Math.round((await hubX()) - x0);
  if (!((res.dragMoved as number) > 20)) {
    const hit = await h.page.evaluate(([x, y]) => { const out: string[] = []; for (let e = document.elementFromPoint(x, y); e; e = e.parentElement) out.push(`${e.tagName}.${typeof e.className === "string" ? e.className : ""}`); const g = document.elementFromPoint(x, y)?.closest("g.link") as SVGGElement | null; return out.slice(0, 6).join(" < ") + (g ? ` link ${g.dataset.from}→${g.dataset.to} sides ${g.dataset.sides} ${g.querySelector(".edge")?.getAttribute("d")}` : ""); }, [bx.x + 4, bx.y + 4]);
    throw new Error(`drag did not move the card ${hub} (moved ${res.dragMoved}px; grabbed ${JSON.stringify(bx)} → ${hit}; card ${JSON.stringify(board.place[hub])})`);
  }
  await h.page.waitForTimeout(1200);

  // Hover the hub card and leave it: all its arrows lift above the cards and drop back, with a cross-fade each way
  const on = await h.page.evaluate((id) => { const r = document.querySelector(`.card[data-id="${id}"] [data-drag]`)!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, hub);
  const off = await h.page.evaluate(() => {
    for (let y = 20; y < innerHeight - 60; y += 20) for (let x = 20; x < innerWidth - 20; x += 20) { const e = document.elementFromPoint(x, y); if (e?.closest(".world, .board") && !e.closest(".card, [data-link], .lw, .stk")) return { x, y }; }
    return null;
  });
  if (off) {
    await h.page.mouse.move(off.x, off.y); await h.page.waitForTimeout(500);
    res.hover = sum(await steps(h, cdp, 12, async (i) => {
      if (i % 2) await h.page.mouse.move(off.x, off.y); else await h.page.mouse.move(on.x, on.y);
      await h.page.waitForTimeout(i % 2 ? 500 : 250);
    }, "hover", true));
  }

  // Sticker drag: the sticker bound to the hub, dragged across the cards around it (every card checks whether it lights up)
  const sb = await h.page.evaluate((id) => { const r = document.querySelector(`[data-sticker="${id}"]`)?.getBoundingClientRect(); return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, STK);
  if (sb) {
    await h.page.mouse.move(sb.x, sb.y);
    await h.page.mouse.down();
    res.stickerDrag = sum(await steps(h, cdp, 60, async (i) => { await h.page.mouse.move(sb.x + 4 + i * 6, sb.y + 4 + i * 3, { steps: 1 }); }, "stickerDrag"));
    await h.page.mouse.up();
    await h.page.keyboard.press("Meta+z");
    await h.page.waitForTimeout(600);
    await focusCard(h, hub);
  }

  // Mutate: move the selected card with arrow keys (one mutate each: undo snapshot + invariants + autosave dependencies)
  res.nudge = sum(await steps(h, cdp, 30, async () => { await h.page.keyboard.press("ArrowRight"); }, "nudge"));
  res.boardKB = Math.round(JSON.stringify(board).length / 1024);
  // Move 120 more times to see how much the undo stack grows the heap (force GC first)
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
  // Expand: click a call in card 0 and wait for the new card
  const ex: number[] = [];
  for (const name of ["schedule", "postprocess"]) {
    await focusCard(h, board.cards[0].id);
    const n0 = await h.page.locator(".card").count();
    const el = h.page.locator(`.card[data-id="${board.cards[0].id}"] .src .call:text-is("${name}")`).first();
    // Press → new card appears in the DOM (measured in the page, includes the host round trip)
    await profiled(cdp, "expand", async () => {
      await el.click();
      const r = await h.page.waitForFunction((n) => document.querySelectorAll(".card").length > n && performance.now() - (window as any).__tDown, n0);
      ex.push(+(await r.jsonValue()));
    });
    await h.page.waitForTimeout(900);
  }
  res.expand = ex.map((x) => +x.toFixed(1));

  // Versions: host pushes a batch of "new versions", then Update All
  const stale: Record<string, unknown> = {};
  for (const c of board.cards) for (const s of (c as CodeCard).segments ?? []) stale[s.id] = { state: "changed", hiddenOnly: false, head: "f64d821" };
  let t = performance.now();
  await profiled(cdp, "stale", async () => { await h.post({ type: "stale", stale: stale as any }); await raf(h); });
  res.staleMsg = +(performance.now() - t).toFixed(1);
  await h.page.context().browser()!.close();
  return res;
}

/** Wheel over the scrolling body of card id (selected first, so the gesture is the card's): 30 steps down, then 30 up, each a 30th of
 *  how far it scrolls (at most 30 px). Throws when it did not scroll */
async function scrollIn(h: Host, cdp: CDPSession, id: string, body: string, name: string) {
  await focusCard(h, id);
  // A point that really is the body: Sidenotes, stickers and arrows can lie over parts of it
  const at = await h.page.evaluate(([id, body]) => {
    const b = document.querySelector<HTMLElement>(`.card[data-id="${id}"] ${body}`)!, r = b.getBoundingClientRect();
    for (let y = r.top + 40; y < Math.min(r.bottom, innerHeight) - 20; y += 20) for (let x = r.left + 40; x < r.right - 40; x += 40) if (document.elementFromPoint(x, y)?.closest(body) === b) return { x, y };
    return null;
  }, [id, body] as const);
  if (!at) throw new Error(`${name}: no free point over ${body} of ${id}`);
  await h.page.mouse.move(at.x, at.y);
  const top = () => h.page.evaluate(([id, body]) => document.querySelector(`.card[data-id="${id}"] ${body}`)!.scrollTop, [id, body] as const);
  const over = await h.page.evaluate(([id, body]) => { const b = document.querySelector(`.card[data-id="${id}"] ${body}`)!; return b.scrollHeight - b.clientHeight; }, [id, body] as const);
  const d = Math.max(4, Math.min(30, Math.floor(over / 30)));
  const t0 = await top();
  let far = 0;
  const m = sum(await steps(h, cdp, 60, async (i) => { await h.page.mouse.wheel(0, i < 30 ? d : -d); if (i === 29) far = await top(); }, name));
  if (!(far - t0 > Math.min(100, over / 2))) throw new Error(`${name}: the body of ${id} did not scroll (scrollTop ${t0} → ${far} of ${over})`);
  return { ...m, scrolledPx: far - t0 };
}

/** Notes board: double-click a Note → its editor has focus (10 different Notes, the first one includes loading the editor if it was not preloaded),
 * then type 80 characters one key at a time, then Esc (save and leave) */
async function notesEdit(h: Host, cdp: CDPSession, board: Board, res: Record<string, unknown>) {
  const ids = board.cards.slice(0, 10).map((c) => c.id);
  const center = (id: string) => h.page.evaluate((id) => { const r = document.querySelector(`.card[data-id="${id}"] .nbody, .card[data-id="${id}"] .tx`)!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 60) }; }, id);
  const editingIn = (id: string) => h.page.waitForFunction((id) => { const a = document.activeElement as HTMLElement | null; return !!a?.isContentEditable && !!a.closest(`.card[data-id="${id}"]`); }, id, { timeout: 10000 });
  // Double-click → focused editor, then the next frame (camera moves between Notes are not timed).
  // In the page: last pointerdown → focus lands in the editor (enterJs: the work done in that task), → the frame after it is painted (enterPaint)
  await h.page.evaluate(() => {
    const w = window as any;
    w.__enter = [];
    addEventListener("pointerdown", () => { w.__tDown2 = performance.now(); }, true);
    addEventListener("focusin", (e) => {
      if (!(e.target as HTMLElement).isContentEditable) return;
      const t0 = w.__tDown2, js = performance.now() - t0;
      requestAnimationFrame(() => setTimeout(() => w.__enter.push([js, performance.now() - t0])));
    }, true);
  });
  const enter: number[] = [];
  await profiled(cdp, "editEnter", async () => { for (let i = 0; i < ids.length; i++) {
    if (i) { await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300); }
    await focusCard(h, ids[i]);
    const pt = await center(ids[i]);
    // 真实用户先移到 Note 上再双击；--hover 0 关闭
    const hov = +arg("hover", "300");
    if (hov) { await h.page.mouse.move(pt.x, pt.y); await h.page.waitForTimeout(hov); }
    const t = performance.now();
    const tr = arg("long", "") === "editEnter" ? await traceStart(cdp) : null;
    await h.page.mouse.dblclick(pt.x, pt.y);
    await editingIn(ids[i]);
    await raf(h);
    enter.push(+(performance.now() - t).toFixed(1));
    if (tr) await tr();
  } });
  res.editEnter = { first: enter[0], median: +med(enter).toFixed(1), p95: +p95(enter).toFixed(1) };
  const inPage = (await h.page.evaluate(() => (window as any).__enter)) as [number, number][];
  const js = inPage.map((x) => x[0]), paint = inPage.map((x) => x[1]);
  res.editEnterJs = { first: +js[0].toFixed(1), median: +med(js).toFixed(1), p95: +p95(js).toFixed(1) };
  res.editEnterPaint = { first: +paint[0].toFixed(1), median: +med(paint).toFixed(1), p95: +p95(paint).toFixed(1) };
  await h.page.keyboard.press("ControlOrMeta+End");
  await h.page.keyboard.press("Enter");
  const text = "Prefill admits waiting seqs until the token budget runs out, then decode. ";
  res.type = sum(await steps(h, cdp, 80, async (i) => { await h.page.keyboard.type(text[i % text.length]); }, "type"));
  const tx = arg("long", "") === "editExit" ? await traceStart(cdp) : null;
  const t = performance.now();
  await profiled(cdp, "editExit", async () => {
    await h.page.keyboard.press("Escape");
    await h.page.waitForFunction(() => !(document.activeElement as HTMLElement | null)?.isContentEditable);
  });
  await raf(h);
  res.editExit = +(performance.now() - t).toFixed(1);
  if (tx) await tx();
  await h.page.waitForTimeout(1500);
  res.typed = (h.board().cards.find((c) => c.id === ids[ids.length - 1]) as { md: string }).md.includes("Prefill admits waiting");
}

/** --long editEnter / editExit: what each main-thread task over 4 ms spent its time on (events inside it over 0.8 ms) */
async function traceStart(cdp: CDPSession) {
  const events: any[] = [];
  const onData = (e: any) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack", transferMode: "ReportEvents" } as any);
  return async () => {
    const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
    await cdp.send("Tracing.end"); await done;
    cdp.off("Tracing.dataCollected", onData);
    const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
    const on = (e: any) => main && e.pid === main.pid && e.tid === main.tid;
    for (const t of events.filter((e) => e.ph === "X" && e.name === "RunTask" && on(e) && e.dur > 4000))
      console.log(`  task ${(t.dur / 1000).toFixed(1)}ms:`, events.filter((e) => e.ph === "X" && on(e) && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e.dur > 800 && e.name !== "RunTask")
        .map((e) => `${e.name}${e.args?.data?.functionName ? "(" + e.args.data.functionName + ")" : e.args?.data?.type ? "(" + e.args.data.type + ")" : ""} ${(e.dur / 1000).toFixed(1)}`).join(" > "));
    if (process.env.LAYOUT_STACKS) for (const e of events.filter((e) => on(e) && (e.name === "Layout" || e.name === "UpdateLayoutTree") && e.dur > 800 && (e.args?.beginData?.stackTrace || e.args?.data?.stackTrace)))
      console.log(`  forced ${e.name} ${(e.dur / 1000).toFixed(1)}`, e.name === "Layout" ? `objs ${e.args?.beginData?.dirtyObjects}/${e.args?.beginData?.totalObjects} root depth ${JSON.stringify(e.args?.endData?.layoutRoots?.map((r: any) => r.depth))}` : `els ${e.args?.elementCount ?? ""}`, ":", (e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace).slice(0, 6).map((f: any) => `${f.functionName}@${f.lineNumber}`).join(" < "));
    console.log("  --");
  };
}

function hubOf(b: Board): string {
  const deg = new Map<string, number>();
  for (const L of b.links) for (const id of [L.from.card, L.to.card]) deg.set(id, (deg.get(id) ?? 0) + 1);
  return [...deg.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

async function focusCard(h: Host, id: string) {
  // Host Reveal on Board: camera moves to the card and selects it
  await h.post({ type: "reveal", card: id });
  await h.page.waitForTimeout(1200);
  // The flight can take longer than that: the camera spring steps at most 32 ms per frame, and frames at this zoom take 70–90 ms
  // on the runner, so it flies 2–3x slower than its own time. Measuring while it still moves measures the flight too, from
  // wherever it happened to be (the drag then grabbed a card half off screen: drag work 21 → 39 ms with nothing else changed)
  await h.page.waitForFunction(() => !document.querySelector(".world")?.classList.contains("moving"), null, { timeout: 30000 });
  await raf(h);
}

void (async () => {
  const all: Record<string, unknown>[] = [];
  for (let i = 0; i < RUNS; i++) { const r = await once(); console.log(JSON.stringify(r)); all.push(r); }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
})();
