#!/usr/bin/env node
// rec-check: finds flashes, blur, blank regions and white frames in a screen recording of a UI (the macOS app or the VS Code
// board), which screenshots cannot catch. TESTING.md has how to use it.
//
//   node tools/rec-check.mjs <video> [--marks marks.json] [--regions regions.json] [--out dir] [--moving 1.2-3.4,…]
//                                    [--width px] [--tile px] [--blur-frames 2] [--decoder ffmpeg|swift]
//
// marks.json: [{name, start, end, moving?: true | [s, e] | [[s, e], …]}] (seconds from the start of the video), or {steps: […]}.
// regions.json: [{name, x, y, w, h, step?, from?, to?}] in video pixels; `step` limits a region to that step, `from` / `to`
// to those frame numbers. Without it the frame is cut into a grid of tiles.
// Writes report.json, report.md, a clip (±0.3 s) of each failing span and a contact sheet of each failing step's worst frames
// into --out (default test-out/rec-check). Exits 1 when a step fails.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

// thresholds on 8-bit luma
const FLAT_SD = 2.5; // a region this even is flat
const CONTENT_SD = 6; // and one this uneven, with some sharpness, has content
const CONTENT_LAP = 20;
const BLUR_RATIO = 0.5; // sharper than this share of the settled frame's sharpness is not blur
const SAME_SIG = 8; // mean cell difference under which a region shows the same thing (blur keeps the cell means)
const CHANGE_SIG = 12; // a cell that moved this much changed
const BACK_SIG = 4; // and one within this came back
const WHITE_SHARE = 0.9; // of the frame's pixels at 240 or more
const SUDDEN_FLAT = 0.15; // of the frame turned flat within 3 frames
const PAD = 0.3; // seconds of clip around a failing span
const MAX_CLIPS = 12;
const MAX_CLIP = 3; // seconds; a longer failing stretch is clipped from its start
const SHEET_ROWS = 6;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    marks: { type: "string" },
    regions: { type: "string" },
    out: { type: "string", default: "test-out/rec-check" },
    moving: { type: "string" },
    width: { type: "string" },
    tile: { type: "string", default: "128" },
    "blur-frames": { type: "string", default: "2" },
    decoder: { type: "string" },
  },
});
const video = positionals[0];
if (!video) {
  console.error("usage: node tools/rec-check.mjs <video> [--marks marks.json] [--regions regions.json] [--out dir]");
  process.exit(2);
}
const blurFrames = Number(opt["blur-frames"]);
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const backend = (opt.decoder ?? (hasFfmpeg ? "ffmpeg" : "swift")) === "ffmpeg" ? ffmpeg() : swift();
const started = performance.now();

// ---- decoders: {info, frames(w, h) → async iterable of {pts, data}, seek(pts), clip(start, dur, out), sheet(out, items, cell)}

