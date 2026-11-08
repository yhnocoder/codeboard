// Usage: node packages/board/test/run-perf.mjs [--cards 240] [--notes 200] (a board of Notes with realistic Markdown: open, pan, zoom, enter edit, type) [--runs 3] [--json out.json] [--quick] [--theme ink-wash] [--light] [--traffic] (City: green light, cars driving) [--profile <step>] [--trace <step>] [--steps <step>] [--long <step>] [--stop pinch] [--inval <step>] [--anim] [--persona] [--scale 2] (--persona: a board like a real study board, Chinese Notes dense with math and Image cards of big screenshots, a Section with one inside it, through the real host: load, pan, zoom, pinch, zoomOutIn, dragImage / dragNote / dragCode; --anim: the line and corner stickers are animated GIFs from a sticker pack; --inval counts what invalidated style and layout; --stop pinch: end each run after the camera steps; --long breaks down each dropped frame, LONG_OVER=8.3 each frame over that many ms; --steps prints each step's time, the board's classes and camera, and the raster passes step by step) [--raster] (only the raster probes: rasterProbes) [--passes drag,dragSnap,dragSection,pan,nearCut,zoom,stops,cut,fit,zoomedOut,inOutIn] (dragSnap, dragSection: persona only) [--no-raster] (RASTER_OUT=<dir>: each raster pass's trace and a screenshot)
// Each scenario reports wall clock (action → next frame painted), main-thread busy time (CDP TaskDuration) and frame times
// (frameP95 / frameMax / over16 / over8: main-thread task durations, frameMedian for steps that wait; the 60 fps budget is 16.7 ms, 120 fps 8.3 ms).
import * as fs from "node:fs";
import { ready, openBoard, launch, symCard, files, REPO, type Host } from "./harness";
import {
  cornerAt,
  emptyBoard,
  THUMB_WIDTHS,
  skeletonOf,
  stampBorn,
  uid,
  type Board,
  type BoardCard,
  type CodeCard,
  type Link,
  type Section,
  type Sidenote,
  type Skeleton,
} from "@codeboard/core";
import type { CDPSession } from "playwright-core";
import { faceFrames, gif, png } from "@codeboard/host/testing";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { realHost } from "./realhost";
import {
  imageHits,
  layerScales,
  median as medianOf,
  pageMeasure,
  rasterChecks,
  rasterWindows,
  scaleHits,
  snapshotsOf,
  tileMemory,
  type RasterResult,
  type TraceEvent,
} from "./probes";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const NCARDS = +arg("cards", "240"),
  NNOTES = +arg("notes", "0"),
  NFRAMES = +arg("frames", "0"),
  RUNS = +arg("runs", "3"),
  JSON_OUT = arg("json", ""),
  PROFILE = arg("profile", ""),
  THEME = arg("theme", ""),
  RASTER_ONLY = process.argv.includes("--raster");

