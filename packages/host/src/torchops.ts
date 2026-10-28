// PyTorch 算子路由：工作区里有 aten/src/ATen/native/native_functions.yaml 时（PyTorch 本身、fork、vendored 的副本），
// Python / C++ 的算子入口 → yaml 里这个算子的 dispatch 表 → 每种设备的 C++ / CUDA kernel。
// 语言服务到 .pyi 存根（Python）就停了，或者在 dispatcher 里绕圈（C++），能走到 kernel 的只有 yaml。
// 路由要用的文件在后台扫一遍；点击只查表，文件事件让表跟着更新。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { grammarOfFile } from "@codeboard/analysis/langs";
import { dispatchAll, macroCalls, pasteMacros, pastedNames, pybindAll, pyMethodAll, type CallSite, type Paster, type Sym } from "@codeboard/analysis";
import { escapeRegExp } from "@codeboard/analysis/basics";
import { analysisOf, symbolsOf, whenAnalysisReady } from "./analysis";
import { entriesOf, indexedFiles, isCode, knownEntries, type IndexEntry } from "./nameindex";
import { exists, langOf, readText, workspace } from "./ws";
import { log } from "./log";

// 这里的一切都和白板一起跑在 extension host 的线程上：长循环每几毫秒让出一次事件循环。
// （worker 线程要单独打包，读不到编辑器里没保存的内容，也共享不了名字索引；活儿主要是读文件和正则，切得开。）
const SLICE_MS = 8;
function slicer() {
  let t = performance.now();
  return async () => {
    if (performance.now() - t < SLICE_MS) return;
    await new Promise((r) => setImmediate(r));
    t = performance.now();
  };
}

export const OPS_YAML = "aten/src/ATen/native/native_functions.yaml";

/** yaml 里的一个 func：add.out → name add，overload out；逗号连着的 key 拆开（CPU, CUDA: f → 两条） */
export type OpDecl = {
  name: string; overload: string; line: number; dispatch: [string, string][]; structured: boolean; delegate?: string; ufunc: boolean;
  variants: string[]; out: boolean;
};
export type OpTable = { root: string; yaml: string; decls: OpDecl[]; byName: Map<string, OpDecl[]>; byFull: Map<string, OpDecl> };
/**
 * 一个 kernel：dispatch key、C++ 名字、写在哪个 func 上（via = 经 structured_delegate 走到的 func）；
 * inner = 有 ufunc_inner_loop 的算子：kernel 是生成的 ufunc_add_CUDA（有构建才找得到），没有就是手写的 ufunc::add
 */
export type Kernel = { key: string; kernel: string; decl: string; via?: string; inner?: string };

const fullName = (d: Pick<OpDecl, "name" | "overload">) => (d.overload ? `${d.name}.${d.overload}` : d.name);

/**
 * native_functions.yaml 的文本 → 一个一个的 func：每个顶层的 "- " 条目单独解析（文件里没有跨条目的锚点），
 * 这样调用方可以在条目之间让出，编辑到一半写坏的条目也只丢这一个 func
 */
function* opEntries(text: string, bad: { n: number }): Generator<OpDecl> {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && !lines[i].startsWith("- ")) continue;
    if (start >= 0) {
      let e: Record<string, unknown> | undefined;
      try { e = (parse(lines.slice(start, i).join("\n")) as Record<string, unknown>[] | null)?.[0]; } catch { bad.n++; }
      const d = e && declOf(e, start + 1);
      if (d) yield d;
    }
    start = i;
  }
}

function declOf(e: Record<string, unknown>, line: number): OpDecl | null {
  const m = /^([\w]+)(?:\.(\w+))?\s*\(([\s\S]*)\)\s*->/.exec(String(e.func ?? ""));
  if (!m) return null;
  const dispatch: [string, string][] = [];
  for (const [keys, k] of Object.entries((e.dispatch ?? {}) as Record<string, unknown>)) for (const key of keys.split(",")) dispatch.push([key.trim(), String(k)]);
  return {
    name: m[1], overload: m[2] ?? "", line, dispatch, structured: e.structured === true,
    delegate: typeof e.structured_delegate === "string" ? e.structured_delegate : undefined,
    ufunc: !!e.ufunc_inner_loop, variants: String(e.variants ?? "function").split(",").map((v) => v.trim()),
    out: /\*[^]*Tensor\(\w!\)/.test(m[3]), // 关键字参数里有可写的 Tensor：out 变体
  };
}

export const parseOps = (text: string): OpDecl[] => [...opEntries(text, { n: 0 })];

/** 不阻塞的 parseOps：整个文件要 300–600 ms */
async function parseOpsSliced(text: string, bad: { n: number }): Promise<OpDecl[]> {
  const out: OpDecl[] = [], turn = slicer();
  for (const d of opEntries(text, bad)) { out.push(d); await turn(); }
  return out;
}

