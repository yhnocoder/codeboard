// Perf comparison for CI: base vs head, measured in the same job on the same runner.
// Usage: node tools/review/perfdiff.mjs <dir> [title]   (dir holds board-base-*.json, board-head-*.json from run-perf.mjs --json,
//        and host-base.log / host-head.log with one JSON line per run-perf-host.mjs run)
// title names the run in the summary (default "Performance"). Writes <dir>/summary.md and exits 1 when an operation regresses past the thresholds below.
// The runner has no GPU, so absolute times mean little; ratios between base and head on the same machine do.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2],
  title = process.argv[3] || "Performance";
if (!dir) {
  console.error("usage: perfdiff.mjs <dir>");
  process.exit(2);
}

// Thresholds picked from run-to-run noise of the same commit (3 local runs, quick profile):
// busyPerStep varied up to 1.21x, frameP95 up to 1.35x (drag), dragEnd up to 1.5x, host open/check up to ~1.6x cold, ~1.4x warm.
// A check fails only when the ratio AND the absolute difference are both past the limit, so tiny numbers can't trip it.
// Board checks (frame p95, work per step, one-off timings) also have to be over the 16.7 ms frame budget: anything still inside
// it is still 60 fps, and on this GPU-less runner a few-ms number swings 1.5x between runs of the same commit. Past the limits
// but inside the budget is listed in the summary, not failed.
const LIMITS = {
  busy: { ratio: 1.35, abs: 2 }, // ms of main-thread work per step
  frame: { ratio: 1.5, abs: 4 }, // ms, 95th percentile frame time (median step frame for steps that wait)
  scalar: { ratio: 1.75, abs: 20 }, // ms, one-off timings (dragEnd)
  host: { ratio: 1.5, abs: 30 }, // ms, host-side board open / version check (warm runs)
};
const FRAME_BUDGET = 16.7;

const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const runs = (side) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`board-${side}-`) && f.endsWith(".json"))
    .flatMap(read);
const hostRuns = (side) => {
  const f = path.join(dir, `host-${side}.log`);
  if (!fs.existsSync(f)) return [];
  // the first run of each invocation is cold (git and parser caches empty): keep only the warm ones
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .filter((r) => !r.coldCheckOld);
};
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x.toFixed(1)) : "–");
const ratio = (b, h) => (b > 0 ? h / b : NaN);

const B = runs("base"),
  H = runs("head");
const lines = [],
  fails = [],
  slow = [],
  inBudget = [];
if (!H.length) {
  console.error("no head perf results");
  process.exit(2);
}

// an operation's frame time: the p95 over its tasks, or for steps that wait the median over the steps (frameOf "stepMedian", perf.ts sum())
const frameOf = (m) => (m?.frameOf === "stepMedian" ? m.frameMedian : m?.frameP95);
const ops = Object.keys(H[0]).filter(
  (k) => H[0][k] && typeof H[0][k] === "object" && ("frameP95" in H[0][k] || "frameMedian" in H[0][k]),
);
// budget: the check only fails when head is also over it; past the limits but inside it is listed, not failed
const row = (name, b, h, lim, budget = 0, unit = "ms") => {
  const r = ratio(b, h),
    past = r > lim.ratio && h - b > lim.abs,
    bad = past && h > budget;
  const line = `${name}: ${fmt(b)} → ${fmt(h)} ${unit} (${r.toFixed(2)}x)`;
  if (bad) fails.push(line);
  else if (past) inBudget.push(line);
  return { r, bad, past };
};
const cell = (b, h, lim, name, budget = 0) => {
  if (!B.length) return `${fmt(h)}`;
  const { r, bad, past } = row(name, b, h, lim, budget);
  return `${fmt(b)} → ${fmt(h)} (${Number.isFinite(r) ? r.toFixed(2) + "x" : "–"})${bad ? " ❌" : past ? " ⚠" : ""}`;
};

lines.push(
  "| Operation | Work per step, ms (base → head) | Frame p95, ms (base → head; median step for hover) | |",
  "|---|---|---|---|",
);
for (const op of ops) {
  const bb = median(B.map((r) => r[op]?.busyPerStep)),
    hb = median(H.map((r) => r[op]?.busyPerStep));
  const bf = median(B.map((r) => frameOf(r[op]))),
    hf = median(H.map((r) => frameOf(r[op])));
  const over = hf > FRAME_BUDGET;
  if (over) slow.push(op);
  // frameOf: how the frame time was measured (p95 over all tasks, or the median step frame); when base measured it differently, nothing to compare
  const sameFrames = !B.length || B.every((r) => r[op]?.frameOf === H[0][op].frameOf);
  const frames = sameFrames
    ? cell(
        bf,
        hf,
        LIMITS.frame,
        `${op} frame ${H[0][op].frameOf === "stepMedian" ? "median step" : "p95"}`,
        FRAME_BUDGET,
      )
    : `${fmt(bf)} → ${fmt(hf)} (measured differently, not compared)`;
  lines.push(
    `| ${op} | ${cell(bb, hb, LIMITS.busy, `${op} work per step`, FRAME_BUDGET)} | ${frames} | ${over ? "⚠ over 16.7 ms" : ""} |`,
  );
}
// with animated stickers (run-perf.mjs --anim), also the main-thread work per idle second: what the playing stickers cost when nothing moves
for (const k of ["dragEnd", ...(H[0].animStickers ? ["idleBusy1s"] : [])]) {
  const b = median(B.map((r) => r[k])),
    h = median(H.map((r) => r[k]));
  if (Number.isFinite(h))
    lines.push(
      `| ${k} (${k === "dragEnd" ? "one-off" : "ms per idle second"}) | ${cell(b, h, LIMITS.scalar, k, FRAME_BUDGET)} | | |`,
    );
}
const HB = hostRuns("base"),
  HH = hostRuns("head");
