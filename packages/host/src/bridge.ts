// 跨语言下钻：Python → C++ / CUDA / Rust，C++ → CUDA kernel，Triton、TileLang。
// 认边界用 @codeboard/analysis 的纯文本函数（bridge.ts），这里负责找文件、找符号、读取值。结果是「目标符号 + 要并进 Call 标记的边界和取值」。
// 都是宿主上的异步工作：读文件、查名字索引，白板不等。
import * as path from "node:path";
import { instName, type CrossMark } from "@codeboard/core";
import { grammarOf, grammarOfFile, type Grammar } from "@codeboard/analysis/langs";
import type { CallAlt } from "@codeboard/analysis/basics";
import {
  bindLaunch, factoryVals, jitKernels, launchMacro, launchTemplateArgs, launchVals, macroDefs, pybindDefs, pyMethodDefs, pyo3Defs, stubDevice,
  templateParams, tilelangInner, torchLibDefs, torchOpOf, tritonInfo, tritonVals, matchClose, symbolAt, type CallSite, type Sym,
} from "@codeboard/analysis";
import { analysisOf } from "./analysis";
import { grepWord, lookupName, type IndexEntry } from "./nameindex";
import { libOf } from "./scope";
import { cppOpEntry, defsOf, entrySym, isStubCall, kernelsOf, kernelTarget, opTableFor, pyDefinedInTorch, pyOpEntry, pyRegs, regTarget, stubRegs, type OpTable } from "./torchops";
import { hostPath, langOf, readText, splitLines } from "./ws";
import { log } from "./log";

export type Target = { abs: string; sym: Sym };
/** 跨过去的结果：目标、边界和取值（title = 模板实例名，dispatch<8, 768>；label = 当备选时的标签，没有就用 title / qual） */
export type Crossed = { t: Target; mark: CrossMark; title?: string; label?: string };

const isCpp = (lang: string) => grammarOf(lang) === "cpp";

const toSym = (e: IndexEntry): Sym => ({ name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] });

/** 按 qual 找 C++ / Rust 的定义（near = 同一个文件里的优先）：名字索引里同名的，qual 的后缀对上（deep_ep::Buffer::f 对 Buffer::f）；带上完整分析的参数 */
async function symByQual(qual: string, grammar: Grammar, prefer?: (e: IndexEntry, text: string) => boolean, near?: string): Promise<Target | null> {
  const parts = qual.split("::").filter(Boolean);
  const name = parts[parts.length - 1];
  const ents = (await lookupName(name)).filter((e) => grammarOfFile(e.abs) === grammar && e.kind === "def");
  const tail = (q: string) => q.split("::");
  const score = (e: IndexEntry) => {
    const t = tail(e.qual);
    let n = 0;
    while (n < parts.length && n < t.length && parts[parts.length - 1 - n] === t[t.length - 1 - n]) n++;
    return n;
  };
  const ranked = ents.map((e) => ({ e, s: score(e) })).filter((x) => x.s >= Math.min(parts.length, 2) || (parts.length === 1 && x.s === 1)).sort((a, b) => b.s - a.s || (a.e.abs === near ? 0 : 1) - (b.e.abs === near ? 0 : 1));
  for (const { e } of ranked) {
    const text = await readText(e.abs);
    if (text === null) continue;
    if (prefer && !prefer(e, text) && ranked.length > 1) continue;
    const sym = analysisOf(langOf(e.abs), text).symbols.find((s) => s.qual === e.qual && s.defLine === e.defLine) ?? toSym(e);
    return { abs: e.abs, sym };
  }
  return null;
}

/** 注册在 lambda 里：目标是那一行所在的 lambda（当成一段，用包着它的符号或那一行） */
async function lambdaTarget(abs: string, line: number): Promise<Target | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const a = analysisOf(langOf(abs), text);
  const sym = symbolAt(a.symbols, line);
  const l = splitLines(text)[line - 1] ?? "";
  return { abs, sym: { name: "<lambda>", qual: sym ? `${sym.qual} · lambda` : "lambda", kind: "def", start: line, defLine: line, end: line, sig: l.trim(), params: [] } };
}

