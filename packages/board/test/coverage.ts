// Which of the repo's source files a scenario runs (nightly, HARNESS_COV=1): the impact map tools/test/pick.mjs picks
// scenarios from. A file counts when a function in it ran, found through the source maps of the bundles that ran: the board
// page's (the board is built with BOARD_SOURCEMAP=1) and the scenarios' own (core and extension code playing the host in the
// Playwright worker). A module's top level runs on every import, so it never counts.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Session } from "node:inspector/promises";
import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import { REPO, type PageCoverage } from "./harness";

type Range = { startOffset: number; endOffset: number; count: number };
type Fn = { ranges: Range[] };

/** A source file of the repo's own packages (not tests or dependencies), relative to the repo */
const ownFile = (abs: string) => {
  const r = path.relative(REPO, abs);
  return /^(packages|extensions)\//.test(r) && !r.includes("node_modules") && !/\/test\//.test(r) ? r : undefined;
};
const fileOf = (url: string) => (url.startsWith("file://") ? fileURLToPath(url) : url);

/** The ranges of a script's functions, outermost first; the script's own top level (the first function, from offset 0) left out */
const ranOf = (fns: Fn[]) =>
  fns.flatMap((f, i) => (i === 0 && f.ranges[0]?.startOffset === 0 ? [] : f.ranges))
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);

type Mappings = { offsets: number[]; sources: (string | undefined)[]; srcs: number[] };
const maps = new Map<string, Mappings | null>();
/** Each mapping of a bundle file: its offset in the generated text and its source */
function mappingsOf(file: string, text: string): Mappings | null {
  if (maps.has(file)) return maps.get(file)!;
  let res: Mappings | null = null;
  try {
    const map = new TraceMap(fs.readFileSync(file + ".map", "utf8"), pathToFileURL(file + ".map").href);
    const sources = map.resolvedSources.map((s) => ownFile(fileOf(s)));
    const lineStart = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStart.push(i + 1);
    const offsets: number[] = [], srcs: number[] = [];
    decodedMappings(map).forEach((segs, line) => { for (const s of segs) if (s.length >= 4) { offsets.push(lineStart[line] + s[0]); srcs.push(s[1]!); } });
    res = { offsets, sources, srcs };
  } catch { res = null; }
  maps.set(file, res);
  return res;
}

/** Sources of the bundle `file` with a mapping inside code that ran (V8 block coverage: the innermost range decides) */
function bundleSources(file: string, text: string, fns: Fn[], out: Set<string>) {
  const m = mappingsOf(file, text);
  if (!m) return;
  const ranges = ranOf(fns);
  const order = m.offsets.map((_: number, i: number) => i).sort((a: number, b: number) => m.offsets[a] - m.offsets[b]);
  const stack: Range[] = [];
  let p = 0;
  for (const k of order) {
    const o = m.offsets[k], src = m.sources[m.srcs[k]];
    while (p < ranges.length && ranges[p].startOffset <= o) {
      while (stack.length && stack[stack.length - 1].endOffset <= ranges[p].startOffset) stack.pop();
      stack.push(ranges[p++]);
    }
    while (stack.length && stack[stack.length - 1].endOffset <= o) stack.pop();
    if (src && stack.length && stack[stack.length - 1].count > 0) out.add(src);
  }
}

export function pageFiles(entries: PageCoverage, out: Set<string>) {
  for (const e of entries) if (e.url.startsWith("file://") && e.source) bundleSources(fileOf(e.url), e.source, e.functions, out);
}

/** Precise coverage of this worker process; take() adds the files run since the last take() */
export async function nodeCoverage() {
  const s = new Session();
  s.connect();
  await s.post("Profiler.enable");
  await s.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  return {
    async take(out?: Set<string>) {
      const { result } = await s.post("Profiler.takePreciseCoverage");
      if (!out) return;
      for (const r of result) {
        if (!r.url.startsWith("file://")) continue;
        const file = fileURLToPath(r.url);
        if (fs.existsSync(file + ".map")) bundleSources(file, fs.readFileSync(file, "utf8"), r.functions, out);
      }
    },
  };
}
