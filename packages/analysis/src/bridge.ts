// 跨语言的边界：从调用处认出它跨了什么（pybind、torch.ops、TORCH_LIBRARY、PyO3、kernel[grid]、launch macro、JIT 编译、TileLang 工厂），
// 以及跨过去之后「实际跑哪个函数、参数取几」。纯文本 / 语法判断，不读文件；找文件、找符号由宿主做。
// 宏和模板只展开到「实际跑哪个 kernel、参数取几」，不做完整的预处理。
import { escapeRegExp, type BoundVal, type CallAlt } from "./basics";
import type { Arg, CallSite, Sym } from "./index";

const lineAt = (text: string, i: number) => text.slice(0, i).split("\n").length;
const short = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 一处注册：在第几行，注册到哪个 C++ / Rust 符号（qual，可能带命名空间）；lambda = 注册的是一个就地写的 lambda（目标就是那一行） */
export type Registration = { line: number; target?: string; lambda?: true; how: string };

/** 括号配对：从 open（指向 "(" / "[" / "{"）开始，到配对的那个括号（含）为止；字符串、注释里的不算 */
export function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // 原始字符串 R"(...)"：跳到 )"
      if (ch === '"' && text[i - 1] === "R") { const e = text.indexOf(')"', i); if (e < 0) return -1; i = e + 1; continue; }
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); if (e < 0) return -1; i = e; continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

/** 参数列表的文本按顶层逗号切开 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === "\\") { cur += s[++i] ?? ""; continue; } if (ch === q) q = ""; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** &deep_ep::Buffer::intranode_dispatch、py::overload_cast<…>(&X::f)、TORCH_FN(f)、f → 符号名 */
function targetOf(arg: string): string | undefined {
  const a = arg.trim();
  const amp = /&\s*([A-Za-z_][\w:]*)/.exec(a);
  if (amp) return amp[1];
  const fnm = /^(?:TORCH_FN|TORCH_FN_TYPE)\s*\(\s*([A-Za-z_][\w:]*)\s*\)/.exec(a);
  if (fnm) return fnm[1];
  if (/^[A-Za-z_][\w:]*$/.test(a)) return a;
  return undefined;
}

// ---------- pybind ----------

