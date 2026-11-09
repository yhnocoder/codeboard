#!/usr/bin/env node
// The macOS app's acceptance gate: every interaction at a full 120 Hz with no visual glitch, on copies of real boards.
//   node tools/mac-gate.mjs [--quick | --all | --boards id,id] [--data ~/Projects/persona/.codeboard] [--app <CodeBoard.app>]
//                           [--out test-out/mac-gate/<time>] [--steps pan,drag_card] [--no-capture] [--no-build] [--xctrace]
//                           [--xctrace-limit 180] [--big 250] [--keep-frames] [--max-load 4] [--wait-quiet 10] [--min-free 8] [--max-out 1]
// Builds the app (apps/macos/build.sh), copies the data folder (the originals are never opened), adds a board of --big cards made
// from the biggest one, then runs the app once per board with --gate (Gate.swift drives the window and records; nothing is judged
// there), and judges here. Timing: the display link's intervals (the main thread's pacing) are the gate, with the window
// capture's presented frames beside them; with --xctrace the Hitches instrument records each board too (at most --xctrace-limit
// seconds; the trace is deleted once its table is exported) and its hitches that fall in each step (count against the step's
// frames, hitch time in ms per second) are the gate instead (the capture falls behind at 120 Hz on full-window
// change, so its late counts overstate). Glitches: probes.ts's flashHits over the captured frames (a static region changing for
// 1–3 frames and reverting), jumpHits over the cards' rects (a still card that moved, a moving one that jumped), cards in view
// with no bitmap (blank), and a step whose input changed nothing (no_effect). Failing frames are kept under <out>/<board>/fails/,
// the rest of the capture, the app's and the data's copies are dropped once the report is written (--keep-frames keeps them).
// The run refuses to start or go on with under --min-free GB free on the disk or once it has written more than --max-out GB
// (mac-gate-disk.mjs; only its own output counts: the captures, traces and reports, not its copies of the app and the data; the
// app's caches go to a temporary folder deleted at the end), and writes <out>/sizes.txt when it stops. Each board waits (up to
// --wait-quiet minutes) for the Mac's 1-minute load to fall under --max-load first; a board started with the load above 2 is
// marked under load. Writes <out>/report.json and report.md, prints the
// table, exits 1 when any gate fails.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diskStop, dropCaptures, freeGB, hitchesRecord, outputGB, sizes } from "./mac-gate-disk.mjs";
import { flashHits, jumpHits } from "../packages/board/test/probes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

/** The gate: hitches (the instrument: a frame presented later than its deadline) under 1 % of the step's frames and under
 *  5 ms of hitch time per second (Apple's "good"); without the instrument, the display link's intervals: under 1 % late (later
 *  than 1.5 periods) and p95 within a quarter of the period (the hand-over to the main thread jitters by about 1 ms) */
const GATE = { hitchPct: 1, hitchMsPerS: 5, p95Ratio: 1.25, lateRatio: 1.5, latePct: 1 };
/** Each board waits for the Mac's 1-minute load average to fall under maxLoad, up to waitQuiet minutes; one started with the
 *  load above busy is marked under load */
const QUIET = { maxLoad: +opt("--max-load", "4"), waitQuiet: +opt("--wait-quiet", "10"), busy: 2 };
/** A continuous step's presented frames are judged when the capture saw at least this share of the driven frames change; fewer
 *  means the content stood still most of the time (an input the app has no handler for), and the display link's pacing is judged */
const PRESENTED_MIN_SHARE = 0.5;
/** The boards a quick run uses: the image-heavy one first, the biggest, and the scaled-up one */
const QUICK = ["bmvstbxlqpve8", "biggest", "big"];