function ffmpeg() {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
    return r.stdout;
  };
  const probe = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate:format=start_time,duration",
      "-of",
      "json",
      video,
    ]),
  );
  const s = probe.streams[0];
  const [a, b] = s.avg_frame_rate.split("/").map(Number);
  const start = Number(probe.format.start_time) || 0;
  // the frames' times from the packets (no decoding); screen recordings are often variable frame rate
  const pts = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    video,
  ])
    .split("\n")
    .filter((l) => l.trim() && l.trim() !== "N/A")
    .map(Number)
    .sort((x, y) => x - y);
  return {
    info: { width: s.width, height: s.height, fps: a / (b || 1), duration: Number(probe.format.duration), start },
    async *frames(w, h) {
      const vf = w === s.width && h === s.height ? "format=gray" : `scale=${w}:${h}:flags=area,format=gray`;
      const p = spawn(
        "ffmpeg",
        ["-v", "error", "-i", video, "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      let n = 0;
      for await (const data of chunked(p.stdout, w * h)) {
        yield { pts: pts[n] ?? start + n / (a / (b || 1)), data };
        n++;
      }
    },
    seek: (t) => Math.max(0, t - start - 0.001),
    clip(t, dur, out) {
      const base = ["-v", "error", "-y", "-ss", String(t), "-i", video, "-t", String(dur), "-an"];
      const enc = [
        "-vf",
        "scale='min(1280,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-pix_fmt",
        "yuv420p",
      ];
      if (spawnSync("ffmpeg", [...base, ...enc, out]).status !== 0) run("ffmpeg", [...base, "-c", "copy", out]);
    },
    sheet(out, items, cell) {
      const ch = Math.round((cell * s.height) / s.width / 2) * 2;
      const k = cell / s.width;
      const inputs = items.flatMap((it) => ["-ss", String(it.t), "-i", video]);
      const chains = items.map((it, j) => {
        const box = it.rect
          ? `,drawbox=x=${Math.round(it.rect[0] * k)}:y=${Math.round(it.rect[1] * k)}:w=${Math.max(4, Math.round(it.rect[2] * k))}:h=${Math.max(4, Math.round(it.rect[3] * k))}:color=red@0.9:t=3`
          : "";
        return `[${j}:v]scale=${cell}:${ch}${box}[v${j}]`;
      });
      const layout = items.map((_, j) => `${(j % 2) * cell}_${Math.floor(j / 2) * ch}`).join("|");
      const graph = `${chains.join(";")};${items.map((_, j) => `[v${j}]`).join("")}xstack=inputs=${items.length}:layout=${layout}:fill=black`;
      run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", graph, "-frames:v", "1", "-update", "1", out]);
    },
  };
}

function swift() {
  const src = join(import.meta.dirname, "rec-check", "decode.swift");
  const hash = createHash("sha1").update(readFileSync(src)).digest("hex").slice(0, 12);
  const bin = join(tmpdir(), `codeboard-rec-check-${hash}`);
  if (spawnSync(bin, []).error) {
    const r = spawnSync("swiftc", ["-O", "-suppress-warnings", "-o", bin, src], { stdio: "inherit" });
    if (r.status !== 0)
      throw new Error(
        "ffmpeg is not installed and the AVFoundation decoder did not compile (needs Xcode or the Command Line Tools)",
      );
  }
  const run = (...args) => {
    const r = spawnSync(bin, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`decoder ${args[0]} failed: ${r.stderr}`);
    return r.stdout;
  };
  const info = JSON.parse(run("info", video));
  return {
    info: { ...info, start: 0 },
    async *frames(w, h) {
      const p = spawn(bin, ["decode", video, String(w), String(h)], { stdio: ["ignore", "pipe", "inherit"] });
      for await (const rec of chunked(p.stdout, 8 + w * h)) {
        yield { pts: new DataView(rec.buffer).getFloat64(0, true), data: rec.subarray(8) };
      }
    },
    seek: (t) => t,
    clip: (t, dur, out) => run("clip", video, out, String(t), String(dur)),
    sheet(out, items, cell) {
      const spec = join(tmpdir(), `rec-check-sheet-${process.pid}.json`);
      writeFileSync(spec, JSON.stringify({ cell, cols: 2, items }));
      try {
        run("sheet", video, out, spec);
      } finally {
        rmSync(spec, { force: true });
      }
    },
  };
}

// a byte stream cut into records of `size` bytes, each in a fresh buffer (they are handed to workers and back)
async function* chunked(stream, size) {
  let rec = new Uint8Array(size);
  let at = 0;
  for await (const chunk of stream) {
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(size - at, chunk.length - off);
      rec.set(chunk.subarray(off, off + take), at);
      at += take;
      off += take;
      if (at === size) {
        yield rec;
        rec = new Uint8Array(size);
        at = 0;
      }
    }
  }
}

// ---- pass 1: decode and measure every frame on worker threads

const { info } = backend;
const aw = Math.min(info.width, Number(opt.width ?? info.width)) & ~1; // blur needs the recording's own pixels by default
const ah = Math.round((aw * info.height) / info.width / 2) * 2;
const scale = aw / info.width;
const marks = opt.marks ? JSON.parse(readFileSync(opt.marks, "utf8")) : null;
const regionsFile = opt.regions ? JSON.parse(readFileSync(opt.regions, "utf8")) : null;