/** pybind11 / nanobind：m.def("name", &f)、.def("name", &Cls::f)、.def_static…；lambda 的目标是那一行 */
export function pybindDefs(text: string, name: string): Registration[] {
  if (!/pybind11|PYBIND11_MODULE|nanobind|NB_MODULE/.test(text)) return [];
  const out: Registration[] = [];
  const re = new RegExp(`\\.def(?:_static)?\\s*\\(\\s*"${escapeRegExp(name)}"\\s*,`, "g");
  for (let m; (m = re.exec(text)); ) {
    const open = text.indexOf("(", m.index);
    const close = matchClose(text, open);
    const args = splitArgs(text.slice(open + 1, close < 0 ? undefined : close));
    const second = args[1] ?? "";
    const line = lineAt(text, m.index);
    const how = /\bm\s*\.def/.test(text.slice(Math.max(0, m.index - 3), m.index + 4)) ? "m.def" : ".def";
    if (/^\[/.test(second)) out.push({ line, lambda: true, how });
    else { const t = targetOf(second); if (t) out.push({ line, target: t, how }); }
  }
  return out;
}

// ---------- torch.ops / TORCH_LIBRARY ----------

/** TORCH_LIBRARY(ns, m) / TORCH_LIBRARY_IMPL / _FRAGMENT 里的 m.def("name", &f)、m.impl("name", kCUDA, &f)；只有 schema 的 m.def 不算 */
export function torchLibDefs(text: string, name: string): Registration[] {
  if (!/TORCH_LIBRARY/.test(text)) return [];
  const out: Registration[] = [];
  const re = new RegExp(`\\.(def|impl)\\s*\\(\\s*"${escapeRegExp(name)}(?:\\.\\w+)?\\s*["(]`, "g");
  for (let m; (m = re.exec(text)); ) {
    const open = text.indexOf("(", m.index);
    const close = matchClose(text, open);
    const args = splitArgs(text.slice(open + 1, close < 0 ? undefined : close));
    const last = args[args.length - 1] ?? "";
    if (args.length < 2) continue; // 只有 schema
    const line = lineAt(text, m.index);
    if (/^\[/.test(last)) out.push({ line, lambda: true, how: `m.${m[1]}` });
    else { const t = targetOf(last); if (t && !/^torch::|^c10::|^k[A-Z]/.test(t)) out.push({ line, target: t, how: `m.${m[1]}` }); }
  }
  return out;
}

/** torch.ops.sgl_kernel.awq_marlin_repack(.default) → 命名空间和名字 */
export function torchOpOf(call: Pick<CallSite, "name" | "recv">): { ns: string; op: string } | null {
  const full = `${call.recv ?? ""}.${call.name}`;
  const m = /(?:^|\.)torch\.ops\.(\w+)\.(\w+)(?:\.(\w+))?$/.exec(full);
  if (!m) return null;
  // torch.ops.ns.op.default(…)：点的是 default
  if (m[3]) return { ns: m[1], op: m[2] };
  return { ns: m[1], op: m[2] };
}

// ---------- PyO3 ----------

/** Rust 里导出给 Python 的函数：#[pyfunction] fn name / #[pyo3(name = "name")]；#[pymethods] impl 里的方法 */
export function pyo3Defs(text: string, syms: Sym[], name: string): Sym[] {
  if (!/#\[py(function|methods|module|class)/.test(text)) return [];
  const lines = text.split(/\r?\n/);
  const out: Sym[] = [];
  for (const s of syms) {
    if (s.kind !== "def") continue;
    const attrs = lines.slice(s.start - 1, s.defLine - 1).join("\n");
    const renamed = /#\[pyo3\([^)]*name\s*=\s*"(\w+)"/.exec(attrs)?.[1];
    if ((renamed ?? s.name) !== name) continue;
    if (/#\[pyfunction/.test(attrs)) { out.push(s); continue; }
    // 方法：所在的 impl 前面有 #[pymethods]
    if (s.parent) {
      const ty = s.parent.split("::").pop()!;
      if (new RegExp(`#\\[pymethods\\][\\s\\S]{0,200}?impl\\s+(?:<[^>]*>\\s*)?${escapeRegExp(ty)}\\b`).test(text)) out.push(s);
    }
  }
  return out;
}

// ---------- 模板参数 ----------

/** template <int kNumRanks, int kNumThreads, typename T = float> → 参数名 */
export function templateParams(head: string): string[] {
  const t = /\btemplate\s*</.exec(head);
  if (!t) return [];
  const open = t.index + t[0].length - 1;
  let depth = 0, paren = 0, end = -1;
  for (let i = open; i < head.length; i++) {
    const ch = head[i];
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (paren) continue;
    else if (ch === "<") depth++;
    else if (ch === ">" && !--depth) { end = i; break; }
  }
  if (end < 0) return [];
  return splitArgs(head.slice(open + 1, end)).map((p) => /([A-Za-z_]\w*)\s*$/.exec(p.replace(/=[\s\S]*$/, "").trim())?.[1] ?? "").filter(Boolean);
}

/** 函数里的 constexpr int kNumThreads = 768; → { kNumThreads: "768" } */
export function constexprs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/constexpr\s+(?:static\s+)?[\w:<>]+\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const literal = (s: string) => /^(-?\d[\w.]*|True|False|true|false|None|"[^"]*"|'[^']*')$/.test(s.trim());

/** 模板参数名 ← 实参（实参是常量就换成值） */
function bindTemplate(params: string[], args: string[], consts: Record<string, string>, pick?: { arg: string; opts: string[]; from: string; value: string }): BoundVal[] {
  return args.map((a, i) => {
    const name = params[i] ?? `#${i + 1}`;
    if (pick && a.trim() === pick.arg) return { name, value: pick.value, opts: pick.opts, from: pick.from };
    const v = consts[a.trim()];
    return { name, value: v && literal(v) ? v : short(a.trim(), 32) };
  });
}

// ---------- launch macro：SWITCH_RANKS(DISPATCH_LAUNCH_CASE) ----------

/** #define NAME(params) body（续行的 \ 接起来） */
export function macroDefs(text: string): Map<string, { params: string[]; body: string; line: number }> {
  const out = new Map<string, { params: string[]; body: string; line: number }>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)\(([^)]*)\)\s?(.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[3];
    let k = i;
    while (/\\\s*$/.test(lines[k]) && k + 1 < lines.length) { body = body.replace(/\\\s*$/, " ") + lines[++k]; }
    body = body.replace(/\\\s*$/, "");
    out.set(m[1], { params: m[2].split(",").map((p) => p.trim()).filter(Boolean), body, line: i + 1 });
  }
  return out;
}

export type LaunchMacro = {
  kernel: string; // 被启动的 kernel 名字（dispatch）
  targs: string[]; // 模板实参（宏参数名原样留着：ranks, kNumThreads, …）
  param?: string; // case 宏的参数名（ranks）
  cases?: string[]; // switch 的各个取值（2, 4, 8）
  on?: string; // switch 的是谁（num_ranks）
  switchName: string;
};

/** case 宏的 body 里启动的 kernel：kernel = X<…>、LAUNCH_KERNEL(&cfg, X<…>, …)、X<…><<<…>>>；去掉 cast 之类 */
function kernelIn(body: string): { kernel: string; targs: string[] } | null {
  const NOT = /^(reinterpret_cast|static_cast|const_cast|dynamic_cast|std|sizeof|decltype|max|min)$/;
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*</g)) {
    const name = m[1];
    if (NOT.test(name)) continue;
    const open = m.index! + m[0].length - 1;
    // 模板实参：配对的 >
    let depth = 0, end = -1;
    for (let i = open; i < body.length; i++) { if (body[i] === "<") depth++; else if (body[i] === ">") { depth--; if (!depth) { end = i; break; } } else if (body[i] === ";" || body[i] === "{") break; }
    if (end < 0) continue;
    if (body[end + 1] === ">" || body[open + 1] === "<") continue; // << / >>
    return { kernel: name, targs: splitArgs(body.slice(open + 1, end)) };
  }
  return null;
}

