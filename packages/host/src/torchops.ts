// PyTorch 的算子路由：工作区里有 aten/src/ATen/native/native_functions.yaml 时（PyTorch 源码、fork、vendored 的副本），
// Python / C++ 的算子入口 → yaml 里这个算子的 dispatch 表 → 各个设备的 C++ / CUDA kernel 符号。
// yaml 在打开白板时（或第一次用到时）找、解析（按文本缓存，改了重新解析）；算子要的文件在后台先分析，点击时只查表、不扫工作区。
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { grammarOfFile } from "@codeboard/analysis/langs";
import { dispatchAll, pybindAll, pyMethodAll, type CallSite, type FileAnalysis, type Sym } from "@codeboard/analysis";
import { analysisOf, symbolsOf, whenAnalysisReady } from "./analysis";
import { entriesOf, indexedFiles, type IndexEntry } from "./nameindex";
import { exists, langOf, readText } from "./ws";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { log } from "./log";

export const OPS_YAML = "aten/src/ATen/native/native_functions.yaml";

/** yaml 里的一条 func：add.out → name add、overload out；dispatch 的键已经按逗号拆开（CPU, CUDA: f → 两条） */
export type OpDecl = {
  name: string; overload: string; line: number; dispatch: [string, string][]; structured: boolean; delegate?: string; ufunc: boolean;
  variants: string[]; out: boolean;
};
export type OpTable = { root: string; yaml: string; decls: OpDecl[]; byName: Map<string, OpDecl[]>; byFull: Map<string, OpDecl> };
/**
 * 一个 kernel：哪个 dispatch key、C++ 名字、写在哪条 func 上（via = 经 structured_delegate 到的那条）；
 * inner = ufunc_inner_loop 的算子：kernel 是生成的 ufunc_add_CUDA（build/ 里有才找得到），没有就退到手写的 ufunc::add
 */
export type Kernel = { key: string; kernel: string; decl: string; via?: string; inner?: string };

const fullName = (d: Pick<OpDecl, "name" | "overload">) => (d.overload ? `${d.name}.${d.overload}` : d.name);

/** native_functions.yaml 的文本 → 每条 func */
export function parseOps(text: string): OpDecl[] {
  const raw = parse(text) as Record<string, unknown>[] | null;
  const lines: number[] = [];
  text.split("\n").forEach((l, i) => { if (/^- func:/.test(l)) lines.push(i + 1); });
  const out: OpDecl[] = [];
  (raw ?? []).forEach((e, i) => {
    const m = /^([\w]+)(?:\.(\w+))?\s*\(([\s\S]*)\)\s*->/.exec(String(e.func ?? ""));
    if (!m) return;
    const dispatch: [string, string][] = [];
    for (const [keys, k] of Object.entries((e.dispatch ?? {}) as Record<string, unknown>)) for (const key of keys.split(",")) dispatch.push([key.trim(), String(k)]);
    out.push({
      name: m[1], overload: m[2] ?? "", line: lines[i] ?? 0, dispatch, structured: e.structured === true,
      delegate: typeof e.structured_delegate === "string" ? e.structured_delegate : undefined,
      ufunc: !!e.ufunc_inner_loop, variants: String(e.variants ?? "function").split(",").map((v) => v.trim()),
      out: /\*[^]*Tensor\(\w!\)/.test(m[3]), // 关键字参数里有可写的 Tensor：out 变体
    });
  });
  return out;
}

export function opTable(root: string, yaml: string, decls: OpDecl[]): OpTable {
  const byName = new Map<string, OpDecl[]>(), byFull = new Map<string, OpDecl>();
  for (const d of decls) { (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d); byFull.set(fullName(d), d); }
  return { root, yaml, decls, byName, byFull };
}

/** torchgen 的 cpp.name：add_ → add_；out 变体加 _out（没有 dispatch 时 CompositeImplicitAutograd 的 kernel 名） */
const cppName = (d: OpDecl) => d.name + (d.out ? "_out" : "");

