// Perf comparison for CI: base vs head, measured in the same job on the same runner.
// Usage: node tools/review/perfdiff.mjs <dir> [title]   (dir holds board-base-*.json, board-head-*.json from run-perf.mjs --json,
//        and host-base.log / host-head.log with one JSON line per run-perf-host.mjs run)
// title names the run in the summary (default "Performance"). Writes <dir>/summary.md and exits 1 when an operation regresses past the thresholds below.
// The runner has no GPU, so absolute times mean little; ratios between base and head on the same machine do.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2], title = process.argv[3] || "Performance";
if (!dir) { console.error("usage: perfdiff.mjs <dir>"); process.exit(2); }

// Thresholds picked from run-to-run noise of the same commit (3 local runs, quick profile):
// busyPerStep varied up to 1.21x, frameP95 up to 1.35x (drag), dragEnd up to 1.5x, host open/check up to ~1.6x cold, ~1.4x warm.
// A check fails only when the ratio AND the absolute difference are both past the limit, so tiny numbers can't trip it.
// Frame p95 also has to be over the 16.7 ms frame budget: on this GPU-less runner a short operation's p95 rests on a dozen
// frames, so 5 → 10 ms is noise, and a frame time still inside the budget is still 60 fps. Work per step catches the cost early.
const LIMITS = {
  busy: { ratio: 1.35, abs: 2 },     // ms of main-thread work per step
  frame: { ratio: 1.5, abs: 4 },     // ms, 95th percentile frame time
  scalar: { ratio: 1.75, abs: 20 },  // ms, one-off timings (dragEnd)
  host: { ratio: 1.5, abs: 30 },     // ms, host-side board open / version check (warm runs)
};
const FRAME_BUDGET = 16.7;

const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const runs = (side) => fs.readdirSync(dir).filter((f) => f.startsWith(`board-${side}-`) && f.endsWith(".json")).flatMap(read);
const hostRuns = (side) => {
  const f = path.join(dir, `host-${side}.log`);
  if (!fs.existsSync(f)) return [];
  // the first run of each invocation is cold (git and parser caches empty): keep only the warm ones
  return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((r) => !r.coldCheckOld);
};
const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (x) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x.toFixed(1)) : "–");
const ratio = (b, h) => (b > 0 ? h / b : NaN);

const B = runs("base"), H = runs("head");
const lines = [], fails = [], slow = [], inBudget = [];
if (!H.length) { console.error("no head perf results"); process.exit(2); }

const ops = Object.keys(H[0]).filter((k) => H[0][k] && typeof H[0][k] === "object" && "frameP95" in H[0][k]);
// budget: the check only fails when head is also over it (frame p95); past the limits but inside it is listed, not failed
const row = (name, b, h, lim, budget = 0, unit = "ms") => {
  const r = ratio(b, h), past = r > lim.ratio && h - b > lim.abs, bad = past && h > budget;
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

lines.push("| Operation | Work per step, ms (base → head) | Frame p95, ms (base → head) | |", "|---|---|---|---|");
for (const op of ops) {
  const bb = median(B.map((r) => r[op]?.busyPerStep)), hb = median(H.map((r) => r[op]?.busyPerStep));
  const bf = median(B.map((r) => r[op]?.frameP95)), hf = median(H.map((r) => r[op]?.frameP95));
  const over = hf > FRAME_BUDGET;
  if (over) slow.push(op);
  lines.push(`| ${op} | ${cell(bb, hb, LIMITS.busy, `${op} work per step`)} | ${cell(bf, hf, LIMITS.frame, `${op} frame p95`, FRAME_BUDGET)} | ${over ? "⚠ over 16.7 ms" : ""} |`);
}
// with animated stickers (run-perf.mjs --anim), also the main-thread work per idle second: what the playing stickers cost when nothing moves
for (const k of ["dragEnd", ...(H[0].animStickers ? ["idleBusy1s"] : [])]) {
  const b = median(B.map((r) => r[k])), h = median(H.map((r) => r[k]));
  if (Number.isFinite(h)) lines.push(`| ${k} (${k === "dragEnd" ? "one-off" : "ms per idle second"}) | ${cell(b, h, LIMITS.scalar, k)} | | |`);
}
const HB = hostRuns("base"), HH = hostRuns("head");
if (HH.length) {
  lines.push("", "| Host | Time, ms (base → head) |", "|---|---|");
  for (const k of ["openAtHead", "checkAtHead", "openOld", "checkOld"]) {
    const b = median(HB.map((r) => r[k])), h = median(HH.map((r) => r[k]));
    lines.push(`| ${k} | ${HB.length ? cell(b, h, LIMITS.host, `host ${k}`) : fmt(h)} |`);
  }
}

const head = [
  `**${title}** (${H.length} run${H.length > 1 ? "s" : ""} per side, base and head alternating on the same runner; medians; the runner has no GPU, so compare ratios, not absolute times): ` +
    (!B.length ? "no base results, nothing to compare." : fails.length ? `❌ ${fails.length} regression${fails.length > 1 ? "s" : ""}.` : "✅ no regressions."),
  ...fails.map((f) => `- ${f}`),
  inBudget.length ? `\nSlower but still inside the ${FRAME_BUDGET} ms frame budget (not a failure): ${inBudget.join("; ")}.` : "",
  slow.length ? `\nOver the 16.7 ms frame budget on this runner: ${slow.join(", ")}.` : "",
  fs.existsSync(path.join(dir, "note.txt")) ? fs.readFileSync(path.join(dir, "note.txt"), "utf8").trim() : "",
  "",
  `<details><summary>Details</summary>\n`,
  ...lines,
  "",
  `Fails when work per step grows > ${LIMITS.busy.ratio}x and > ${LIMITS.busy.abs} ms, frame p95 > ${LIMITS.frame.ratio}x and > ${LIMITS.frame.abs} ms and over ${FRAME_BUDGET} ms, a one-off timing > ${LIMITS.scalar.ratio}x and > ${LIMITS.scalar.abs} ms, or a host timing > ${LIMITS.host.ratio}x and > ${LIMITS.host.abs} ms.`,
  "</details>",
];
fs.writeFileSync(path.join(dir, "summary.md"), head.join("\n") + "\n");
console.log(head.join("\n"));
process.exit(fails.length ? 1 : 0);
