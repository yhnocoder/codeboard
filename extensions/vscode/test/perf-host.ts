// 宿主性能：打开白板（所有段的高亮 + 版本状态）和 HEAD 变了之后的版本检查，在 nano-vllm 的一份拷贝上量。
// 用法：node extensions/vscode/test/run-perf-host.mjs [--cards 240] [--runs 3]
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { analyze, initAnalysis } from "@codeboard/core/analysis";
import { uid, type Segment } from "@codeboard/core";
import { startAnalysis } from "../src/analysis";
import { staleFor } from "../src/versions";
import { viewsFor } from "../src/views";
import { forgetHeads } from "../src/git";
import { WS } from "./vscode-stub";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg("cards", "240"), RUNS = +arg("runs", "3");
const REPO = path.resolve(__dirname, ".."); // 打包后在 test-out/
const git = (...a: string[]) => execFileSync("git", a, { cwd: WS, encoding: "utf8" }).trim();

/** 钉在 commit 上的 n 段：nano-vllm 里所有函数，不够就重复 */
function segments(commit: string, n: number): Segment[] {
  const files = git("ls-tree", "-r", "--name-only", commit, "nanovllm").split("\n").filter((f) => f.endsWith(".py"));
  const all: Segment[] = [];
  for (const f of files) {
    const text = git("show", `${commit}:${f}`);
    const lines = text.split("\n");
    for (const s of analyze("python", text).symbols) if (s.kind === "def") all.push({ id: uid("s"), src: { kind: "repo", repo: "" }, path: f, lang: "python", start: s.start, end: s.end, text: lines.slice(s.start - 1, s.end), version: { kind: "git", commit }, symbol: { qual: s.qual, kind: "function" } });
  }
  const out: Segment[] = [];
  for (let i = 0; out.length < n; i++) out.push({ ...all[i % all.length], id: uid("s") });
  return out;
}

async function time<T>(f: () => Promise<T>) { const t = performance.now(); const r = await f(); return [performance.now() - t, r] as const; }

void (async () => {
  if (!fs.existsSync(WS)) execFileSync("git", ["clone", "-q", path.join(REPO, "examples/nano-vllm"), WS]);
  const wasm = path.join(REPO, "node_modules/@vscode/tree-sitter-wasm/wasm");
  await initAnalysis(wasm);
  await startAnalysis(wasm);
  const head = git("rev-parse", "HEAD");
  const old = git("rev-parse", "HEAD~6"); // 早于 chunked prefill 重构：scheduler、block_manager 都改过
  for (let r = 0; r < RUNS; r++) {
    // 每轮都是新进程才公平（缓存）；这里用一份新的段（新 id）+ 清 HEAD 缓存近似
    forgetHeads();
    const atHead = segments(head, N), atOld = segments(old, N);
    const [coldCheck] = r === 0 ? await time(() => staleFor(atOld)) : [0];
    const [open] = await time(() => Promise.all([viewsFor(atHead), staleFor(atHead)]));
    const [check] = await time(() => staleFor(atHead));
    const [openOld] = await time(() => Promise.all([viewsFor(atOld), staleFor(atOld)]));
    const [checkOld, st] = await time(() => staleFor(atOld));
    const changed = Object.values(st).filter((s) => s.state !== "ok").length;
    console.log(JSON.stringify({ segs: N, coldCheckOld: Math.round(coldCheck), openAtHead: Math.round(open), checkAtHead: Math.round(check), openOld: Math.round(openOld), checkOld: Math.round(checkOld), notOk: changed }));
  }
})();