export function opTable(root: string, yaml: string, decls: OpDecl[]): OpTable {
  const byName = new Map<string, OpDecl[]>(), byFull = new Map<string, OpDecl>();
  for (const d of decls) { (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d); byFull.set(fullName(d), d); }
  return { root, yaml, decls, byName, byFull };
}

/** torchgen 的 cpp.name：add_ → add_，out 变体加 _out（没有 dispatch 的 func 的 CompositeImplicitAutograd kernel 名） */
const cppName = (d: OpDecl) => d.name + (d.out ? "_out" : "");

/** 一个 func 的所有 kernel：自己的 dispatch；自己没有的 key 从 structured_delegate 拿；ufunc 的 CPU / CUDA；都没有 = CompositeImplicitAutograd */
export function declKernels(t: OpTable, d: OpDecl): Kernel[] {
  const own: Kernel[] = d.dispatch.map(([key, kernel]) => ({ key, kernel, decl: fullName(d) }));
  const has = (key: string, xs: Kernel[]) => xs.some((k) => k.key === key);
  const out = [...own];
  const target = d.delegate ? t.byFull.get(d.delegate) : d.structured ? d : undefined;
  if (target && target !== d) for (const k of declKernels(t, target)) if (!has(k.key, out)) out.push({ ...k, decl: fullName(d), via: k.decl });
  if (target === d && d.ufunc) for (const key of ["CUDA", "CPU"]) if (!has(key, out)) out.push({ key, kernel: `ufunc_${d.name}_${key}`, decl: fullName(d), inner: d.name });
  if (!d.dispatch.length && !d.delegate) out.push({ key: "CompositeImplicitAutograd", kernel: cppName(d), decl: fullName(d) });
  return out;
}

/** 0 = CUDA，1 = CPU，2 = Composite*，3 = 其他（MPS、XPU、Sparse、Nested、Meta…） */
export const keyRank = (key: string) => (key === "CUDA" ? 0 : key === "CPU" ? 1 : /^Composite/.test(key) ? 2 : 3);

/**
 * 算子 name（overload 可选）的 kernel：CUDA 在前，然后 CPU、Composite；这些都没有时才给别的 key。
 * 同一个 C++ 名字的几个 key 合成一条（key 用逗号连起来）
 */
export function kernelsOf(t: OpTable, name: string, overload?: string): Kernel[] {
  // 没给 overload：默认的 func 在前，然后别的非 out 的，out 变体最后（边界标的是最像这次调用的那个）
  const rank = (d: OpDecl) => (!d.overload ? 0 : d.out ? 2 : 1);
  const decls = overload !== undefined ? [t.byFull.get(overload ? `${name}.${overload}` : name)].filter((d): d is OpDecl => !!d)
    : [...(t.byName.get(name) ?? [])].sort((a, b) => rank(a) - rank(b));
  const all = decls.flatMap((d) => declKernels(t, d));
  const main = all.filter((k) => keyRank(k.key) <= 2);
  const list = (main.length ? main : all).map((k, i) => ({ k, i })).sort((a, b) => keyRank(a.k.key) - keyRank(b.k.key) || a.i - b.i).map((x) => x.k);
  const out: Kernel[] = [];
  for (const k of list) {
    const same = out.find((o) => o.kernel === k.kernel);
    if (same) { if (!same.key.split(", ").includes(k.key)) same.key += `, ${k.key}`; } else out.push({ ...k });
  }
  return out;
}

const isCudaFile = (abs: string) => /\.(cu|cuh)$/.test(abs) || /[\\/](cuda|cudnn|miopen)[\\/]/.test(abs);

// 扫描：aten/src/ATen（yaml 往上两层）和 torch/csrc 下的代码文件，加上构建生成的 Ufunc*.cpp / .cu（名字索引跳过 build/）。
// 只留定义位置和注册，不留文件文本：每个文件注册了什么、提到了哪些要找的名字（kernel、注册目标），以及那几个生成文件的 tree-sitter 符号。

/** 一处注册：文件和行、注册的目标（qual）；how = REGISTER_*DISPATCH、pybind .def / m.def、PyMethodDef */
export type Reg = { abs: string; line: number; target?: string; lambda?: true; how: string };
/** 由宏调用定义的 kernel（CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)） */
type MacroSite = { abs: string; line: number; macro: string; sig: string };
/**
 * 一个文件给扫描的表加了什么。pasters = 它里面用 ## 拼名字的 #define；pasted = 它调用这些宏拼出来的 kernel（第 2 遍：#define 可能在别的文件里）
 */
