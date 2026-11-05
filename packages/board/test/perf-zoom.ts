// Zoom frames on a real board: opens a board of a project's .codeboard/ folder in the real host (realhost.ts: the project folder
// is the storage, as in VS Code), fits it, then zooms out past the summary cut to the minimum and back in with Ctrl+wheel steps
// (a mouse: 30 per step; --pinch: trackpad steps of 5), and reports the frames: every main-thread task of the renderer while the
// gesture runs (a task over 16.7 ms drops a frame), p50 / p95 / p99 / max, and the same per step.
// Usage: node packages/board/test/run-perf-zoom.mjs --root <project dir> --board <id> [--runs 2] [--pinch] [--json out.json] [--steps]
import * as fs from "node:fs";
import * as path from "node:path";
import type { CDPSession } from "playwright-core";
import { launch, openBoard, type Host, type OpenOptions } from "./harness";
import { realHost } from "./realhost";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ROOT = path.resolve(arg("root", "")),
  BOARD = arg("board", ""),
  RUNS = +arg("runs", "1"),
  PINCH = process.argv.includes("--pinch"),
  STEPS = process.argv.includes("--steps"),
  JSON_OUT = arg("json", "");
if (!ROOT || !BOARD) throw new Error("--root <project dir> --board <id>");

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stat = (xs: number[]) => ({
  n: xs.length,
  p50: +pct(xs, 50).toFixed(1),
  p95: +pct(xs, 95).toFixed(1),
  p99: +pct(xs, 99).toFixed(1),
  max: +Math.max(0, ...xs).toFixed(1),
  over16: xs.filter((x) => x > 16.7).length,
});
const raf = (h: Host) =>
  h.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** n wheel steps, traced: the renderer's main-thread tasks (one per frame when the frame is busy) */