/** 一条 func 的全部 kernel：自己写的 dispatch；structured_delegate 指向的那条的（自己没写的键）；ufunc 的 CPU / CUDA；都没有 = CompositeImplicitAutograd */
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

/** 0 = CUDA，1 = CPU，2 = Composite*，3 = 其余（MPS、XPU、Sparse、Nested、Meta…） */
export const keyRank = (key: string) => (key === "CUDA" ? 0 : key === "CPU" ? 1 : /^Composite/.test(key) ? 2 : 3);

/**
 * 算子 name（可带 overload）的 kernel：CUDA 在前，然后 CPU、Composite；有这三类时其余的键（MPS、Sparse…）不列。
 * 同一个 C++ 名字的几个键并成一条（键用逗号连起来）
 */
export function kernelsOf(t: OpTable, name: string, overload?: string): Kernel[] {
  // 没给 overload：默认的那个在前，然后别的非 out 变体，out 变体最后（边界写的是最像调用处的那条）
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

// 算子要的文件：yaml 往上两层（aten/src/ATen）和 torch/csrc 下的代码文件在后台读一遍文本（点击时不扫工作区），
// 顺便记下 DispatchStub 的注册、注册给 Python 的名字、宏生成的 kernel；构建目录里生成的 Ufunc*.cpp / .cu（名字索引不看 build/）单独读

/** 一处注册：在哪个文件哪一行，注册的目标（qual）；macro = REGISTER_*DISPATCH；how = pybind 的 .def / m.def、PyMethodDef */
export type Reg = { abs: string; line: number; target?: string; lambda?: true; how: string };
type Scan = {
  ready: Promise<void>; regs: Map<string, Reg[]>; pyRegs: Map<string, Reg[]>; macros: Map<string, { abs: string; line: number; macro: string; sig: string }[]>;
  gen: Map<string, IndexEntry[]>; genDir: string; ms?: number; files?: number;
  /** 要找的名字（kernel、注册的目标）出现在哪些文件里 */
  where: Map<string, Set<string>>;
  /** 用时（ms）：注册、名字出现在哪、生成的文件 */
  phases?: number[];
};
const scans = new Map<string, Scan>();

const push = <V>(m: Map<string, V[]>, k: string, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const MACRO_CALL = /^[ \t]*([A-Z][A-Z0-9_]*)\s*\(([^()]*)\)/gm;

function regsOf(x: Scan, kernels: Set<string>, abs: string, text: string, aten: boolean, csrc: boolean) {
  if (aten) {
    for (const r of dispatchAll(text)) push(x.regs, r.name, { abs, line: r.line, target: r.target, how: r.macro });
    let starts: number[] | undefined, n = 0; // 宏调用按顺序出现：行号接着往下数
    const lineAt = (i: number) => { starts ??= [...text.matchAll(/\n/g)].map((m) => m.index); while (n < starts.length && starts[n] < i) n++; return n + 1; };
    for (const m of text.matchAll(MACRO_CALL)) for (const id of m[2].match(/\b[A-Za-z_]\w*\b/g) ?? []) {
      if (kernels.has(id)) push(x.macros, id, { abs, line: lineAt(m.index), macro: m[1], sig: m[0].trim() });
    }
  }
  if (csrc) {
    for (const r of pybindAll(text)) push(x.pyRegs, r.name, { abs, line: r.line, target: r.target, lambda: r.lambda, how: `pybind · ${path.basename(abs)} ${r.how}` });
    for (const r of pyMethodAll(text)) push(x.pyRegs, r.name, { abs, line: r.line, target: r.target, how: `PyMethodDef · ${path.basename(abs)}` });
  }
}

async function scan(t: OpTable, x: Scan) {
  const t0 = performance.now();
  const aten = path.dirname(path.dirname(t.yaml)) + path.sep, csrc = path.join(t.root, "torch", "csrc") + path.sep;
  const kernels = new Set(t.decls.flatMap((d) => d.dispatch.map(([, k]) => k)).concat(t.decls.filter((d) => !d.dispatch.length && !d.delegate).map(cppName)));
  const files = (await indexedFiles()).map((f) => f.abs).filter((a) => a.startsWith(aten) || a.startsWith(csrc));
  let n = 0;
  // 只读文本、不做语法分析（几千个文件几秒）：第一遍记注册，第二遍记要找的名字（kernel、注册的目标）出现在哪些文件里，
  // 点击时只分析那几个文件
  for (const abs of files) {
    const text = await readText(abs, false);
    if (text === null) continue;
    regsOf(x, kernels, abs, text, abs.startsWith(aten), abs.startsWith(csrc));
    if (++n % 64 === 0) await sleep(0);
  }
  const t1 = performance.now();
  const wanted = new Set(kernels);
  for (const m of [x.regs, x.pyRegs]) for (const rs of m.values()) for (const r of rs) if (r.target) wanted.add(r.target.split("::").pop()!);
  for (const d of t.decls) for (const k of declKernels(t, d)) { wanted.add(k.kernel); if (k.inner) wanted.add(k.inner); }
  let k = 0;
  for (const abs of files) {
    const text = await readText(abs, false);
    if (text === null) continue;
    for (const m of text.matchAll(/\b[A-Za-z_]\w*/g)) if (wanted.has(m[0])) { const fs2 = x.where.get(m[0]) ?? x.where.set(m[0], new Set()).get(m[0])!; fs2.add(abs); }
    if (++k % 64 === 0) await sleep(0);
  }
  const t2 = performance.now();
  // 生成的 ufunc kernel 和它们的 DispatchStub 注册（build/aten/src/ATen/Ufunc*）
  let gen: string[] = [];
  try { gen = (await fs.readdir(x.genDir)).filter((f) => /^Ufunc\w*\.(cpp|cu)$/.test(f)).map((f) => path.join(x.genDir, f)); } catch { /* 没构建过 */ }
  for (const abs of gen) {
    const text = await readText(abs, false);
    if (text === null) continue;
    for (const s of symbolsOf(langOf(abs), text)) if (s.kind === "def") push(x.gen, s.name, { name: s.name, qual: s.qual, kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: s.sig });
    regsOf(x, kernels, abs, text, true, false);
    await sleep(0);
  }
  x.ms = Math.round(performance.now() - t0); x.files = n + gen.length;
  x.phases = [t1 - t0, t2 - t1, performance.now() - t2].map(Math.round);
  log("info", `op index: ${x.files} files of ${t.root} read, ${x.regs.size} dispatch stubs, ${x.pyRegs.size} Python names, ${x.ms} ms`);
}

/** 这份 PyTorch 的扫描（第一次要的时候开始；点击等它扫完，之后都是查表） */
export function scanOf(t: OpTable): Scan {
  let x = scans.get(t.root);
  if (!x) {
    x = { ready: Promise.resolve(), regs: new Map(), pyRegs: new Map(), macros: new Map(), gen: new Map(), where: new Map(), genDir: path.join(t.root, "build", "aten", "src", "ATen") };
    x.ready = whenAnalysisReady().then(() => scan(t, x!)).catch((e) => log("warn", `op index: scan failed: ${e instanceof Error ? e.message : e}`));
    scans.set(t.root, x);
  }
  return x;
}
/** 打开白板时：找 yaml、开始扫，等扫完 */
export async function warmOps() { await Promise.all((await opTables()).map((t) => scanOf(t).ready)); }

/** name 的定义：文本里出现过它的那几个文件（分析进名字索引，已经分析过的不重做）+ 生成的文件 */
export async function defsOf(t: OpTable, name: string): Promise<IndexEntry[]> {
  const x = scanOf(t);
  await x.ready;
  const out: IndexEntry[] = [];
  for (const abs of x.where.get(name) ?? []) for (const e of await entriesOf(abs)) if (e.name === name) out.push(e);
  return [...out, ...(x.gen.get(name) ?? [])];
}

/** kernel 的 C++ 定义：at::native::name 优先，CUDA 的键优先 .cu / cuda/ 里的，其余优先不在里面的；ufunc 先找生成的 ufunc_add_CUDA，没有就是 ufunc::add */
export async function kernelEntry(t: OpTable, k: Kernel): Promise<IndexEntry | undefined> {
  const aten = path.dirname(path.dirname(t.yaml)) + path.sep, gen = scanOf(t).genDir + path.sep;
  const ok = (e: IndexEntry) => e.kind === "def" && (e.abs.startsWith(aten) || e.abs.startsWith(gen)) && grammarOfFile(e.abs) === "cpp";
  let ents = (await defsOf(t, k.kernel)).filter(ok);
  if (!ents.length && k.inner) ents = (await defsOf(t, k.inner)).filter((e) => ok(e) && /(^|::)ufunc::/.test(e.qual));
  const cuda = k.key.split(", ")[0] === "CUDA";
  const score = (e: IndexEntry) => (e.qual.endsWith(`native::${k.kernel}`) ? 2 : 0) + (isCudaFile(e.abs) === cuda ? 1 : 0);
  return ents.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => b.s - a.s || a.i - b.i)[0]?.e;
}

/**
 * 宏生成的 kernel：名字只出现在顶层一个全大写宏调用的实参里（CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)）。
 * 目标是那一行（从那里再点 acos_stub）；## 拼出来的名字（FOREACH_BINARY_OP_SCALAR(add)）找不到
 */
export async function macroKernel(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const x = scanOf(t);
  await x.ready;
  const cuda = k.key.split(", ")[0] === "CUDA";
  const m = [...(x.macros.get(k.kernel) ?? [])].sort((a, b) => (isCudaFile(a.abs) === cuda ? 0 : 1) - (isCudaFile(b.abs) === cuda ? 0 : 1))[0];
  return m ? { abs: m.abs, sym: { name: k.kernel, qual: `${m.macro}(${k.kernel})`, kind: "def", start: m.line, defLine: m.line, end: m.line, sig: m.sig, params: [] } } : null;
}

/** 名字索引的条目 → 带完整分析（参数）的符号 */
export async function entrySym(e: IndexEntry): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(e.abs);
  if (text === null) return null;
  const sym = analysisOf(langOf(e.abs), text).symbols.find((s) => s.qual === e.qual && s.defLine === e.defLine)
    ?? { name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] };
  return { abs: e.abs, sym };
}

