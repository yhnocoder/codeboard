// Scenario process for run-harness.mjs. Forked with an IPC channel it runs the scenarios it is sent one at a time and
// reports each one's result: failed when it prints a line starting with FAIL, throws, or sets process.exitCode.
// With HARNESS_COV=1 it also reports which source lines of the repo each scenario ran (board code in the page, core code in Node).
// `node run.cjs --list-json` prints every scenario with the test file that defines it.
import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import { Session } from "node:inspector/promises";
import { ready, browsers, covered, REPO } from "./harness";

type Msg = { type: "run"; name: string } | { type: "exit" };

export function main(S: Record<string, () => Promise<void>>, origin: Record<string, string>) {
  if (process.argv.includes("--list-json")) { process.stdout.write(JSON.stringify(origin) + "\n"); return; }
  if (!process.send) { console.error("run this through packages/board/test/run-harness.mjs"); process.exit(2); }
  worker(S).catch((e) => { console.error(e); process.exit(2); });
}

async function worker(S: Record<string, () => Promise<void>>) {
  const send = (m: unknown) => new Promise<void>((r) => process.send!(m, () => r()));
  let cur = "", fails: string[] = [];
  const log = (...a: unknown[]) => {
    const text = util.format(...a);
    if (/^\s*FAIL\b/.test(text)) fails.push(text.trim().slice(0, 400));
    process.send!({ type: "log", name: cur, text });
  };
  console.log = console.info = console.warn = console.error = log;
  process.on("unhandledRejection", (e) => log("FAIL unhandled-rejection", String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ")));
  await ready();
  const node = process.env.HARNESS_COV ? await nodeCoverage() : undefined;
  await node?.take(); // the analysis of nano-vllm at start-up belongs to no scenario
  process.on("message", async (m: Msg) => {
    if (m.type === "exit") process.exit(0);
    cur = m.name; fails = []; process.exitCode = 0;
    const t0 = Date.now();
    let error = "";
    try { await S[m.name](); } catch (e) { error = String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n"); }
    const ms = Date.now() - t0;
    for (const b of [...browsers]) await b.close().catch(() => {});
    if (process.exitCode && !fails.length && !error) fails.push(`FAIL ${m.name} (exit code ${process.exitCode})`);
    process.exitCode = 0;
    let lines: Record<string, string> | undefined;
    if (node) { const acc: Lines = new Map(); pageLines(covered.splice(0), acc); await node.take(acc); lines = packLines(acc); }
    await send({ type: "done", name: m.name, ms, fails, error, lines });
  });
  await send({ type: "ready" });
}

// ---------- coverage → source lines ----------

type Range = { startOffset: number; endOffset: number; count: number };
type Fn = { ranges: Range[] };
/** source file → lines (1-based) that ran */
type Lines = Map<string, Set<number>>;
/** "3-7,9,12-20" per file */
const packLines = (acc: Lines) => Object.fromEntries([...acc].sort(([a], [b]) => a.localeCompare(b)).map(([f, set]) => {
  const ls = [...set].sort((a, b) => a - b), out: string[] = [];
  for (let i = 0; i < ls.length; ) { let j = i; while (j + 1 < ls.length && ls[j + 1] === ls[j] + 1) j++; out.push(i === j ? `${ls[i]}` : `${ls[i]}-${ls[j]}`); i = j + 1; }
  return [f, out.join(",")];
}));

/** Keep files of the repo's own packages, not tests or dependencies */
const ownFile = (abs: string) => {
  const r = path.relative(REPO, abs);
  return /^(packages|extensions)\//.test(r) && !r.includes("node_modules") && !/\/test\//.test(r) ? r : undefined;
};

const maps = new Map<string, { offsets: Int32Array; srcs: Int32Array; srcLines: Int32Array; sources: (string | undefined)[] } | null>();
/** Decoded source map of a generated file: for each mapping, its offset in the generated text, its source index and source line */
function mapOf(file: string, text: string) {
  if (maps.has(file)) return maps.get(file)!;
  let res: ReturnType<typeof mapOf> = null;
  try {
    const m = JSON.parse(fs.readFileSync(file + ".map", "utf8"));
    const dir = path.resolve(path.dirname(file), m.sourceRoot ?? "");
    const sources = (m.sources as string[]).map((s) => ownFile(path.resolve(dir, s.replace(/^webpack:\/\/\//, ""))));
    const lineStart = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStart.push(i + 1);
    const offsets: number[] = [], srcs: number[] = [], srcLines: number[] = [];
    let line = 0, col = 0, src = 0, sline = 0, field = 0, value = 0, shift = 0;
    const seg: number[] = [];
    const flush = () => {
      if (seg.length >= 3) { col += seg[0]; src += seg[1]; sline += seg[2]; offsets.push(lineStart[line] + col); srcs.push(src); srcLines.push(sline + 1); }
      else if (seg.length) col += seg[0];
      seg.length = 0; field = 0;
    };
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (const ch of m.mappings as string) {
      if (ch === ";") { flush(); line++; col = 0; continue; }
      if (ch === ",") { flush(); continue; }
      const d = B64.indexOf(ch);
      value += (d & 31) << shift;
      if (d & 32) { shift += 5; continue; }
      const v = value & 1 ? -(value >>> 1) : value >>> 1;
      // generated column, source index, source line; the source column and name are read and dropped
      if (field < 3) seg.push(v);
      field++; value = 0; shift = 0;
    }
    flush();
    res = { offsets: Int32Array.from(offsets), srcs: Int32Array.from(srcs), srcLines: Int32Array.from(srcLines), sources };
  } catch { res = null; }
  maps.set(file, res);
  return res;
}

/** Source lines with a mapping inside code that ran (V8 block coverage: the innermost range decides), added to acc */
function linesRun(file: string, text: string, fns: Fn[], acc: Lines) {
  const m = mapOf(file, text);
  if (!m) return;
  const ranges = fns.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const order = [...m.offsets.keys()].sort((a, b) => m.offsets[a] - m.offsets[b]);
  const stack: Range[] = [];
  let p = 0;
  for (const k of order) {
    const o = m.offsets[k];
    while (p < ranges.length && ranges[p].startOffset <= o) {
      while (stack.length && stack[stack.length - 1].endOffset <= ranges[p].startOffset) stack.pop();
      stack.push(ranges[p++]);
    }
    while (stack.length && stack[stack.length - 1].endOffset <= o) stack.pop();
    const src = m.sources[m.srcs[k]];
    if (!src || !stack.length || stack[stack.length - 1].count <= 0) continue;
    let set = acc.get(src);
    if (!set) acc.set(src, (set = new Set()));
    set.add(m.srcLines[k]);
  }
}

function pageLines(entries: typeof covered, acc: Lines) {
  for (const e of entries) if (e.url.startsWith("file://") && e.source) linesRun(decodeURIComponent(new URL(e.url).pathname), e.source, e.functions, acc);
}

/** Precise coverage of this Node process (the harness's host side runs core: analysis, patches, storage) */
async function nodeCoverage() {
  const s = new Session();
  s.connect();
  await s.post("Profiler.enable");
  await s.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  const self = process.argv[1];
  const text = fs.readFileSync(self, "utf8");
  return {
    async take(acc?: Lines) {
      const { result } = await s.post("Profiler.takePreciseCoverage");
      const mine = result.find((r) => r.url === self || r.url === "file://" + self);
      if (mine && acc) linesRun(self, text, mine.functions, acc);
    },
  };
}