const data = path.resolve(
  opt("--data", path.join(os.homedir(), "Projects/persona/.codeboard")).replace(/^~/, os.homedir()),
);
const app = path.resolve(opt("--app", path.join(root, "apps/macos/build/CodeBoard.app")));
const out = path.resolve(
  opt("--out", path.join(root, "test-out/mac-gate", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))),
);
const bigN = +opt("--big", "250");
/** Disk guards: the free space (GB) the run needs, and what it may write (GB; its copies of the app and the data don't count) */
const DISK = { minFree: +opt("--min-free", "8"), maxOut: +opt("--max-out", "1") };
const xctrace = flag("--xctrace");
const traceLimit = +opt("--xctrace-limit", "180");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const diskWhy = () => diskStop({ free: freeGB(out), used: outputGB(out, ["cbgate.app", "data"]) }, DISK);
// the app's caches (the Notes' rendered PDFs) for this run only, out of the user's ~/Library/Caches and out of <out>
const caches = fs.mkdtempSync(path.join(os.tmpdir(), "cbgate-caches-"));
process.on("exit", () => fs.rmSync(caches, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));
/** On a stop: <out>/sizes.txt, the biggest contributors to the output (and the copies and caches, marked as not counted) */
function writeSizes(why) {
  const mb = (b) => `${(b / 2 ** 20).toFixed(1).padStart(9)} MB`;
  const rows = sizes(out).map(([f, b]) => `${mb(b)}  ${f}${/^(cbgate\.app|data)\//.test(f) ? " (not counted)" : ""}`);
  const c = sizes(caches).reduce((n, [, b]) => n + b, 0);
  fs.writeFileSync(
    path.join(out, "sizes.txt"),
    [why, "", ...rows.slice(0, 40), `${mb(c)}  ${caches} (app caches, not counted)`, ""].join("\n"),
  );
}
if (diskWhy()) {
  console.error(`not starting: ${diskWhy()}`);
  process.exit(1);
}

if (!flag("--no-build")) {
  console.log("building the app…");
  execFileSync("sh", [path.join(root, "apps/macos/build.sh")], { stdio: "inherit" });
}
// the gate runs its own copy of the bundle, named cbgate: another CodeBoard on the Mac (a developer's, another check's) may be
// killed by name while the gate runs, and the instruments attach only to a process that allows it (get-task-allow; the app's own
// signing is untouched)
const gateApp = path.join(out, "cbgate.app");
fs.cpSync(app, gateApp, { recursive: true });
fs.renameSync(path.join(gateApp, "Contents/MacOS/CodeBoard"), path.join(gateApp, "Contents/MacOS/cbgate"));
const plist = path.join(gateApp, "Contents/Info.plist");
fs.writeFileSync(
  plist,
  fs
    .readFileSync(plist, "utf8")
    .replace(
      "<key>CFBundleExecutable</key><string>CodeBoard</string>",
      "<key>CFBundleExecutable</key><string>cbgate</string>",
    )
    .replace("<key>CFBundleName</key><string>CodeBoard</string>", "<key>CFBundleName</key><string>cbgate</string>"),
);
execFileSync("codesign", [
  "--force",
  "--sign",
  "-",
  "--options",
  "runtime",
  "--entitlements",
  path.join(root, "tools/mac-gate.entitlements"),
  gateApp,
]);

// ---- the data: a copy, plus the big board
const copy = path.join(out, "data");
fs.cpSync(data, copy, { recursive: true });
const boards = fs
  .readdirSync(copy)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(copy, f), "utf8")) }))
  .filter((b) => Array.isArray(b.cards) && b.id !== "gate250");
const biggest = boards.reduce((a, b) => (b.cards.length > a.cards.length ? b : a));
const big = makeBig(biggest, bigN);
fs.writeFileSync(path.join(copy, `${big.id}.json`), JSON.stringify(big));

/** A board of n cards: the given one tiled with copies of its cards and links (new ids), placed in columns to its right */
function makeBig(b, n) {
  const { id: _id, ...src } = b;
  const o = structuredClone(src);
  o.id = "gate250";
  o.name = `${b.name} ×${Math.ceil(n / b.cards.length)} (gate)`;
  const xs = Object.values(b.place ?? {}).map((p) => p.x + (p.w ?? 400));
  const ys = Object.values(b.place ?? {}).map((p) => p.y + (p.mh ?? p.h ?? 300));
  const w = Math.max(...xs, 1000) + 200;
  const h = Math.max(...ys, 1000) + 200;
  for (let k = 1; o.cards.length < n; k++) {
    const dx = (k % 3) * w;
    const dy = Math.floor(k / 3) * h;
    const map = new Map(b.cards.map((c) => [c.id, `${c.id}g${k}`]));
    for (const c of b.cards) {
      if (o.cards.length >= n) break;
      const copy = structuredClone(c);
      copy.id = map.get(c.id);
      if (copy.segments) for (const s of copy.segments) s.id = `${s.id}g${k}`;
      o.cards.push(copy);
      const p = b.place?.[c.id];
      if (p) {
        const { section: _s, ...q } = p;
        o.place[copy.id] = { ...q, x: p.x + dx, y: p.y + dy };
      }
    }
    for (const l of b.links ?? []) {
      const from = map.get(l.from?.card);
      const to = map.get(l.to?.card);
      if (!from || !to || !o.cards.some((c) => c.id === from) || !o.cards.some((c) => c.id === to)) continue;
      o.links.push({
        ...structuredClone(l),
        id: `${l.id}g${k}`,
        from: { ...l.from, card: from },
        to: { ...l.to, card: to },
      });
    }
  }
  return o;
}