/** kernel 的符号；索引里没有时找生成它的宏调用 */
export async function kernelTarget(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const best = await kernelEntry(t, k);
  return best ? entrySym(best) : macroKernel(t, k);
}

/** 注册的目标（qual）→ 定义：qual 的后缀对上，同一个文件里的优先 */
export async function regTarget(t: OpTable, r: Reg): Promise<IndexEntry | undefined> {
  const parts = r.target!.split("::");
  const ents = (await defsOf(t, parts[parts.length - 1])).filter((e) => e.kind === "def" && grammarOfFile(e.abs) === "cpp" && e.qual.split("::").slice(-parts.length).join("::") === parts.join("::"));
  return ents.find((e) => e.abs === r.abs) ?? ents[0];
}

// 找 yaml、解析（按文本缓存）

let found: Promise<string[]> | undefined;
const parsed = new Map<string, { text: string; t: OpTable }>();

/** 工作区里的每一份 native_functions.yaml 一张表（没有就是空的：这个工作区不是 PyTorch） */
export async function opTables(): Promise<OpTable[]> {
  // 不另外搜工作区：名字索引列出的代码文件里有 …/aten/src/ATen/native/ 的，看那一份有没有 yaml（fork、vendored 的副本也算）
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
    const text = await readText(yaml, false);
    if (text === null) continue;
    let c = parsed.get(yaml);
    if (c?.text !== text) {
      const t0 = performance.now();
      try { c = { text, t: opTable(yaml.slice(0, yaml.length - OPS_YAML.length - 1), yaml, parseOps(text)) }; }
      catch (e) { log("warn", `op index: cannot parse ${yaml}: ${e instanceof Error ? e.message : e}`); continue; }
      parsed.set(yaml, c);
      log("info", `op index: ${c.t.decls.length} ops from ${yaml}, ${Math.round(performance.now() - t0)} ms`);
    }
    out.push(c.t);
  }
  return out;
}
/** 点击所在的文件属于哪一份 PyTorch（不在任何一份里就用第一份） */
export async function opTableFor(abs?: string): Promise<OpTable | undefined> {
  const ts = await opTables();
  return ts.find((t) => abs?.startsWith(t.root + path.sep)) ?? ts[0];
}
export function resetOpTables() { found = undefined; parsed.clear(); scans.clear(); }