type FileRec = { regs: [string, Reg][]; pyRegs: [string, Reg][]; macros: [string, MacroSite][]; words: string[]; gen: IndexEntry[]; pasters: [string, Paster][]; pasted: [string, MacroSite][] };
type Scan = {
  t: OpTable; aten: string; csrc: string;
  /** <build>/aten/src/ATen，torchgen 把 Ufunc kernel 写在这里（没有：没构建过，或者没有 compile_commands.json） */
  genDir?: string;
  /** 要在文件里找的名字：yaml 里的 kernel 和 ufunc inner loop，再加注册目标；值是拷贝出来的扁平字符串 */
  wanted: Map<string, string>;
  files: Map<string, FileRec>;
  regs: Map<string, Reg[]>; pyRegs: Map<string, Reg[]>; macros: Map<string, MacroSite[]>; gen: Map<string, IndexEntry[]>;
  pasters: Map<string, { abs: string; p: Paster }[]>;
  /** 要找的名字 → 提到它的文件 */
  where: Map<string, Set<string>>;
  /** 第 1 遍完成：kernel、注册 */
  head: Promise<void>;
  /** 第 2 遍完成：注册目标 */
  ready: Promise<void>;
  /** 文件更新在扫描之后一个接一个跑 */
  queue: Promise<void>;
  /** 排着、还没开始的文件更新（同一个文件再变只排一次：git checkout 一下来几千个事件，保存还会从 onDidSave 和监听各来一次） */
  pending: Set<string>;
  /** 排着、还没开始的第 2 遍重做 / 构建目录重找（一次就够） */
  retarget?: true; rebuild?: true;
  dead?: true;
  /** 来自 yaml 的名字（第 1 遍就找它们的文件） */
  yamlNames: Set<string>;
};
const scans = new Map<string, Scan>();

const push = <V>(m: Map<string, V[]>, k: string, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const MACRO_CALL = /^[ \t]*([A-Z][A-Z0-9_]*)\s*\(([^()]*)\)/gm;
const UFUNC_FILE = /^Ufunc\w*\.(cpp|cu)$/;
// 文件文本的子串会让整个文本一直活着（V8 的 sliced string）：扫描留下的字符串都拷一份
const own = (s: string) => Buffer.from(s, "utf8").toString("utf8");

const isGen = (x: Scan, abs: string) => !!x.genDir && path.dirname(abs) === x.genDir;
const inScan = (x: Scan, abs: string) => (isGen(x, abs) ? UFUNC_FILE.test(path.basename(abs)) : isCode(abs) && (abs.startsWith(x.aten) || abs.startsWith(x.csrc)));

/**
 * 构建生成的 ATen 目录，从 clangd 用的 compile_commands.json 找：clangd 的 --compile-commands-dir 指的目录，
 * 没有就是 <root>、<root>/build、<root>/build/* 里第一个有它的。它的条目写着编译的是哪个生成的 Ufunc*.cpp，
 * 所以文件是源码根目录下的一份副本时（PyTorch 的 setup.py 会拷一份过去）也能找到真正的目录
 */
export async function genDirOf(root: string): Promise<string | undefined> {
  const args = workspace().settings.get<unknown>("clangd.arguments");
  const ws = workspace().files.rootOf(root) ?? root;
  const dirs: string[] = [];
  if (Array.isArray(args)) {
    const i = args.findIndex((a) => typeof a === "string" && /^--compile-commands-dir(=|$)/.test(a));
    const v = i < 0 ? undefined : /=/.test(args[i]) ? String(args[i]).replace(/^[^=]*=/, "") : args[i + 1];
    if (typeof v === "string" && v) dirs.push(path.resolve(ws, v.replace(/\$\{(workspaceFolder|workspaceRoot)\}/g, ws)));
  }
  dirs.push(root, path.join(root, "build"));
  try { for (const d of (await fs.readdir(path.join(root, "build"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) if (d.isDirectory()) dirs.push(path.join(root, "build", d.name)); } catch { /* no build/ */ }
  for (const d of dirs) {
    const text = await readText(path.join(d, "compile_commands.json"), false);
    if (text === null) continue;
    // 只看 "file" 的值：command 也以同一个路径结尾（… -c <file>），引号里还有转义的引号
    for (const m of text.matchAll(UFUNC_FILE_KEY)) {
      let file: unknown;
      try { file = JSON.parse(m[1]); } catch { continue; }
      if (typeof file === "string" && UFUNC_PATH.test(file)) return path.dirname(path.resolve(d, file));
    }
    return d === root ? undefined : path.join(d, "aten", "src", "ATen"); // 没有编译 Ufunc 文件的条目：按通常的布局
  }
  return undefined;
}
const UFUNC_PATH = /[\\/]aten[\\/]src[\\/]ATen[\\/]Ufunc\w*\.(cpp|cu)$/;
const UFUNC_FILE_KEY = /"file"\s*:\s*("(?:[^"\\]|\\.)*Ufunc\w*\.(?:cpp|cu)")/g;

/** 一个文件注册了什么、它的宏调用定义了哪些 kernel、提到了哪些要找的名字 */
function scanText(x: Scan, abs: string, text: string): FileRec {
  const rec: FileRec = { regs: [], pyRegs: [], macros: [], words: [], gen: [], pasters: [], pasted: [] };
  const aten = isGen(x, abs) || abs.startsWith(x.aten), csrc = abs.startsWith(x.csrc);
  if (aten) {
    for (const r of dispatchAll(text)) rec.regs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), how: own(r.macro) }]);
    let starts: number[] | undefined, n = 0; // 宏调用按顺序出现：行号接着上一个往下数
    const lineAt = (i: number) => { starts ??= [...text.matchAll(/\n/g)].map((m) => m.index); while (n < starts.length && starts[n] < i) n++; return n + 1; };
    for (const m of text.matchAll(MACRO_CALL)) for (const id of m[2].match(/\b[A-Za-z_]\w*\b/g) ?? []) {
      const k = x.wanted.get(id);
      if (k) rec.macros.push([k, { abs, line: lineAt(m.index), macro: own(m[1]), sig: own(m[0].trim()) }]);
    }
    if (!isGen(x, abs)) for (const [name, p] of pasteMacros(text)) rec.pasters.push([own(name), { params: p.params.map(own), names: p.names.map((n) => n.map((v) => (typeof v === "string" ? own(v) : v))) }]);
  }
  if (csrc) {
    for (const r of pybindAll(text)) rec.pyRegs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), lambda: r.lambda, how: `pybind · ${path.basename(abs)} ${r.how}` }]);
    for (const r of pyMethodAll(text)) rec.pyRegs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), how: `PyMethodDef · ${path.basename(abs)}` }]);
  }
  if (isGen(x, abs)) {
    for (const s of symbolsOf(langOf(abs), text)) if (s.kind === "def") rec.gen.push({ name: own(s.name), qual: own(s.qual), kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: own(s.sig) });
  } else rec.words = wordsIn(x, text);
  return rec;
}

