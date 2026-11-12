// Manual E2E_FLOW (not in CI): zoom and pan a dense board in the real VS Code and measure the webview's frames.
// Each run: a pan at the card level, Ctrl+wheel steps out to the minimum zoom and back in, a pan there; each gesture followed by
// its stop (TAIL). Per gesture:
// - frames: the rAF gaps the webview sees and the renderer main thread's tasks from a trace (p95 / p99, the longest task of
//   each step with STEPS=1, what was in each long task);
// - blank frames: the window as shown (a screencast), a frame counted blank when BLANK_SHARE more of the cards in view shows
//   the bare board where the card's paper should be than at rest after the stop (tiles drawn as nothing, a card culled
//   or not drawn yet). The camera of every animation frame is recorded, so where each card is in each frame is known; frames at
//   the summary level or under the switch's mist are not judged. Counted over the steps and over the stop apart; the worst
//   frame of each run saved as a JPEG with the frame before;
// - memory after the steps and after the stop (Chromium's memory-infra dumps): the webview renderer's footprint and its
//   compositor tile memory (cc/tile_memory), the GPU process's footprint and its GPU memory.
// The workspace holds the board to measure (E2E_WS); BOARD=<board id> leaves only that board in the workspace's copy (Open Board
// opens the first board). On a Mac with its GPU (E2E_GPU=1: run.sh otherwise starts VS Code with --disable-gpu; MAC is set by
// run.sh on macOS):
//   E2E_GPU=1 E2E_WS=/path/to/ws BOARD=<id> E2E_FLOW=extensions/vscode/test/zoom-perf.cjs npm run e2e
// RUNS=<n> (2) runs, TAIL=<ms> (1200) traced after the last step, TRACE_OUT=1 keeps the raw traces (TRACE_CATS=cc,viz adds
// categories); PERF_CSS=<rules> injects styles to try a change; LAYERS=1 lists the compositor layers at the end; ZLOG=1 records
// the board's zoom log over the first run; BLANK=0 no screencast, MEM=0 no memory dumps; results in
// test-out/<theme>/zoom-perf/ (result.json, blank-<gesture>-<run>-<n>.jpg)
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
const BLANK = process.env.BLANK !== "0";
const MEM = process.env.MEM !== "0";
/** A frame is blank when this share more of the cards in view (their paper, sampled) shows the bare board than at rest (a
 *  card's own dark parts, a code block or a dark picture, read as bare in every frame): the least in the frames filmed before
 *  the first step and REST ms or more into the stop (the screencast sends a frame only when the window changed), or in all of
 *  them when there is none */
const BLANK_SHARE = 0.03;
const REST = 600;
/** The frame on screen can be this much older than the animation frame that set its camera (a long commit): a card's box is
 *  the part of it under every camera of that long before the frame and the one after */
const LAG = 250;
/** A pixel this close (max over R, G, B) to the board's background colour, and closer to it than to the card's paper, is bare
 *  board (the screencast's JPEG blurs edges and Ink Wash's paper has a grain); a card whose paper is about the board's colour
 *  (within PAPER_NEAR) is not judged */
const BG_NEAR = 14;
const PAPER_NEAR = 8;
const stat = (xs) => ({
  n: xs.length,
  p50: +pct(xs, 50).toFixed(1),
  p95: +pct(xs, 95).toFixed(1),
  p99: +pct(xs, 99).toFixed(1),
  max: +Math.max(0, ...xs).toFixed(1),
  over16: xs.filter((x) => x > 16.7).length,
});
const mb = (v) => +(v / 1048576).toFixed(1);

/** The window's frames as Chromium drew them (CDP screencast, JPEG, every frame it sends), with the wall time each was drawn */
async function screencast(page) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let on = true;
  const said = (what) => (e) => console.log(`  screencast ${what}: ${String(e.message).split("\n")[0]}`);
  cdp.on("Page.screencastFrame", (f) => {
    if (!on) return;
    frames.push({
      t: f.metadata.timestamp * 1000,
      data: f.data,
      w: f.metadata.deviceWidth,
      h: f.metadata.deviceHeight,
    });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(said("ack"));
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 85,
    everyNthFrame: 1,
    maxWidth: 1600,
    maxHeight: 1600,
  });
  return async () => {
    on = false;
    await cdp.send("Page.stopScreencast").catch(said("stop"));
    await cdp.detach().catch(said("detach"));
    return frames;
  };
}