// 入口：调用处 → 算子名

export type OpEntry = { op: string; overload?: string; how: "explicit" | "torch" | "functional" | "method" | "at" };

/** recv 的第一段按 import 换成模块全名：F.x → torch.nn.functional；from torch import _C → torch._C */
export function resolveRecv(recv: string, imports: FileAnalysis["imports"]): string {
  const [head, ...rest] = recv.split(".");
  const im = imports.find((i) => i.name === head);
  const mod = !im ? head : im.from ? (im.module === head ? head : `${im.module}.${head}`) : im.module;
  return [mod, ...rest].join(".");
}

const C_NS = /^torch\.(_C\._(VariableFunctions|nn|linalg|fft|special|nested|sparse)|_VF)$/;

/**
 * Python 调用处 → 算子：torch.ops.aten.X(.overload)、torch._C._nn.X、torch._VF.X、torch.linalg.X 等（explicit）；torch.X；torch.nn.functional.X；
 * 其余的 recv.X（Tensor 方法，静态看不出 recv 是不是 Tensor，只当候选）。self / cls、import 进来的别的模块不算
 */
export function pyOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">, imports: FileAnalysis["imports"]): OpEntry | null {
  if (!site.recv) return null;
  const full = resolveRecv(site.recv, imports);
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

/** C++ 调用处 → 算子：at::X（生成的 Functions.h，进 dispatcher）、at::native::X（名字索引里没有这个函数时）、at::_ops::add_Tensor::call（生成的 Operators.h） */
export function cppOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">): OpEntry | null {
  const r = site.recv?.replace(/^::/, "");
  if ((r === "at" || r === "at::native") && t.byName.has(site.name)) return { op: site.name, how: "at" };
  const ops = /^at::_ops::(\w+)$/.exec(r ?? "")?.[1];
  if (ops && /^(call|redispatch)$/.test(site.name)) {
    if (t.byName.has(ops)) return { op: ops, overload: "", how: "at" };
    // add_Tensor → add.Tensor：从右往左找第一个 _ 拆开对得上的
    for (let i = ops.lastIndexOf("_"); i > 0; i = ops.lastIndexOf("_", i - 1)) if (t.byFull.has(`${ops.slice(0, i)}.${ops.slice(i + 1)}`)) return { op: ops.slice(0, i), overload: ops.slice(i + 1), how: "at" };
  }
  return null;
}

/**
 * torch.X / torch.nn.functional.X 在 Python 里有自己的定义（torch/functional.py、torch/__init__.py、torch/nn/functional.py 的顶层 def）：
 * 那就照常去 Python 的定义（F.softmax 的 def 里再点 input.softmax）。路径相对 yaml 所在的那份 PyTorch
 */
export async function pyDefinedInTorch(t: OpTable, name: string, how: OpEntry["how"]): Promise<boolean> {
  for (const f of how === "functional" ? ["torch/nn/functional.py"] : ["torch/functional.py", "torch/__init__.py"]) {
    const abs = path.join(t.root, f);
    const text = await readText(abs, false);
    if (text !== null && analysisOf("python", text).symbols.some((s) => s.qual === name && s.kind === "def")) return true;
  }
  return false;
}

/** DispatchStub 的调用：第一个实参是设备（iter.device_type()、self.device().type()、kCPU、DeviceType::CUDA） */
export const isStubCall = (site: Pick<CallSite, "args">) => /device|DeviceType|^(at::|c10::)?k[A-Z][A-Za-z]+$/.test(site.args[0]?.text.trim() ?? "");