function wordsIn(x: Scan, text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z_]\w*/g)) { const k = x.wanted.get(m[0]); if (k) seen.add(k); }
  return [...seen];
}

function addRec(x: Scan, abs: string, rec: FileRec) {
  x.files.set(abs, rec);
  for (const [k, r] of rec.regs) push(x.regs, k, r);
  for (const [k, r] of rec.pyRegs) push(x.pyRegs, k, r);
  for (const [k, m] of rec.macros) push(x.macros, k, m);
  for (const e of rec.gen) push(x.gen, e.name, e);
  for (const [k, p] of rec.pasters) push(x.pasters, k, { abs, p });
  for (const [k, m] of rec.pasted) push(x.macros, k, m);
  for (const w of rec.words) (x.where.get(w) ?? x.where.set(w, new Set()).get(w)!).add(abs);
}

function dropRec(x: Scan, abs: string) {
  const rec = x.files.get(abs);
  if (!rec) return;
  x.files.delete(abs);
  const drop = <V extends { abs: string }>(m: Map<string, V[]>, keys: Iterable<string>) => {
    for (const k of keys) { const rest = (m.get(k) ?? []).filter((v) => v.abs !== abs); if (rest.length) m.set(k, rest); else m.delete(k); }
  };
  drop(x.regs, rec.regs.map(([k]) => k));
  drop(x.pyRegs, rec.pyRegs.map(([k]) => k));
  drop(x.macros, [...rec.macros, ...rec.pasted].map(([k]) => k));
  drop(x.pasters, rec.pasters.map(([k]) => k));
  drop(x.gen, rec.gen.map((e) => e.name));
  for (const w of rec.words) { const s = x.where.get(w); s?.delete(abs); if (s && !s.size) x.where.delete(w); }
}

/** 注册目标也成为要找的名字（它们的定义和 kernel 一样查） */
function wantTargets(x: Scan, rec: FileRec) {
  for (const [, r] of [...rec.regs, ...rec.pyRegs]) if (r.target) { const n = r.target.split("::").pop()!; if (!x.wanted.has(n)) x.wanted.set(n, own(n)); }
}

async function genFiles(x: Scan): Promise<string[]> {
  const dir = x.genDir;
  if (!dir) return [];
  try { return (await fs.readdir(dir)).filter((f) => UFUNC_FILE.test(f)).map((f) => path.join(dir, f)); } catch { return []; }
}

/** 第 1 遍：注册、宏定义的 kernel、yaml 里的名字在哪些文件；大多数点击有这些就够了 */
async function scanHead(x: Scan) {
  const t0 = performance.now(), turn = slicer();
  const files = (await indexedFiles()).map((f) => f.abs).filter((a) => inScan(x, a));
  x.genDir = await genDirOf(x.t.root);
  const gen = await genFiles(x);
  for (const abs of [...gen, ...files]) {
    if (x.dead) return;
    const text = await readText(abs, false);
    if (text !== null) { const rec = scanText(x, abs, text); addRec(x, abs, rec); wantTargets(x, rec); }
    await turn();
  }
  return Math.round(performance.now() - t0);
}

