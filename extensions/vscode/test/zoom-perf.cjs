// Manual E2E_FLOW (not in CI): zoom a dense board through the summary cut in the real VS Code and measure the webview's frames:
// Ctrl+wheel steps over the board (24 out from about 100 % to the minimum, 12 back in), the rAF gaps the webview sees and the
// renderer main thread's tasks from a trace (frame p95 / p99, the longest task of each step with STEPS=1, what was in each long task).
// The workspace holds the one board to measure (E2E_WS; Open Board opens the first board):
//   E2E_WS=/path/to/ws E2E_FLOW=extensions/vscode/test/zoom-perf.cjs E2E_TMP=/tmp/zoom-perf npm run e2e
// RUNS=<n> (2) gestures, TAIL=<ms> (1200) traced after the last step, TRACE_OUT=1 keeps the raw traces (TRACE_CATS=cc,viz adds categories); PERF_CSS=<rules> injects styles to try a change; LAYERS=1 lists the compositor layers at the end; results in test-out/<theme>/zoom-perf/
const fs = require("node:fs");
const path = require("node:path");
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
// rests between the gestures, so a stop's work (the re-raster at the new scale) is in the trace and over before the next gesture
const SETTLED = 1500;
const BETWEEN = 800;
const TAIL = +(process.env.TAIL || 1200);
const stat = (xs) => ({
  n: xs.length,
  p50: +pct(xs, 50).toFixed(1),
  p95: +pct(xs, 95).toFixed(1),
  p99: +pct(xs, 99).toFixed(1),
  max: +Math.max(0, ...xs).toFixed(1),
  over16: xs.filter((x) => x > 16.7).length,
});
module.exports = async (page, t) => {
  const OUT = process.env.PERF_OUT || path.join(t.OUT, "zoom-perf");
  fs.mkdirSync(OUT, { recursive: true });
  await t.openBoard(page);
  const f = await t.boardFrame(page);
  await t.until(
    "the board's cards are mounted",
    () =>
      f
        .locator(".card")
        .count()
        .then((n) => n >= 30),
    60000,
  );
  await t.idle(f);
  // PERF_CSS=<rules>: style rules injected into the board before the gesture, to try a change without a build
  if (process.env.PERF_CSS) await f.addStyleTag({ content: process.env.PERF_CSS });
  await t.fit(f);
  await t.hold(SETTLED, "the fit's zoom animation ends and the world is rastered at its scale before the steps start");
  const box = await (await f.frameElement()).boundingBox();
  // an empty spot: center-ish of the frame, away from the toolbar
  const spot = [box.x + box.width * 0.5, box.y + box.height * 0.55];
  await page.mouse.move(spot[0], spot[1]);
  const raf = () => f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const info = await f.evaluate(() => ({
    cards: document.querySelectorAll(".card").length,
    world: document.querySelector(".world")?.style.transform,
    board: document.querySelector(".board")?.className,
    dpr: devicePixelRatio,
    w: innerWidth,
    h: innerHeight,
  }));
  console.log("  board:", JSON.stringify(info));
  await page.screenshot({ path: path.join(OUT, "fit.png") });

  const tracer = await page.context().browser().newBrowserCDPSession();
  const gesture = async (name, n, delta, rest = 0) => {
    const events = [];
    const onData = (d) => events.push(...d.value);
    tracer.on("Tracing.dataCollected", onData);
    const done = new Promise((r) => tracer.once("Tracing.tracingComplete", r));
    await tracer.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        // TRACE_CATS=cc,viz: more categories (the compositor's and the display compositor's own events), for the raw traces
        includedCategories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          ...(process.env.TRACE_CATS ? process.env.TRACE_CATS.split(",") : []),
        ],
      },
    });
    await f.evaluate(() => {
      const w = window;
      w.__gaps = [];
      let last = performance.now();
      const tick = (ts) => {
        w.__gaps.push(ts - last);
        last = ts;
        w.__raf = requestAnimationFrame(tick);
      };
      w.__raf = requestAnimationFrame(tick);
    });
    // Control held for the whole gesture, one wheel notch per step, paced by the webview's frames: the step's mark, the notch, two
    // animation frames (the handler's frame and the next), then the camera read and the next mark in one round trip, so the steps
    // come about as fast as a wheel's notches do (two frames apart) and no step's work is counted against another's
    const cams = [];
    await page.keyboard.down("Control");
    await f.evaluate(() => console.timeStamp("perf-step"));
    for (let i = 0; i < n; i++) {
      await page.mouse.wheel(0, delta(i));
      cams.push(
        await f.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const s = `${document.querySelector(".world")?.style.transform} ${document.querySelector(".board")?.className}`;
                  console.timeStamp("perf-step");
                  r(s);
                }),
              ),
            ),
        ),
      );
      if (rest) await t.hold(rest, "the camera stops after each step: the stop's work is what this step measures");
    }
    await page.keyboard.up("Control");
    await t.hold(TAIL, "the camera stops after the last step: its re-raster belongs to the gesture");
    const gaps = await f.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      return window.__gaps.slice(1);
    });
    await tracer.send("Tracing.end");
    await done;
    tracer.off("Tracing.dataCollected", onData);
    if (process.env.TRACE_OUT) fs.writeFileSync(path.join(OUT, `${name}-${Date.now()}.json`), JSON.stringify(events));
    // the webview's renderer main thread: the one that logged our marks
    const marksAll = events.filter((e) => e.name === "TimeStamp" && e.args?.data?.message === "perf-step");
    const main = marksAll[0];
    const onMain = (e) => !!main && e.pid === main.pid && e.tid === main.tid;
    const tasks = events.filter((e) => e.ph === "X" && e.name === "RunTask" && onMain(e) && e.dur > 1000);
    const marks = marksAll
      .filter(onMain)
      .map((e) => e.ts)
      .sort((a, b) => a - b);
    const perStep = marks
      .slice(0, -1)
      .map((ts, i) => Math.max(0, ...tasks.filter((e) => e.ts >= ts && e.ts < marks[i + 1]).map((e) => e.dur / 1000)));
    const pace = marks.slice(1).map((ts, i) => (ts - marks[i]) / 1000);
    if (process.env.STEPS) perStep.forEach((ms, i) => console.log(`  ${name} #${i} ${ms.toFixed(1)}ms ${cams[i]}`));
    const long = tasks
      .filter((e) => e.dur > 16700)
      .map((tk) => {
        const inner = events
          .filter(
            (e) =>
              e.ph === "X" &&
              onMain(e) &&
              e.ts >= tk.ts &&
              e.ts + e.dur <= tk.ts + tk.dur &&
              e.dur > 1500 &&
              e.name !== "RunTask",
          )
          .sort((a, b) => b.dur - a.dur)
          .slice(0, 8)
          .sort((a, b) => a.ts - b.ts)
          .map(
            (e) =>
              `${e.name}${e.args?.data?.functionName ? `(${e.args.data.functionName})` : ""} ${(e.dur / 1000).toFixed(1)}`,
          );
        return `${(tk.dur / 1000).toFixed(0)}ms: ${inner.join(" > ")}`;
      });
    // other renderer threads' tasks in the same window (the workbench's), for reference
    const others = events.filter((e) => e.ph === "X" && e.name === "RunTask" && !onMain(e) && e.dur > 16700).length;
    const r = {
      name,
      tasks: stat(tasks.map((e) => e.dur / 1000)),
      gaps: stat(gaps),
      step: stat(perStep),
      pace: stat(pace),
      long,
      otherLong: others,
      pid: main?.pid,
    };
    console.log(
      `  ${name}: tasks p95 ${r.tasks.p95} p99 ${r.tasks.p99} max ${r.tasks.max} over16 ${r.tasks.over16}/${r.tasks.n}; gaps p95 ${r.gaps.p95} p99 ${r.gaps.p99} max ${r.gaps.max} n ${r.gaps.n}; steps ${perStep.length} every ${r.pace.p50}–${r.pace.p95} ms`,
    );
    for (const l of long) console.log("    long", l);
    return r;
  };
  const runs = [];
  const RUNS = +(process.env.RUNS || 2);
  const d = 30,
    n = 24;
  for (let r = 0; r < RUNS; r++) {
    for (let i = 0; i < n / 2; i++) {
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -d);
      await page.keyboard.up("Control");
      await raf();
    }
    await t.hold(SETTLED, "at rest at the card level before zooming out");
    const out = await gesture("out", n, () => d);
    await t.hold(BETWEEN, "at rest at the minimum zoom before zooming back in");
    if (r === 0) await page.screenshot({ path: path.join(OUT, "out.png") });
    const back = await gesture("in", n / 2, () => -d);
    await t.hold(BETWEEN, "at rest at the card level before the fit");
    if (r === 0) await page.screenshot({ path: path.join(OUT, "in.png") });
    await t.fit(f);
    await t.hold(SETTLED, "the fit's zoom animation ends before the next run");
    await page.mouse.move(spot[0], spot[1]);
    runs.push({ out, in: back });
  }
  await tracer.detach();
  // LAYERS=1: the webview's compositor layers after the gestures (id, size, element), to match a trace's RasterTask tileData.layerId
  if (process.env.LAYERS) {
    // the webview's renderer: the board's frame, or the webview host frame around it, has the CDP session (an out-of-process
    // frame); the page's own session would list the workbench's layers only
    let cdp;
    for (const target of [f, f.parentFrame(), page]) {
      cdp = await page
        .context()
        .newCDPSession(target)
        .catch(() => null);
      if (cdp) break;
    }
    await cdp.send("DOM.enable");
    await cdp.send("DOM.getDocument", { depth: 0 });
    let layers = null;
    cdp.once("LayerTree.layerTreeDidChange", (e) => {
      layers = e.layers ?? [];
    });
    await cdp.send("LayerTree.enable");
    await t.until("the webview's compositor layers", () => !!layers, 5000);
    const rows = [];
    for (const l of layers) {
      let desc = "";
      if (l.backendNodeId)
        desc = await cdp
          .send("DOM.describeNode", { backendNodeId: l.backendNodeId })
          .then(({ node }) => {
            const a = node.attributes ?? [];
            return `<${node.localName} class="${(a[a.indexOf("class") + 1] ?? "").slice(0, 50)}">`;
          })
          .catch(() => "");
      rows.push(
        `  layer ${l.layerId} ${l.width}x${l.height} paints ${l.paintCount} ${l.drawsContent ? "draws" : ""} ${desc}`,
      );
    }
    console.log(`  ${layers.length} compositor layers:\n${rows.join("\n")}`);
    fs.writeFileSync(path.join(OUT, "layers.txt"), rows.join("\n"));
    await cdp.detach();
  }
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ info, runs }, null, 1));
  const all = (k) => runs.flatMap((r) => [r.out, r.in]).map((g) => g[k]);
  console.log("  summary tasks:", JSON.stringify(all("tasks")));
  console.log("  summary gaps:", JSON.stringify(all("gaps")));
};