const grid = [];
if (!regionsFile) {
  const t = Math.round(Number(opt.tile) * scale);
  const cols = Math.max(1, Math.round(aw / t));
  const rows = Math.max(1, Math.round(ah / t));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = Math.round((c * aw) / cols);
      const y = Math.round((r * ah) / rows);
      grid.push({
        name: `r${r}c${c}`,
        x,
        y,
        w: Math.round(((c + 1) * aw) / cols) - x,
        h: Math.round(((r + 1) * ah) / rows) - y,
      });
    }
}
const regions = regionsFile
  ? regionsFile.map((g) => ({
      ...g,
      x: Math.round(g.x * scale),
      y: Math.round(g.y * scale),
      w: Math.max(4, Math.round(g.w * scale)),
      h: Math.max(4, Math.round(g.h * scale)),
    }))
  : grid;
for (const g of regions) {
  g.x = Math.min(Math.max(0, g.x), aw - 4);
  g.y = Math.min(Math.max(0, g.y), ah - 4);
  g.w = Math.min(g.w, aw - g.x);
  g.h = Math.min(g.h, ah - g.y);
}

const frames = []; // {pts, t, stats: Float32Array(R*3) with NaN for inactive regions, sig: Uint8Array(R*16), white}
const activeAt = (i, pts) => {
  const t = pts - info.start;
  const step = steps.find((s) => t >= s.start && t <= s.end)?.name;
  return regions.map(
    (g) =>
      (g.from === undefined || i >= g.from) &&
      (g.to === undefined || i <= g.to) &&
      (g.step === undefined || g.step === step),
  );
};
// steps need only the marks here; the frames are mapped to them after decoding
const steps = (Array.isArray(marks) ? marks : (marks?.steps ?? [])).map((m) => ({
  ...m,
  start: Number(m.start),
  end: Number(m.end),
}));

await (async () => {
  const n = Math.max(1, Math.min(8, availableParallelism() - 1));
  const workers = Array.from({ length: n }, () => new Worker(join(import.meta.dirname, "rec-check", "worker.mjs")));
  const idle = [...workers];
  let wake = null;
  let pending = 0;
  let done = null;
  for (const w of workers) {
    w.on("message", (m) => {
      const f = frames[m.i];
      f.stats = m.stats;
      f.sig = m.sig;
      f.white = m.white;
      for (let r = 0; r < f.active.length; r++) if (!f.active[r]) f.stats[r * 3] = Number.NaN;
      delete f.active;
      idle.push(w);
      pending--;
      wake?.();
      if (!pending) done?.();
    });
    w.on("error", (e) => {
      console.error(e);
      process.exit(2);
    });
  }
  for await (const { pts, data } of backend.frames(aw, ah)) {
    while (!idle.length) await new Promise((r) => (wake = r));
    wake = null;
    const i = frames.length;
    const active = activeAt(i, pts);
    const rects = new Int32Array(regions.length * 4);
    regions.forEach((g, r) => rects.set(active[r] ? [g.x, g.y, g.w, g.h] : [0, 0, 4, 4], r * 4));
    frames.push({ pts, t: pts - info.start, active });
    const buf = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
    pending++;
    idle.pop().postMessage({ i, buf, w: aw, h: ah, rects }, [buf]);
  }
  if (pending) await new Promise((r) => (done = r));
  await Promise.all(workers.map((w) => w.terminate()));
})();
if (!frames.length) throw new Error(`no frames decoded from ${video}`);
const decodeSec = (performance.now() - started) / 1000;

// ---- pass 2: judge each step against its settled frame