/** 所有文件都读过之后一个文件再加的：提到的注册目标、调用拼名字的宏拼出来的 kernel */
function targetsIn(x: Scan, abs: string, rec: FileRec, text: string) {
  const had = new Set(rec.words), words = wordsIn(x, text).filter((w) => !had.has(w));
  rec.words.push(...words);
  for (const w of words) (x.where.get(w) ?? x.where.set(w, new Set()).get(w)!).add(abs);
  for (const [k, m] of rec.pasted) { const rest = (x.macros.get(k) ?? []).filter((v) => v !== m); if (rest.length) x.macros.set(k, rest); else x.macros.delete(k); }
  rec.pasted = [];
  if (!abs.startsWith(x.aten)) return;
  for (const c of macroCalls(text, (n) => x.pasters.has(n))) {
    const defs = x.pasters.get(c.macro)!, here = defs.filter((d) => d.abs === abs);
    // 同一个宏名在不同文件里可能是不同的 #define（CPU 和 CUDA 文件里的 FOREACH_BINARY_OP_SCALAR）
    const made = new Set((here.length ? here : defs.filter((d) => d.p.params.length === c.args.length)).flatMap((d) => pastedNames(d.p, c.args)));
    for (const n of made) { const k = x.yamlNames.has(n) && x.wanted.get(n); if (k) rec.pasted.push([k, { abs, line: c.line, macro: own(c.macro), sig: own(c.sig) }]); }
  }
  for (const [k, m] of rec.pasted) push(x.macros, k, m);
}

/** 第 2 遍：第 1 遍找到的注册目标、拼名字的宏拼出来的 kernel 在哪些文件。文件重新读而不是留着：文本有 ~80 MB 堆 */
async function scanTargets(x: Scan): Promise<number> {
  const t0 = performance.now(), turn = slicer();
  for (const [abs, rec] of [...x.files]) {
    if (x.dead) break;
    if (isGen(x, abs) || x.files.get(abs) !== rec) continue; // 这期间文件事件已经重做过了
    const text = await readText(abs, false);
    if (text !== null && x.files.get(abs) === rec) targetsIn(x, abs, rec, text);
    await turn();
  }
  return Math.round(performance.now() - t0);
}
const counts = (x: Scan) => `${x.files.size} files of ${x.t.root}, ${x.regs.size} dispatch stubs, ${x.pyRegs.size} Python names`;

/** 扫描范围里的文件变了（保存、新建、在外面改了、删了）：扫描完后只重做这一个文件 */
function rescanFile(x: Scan, abs: string) {
  if (x.pending.has(abs)) return;
  x.pending.add(abs);
  x.queue = x.queue.then(async () => {
    x.pending.delete(abs); // 从这里开始的改动要再排一次：这次读到的可能是改之前的
    await x.ready;
    if (x.dead) return;
    const text = await readText(abs, false);
    const mine = () => JSON.stringify(x.files.get(abs)?.pasters ?? []);
    const before = mine();
    dropRec(x, abs);
    if (text !== null) {
      const rec = scanText(x, abs, text);
      addRec(x, abs, rec);
      // 新的注册目标：现在只在这个文件里找；别处的通过名字索引解析（regTarget）
      wantTargets(x, rec);
      if (!isGen(x, abs)) targetsIn(x, abs, rec, text);
    }
    // 这里加、删、改了拼名字的宏，别的文件里的调用拼出来的东西也变了：重做第 2 遍
    if (!x.dead && mine() !== before) retarget(x);
  }).catch((e) => log("warn", `op index: cannot update ${abs}: ${e instanceof Error ? e.message : e}`));
}

function retarget(x: Scan) {
  if (x.retarget) return;
  x.retarget = true;
  x.queue = x.queue.then(async () => {
    x.retarget = undefined;
    if (x.dead) return;
    const ms = await scanTargets(x);
    log("info", `op index: second pass again after a macro changed, ${ms} ms`);
  }).catch((e) => log("warn", `op index: cannot redo the second pass: ${e instanceof Error ? e.message : e}`));
}

/**
 * 点击只等扫描（head = 只等第 1 遍，白板刚打开时点击等 ~2 s 而不是 ~5 s），不等排着的文件更新：
 * 每个文件的更新是同步地换掉它那一份（dropRec / addRec），表任何时候都是一致的；git checkout 之后排着的几千个更新不挡点击
 */
const settled = (x: Scan, head?: "head") => (head ? x.head : x.ready);

/** 这个 PyTorch 的扫描（第一次被要时开始；点击等它完成，之后只查表） */
export function scanOf(t: OpTable): Scan {
  let x = scans.get(t.root);
  if (!x) {
    const wanted = new Map<string, string>();
    for (const d of t.decls) for (const k of declKernels(t, d)) for (const n of [k.kernel, k.inner]) if (n && !wanted.has(n)) wanted.set(n, own(n));
    const s: Scan = {
      t, aten: path.dirname(path.dirname(t.yaml)) + path.sep, csrc: path.join(t.root, "torch", "csrc") + path.sep,
      wanted, yamlNames: new Set(wanted.keys()), files: new Map(), regs: new Map(), pyRegs: new Map(), macros: new Map(), gen: new Map(), pasters: new Map(), where: new Map(),
      head: Promise.resolve(), ready: Promise.resolve(), queue: Promise.resolve(), pending: new Set(),
    };
    const fail = (e: unknown) => log("warn", `op index: scan failed: ${e instanceof Error ? e.message : e}`);
    const first = whenAnalysisReady().then(() => scanHead(s));
    s.head = first.then(() => undefined, fail);
    s.ready = first.then(async (a) => {
      const b = await scanTargets(s);
      if (!s.dead) log("info", `op index: ${counts(s)}, ${a} + ${b} ms`);
    }).catch(fail);
    scans.set(t.root, (x = s));
  }
  return x;
}
/** 白板打开时：找 yaml、开始扫描、等它完成 */
export async function warmOps() { await Promise.all((await opTables()).map((t) => scanOf(t).ready)); }