async function gesture(h: Host, cdp: CDPSession, name: string, n: number, delta: (i: number) => number, rest = 0) {
  const events: any[] = [];
  const onData = (e: any) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", {
    // TRACE_CATS=cc,…: more categories (cc: the compositor's own events)
    categories: `devtools.timeline,disabled-by-default-devtools.timeline${process.env.TRACE_CATS ? `,${process.env.TRACE_CATS}` : ""}`,
    transferMode: "ReportEvents",
  } as any);
  // the frames the page itself sees: the gaps between animation frames while the gesture runs
  await h.page.evaluate(() => {
    const w = window as any;
    w.__gaps = [];
    let last = performance.now();
    const tick = (t: number) => {
      w.__gaps.push(t - last);
      last = t;
      w.__raf = requestAnimationFrame(tick);
    };
    w.__raf = requestAnimationFrame(tick);
  });
  const marks: number[] = [];
  const cams: string[] = [];
  for (let i = 0; i < n; i++) {
    await h.page.evaluate(() => console.timeStamp("perf-step"));
    await h.page.keyboard.down("Control");
    await h.page.mouse.wheel(0, delta(i));
    await h.page.keyboard.up("Control");
    await raf(h);
    if (rest) await h.page.waitForTimeout(rest);
    if (STEPS)
      cams.push(
        await h.page.evaluate(
          () =>
            `${(document.querySelector(".world") as HTMLElement)?.style.transform} ${document.querySelector(".board")?.className}`,
        ),
      );
  }
  // --tail <ms>: keep tracing this long after the last step (the camera stops, the world is rastered again at the new scale)
  if (+arg("tail", "0")) await h.page.waitForTimeout(+arg("tail", "0"));
  const gaps: number[] = await h.page.evaluate(() => {
    const w = window as any;
    cancelAnimationFrame(w.__raf);
    return w.__gaps.slice(1);
  });
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", onData);
  // TRACE_OUT=<dir>: the raw trace of each gesture, for a closer look
  if (process.env.TRACE_OUT) {
    fs.mkdirSync(process.env.TRACE_OUT, { recursive: true });
    fs.writeFileSync(path.join(process.env.TRACE_OUT, `${name}-${Date.now()}.json`), JSON.stringify(events));
  }
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  const onMain = (e: any) => !!main && e.pid === main.pid && e.tid === main.tid;
  const tasks = events.filter((e) => e.ph === "X" && e.name === "RunTask" && onMain(e) && e.dur > 1000);
  for (const e of events)
    if (e.name === "TimeStamp" && e.args?.data?.message === "perf-step" && onMain(e)) marks.push(e.ts);
  marks.sort((a, b) => a - b);
  // each step's longest task, from its mark to the next
  const perStep = marks.map((ts, i) =>
    Math.max(0, ...tasks.filter((e) => e.ts >= ts && e.ts < (marks[i + 1] ?? Infinity)).map((e) => e.dur / 1000)),
  );
  // RASTER=1 (with TRACE_CATS=cc): which compositor layers were rastered in each step, and for how long (RasterTask events
  // carry the layer id; the LayerTree listing names them)
  const rasters = process.env.RASTER
    ? marks.map((ts, i) => {
        const by = new Map<number, { n: number; ms: number }>();
        for (const e of events)
          if (e.name === "RasterTask" && e.ts >= ts && e.ts < (marks[i + 1] ?? ts + 3_000_000)) {
            const id = e.args?.tileData?.layerId ?? -1;
            const o = by.get(id) ?? { n: 0, ms: 0 };
            o.n++;
            o.ms += e.dur / 1000;
            by.set(id, o);
          }
        return [...by]
          .sort((a, b) => b[1].ms - a[1].ms)
          .map(([id, o]) => `L${id}:${o.n}t/${o.ms.toFixed(0)}ms`)
          .join(" ");
      })
    : [];
  // PAINTS=1: which elements Blink painted in each step (a Paint event per invalidated element, with its node)
  const paints: string[] = [];
  if (process.env.PAINTS) {
    await cdp.send("DOM.enable");
    const names = new Map<number, string>();
    for (let i = 0; i < marks.length; i++) {
      const by = new Map<number, number>();
      for (const e of events)
        if (
          e.name === "Paint" &&
          onMain(e) &&
          e.args?.data?.nodeId &&
          e.ts >= marks[i] &&
          e.ts < (marks[i + 1] ?? marks[i] + 3_000_000)
        )
          by.set(e.args.data.nodeId, (by.get(e.args.data.nodeId) ?? 0) + 1);
      const parts: string[] = [];
      for (const [id, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        if (!names.has(id))
          try {
            const { node } = await cdp.send("DOM.describeNode", { backendNodeId: id });
            const attrs = node.attributes ?? [];
            names.set(
              id,
              `${node.localName}.${(attrs[attrs.indexOf("class") + 1] ?? "").slice(0, 24).replace(/ /g, ".")}`,
            );
          } catch {
            names.set(id, `node${id}`);
          }
        parts.push(`${names.get(id)}×${n}`);
      }
      paints.push(parts.join(" "));
    }
  }
  if (STEPS)
    perStep.forEach((t, i) =>
      console.log(
        `  ${name} #${i} ${t.toFixed(1)}ms ${cams[i]}${rasters[i] ? `\n      raster ${rasters[i]}` : ""}${paints[i] ? `\n      paint ${paints[i]}` : ""}`,
      ),
    );
  const long = tasks
    .filter((e) => e.dur > 16700)
    .map((t) => {
      const inner = events
        .filter(
          (e) =>
            e.ph === "X" &&
            onMain(e) &&
            e.ts >= t.ts &&
            e.ts + e.dur <= t.ts + t.dur &&
            e.dur > 1500 &&
            e.name !== "RunTask",
        )
        .sort((a, b) => a.ts - b.ts);
      // the biggest events inside it, nested ones included
      const parts = [...inner]
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 10)
        .sort((a, b) => a.ts - b.ts)
        .map(
          (e) =>
            `${e.name}${e.args?.data?.functionName ? `(${e.args.data.functionName})` : ""} ${(e.dur / 1000).toFixed(1)}`,
        );
      return `${(t.dur / 1000).toFixed(0)}ms: ${parts.join(" > ")}`;
    });
  // NODES=1: which elements were painted most often during the gesture (an element painted on every step is a layer of its own
  // that Chromium paints and rasters again at every scale)
  if (process.env.NODES) {
    const by = new Map<number, { n: number; ms: number }>();
    for (const e of events)
      if (e.name === "Paint" && onMain(e) && e.args?.data?.nodeId) {
        const o = by.get(e.args.data.nodeId) ?? { n: 0, ms: 0 };
        o.n++;
        o.ms += e.dur / 1000;
        by.set(e.args.data.nodeId, o);
      }
    await cdp.send("DOM.enable");
    const top = [...by].sort((a, b) => b[1].n - a[1].n).slice(0, 30);
    for (const [id, o] of top) {
      let desc = "?";
      try {
        const { node } = await cdp.send("DOM.describeNode", { backendNodeId: id });
        const attrs = node.attributes ?? [];
        const cls = attrs[attrs.indexOf("class") + 1] ?? "";
        desc = `<${node.localName} class="${cls.slice(0, 60)}">`;
      } catch {}
      console.log(`  painted ${String(o.n).padStart(3)}× ${o.ms.toFixed(1).padStart(6)}ms  node ${id} ${desc}`);
    }
  }
  // LAYERS=1: the compositor layers after the gesture (DevTools' Layers panel: element, size, how often painted)
  if (process.env.LAYERS) await listLayers(cdp);
  return { tasks: stat(tasks.map((e) => e.dur / 1000)), step: stat(perStep), gaps: stat(gaps), long };
}

