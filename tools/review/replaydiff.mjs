// Replay result for CI: compares head's failed checks with base's, both replayed with head's script on the same runner type.
// Usage: node tools/review/replaydiff.mjs <out.md> <head dir>... [--base <base dir>...]
//   Each dir holds a steps.json from replay.cjs (one per shard).
// Fails (exit 1) when a check fails on head but not on base, or head produced no results.
// A check that also fails on base is a known problem: listed, but it doesn't block an unrelated PR.
import fs from "node:fs";
import path from "node:path";

const [out, ...rest] = process.argv.slice(2);
const at = rest.indexOf("--base");
const headDirs = at < 0 ? rest : rest.slice(0, at), baseDirs = at < 0 ? [] : rest.slice(at + 1);
const load = (dirs) => dirs.flatMap((d) => { const f = path.join(d, "steps.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []; });
const fails = (steps) => new Map(steps.flatMap((s) => s.checks.filter((c) => !c.ok).map((c) => [`${s.name}: ${c.what}`, c])));
const passes = (steps) => new Set(steps.flatMap((s) => s.checks.filter((c) => c.ok).map((c) => `${s.name}: ${c.what}`)));

const H = load(headDirs), B = load(baseDirs);
const hf = fails(H), bf = fails(B), bp = passes(B), hp = passes(H);
const hasBase = B.length > 0;
// New: fails on head and did not fail on base (passed there, or the check is new)
const fresh = [...hf.keys()].filter((k) => !hasBase || !bf.has(k));
const known = [...hf.keys()].filter((k) => hasBase && bf.has(k));
const fixed = [...bf.keys()].filter((k) => hp.has(k));
const nChecks = H.reduce((n, s) => n + s.checks.length, 0);

const lines = [];
if (!H.length) lines.push("**Study-task replay**: ❌ no results (the replay crashed before writing steps.json).");
else {
  lines.push(`**Study-task replay** (${H.length} steps, ${nChecks} checks${hasBase ? "; base replayed with the same script" : "; no base to compare"}): ` +
    (fresh.length ? `❌ ${fresh.length} new failure${fresh.length > 1 ? "s" : ""}.` : known.length ? `✅ no new failures (${known.length} known, also failing on base).` : "✅ all checks passed."));
  for (const k of fresh) lines.push(`- ❌ ${k}${bp.has(k) ? " (passes on base)" : ""}`);
  if (known.length) lines.push("", "Known failures, also on base:", ...known.map((k) => `- ${k}`));
  if (fixed.length) lines.push("", "Fixed by this change (fail on base, pass on head):", ...fixed.map((k) => `- ${k}`));
}
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(lines.join("\n"));
process.exit(!H.length || fresh.length ? 1 : 0);