const pick = flag("--all")
  ? [...boards.map((b) => b.id), big.id]
  : (opt("--boards", QUICK.join(",")) || "")
      .split(",")
      .map((s) => (s === "biggest" ? biggest.id : s === "big" ? big.id : s));
const stepsOpt = opt("--steps", null);
const names = Object.fromEntries([...boards, big].map((b) => [b.id, b.name]));

// ---- run the app once per board
async function runBoard(id) {
  const dir = path.join(out, id);
  fs.mkdirSync(dir, { recursive: true });
  const a = [
    "--open",
    copy,
    "--board",
    id,
    "--gate",
    dir,
    ...(opt("--app-args", "") ? opt("--app-args", "").split(" ") : []),
  ];
  if (stepsOpt) a.push("--steps", stepsOpt);
  if (flag("--no-capture")) a.push("--no-capture");
  // a quiet machine: other work (builds, other apps) drops frames too
  const t0 = Date.now();
  let load = os.loadavg()[0];
  while (load >= QUIET.maxLoad && Date.now() - t0 < QUIET.waitQuiet * 60_000) {
    console.log(`   load ${load.toFixed(1)}: waiting for it to fall under ${QUIET.maxLoad}`);
    await new Promise((r) => setTimeout(r, 10_000));
    load = os.loadavg()[0];
  }
  const underLoad = load > QUIET.busy;
  const log = fs.openSync(path.join(dir, "app.log"), "w");
  const p = spawn(path.join(gateApp, "Contents/MacOS/cbgate"), a, {
    stdio: ["ignore", log, log],
    env: { ...process.env, CODEBOARD_CACHES: caches },
  });
  let trace = null;
  const traceFile = path.join(dir, "hitches.trace");
  if (xctrace) {
    await new Promise((r) => setTimeout(r, 1500));
    trace = spawn("xcrun", hitchesRecord(p.pid, traceFile, traceLimit), { stdio: "ignore" });
  }
  // the disk while it runs: the trace and the capture grow, and both are ended before the disk fills
  let stopped = null;
  const watch = setInterval(() => {
    stopped = diskWhy();
    if (!stopped) return;
    clearInterval(watch);
    writeSizes(stopped);
    trace?.kill("SIGKILL");
    p.kill("SIGKILL");
  }, 2000);
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      resolve("timeout");
    }, 900_000);
    p.on("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  let hitches = null;
  if (trace) {
    // xctrace ends the recording itself when the target exits or at its time limit
    if (trace.exitCode == null && trace.signalCode == null) await new Promise((r) => trace.on("exit", r));
    if (!stopped) hitches = exportHitches(traceFile, traceLimit);
    fs.rmSync(traceFile, { recursive: true, force: true });
  }
  clearInterval(watch);
  fs.closeSync(log);
  if (stopped) return { id, name: names[id], error: `stopped: ${stopped}` };
  const runFile = path.join(dir, "run.json");
  if (!fs.existsSync(runFile))
    return {
      id,
      name: names[id],
      error: `the app exited with ${code} and wrote no run.json (see ${path.relative(root, dir)}/app.log)`,
    };
  const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  if (run.error) return { id, name: names[id], error: run.error };
  // the load before the run: other work on the Mac (builds, other apps) drops frames too, and the report says when there was some
  return { ...judge(id, run, dir, hitches), loadBefore: +load.toFixed(1), underLoad };
}

/** The Hitches instrument's hitches table: each hitch's wall-clock start (s) and duration (ms), from the trace's start
 *  date and the rows' trace-relative start; null when the export fails */