/** A large board: nano-vllm functions (repeated if too few), linked into trees by calls, a Section every 12 cards (two levels nested), some Sidenotes */
export function bigBoard(n: number): Board {
  const b = emptyBoard("perf", `perf · ${n} cards`);
  const defs = [...files.entries()].flatMap(([f, x]) =>
    x.a.symbols
      .filter((s) => s.kind === "def")
      .map((s) => ({ f, s, calls: x.a.calls.filter((c) => c.line >= s.start && c.line <= s.end && !c.dispatch) })),
  );
  const cards: { c: CodeCard; d: (typeof defs)[number] }[] = [];
  for (let i = 0; cards.length < n; i++) {
    const d = defs[i % defs.length];
    cards.push({ c: symCard(d.f, d.s), d });
  }
  // Card 0 is LLMEngine.step with no links, reserved for the expand scenario to click
  const step = defs.find((d) => d.s.qual === "LLMEngine.step")!;
  cards.unshift({ c: symCard(step.f, step.s), d: { ...step, calls: [] } });
  const COLS = 12;
  cards.forEach(({ c }, i) => {
    b.cards.push(c);
    b.place[c.id] = { x: (i % COLS) * 620, y: Math.floor(i / COLS) * 700, w: 560 };
  });
  const hasIn = new Set<string>();
  cards.forEach(({ c, d }, i) => {
    for (const call of d.calls) {
      const j = cards.findIndex((t, k) => k > i && !hasIn.has(t.c.id) && t.d.s.name === call.name);
      if (j < 0) continue;
      hasIn.add(cards[j].c.id);
      const L: Link = {
        id: uid("l"),
        from: { card: c.id, seg: c.segments[0].id, line: call.line },
        to: { card: cards[j].c.id },
        call: { name: call.name, col: call.col, ...(call.loop ? { loop: true } : {}) },
      };
      b.links.push(L);
    }
  });
  // Add arrows without a Call mark until there are about as many as cards
  for (let i = 1; b.links.length < n && i + 7 < cards.length; i += 3)
    b.links.push({ id: uid("l"), from: { card: cards[i].c.id }, to: { card: cards[i + 7].c.id } });
  const rows = Math.ceil(cards.length / COLS);
  for (let r = 0; r < rows; r++) {
    const outer: Section = { id: uid("x"), title: `Row ${r}`, x: -40, y: r * 700 - 60, w: COLS * 620 + 40, h: 640 };
    const inner: Section = {
      id: uid("x"),
      title: `Row ${r} left`,
      x: -20,
      y: r * 700 - 40,
      w: 6 * 620,
      h: 600,
      parent: outer.id,
    };
    b.sections.push(outer, inner);
    cards.slice(r * COLS, r * COLS + COLS).forEach(({ c }, k) => {
      b.place[c.id].section = k < 6 ? inner.id : outer.id;
    });
  }
  cards.forEach(({ c }, i) => {
    if (i % 3) return;
    const s = c.segments[0];
    s.hl = [[s.start + 1, s.start + 1]];
    const n: Sidenote = {
      id: uid("n"),
      at: { card: c.id, seg: s.id, lines: [s.start + 1, s.start + 1] },
      kind: "text",
      md: `Note on ${s.symbol?.qual}`,
    };
    b.sidenotes.push(n);
  });
  // Stickers like a studied board has: on a code line every 4th card, in the corner every 6th
  cards.forEach(({ c }, i) => {
    const s = c.segments[0];
    if (i % 4 === 1)
      b.stickers.push({
        id: uid("k"),
        icon: { pack: "builtin", name: "star" },
        at: { kind: "line", card: c.id, seg: s.id, line: s.start + 1 },
      });
    if (i % 6 === 2)
      b.stickers.push({
        id: uid("k"),
        icon: { pack: "builtin", name: "flag" },
        at: { kind: "canvas", ...cornerAt(b.place[c.id].w ?? 560), on: { card: c.id } },
      });
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
  child.id = "perf-sub";
  child.name = "Sub board";
  const sk = skeletonOf(child);
  const ids = new Set<string>();
  // 第 0 张（LLMEngine.step）留给 expand；从第一、二行里隔着挑
  for (let i = 2; ids.size < n && i < b.cards.length; i += 5) ids.add(b.cards[i].id);
  b.cards = b.cards.map((c) =>
    ids.has(c.id) ? ({ id: c.id, kind: "board", board: child.id } satisfies BoardCard) : c,
  );
  for (const id of ids) b.place[id] = { ...b.place[id], h: 360 };
  for (const l of b.links) {
    if (ids.has(l.to.card)) l.to = { card: l.to.card };
    if (ids.has(l.from.card)) {
      l.from = { card: l.from.card };
      delete l.call;
    }
  }
  b.sidenotes = b.sidenotes.filter((s) => !ids.has(s.at.card));
  return sk;
}

/** A board of Notes with the Markdown people write: headings, lists and tasks, code, math, tables, links, quotes */
export function notesBoard(n: number): Board {
  const b = emptyBoard("perf", `perf · ${n} notes`);
  const fns = [
    "Scheduler.schedule",
    "BlockManager.allocate",
    "ModelRunner.run",
    "LLMEngine.step",
    "Sequence.append_token",
    "Sampler.forward",
  ];
  const COLS = 10;
  for (let i = 0; i < n; i++) {
    const f = fns[i % fns.length],
      k = i % 4;
    const md = [
      `## ${i}. ${f}`,
      "",
      `prefill 时先调 **${f.split(".")[1]}**，见 [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm) 和 \`seq.block_table\`。复杂度 $O(n^2)$，每步 $b \\cdot t$ 个 token。`,
      "",
      "- [ ] check `can_allocate(seq)`",
      "- [x] 按 hash 复用前缀块",
      "  - 命中就 `ref_count += 1`",
      "- waiting → running",
      "",
      ...(k === 0
        ? [
            "```python",
            `def ${f.split(".")[1]}(self, seq):`,
            "    # 先找空闲块",
            "    block = self._allocate_block(self.free_block_ids[0])",
            "    for i in range(len(seq)):",
            "        seq.block_table.append(block.block_id)",
            "    return len(seq) * 2",
            "```",
            "",
          ]
        : []),
      ...(k === 1 ? ["$$", "\\mathrm{softmax}(x)_i = \\frac{e^{x_i}}{\\sum_j e^{x_j}}", "$$", ""] : []),
      ...(k === 2
        ? [
            "| 阶段 | 每步 token | 显存 |",
            "| --- | --- | --- |",
            "| prefill | 整个 prompt | 高 |",
            "| decode | 1 | 低 |",
            "",
          ]
        : []),
      ...(k === 3
        ? [
            "> 抢占时把最后一个 running 的序列放回 waiting，释放它的块",
            "",
            "1. schedule",
            "2. run",
            "3. postprocess",
            "",
          ]
        : []),
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
const raf = (h: Host) =>
  h.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function busy(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
}
/** Run n steps, each one action followed by waiting for it to paint; perStep: also each step's frame (sum then reports frameMedian over the steps) */
async function steps(
  h: Host,
  cdp: CDPSession,
  n: number,
  step: (i: number) => Promise<void>,
  name = "",
  perStep = false,
): Promise<M> {
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
  await cdp.send("Tracing.start", {
    categories:
      "devtools.timeline,disabled-by-default-devtools.timeline" +
      (inval ? ",disabled-by-default-devtools.timeline.invalidationTracking" : "") +
      (name && name === arg("selstats", "") ? ",disabled-by-default-blink.debug" : ""),
    transferMode: "ReportEvents",
  } as any);
  if (prof) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
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
    if (name && name === arg("steps", "")) {
      const bn = await busy(cdp);
      bs = `busy ${(bn - bPrev).toFixed(0)}`;
      bPrev = bn;
    }
    if (name && name === arg("steps", ""))
      console.log(
        `  ${name} #${i} ${wall[i].toFixed(0)}ms ${bs}`,
        await h.page.evaluate(
          () =>
            `${document.querySelector(".board")?.className} ${(document.querySelector(".world") as HTMLElement)?.style.transform}`,
        ),
      );
  }
  const bz = (await busy(cdp)) - b0;
  const m1 = await metrics(cdp);
  const parts = Object.fromEntries(
    PARTS.map((k) => [k.replace("Duration", ""), +(((m1[k] - m0[k]) * 1000) / n).toFixed(2)]),
  );
  if (prof) {
    const pr = (await cdp.send("Profiler.stop")).profile as any;
    if (process.env.PROFILE_OUT) fs.writeFileSync(process.env.PROFILE_OUT, JSON.stringify(pr));
    top(pr);
  }
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", onData);
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const onMain = (e: any) => !!main && e.pid === main.pid && e.tid === main.tid;
  const runTasks = events.filter((e) => e.ph === "X" && e.name === "RunTask" && onMain(e) && e.dur > 1000);
  const tasks = runTasks.map((e) => e.dur / 1000);
  // Each step's frame: its longest main-thread task, from its mark to the next step's
  const marks = events
    .filter((e) => e.name === "TimeStamp" && e.args?.data?.message === STEP_MARK && onMain(e))
    .map((e) => e.ts as number)
    .sort((a, b) => a - b);
  const frames =
    perStep && marks.length === n
      ? marks.map((ts, i) =>
          Math.max(
            0,
            ...runTasks.filter((e) => e.ts >= ts && e.ts < (marks[i + 1] ?? Infinity)).map((e) => e.dur / 1000),
          ),
        )
      : undefined;
  if (name && name === arg("long", "")) {
    // What each dropped frame spent its time on (events inside the task, >1.5 ms); LONG_OVER=8.3: the frames dropped at 120 fps
    for (const t of events.filter(
      (e) =>
        e.ph === "X" &&
        e.name === "RunTask" &&
        main &&
        e.pid === main.pid &&
        e.tid === main.tid &&
        e.dur > +(process.env.LONG_OVER ?? 16.7) * 1000,
    ))
      console.log(
        `  long ${(t.dur / 1000).toFixed(0)}ms:`,
        events
          .filter(
            (e) =>
              e.ph === "X" &&
              e.pid === main.pid &&
              e.tid === main.tid &&
              e.ts >= t.ts &&
              e.ts + e.dur <= t.ts + t.dur &&
              e.dur > +(process.env.LONG_MIN ?? 1500) &&
              e.name !== "RunTask",
          )
          .map(
            (e) =>
              `${e.name}${e.args?.data?.functionName ? "(" + e.args.data.functionName + ")" : ""} ${(e.dur / 1000).toFixed(1)}`,
          )
          .join(" > "),
      );
  }
  if (name && name === arg("selstats", "")) {
    // CSS selector stats (DevTools "Enable CSS selector stats"): the selectors that cost the most in this step
    const by = new Map<string, { t: number; att: number; m: number }>();
    for (const e of events)
      for (const x of e.args?.selector_stats?.selector_timings ?? []) {
        const o = by.get(x.selector) ?? { t: 0, att: 0, m: 0 };
        o.t += x.elapsed ?? x["elapsed (us)"] ?? 0;
        o.att += x.match_attempts;
        o.m += x.match_count;
        by.set(x.selector, o);
      }
    const tot = [...by.values()].reduce((s, o) => s + o.t, 0);
    console.log(`-- selector stats: ${by.size} selectors, ${(tot / 1000).toFixed(0)} ms`);
    for (const [k, o] of [...by].sort((a, b) => b[1].t - a[1].t).slice(0, 50))
      console.log(
        `${(o.t / 1000).toFixed(1).padStart(7)}ms ${String(o.att).padStart(8)} ${String(o.m).padStart(7)}  ${k.slice(0, 140)}`,
      );
  }
  if (inval) {
    // What invalidated style / layout: count by event, reason and node (--inval <step>)
    const by = new Map<string, number>();
    for (const e of events)
      if (e.name.includes("Invalidat") && e.args?.data) {
        const d = e.args.data;
        const k = `${e.name.replace("InvalidationTracking", "")} ${d.reason ?? d.invalidationList?.[0]?.classes?.join(".") ?? ""} ${d.nodeName ?? ""}`;
        by.set(k, (by.get(k) ?? 0) + 1);
      }
    console.log("-- invalidations");
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 60))
      console.log(`${String(v).padStart(8)}  ${k}`);
  }
  if (tr) {
    const by = new Map<string, number>();
    for (const e of events)
      if (e.ph === "X" && e.dur && (!main || (e.pid === main.pid && e.tid === main.tid)))
        by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
    console.log("-- trace (main thread, inclusive ms)");
    for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 25))
      console.log(`${v.toFixed(0).padStart(8)}  ${k}`);
  }
  return { wall, busy: bz, parts, tasks, frames };
}
/** Profile results: top 30 functions by self time and total time */
function top(p: {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}) {
  const self = new Map<number, number>();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n: (typeof p.nodes)[number]) =>
    `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
  const selfBy = new Map<string, number>(),
    totBy = new Map<string, number>();
  for (const [id, t] of self) {
    const k = key(byId.get(id)!);
    selfBy.set(k, (selfBy.get(k) ?? 0) + t);
    const seen = new Set<string>();
    for (let q: number | undefined = id; q !== undefined; q = parent.get(q)) {
      const kk = key(byId.get(q)!);
      if (seen.has(kk)) continue;
      seen.add(kk);
      totBy.set(kk, (totBy.get(kk) ?? 0) + t);
    }
  }
  const pr = (m: Map<string, number>, t: string) => {
    console.log(`-- ${t}`);
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 30))
      console.log(`${(v / 1000).toFixed(0).padStart(7)}ms  ${k}`);
  };
  pr(selfBy, "self");
  pr(totBy, "total");
}
const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pct = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const p95 = (a: number[]) => pct(a, 0.95);
/**
 * Frames: main-thread task durations (>1 ms); frameMax over 16.7 means a dropped frame, over16 counts such tasks (over8: over 8.3 ms, a dropped frame at 120 fps). frameP95 is the 95th
 * percentile of all the tasks (frameP99 the 99th). After steps(..., perStep) (frameOf "stepMedian") it is frameMedian instead, the median of each step's frame (its longest task), with
 * the frames themselves in stepFrames: for steps that wait, where the waits' own frames outnumber the steps' (hover: 12 steps that wait 250–500 ms each for the
 * cross-fades, ~125 tasks of which the 6 lifts are 5%, so a p95 over all tasks fell on either side of them by how many fade frames the runner drew: 12.7 → 19.6 ms,
 * same code). A p95 over 12 steps is their longest one, which one stray task decides: 18.9–37.2 ms in four runs of the same commit, a 1.60x hover "regression"
 * in the regular run on e1a08d9. The median moves only when the lifts and drops themselves get slower: 16.5–18.6 ms in six runs.
 */
const sum = (m: M) => ({
  median: +med(m.wall).toFixed(1),
  p95: +p95(m.wall).toFixed(1),
  busyPerStep: +(m.busy / m.wall.length).toFixed(2),
  ...m.parts,
  ...(m.frames
    ? { frameOf: "stepMedian", frameMedian: +med(m.frames).toFixed(1), stepFrames: m.frames.map((f) => +f.toFixed(1)) }
    : {
        frameP95: +p95(m.tasks?.length ? m.tasks : [0]).toFixed(1),
        frameP99: +pct(m.tasks?.length ? m.tasks : [0], 0.99).toFixed(1),
      }),
  frameMax: +Math.max(0, ...(m.tasks ?? [])).toFixed(1),
  over16: (m.tasks ?? []).filter((t) => t > 16.7).length,
  over8: (m.tasks ?? []).filter((t) => t > 8.3).length,
});

async function profiled<T>(cdp: CDPSession, name: string, fn: () => Promise<T>): Promise<T> {
  if (name !== PROFILE) return fn();
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const r = await fn();
  const pr = (await cdp.send("Profiler.stop")).profile as any;
  if (process.env.PROFILE_OUT) fs.writeFileSync(process.env.PROFILE_OUT, JSON.stringify(pr));
  top(pr);
  return r;
}
async function idle(h: Host, cdp: CDPSession, ms: number) {
  const b0 = await busy(cdp);
  await h.page.waitForTimeout(ms);
  return (await busy(cdp)) - b0;
}

async function once() {
  await ready();
  const board = NNOTES ? notesBoard(NNOTES) : bigBoard(NCARDS);
  const sk = NFRAMES ? withFrames(board, NFRAMES) : null;
  // A sticker bound to the hub card (the card the drag scenario grabs), for the stickerDrag scenario
  const STK = "kperf";
  if (!NNOTES)
    board.stickers.push({
      id: STK,
      icon: { pack: "builtin", name: "zap" },
      at: { kind: "canvas", x: 24, y: -48, size: 32, on: { card: hubOf(board) } },
    });
  // --anim: every star / flag sticker becomes an animated 64px GIF (2 frames, 200 ms), like a pack of downloaded animated emoji
  const ANIM = process.argv.includes("--anim");
  const pack = ANIM
    ? [
        {
          id: "perf",
          name: "perf",
          icons: [
            {
              name: "wink",
              anim: true,
              img: `data:image/gif;base64,${gif(
                64,
                64,
                [
                  [0, 0, 0],
                  [236, 120, 160],
                  [60, 40, 30],
                ],
                faceFrames(64, [236, 120, 160, 255]).map((f) => (x: number, y: number) => {
                  const c = f(x, y);
                  return c[3] === 0 ? 0 : c[0] === 60 ? 2 : 1;
                }),
                200,
                0,
              ).toString("base64")}`,
            },
          ],
        },
      ]
    : [];
  if (ANIM)
    for (const k of board.stickers)
      if (k.icon.pack === "builtin" && k.id !== STK) k.icon = { pack: "perf", name: "wink" };
  const res: Record<string, unknown> = {
    cards: board.cards.length,
    links: board.links.length,
    sections: board.sections.length,
    sidenotes: board.sidenotes.length,
    ...(ANIM ? { animStickers: board.stickers.filter((k) => k.icon.pack === "perf").length } : {}),
    ...(sk ? { frames: NFRAMES } : {}),
  };
  const t0 = performance.now();
  let cdp!: CDPSession;
  const h = await openBoard(await launch(), {
    until: "shown",
    board,
    light: process.argv.includes("--light"),
    settings: THEME ? ({ theme: THEME } as any) : undefined,
    on: (m, reply) =>
      sk && m.type === "skeletons"
        ? (void reply(m.req!, Object.fromEntries(m.ids.map((id) => [id, sk]))), true)
        : ANIM && m.type === "stickerPacks"
          ? (void reply(m.req!, pack), true)
          : false,
    beforeLoad: async (page) => {
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      if (PROFILE === "load") {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
      }
    },
  });
  // Load: init received → all cards painted (measured in the page)
  const ld = await h.page.waitForFunction(
    (n) => document.querySelectorAll(".card").length >= n && performance.now() - (window as any).__tInit,
    board.cards.length,
    { timeout: 60000 },
  );
  res.load = +(+(await ld.jsonValue())).toFixed(0);
  res.openTotal = +(performance.now() - t0).toFixed(0);
  if (PROFILE === "load") top((await cdp.send("Profiler.stop")).profile as any);
  if (arg("css", "")) await h.page.addStyleTag({ content: arg("css", "") });
  if (process.argv.includes("--traffic")) {
    await h.page.locator(".dock .traffic").click();
    res.movers = await h.page.locator(".movers .mover").count();
  }
  await h.page.waitForTimeout(1500);
  if (arg("shot", "")) {
    const still = () =>
      h.page.waitForFunction(() => !document.querySelector(".world")?.matches(".moving"), null, {
        timeout: 30000,
      });
    for (const z of [1, 2.5]) {
      await h.post({ type: "reveal", card: board.links[0].to.card });
      await h.page.waitForTimeout(1000);
      await still();
      if (z > 1) {
        await h.page.keyboard.down("Control");
        for (let i = 0; i < 12; i++) await h.page.mouse.wheel(0, -40);
        await h.page.keyboard.up("Control");
        await h.page.waitForTimeout(800);
        await still();
      }
      await h.page.screenshot({ path: `${arg("shot", "")}-${z}.png` });
    }
    // After a wheel pan across two rows of cards that were hidden off screen (state/cull.ts), at rest
    await h.post({ type: "reveal", card: board.links[0].to.card });
    await h.page.waitForTimeout(1000);
    await still();
    await h.page.mouse.move(700, 450);
    for (let i = 0; i < 35; i++) {
      await h.page.mouse.wheel(i % 3 ? 0 : 60, 40);
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(1500);
    await h.page.mouse.move(5, 5);
    await h.page.waitForTimeout(500);
    await still();
    await h.page.screenshot({ path: `${arg("shot", "")}-pan.png` });
    await h.page.context().browser()!.close();
    return res;
  }
  if (arg("stop", "") === "dom") {
    res.dom = await h.page.evaluate(() => {
      const by: Record<string, number> = {};
      for (const e of document.querySelectorAll(".world *")) {
        const k = e.tagName + "." + (typeof e.className === "string" ? e.className.split(" ")[0] : "");
        by[k] = (by[k] ?? 0) + 1;
      }
      return {
        total: document.querySelectorAll("*").length,
        top: Object.entries(by)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 45),
      };
    });
    await h.page.context().browser()!.close();
    return res;
  }
  if (arg("stop", "") === "collapse") {
    // Collapse and expand the Section of the row in view (12 cards: its inner Section and 6 direct members), from the toolbar caret
    const b = h.board(),
      row = b.sections.find((x) => !x.parent && b.sections.some((y) => y.parent === x.id))!;
    await h.post({ type: "reveal", card: Object.entries(b.place).find(([, p]) => p.section === row.id)![0] });
    await h.page.waitForTimeout(1200);
    const chev = h.page.locator(`.slabel[data-sect="${row.id}"] .chev2`);
    res.collapse = sum(
      await steps(
        h,
        cdp,
        6,
        async () => {
          await chev.evaluate((e) => (e as HTMLElement).click());
          await h.page.waitForTimeout(900);
        },
        "collapse",
      ),
    );
    await h.page.context().browser()!.close();
    return res;
  }
  if (arg("stop", "") === "settle") {
    // One small zoom step, then wait until the camera has stopped and the world is redrawn at the new scale: what one stop costs, at 100 % and zoomed out to 40 %
    const spot = await h.page.evaluate(() => {
      for (let y = 120; y < 860; y += 20)
        for (let x = 80; x < 1350; x += 20) {
          const e = document.elementFromPoint(x, y);
          if (e && (e.classList.contains("board") || e.classList.contains("world"))) return [x, y];
        }
      return [700, 450];
    });
    await h.page.mouse.move(spot[0], spot[1]);
    const wheel = async (d: number) => {
      await h.page.keyboard.down("Control");
      await h.page.mouse.wheel(0, d);
      await h.page.keyboard.up("Control");
    };
    for (const [lvl, n] of [
      ["Full", 0],
      ["Out", 3],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await wheel(30);
        await h.page.waitForTimeout(150);
      }
      await h.page.waitForTimeout(1500);
      res["settle" + lvl] = sum(
        await steps(
          h,
          cdp,
          12,
          async (i) => {
            await wheel(i % 2 ? 4 : -4);
            await h.page.waitForTimeout(500);
          },
          "settle" + lvl,
        ),
      );
    }
    await h.page.context().browser()!.close();
    return res;
  }
  res.idleBusy1s = +(await idle(h, cdp, 1000)).toFixed(1);
  // --raster: only the raster probes (rasterProbes), not the timed steps
  if (RASTER_ONLY) {
    const { passes: raster, ran } = await rasterProbes(h, cdp, hubOf(board));
    res.raster = raster;
    res.rasterChecks = rasterChecks(raster, "synthetic", ran);
    await h.page.context().browser()!.close();
    return res;
  }

  // Pan the canvas (gesture starts over empty canvas, so the board pans instead of a card scrolling); the first pan after opening
  const spot = await h.page.evaluate(() => {
    for (let y = 120; y < 860; y += 20)
      for (let x = 80; x < 1350; x += 20) {
        const e = document.elementFromPoint(x, y);
        if (e && (e.classList.contains("board") || e.classList.contains("world"))) return [x, y];
      }
    return [700, 450];
  });
  await h.page.mouse.move(spot[0], spot[1]);
  res.panCanvas = sum(
    await steps(
      h,
      cdp,
      30,
      async (i) => {
        await h.page.mouse.wheel(i % 2 ? 25 : -25, 0);
      },
      "panCanvas",
    ),
  );
  await h.page.waitForTimeout(600);

  await h.page.mouse.move(700, 450);
  res.pan = sum(
    await steps(
      h,
      cdp,
      60,
      async () => {
        await h.page.mouse.wheel(0, 40);
      },
      "pan",
    ),
  );
  res.zoom = sum(
    await steps(
      h,
      cdp,
      40,
      async (i) => {
        await h.page.keyboard.down("Control");
        await h.page.mouse.wheel(0, i < 20 ? 30 : -30);
        await h.page.keyboard.up("Control");
      },
      "zoom",
    ),
  );
  // Trackpad pinch: many small steps from 100% down past the summary cut and back (crosses the switch both ways)
  res.pinch = sum(
    await steps(
      h,
      cdp,
      100,
      async (i) => {
        await h.page.keyboard.down("Control");
        await h.page.mouse.wheel(0, i < 50 ? 5 : -5);
        await h.page.keyboard.up("Control");
      },
      "pinch",
    ),
  );
  await h.page.waitForTimeout(800);
  // Scroll inside a card: the wheel over a selected card's long body scrolls the body itself (the card owns the gesture), down then up
  // (the code card whose code overflows its body the most: the longest function, capped at CODE_MAX)
  const scrolled = NNOTES
    ? "n10"
    : await h.page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>(".card.ccard")]
            .map((c) => {
              const b = c.querySelector<HTMLElement>(".cbody");
              return { id: c.dataset.id!, over: b ? b.scrollHeight - b.clientHeight : 0 };
            })
            .sort((a, b) => b.over - a.over)[0]?.id,
      );
  if (scrolled)
    res[NNOTES ? "scrollNote" : "scrollCode"] = await scrollIn(
      h,
      cdp,
      scrolled,
      NNOTES ? ".nbody" : ".cbody",
      NNOTES ? "scrollNote" : "scrollCode",
    );
  if (arg("stop", "") === "pinch") {
    await h.page.context().browser()!.close();
    return res;
  }
  if (NNOTES) {
    await notesEdit(h, cdp, board, res);
    await h.page.context().browser()!.close();
    return res;
  }

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
      return (
        e?.closest(".card")?.getAttribute("data-id") === id &&
        !!e.closest("[data-drag]") &&
        !e.closest("button, .step, [contenteditable]")
      );
    };
    const k = document.querySelector(`.card[data-id="${id}"] .chead .kind`)?.getBoundingClientRect();
    if (k && free(k.left + 4, k.top + 4)) return { x: k.left, y: k.top, at: "kind" };
    const head = document.querySelector(`.card[data-id="${id}"] [data-drag]`)!.getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7])
      for (let x = head.left + 6; x < head.right - 6; x += 6) {
        const y = head.top + head.height * fy;
        if (free(x, y)) return { x: x - 4, y: y - 4, at: `${(document.elementFromPoint(x, y) as Element).tagName}` };
      }
    throw new Error("no free spot on the header to grab");
  }, hub);
  if (process.argv.includes("--steps")) console.log("  drag grab", JSON.stringify(bx));
  const hubX = () =>
    h.page.evaluate(
      (id) => parseFloat((document.querySelector(`.card[data-id="${id}"]`) as HTMLElement).style.left),
      hub,
    );
  const x0 = await hubX();
  await h.page.mouse.move(bx.x + 4, bx.y + 4);
  await h.page.mouse.down();
  res.drag = sum(
    await steps(
      h,
      cdp,
      60,
      async (i) => {
        await h.page.mouse.move(bx.x + 4 + i * 4, bx.y + 4 + i * 2, { steps: 1 });
      },
      "drag",
    ),
  );
  const tUp = performance.now();
  const bUp = await busy(cdp);
  await profiled(cdp, "dragEnd", async () => {
    await h.page.mouse.up();
    await raf(h);
  });
  res.dragEndBusy = +((await busy(cdp)) - bUp).toFixed(1);
  res.dragEnd = +(performance.now() - tUp).toFixed(1);
  // The drag must have moved the card (60 steps × 4 px on screen), or drag / nudge / undo numbers measure nothing
  res.dragMoved = Math.round((await hubX()) - x0);
  if (!((res.dragMoved as number) > 20)) {
    const hit = await h.page.evaluate(
      ([x, y]) => {
        const out: string[] = [];
        for (let e = document.elementFromPoint(x, y); e; e = e.parentElement)
          out.push(`${e.tagName}.${typeof e.className === "string" ? e.className : ""}`);
        const g = document.elementFromPoint(x, y)?.closest("g.link") as SVGGElement | null;
        return (
          out.slice(0, 6).join(" < ") +
          (g
            ? ` link ${g.dataset.from}→${g.dataset.to} sides ${g.dataset.sides} ${g.querySelector(".edge")?.getAttribute("d")}`
            : "")
        );
      },
      [bx.x + 4, bx.y + 4],
    );
    throw new Error(
      `drag did not move the card ${hub} (moved ${res.dragMoved}px; grabbed ${JSON.stringify(bx)} → ${hit}; card ${JSON.stringify(board.place[hub])})`,
    );
  }
  await h.page.waitForTimeout(1200);

  // Hover the hub card and leave it: all its arrows lift above the cards and drop back, with a cross-fade each way
  const on = await h.page.evaluate((id) => {
    const r = document.querySelector(`.card[data-id="${id}"] [data-drag]`)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, hub);
  const off = await h.page.evaluate(() => {
    for (let y = 20; y < innerHeight - 60; y += 20)
      for (let x = 20; x < innerWidth - 20; x += 20) {
        const e = document.elementFromPoint(x, y);
        if (e?.closest(".world, .board") && !e.closest(".card, [data-link], .lw, .stk")) return { x, y };
      }
    return null;
  });
  if (off) {
    await h.page.mouse.move(off.x, off.y);
    await h.page.waitForTimeout(500);
    res.hover = sum(
      await steps(
        h,
        cdp,
        12,
        async (i) => {
          if (i % 2) await h.page.mouse.move(off.x, off.y);
          else await h.page.mouse.move(on.x, on.y);
          await h.page.waitForTimeout(i % 2 ? 500 : 250);
        },
        "hover",
        true,
      ),
    );
  }

  // Sticker drag: the sticker bound to the hub, dragged across the cards around it (every card checks whether it lights up)
  const sb = await h.page.evaluate((id) => {
    const r = document.querySelector(`[data-sticker="${id}"]`)?.getBoundingClientRect();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, STK);
  if (sb) {
    await h.page.mouse.move(sb.x, sb.y);
    await h.page.mouse.down();
    res.stickerDrag = sum(
      await steps(
        h,
        cdp,
        60,
        async (i) => {
          await h.page.mouse.move(sb.x + 4 + i * 6, sb.y + 4 + i * 3, { steps: 1 });
        },
        "stickerDrag",
      ),
    );
    await h.page.mouse.up();
    await h.page.keyboard.press("Meta+z");
    await h.page.waitForTimeout(600);
    await focusCard(h, hub);
  }

  // Mutate: move the selected card with arrow keys (one mutate each: undo snapshot + invariants + autosave dependencies)
  res.nudge = sum(
    await steps(
      h,
      cdp,
      30,
      async () => {
        await h.page.keyboard.press("ArrowRight");
      },
      "nudge",
    ),
  );
  res.boardKB = Math.round(JSON.stringify(board).length / 1024);
  // Move 120 more times to see how much the undo stack grows the heap (force GC first)
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return ((await cdp.send("Runtime.getHeapUsage")) as any).usedSize / 2 ** 20;
  };
  const h0 = await heap();
  for (let i = 0; i < 120; i++) await h.page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowDown");
  await h.page.waitForTimeout(300);
  res.heapPer100Edits = +(((await heap()) - h0) / 1.2).toFixed(1);
  res.saveAfterNudge = +(await idle(h, cdp, 1500)).toFixed(1);
  res.undo = sum(
    await steps(
      h,
      cdp,
      15,
      async () => {
        await h.page.keyboard.press("Meta+z");
      },
      "undo",
    ),
  );
  res.redo = sum(
    await steps(
      h,
      cdp,
      15,
      async () => {
        await h.page.keyboard.press("Meta+Shift+z");
      },
      "redo",
    ),
  );
  await h.page.waitForTimeout(1200);
  // --no-raster: no raster probes (PR CI runs them in one of its two head runs: they count, so one run is enough)
  if (!NNOTES && !sk && !process.argv.includes("--no-raster")) {
    const { passes: raster, ran } = await rasterProbes(h, cdp, hubOf(board));
    res.raster = raster;
    res.rasterChecks = rasterChecks(raster, "synthetic", ran);
  }

  if (process.argv.includes("--quick")) {
    await h.page.context().browser()!.close();
    return res;
  }
  // Expand: click a call in card 0 and wait for the new card
  const ex: number[] = [];
  for (const name of ["schedule", "postprocess"]) {
    await focusCard(h, board.cards[0].id);
    const n0 = await h.page.locator(".card").count();
    const el = h.page.locator(`.card[data-id="${board.cards[0].id}"] .src .call:text-is("${name}")`).first();
    // Press → new card appears in the DOM (measured in the page, includes the host round trip)
    await profiled(cdp, "expand", async () => {
      await el.click();
      const r = await h.page.waitForFunction(
        (n) => document.querySelectorAll(".card").length > n && performance.now() - (window as any).__tDown,
        n0,
      );
      ex.push(+(await r.jsonValue()));
    });
    await h.page.waitForTimeout(900);
  }
  res.expand = ex.map((x) => +x.toFixed(1));

  // Versions: host pushes a batch of "new versions", then Update All
  const stale: Record<string, unknown> = {};
  for (const c of board.cards)
    for (const s of (c as CodeCard).segments ?? [])
      stale[s.id] = { state: "changed", hiddenOnly: false, head: "f64d821" };
  let t = performance.now();
  await profiled(cdp, "stale", async () => {
    await h.post({ type: "stale", stale: stale as any });
    await raf(h);
  });
  res.staleMsg = +(performance.now() - t).toFixed(1);
  await h.page.context().browser()!.close();
  return res;
}

/** Wheel over the scrolling body of card id (selected first, so the gesture is the card's): 30 steps down, then 30 up, each a 30th of
 *  how far it scrolls (at most 30 px). Throws when it did not scroll */
async function scrollIn(h: Host, cdp: CDPSession, id: string, body: string, name: string) {
  await focusCard(h, id);
  // A point that really is the body: Sidenotes, stickers and arrows can lie over parts of it
  const at = await h.page.evaluate(
    ([id, body]) => {
      const b = document.querySelector<HTMLElement>(`.card[data-id="${id}"] ${body}`)!,
        r = b.getBoundingClientRect();
      for (let y = r.top + 40; y < Math.min(r.bottom, innerHeight) - 20; y += 20)
        for (let x = r.left + 40; x < r.right - 40; x += 40)
          if (document.elementFromPoint(x, y)?.closest(body) === b) return { x, y };
      return null;
    },
    [id, body] as const,
  );
  if (!at) throw new Error(`${name}: no free point over ${body} of ${id}`);
  await h.page.mouse.move(at.x, at.y);
  const top = () =>
    h.page.evaluate(([id, body]) => document.querySelector(`.card[data-id="${id}"] ${body}`)!.scrollTop, [
      id,
      body,
    ] as const);
  const over = await h.page.evaluate(
    ([id, body]) => {
      const b = document.querySelector(`.card[data-id="${id}"] ${body}`)!;
      return b.scrollHeight - b.clientHeight;
    },
    [id, body] as const,
  );
  const d = Math.max(4, Math.min(30, Math.floor(over / 30)));
  const t0 = await top();
  let far = 0;
  const m = sum(
    await steps(
      h,
      cdp,
      60,
      async (i) => {
        await h.page.mouse.wheel(0, i < 30 ? d : -d);
        if (i === 29) far = await top();
      },
      name,
    ),
  );
  if (!(far - t0 > Math.min(100, over / 2)))
    throw new Error(`${name}: the body of ${id} did not scroll (scrollTop ${t0} → ${far} of ${over})`);
  return { ...m, scrolledPx: far - t0 };
}

/** Notes board: double-click a Note → its editor has focus (10 different Notes, the first one includes loading the editor if it was not preloaded),
 * then type 80 characters one key at a time, then Esc (save and leave) */
async function notesEdit(h: Host, cdp: CDPSession, board: Board, res: Record<string, unknown>) {
  const ids = board.cards.slice(0, 10).map((c) => c.id);
  const center = (id: string) =>
    h.page.evaluate((id) => {
      const r = document
        .querySelector(`.card[data-id="${id}"] .nbody, .card[data-id="${id}"] .tx`)!
        .getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 60) };
    }, id);
  const editingIn = (id: string) =>
    h.page.waitForFunction(
      (id) => {
        const a = document.activeElement as HTMLElement | null;
        return !!a?.isContentEditable && !!a.closest(`.card[data-id="${id}"]`);
      },
      id,
      { timeout: 10000 },
    );
  // Double-click → focused editor, then the next frame (camera moves between Notes are not timed).
  // In the page: last pointerdown → focus lands in the editor (enterJs: the work done in that task), → the frame after it is painted (enterPaint)
  await h.page.evaluate(() => {
    const w = window as any;
    w.__enter = [];
    addEventListener(
      "pointerdown",
      () => {
        w.__tDown2 = performance.now();
      },
      true,
    );
    addEventListener(
      "focusin",
      (e) => {
        if (!(e.target as HTMLElement).isContentEditable) return;
        const t0 = w.__tDown2,
          js = performance.now() - t0;
        requestAnimationFrame(() => setTimeout(() => w.__enter.push([js, performance.now() - t0])));
      },
      true,
    );
  });
  const enter: number[] = [];
  await profiled(cdp, "editEnter", async () => {
    for (let i = 0; i < ids.length; i++) {
      if (i) {
        await h.page.keyboard.press("Escape");
        await h.page.waitForTimeout(300);
      }
      await focusCard(h, ids[i]);
      const pt = await center(ids[i]);
      // 真实用户先移到 Note 上再双击；--hover 0 关闭
      const hov = +arg("hover", "300");
      if (hov) {
        await h.page.mouse.move(pt.x, pt.y);
        await h.page.waitForTimeout(hov);
      }
      const t = performance.now();
      const tr = arg("long", "") === "editEnter" ? await traceStart(cdp) : null;
      await h.page.mouse.dblclick(pt.x, pt.y);
      await editingIn(ids[i]);
      await raf(h);
      enter.push(+(performance.now() - t).toFixed(1));
      if (tr) await tr();
    }
  });
  res.editEnter = { first: enter[0], median: +med(enter).toFixed(1), p95: +p95(enter).toFixed(1) };
  const inPage = (await h.page.evaluate(() => (window as any).__enter)) as [number, number][];
  const js = inPage.map((x) => x[0]),
    paint = inPage.map((x) => x[1]);
  res.editEnterJs = { first: +js[0].toFixed(1), median: +med(js).toFixed(1), p95: +p95(js).toFixed(1) };
  res.editEnterPaint = { first: +paint[0].toFixed(1), median: +med(paint).toFixed(1), p95: +p95(paint).toFixed(1) };
  await h.page.keyboard.press("ControlOrMeta+End");
  await h.page.keyboard.press("Enter");
  const text = "Prefill admits waiting seqs until the token budget runs out, then decode. ";
  res.type = sum(
    await steps(
      h,
      cdp,
      80,
      async (i) => {
        await h.page.keyboard.type(text[i % text.length]);
      },
      "type",
    ),
  );
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
  res.typed = (h.board().cards.find((c) => c.id === ids[ids.length - 1]) as { md: string }).md.includes(
    "Prefill admits waiting",
  );
}

// ---- Raster probes: counts, not milliseconds (probes.ts). Each runs its own steps after the timed ones, traced with the
// compositor's layer snapshots (disabled-by-default-devtools.timeline.layers: the tree and its tiles at every draw), which would
// slow the timed steps: the pixels rastered in each step (as a share of the viewport's device pixels), the layers rastered in
// each step, the pixels of tiles rastered at more than 2x the scale they were shown at, the pixels rastered while the camera
// comes to rest, and, at rest, every layer rastered below the scale it is shown at (blurry) or more than 2x above it (wasted).

/** Trace marker at the start of each raster step, and of the rest after the last one */
const RASTER_MARK = "raster-step";
const still = (h: Host) =>
  h.page.waitForFunction(() => !document.querySelector(".world.moving, .board.relift, .board.lifting"), null, {
    timeout: 30000,
  });
/** A rest: the camera stopped, then long enough for the raster workers to finish and the compositor to draw */
async function rest(h: Host) {
  await still(h);
  await h.page.waitForTimeout(900);
  await still(h);
  await raf(h);
}
const timeStamp = (h: Host, m: string) => h.page.evaluate((m) => console.timeStamp(m), m);

async function rasterPass(
  h: Host,
  cdp: CDPSession,
  name: string,
  n: number,
  step: (i: number) => Promise<void>,
  done?: () => Promise<void>,
): Promise<RasterResult> {
  await rest(h);
  const events: TraceEvent[] = [];
  const onData = (e: any) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.layers",
    transferMode: "ReportEvents",
  } as any);
  for (let i = 0; i < n; i++) {
    await timeStamp(h, RASTER_MARK);
    await step(i);
    await raf(h);
  }
  await timeStamp(h, RASTER_MARK);
  await done?.();
  await rest(h);
  const ended = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await ended;
  cdp.off("Tracing.dataCollected", onData);
  // RASTER_OUT=<dir>: each pass's trace and a screenshot at rest, for a closer look
  if (process.env.RASTER_OUT) {
    fs.writeFileSync(path.join(process.env.RASTER_OUT, `${name}.json`), JSON.stringify(events));
    await h.page.screenshot({ path: path.join(process.env.RASTER_OUT, `${name}.png`) });
  }
  const marks = events
    .filter((e) => e.name === "TimeStamp" && e.args?.data?.message === RASTER_MARK)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  // a loop, not Math.max(...): a pass's trace can hold more events than a call takes arguments
  let end = 0;
  for (const e of events) if (e.ts > end) end = e.ts;
  const { steps: w, unknown, tasks, names } = rasterWindows(events, marks, end + 1);
  const snaps = snapshotsOf(events);
  const last = snaps.at(-1)?.s;
  const vs = last?.device_viewport_size;
  const vp = vs ? vs.width * vs.height : 1;
  const st = w.slice(0, -1),
    settle = w.at(-1);
  const layers = last ? layerScales(last) : [];
  const hits = scaleHits(layers, vp);
  const tag = (l: (typeof hits)[number]) =>
    `${l.name.replace(/^Layout\w+ (\([^)]*\) )?/, "")} ${l.w}×${l.h} raster ${l.raster} shown ${l.ideal} (${l.ratio}x)`;
  const vps = (px: number) => +(px / vp).toFixed(2);
  const mem = snaps.map(({ s }) => tileMemory(s));
  const r: RasterResult = {
    stepVP: vps(medianOf(st.map((x) => x.px))),
    stepVPMax: vps(Math.max(0, ...st.map((x) => x.px))),
    stepLayers: medianOf(st.map((x) => x.layers)),
    stepLayersMax: Math.max(0, ...st.map((x) => x.layers)),
    wastedVP: vps(w.reduce((t, x) => t + x.wasted, 0)),
    restVP: vps(settle?.px ?? 0),
    layers: layers.length,
    zoom: +(await zoomOf(h)).toFixed(3),
    blurry: hits.filter((x) => x.kind === "blurry").map(tag),
    wasted: hits.filter((x) => x.kind === "wasted").map(tag),
    unknown,
    tasks,
    snapshots: snaps.length,
    tileMBMax: Math.max(0, ...mem.map((m) => m.mb)),
    tileVPMax: Math.max(0, ...mem.map((m) => m.vp)),
    tileMBRest: mem.at(-1)?.mb ?? 0,
    tileLimitMB: mem.at(-1)?.limitMB ?? 0,
    oomSnapshots: mem.filter((m) => m.oom).length,
  };
  if (process.argv.includes("--steps")) {
    console.log(`  raster ${name}: ${JSON.stringify(r)}`);
    const short = (id: number) => (names.get(id) ?? `#${id}`).replace(/^Layout\w+ (\([^)]*\) )?/, "").slice(0, 40);
    w.forEach((x, i) =>
      console.log(
        `    ${i === w.length - 1 ? "rest" : `#${i}`} ${(x.px / vp).toFixed(2)} vp (wasted ${(x.wasted / vp).toFixed(2)}), ${x.layers} layers, ${x.tiles} tiles: ${[
          ...x.byLayer,
        ]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id, px]) => `${short(id)} ${(px / vp).toFixed(2)}`)
          .join(", ")}`,
      ),
    );
    for (const l of layers)
      console.log(`    layer ${l.id} ${l.name} ${l.w}×${l.h} raster ${l.raster} shown ${l.ideal} on ${l.shownPx} px`);
  }
  return r;
}

const zoomOf = (h: Host) =>
  h.page.evaluate(
    () => +(/scale\(([\d.e+-]+)\)/.exec((document.querySelector(".world") as HTMLElement)?.style.transform)?.[1] ?? 1),
  );
const ctrlWheel = async (h: Host, dy: number) => {
  await h.page.keyboard.down("Control");
  await h.page.mouse.wheel(0, dy);
  await h.page.keyboard.up("Control");
};
/** A point over empty canvas, where a wheel pans or zooms the board */
const emptySpot = (h: Host) =>
  h.page.evaluate(() => {
    for (let y = 120; y < innerHeight - 40; y += 20)
      for (let x = 80; x < innerWidth - 50; x += 20) {
        const e = document.elementFromPoint(x, y);
        if (e && (e.classList.contains("board") || e.classList.contains("world"))) return { x, y };
      }
    return { x: innerWidth / 2, y: innerHeight / 2 };
  });

/**
 * The raster probes on a board (probes.ts RASTER_BUDGET says which numbers are judged): drag a card (`drag`: its id), pan, pan and hover at rest just above the summary cut (nearCut), zoom
 * out and in, six small zoom stops, a mouse-wheel zoom out across the summary cut (#155: the summary columns rastered at device
 * scale as they came in), Fit to Window from 100 %, from there in to 0.2 (zoomed out past the cut, out of the detent's reach),
 * and in to 250 %, out past the cut and back to ~150 % (inOutIn)
 */
async function rasterProbes(
  h: Host,
  cdp: CDPSession,
  drag: string,
  section?: { id: string; near: string },
  /** a card dragged along its row's top edge (dragSnap), snapped to its neighbours with the guides showing at every move */
  snap?: string,
) {
  const out: Record<string, RasterResult> = {};
  const ran: string[] = [];
  // --passes drag,cut: only these; --quick (PR CI): only the passes with a budget at card level, the others run in the regular runs
  const passes = arg("passes", process.argv.includes("--quick") ? "drag,dragSnap,pan,nearCut,stops" : "").split(",");
  const want = (p: string) => passes[0] === "" || passes.includes(p);
  // the passes asked for (zoom: zoomOut and zoomIn; zoomedOut after fit): rasterChecks fails one that ran and left no result
  for (const p of [
    "drag",
    "dragSnap",
    "dragSection",
    "pan",
    "nearCut",
    "stops",
    "zoomOut",
    "zoomIn",
    "cut",
    "fit",
    "zoomedOut",
    "inOutIn",
  ])
    if (
      p === "dragSection"
        ? section && want(p)
        : p === "dragSnap"
          ? snap && want(p)
          : want(p) || (p.startsWith("zoom") && p !== "zoomedOut" && want("zoom")) || (p === "fit" && want("zoomedOut"))
    )
      ran.push(p);
  // every pass from 100 % (the timed steps before leave the camera wherever they ended), where reveal keeps it
  const at100 = async () => {
    await h.page.locator('span.zoom[data-tip="Zoom to 100%"]').click();
    await still(h);
  };
  // out to 0.45 one step at a time, each to its stop: the camera eases to a wheel's target, so a loop that reads the zoom
  // between quick steps overshoots into the summary cut's detent
  const outTo045 = async () => {
    for (let i = 0; i < 40 && (await zoomOf(h)) > 0.46; i++) {
      await ctrlWheel(h, 10);
      await still(h);
    }
  };
  // ...and the world rastered at 100 % again: the board keeps the scale it last rastered at until a zoom in passes it or a zoom
  // out halves it (Canvas.tsx), so what a pass rasters depends on where the camera stopped before. Out to 0.45 and back to 100 %
  // rasters it at 100 % on every build (older ones rastered at every stop)
  const fresh = async () => {
    await at100();
    await outTo045();
    await at100();
    await focusCard(h, drag);
  };
  await fresh();
  if (want("drag")) {
    await focusCard(h, drag);
    const at = await grabPoint(h, drag);
    await h.page.mouse.move(at.x, at.y);
    await h.page.mouse.down();
    out.drag = await rasterPass(
      h,
      cdp,
      "drag",
      30,
      (i) => h.page.mouse.move(at.x + 4 + i * 4, at.y + 2 + i * 2, { steps: 1 }),
      () => h.page.mouse.up(),
    );
    await h.page.keyboard.press("Meta+z");
  }
  // a card dragged sideways along its row, its top snapped to the row's (a pixel of jitter for the snap to pull back): the
  // alignment guides show at every move, each move changing where the card is but not the guide along the row's top
  if (snap && want("dragSnap")) {
    await fresh();
    await focusCard(h, snap);
    const at = await grabPoint(h, snap);
    await h.page.mouse.move(at.x, at.y);
    await h.page.mouse.down();
    out.dragSnap = await rasterPass(
      h,
      cdp,
      "dragSnap",
      30,
      (i) => h.page.mouse.move(at.x + 4 + i * 4, at.y + (i % 2), { steps: 1 }),
      () => h.page.mouse.up(),
    );
    await h.page.keyboard.press("Meta+z");
  }
  // a Section dragged by its title, with its cards and the Section inside it (#159 lifted dragged cards; a Section's frame,
  // title and cards moved by its drag are lifted the same way)
  if (section && want("dragSection")) {
    await fresh();
    await focusCard(h, section.near);
    const at = await h.page.evaluate((id) => {
      const r = document.querySelector(`.slabel[data-sect="${id}"] .dots`)!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, section.id);
    await h.page.mouse.move(at.x, at.y);
    await h.page.mouse.down();
    out.dragSection = await rasterPass(
      h,
      cdp,
      "dragSection",
      30,
      (i) => h.page.mouse.move(at.x + 4 + i * 4, at.y + 2 + i * 2, { steps: 1 }),
      () => h.page.mouse.up(),
    );
    await h.page.keyboard.press("Meta+z");
  }
  await fresh();
  const spot = await emptySpot(h);
  await h.page.mouse.move(spot.x, spot.y);
  if (want("pan")) out.pan = await rasterPass(h, cdp, "pan", 20, (i) => h.page.mouse.wheel(i % 3 ? 0 : 60, 40));
  // a pan at rest just above the summary cut (in the detent's reach, the card level shown), stepped out there from 100 %
  if (want("nearCut")) {
    await fresh();
    await h.page.mouse.move(spot.x, spot.y);
    for (let i = 0; i < 60 && (await zoomOf(h)) > 0.34; i++) {
      await ctrlWheel(h, 6);
      await still(h);
    }
    await rest(h);
    if (process.argv.includes("--steps")) console.log(`  nearCut: at ${(await zoomOf(h)).toFixed(3)}`);
    // panned by fractions of a pixel too (a trackpad's), and the pointer moved over the cards in between (hovered, a card is
    // painted again)
    const box = await h.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    out.nearCut = await rasterPass(h, cdp, "nearCut", 20, (i) =>
      i % 2
        ? h.page.mouse.move(box.w * (0.2 + 0.06 * (i % 10)), box.h * (0.3 + 0.04 * (i % 7)), { steps: 4 })
        : h.page.mouse.wheel(i % 3 ? 0.4 : 80.6, 50.3),
    );
  }
  // camera stops: from where the card is revealed (100 %), each step a small zoom (±4) and a rest: what a stop costs
  if (want("stops")) {
    await fresh();
    await h.page.mouse.move(spot.x, spot.y);
    out.stops = await rasterPass(h, cdp, "stops", 6, async (i) => {
      await ctrlWheel(h, i % 2 ? 4 : -4);
      await rest(h);
    });
  }
  if (want("zoom")) {
    await fresh();
    await h.page.mouse.move(spot.x, spot.y);
    out.zoomOut = await rasterPass(h, cdp, "zoomOut", 8, () => ctrlWheel(h, 30));
    out.zoomIn = await rasterPass(h, cdp, "zoomIn", 8, () => ctrlWheel(h, -30));
  }
  // across the summary cut: from 0.45 at rest (half a mouse-wheel notch out of the detent's reach), mouse-wheel notches out
  // (deltaY 100: one pushes through the detent) to below 0.27, so the summary columns come in while the camera moves
  if (want("cut")) {
    await fresh();
    await h.page.mouse.move(spot.x, spot.y);
    await outTo045();
    out.cut = await rasterPass(h, cdp, "cut", 4, async () => {
      if ((await zoomOf(h)) <= 0.27) return;
      await ctrlWheel(h, 100);
      await still(h);
    });
  }
  // Fit to Window from 100 %, the world rastered there: the camera flies out 8x (persona) to 19x (synthetic)
  if (want("fit") || want("zoomedOut")) {
    await fresh();
    out.fit = await rasterPass(h, cdp, "fit", 1, () => h.page.locator('button[aria-label="Fit to Window"]').click());
  }
  if (want("zoomedOut")) {
    // zoomed in around the summaries (their first column), so they stay in view
    const s2 = await h.page.evaluate(() => {
      const r = document.querySelector(".sumcol")?.getBoundingClientRect();
      return r && r.width ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) } : null;
    });
    if (s2) await h.page.mouse.move(s2.x, s2.y);
    // in from the fit with small steps (a trackpad's) to 0.2, below the summary cut (at most 0.3) and out of the detent's reach
    let i = 0;
    out.zoomedOut = await rasterPass(h, cdp, "zoomedOut", 1, async () => {
      for (; i < 80 && (await zoomOf(h)) < 0.2; i++) {
        await ctrlWheel(h, -5);
        await raf(h);
      }
    });
  }
  // in, out past the summary cut and back: from Fit, mouse-wheel notches in to 250 % (the world rastered again there, magnified),
  // then in one go out below the cut, where Chromium rasters the world again on its own; at rest there, a quick pinch back in to
  // ~150 % (steps with no frame between them: the camera stops only there). Judged at rest there: the world rastered at the scale it is shown at, not at the one it had below the cut
  if (want("inOutIn")) {
    await fresh();
    await h.page.locator('button[aria-label="Fit to Window"]').click();
    await rest(h);
    const fitSpot = await emptySpot(h);
    await h.page.mouse.move(fitSpot.x, fitSpot.y);
    for (let i = 0; i < 40 && (await zoomOf(h)) < 2.4; i++) {
      await ctrlWheel(h, -30);
      await raf(h);
    }
    await rest(h);
    const zIn = await zoomOf(h);
    const inSpot = await emptySpot(h);
    await h.page.mouse.move(inSpot.x, inSpot.y);
    // mouse-wheel notches with no frame between them (deltaY 100 each: one pushes through the detent), so the camera does not
    // stop on the way, where the world would be rastered again at half its scale and the stop below the cut would not matter
    for (let i = 0; i < 12 && (await zoomOf(h)) > 0.2; i++) await ctrlWheel(h, 100);
    await rest(h);
    if (process.argv.includes("--steps"))
      console.log(`  inOutIn: in to ${zIn.toFixed(3)}, out to ${(await zoomOf(h)).toFixed(3)}`);
    // back in around the card dragged above (swapped out, its box is still laid out), so the card level is in view at rest
    const back = await h.page.evaluate((id) => {
      const r = document.querySelector(`.card[data-id="${id}"]`)?.getBoundingClientRect();
      return r && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
        ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        : null;
    }, drag);
    if (back) await h.page.mouse.move(back.x, back.y);
    let i = 0;
    out.inOutIn = await rasterPass(h, cdp, "inOutIn", 1, async () => {
      for (; i < 60 && (await zoomOf(h)) < 1.25; i++) await ctrlWheel(h, -20);
    });
  }
  return { passes: out, ran };
}

/** --long editEnter / editExit: what each main-thread task over 4 ms spent its time on (events inside it over 0.8 ms) */
async function traceStart(cdp: CDPSession) {
  const events: any[] = [];
  const onData = (e: any) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack",
    transferMode: "ReportEvents",
  } as any);
  return async () => {
    const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
    await cdp.send("Tracing.end");
    await done;
    cdp.off("Tracing.dataCollected", onData);
    const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
    const on = (e: any) => main && e.pid === main.pid && e.tid === main.tid;
    for (const t of events.filter((e) => e.ph === "X" && e.name === "RunTask" && on(e) && e.dur > 4000))
      console.log(
        `  task ${(t.dur / 1000).toFixed(1)}ms:`,
        events
          .filter(
            (e) =>
              e.ph === "X" &&
              on(e) &&
              e.ts >= t.ts &&
              e.ts + e.dur <= t.ts + t.dur &&
              e.dur > 800 &&
              e.name !== "RunTask",
          )
          .map(
            (e) =>
              `${e.name}${e.args?.data?.functionName ? "(" + e.args.data.functionName + ")" : e.args?.data?.type ? "(" + e.args.data.type + ")" : ""} ${(e.dur / 1000).toFixed(1)}`,
          )
          .join(" > "),
      );
    if (process.env.LAYOUT_STACKS)
      for (const e of events.filter(
        (e) =>
          on(e) &&
          (e.name === "Layout" || e.name === "UpdateLayoutTree") &&
          e.dur > 800 &&
          (e.args?.beginData?.stackTrace || e.args?.data?.stackTrace),
      ))
        console.log(
          `  forced ${e.name} ${(e.dur / 1000).toFixed(1)}`,
          e.name === "Layout"
            ? `objs ${e.args?.beginData?.dirtyObjects}/${e.args?.beginData?.totalObjects} root depth ${JSON.stringify(e.args?.endData?.layoutRoots?.map((r: any) => r.depth))}`
            : `els ${e.args?.elementCount ?? ""}`,
          ":",
          (e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace)
            .slice(0, 6)
            .map((f: any) => `${f.functionName}@${f.lineNumber}`)
            .join(" < "),
        );
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
  await h.page.waitForFunction(() => !document.querySelector(".world")?.classList.contains("moving"), null, {
    timeout: 30000,
  });
  await raf(h);
}

// --persona: a board like the ones people study with (Linda's "Multidimensional grids", 41 cards): Notes of long Chinese prose with
// dense inline math (tens of $…$ each), display math and a big table, code cards, and Image cards of big screenshots
// (~2400 × 1800, shown ~480 px wide; smaller ones shown 280) that the real host shows as smaller copies (host/src/thumbs).
// Opened through the real host (realhost.ts) with its thumbnail worker, so load includes making the copies
const ZH = [
  "这一段讲的是网格怎么在多个维度上展开",
  "每个线程块负责输出矩阵的一小块",
  "先把全局内存里的数据搬进共享内存，再在寄存器里累加",
  "边界上不满一个块的地方要单独处理",
  "这样做的好处是访存是合并的，带宽利用率高",
  "注意步长和维度的顺序，行优先和列优先会差很多",
  "如果维度不能整除块大小，就要多发一个块",
  "调度器按顺序把块分给每个流式多处理器",
];
const MATH = [
  "$x_{i,j}$",
  "$\\mathbf{A} \\in \\mathbb{R}^{m \\times n}$",
  "$\\lceil N / B \\rceil$",
  "$\\sum_{k=0}^{K-1} a_{ik} b_{kj}$",
  "$\\text{blockIdx}.x \\cdot B + \\text{threadIdx}.x$",
  "$O(n^3)$",
  "$\\alpha \\cdot \\beta$",
  "$t \\in [0, T)$",
  "$\\frac{M}{B_m} \\times \\frac{N}{B_n}$",
  "$s = \\sqrt{d_k}$",
];
function personaNote(i: number): string {
  const para = (k: number) =>
    Array.from({ length: 9 }, (_, j) => `${ZH[(i + k + j) % ZH.length]}，${MATH[(i * 3 + k + j) % MATH.length]}`).join(
      "；",
    ) + "。";
  const table =
    i % 4 === 0
      ? [
          "| 维度 | 块大小 | 网格大小 | 每块线程 | 说明 |",
          "| --- | --- | --- | --- | --- |",
          ...Array.from(
            { length: 10 },
            (_, r) =>
              `| ${r + 1} | $B_${r} = ${2 ** (r % 6)}$ | $\\lceil N_${r} / B_${r} \\rceil$ | ${32 * (r + 1)} | ${ZH[r % ZH.length]} |`,
          ),
          "",
        ]
      : [];
  return [
    `## ${i + 1}. 多维网格 ${MATH[i % MATH.length]}`,
    "",
    para(0),
    "",
    para(1),
    "",
    "$$",
    "C_{ij} = \\sum_{k=0}^{K-1} A_{ik} B_{kj}, \\quad i < M,\; j < N",
    "$$",
    "",
    para(2),
    "",
    ...table,
    para(3),
  ].join("\n");
}
/** A screenshot-like picture: a grid, dark text-like rows and a few coloured blocks, different for each seed */
const shot = (w: number, h: number, seed: number) =>
  png(w, h, (x, y) => {
    if (x % 48 === 0 || y % 48 === 0) return [40, 40, 48, 255];
    const row = Math.floor(y / 24),
      col = Math.floor(x / 96);
    if (y % 24 > 6 && y % 24 < 14 && (row * 7 + col * 3 + seed) % 5 < 3 && x % 96 < 80) return [30, 30, 36, 255];
    if ((row + col + seed) % 11 === 0) return [200 - seed * 10, 90 + seed * 12, 60, 255];
    return [248, 247, 242, 255];
  });