async function listLayers(cdp: CDPSession) {
  await cdp.send("DOM.enable");
  await cdp.send("DOM.getDocument", { depth: 0 });
  const got = new Promise<any[]>((r) => cdp.once("LayerTree.layerTreeDidChange", (e: any) => r(e.layers ?? [])));
  await cdp.send("LayerTree.enable");
  const layers = await Promise.race([got, new Promise<any[]>((r) => setTimeout(() => r([]), 3000))]);
  await cdp.send("LayerTree.disable");
  await cdp.send("DOM.enable");
  const rows: string[] = [];
  for (const l of layers) {
    let desc = "";
    if (l.backendNodeId)
      try {
        const { node } = await cdp.send("DOM.describeNode", { backendNodeId: l.backendNodeId });
        const attrs = node.attributes ?? [];
        desc = `<${node.localName} class="${(attrs[attrs.indexOf("class") + 1] ?? "").slice(0, 50)}">`;
      } catch {}
    let why = "";
    try {
      const r: any = await cdp.send("LayerTree.compositingReasons", { layerId: l.layerId });
      why = (r.compositingReasonIds ?? r.compositingReasons ?? []).join(",");
    } catch (e) {
      why = `reasons? ${String(e).slice(0, 60)}`;
    }
    rows.push(
      `  layer ${String(l.layerId).padStart(4)} parent ${String(l.parentLayerId ?? "-").padStart(4)} ${String(l.width).padStart(6)}×${String(l.height).padEnd(6)} at ${l.offsetX},${l.offsetY} paints ${String(l.paintCount).padStart(4)} ${l.drawsContent ? "draws" : "     "} ${desc} ${why}`,
    );
  }
  console.log(`  ${layers.length} compositor layers:`);
  for (const r of rows) console.log(r);
}