function exportHitches(trace, limitS) {
  try {
    const x = (xpath) =>
      execFileSync("xcrun", ["xctrace", "export", "--input", trace, ...xpath], {
        encoding: "utf8",
        maxBuffer: 1 << 28,
      });
    const toc = x(["--toc"]);
    const startDate = /<start-date>([^<]+)<\/start-date>/.exec(toc)?.[1];
    if (!startDate) return { error: "no start date in the trace" };
    const t0 = new Date(startDate).getTime() / 1000;
    const xml = x(["--xpath", '/trace-toc/run[@number="1"]/data/table[@schema="hitches"]']);
    // a value repeated from an earlier row is a <… ref="id"/>
    const byId = new Map();
    const val = (r, tag) => {
      const m = new RegExp(`<${tag} id="(\\d+)"[^>]*>(\\d+)</${tag}>|<${tag} ref="(\\d+)"/>`).exec(r);
      if (!m) return null;
      if (m[1]) byId.set(`${tag}${m[1]}`, +m[2]);
      return m[1] ? +m[2] : (byId.get(`${tag}${m[3]}`) ?? null);
    };
    const rows = [];
    for (const r of xml.split("<row>").slice(1)) {
      const start = val(r, "start-time");
      const dur = val(r, "duration");
      if (start != null) rows.push({ at: t0 + start / 1e9, ms: (dur ?? 0) / 1e6 });
    }
    // a step that ends after the recording did is not judged by it
    return { rows, from: t0, until: t0 + limitS };
  } catch (e) {
    return { error: String(e.message).split("\n")[0] };
  }
}

// ---- judging
const pct = (xs, q) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : 0);
const stats = (dts, nominal) => {
  const s = [...dts].sort((a, b) => a - b);
  const late = s.filter((d) => d > nominal * GATE.lateRatio);
  return {
    n: s.length,
    p50: +pct(s, 0.5).toFixed(2),
    p95: +pct(s, 0.95).toFixed(2),
    max: +(s.at(-1) ?? 0).toFixed(2),
    late: late.length,
    latePct: +(s.length ? (late.length / s.length) * 100 : 0).toFixed(1),
    // hitch time: how much later than its period each late frame came, per second (what the Hitches instrument calls ms/s)
    hitchMsPerS: +(
      s.length ? (late.reduce((a, d) => a + (d - nominal), 0) / s.reduce((a, d) => a + d, 0)) * 1000 : 0
    ).toFixed(1),
  };
};