const CAM = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/;
/** The cards with a paper of their own, where they are in the world (the board's CSS px at zoom 1), and the world's origin in
 *  the board's frame */
const cardsOf = (f) =>
  f.evaluate((cam) => {
    const world = document.querySelector(".world");
    const m = new RegExp(cam).exec(world.style.transform);
    const [x, y, z] = m ? m.slice(1).map(Number) : [0, 0, 1];
    const o = world.parentElement.getBoundingClientRect();
    const rgb = (s) => /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?/.exec(s);
    const cards = [...document.querySelectorAll(".cardlay .card")].flatMap((c) => {
      const a = rgb(getComputedStyle(c).backgroundColor);
      if (!a || (a[4] !== undefined && +a[4] < 0.95)) return [];
      const r = c.getBoundingClientRect();
      const l = (r.left - o.left - x) / z,
        t = (r.top - o.top - y) / z;
      return [{ l, t, r: l + r.width / z, b: t + r.height / z, paper: a.slice(1, 4).map(Number) }];
    });
    return { ox: o.left, oy: o.top, cards };
  }, CAM.source);

/**
 * Blank frames: in each frame of the film, the share of the cards in view whose paper shows the bare board. Where the cards are
 * comes from the camera of the animation frames around the frame's time (cams: [wall ms, the world's transform, the card level
 * swapped out or the summary switch's mist up]): each card's box under the three around it intersected, so a frame shown a frame early or late does not count
 * a card's moving edge. Frames at the summary level (the card level swapped out) or under the switch's mist (the board's
 * colour over the cards, by design) are not judged. The frames are decoded in the
 * workbench's page, after the gesture (createImageBitmap and a canvas)
 */
async function blankFrames(page, frames, box, bg, at, cams, still) {
  const cam = cams.map(([t, tr, gone]) => {
    const m = CAM.exec(tr ?? "");
    return { t, gone, x: m ? +m[1] : 0, y: m ? +m[2] : 0, z: m ? +m[3] : 1 };
  });
  const far = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const papers = at.cards.filter((c) => far(c.paper, bg) > PAPER_NEAR);
  const boxesOf = (t) => {
    let i = cam.length - 1;
    while (i > 0 && cam[i].t > t) i--; // a frame before the first animation frame recorded: the camera has not moved yet
    let j = i;
    while (j > 0 && cam[j - 1].t >= t - LAG) j--;
    const near = cam.slice(Math.max(0, j - 1), i + 2);
    if (!cam.length || near.some((c) => c.gone)) return null;
    const out = [];
    for (const c of papers) {
      let l = -Infinity,
        t = -Infinity,
        r = Infinity,
        b = Infinity;
      for (const k of near) {
        l = Math.max(l, box.x + at.ox + k.x + c.l * k.z);
        t = Math.max(t, box.y + at.oy + k.y + c.t * k.z);
        r = Math.min(r, box.x + at.ox + k.x + c.r * k.z);
        b = Math.min(b, box.y + at.oy + k.y + c.b * k.z);
      }
      // 4 px in from the edge (the JPEG's blur, the card's rounded corners), inside the board's frame
      l = Math.max(l + 4, box.x);
      t = Math.max(t + 4, box.y);
      r = Math.min(r - 4, box.x + box.width);
      b = Math.min(b - 4, box.y + box.height);
      if (r - l > 8 && b - t > 8) out.push({ l, t, r, b, paper: c.paper });
    }
    return out;
  };
  const shares = [];
  for (let from = 0; from < frames.length; from += 16)
    shares.push(
      ...(await page.evaluate(
        async ({ batch, bg, near }) => {
          const out = [];
          for (const f of batch) {
            if (!f.boxes?.length) {
              out.push(null);
              continue;
            }
            const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
            const img = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
            const c = new OffscreenCanvas(img.width, img.height);
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            const data = g.getImageData(0, 0, img.width, img.height).data;
            const k = img.width / f.w;
            const d = (i, v) =>
              Math.max(Math.abs(data[i] - v[0]), Math.abs(data[i + 1] - v[1]), Math.abs(data[i + 2] - v[2]));
            let n = 0,
              bare = 0;
            for (const b of f.boxes)
              for (let y = Math.round(b.t * k); y < Math.round(b.b * k); y += 3)
                for (let x = Math.round(b.l * k); x < Math.round(b.r * k); x += 3) {
                  const i = (y * img.width + x) * 4;
                  n++;
                  const e = d(i, bg);
                  if (e <= near && e < d(i, b.paper)) bare++;
                }
            out.push(n > 500 ? bare / n : null);
          }
          return out;
        },
        {
          batch: frames.slice(from, from + 16).map((f) => ({ data: f.data, w: f.w, boxes: boxesOf(f.t) })),
          bg,
          near: BG_NEAR,
        },
      )),
    );
  const judged = shares.filter((v) => v !== null);
  const rest = shares.filter((v, i) => v !== null && still(frames[i].t));
  const base = Math.min(...(rest.length ? rest : judged.length ? judged : [0]));
  const blank = (v) => v !== null && v - base > BLANK_SHARE;
  const runs = [];
  for (let i = 0; i < shares.length; i++) {
    if (!blank(shares[i])) continue;
    let j = i;
    while (j < shares.length && blank(shares[j])) j++;
    const worst = shares.slice(i, j).reduce((w, v, k) => (v > shares[w] ? i + k : w), i);
    runs.push({
      at: i,
      frames: j - i,
      worst,
      share: +shares[worst].toFixed(3),
      ms: +(frames[j - 1].t - frames[i].t).toFixed(0),
    });
    i = j - 1;
  }
  return { shares, runs, judged: judged.length, base: +base.toFixed(3) };
}