/**
 * 调用处是 SWITCH_X(CASE_MACRO)：CASE_MACRO 在 defs 里（同一个文件），SWITCH_X 在 switches 里（可能在别的头文件）。
 * 认不出返回 null
 */
export function launchMacro(call: Pick<CallSite, "name" | "args">, defs: Map<string, { params: string[]; body: string }>, switches: Map<string, { params: string[]; body: string }>): LaunchMacro | null {
  const arg = call.args.map((a) => a.text.trim()).find((a) => defs.has(a));
  const sw = switches.get(call.name) ?? defs.get(call.name);
  if (!arg) {
    // 直接点的是 case 宏自己（DISPATCH_LAUNCH_CASE(8)）或 LAUNCH_KERNEL(&cfg, kernel<…>, …)
    const own = defs.get(call.name);
    const k = own ? kernelIn(own.body) : call.args[1] ? kernelIn(call.args[1].text + " ") : null;
    return k ? { kernel: k.kernel, targs: k.targs, param: own?.params[0], cases: own && call.args[0] ? [call.args[0].text] : undefined, switchName: call.name } : null;
  }
  const cm = defs.get(arg)!;
  const k = kernelIn(cm.body);
  if (!k) return null;
  const out: LaunchMacro = { kernel: k.kernel, targs: k.targs, param: cm.params[0], switchName: call.name };
  if (sw) {
    const on = /switch\s*\(\s*([^)]*?)\s*\)/.exec(sw.body)?.[1];
    const cp = sw.params[sw.params.length - 1];
    const cases = [...sw.body.matchAll(new RegExp(`case\\s+([^:]+?)\\s*:\\s*${escapeRegExp(cp ?? "case_macro")}\\s*\\(([^)]*)\\)`, "g"))].map((m) => splitArgs(m[2]).pop() ?? m[1]);
    if (cases.length) { out.cases = cases; out.on = on; }
  }
  return out;
}

/** launch macro 的取值：模板参数名 ← 实参；switch 的那个参数有几个取值（默认最后一个，通常最大） */
export function launchVals(lm: LaunchMacro, kernelHead: string, fnText: string): BoundVal[] {
  const params = templateParams(kernelHead);
  const pick = lm.param && lm.cases?.length ? { arg: lm.param, opts: lm.cases, from: lm.on ? `${lm.switchName}(${lm.on})` : lm.switchName, value: lm.cases[lm.cases.length - 1] } : undefined;
  return bindTemplate(params, lm.targs, constexprs(fnText), pick);
}