/**
 * Python 调用 obj.name(…)：语言服务说不出来（C 扩展），在 pybind / PyMethodDef / PyO3 的注册里找 name。
 * PyTorch 里的文件先查算子索引扫过的 torch/csrc（不扫工作区），那里没有再照常在整个工作区里找
 */
export async function viaRegistry(name: string, here?: string): Promise<Crossed[]> {
  const out: Crossed[] = [];
  const ops = await opTableFor(here);
  if (ops) {
    for (const r of await pyRegs(ops, name)) {
      const e = r.lambda ? null : await regTarget(ops, r);
      const t = r.lambda ? await lambdaTarget(r.abs, r.line) : e ? await entrySym(e) : null;
      if (t) out.push({ t, mark: { bound: r.how } });
    }
    if (out.length) return out;
  }
  for (const { abs, text } of await grepWord(name, "cpp")) {
    for (const r of pybindDefs(text, name)) {
      const t = r.lambda ? await lambdaTarget(abs, r.line) : r.target ? await symByQual(r.target, "cpp", undefined, abs) : null;
      if (t) out.push({ t, mark: { bound: `pybind · ${path.basename(abs)} ${r.how}` } });
    }
    for (const r of pyMethodDefs(text, name)) {
      const t = r.target ? await symByQual(r.target, "cpp", undefined, abs) : null;
      if (t) out.push({ t, mark: { bound: `PyMethodDef · ${path.basename(abs)}` } });
    }
  }
  for (const { abs, text } of await grepWord(name, "rust")) {
    for (const s of pyo3Defs(text, analysisOf("rust", text).symbols, name)) out.push({ t: { abs, sym: s }, mark: { bound: `PyO3 · ${path.basename(abs)} #[${/#\[pymethods\]/.test(text) && s.parent ? "pymethods" : "pyfunction"}]` } });
  }
  return out;
}

/** torch.ops.ns.op(…)：TORCH_LIBRARY 里注册的 C++ 函数 */
async function viaTorchOps(site: CallSite): Promise<Crossed[]> {
  const op = torchOpOf(site);
  if (!op) return [];
  const out: Crossed[] = [];
  for (const { abs, text } of await grepWord(op.op, "cpp")) {
    for (const r of torchLibDefs(text, op.op)) {
      const t = r.lambda ? await lambdaTarget(abs, r.line) : r.target ? await symByQual(r.target, "cpp") : null;
      if (t && !out.some((x) => x.t.abs === t.abs && x.t.sym.qual === t.sym.qual)) out.push({ t, mark: { bound: `torch.ops · ${path.basename(abs)} ${r.how}` } });
    }
  }
  return out;
}

/**
 * PyTorch 算子 → native_functions.yaml 的 dispatch 表 → 每个键的 kernel：一个设备一个候选（CUDA 在前，然后 CPU、Composite）。
 * 边界写 yaml 里的那条 func（经 structured_delegate 的写 a → b），dispatch key 放在取值里（换备选时跟着换）
 */
export async function viaOps(t: OpTable, op: string, overload?: string): Promise<Crossed[]> {
  const out: Crossed[] = [];
  for (const k of kernelsOf(t, op, overload)) {
    const tg = await kernelTarget(t, k);
    if (!tg) continue;
    const same = out.find((x) => x.t.abs === tg.abs && x.t.sym.qual === tg.sym.qual && x.t.sym.defLine === tg.sym.defLine);
    if (same) { same.mark.vals![0].value += `, ${k.key}`; same.label = `${same.mark.vals![0].value} · ${tg.sym.qual}`; continue; }
    const ufunc = k.inner ? (tg.sym.name === k.kernel ? " ufunc (generated)" : " ufunc_inner_loop") : "";
    const bound = `native_functions.yaml · ${k.via ? `${k.decl} → ${k.via}` : k.decl}${ufunc}`;
    out.push({ t: tg, mark: { bound, vals: [{ name: "dispatch", value: k.key }] }, label: `${k.key} · ${tg.sym.qual}` });
  }
  if (out.length) log("info", `op ${op}${overload ? `.${overload}` : ""} → ${out.map((x) => x.label).join("; ")}`);
  return out;
}

