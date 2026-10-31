// Host performance of the whole-workspace name index (used when the language service gives no definition):
// a synthetic big repo (nano-vllm copied many times, like sglang-sized), a click on a call the language service cannot answer.
// Measures the click latency (cold and warm), the longest event-loop stall while indexing, and whether a definition in a file past
// the first 8000 files is found. Usage: node packages/host/test/run-perf-host.mjs --index [--files 12000]
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { CodeCard, ExpandResult, Segment } from "@codeboard/core";
import { startAnalysis, analysisOf } from "../src/analysis";
import { cardForFileSym } from "../src/cards";
import * as R from "../src/resolve";
import { nameIndexReady, resetIndex } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const FILES = +arg("files", "12000");
const REPO = path.resolve(__dirname, ".."); // bundled into test-out/
const BIG = `/tmp/codeboard-perf/big-${FILES}u`;

/** BIG/r0000/nanovllm/… copies (each with its own trailing comment) until FILES code files, plus zzz/late.py (sorted last) defining very_late_function and app/main.py calling it */
function makeRepo() {
  if (fs.existsSync(path.join(BIG, "app/main.py"))) return;
  const src = path.join(WS, "nanovllm");
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".py")) files.push(path.relative(src, p)); } };
  walk(src);
  let n = 0;
  for (let k = 0; n < FILES - 2; k++) for (const f of files) {
    if (n >= FILES - 2) break;
    const to = path.join(BIG, `r${String(k).padStart(4, "0")}`, "nanovllm", f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, `${fs.readFileSync(path.join(src, f), "utf8")}\n# copy ${k}\n`); // every file different: no analysis cache hits
    n++;
  }
  fs.mkdirSync(path.join(BIG, "zzz"), { recursive: true });
  fs.writeFileSync(path.join(BIG, "zzz/late.py"), "def very_late_function(x):\n    return x + 1\n");
  fs.mkdirSync(path.join(BIG, "app"), { recursive: true });
  fs.writeFileSync(path.join(BIG, "app/main.py"), "from zzz.late import very_late_function\n\n\ndef main():\n    y = very_late_function(1)\n    return y\n");
}

/** Longest gap between 5 ms timer ticks while fn runs (how long the extension host would not answer anything) */
async function stall<T>(fn: () => Promise<T>): Promise<[number, T]> {
  let last = performance.now(), worst = 0;
  const t = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; }, 5);
  try { const r = await fn(); return [Math.round(worst), r]; } finally { clearInterval(t); }
}

void (async () => {
  if (!fs.existsSync(WS)) execFileSync("git", ["clone", "-q", path.join(REPO, "examples/nano-vllm"), WS]);
  makeRepo();
  const W = nodeWorkspace(BIG);
  useWorkspace(W);
  await startAnalysis();
  const main = path.join(BIG, "app/main.py");
  const text = fs.readFileSync(main, "utf8");
  const sym = analysisOf("python", text).symbols.find((s) => s.qual === "main")!;
  const seg = ((await cardForFileSym(main, sym))!.card as CodeCard).segments[0] as Segment;
  const line = 5, col = text.split("\n")[4].indexOf("very_late_function");
  const click = () => R.expand({ seg, line, col, name: "very_late_function" });
  const found = (r: ExpandResult) => "card" in r && r.card.segments[0].symbol?.qual === "very_late_function";
  // A common name (Scheduler is defined in every copy): pick list of up to 20
  const sch = path.join(BIG, "r0000/nanovllm/engine/llm_engine.py");
  const st = fs.readFileSync(sch, "utf8");
  const ssym = analysisOf("python", st).symbols.find((s) => s.qual === "LLMEngine.__init__")!;
  const sseg = ((await cardForFileSym(sch, ssym))!.card as CodeCard).segments[0] as Segment;
  const sl = st.split("\n").findIndex((l) => /Scheduler\(config\)/.test(l)) + 1;
  const click2 = () => R.expand({ seg: sseg, line: sl, col: st.split("\n")[sl - 1].indexOf("Scheduler"), name: "Scheduler" });

  const bg = (R as { startNameIndex?: () => void }).startNameIndex;
  const t0 = performance.now();
  const [coldStall, cold] = await stall(click);
  const coldMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const [, warm] = await stall(click);
  const warmMs = Math.round(performance.now() - t1);
  const t2 = performance.now();
  const [, common] = await stall(click2);
  const commonMs = Math.round(performance.now() - t2);
  let bgMs: number | undefined, bgStall: number | undefined;
  if (bg) {
    // after: the whole index built in the background (fresh index), worst stall while it runs
    resetIndex();
    const t3 = performance.now();
    [bgStall] = await stall(async () => { bg(); await nameIndexReady(); });
    bgMs = Math.round(performance.now() - t3);
  }
  console.log(JSON.stringify({
    files: FILES, coldClickMs: coldMs, coldClickStallMs: coldStall, foundPastFile8000: found(cold), warmClickMs: warmMs, warmFound: found(warm),
    commonNameMs: commonMs, commonPick: "pick" in common ? common.pick.length : "card" in common ? "card" : "none", backgroundBuildMs: bgMs, backgroundStallMs: bgStall, findFiles: W.finds,
  }));
})().catch((e) => { console.error(e); process.exit(2); });