/** CUDA 的 kernel<8, 768><<<…>>>：模板参数名 ← 写在调用处的实参 */
export function launchTemplateArgs(lineText: string, col: number): string[] {
  const rest = lineText.slice(col);
  const m = /^[A-Za-z_]\w*\s*</.exec(rest);
  if (!m) return [];
  const open = m[0].length - 1;
  let depth = 0;
  for (let i = open; i < rest.length; i++) {
    if (rest[i] === "<") { if (rest.startsWith("<<<", i) && depth === 0) return []; depth++; }
    else if (rest[i] === ">") { depth--; if (!depth) return splitArgs(rest.slice(open + 1, i)); }
  }
  return [];
}
export const bindLaunch = (kernelHead: string, targs: string[], fnText: string) => bindTemplate(templateParams(kernelHead), targs, constexprs(fnText));

// ---------- JIT 编译：jit->compile("dispatch", std::format(R"(#include <…/{}.cuh> … &ns::{})", header, func)) ----------

export type JitKernel = { header: string; kernel: string; targs: string[]; ns?: string };

/** 调用处那条 compile 的文本 + 所在函数的文本 → 可能编译的几个 kernel（if / else 各一个） */
export function jitKernels(callText: string, fnText: string): JitKernel[] {
  const inc = /#include\s*<([^>]*)\{\}([^>]*)>/.exec(callText);
  const ref = /&([\w:]*?)\{\}/.exec(callText);
  if (!inc || !ref) return [];
  const fmtArgs = /\)"\s*,\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(callText);
  const hv = fmtArgs?.[1] ?? "header_name", fv = fmtArgs?.[2] ?? "func_name";
  const headers = [...fnText.matchAll(new RegExp(`\\b${escapeRegExp(hv)}\\s*=\\s*"([^"]+)"`, "g"))].map((m) => ({ at: m.index!, v: m[1] }));
  const funcs = [...fnText.matchAll(new RegExp(`\\b${escapeRegExp(fv)}\\s*=\\s*std::format\\(\\s*"([A-Za-z_]\\w*)<([^"]*)>"\\s*,`, "g"))].map((m) => {
    const open = fnText.indexOf("(", m.index!);
    const close = matchClose(fnText, open);
    const args = splitArgs(fnText.slice(open + 1, close < 0 ? undefined : close)).slice(1);
    return { at: m.index!, kernel: m[1], targs: args };
  });
  return funcs.map((f) => {
    const h = [...headers].reverse().find((x) => x.at < f.at) ?? headers[0];
    return { header: `${inc[1]}${h?.v ?? ""}${inc[2]}`, kernel: f.kernel, targs: f.targs, ns: ref[1].replace(/::$/, "") || undefined };
  });
}

// ---------- Triton ----------

export type TritonInfo = { jit: boolean; constexprs: string[]; configs: BoundVal[][] };