const last = frames.length - 1;
const R = regions.length;
const mean = (i, r) => frames[i].stats[r * 3];
const sd = (i, r) => frames[i].stats[r * 3 + 1];
const lap = (i, r) => frames[i].stats[r * 3 + 2];
const on = (i, r) => !Number.isNaN(mean(i, r));
const flat = (i, r) => sd(i, r) < FLAT_SD;
const content = (i, r) => sd(i, r) >= CONTENT_SD && lap(i, r) >= CONTENT_LAP;
const sigDiff = (i, j, r, max = false) => {
  const a = frames[i].sig;
  const b = frames[j].sig;
  let d = 0;
  for (let k = r * 16; k < r * 16 + 16; k++) {
    const e = Math.abs(a[k] - b[k]);
    d = max ? Math.max(d, e) : d + e / 16;
  }
  return d;
};
const area = (r) => regions[r].w * regions[r].h;
const totalArea = regions.reduce((s, g) => s + g.w * g.h, 0);
const flatShare = (i) => {
  let a = 0;
  for (let r = 0; r < R; r++) if (on(i, r) && flat(i, r)) a += area(r);
  return a / totalArea;
};
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : Number.NaN;
};
const sharpness = (i) => median(regions.map((_, r) => (on(i, r) && content(i, r) ? lap(i, r) : Number.NaN)));
const frameAt = (t) => {
  let i = 0;
  while (i < last && frames[i + 1].t <= t + 1e-6) i++;
  return i;
};
const spans = (s) =>
  s === true ? [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]] : Array.isArray(s?.[0]) ? s : s ? [s] : [];
const cliMoving = (opt.moving ?? "")
  .split(",")
  .filter(Boolean)
  .map((p) => p.split("-").map(Number));

if (!steps.length) steps.push({ name: "recording", start: frames[0].t, end: frames[last].t });
for (const [k, s] of steps.entries()) {
  s.first = frames.findIndex((f) => f.t >= s.start - 1e-6);
  s.last = frameAt(s.end);
  if (s.first < 0 || s.first > s.last) s.first = s.last = -1;
  // the settled frame: 1 s after the step when the next step has not started by then, else the step's last frame
  const next = steps[k + 1];
  const settle = s.end + 1;
  s.ref = settle <= frames[last].t && (!next || next.start >= settle) ? frameAt(settle) : s.last;
  s.movingSpans = [...spans(s.moving), ...cliMoving];
}

const hits = []; // {kind, region (index or -1 for the whole frame), frame, until?, value}
for (const s of steps) {
  if (s.first < 0) continue;
  const ref = s.ref;
  const moving = (i) => s.movingSpans.some(([a, b]) => frames[i].t >= a - 1e-6 && frames[i].t <= b + 1e-6);
  const seen = new Uint8Array(R);
  const refSharp = sharpness(ref);
  const refFlat = flatShare(ref);
  for (let i = s.first; i <= s.last; i++) {
    const mv = moving(i);
    if (frames[i].white >= WHITE_SHARE && frames[ref].white < 0.5)
      hits.push({ kind: "white", region: -1, frame: i, value: frames[i].white });
    const fs = flatShare(i);
    const before = Math.min(...[i - 1, i - 2, i - 3].filter((j) => j >= 0).map(flatShare));
    if (fs - before >= SUDDEN_FLAT && fs - refFlat >= SUDDEN_FLAT)
      hits.push({ kind: "blank", region: -1, frame: i, value: fs });
    if (mv) {
      // the camera moves: the frame's sharpness against the settled frame's, not region by region
      const sh = sharpness(i);
      if (sh < refSharp * BLUR_RATIO) hits.push({ kind: "blur", region: -1, frame: i, value: sh / refSharp });
    }
    for (let r = 0; r < R; r++) {
      if (!on(i, r)) continue;
      const settled = on(ref, r) && content(ref, r);
      if (!mv && settled) {
        if (flat(i, r) && (seen[r] || Math.abs(mean(i, r) - mean(s.first, r)) > 6))
          hits.push({ kind: "blank", region: r, frame: i, value: mean(i, r) });
        else if (!flat(i, r) && lap(i, r) < lap(ref, r) * BLUR_RATIO && sigDiff(i, ref, r) < SAME_SIG)
          hits.push({ kind: "blur", region: r, frame: i, value: lap(i, r) / lap(ref, r) });
      }
      if (content(i, r)) seen[r] = 1;
      // flash: a still region that changes and is back where it was 1–3 frames later, and stays
      if (mv || i < 2 || i + 1 > last || !on(i - 1, r) || !on(i - 2, r)) continue;
      if (sigDiff(i - 2, i - 1, r, true) >= BACK_SIG || sigDiff(i - 1, i, r, true) < CHANGE_SIG) continue;
      for (let k = 0; k < 3 && i + k + 1 <= last; k++) {
        const j = i + k + 1;
        if (!on(j, r) || moving(j)) break;
        if (sigDiff(i - 1, j, r, true) < BACK_SIG) {
          if (j + 1 > last || sigDiff(j, j + 1, r, true) < BACK_SIG)
            hits.push({ kind: "flash", region: r, frame: i, until: j - 1, value: k + 1 });
          break;
        }
      }
    }
  }
}