/** 一个 DispatchStub 的注册 */
export async function stubRegs(t: OpTable, stub: string): Promise<Reg[]> {
  const x = scanOf(t);
  await settled(x, "head");
  return x.regs.get(stub) ?? [];
}
/** 一个 Python 名字的 pybind / PyMethodDef 注册 */
export async function pyRegs(t: OpTable, name: string): Promise<Reg[]> {
  const x = scanOf(t);
  await settled(x, "head");
  return x.pyRegs.get(name) ?? [];
}

/** name 的定义：在提到它的文件里（分析进名字索引，只一次）和生成的文件里 */
export async function defsOf(t: OpTable, name: string): Promise<IndexEntry[]> {
  const x = scanOf(t);
  await settled(x, x.yamlNames.has(name) ? "head" : undefined);
  const out: IndexEntry[] = [];
  for (const abs of x.where.get(name) ?? []) for (const e of await entriesOf(abs)) if (e.name === name) out.push(e);
  return [...out, ...(x.gen.get(name) ?? [])];
}

/** kernel 的 C++ 定义：at::native::name 优先；CUDA key 优先 .cu / cuda/ 里的，其他 key 优先别处的；ufunc：生成的 ufunc_add_CUDA，没有就是 ufunc::add */
export async function kernelEntry(t: OpTable, k: Kernel): Promise<IndexEntry | undefined> {
  const x = scanOf(t);
  const ok = (e: IndexEntry) => e.kind === "def" && (e.abs.startsWith(x.aten) || isGen(x, e.abs)) && grammarOfFile(e.abs) === "cpp";
  let ents = (await defsOf(t, k.kernel)).filter(ok);
  if (!ents.length && k.inner) ents = (await defsOf(t, k.inner)).filter((e) => ok(e) && /(^|::)ufunc::/.test(e.qual));
  const cuda = k.key.split(", ")[0] === "CUDA";
  const score = (e: IndexEntry) => (e.qual.endsWith(`native::${k.kernel}`) ? 2 : 0) + (isCudaFile(e.abs) === cuda ? 1 : 0);
  return ents.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => b.s - a.s || a.i - b.i)[0]?.e;
}

/**
 * 宏定义的 kernel：名字是某个顶层全大写宏调用的参数（CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)）。
 * 目标就是那一行（从那里接着点 acos_stub）
 */
export async function macroKernel(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const x = scanOf(t);
  await settled(x, "head");
  if (!x.macros.has(k.kernel)) await settled(x); // 拼名字的宏拼出来的：第 2 遍之后才知道
  const cuda = k.key.split(", ")[0] === "CUDA";
  const m = [...(x.macros.get(k.kernel) ?? [])].sort((a, b) => (isCudaFile(a.abs) === cuda ? 0 : 1) - (isCudaFile(b.abs) === cuda ? 0 : 1))[0];
  return m ? { abs: m.abs, sym: { name: k.kernel, qual: `${m.macro}(${k.kernel})`, kind: "def", start: m.line, defLine: m.line, end: m.line, sig: m.sig, params: [] } } : null;
}

/** 名字索引的一条 → 带完整分析（参数）的符号 */
export async function entrySym(e: IndexEntry): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(e.abs);
  if (text === null) return null;
  const sym = analysisOf(langOf(e.abs), text).symbols.find((s) => s.qual === e.qual && s.defLine === e.defLine)
    ?? { name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] };
  return { abs: e.abs, sym };
}

/** kernel 的符号；索引里没有就是定义它的宏调用 */
export async function kernelTarget(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const best = await kernelEntry(t, k);
  return best ? entrySym(best) : macroKernel(t, k);
}

/** 注册目标（qual）→ 它的定义：qual 的尾部对得上，注册所在的文件优先 */
export async function regTarget(t: OpTable, r: Reg): Promise<IndexEntry | undefined> {
  const parts = r.target!.split("::");
  const name = parts[parts.length - 1];
  const fit = (e: IndexEntry) => e.kind === "def" && grammarOfFile(e.abs) === "cpp" && e.qual.split("::").slice(-parts.length).join("::") === parts.join("::");
  // 注册所在的文件优先：目标通常就在那里，而且只要第 1 遍
  const near = (await entriesOf(r.abs)).find((e) => e.name === name && fit(e));
  if (near) return near;
  // 扫描之后编辑加上的目标只有名字索引知道
  return (await defsOf(t, name)).find(fit) ?? knownEntries(name).find(fit);
}