async function main() {
  const browser = await launch();
  const t0 = performance.now();
  const run = await realHost(
    [],
    {
      openPage: (o: OpenOptions) => openBoard(browser, o, { fail: (c, d) => console.log("FAIL", c, d) }),
      afterTest: () => {},
      fail: (c, d) => console.log("FAIL", c, d),
    },
    // --dpr 2: a Retina display (text glyphs four times the pixels)
    { root: ROOT, page: { w: +arg("w", "1600"), h: +arg("h", "1000"), scale: +arg("dpr", "1"), until: "shown" } },
  );
  const h = await run.open(BOARD);
  const cdp = await h.page.context().newCDPSession(h.page);
  await h.page
    .waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 60000 })
    .catch(() => Promise.reject(new Error("no cards on the page after 60 s")));
  // settled: images loaded, Markdown rendered
  // (a Note's images load lazily: one far off screen never completes)
  await h.page
    .waitForFunction(
      () =>
        [...document.images].every((i) => {
          const r = i.getBoundingClientRect();
          return (
            i.complete ||
            r.right < -2000 ||
            r.left > innerWidth + 2000 ||
            r.bottom < -2000 ||
            r.top > innerHeight + 2000
          );
        }),
      null,
      { timeout: 20000 },
    )
    .catch(() => console.log("  (images in view still loading after 20 s)"));
  await h.page.waitForTimeout(1500);
  await h.page.locator('button[aria-label="Fit to Window"]').click();
  await h.page.waitForTimeout(1500);
  // --css "<rules>": a style to try (added to the page)
  if (arg("css", "")) await h.page.addStyleTag({ content: arg("css", "") });
  const res: Record<string, unknown> = {
    board: BOARD,
    cards: await h.page.evaluate(() => document.querySelectorAll(".card").length),
    open: +(performance.now() - t0).toFixed(0),
    z0: await h.page.evaluate(() => (document.querySelector(".world") as HTMLElement)?.style.transform),
  };
  // over empty canvas
  const spot = await h.page.evaluate(() => {
    for (let y = 120; y < 860; y += 20)
      for (let x = 80; x < 1350; x += 20) {
        const e = document.elementFromPoint(x, y);
        if (e && (e.classList.contains("board") || e.classList.contains("world"))) return [x, y];
      }
    return [700, 450];
  });
  await h.page.mouse.move(spot[0], spot[1]);
  if (process.env.LAYERS) await listLayers(cdp);
  // BIG=1: the largest boxes in the world (a huge box makes the world's compositor layer, and its tilings, huge)
  if (process.env.BIG)
    console.log(
      await h.page.evaluate(() => {
        const z = +(
          /scale\(([\d.]+)\)/.exec((document.querySelector(".world") as HTMLElement).style.transform)?.[1] ?? 1
        );
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(".world, .world *")) {
          const r = el.getBoundingClientRect();
          const w = r.width / z,
            hh = r.height / z;
          if (w > 3000 || hh > 3000)
            out.push(
              `${Math.round(w)}×${Math.round(hh)} <${el.localName} class="${el.getAttribute("class")?.slice(0, 50)}">`,
            );
        }
        return out.slice(0, 40).join("\n");
      }),
    );
  const runs: unknown[] = [];
  // --settle: what one camera stop costs: tiny zoom steps (±4) at the card level, each followed by a rest long enough for the stop's
  // re-raster (the longest main-thread task of each step)
  if (process.argv.includes("--settle")) {
    // --at <n>: this many steps of 30 in from the fit (6: about 100 %); --by <d>: the step (4: a 4 % change, 30: 35 %)
    for (let i = 0; i < +arg("at", "6"); i++) {
      await h.page.keyboard.down("Control");
      await h.page.mouse.wheel(0, -30);
      await h.page.keyboard.up("Control");
      await raf(h);
    }
    await h.page.waitForTimeout(1500);
    const by = +arg("by", "4");
    // --mono: every step zooms in (each stop at a new scale) instead of alternating between two scales
    const mono = process.argv.includes("--mono");
    const st = await gesture(h, cdp, "settle", mono ? 6 : 8, (i) => (mono || !(i % 2) ? -by : by), 900);
    console.log(`settle: step max ${st.step.p99} ${JSON.stringify(st.step)}`);
    if (arg("shot", "")) {
      await h.page.waitForTimeout(1500);
      await h.page.screenshot({ path: `${arg("shot", "")}-settle.png` });
    }
    for (const l of st.long) console.log("  long", l);
    await run.close();
    await browser.close();
    return;
  }
  for (let r = 0; r < RUNS; r++) {
    const d = PINCH ? 5 : 30,
      n = PINCH ? 120 : 24;
    // from the card level (zoomed in from the fit, which may rest below the cut) out to the minimum zoom through the summary cut,
    // then back in past the start
    // PRE=<steps>: how far in from the fit before the gesture (12: about 185 %; 6: about 100 %)
    for (let i = 0; i < +(process.env.PRE ?? n / 2); i++) {
      await h.page.keyboard.down("Control");
      await h.page.mouse.wheel(0, -d);
      await h.page.keyboard.up("Control");
      await raf(h);
    }
    await h.page.waitForTimeout(1200);
    const out = await gesture(h, cdp, "out", n, () => d);
    await h.page.waitForTimeout(800);
    // --shot <prefix>: screenshots at rest after each gesture (is the text crisp at the new scale?)
    const shot = async (tag: string) => {
      if (!arg("shot", "")) return;
      await h.page.waitForTimeout(1500);
      await h.page.screenshot({ path: `${arg("shot", "")}-${tag}.png` });
    };
    await shot(`out${r}`);
    const back = await gesture(h, cdp, "in", n / 2, () => -d);
    await h.page.waitForTimeout(800);
    await shot(`in${r}`);
    await h.page.locator('button[aria-label="Fit to Window"]').click();
    await h.page.waitForTimeout(1200);
    await h.page.mouse.move(spot[0], spot[1]);
    runs.push({ out, in: back });
    console.log(
      `run ${r} out: tasks p95 ${out.tasks.p95} p99 ${out.tasks.p99} max ${out.tasks.max} over16 ${out.tasks.over16}/${out.tasks.n}; gaps p95 ${out.gaps.p95} p99 ${out.gaps.p99}` +
        `\n      in: tasks p95 ${back.tasks.p95} p99 ${back.tasks.p99} max ${back.tasks.max} over16 ${back.tasks.over16}/${back.tasks.n}; gaps p95 ${back.gaps.p95} p99 ${back.gaps.p99}`,
    );
    for (const l of [...out.long, ...back.long]) console.log("  long", l);
  }
  res.runs = runs;
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(res, null, 1));
  await run.close();
  await browser.close();
  console.log(JSON.stringify({ board: res.board, cards: res.cards, open: res.open, z0: res.z0 }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