// consecutive frames of one kind in one region make a span
hits.sort((a, b) => a.kind.localeCompare(b.kind) || a.region - b.region || a.frame - b.frame);
const found = [];
for (const h of hits) {
  const p = found.at(-1);
  if (p && p.kind === h.kind && p.region === h.region && h.frame <= p.until + 1 && h.kind !== "flash") {
    p.until = Math.max(p.until, h.frame);
    p.worst = h.kind === "blur" ? Math.min(p.worst, h.value) : p.worst;
  } else found.push({ kind: h.kind, region: h.region, frame: h.frame, until: h.until ?? h.frame, worst: h.value });
}
// the same kind over the same frames in several regions is one flag
const groups = new Map();
for (const f of found) {
  const g = groups.get(`${f.kind}:${f.frame}:${f.until}`);
  if (!g) groups.set(`${f.kind}:${f.frame}:${f.until}`, { ...f, regions: [f.region] });
  else {
    g.regions.push(f.region);
    g.worst = f.kind === "blur" ? Math.min(g.worst, f.worst) : Math.max(g.worst, f.worst);
  }
}
const PRIORITY = { white: 0, blank: 1, flash: 2, blur: 3 };
const report = {
  video,
  width: info.width,
  height: info.height,
  fps: Math.round(info.fps * 100) / 100,
  frames: frames.length,
  duration: Math.round((frames[last].t - frames[0].t) * 1000) / 1000,
  analysis: { width: aw, height: ah, regions: regionsFile ? "regions.json" : `${R} tiles`, seconds: 0 },
  pass: true,
  steps: steps.map((s) => {
    const flags = [...groups.values()]
      .filter((f) => f.frame >= s.first && f.frame <= s.last)
      .map((f) => {
        const whole = f.regions.includes(-1);
        const names = f.regions.map((r) => regions[r]?.name ?? "frame");
        const gs = whole ? [{ x: 0, y: 0, w: aw, h: ah }] : f.regions.map((r) => regions[r]);
        const x = Math.min(...gs.map((g) => g.x));
        const y = Math.min(...gs.map((g) => g.y));
        const rect = [x, y, Math.max(...gs.map((g) => g.x + g.w)) - x, Math.max(...gs.map((g) => g.y + g.h)) - y];
        const n = f.until - f.frame + 1;
        return {
          kind: f.kind,
          fail: f.kind !== "blur" || n > blurFrames,
          frame: f.frame,
          endFrame: f.until,
          frames: n,
          time: round3(frames[f.frame].t),
          endTime: round3(frames[f.until].t),
          region: whole ? "frame" : names.length <= 4 ? names.join(" ") : `${names.length} regions`,
          regions: names,
          rect: whole ? null : rect.map((v) => Math.round(v / scale)),
          value: Math.round(f.worst * 1000) / 1000,
        };
      })
      .sort((a, b) => a.frame - b.frame);
    const pass = !flags.some((f) => f.fail);
    return {
      name: s.name,
      start: round3(s.start),
      end: round3(s.end),
      firstFrame: s.first,
      lastFrame: s.last,
      settledFrame: s.ref,
      pass,
      flags,
    };
  }),
};
report.pass = report.steps.every((s) => s.pass);

// ---- what to look at: clips around failing spans, a contact sheet per failing step