// 找 yaml、解析 yaml（同一份文本只一次；文件事件把它丢掉）

let found: Promise<string[]> | undefined;
const tables = new Map<string, Promise<OpTable | null>>();

async function loadTable(yaml: string): Promise<OpTable | null> {
  const text = await readText(yaml, false);
  if (text === null) return null;
  const t0 = performance.now(), bad = { n: 0 };
  const t = opTable(yaml.slice(0, yaml.length - OPS_YAML.length - 1), yaml, await parseOpsSliced(text, bad));
  log(bad.n ? "warn" : "info", `op index: ${t.decls.length} ops from ${yaml}${bad.n ? `, ${bad.n} entries not valid YAML` : ""}, ${Math.round(performance.now() - t0)} ms`);
  return t;
}

/** 工作区里每个 native_functions.yaml 一张表（没有：这个工作区不是 PyTorch） */
export async function opTables(): Promise<OpTable[]> {
  // 不单独搜工作区：名字索引里 …/aten/src/ATen/native/ 下的代码文件说明了去哪找（fork、vendored 的副本）
  found ??= (async () => {
    const native = `${path.sep}${path.dirname(OPS_YAML).split("/").join(path.sep)}${path.sep}`;
    const roots = new Set<string>();
    for (const { abs } of await indexedFiles()) { const i = abs.indexOf(native); if (i > 0) roots.add(abs.slice(0, i)); }
    const out: string[] = [];
    for (const r of roots) { const y = path.join(r, OPS_YAML); if (await exists(y)) out.push(y); }
    return out;
  })().catch(() => []);
  const out: OpTable[] = [];
  for (const yaml of await found) {
    let p = tables.get(yaml);
    if (!p) tables.set(yaml, (p = loadTable(yaml)));
    const t = await p;
    if (t) out.push(t);
  }
  return out;
}
/**
 * 点击的文件属于哪个 PyTorch；不在任何一个里面就没有（vendored 的 PyTorch 旁边的项目自己的代码照常走 pybind / PyMethodDef / PyO3，
 * 它的 .add、.get 也不是 PyTorch 的算子）
 */
export async function opTableFor(abs?: string): Promise<OpTable | undefined> {
  if (!abs) return undefined;
  return (await opTables()).find((t) => abs.startsWith(t.root + path.sep));
}

function dropScan(root: string) {
  const x = scans.get(root);
  if (x) { x.dead = true; scans.delete(root); }
}
export function resetOpTables() { found = undefined; tables.clear(); for (const r of [...scans.keys()]) dropScan(r); }

/** 文件保存、新建、在编辑器外改了或删了：yaml 丢掉它的表和扫描，扫描过的文件重做 */
export function opsFileChanged(abs: string) {
  if (path.basename(abs) === "compile_commands.json") { opsBuildChanged(); return; }
  if (abs.endsWith(path.sep + OPS_YAML.split("/").join(path.sep))) {
    if (!tables.has(abs)) { found = undefined; return; } // 工作区里新来了一个 PyTorch
    tables.delete(abs);
    dropScan(abs.slice(0, abs.length - OPS_YAML.length - 1));
    return;
  }
  for (const x of scans.values()) if (inScan(x, abs)) rescanFile(x, abs);
}
/** compile_commands.json 或 clangd 的参数变了：生成的文件现在可能在别处 */
export function opsBuildChanged() {
  for (const x of scans.values()) {
    if (x.rebuild) continue;
    x.rebuild = true;
    x.queue = x.queue.then(async () => {
      x.rebuild = undefined;
      await x.ready;
      if (x.dead) return;
      for (const abs of [...x.files.keys()]) if (isGen(x, abs)) dropRec(x, abs);
      x.genDir = await genDirOf(x.t.root);
      for (const abs of await genFiles(x)) { const text = await readText(abs, false); if (text !== null) addRec(x, abs, scanText(x, abs, text)); }
    }).catch((e) => log("warn", `op index: cannot update the build folder: ${e instanceof Error ? e.message : e}`));
  }
}

/** 删了文件或目录 */
export function opsPathRemoved(p: string) {
  for (const yaml of [...tables.keys()]) if (yaml === p || yaml.startsWith(p + path.sep)) opsFileChanged(yaml);
  for (const x of scans.values()) for (const abs of [...x.files.keys()]) if (abs === p || abs.startsWith(p + path.sep)) rescanFile(x, abs);
}

// 入口：调用处 → 算子名

export type OpEntry = { op: string; overload?: string; how: "explicit" | "torch" | "functional" | "method" | "at" };

/**
 * recv 的第一段换成完整模块名，经过 import 和模块级的 torch.ops 别名：
 * F.x → torch.nn.functional；from torch import _C → torch._C；aten = torch._ops.ops.aten → torch.ops.aten
 */
