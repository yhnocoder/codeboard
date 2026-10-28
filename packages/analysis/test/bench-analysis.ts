// 分析耗时：一个仓库里最大的 40 个 .py（参数给的目录，默认 examples/sglang）。旧 = 逐节点遍历，新 = 查询 + 增量 + 按行
// 跑法：npm run bench:analysis -w @codeboard/analysis [-- <目录>]（sglang 先 git submodule update --init --depth 1 examples/sglang）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import TS from "@vscode/tree-sitter-wasm";
import { initAnalysis, analyze, languageOf, forgetTree, setTreeCacheSize } from "../src";
import { analyzeOld } from "./oracle/analysis-old";

const dir = process.argv[2] ?? new URL("../../../examples/sglang", import.meta.url).pathname;
const files = execFileSync("bash", ["-c", `find ${dir} -name '*.py' -printf '%s %p\\n' | sort -rn | head -40`], { encoding: "utf8" }).trim().split("\n").map((l) => l.split(" ")[1]);
const texts = files.map((f) => readFileSync(f, "utf8"));
await initAnalysis();
setTreeCacheSize(2 * files.length + 4); // 每个文件一棵树，不让 LRU 挤掉
const p = new TS.Parser(); p.setLanguage(languageOf("python")!);

const now = () => performance.now();
function time(fn: () => void, rounds = 5) {
  const ts: number[] = [];
  for (let r = 0; r < rounds; r++) { const t0 = now(); fn(); ts.push(now() - t0); }
  ts.sort((a, b) => a - b);
  return ts[rounds >> 1];
}
// 一行改动：中间那一行末尾加个空格（真实编辑的样子），改完 / 改回轮流
const edited = texts.map((t) => { const i = t.indexOf("\n", t.length >> 1); return t.slice(0, i) + " " + t.slice(i); });
// 段：每个文件里中间位置那个函数（卡片通常是一个函数）
const segs = texts.map((t) => {
  const a = analyze("python", t);
  const defs = a.symbols.filter((s) => s.kind === "def");
  const mid = a.flags.length >> 1;
  return defs.sort((x, y) => Math.abs(x.start - mid) - Math.abs(y.start - mid))[0] ?? { start: 1, end: 20 };
});
const lines = texts.reduce((n, t) => n + t.split("\n").length, 0);
console.log(`${files.length} files, ${lines} lines, ${(texts.reduce((n, t) => n + t.length, 0) / 1e6).toFixed(1)} MB; segs avg ${Math.round(segs.reduce((n, s) => n + s.end - s.start + 1, 0) / segs.length)} lines`);

for (const t of texts) { analyzeOld("python", t); analyze("python", t); } // 预热 JIT
const parse = time(() => { for (const t of texts) p.parse(t)!.delete(); });
const oldFull = time(() => { for (const t of texts) analyzeOld("python", t); });
const newFull = time(() => { for (const t of texts) analyze("python", t); });
// 增量：树已在缓存里（key = 文件），一行改动后再分析
let flip = false;
texts.forEach((t, i) => analyze("python", t, { key: files[i] }));
const incr = time(() => { flip = !flip; texts.forEach((t, i) => analyze("python", flip ? edited[i] : t, { key: files[i] })); }, 6);
const incrParse = time(() => { flip = !flip; texts.forEach((t, i) => { const tr = p.parse(flip ? edited[i] : t)!; tr.delete(); }); }, 6);
// 按行：树在缓存里（同一个文件的第二张卡 / 再次渲染）；树不在（第一次）
const segWarm = time(() => texts.forEach((t, i) => analyze("python", t, { key: files[i], lines: segs[i] })));
forgetTree();
const segCold = time(() => texts.forEach((t, i) => analyze("python", t, { lines: segs[i] })));
const fullWarm = time(() => texts.forEach((t, i) => analyze("python", t, { key: "w" + files[i] })));
const r = (x: number) => `${Math.round(x)} ms`;
console.log(JSON.stringify({ parse: r(parse), oldFull: r(oldFull), oldWalk: r(oldFull - parse), newFull: r(newFull), newQuery: r(newFull - parse), incrNew: r(incr), parseOnly: r(incrParse), segWarm: r(segWarm), segCold: r(segCold), fullWarmTreeCached: r(fullWarm) }, null, 1));