const out = opt.out;
mkdirSync(out, { recursive: true });
let clips = 0;
for (const s of report.steps) {
  const windows = [];
  for (const f of s.flags.filter((x) => x.fail)) {
    const a = Math.max(0, f.time - PAD);
    const b = f.endTime + PAD;
    const w = windows.at(-1);
    if (w && a <= w[1]) w[1] = Math.max(w[1], b);
    else windows.push([a, b]);
  }
  s.clips = [];
  for (const [a, b] of windows) {
    if (clips >= MAX_CLIPS) break;
    const file = `clip-${slug(s.name)}-${s.clips.length + 1}.mp4`;
    backend.clip(backend.seek(a + info.start), Math.min(b - a, MAX_CLIP), join(out, file));
    s.clips.push(file);
    clips++;
  }
  const worst = s.flags
    .filter((f) => f.fail)
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.frames - a.frames)
    .slice(0, SHEET_ROWS);
  if (worst.length) {
    // each row: the flagged frame, then the frame it is judged against (the one before a flash, else the settled frame)
    const items = worst.flatMap((f) => {
      const other = f.kind === "flash" ? f.frame - 1 : s.settledFrame;
      return [f.frame, other].map((i) => ({ t: backend.seek(frames[i].pts), rect: f.rect }));
    });
    s.sheet = `sheet-${slug(s.name)}.png`;
    s.sheetRows = worst.map(
      (f) =>
        `${f.kind} ${f.region} @ frame ${f.frame} | ${f.kind === "flash" ? `frame ${f.frame - 1}` : `settled ${s.settledFrame}`}`,
    );
    backend.sheet(join(out, s.sheet), items, Math.min(960, info.width));
  }
}
const total = (performance.now() - started) / 1000;
report.analysis.seconds = Math.round(total * 10) / 10;
report.analysis.decodeSeconds = Math.round(decodeSec * 10) / 10;
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(out, "report.md"), markdown(report));
const speed = report.duration / decodeSec;
console.log(
  `${report.pass ? "PASS" : "FAIL"} ${basename(video)}: ${frames.length} frames ${aw}×${ah}, ${report.steps.filter((s) => !s.pass).length}/${report.steps.length} steps failed; analysed in ${decodeSec.toFixed(1)} s (${speed.toFixed(1)}× real time), ${total.toFixed(1)} s with clips → ${join(out, "report.md")}`,
);
process.exit(report.pass ? 0 : 1);

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
function slug(s) {
  return String(s)
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 40);
}
function markdown(r) {
  const lines = [`# rec-check: ${basename(r.video)} — ${r.pass ? "PASS" : "FAIL"}`, ""];
  lines.push(
    `${r.width}×${r.height}, ${r.fps} fps, ${r.frames} frames, ${r.duration} s; analysed at ${r.analysis.width}×${r.analysis.height} over ${r.analysis.regions}.`,
    "",
  );
  for (const s of r.steps) {
    lines.push(
      `## ${s.name}: ${s.pass ? "pass" : "FAIL"}`,
      "",
      `${s.start}–${s.end} s, frames ${s.firstFrame}–${s.lastFrame}, settled frame ${s.settledFrame}.`,
      "",
    );
    if (s.flags.length) {
      lines.push(
        "| kind | fails | time (s) | frames | region | rect (x, y, w, h) | value |",
        "|---|---|---|---|---|---|---|",
      );
      for (const f of s.flags)
        lines.push(
          `| ${f.kind} | ${f.fail ? "yes" : "no"} | ${f.time}–${f.endTime} | ${f.frame}–${f.endFrame} (${f.frames}) | ${f.region} | ${f.rect?.join(", ") ?? "whole frame"} | ${f.value} |`,
        );
      lines.push("");
    }
    if (s.clips?.length) lines.push(`Clips: ${s.clips.map((c) => `[${c}](${c})`).join(", ")}`, "");
    if (s.sheet) lines.push(`![${s.sheet}](${s.sheet})`, "", ...s.sheetRows.map((x, i) => `${i + 1}. ${x}`), "");
  }
  return `${lines.join("\n")}\n`;
}