/**
 * DispatchStub：stub(device, …) → REGISTER_DISPATCH(stub, &fn) 注册的各个设备的 fn（CUDA 在前；含 build/ 里生成的 Ufunc*）；
 * 一个注册都找不到、而 stub 是 ufunc 算子的（add_stub，没构建过）→ ufunc::add
 */
export async function viaStub(stub: string, t: OpTable): Promise<Crossed[]> {
  const out: Crossed[] = [];
  const order = (k: string) => (k === "CUDA" ? 0 : k === "CPU" ? 1 : 2);
  for (const r of await stubRegs(t, stub)) {
    const key = stubDevice(r.how, r.abs);
    const e = await regTarget(t, r);
    const tg = e && (await entrySym(e));
    if (!tg) continue;
    const same = out.find((o) => o.t.abs === tg.abs && o.t.sym.qual === tg.sym.qual);
    if (same) { if (!same.mark.vals![0].value.split(", ").includes(key)) same.mark.vals![0].value += `, ${key}`; continue; }
    out.push({ t: tg, mark: { bound: `DispatchStub · ${path.basename(r.abs)} ${r.how}`, vals: [{ name: "dispatch", value: key }] }, label: `${key} · ${tg.sym.qual}` });
  }
  if (!out.length) {
    const op = stub.replace(/_stub$/, "");
    if (op !== stub && t.byName.get(op)?.some((d) => d.ufunc)) {
      const ufunc = (await viaOps(t, op)).filter((c) => /ufunc/.test(c.mark.bound ?? ""));
      for (const c of ufunc) c.mark.bound = `DispatchStub · ${stub} (registered by generated code) → ufunc ${op}`;
      return ufunc;
    }
  }
  return out.sort((a, b) => order(a.mark.vals![0].value) - order(b.mark.vals![0].value));
}

/** 生成的算子文件（build/…/ATen/ops/_softmax.h、Operators_3.cpp、Functions.h、TensorBody.h）：clangd 会落到这里，再往下是 dispatcher 的环 */
const GENERATED_OP = /[\\/]ATen[\\/](ops[\\/]\w+\.h|Operators(_\d+)?\.(cpp|h)|Functions\.h|TensorBody\.h|RedispatchFunctions\.h|MethodOperators\.h)$/;

/**
 * 语言服务给了定义之后（C++）：落在生成的算子文件里 → 走 yaml；落在 DEFINE_DISPATCH(x) / DECLARE_DISPATCH(…, x) 那一行 → REGISTER_DISPATCH 的目标。
 * 都不是回空（照常用语言服务的定义）
 */
export async function crossAfterDefs(site: CallSite | undefined, lang: string, defs: { abs: string; line: number }[], here?: string): Promise<Crossed[]> {
  if (!site || !isCpp(lang) || !defs.length) return [];
  try {
    const ops = await opTableFor(here);
    if (!ops) return [];
    if (defs.some((d) => GENERATED_OP.test(d.abs))) {
      const fromFile = defs.map((d) => /[\\/]ops[\\/](\w+?)(?:_ops|_native|_compositeimplicitautograd_dispatch|_cpu_dispatch|_cuda_dispatch)?\.h$/.exec(d.abs)?.[1]).find((n) => n && ops.byName.has(n));
      const op = ops.byName.has(site.name) ? site.name : fromFile;
      if (op) return await viaOps(ops, op);
    }
    for (const d of defs) {
      const line = splitLines((await readText(d.abs)) ?? "")[d.line - 1] ?? "";
      const stub = /\b(?:DEFINE|DECLARE)_DISPATCH\s*\((?:[^,()]*,\s*)?(\w+)\s*\)/.exec(line)?.[1];
      if (stub) return await viaStub(stub, ops);
    }
  } catch (e) { log("warn", `cross-language after definition ${site.name}: ${e instanceof Error ? e.message : e}`); }
  return [];
}