if (HH.length) {
  lines.push("", "| Host | Time, ms (base → head) |", "|---|---|");
  for (const k of ["openAtHead", "checkAtHead", "openOld", "checkOld"]) {
    const b = median(HB.map((r) => r[k])),
      h = median(HH.map((r) => r[k]));
    lines.push(`| ${k} | ${HB.length ? cell(b, h, LIMITS.host, `host ${k}`) : fmt(h)} |`);
  }
}

// Raster counts (perf.ts rasterProbes, probes.ts): pixels rastered per step and layers' raster scale at rest, counted from the
// compositor's trace, so the same on any machine. They are judged against absolute budgets (probes.ts RASTER_BUDGET, carried in
// each run's rasterChecks), not against base: head fails when its median over the runs that have them is past the limit (under
// it for the checks marked atLeast: the integrity checks that a pass has snapshots, tasks and layers at rest). perf-ab.sh leaves
// raster.expected in the dir when a head run was asked for them, so a run that crashed or dropped them fails here, not silently
const withRaster = (rs) => rs.filter((r) => Array.isArray(r.rasterChecks));
const RB = withRaster(B),
  RH = withRaster(H);
const rasterFails = [];
if (!RH.length && fs.existsSync(path.join(dir, "raster.expected"))) {
  lines.push(
    "",
    "No head run has raster counts, though one was asked for them: the run failed or dropped them (see its log).",
  );
  fails.push("raster: no head run has raster counts (raster.expected is set)");
}
if (RH.length) {
  lines.push("", "| Raster budget (absolute; counts) | base → head | limit | |", "|---|---|---|---|");
  for (const c of RH[0].rasterChecks) {
    const at = (rs) => median(rs.map((r) => r.rasterChecks.find((x) => x.name === c.name)?.value));
    const h = at(RH),
      b = at(RB),
      bad = h === undefined || Number.isNaN(h) || (c.atLeast ? h < c.limit : h > c.limit);
    if (bad)
      rasterFails.push(
        `raster ${c.name}: ${fmt(h)} ${c.atLeast ? "under the minimum" : "over the budget"} of ${c.limit}`,
      );
    lines.push(
      `| ${c.name} | ${RB.length ? `${fmt(b)} → ` : ""}${fmt(h)} | ${c.atLeast ? "≥ " : ""}${c.limit} | ${bad ? "❌" : ""} |`,
    );
  }
  const passes = Object.keys(RH[0].raster ?? {});
  lines.push(
    "",
    "| Raster pass (head) | px per step, viewports (median / max) | layers per step (median / max) | wasted, viewports | rest, viewports | layers at rest | zoom | blurry / wasted at rest |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const p of passes) {
    const v = (k) => median(RH.map((r) => r.raster?.[p]?.[k]));
    const n = (k) => median(RH.map((r) => r.raster?.[p]?.[k]?.length));
    lines.push(
      `| ${p} | ${fmt(v("stepVP"))} / ${fmt(v("stepVPMax"))} | ${fmt(v("stepLayers"))} / ${fmt(v("stepLayersMax"))} | ${fmt(v("wastedVP"))} | ${fmt(v("restVP"))} | ${fmt(v("layers"))} | ${v("zoom")} | ${n("blurry")} / ${n("wasted")} |`,
    );
  }
  fails.push(...rasterFails);
}

const head = [
  `**${title}** (${B.length ? `${B.length} base, ${H.length} head` : H.length} run${H.length > 1 ? "s" : ""}, base and head alternating on the same runner; medians; the runner has no GPU, so compare ratios, not absolute times): ` +
    (fails.length
      ? `❌ ${fails.length} regression${fails.length > 1 ? "s" : ""}.`
      : !B.length
        ? "no base results, nothing to compare."
        : "✅ no regressions."),
  ...fails.map((f) => `- ${f}`),
  inBudget.length
    ? `\nSlower but still inside the ${FRAME_BUDGET} ms frame budget (not a failure): ${inBudget.join("; ")}.`
    : "",
  slow.length ? `\nOver the 16.7 ms frame budget on this runner: ${slow.join(", ")}.` : "",
  fs.existsSync(path.join(dir, "note.txt")) ? fs.readFileSync(path.join(dir, "note.txt"), "utf8").trim() : "",
  "",
  `<details><summary>Details</summary>\n`,
  ...lines,
  "",
  `Fails when work per step grows > ${LIMITS.busy.ratio}x and > ${LIMITS.busy.abs} ms, frame p95 > ${LIMITS.frame.ratio}x and > ${LIMITS.frame.abs} ms, or a one-off timing > ${LIMITS.scalar.ratio}x and > ${LIMITS.scalar.abs} ms, each only when head is also over ${FRAME_BUDGET} ms; or a host timing > ${LIMITS.host.ratio}x and > ${LIMITS.host.abs} ms; or a raster count is over its absolute budget (packages/board/test/probes.ts RASTER_BUDGET: viewports of device pixels rastered per step; layers blurry or rastered over 2x the scale shown at rest).`,
  "</details>",
];
fs.writeFileSync(path.join(dir, "summary.md"), head.join("\n") + "\n");
console.log(head.join("\n"));
process.exit(fails.length ? 1 : 0);
