#!/usr/bin/env node
// The macOS app's acceptance gate: every interaction at a full 120 Hz with no visual glitch, on copies of real boards.
//   node tools/mac-gate.mjs [--quick | --all | --boards id,id] [--data ~/Projects/persona/.codeboard] [--app <CodeBoard.app>]
//                           [--out test-out/mac-gate/<time>] [--steps pan,drag_card] [--no-capture] [--no-build] [--xctrace]
//                           [--big 250] [--keep-frames]
// Builds the app (apps/macos/build.sh), copies the data folder (the originals are never opened), adds a board of --big cards made
// from the biggest one, then runs the app once per board with --gate (Gate.swift drives the window and records; nothing is judged
// there) and judges here: frame intervals from the display link (the main thread's pacing) and the presented frames the window
// capture saw; probes.ts's flashHits over the captured frames (a static region changing for 1–3 frames and reverting), jumpHits
// over the cards' rects (a still card that moved, a moving one that jumped), cards in view with no bitmap (blank). Failing frames
// are kept under <out>/<board>/fails/, the rest of the capture is dropped (--keep-frames keeps it). Writes <out>/report.json and
// report.md, prints the table, exits 1 when any gate fails. With --xctrace the Animation Hitches instrument records each run too
// (its trace is kept next to the run; it is slow to export, so it is the ground truth to open by hand, not a gate).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flashHits, jumpHits } from "../packages/board/test/probes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

/** The gate: under 1 % late frames (later than 1.5 periods: a dropped frame reads a whole period more), and p95 within a quarter
 *  of the period (the display link's hand-over to the main thread and the capture's time stamps jitter by about 1 ms; a 120 Hz
 *  run that drops no frame sits at 8.3–9.5 ms, one that drops frames at 16.7) */
const GATE = { p95Ratio: 1.25, lateRatio: 1.5, latePct: 1 };
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
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

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
  const load = os.loadavg()[0];
  const log = fs.openSync(path.join(dir, "app.log"), "w");
  const p = spawn(path.join(gateApp, "Contents/MacOS/cbgate"), a, { stdio: ["ignore", log, log] });
  let trace = null;
  if (flag("--xctrace")) {
    await new Promise((r) => setTimeout(r, 1500));
    trace = spawn(
      "xcrun",
      [
        "xctrace",
        "record",
        "--template",
        "Animation Hitches",
        "--attach",
        String(p.pid),
        "--output",
        path.join(dir, "hitches.trace"),
        "--time-limit",
        "600s",
      ],
      { stdio: "ignore" },
    );
  }
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
    // xctrace ends the recording itself when the target exits
    await new Promise((r) => trace.on("exit", r));
    hitches = exportHitches(path.join(dir, "hitches.trace"));
  }
  fs.closeSync(log);
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
  return { ...judge(id, run, dir), hitches, loadBefore: +load.toFixed(1) };
}

/** The Animation Hitches instrument's hitches table: how many, and their total duration in ms (an error when the export fails) */
function exportHitches(trace) {
  try {
    const xml = execFileSync(
      "xcrun",
      ["xctrace", "export", "--input", trace, "--xpath", '/trace-toc/run[@number="1"]/data/table[@schema="hitches"]'],
      { encoding: "utf8", maxBuffer: 1 << 28 },
    );
    // a value repeated from an earlier row is a <duration ref="id"/>
    const rows = xml.split("<row>").slice(1);
    const byId = new Map();
    let ms = 0;
    for (const r of rows) {
      const m = /<duration id="(\d+)"[^>]*>(\d+)<\/duration>|<duration ref="(\d+)"\/>/.exec(r);
      if (!m) continue;
      if (m[1]) byId.set(m[1], +m[2]);
      ms += (m[1] ? +m[2] : (byId.get(m[3]) ?? 0)) / 1e6;
    }
    return { count: rows.length, ms: +ms.toFixed(1) };
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

function judge(id, run, dir) {
  const nominal = run.nominal_ms;
  const steps = [];
  for (const s of run.steps) {
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
    // the gate: the presented frames where the content changes every frame, else the main thread's pacing
    const sparse = presented && presented.n < samples.length * PRESENTED_MIN_SHARE;
    const judged = s.continuous && presented && !sparse ? presented : link;
    const fails = [];
    if (judged.p95 > nominal * GATE.p95Ratio) fails.push(`p95 ${judged.p95} ms`);
    if (judged.latePct >= GATE.latePct) fails.push(`${judged.late} late frames (${judged.latePct} %)`);

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
      // the masks of a captured frame: the sample taken last before it was presented (its input is what the frame shows)
      const masks = cap.t.map((t) => {
        let m = samples[0];
        for (const x of samples) if (s.t0 + x.t <= t) m = x;
        return m.masks.map(([x, y, w, h]) => ({ x, y, w, h }));
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
    // did the action do anything: a key the app has no handler for changes nothing (reported, not failed)
    const changed =
      samples.some((x, i) => i && JSON.stringify(x.rects) !== JSON.stringify(samples[0].rects)) ||
      (presented?.n ?? 0) > 2;
    steps.push({
      name: s.name,
      continuous: s.continuous,
      frames: s.frames,
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
    steps,
    pass: steps.every((s) => s.pass),
  };
}

// ---- report
const f1 = (x) => (x == null ? "-" : x.toFixed(1));
function table(r) {
  const rows = [
    ["step", "p50", "p95", "max", "late%", "hitch", "link p95", "main p95", "flash", "jump", "blank", "result"],
  ];
  for (const s of r.steps) {
    const j = s.continuous && s.presented && !s.sparse ? s.presented : s.link;
    rows.push([
      s.name + (s.effect ? "" : " (no effect)"),
      f1(j.p50),
      f1(j.p95),
      f1(j.max),
      f1(j.latePct),
      f1(j.hitchMsPerS),
      f1(s.link.p95),
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
  const r = await runBoard(id);
  results.push(r);
  if (r.error) console.log(`   ${r.error}`);
  else {
    console.log(
      `   ${r.cards} cards, display ${r.refreshHz} Hz, period ${r.nominal} ms, capture ${r.capture ? "on" : "off"}, load before ${r.loadBefore}${r.hitches ? `, Animation Hitches instrument: ${r.hitches.count ?? "?"} hitches, ${r.hitches.ms ?? "?"} ms${r.hitches.error ? ` (${r.hitches.error})` : ""}` : ""}`,
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
    "p50/p95/max/late%/hitch: presented frame intervals (ms, from the window capture) for continuous steps, the display link's for discrete ones; hitch: ms of lateness per second; link p95: the display link's interval; main p95: the main thread's cost per frame of the gate's own input",
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
          `## ${r.name} (${r.id}): ${r.pass ? "pass" : "FAIL"}`,
          "",
          `${r.cards} cards, ${r.refreshHz} Hz, period ${r.nominal} ms, load average before the run ${r.loadBefore}${r.hitches ? `, Animation Hitches instrument: ${r.hitches.count ?? "?"} hitches, ${r.hitches.ms ?? "?"} ms` : ""}`,
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
console.log(
  `\n${report.pass ? "PASS" : "FAIL"}: ${results.filter((r) => r.pass).length}/${results.length} boards; report ${path.relative(root, path.join(out, "report.md"))}`,
);
process.exit(report.pass ? 0 : 1);