export function resolveRecv(recv: string, text: string): string {
  const [head, ...rest] = recv.split(".");
  const im = analysisOf("python", text).imports.find((i) => i.name === head);
  const alias = im ? undefined : new RegExp(`^${escapeRegExp(head)}\\s*=\\s*(torch(?:\\._ops)?\\.ops(?:\\.\\w+)?)\\s*(?:#.*)?$`, "m").exec(text)?.[1];
  const mod = alias ?? (!im ? head : im.from ? (im.module === head ? head : `${im.module}.${head}`) : im.module);
  return [mod, ...rest].join(".").replace(/^torch\._ops\.ops\b/, "torch.ops");
}

const C_NS = /^torch\.(_C\._(VariableFunctions|nn|linalg|fft|special|nested|sparse)|_VF)$/;

/**
 * Python 调用处 → 算子：torch.ops.aten.X(.overload)、torch._C._nn.X、torch._VF.X、torch.linalg.X…（explicit）；torch.X；torch.nn.functional.X；
 * 其他的 recv.X（Tensor 方法：静态看不出 recv 是不是 Tensor，所以只是候选）。self / cls 和别的 import 进来的模块不算
 */
export function pyOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">, text: string): OpEntry | null {
  if (!site.recv) return null;
  const full = resolveRecv(site.recv, text);
  const imports = analysisOf("python", text).imports;
  const ops = /^torch\.ops\.aten\.(\w+)(?:\.(\w+))?$/.exec(`${full}.${site.name}`);
  if (ops) return t.byName.has(ops[1]) ? { op: ops[1], overload: ops[2] === "default" ? "" : ops[2], how: "explicit" } : null;
  // torch.linalg.norm → linalg_norm（torch/linalg 里是 _add_docstr(_linalg.linalg_norm, …)）
  const sub = /^torch\.(linalg|fft|special)$/.exec(full);
  if (sub && t.byName.has(`${sub[1]}_${site.name}`)) return { op: `${sub[1]}_${site.name}`, how: "explicit" };
  if (!t.byName.has(site.name)) return null;
  const decls = t.byName.get(site.name)!;
  if (C_NS.test(full)) return { op: site.name, how: "explicit" };
  if (full === "torch") return decls.some((d) => d.variants.includes("function")) ? { op: site.name, how: "torch" } : null;
  if (full === "torch.nn.functional") return { op: site.name, how: "functional" };
  const head = site.recv.split(".")[0];
  if (/^(self|cls)$/.test(site.recv) || imports.some((i) => i.name === head) && full !== "torch.Tensor") return null;
  return decls.some((d) => d.variants.includes("method")) ? { op: site.name, how: "method" } : null;
}

/** C++ 调用处 → 算子：at::X（生成的 Functions.h，进 dispatcher）、at::native::X（索引里没有这个函数时）、at::_ops::add_Tensor::call */
export function cppOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">): OpEntry | null {
  const r = site.recv?.replace(/^::/, "");
  if ((r === "at" || r === "at::native") && t.byName.has(site.name)) return { op: site.name, how: "at" };
  const ops = /^at::_ops::(\w+)$/.exec(r ?? "")?.[1];
  if (ops && /^(call|redispatch)$/.test(site.name)) {
    if (t.byName.has(ops)) return { op: ops, overload: "", how: "at" };
    // add_Tensor → add.Tensor：从右往左第一个能拆成已知 func 的 _
    for (let i = ops.lastIndexOf("_"); i > 0; i = ops.lastIndexOf("_", i - 1)) if (t.byFull.has(`${ops.slice(0, i)}.${ops.slice(i + 1)}`)) return { op: ops.slice(0, i), overload: ops.slice(i + 1), how: "at" };
  }
  return null;
}

/**
 * 有 Python 定义的 torch.X / torch.nn.functional.X（torch/functional.py、torch/__init__.py、torch/nn/functional.py 里的顶层 def）
 * 照常去 Python（在 F.softmax 的 def 里再点 input.softmax）。路径相对 yaml 所在的 PyTorch
 */
export async function pyDefinedInTorch(t: OpTable, name: string, how: OpEntry["how"]): Promise<boolean> {
  for (const f of how === "functional" ? ["torch/nn/functional.py"] : ["torch/functional.py", "torch/__init__.py"]) {
    const abs = path.join(t.root, f);
    const text = await readText(abs, false);
    if (text !== null && analysisOf("python", text).symbols.some((s) => s.qual === name && s.kind === "def")) return true;
  }
  return false;
}

/** DispatchStub 调用：第一个参数是设备（iter.device_type()、self.device().type()、kCPU、DeviceType::CUDA） */
export const isStubCall = (site: Pick<CallSite, "args">) => /device|DeviceType|^(at::|c10::)?k[A-Z][A-Za-z]+$/.test(site.args[0]?.text.trim() ?? "");