/** The board and its assets/ files */
export function personaBoard(): { board: Board; assets: Record<string, Buffer> } {
  const b = emptyBoard("persona", "perf · persona");
  const assets: Record<string, Buffer> = {};
  const defs = [...files.entries()].flatMap(([f, x]) =>
    x.a.symbols.filter((s) => s.kind === "def" && s.end - s.start < 60).map((s) => ({ f, s })),
  );
  // rows like Linda's: Notes 420 wide, big images 480, small ones 280, code 560
  let y = 0;
  for (let r = 0; r < 5; r++) {
    let x = 0;
    const row: { c: Board["cards"][number]; w: number }[] = [];
    // every other Note carries a big screenshot, pasted as the host saves one (assets/<its sha1>-<w>x<h>.png)
    const note = (i: number) => {
      let md = personaNote(i);
      if (i % 2 === 0) {
        const bytes = shot(i % 4 ? 2380 : 2520, i % 4 ? 1480 : 1620, i + 20);
        const file = `${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}-${i % 4 ? 2380 : 2520}x${i % 4 ? 1480 : 1620}.png`;
        assets[file] = bytes;
        md = md.replace(/\n\n/, `\n\n![screenshot ${i}](assets/${file})\n\n`);
      }
      row.push({
        c: { id: `n${i}`, kind: "note", md, look: "note" } as Board["cards"][number],
        w: 420,
      });
    };
    note(r * 4);
    note(r * 4 + 1);
    const big = `big${r}.png`;
    assets[big] = shot(r % 2 ? 2492 : 2460, r % 2 ? 1764 : 1796, r);
    row.push({ c: { id: `i${r}`, kind: "image", src: big } as Board["cards"][number], w: 480 });
    if (r < 4) {
      const small = `small${r}.png`;
      assets[small] = shot(900, 904, r + 5);
      row.push({ c: { id: `j${r}`, kind: "image", src: small } as Board["cards"][number], w: 280 });
    }
    note(r * 4 + 2);
    note(r * 4 + 3);
    const d = defs[(r * 7) % defs.length],
      d2 = defs[(r * 7 + 3) % defs.length];
    row.push({ c: symCard(d.f, d.s), w: 560 }, { c: symCard(d2.f, d2.s), w: 560 });
    for (const { c, w } of row) {
      b.cards.push(c);
      b.place[c.id] = { x, y, w };
      x += w + 60;
    }
    y += 1100;
  }
  // Sections like Linda's: row 1 in one, with its first two Notes in a Section inside it (each frame grows to hold its cards)
  b.sections.push(
    { id: PERSONA_SECTION.id, title: "第二部分", x: -40, y: 1040, w: 400, h: 400 },
    { id: "s1a", title: "两个 Note", x: -20, y: 1080, w: 300, h: 300, parent: PERSONA_SECTION.id },
  );
  b.place.n4.section = b.place.n5.section = "s1a";
  for (const c of b.cards)
    if (b.place[c.id].y === 1100 && !b.place[c.id].section) b.place[c.id].section = PERSONA_SECTION.id;
  // arrows from each row's first Note to its code and image cards, and down to the next row
  for (let r = 0; r < 5; r++) {
    const ids = b.cards.filter((c) => b.place[c.id].y === r * 1100).map((c) => c.id);
    for (const to of ids.filter((id) => !id.startsWith("n")))
      b.links.push({ id: uid("l"), from: { card: ids[0] }, to: { card: to } });
    if (r < 4) b.links.push({ id: uid("l"), from: { card: ids[1] }, to: { card: `n${(r + 1) * 4}` } });
  }
  b.cam = { x: 80, y: 80, z: 1 };
  stampBorn(b);
  return { board: b, assets };
}