/** The memory-infra dumps of a trace, by process: footprint, and the compositor's tile memory and the GPU's own where they are */
function memoryOf(events, rendererPid) {
  const names = new Map();
  for (const e of events) if (e.ph === "M" && e.name === "process_name") names.set(e.pid, e.args?.name ?? "");
  const hex = (v) => (typeof v === "string" ? Number.parseInt(v, 16) : +v || 0);
  const size = (a) => hex(a?.attrs?.size?.value);
  const dumps = new Map();
  for (const e of events) {
    if (e.ph !== "v" || !e.args?.dumps) continue;
    const d = e.args.dumps,
      al = d.allocators ?? {};
    const keys = Object.keys(al);
    // an allocator's size is its leaves' (a dump names every node by its path; a parent may or may not carry the sum)
    const leaves = (prefix) =>
      keys
        .filter((k) => (k === prefix || k.startsWith(`${prefix}/`)) && !keys.some((c) => c.startsWith(`${k}/`)))
        .reduce((s, k) => s + size(al[k]), 0);
    const row = {
      process: e.pid === rendererPid ? "webview" : names.get(e.pid) || String(e.pid),
      footprintMB: mb(hex(d.process_totals?.private_footprint_bytes)),
      tileMB: mb(leaves("cc/tile_memory")),
      gpuMB: mb(leaves("gpu") + leaves("shared_image") + leaves("skia/gpu_resources")),
    };
    // a process's dump comes in more than one event (its totals in one, its allocators in another): one row per process
    const k = `${e.id ?? e.ts}`;
    if (!dumps.has(k)) dumps.set(k, new Map());
    const rows = dumps.get(k),
      had = rows.get(e.pid);
    if (!had) rows.set(e.pid, row);
    else for (const f of ["footprintMB", "tileMB", "gpuMB"]) had[f] = +(had[f] + row[f]).toFixed(1);
  }
  return [...dumps.values()].map((rows) =>
    [...rows.values()].filter(
      (r) =>
        (r.footprintMB || r.tileMB || r.gpuMB) &&
        (r.process === "webview" || /GPU/i.test(r.process) || /Browser/i.test(r.process)),
    ),
  );
}