function judge(id, run, dir, hitchesAll) {
  const nominal = run.nominal_ms;
  const steps = [];
  for (const s of run.steps) {
    // the instrument's hitches that fell in this step (its wall clock, from the app)
    const covered = hitchesAll?.rows && s.t0_wall + s.wall_s <= hitchesAll.until;
    const inStep = covered ? hitchesAll.rows.filter((h) => h.at >= s.t0_wall && h.at < s.t0_wall + s.wall_s) : null;
    const hitches = inStep && {
      count: inStep.length,
      ms: +inStep.reduce((a, h) => a + h.ms, 0).toFixed(1),
      pct: +((inStep.length / Math.max(1, s.wall_s * (1000 / nominal))) * 100).toFixed(1),
      msPerS: +(inStep.reduce((a, h) => a + h.ms, 0) / s.wall_s).toFixed(1),
    };
    const samples = s.samples;
    const link = stats(
      samples.map((x) => x.dt).filter((d) => d > 0),
      nominal,
    );
    const main = samples.map((x) => x.main_ms).sort((a, b) => a - b);
    let presented = null;
    const cap = s.capture;
    if (cap && cap.t.length > 2) {
      const d = [];
      for (let i = 1; i < cap.t.length; i++) d.push((cap.t[i] - cap.t[i - 1]) * 1000);
      presented = stats(d, nominal);
    }
    // the gate: the instrument's hitches; without it, the main thread's pacing
    const sparse = presented && presented.n < samples.length * PRESENTED_MIN_SHARE;
    const fails = [];
    if (hitches) {
      if (hitches.pct >= GATE.hitchPct) fails.push(`${hitches.count} hitches (${hitches.pct} % of frames)`);
      if (hitches.msPerS > GATE.hitchMsPerS) fails.push(`hitch time ${hitches.msPerS} ms/s`);
    } else {
      if (link.p95 > nominal * GATE.p95Ratio) fails.push(`link p95 ${link.p95} ms`);
      if (link.latePct >= GATE.latePct) fails.push(`${link.late} late link frames (${link.latePct} %)`);
    }

    // glitches
    const hits = { flash: [], jump: [], blank: [] };
    const role = (k) => (s.free.includes(k) ? "free" : s.moves.includes(k) ? "moves" : "still");
    for (const h of jumpHits(
      samples.map((x) => ({ rects: x.rects, z: x.z })),
      role,
    ))
      hits.jump.push(h);
    for (let f = 2; f < samples.length; f++)
      if (samples[f].blank.length) hits.blank.push({ frame: f, t: samples[f].t, ids: samples[f].blank });
    let frameAt = () => null;
    if (cap) {
      const bytes = cap.cols * cap.rows * 12;
      const buf = fs.readFileSync(path.join(dir, cap.grids));
      const grids = cap.t.map((_, i) => ({
        cols: cap.cols,
        rows: cap.rows,
        cell: cap.cell,
        q: new Uint8Array(buf.buffer, buf.byteOffset + i * bytes, bytes),
      }));
      // the masks of a captured frame: the sample taken last before it was presented (its input is what the frame shows); they
      // are in window points, the capture is smaller
      const k = cap.w / run.window[0];
      const masks = cap.t.map((t) => {
        let m = samples[0];
        for (const x of samples) if (s.t0 + x.t <= t) m = x;
        return m.masks.map(([x, y, w, h]) => ({ x: x * k, y: y * k, w: w * k, h: h * k }));
      });
      hits.flash = flashHits(grids, masks);
      frameAt = (t) => {
        let best = 0;
        for (let i = 0; i < cap.t.length; i++) if (Math.abs(cap.t[i] - t) < Math.abs(cap.t[best] - t)) best = i;
        return best;
      };
      // a frame's own interval, for the report of where the drops were
    }
    for (const h of hits.flash)
      fails.push(`flash ${h.box.w}×${h.box.h} at (${h.box.x}, ${h.box.y}) frames ${h.from}–${h.to}`);
    for (const h of hits.jump) fails.push(`${h.key} ${h.kind} by ${h.by} px at frame ${h.frame}`);
    if (s.dropped_input) fails.push(`${s.dropped_input} inputs dropped (the app was not frontmost)`);
    if (hits.blank.length)
      fails.push(
        `blank cards in view in ${hits.blank.length} frames (${[...new Set(hits.blank.flatMap((b) => b.ids))].slice(0, 3).join(", ")})`,
      );

    // the frames to keep: a flash's frames (one before, one after), the first blank and jump frames; the rest of the capture goes
    const keep = new Set([0, (cap?.t.length ?? 1) - 1]);
    const failDir = path.join(dir, "fails");
    const kept = [];
    if (cap) {
      const save = (i, why) => {
        if (i < 0 || i >= cap.t.length) return;
        fs.mkdirSync(failDir, { recursive: true });
        const from = path.join(dir, s.name, `${String(i).padStart(3, "0")}.jpg`);
        const to = path.join(failDir, `${s.name}-${why}-${String(i).padStart(3, "0")}.jpg`);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.copyFileSync(from, to);
          kept.push(path.relative(root, to));
        }
        keep.add(i);
      };
      for (const h of hits.flash) for (let i = h.from - 1; i <= h.to + 1; i++) save(i, "flash");
      for (const h of hits.blank.slice(0, 3)) save(frameAt(s.t0 + h.t), "blank");
      for (const h of hits.jump) save(frameAt(s.t0 + samples[h.frame].t), "jump");
      if (!flag("--keep-frames")) {
        const sd = path.join(dir, s.name);
        for (const f of fs.readdirSync(sd)) {
          const m = /^(\d{3})\.jpg$/.exec(f);
          if (m && !keep.has(+m[1])) fs.rmSync(path.join(sd, f));
        }
        fs.rmSync(path.join(dir, cap.grids), { force: true });
      }
    }
    // did the action do anything: the camera or a card changed, or the window's content changed in a fifth of the frames; an
    // input that reached nothing (no handler, not delivered) is a failure of its own, never a silent pass
    const s0 = samples[0];
    const changed =
      samples.some(
        (x, i) =>
          i &&
          (x.z !== s0.z ||
            x.o[0] !== s0.o[0] ||
            x.o[1] !== s0.o[1] ||
            JSON.stringify(x.rects) !== JSON.stringify(s0.rects)),
      ) || (presented?.n ?? 0) > samples.length * 0.2;
    if (!changed) fails.push("no_effect: the input changed nothing");
    steps.push({
      name: s.name,
      continuous: s.continuous,
      frames: s.frames,
      hitches,
      link,
      presented,
      main: { p95: +pct(main, 0.95).toFixed(2), max: +(main.at(-1) ?? 0).toFixed(2) },
      cpuPct: +s.cpu_pct.toFixed(0),
      hz120: nominal < 8.6 && (presented ? presented.p50 < 8.6 : true),
      effect: changed,
      sparse: !!sparse,
      hits: { flash: hits.flash.length, jump: hits.jump.length, blank: hits.blank.length },
      detail: hits,
      fails,
      frames_kept: kept,
      pass: fails.length === 0,
    });
  }
  return {
    id,
    name: names[id] ?? id,
    cards: run.cards,
    refreshHz: run.refresh_hz,
    nominal: +nominal.toFixed(2),
    capture: run.capture,
    instrument: hitchesAll ? (hitchesAll.error ?? "the Hitches instrument") : "off",
    steps,
    pass: steps.every((s) => s.pass),
  };
}