/** A point of the card that grabs it (its drag handle, not under an arrow, a button or an editor) */
async function grabPoint(h: Host, id: string) {
  return h.page.evaluate((id) => {
    const card = document.querySelector(`.card[data-id="${id}"]`)!;
    const head = (card.querySelector("[data-drag]") ?? card).getBoundingClientRect();
    for (const fy of [0.5, 0.3, 0.7, 0.1])
      for (let x = head.left + 6; x < head.right - 6; x += 6) {
        const y = head.top + Math.min(head.height, 40) * fy;
        const e = document.elementFromPoint(x, y);
        if (
          e?.closest(".card")?.getAttribute("data-id") === id &&
          e.closest("[data-drag]") &&
          !e.closest("button, .step, [contenteditable]")
        )
          return { x, y };
      }
    throw new Error(`no point to grab card ${id} by`);
  }, id);
}

/** The card the raster probes drag on the persona board: a Note with no arrows, which the timed drags (i0, n1, a code card) leave
 *  where it was. Lifted onto a layer of its own, its moves raster nothing */
const PERSONA_DRAG = "n2";
/** The Section the raster probes drag on the persona board by its title (row 1, with a Section inside it), from the camera on
 *  its first card */
const PERSONA_SECTION = { id: "s1", near: "n4" };
let personaFiles: ReturnType<typeof personaBoard> | undefined;
async function personaOnce() {
  await ready();
  personaFiles ??= personaBoard();
  const { board, assets } = personaFiles;
  const browser = await launch();
  let cdp!: CDPSession;
  const fails: string[] = [];
  const fail = (c: string, d: string) => void fails.push(`${c}: ${d.slice(0, 200)}`);
  const run = await realHost(
    [board],
    { openPage: (o) => openBoard(browser, o, { fail }), afterTest: () => {}, fail },
    {
      thumbWorker: path.join(REPO, "test-out/harness/thumbs-worker.cjs"),
      storage: process.argv.includes("--cold") ? undefined : path.join(REPO, "test-out/perf-storage"),
      page: {
        light: process.argv.includes("--light"),
        scale: +arg("scale", "1"),
        settings: THEME ? ({ theme: THEME } as any) : undefined,
        beforeLoad: async (page) => {
          cdp = await page.context().newCDPSession(page);
          await cdp.send("Performance.enable");
        },
      },
    },
  );
  const dir = run.host.store.assetsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, b] of Object.entries(assets)) fs.writeFileSync(path.join(dir, f), b);
  const res: Record<string, unknown> = {
    persona: true,
    cards: board.cards.length,
    images: board.cards.filter((c) => c.kind === "image").length,
    noteImages: board.cards.filter((c) => c.kind === "note" && c.md.includes("](assets/")).length,
    katex: [...board.cards].reduce((n, c) => n + (c.kind === "note" ? (c.md.match(/\$/g)?.length ?? 0) / 2 : 0), 0),
  };
  // The copies made first, as the host makes them when an image is saved (their time reported on its own, thumbs), in a storage
  // kept across runs (test-out/perf-storage): load and the steps then measure a board opened again, as every open after the
  // first is; --cold leaves them to be made while the board loads
  if (!process.argv.includes("--cold")) {
    const t = performance.now();
    for (const f of Object.keys(assets))
      for (const w of THUMB_WIDTHS) await run.host.hub.cx.thumbs.get(path.join(dir, f), w);
    res.thumbs = +(performance.now() - t).toFixed(0);
  }
  const t0 = performance.now();
  const h = await run.open(board.id);
  // Load: init received → all cards painted; then → the Image cards in view showing their image
  const ld = await h.page.waitForFunction(
    (n) => document.querySelectorAll(".card").length >= n && performance.now() - (window as any).__tInit,
    board.cards.length,
    { timeout: 60000 },
  );
  res.load = +(+(await ld.jsonValue())).toFixed(0);
  const shown = await h.page.waitForFunction(
    () => {
      const inView = [...document.querySelectorAll<HTMLImageElement>(".card.image img")].filter((i) => {
        const r = i.getBoundingClientRect();
        return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      });
      return (
        inView.length &&
        inView.every((i) => i.complete && i.naturalWidth) &&
        performance.now() - (window as any).__tInit
      );
    },
    null,
    { timeout: 60000 },
  );
  res.imagesShown = +(+(await shown.jsonValue())).toFixed(0);
  // the Note images in view loaded, then their decoded size (megapixels) as opened at 100%
  await h.page
    .waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLImageElement>(".card.note .md img")]
          .filter((i) => {
            const r = i.getBoundingClientRect();
            return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
          })
          .every((i) => i.complete),
      null,
      { timeout: 60000 },
    )
    .catch(() => {});
  res.noteImgMPOpen = await h.page.evaluate(
    () =>
      +(
        [...document.querySelectorAll<HTMLImageElement>(".card.note .md img")].reduce(
          (s, i) => s + i.naturalWidth * i.naturalHeight,
          0,
        ) / 1e6
      ).toFixed(1),
  );
  res.openTotal = +(performance.now() - t0).toFixed(0);
  await h.page.waitForTimeout(1500);
  // the image budget (probes.ts imageHits): images on screen decoded at more than 6x the pixels they are shown at (#161)
  const seen = await h.page.evaluate(pageMeasure);
  const hits = imageHits(seen.imgs, seen.dpr);
  res.imageBudget = { hits: hits.length, ...seen.counts, ...(hits.length ? { over: hits.slice(0, 4) } : {}) };
  const imageCheck = { name: "images over the decode budget at open", value: hits.length, limit: 0, ok: !hits.length };
  res.idleBusy1s = +(await idle(h, cdp, 1000)).toFixed(1);
  if (RASTER_ONLY) {
    const { passes: raster, ran } = await rasterProbes(h, cdp, PERSONA_DRAG, PERSONA_SECTION, PERSONA_DRAG);
    res.raster = raster;
    res.rasterChecks = [...rasterChecks(raster, "persona", ran), imageCheck];
    await run.close().catch(() => {});
    await browser.close();
    return res;
  }

  const zoomStep = async (dy: number) => {
    await h.page.keyboard.down("Control");
    await h.page.mouse.wheel(0, dy);
    await h.page.keyboard.up("Control");
  };
  await h.page.mouse.move(700, 450);
  res.pan = sum(await steps(h, cdp, 60, async (i) => void (await h.page.mouse.wheel(i % 3 ? 0 : 60, 40)), "pan"));
  res.zoom = sum(await steps(h, cdp, 40, (i) => zoomStep(i < 20 ? 30 : -30), "zoom"));
  res.pinch = sum(await steps(h, cdp, 100, (i) => zoomStep(i < 50 ? 5 : -5), "pinch"));
  // From card level (100%) out through the summary cut to the smallest zoom, and back in; the rest after each direction is in
  // the measured window, so the re-raster when the camera stops is in it too
  await focusCard(h, "n0");
  res.zoomOutIn = sum(
    await steps(
      h,
      cdp,
      62,
      async (i) => {
        if (i === 30 || i === 61) await h.page.waitForTimeout(1500);
        else await zoomStep(i < 30 ? 40 : -40);
      },
      "zoomOutIn",
    ),
  );
  // Drag an Image card, a Note and a code card (the drag does not commit: undone after, so each starts from the same board)
  for (const [name, id] of [
    ["dragImage", "i0"],
    ["dragNote", "n1"],
    ["dragCode", board.cards.find((c) => c.kind === "code")!.id],
  ] as const) {
    await focusCard(h, id);
    const at = await grabPoint(h, id);
    await h.page.mouse.move(at.x, at.y);
    await h.page.mouse.down();
    res[name] = sum(await steps(h, cdp, 60, (i) => h.page.mouse.move(at.x + i * 4, at.y + i * 2, { steps: 1 }), name));
    await h.page.mouse.up();
    await h.page.waitForTimeout(600);
  }
  if (!process.argv.includes("--no-raster")) {
    // the three drags put back, so the raster probes see the board as opened (as with --raster)
    for (let k = 0; k < 3; k++) await h.page.keyboard.press("Meta+z");
    const { passes: raster, ran } = await rasterProbes(h, cdp, PERSONA_DRAG, PERSONA_SECTION, PERSONA_DRAG);
    res.raster = raster;
    res.rasterChecks = [...rasterChecks(raster, "persona", ran), imageCheck];
  } else res.rasterChecks = [imageCheck];
  res.dom = await h.page.evaluate(() => ({
    katex: document.querySelectorAll(".katex").length,
    imgMP: +(
      [...document.querySelectorAll<HTMLImageElement>(".card.image img")].reduce(
        (s, i) => s + i.naturalWidth * i.naturalHeight,
        0,
      ) / 1e6
    ).toFixed(1),
    // the Note images' decoded size (megapixels): the originals, or the copies they show
    noteImgMP: +(
      [...document.querySelectorAll<HTMLImageElement>(".card.note .md img")].reduce(
        (s, i) => s + i.naturalWidth * i.naturalHeight,
        0,
      ) / 1e6
    ).toFixed(1),
  }));
  res.heapMB = +(((await cdp.send("Runtime.getHeapUsage")) as any).usedSize / 2 ** 20).toFixed(0);
  if (fails.length) res.fails = fails.slice(0, 8);
  await run.close().catch(() => {});
  await browser.close();
  return res;
}
void (async () => {
  const all: Record<string, unknown>[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = process.argv.includes("--persona") ? await personaOnce() : await once();
    console.log(JSON.stringify(r));
    all.push(r);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
})();