/** kernel 的定义：同名、__global__ 的那个（同一个文件的优先） */
async function kernelSym(name: string, near?: string, file?: (abs: string) => boolean): Promise<{ t: Target; head: string } | null> {
  const ents = (await lookupName(name)).filter((e) => grammarOfFile(e.abs) === "cpp" && e.kind === "def" && (!file || file(e.abs)));
  ents.sort((a, b) => (a.abs === near ? -1 : 0) - (b.abs === near ? -1 : 0));
  let fallback: { t: Target; head: string } | null = null;
  for (const e of ents) {
    const text = await readText(e.abs);
    if (text === null) continue;
    const lines = splitLines(text);
    const head = lines.slice(e.start - 1, e.defLine).join("\n");
    const sym = analysisOf(langOf(e.abs), text).symbols.find((s) => s.qual === e.qual && s.defLine === e.defLine) ?? toSym(e);
    const hit = { t: { abs: e.abs, sym }, head };
    if (/__global__/.test(head)) return hit;
    fallback ??= hit;
  }
  return file ? fallback : null;
}

/** 调用处是 SWITCH_X(CASE_MACRO) / CASE_MACRO(8) / LAUNCH_KERNEL(&cfg, k<…>, …)：展开到实际启动的 kernel 和模板取值 */
async function viaLaunchMacro(site: CallSite, abs: string, text: string): Promise<Crossed[]> {
  const defs = macroDefs(text);
  const argMacro = site.args.some((a) => defs.has(a.text.trim()));
  if (!argMacro && !defs.has(site.name) && !/LAUNCH/.test(site.name)) return [];
  // SWITCH_X 的定义可能在别的头文件里
  let switches = new Map<string, { params: string[]; body: string }>();
  if (argMacro && !defs.has(site.name)) for (const f of await grepWord(site.name, "cpp")) { const m = macroDefs(f.text); if (m.has(site.name)) { switches = m; break; } }
  const lm = launchMacro(site, defs, switches);
  if (!lm) return [];
  const k = await kernelSym(lm.kernel, abs);
  if (!k) return [];
  const a = analysisOf(langOf(abs), text);
  const fn = symbolAt(a.symbols.filter((s) => s.kind === "def"), site.line);
  const fnText = fn ? splitLines(text).slice(fn.start - 1, fn.end).join("\n") : text;
  const vals = launchVals(lm, k.head, fnText);
  return [{ t: k.t, mark: { bound: `launch macro · ${site.name}`, vals }, title: instName(lm.kernel, vals) }];
}

