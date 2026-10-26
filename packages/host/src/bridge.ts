// 跨语言下钻：Python → C++ / CUDA / Rust，C++ → CUDA kernel，Triton、TileLang。
// 认边界用 core 的纯文本函数（analysis/bridge.ts），这里负责找文件、找符号、读取值。结果是「目标符号 + 要并进 Call 标记的边界和取值」。
// 都是宿主上的异步工作：读文件、查名字索引，白板不等。
import * as path from "node:path";
import { grammarOf, grammarOfFile, type CallAlt, type CrossMark, type Grammar } from "@codeboard/core";
import {
  bindLaunch, factoryVals, instName, jitKernels, launchMacro, launchTemplateArgs, launchVals, macroDefs, pybindDefs, pyo3Defs, templateParams,
  tilelangInner, torchLibDefs, torchOpOf, tritonInfo, tritonVals, matchClose, symbolAt, type CallSite, type Sym,
} from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { grepWord, lookupName, type IndexEntry } from "./nameindex";
import { libOf } from "./scope";
import { hostPath, langOf, readText, splitLines } from "./ws";
import { log } from "./log";

export type Target = { abs: string; sym: Sym };
/** 跨过去的结果：目标、边界和取值（title = 模板实例名，dispatch<8, 768>） */
export type Crossed = { t: Target; mark: CrossMark; title?: string };

const isCpp = (lang: string) => grammarOf(lang) === "cpp";

const toSym = (e: IndexEntry): Sym => ({ name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] });

/** 按 qual 找 C++ / Rust 的定义：名字索引里同名的，qual 的后缀对上（deep_ep::Buffer::f 对 Buffer::f）；带上完整分析的参数 */
async function symByQual(qual: string, grammar: Grammar, prefer?: (e: IndexEntry, text: string) => boolean): Promise<Target | null> {
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
  const ranked = ents.map((e) => ({ e, s: score(e) })).filter((x) => x.s >= Math.min(parts.length, 2) || (parts.length === 1 && x.s === 1)).sort((a, b) => b.s - a.s);
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

// ---------- 定义找不到时：Python → C++（pybind）/ Rust（PyO3） ----------

/** Python 调用 obj.name(…)：语言服务说不出来（C 扩展），在 pybind / PyO3 的注册里找 name */
export async function viaRegistry(name: string): Promise<Crossed[]> {
  const out: Crossed[] = [];
  for (const { abs, text } of await grepWord(name, "cpp")) {
    for (const r of pybindDefs(text, name)) {
      const t = r.lambda ? await lambdaTarget(abs, r.line) : r.target ? await symByQual(r.target, "cpp") : null;
      if (t) out.push({ t, mark: { bound: `pybind · ${path.basename(abs)} ${r.how}` } });
    }
  }
  for (const { abs, text } of await grepWord(name, "rust")) {
    for (const s of pyo3Defs(text, analysisOf("rust", text).symbols, name)) out.push({ t: { abs, sym: s }, mark: { bound: `PyO3 · ${path.basename(abs)} #[${/#\[pymethods\]/.test(text) && s.parent ? "pymethods" : "pyfunction"}]` } });
  }
  return out;
}

// ---------- 点下去之前就认得出的：torch.ops、launch macro、JIT 编译 ----------

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

/** 点下去之前：torch.ops（Python）、launch macro / JIT 编译（C++）。认不出回空 */
export async function crossBefore(site: CallSite | undefined, lang: string, here: { abs: string; text: string } | null): Promise<Crossed[]> {
  if (!site) return [];
  try {
    if (!isCpp(lang)) return site.recv?.includes("torch.ops") ? await viaTorchOps(site) : [];
    if (!here) return [];
    const lm = await viaLaunchMacro(site, here.abs, here.text);
    if (lm.length) return lm;
    if (/^(compile|build|jit_compile)$/.test(site.name)) return await viaJit(site, here.abs, here.text);
  } catch (e) { log("warn", `cross-language ${site.name}: ${e instanceof Error ? e.message : e}`); }
  return [];
}

// ---------- 找到了目标之后：kernel[grid]、<<<>>>、TileLang 工厂 ----------

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
  for (const r of rest) alts.push({ label: r.title ?? r.t.sym.qual, detail: `${hostPath(r.t.abs)}:${r.t.sym.defLine}`, path: hostPath(r.t.abs), line: r.t.sym.defLine, qual: r.t.sym.qual, lib: await libOf(r.t.abs), vals: r.mark.vals });
  return { ...first, mark: { ...first.mark, alts } };
}