module.exports = async (page, t) => {
  const OUT = process.env.PERF_OUT || path.join(t.OUT, "zoom-perf");
  fs.mkdirSync(OUT, { recursive: true });
  // BOARD=<id>: only that board in this run's copy of the workspace, so Open Board opens it
  if (process.env.BOARD) {
    const dir = path.join(t.WS, ".codeboard");
    for (const n of fs.readdirSync(dir))
      if (n.endsWith(".json") && n !== `${process.env.BOARD}.json`) fs.rmSync(path.join(dir, n));
  }
  await t.openBoard(page);
  const f = await t.boardFrame(page);
  await t.until(
    "the board's cards are mounted",
    () =>
      f
        .locator(".card")
        .count()
        .then((n) => n >= +(process.env.MIN_CARDS || 30)),
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
    bg: getComputedStyle(document.querySelector(".board")).backgroundColor,
  }));
  console.log("  board:", JSON.stringify(info));
  await page.screenshot({ path: path.join(OUT, "fit.png") });
  // the board's background as the screencast shows it: the colour of the frame's top-left corner area at rest is the canvas
  const bgOf = (s) => (/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(s) ?? [0, 255, 255, 255]).slice(1, 4).map(Number);
  const bg = bgOf(info.bg);

  const tracer = await page.context().browser().newBrowserCDPSession();
  const dump = () =>
    MEM
      ? tracer.send("Tracing.requestMemoryDump", { deterministic: false, levelOfDetail: "light" }).catch((e) => {
          console.log(`  memory dump: ${String(e.message).split("\n")[0]}`);
        })
      : Promise.resolve();
  const blanks = [];
  /** n steps of `delta(i)` ([dx, dy], or dy for a zoom with Ctrl held), then the stop (TAIL), traced and filmed */
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
          ...(MEM ? ["disabled-by-default-memory-infra"] : []),
          ...(process.env.TRACE_CATS ? process.env.TRACE_CATS.split(",") : []),
        ],
        ...(MEM ? { memoryDumpConfig: { triggers: [] } } : {}),
      },
    });
    const film = BLANK ? await screencast(page) : null;
    // where the cards are, and the camera of every animation frame (wall time, as the film's), for the blank frames
    const at = BLANK ? await cardsOf(f) : null;
    await f.evaluate(() => {
      const w = window;
      w.__gaps = [];
      w.__cams = [];
      const world = document.querySelector(".world"),
        lay = document.querySelector(".cardlay"),
        mist = document.querySelector(".cutmist");
      let last = performance.now();
      const tick = (ts) => {
        w.__gaps.push(ts - last);
        w.__cams.push([
          performance.timeOrigin + ts,
          world?.style.transform,
          !!lay?.classList.contains("gone") || !!mist?.classList.contains("on"),
        ]);
        last = ts;
        w.__raf = requestAnimationFrame(tick);
      };
      w.__raf = requestAnimationFrame(tick);
    });
    // one wheel notch per step (Control held for a zoom), paced by the webview's frames: the step's mark, the notch, two
    // animation frames (the handler's frame and the next), then the camera read and the next mark in one round trip, so the steps
    // come about as fast as a wheel's notches do (two frames apart) and no step's work is counted against another's
    const cams = [];
    const zoom = typeof delta(0) === "number";
    if (zoom) await page.keyboard.down("Control");
    const stepsAt = Date.now();
    await f.evaluate(() => console.timeStamp("perf-step"));
    for (let i = 0; i < n; i++) {
      const d = delta(i);
      if (zoom) await page.mouse.wheel(0, d);
      else await page.mouse.wheel(d[0], d[1]);
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
    if (zoom) await page.keyboard.up("Control");
    // the screencast's timestamps are wall time: frames from here on are the stop's
    const stopAt = Date.now();
    await dump();
    await t.hold(TAIL, "the camera stops after the last step: its re-raster belongs to the gesture");
    await dump();
    const { gaps, cams: frameCams } = await f.evaluate(() => {
      cancelAnimationFrame(window.__raf);
      return { gaps: window.__gaps.slice(1), cams: window.__cams };
    });
    const filmed = film ? await film() : [];
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
    // blank frames: the worst frame of each run saved, with the frame before it
    const blank = filmed.length
      ? await blankFrames(page, filmed, box, bg, at, frameCams, (t) => t < stepsAt || t >= stopAt + REST)
      : { shares: [], runs: [], judged: 0, base: 0 };
    for (const [k, r] of blank.runs.slice(0, 4).entries()) {
      const file = path.join(OUT, `blank-${name}-${blanks.length}-${k}.jpg`);
      fs.writeFileSync(file, Buffer.from(filmed[r.worst].data, "base64"));
      if (r.at > 0)
        fs.writeFileSync(file.replace(/\.jpg$/, "-before.jpg"), Buffer.from(filmed[r.at - 1].data, "base64"));
    }
    const memory = MEM ? memoryOf(events, main?.pid) : [];
    const r = {
      name,
      tasks: stat(tasks.map((e) => e.dur / 1000)),
      gaps: stat(gaps),
      step: stat(perStep),
      pace: stat(pace),
      frames: filmed.length,
      judgedFrames: blank.judged,
      bareBase: blank.base,
      blankFrames: blank.runs.reduce((s, x) => s + x.frames, 0),
      stopBlankFrames: blank.runs.filter((x) => filmed[x.at].t >= stopAt).reduce((s, x) => s + x.frames, 0),
      blankRuns: blank.runs,
      bareMax: +Math.max(0, ...blank.shares.filter((v) => v !== null)).toFixed(3),
      // after the steps, after the stop
      memory,
      long,
      otherLong: others,
      pid: main?.pid,
    };
    blanks.push(r.blankFrames);
    console.log(
      `  ${name}: tasks p95 ${r.tasks.p95} p99 ${r.tasks.p99} max ${r.tasks.max} over16 ${r.tasks.over16}/${r.tasks.n}; gaps p95 ${r.gaps.p95} p99 ${r.gaps.p99} max ${r.gaps.max} n ${r.gaps.n}; steps ${perStep.length} every ${r.pace.p50}–${r.pace.p95} ms`,
    );
    if (BLANK)
      console.log(
        `    blank: ${r.blankFrames} of ${r.judgedFrames} frames judged (${r.frames} filmed; ${r.stopBlankFrames} in the stop), worst ${r.bareMax} of the cards bare (at rest ${r.bareBase}), in ${r.blankRuns.length} runs ${JSON.stringify(r.blankRuns.slice(0, 6))}`,
      );
    for (const [i, d] of memory.entries())
      console.log(`    memory ${i ? "after the stop" : "after the steps"}: ${JSON.stringify(d)}`);
    for (const l of long) console.log("    long", l);
    return r;
  };
  // ZLOG=1: the board's own zoom log (state/zoomlog.ts: per-frame camera lines, cull, the level switch, the summary build, long
  // tasks) recorded over the first run through the host's Record Zoom Log command, copied from the clipboard into zoom-log.txt
  const ZLOG = !!process.env.ZLOG;
  const zoomLog = async () => {
    await t.command(page, "CodeBoard: Record Zoom Log");
    await page.mouse.move(spot[0], spot[1]);
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
    if (ZLOG && r === 0) await zoomLog();
    // a pan at the card level, about 100 %: wheel steps right and down
    const pan = await gesture("pan", 24, () => [60, 20]);
    await t.hold(BETWEEN, "at rest after the pan before zooming out");
    const out = await gesture("out", n, () => d);
    await t.hold(BETWEEN, "at rest at the minimum zoom before zooming back in");
    if (r === 0) await page.screenshot({ path: path.join(OUT, "out.png") });
    const back = await gesture("in", n / 2, () => -d);
    await t.hold(BETWEEN, "at rest at the card level before the pan back");
    if (r === 0) await page.screenshot({ path: path.join(OUT, "in.png") });
    // a pan at the zoom the pinch back in stopped at (the card level just above the cut, or 100 % on a small board)
    const panOut = await gesture("panZoomedOut", 24, () => [-60, -20]);
    await t.hold(BETWEEN, "at rest after the pan before the fit");
    if (ZLOG && r === 0) {
      await zoomLog();
      const log = await t.clipboard(f);
      fs.writeFileSync(path.join(OUT, "zoom-log.txt"), log);
      const lines = log.split("\n");
      console.log(`  zoom log: ${lines.length} lines; events: ${lines.filter((l) => !/^f /.test(l)).join(" | ")}`);
    }
    await t.fit(f);
    await t.hold(SETTLED, "the fit's zoom animation ends before the next run");
    await page.mouse.move(spot[0], spot[1]);
    runs.push({ pan, out, in: back, panZoomedOut: panOut });
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
  const gestures = runs.flatMap((r) => Object.values(r));
  const all = (k) => gestures.map((g) => g[k]);
  console.log("  summary tasks:", JSON.stringify(all("tasks")));
  console.log("  summary gaps:", JSON.stringify(all("gaps")));
  if (BLANK)
    console.log(
      "  summary blank frames:",
      JSON.stringify(
        Object.fromEntries(
          gestures.map((g, i) => [
            `${g.name}#${Math.floor(i / 4)}`,
            `${g.blankFrames}/${g.frames} (stop ${g.stopBlankFrames})`,
          ]),
        ),
      ),
    );
};