/** jit->compile("…", std::format(R"(#include <…/{}.cuh> … &ns::{})", header, func))：编译、启动的是哪个 kernel；if / else 的另一个是备选 */
async function viaJit(site: CallSite, abs: string, text: string): Promise<Crossed[]> {
  const lines = splitLines(text);
  // 调用的整段文本：从调用名字到配对的括号
  const at = lines.slice(0, site.line - 1).reduce((n, l) => n + l.length + 1, 0) + site.col;
  const open = text.indexOf("(", at);
  const close = open < 0 ? -1 : matchClose(text, open);
  if (close < 0) return [];
  const callText = text.slice(at, close + 1);
  if (!/#include/.test(callText)) return [];
  const a = analysisOf(langOf(abs), text);
  const fn = symbolAt(a.symbols.filter((s) => s.kind === "def"), site.line);
  const fnText = fn ? lines.slice(fn.start - 1, fn.end).join("\n") : text;
  const ks = jitKernels(callText, fnText);
  const out: Crossed[] = [];
  for (const j of ks) {
    const k = await kernelSym(j.kernel, undefined, (f) => f.replace(/\\/g, "/").endsWith(j.header));
    if (!k) continue;
    const params = templateParams(k.head);
    const vals = j.targs.map((x, i) => ({ name: params[i] ?? `#${i + 1}`, value: x.length > 28 ? x.slice(0, 27) + "…" : x }));
    out.push({ t: k.t, mark: { bound: `JIT compile · ${path.basename(j.header)}`, vals } });
  }
  return out;
}

/**
 * 点下去之前：PyTorch 算子（torch.ops.aten.X、torch._C._nn.X、torch.X；at::X）、DispatchStub、torch.ops（Python）、launch macro / JIT 编译（C++）。
 * 认不出回空
 */
export async function crossBefore(site: CallSite | undefined, lang: string, here: { abs: string; text: string } | null): Promise<Crossed[]> {
  if (!site) return [];
  try {
    const ops = await opTableFor(here?.abs);
    if (!isCpp(lang)) {
      const e = ops && here && lang === "python" ? pyOpEntry(ops, site, here.text) : null;
      if (e && (e.how === "explicit" || ((e.how === "torch" || e.how === "functional") && !(await pyDefinedInTorch(ops!, e.op, e.how))))) {
        const r = await viaOps(ops!, e.op, e.overload);
        // yaml 认识的 torch.ops.aten.X 不再去找 TORCH_LIBRARY_IMPL(aten, …) 里同名的 m.impl（batch rule、autocast）
        if (r.length || site.recv?.includes("torch.ops")) return r;
      }
      return site.recv?.includes("torch.ops") ? await viaTorchOps(site) : [];
    }
    if (ops) {
      const e = cppOpEntry(ops, site);
      // at::native::X 是直接调用：索引里有这个函数就照常找
      if (e && !(site.recv?.endsWith("native") && (await defsOf(ops, site.name)).some((x) => x.kind === "def" && x.qual.endsWith(`native::${site.name}`)))) {
        const r = await viaOps(ops, e.op, e.overload);
        if (r.length) return r;
      }
      if (isStubCall(site)) {
        const r = await viaStub(site.name, ops);
        if (r.length) return r;
      }
    }
    if (!here) return [];
    const lm = await viaLaunchMacro(site, here.abs, here.text);
    if (lm.length) return lm;
    if (/^(compile|build|jit_compile)$/.test(site.name)) return await viaJit(site, here.abs, here.text);
  } catch (e) { log("warn", `cross-language ${site.name}: ${e instanceof Error ? e.message : e}`); }
  return [];
}

/** 目标找到了：Triton 的 [grid] 启动补上 constexpr / config；CUDA 的 <<<>>> 补模板取值；TileLang 工厂换成里面的 prim_func */
export async function decorate(site: CallSite | undefined, t: Target, caller?: { lang: string; line: string; fnText: string }): Promise<Crossed> {
  const plain: Crossed = { t, mark: {} };
  const text = await readText(t.abs);
  if (text === null || !site) return plain;
  const lines = splitLines(text);
  const lang = langOf(t.abs);
  if (site.launch === "grid" && lang === "python") {
    const info = tritonInfo(lines, t.sym);
    const full = analysisOf(lang, text).symbols.find((s) => s.qual === t.sym.qual && s.defLine === t.sym.defLine) ?? t.sym;
    const { vals, alts } = tritonVals(info, full.params.map((p) => p.name), site.args);
    return { t: { abs: t.abs, sym: full }, mark: { bound: "kernel[grid]", ...(vals.length ? { vals } : {}), ...(alts.length ? { alts } : {}) } };
  }
  if (site.launch === "<<<" && caller) {
    const head = lines.slice(t.sym.start - 1, t.sym.defLine).join("\n");
    const vals = bindLaunch(head, launchTemplateArgs(caller.line, site.col), caller.fnText);
    return { t, mark: { bound: "kernel<<<…>>>", ...(vals.length ? { vals } : {}) }, title: vals.length ? instName(t.sym.name, vals) : undefined };
  }
  if (lang === "python" && t.sym.kind === "def") {
    const syms = analysisOf(lang, text).symbols;
    const inner = tilelangInner(lines, t.sym, syms);
    if (inner) {
      const factory = syms.find((s) => s.qual === t.sym.qual) ?? t.sym;
      const vals = factoryVals(factory.params, site.args);
      return { t: { abs: t.abs, sym: inner }, mark: { bound: "tilelang.jit factory", ...(vals.length ? { vals } : {}) }, title: `${factory.name} → ${inner.name}` };
    }
  }
  return plain;
}

/** 几个结果：第一个是选中的，其余进 alts（灰色虚框） */
export async function withAlts(list: Crossed[]): Promise<Crossed> {
  const [first, ...rest] = list;
  if (!rest.length) return first;
  const alts: CallAlt[] = [...(first.mark.alts ?? [])];
  for (const r of rest) alts.push({ label: r.label ?? r.title ?? r.t.sym.qual, detail: `${hostPath(r.t.abs)}:${r.t.sym.defLine}`, path: hostPath(r.t.abs), line: r.t.sym.defLine, qual: r.t.sym.qual, lib: await libOf(r.t.abs), vals: r.mark.vals });
  return { ...first, mark: { ...first.mark, alts } };
}