// ---- report
const f1 = (x) => (x == null ? "-" : x.toFixed(1));
function table(r) {
  const rows = [
    [
      "step",
      "hitches",
      "hitch%",
      "ms/s",
      "link p95",
      "link late%",
      "SCK p95",
      "SCK late%",
      "main p95",
      "flash",
      "jump",
      "blank",
      "result",
    ],
  ];
  for (const s of r.steps) {
    const h = s.hitches;
    rows.push([
      s.name,
      h ? String(h.count) : "-",
      h ? f1(h.pct) : "-",
      h ? f1(h.msPerS) : "-",
      f1(s.link.p95),
      f1(s.link.latePct),
      s.presented ? f1(s.presented.p95) : "-",
      s.presented ? f1(s.presented.latePct) : "-",
      f1(s.main.p95),
      String(s.hits.flash),
      String(s.hits.jump),
      String(s.hits.blank),
      s.pass ? "ok" : `FAIL: ${s.fails.join("; ")}`,
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (i === rows[0].length - 1 ? 0 : r[i].length))));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

const results = [];
for (const id of pick) {
  console.log(`\n== ${names[id] ?? id} (${id})`);
  const why = diskWhy();
  if (why) writeSizes(why);
  const r = why ? { id, name: names[id], error: `not run: ${why}` } : await runBoard(id);
  results.push(r);
  if (r.error) console.log(`   ${r.error}`);
  else {
    console.log(
      `   ${r.cards} cards, display ${r.refreshHz} Hz, period ${r.nominal} ms, capture ${r.capture ? "on" : "off"}, timing by ${r.instrument}, load before ${r.loadBefore}${r.underLoad ? " (UNDER LOAD: taken while the Mac was busy)" : ""}`,
    );
    console.log(table(r).replace(/^/gm, "   "));
  }
}
const report = {
  when: new Date().toISOString(),
  app,
  data,
  gate: GATE,
  columns:
    "hitches / hitch% / ms/s (--xctrace): the Hitches instrument's hitches in the step, as a share of the step's frames, and hitch time per second (the gate); link: the display link's intervals (ms); SCK: the window capture's presented-frame intervals (it falls behind on full-window change); main p95: the main thread's cost per frame of the gate's own input",
  boards: results,
  pass: results.every((r) => r.pass),
};
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
const md = [
  `# macOS gate ${report.when}`,
  "",
  `App: ${app}`,
  `Data: a copy of ${data}`,
  "",
  ...results.flatMap((r) =>
    r.error
      ? [`## ${r.name} (${r.id})`, "", r.error, ""]
      : [
          `## ${r.name} (${r.id}): ${r.pass ? "pass" : "FAIL"}${r.underLoad ? " (under load)" : ""}`,
          "",
          `${r.cards} cards, ${r.refreshHz} Hz, period ${r.nominal} ms, timing by ${r.instrument}, load average before the run ${r.loadBefore}${r.underLoad ? " (under load)" : ""}`,
          "",
          "```",
          table(r),
          "```",
          "",
          ...r.steps.filter((s) => s.frames_kept.length).map((s) => `- ${s.name}: ${s.frames_kept.join(", ")}`),
          "",
        ],
  ),
].join("\n");
fs.writeFileSync(path.join(out, "report.md"), md);
if (!flag("--keep-frames")) {
  for (const id of pick) if (fs.existsSync(path.join(out, id))) dropCaptures(path.join(out, id));
  fs.rmSync(gateApp, { recursive: true, force: true });
  fs.rmSync(copy, { recursive: true, force: true });
}
console.log(
  `\n${report.pass ? "PASS" : "FAIL"}: ${results.filter((r) => r.pass).length}/${results.length} boards; report ${path.relative(root, path.join(out, "report.md"))}`,
);
process.exit(report.pass ? 0 : 1);