/** def 的装饰器和参数：@triton.jit、@triton.autotune(configs=[triton.Config({…}, num_stages=…, num_warps=…), …])、tl.constexpr 的参数 */
export function tritonInfo(lines: string[], sym: Pick<Sym, "start" | "defLine" | "end" | "params">): TritonInfo {
  const head = lines.slice(sym.start - 1, sym.defLine - 1).join("\n");
  const jit = /@triton\.jit|@triton\.autotune|@triton\.heuristics|@jit\b/.test(head);
  // 参数到 ) 为止（多行）
  let sig = "";
  for (let i = sym.defLine - 1; i < Math.min(lines.length, sym.end); i++) { sig += lines[i] + "\n"; if (/\)\s*(->[^:]*)?:\s*(#.*)?$/.test(lines[i])) break; }
  const cx = [...sig.matchAll(/([A-Za-z_]\w*)\s*:\s*tl\.constexpr/g)].map((m) => m[1]);
  const configs: BoundVal[][] = [];
  for (const m of head.matchAll(/triton\.Config\(\s*\{([^}]*)\}\s*(?:,([^)]*))?\)/g)) {
    const vals: BoundVal[] = [];
    for (const kv of m[1].matchAll(/["'](\w+)["']\s*:\s*([^,]+)/g)) vals.push({ name: kv[1], value: kv[2].trim() });
    for (const kv of (m[2] ?? "").matchAll(/(num_stages|num_warps|num_ctas)\s*=\s*([^,\s)]+)/g)) vals.push({ name: kv[1] === "num_stages" ? "stages" : kv[1] === "num_warps" ? "warps" : kv[1], value: kv[2] });
    configs.push(vals);
  }
  return { jit, constexprs: cx, configs };
}

/**
 * kernel[grid](…) 的取值：constexpr 参数里实参是常量的（BLOCK_M → 64）；没有常量时最多列 3 个 name → 表达式。
 * autotune 的 config：第一组是选中的，其余是灰色备选
 */
export function tritonVals(info: TritonInfo, params: string[], args: Arg[]): { vals: BoundVal[]; alts: CallAlt[] } {
  const bound: { name: string; text: string }[] = [];
  let i = 0;
  for (const a of args) {
    if (a.star) break;
    if (a.kw) continue;
    const p = params[i++];
    if (p && info.constexprs.includes(p)) bound.push({ name: p, text: a.text });
  }
  for (const a of args) if (a.kw && info.constexprs.includes(a.kw)) bound.push({ name: a.kw, text: a.text });
  const lits = bound.filter((b) => literal(b.text));
  const vals: BoundVal[] = (lits.length ? lits : bound.slice(0, 3)).map((b) => ({ name: b.name, value: short(b.text, 28) }));
  const alts: CallAlt[] = [];
  if (info.configs.length) {
    vals.push(...info.configs[0]);
    info.configs.slice(1).forEach((c, k) => alts.push({ label: `config ${k + 2} · ${c.map((v) => `${v.name}=${v.value}`).join(" ")}`, vals: [...vals.slice(0, vals.length - info.configs[0].length), ...c] }));
  }
  return { vals, alts };
}

// ---------- TileLang ----------

/** @tilelang.jit 的工厂函数：里面 @T.prim_func 的那个函数（跳过工厂直达 prim_func） */
export function tilelangInner(lines: string[], factory: Pick<Sym, "start" | "defLine" | "qual">, syms: Sym[]): Sym | undefined {
  const head = lines.slice(factory.start - 1, factory.defLine - 1).join("\n");
  if (!/@(tilelang|tl)\.jit\b|@tilelang\.jit|@jit\b/.test(head)) return undefined;
  return syms.find((s) => s.qual.startsWith(factory.qual + ".") && lines.slice(s.start - 1, s.defLine - 1).some((l) => /@T\.prim_func|@tilelang\.prim_func|@T\.macro/.test(l)));
}

/** 工厂参数 ← 实参：block_N → 64、num_stages → 2 */
export function factoryVals(params: Sym["params"], args: Arg[]): BoundVal[] {
  const ps = params.filter((p) => p.kind !== "self");
  const out: BoundVal[] = [];
  let i = 0;
  for (const a of args) {
    if (a.star) break;
    if (a.kw) continue;
    const p = ps[i++];
    if (p && p.kind !== "star" && p.kind !== "dstar") out.push({ name: p.name, value: short(a.text, 28) });
  }
  for (const a of args) if (a.kw) out.push({ name: a.kw, value: short(a.text, 28) });
  return out;
}

// ---------- 动态分发 ----------

/** 基类方法是不是抽象的：@abstractmethod，或者函数体（去掉 docstring）只有 raise NotImplementedError / ... / pass */
export function isAbstractBody(lines: string[], sym: Pick<Sym, "start" | "defLine" | "end">): boolean {
  if (lines.slice(sym.start - 1, sym.defLine - 1).some((l) => /@(abc\.)?abstractmethod/.test(l))) return true;
  let body = lines.slice(sym.defLine - 1, sym.end).join("\n");
  body = body.replace(/^[\s\S]*?\)\s*(->[^:]*)?:/, ""); // 去掉签名
  body = body.replace(/^\s*[rRbBuU]*("""|''')[\s\S]*?\1/, "").replace(/#.*$/gm, "").trim();
  return body === "" || /^(raise\s+NotImplementedError\b.*|\.\.\.|pass)$/s.test(body);
}
