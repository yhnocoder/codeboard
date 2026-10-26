// 先问 VS Code 的「转到定义」（装了 Pylance、clangd 时最准）；钉的版本不是工作区当前内容、或者语言服务没给结果时，按名字在索引里找。
import * as path from "node:path";
import { escapeRegExp, grammarOf, grammarOfFile, rankByReceiver, renderLine, type CodeCard, type ExpandPick, type ExpandResult, type ImplPick, type DispatchResult, type PeekDef, type PeekResult, type Segment, type Var } from "@codeboard/core";
import { isAbstractBody, isModuleDef, peekPlan, splitHover, symbolAt, varCandidates, type CallSite, type FileAnalysis, type Sym } from "@codeboard/core/analysis";
import { crossBefore, decorate, viaRegistry, withAlts, type Crossed, type Target } from "./bridge";
import { analysisOf, cachedAnalysis, segAnalysis } from "./analysis";
import { sharedDefs, type Def } from "./defcache";
import { cardForFileSym, symCard } from "./cards";
import { absOf, locOfFile, versionText, hasLocalFile } from "./source";
import { makeSegment, workingPlace } from "./versions";
import { highlight, tokensOf } from "./views";
import { libOf } from "./scope";
import { entriesOf, indexedFiles, lookupName, type IndexEntry } from "./nameindex";
import { log } from "./log";
import { exists, fromHostPath, hostPath, langOf, mkUid, readText, recentFiles, splitLines, workspace, wsRoots } from "./ws";

export { nameIndexReady, resetIndex, startNameIndex } from "./nameindex";

// ---------- 转到定义 ----------

/** 问语言服务（同一个文件、位置、内容的请求共用：悬停时可能已经在问了） */
export const lspDefs = (abs: string, line: number, col: number): Promise<Def[]> => sharedDefs(abs, line, col, () => askDefs(abs, line, col));
/** 定义处的「转到实现」（Pylance 要在整个工作区里找子类，冷的时候要好几秒）：悬停预取、打开白板的预热、点击、peek 共用一个请求 */
const lspImpls = (d: Def): Promise<Def[]> => sharedDefs(d.abs, d.line, d.col, async () => {
  const t0 = performance.now();
  const r = await workspace().language.implementations(d.abs, d.line, d.col);
  log("info", `implementations at ${hostPath(d.abs)}:${d.line} → ${r.length}, ${Math.round(performance.now() - t0)} ms`);
  return r;
}, "impl");

// Pylance 刚启动时会先回空：还没见它答过话时，空的回答隔一会儿再问几次，再退到名字索引
const RETRY = 3, RETRY_GAP = 600, RETRY_CLICKS = 3;
let lspSeen = false, retryClicks = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 测试用：当作语言服务还没答过话 */
export const forgetLspSeen = () => { lspSeen = false; retryClicks = 0; };

/** 点击时问定义：语言服务像是还在启动（装了 Pylance、还没答过）就重试 */
export async function clickDefs(abs: string, line: number, col: number): Promise<Def[]> {
  let d = await lspDefs(abs, line, col);
  if (d.length || lspSeen || retryClicks >= RETRY_CLICKS || langOf(abs) !== "python" || !workspace().about.hasExtension("ms-python.vscode-pylance")) return d;
  retryClicks++;
  for (let k = 0; k < RETRY && !d.length && !lspSeen; k++) { await sleep(RETRY_GAP); d = await lspDefs(abs, line, col); }
  if (d.length) log("info", `definition at ${hostPath(abs)}:${line}:${col} answered after retry (language server starting)`);
  return d;
}

async function askDefs(abs: string, line: number, col: number): Promise<Def[]> {
  try {
    const r = await workspace().language.definitions(abs, line, col);
    if (r.length) lspSeen = true;
    return r.filter((d) => !(d.abs === abs && d.line === line)); // 指回调用处自己
  } catch (e) {
    log("warn", `definition provider failed at ${hostPath(abs)}:${line}:${col}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

export async function symAtDef(d: Def, name?: string, qual?: string): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(d.abs);
  if (text === null) return null;
  const syms = analysisOf(langOf(d.abs), text).symbols;
  const sym = syms.find((s) => s.defLine === d.line && (!name || s.name === name)) ?? (qual ? syms.find((s) => s.qual === qual) : undefined) ?? syms.find((s) => s.defLine === d.line)
    ?? (name ? symbolAt(syms.filter((s) => s.name === name), d.line) : undefined);
  return sym ? { abs: d.abs, sym } : null;
}

const toSym = (e: IndexEntry): Sym => ({ name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] });

// ---------- expand ----------

type ExpandReq = { seg: Segment; line: number; col: number; name: string; recv?: string; pick?: ExpandPick };

/** pick 的文件：rel = 相对段自己的来源根（工作区外的类卡点成员），否则是 hostPath */
export const pickAbs = (seg: Segment, p: ExpandPick) => (p.rel ? absOf({ ...seg, path: p.path }) : fromHostPath(p.path));

const none = (reason: string): ExpandResult => ({ none: true, reason });

export async function expand(m: ExpandReq): Promise<ExpandResult> {
  const seg = m.seg;
  if (seg.src.kind === "free") return none("Free code has no source to follow.");
  if (seg.src.kind === "github") return none("Expanding calls in GitHub code is not supported yet.");
  const full = await versionText(seg);
  const site = callSite(seg, full, m);
  if (!site) log("warn", `vars ${m.name} → callSite miss path=${seg.path}:${m.line}:${m.col}${full ? "" : " (file text unavailable, used saved lines)"}`);
  let resolved: string | undefined, lspN = 0, dispatching = false;
  const here = full ? { abs: absOf(seg) ?? seg.path, text: full } : null;
  const caller = full ? callerOf(seg.lang, full, m.line) : undefined;

  let targets: Target[] = [];
  let crossed: Crossed[] = [];
  if (m.pick) {
    const abs = pickAbs(seg, m.pick);
    const t = abs && (await symAtDef({ abs, line: m.pick.line, col: 0 }, m.pick.rel ? m.name : undefined, m.pick.qual));
    if (t) targets = [t];
  } else {
    // 跨语言：torch.ops、launch macro、JIT 编译点下去之前就认得出（语言服务答不了）
    crossed = await crossBefore(site, seg.lang, here);
    const wp = crossed.length ? null : await workingPlace(seg);
    resolved = wp ? `${hostPath(wp.abs)}:${wp.start + (m.line - seg.start)}${wp.exact ? "" : " (inexact)"}` : undefined;
    if (wp?.exact) {
      const line = wp.start + (m.line - seg.start);
      const defs = await clickDefs(wp.abs, line, m.col);
      lspN = defs.length;
      // 动态分发：定义处是基类的方法、有子类覆盖它 → 列出全部实现让人选
      // 转到实现在 Pylance 那边要在整个工作区里找子类（冷的时候、慢机器上要好几秒）：点击只等一小会儿（预取过的话已经在缓存里），
      // 等不到就先按定义建卡，回 dispatching，白板再单独问（dispatchAt），有覆盖再给选
      if (defs.length === 1) {
        const dsp = dispatchOf(defs[0], m.name);
        const quick = await within(dsp, DISPATCH_WAIT);
        if (quick === LATE) { dsp.catch(() => null); dispatching = await mayDispatch(defs[0], m.name); }
        else if (quick) return quick.result;
      }
      for (const d of defs) {
        const t = await symAtDef(d, m.name);
        if (t && !targets.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)) targets.push(t);
      }
    }
    // Python 调到 C / C++ / Rust 扩展：语言服务找不到定义，先看 pybind / PyO3 的注册（再退到名字索引）
    // 名字索引里有同名的 Python 定义就不算（self.model.forward 不去找 C++ 的 .def("forward")）
    if (!crossed.length && !targets.length && !lspN && seg.lang === "python" && !(await lookupName(m.name)).some((e) => /\.pyi?$/.test(e.abs))) crossed = await viaRegistry(m.name);
    // 语言服务给了定义、只是那里不是函数 / 类（变量、属性、参数）：不扫工作区（大仓库建名字索引要几十秒），
    // 只在当前文件和已经分析过的文件里按名字找
    if (!crossed.length && !targets.length) {
      let ents = lspN ? await nearbyEntries(m.name, wp?.abs) : await lookupName(m.name);
      if (grammarOf(seg.lang) === "cpp") ents = await cppCands(ents, site);
      const cands = ents.map((e) => ({ ...e, path: hostPath(e.abs), line: e.defLine }));
      if (cands.length) {
        const selfClass = (seg.symbol?.kind === "class" ? seg.symbol.qual : seg.symbol?.qual.split(".").slice(0, -1).join(".")) || seg.scope?.split(".").slice(0, -1).join(".");
        const here = await currentFile(seg);
        const { ranked, best } = rankByReceiver(cands, m.recv ?? site?.recv, { path: here, selfClass });
        if (best) targets = [{ abs: best.abs, sym: toSym(best) }];
        else return { pick: ranked.slice(0, 20).map((e) => ({ label: e.qual, detail: `${e.path}:${e.defLine}`, path: e.path, line: e.defLine })) };
      }
    }
  }
  if (!crossed.length && !targets.length) {
    const why = site?.dispatch ? "Dynamic dispatch: not resolved" : `No definition found for “${m.name}”.`;
    log("warn", `expand ${m.name} → ${why} path=${seg.path}:${m.line}:${m.col} resolved=${resolved ?? "none"} lsp=${lspN}${m.pick ? ` pick=${m.pick.path}:${m.pick.line}` : ""}`);
    return { ...none(why), name: m.name };
  }
  if (targets.length > 1) return { pick: targets.map((t) => ({ label: t.sym.qual, detail: `${hostPath(t.abs)}:${t.sym.defLine}`, path: hostPath(t.abs), line: t.sym.defLine })) };

  // 目标找到了：Triton 的 [grid]、CUDA 的 <<<>>>、TileLang 工厂补上边界和取值
  const x = crossed.length ? await withAlts(crossed) : await decorate(site, targets[0], caller);
  const t = x.t;
  if (crossed.length) log("info", `expand ${m.name} → ${x.mark.bound} → ${t.sym.qual} (${hostPath(t.abs)}:${t.sym.defLine})${crossed.length > 1 ? ` +${crossed.length - 1} alternatives` : ""}`);
  const nc = await cardForFileSym(t.abs, t.sym);
  if (!nc) { log("error", `expand ${m.name} → cannot read ${hostPath(t.abs)}`); return none(`Cannot read ${hostPath(t.abs)}.`); }
  const mark = Object.keys(x.mark).length ? x.mark : undefined;
  return { card: nc.card as CodeCard, views: nc.views, w: nc.w, vars: site && !t.sym.name.startsWith("<") ? await varsFor(site, t) : [], ...(mark ? { mark } : {}), ...(x.title ? { title: x.title } : {}), ...(dispatching && !crossed.length ? { dispatching: true as const } : {}) };
}

/**
 * C++ 里按名字找到的候选：只要 C / C++ / CUDA 的；ns::f(…) 要 qual 以 ns::f 结尾的；普通调用不会是 __global__ kernel（那要 <<<>>> 或 launch）。
 * 筛完一个都不剩就照原样
 */
async function cppCands(ents: IndexEntry[], site: CallSite | undefined): Promise<IndexEntry[]> {
  const keep = (xs: IndexEntry[], f: (e: IndexEntry) => boolean | Promise<boolean>) => Promise.all(xs.map(async (e) => [e, await f(e)] as const)).then((r) => { const k = r.filter(([, ok]) => ok).map(([e]) => e); return k.length ? k : xs; });
  let out = await keep(ents, (e) => grammarOfFile(e.abs) === "cpp");
  if (site?.recv && /^[A-Za-z_][\w:]*$/.test(site.recv) && !site.recv.includes(".")) out = await keep(out, (e) => e.qual.endsWith(`${site.recv}::${e.name}`));
  if (!site?.launch) out = await keep(out, async (e) => { const t = await readText(e.abs); return !t || !/__global__/.test(splitLines(t).slice(e.start - 1, e.defLine).join("\n")); });
  return out;
}

/** 调用所在的那一行和函数的文本（CUDA 的 <<<>>> 要读模板实参、constexpr） */
function callerOf(lang: string, full: string, line: number): { lang: string; line: string; fnText: string } {
  const lines = splitLines(full);
  const fn = symbolAt(analysisOf(lang, full).symbols.filter((s) => s.kind === "def"), line);
  return { lang, line: lines[line - 1] ?? "", fnText: fn ? lines.slice(fn.start - 1, fn.end).join("\n") : "" };
}

// ---------- 动态分发 ----------

/** 点击时最多等转到实现多久（ms）：缓存里有、或者语言服务热着时够用；再久就先建卡 */
const DISPATCH_WAIT = 200;
const LATE = Symbol("late");
const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof LATE>((r) => { t = setTimeout(() => r(LATE), ms); })]).finally(() => clearTimeout(t));
};
/** dispatchOf 会去问转到实现的那种定义：Python 类里的方法 */
async function mayDispatch(d: Def, name: string): Promise<boolean> {
  if (langOf(d.abs) !== "python") return false;
  const b = await symAtDef(d, name);
  return !!b && !!b.sym.parent && b.sym.kind === "def";
}

/** expand 回了 dispatching 之后白板来问：同一个调用点的定义处有没有被覆盖（定义、转到实现都走缓存，和 expand 发出去的是同一个请求） */
export async function dispatchAt(m: { seg: Segment; line: number; col: number; name: string }): Promise<DispatchResult> {
  if (!hasLocalFile(m.seg.src)) return null;
  const wp = await workingPlace(m.seg);
  if (!wp?.exact) return null;
  const defs = await clickDefs(wp.abs, wp.start + (m.line - m.seg.start), m.col);
  if (defs.length !== 1) return null;
  const d = await dispatchOf(defs[0], m.name);
  return d ? { ...d.result, ...(d.abstract ? { abstract: true as const } : {}) } : null;
}

/**
 * 定义处是类里的方法：在它上面问「转到实现」（Pylance 回所有覆盖它的子类方法）。有覆盖就是动态分发：
 * 列出全部实现（基类自己不是抽象的也算一个），library 里的标上包名（⌥ 才展开）
 */
export async function dispatchOf(d: Def, name: string): Promise<{ result: Extract<ExpandResult, { impls: unknown }>; n: number; base: string; abstract: boolean } | null> {
  if (langOf(d.abs) !== "python") return null;
  const b = await symAtDef(d, name);
  if (!b || !b.sym.parent || b.sym.kind !== "def") return null;
  let locs: Def[] = [];
  try { locs = await lspImpls(d); } catch { return null; }
  const impls: Target[] = [];
  for (const l of locs) {
    if (l.abs === d.abs && l.line === d.line) continue;
    const t = await symAtDef(l, name);
    if (t && !(t.abs === b.abs && t.sym.qual === b.sym.qual) && !impls.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)) impls.push(t);
  }
  if (!impls.length) return null;
  const text = await readText(b.abs);
  const abstract = text !== null && isAbstractBody(splitLines(text), b.sym);
  const pick = async (t: Target, base?: true): Promise<ImplPick> => {
    const lib = await libOf(t.abs);
    return { label: t.sym.qual, detail: `${hostPath(t.abs)}:${t.sym.defLine}`, path: hostPath(t.abs), line: t.sym.defLine, qual: t.sym.qual, ...(lib ? { lib } : {}), ...(base ? { base } : {}) };
  };
  const list = [...(abstract ? [] : [await pick(b, true)]), ...(await Promise.all(impls.map((t) => pick(t))))];
  log("info", `dynamic dispatch ${b.sym.qual} → ${list.length} implementations`);
  return { result: { impls: list, base: b.sym.qual }, n: list.length, base: b.sym.parent, abstract };
}

/** 不扫工作区的名字查找：当前文件 + 最近读过、分析还在缓存里的文件 */
async function nearbyEntries(name: string, here?: string): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  const files = [...new Set([...(here ? [here] : []), ...recentFiles()])];
  for (const abs of files) {
    const text = await readText(abs);
    if (text === null) continue;
    const a = abs === here ? analysisOf(langOf(abs), text) : cachedAnalysis(langOf(abs), text);
    for (const s of a?.symbols ?? []) if (s.name === name) out.push({ name: s.name, qual: s.qual, kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: s.sig });
  }
  return out;
}

async function currentFile(seg: Segment) {
  const loc = (await workingPlace(seg))?.abs;
  return loc ? hostPath(loc) : seg.path;
}

function callSite(seg: Segment, full: string | null, m: ExpandReq): CallSite | undefined {
  let calls: CallSite[];
  let shift = 0, colOff = 0;
  if (full) calls = segAnalysis(seg.lang, full, m.line, m.line, absOf(seg) ?? undefined).calls;
  else {
    const ind = Math.min(...seg.text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    colOff = Number.isFinite(ind) ? ind : 0;
    calls = analysisOf(seg.lang, seg.text.map((l) => l.slice(Math.min(colOff, l.length - l.trimStart().length))).join("\n")).calls;
    shift = seg.start - 1;
  }
  const on = calls.filter((c) => c.line + shift === m.line);
  return on.find((c) => c.col + colOff === m.col) ?? on.find((c) => c.name === m.name || c.dispatch === m.name);
}

/** 带 Call 标记的箭头的变量候选：类的话用 __init__ 的参数 */
async function varsFor(site: CallSite, t: { abs: string; sym: Sym }): Promise<Var[]> {
  const text = t.sym.kind === "class" || !t.sym.params.length ? await readText(t.abs) : null;
  return varCandidates(site, calleeOf(t.sym, text ? analysisOf(langOf(t.abs), text).symbols : []));
}
/** 被调的函数：类 → __init__；索引里来的 Sym 没有参数，按 qual 在分析结果里补 */
function calleeOf(sym: Sym, syms: Sym[]): Sym {
  if (sym.kind === "class") return syms.find((s) => s.qual === `${sym.qual}.__init__`) ?? sym;
  return sym.params.length ? sym : syms.find((s) => s.qual === sym.qual && s.start === sym.start) ?? syms.find((s) => s.qual === sym.qual) ?? sym;
}

// ---------- 拖到已有的卡：变量候选 ----------

type CallVarsReq = { seg: Segment; line: number; col: number; name: string; target: Segment };

/** 调用接到已有的卡上（拖过去 / Link to Existing Card）：按目标卡的符号算变量候选 */
export async function callVars(m: CallVarsReq): Promise<Var[]> {
  if (m.seg.src.kind === "free") return [];
  const site = callSite(m.seg, await versionText(m.seg), m);
  if (!site) return [];
  const t = m.target;
  const full = t.src.kind === "free" ? null : await versionText(t);
  let syms: Sym[];
  if (full) syms = analysisOf(t.lang, full).symbols;
  else {
    // 只有段文本：去掉公共缩进再分析，行号对回去
    const ind = Math.min(...t.text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const cut = Number.isFinite(ind) ? ind : 0;
    syms = analysisOf(t.lang, t.text.map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length))).join("\n")).symbols
      .map((s) => ({
        ...s, start: s.start + t.start - 1, defLine: s.defLine + t.start - 1, end: s.end + t.start - 1,
        params: s.params.map((p, i) => (i === 0 && /^(self|cls)$/.test(p.name) ? { ...p, kind: "self" as const } : p)), // 方法单独分析时看不出 self
      }));
  }
  const top = (t.symbol && syms.find((s) => s.qual === t.symbol!.qual)) ?? syms.filter((s) => s.start >= t.start && s.end <= t.end && (s.name === m.name || s.qual.endsWith(`.${m.name}`)))[0] ?? symbolAt(syms, t.start);
  return top ? varCandidates(site, calleeOf(top, syms)) : [];
}

// ---------- peek ----------

type PeekReq = { seg: Segment; line: number; col: number; word: string; at?: { path: string; line: number; col: number } };
type Hover = { sig?: string; doc?: string };

/** VS Code 的 hover（Pylance：签名代码块 + Markdown 文档）；没有语言服务时为 null */
async function hoverAt(abs: string, line: number, col: number): Promise<Hover | null> {
  try {
    const parts = await workspace().language.hover(abs, line, col);
    // Pylance 在文档末尾带 <!--moduleHash:...--> 之类的 HTML 注释，Markdown 渲染时会原样显示，先去掉
    const r = splitHover(parts.join("\n\n").replace(/<!--[\s\S]*?-->/g, "").trim());
    return r.sig || r.doc ? r : null;
  } catch { return null; }
}

export async function peek(m: PeekReq): Promise<PeekResult> {
  let defs: Def[] = [];
  let use: { abs: string; line: number; col: number } | undefined;
  if (m.at) use = { abs: fromHostPath(m.at.path), line: m.at.line, col: m.at.col };
  else if (m.seg.src.kind !== "free") {
    const wp = await workingPlace(m.seg);
    if (wp?.exact) use = { abs: wp.abs, line: wp.start + (m.line - m.seg.start), col: m.col };
  }
  if (use) defs = await clickDefs(use.abs, use.line, use.col);
  if (defs.length) {
    // hover 在使用处问（Pylance 给的类型更具体），没有再问定义处
    const hov = (use && (await hoverAt(use.abs, use.line, use.col))) || (await hoverAt(defs[0].abs, defs[0].line, defs[0].col));
    // 动态分发的提示也不让 peek 等转到实现：等不到这次就不显示（请求还在跑，进了缓存下次就有）
    const dp = defs.length === 1 ? dispatchOf(defs[0], m.word.split(".").pop()!) : null;
    const [out, q] = await Promise.all([peekAt(defs[0], m.word, hov), dp ? within(dp, DISPATCH_WAIT) : null]);
    if (q === LATE) dp!.catch(() => null);
    const dsp = q === LATE ? null : q;
    if (out && dsp) out.dispatch = { n: dsp.n, base: dsp.base, ...(dsp.abstract ? { abstract: true } : {}) };
    return out;
  }
  // 兜底 1：import 进来的模块（mp → torch.multiprocessing）
  const mod = await importedModule(m);
  if (mod) return mod;
  // 兜底 2：同一个函数里的赋值 / 参数（按那个版本的文本）
  const local = await localDef(m);
  if (local) return local;
  // 兜底 3：名字索引里的函数 / 类
  const word = m.word.split(".").pop()!;
  const hits = await lookupName(word);
  if (hits?.length) {
    const e = hits.length === 1 ? hits[0] : rankByReceiver(hits.map((h) => ({ ...h, path: hostPath(h.abs), line: h.defLine })), m.word.includes(".") ? m.word.split(".").slice(0, -1).join(".") : undefined, { path: m.seg.path }).ranked[0];
    return peekAt({ abs: e.abs, line: e.defLine, col: 0 }, word);
  }
  // 兜底 4：x.field → 有类的文件里找类体字段 field: … = …（只看前 400 个文件）
  const f = await classField(word);
  return f ? peekAt(f, word) : null;
}

async function classField(word: string): Promise<Def | null> {
  if (!/^[A-Za-z_]\w*$/.test(word)) return null;
  const re = new RegExp(`^\\s+${word}\\s*(:[^=]*)?=(?!=)`);
  let n = 0;
  for (const { abs, ents: known } of await indexedFiles()) {
    let ents = known, text: string | null | undefined;
    if (!ents) { // 还没分析过：文本里没有这个词就不用分析
      text = await readText(abs);
      if (!text || !text.includes(word)) continue;
      ents = await entriesOf(abs);
    }
    if (!ents.some((e) => e.kind === "class") || n++ > 400) continue;
    text ??= await readText(abs);
    if (!text || !text.includes(word)) continue;
    const lines = splitLines(text);
    const a = analysisOf(langOf(abs), text);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && symbolAt(a.symbols, i + 1)?.kind === "class") return { abs, line: i + 1, col: lines[i].indexOf(word) };
  }
  return null;
}

/** 按 peekPlan 取的几行（不一定连续）：用整个文件的 token 高亮 */
async function rowsHtml(rows: number[], lang: string, text: string, lines: string[]) {
  const toks = await tokensOf(lang, text);
  return rows.map((l) => renderLine(toks[l - 1] ?? [{ text: lines[l - 1] ?? "" }]));
}

/** 签名 / 文档：hover 优先，没有就用 docstring */
async function topOf(plan: { sig?: string; doc?: string }, hov: Hover | null | undefined, lang: string) {
  const sig = hov?.sig ?? plan.sig;
  return { sig, sigHtml: sig ? (await highlight(splitLines(sig), lang)).join("\n") : undefined, doc: hov?.doc ?? plan.doc };
}

/** 模块的显示名：torch/multiprocessing/__init__.py → torch/multiprocessing */
const modTitle = (p: string) => p.replace(/\/__init__\.pyi?$/, "").replace(/\.pyi?$/, "");

/** 定义的那几行（按定义类型取）+ hover + Pin / Place 用的段 + 下一跳 */
async function peekAt(d: Def, word: string, hov?: Hover | null, forceModule = false): Promise<PeekDef | null> {
  const text = await readText(d.abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(d.abs);
  const a = analysisOf(lang, text);
  const module = forceModule || /^\(module\)/.test(hov?.sig ?? "") || isModuleDef(lines, d.line, d.col, word);
  const plan = peekPlan(a, lines, d.line, { word, module });
  const sym = a.symbols.find((s) => s.defLine === d.line);
  const loc = await locOfFile(d.abs);
  const rows = plan.rows;
  let seg: Segment;
  if (sym && !module) seg = (await symCard(loc, lines, sym, lang)).segments[0];
  else {
    const s = rows[0] ?? 1, e = rows[rows.length - 1] ?? Math.min(lines.length, 1);
    seg = await makeSegment(loc, lines, s, e, { lang, scope: symbolAt(a.symbols, d.line)?.qual });
  }
  const out: PeekDef = {
    path: hostPath(d.abs), line: d.line, start: rows[0] ?? d.line, text: rows.map((l) => lines[l - 1] ?? ""), html: await rowsHtml(rows, lang, text, lines), seg,
    kind: plan.kind, rows, head: plan.head, more: plan.more, ...(await topOf(plan, hov, lang)), lib: await libOf(d.abs),
    title: module ? modTitle(loc.src.kind === "repo" ? hostPath(d.abs) : loc.path) : undefined,
  };
  const f = !module && followOf(lines[d.line - 1] ?? "", word);
  if (f) {
    const next = await lspDefs(d.abs, d.line, f.col);
    const where = next[0] ? ` · ${path.basename(next[0].abs)}:${next[0].line}` : "";
    out.follow = { label: `${f.expr}${where}`, line: d.line, col: f.col, path: hostPath(d.abs) };
  }
  return out;
}

/** self.x = config.max_num_batched_tokens → 下一跳是 config.max_num_batched_tokens 的最后一个名字 */
function followOf(line: string, word: string): { expr: string; col: number } | null {
  const m = /^\s*(?:self\.)?([\w.]+)\s*(?::[^=]+)?=\s*([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+)\s*(?:#.*)?$/.exec(line);
  if (!m || (word && !m[1].endsWith(word.split(".").pop()!))) return null;
  const expr = m[2];
  return { expr, col: line.lastIndexOf(expr) + expr.lastIndexOf(".") + 1 };
}

/** 没有语言服务：悬停的名字是 import 进来的模块（import torch.multiprocessing as mp）。工作区里的模块读它的 docstring，library 只给签名 */
async function importedModule(m: PeekReq): Promise<PeekDef | null> {
  const seg = m.seg;
  if (seg.src.kind === "free" || m.word.includes(".")) return null;
  const full = await versionText(seg);
  const a: FileAnalysis | null = full ? segAnalysis(seg.lang, full, 1, 0, absOf(seg) ?? undefined) : null; // 只用 import
  const im = a?.imports.find((i) => i.name === m.word && !i.from);
  if (!a || !im || !full) return null;
  const rel = im.module.split(".");
  for (const f of wsRoots()) for (const c of [path.join(f, ...rel, "__init__.py"), path.join(f, ...rel) + ".py"])
    if (await exists(c)) return peekAt({ abs: c, line: 1, col: 0 }, m.word, null, true);
  const lines = splitLines(full);
  const pseg: Segment = { id: mkUid("s"), src: seg.src, path: seg.path, lang: seg.lang, start: im.line, end: im.line, text: [lines[im.line - 1] ?? ""], version: seg.version };
  const abs = absOf(seg);
  return {
    path: hostPath(abs ?? seg.path), line: im.line, start: im.line, text: [], html: [], seg: pseg, kind: "module", rows: [],
    ...(await topOf({ sig: `(module) ${m.word}` }, null, seg.lang)), lib: rel[0], title: rel.join("/"),
  };
}

/** 没有语言服务：在段所在的函数里往上找 word = … / 参数 */
async function localDef(m: PeekReq): Promise<PeekDef | null> {
  const seg = m.seg;
  const full = await versionText(seg);
  if (!full) return null;
  const lines = splitLines(full);
  const name = m.word.replace(/^self\./, "");
  const esc = escapeRegExp(name);
  const isSelf = m.word.startsWith("self.");
  const re = new RegExp(isSelf ? `^\\s*self\\.${esc}\\s*(:[^=]*)?=(?!=)` : `^\\s*${esc}\\s*(:[^=]*)?=(?!=)|^\\s*(?:async\\s+)?def\\s+\\w+\\(.*\\b${esc}\\b`);
  const a = analysisOf(seg.lang, full, absOf(seg) ?? undefined);
  const fn = symbolAt(a.symbols, m.line, "def");
  const cls = isSelf ? a.symbols.find((s) => s.kind === "class" && fn?.parent === s.qual) : undefined;
  const lo = cls?.start ?? fn?.start ?? 1, hi = cls ? cls.end : m.line - 1;
  let hit = -1;
  for (let l = isSelf ? lo : hi; isSelf ? l <= hi : l >= lo; isSelf ? l++ : l--) if (re.test(lines[l - 1] ?? "") && l !== m.line) { hit = l; break; }
  if (hit < 0) return null;
  const plan = peekPlan(a, lines, hit, { word: name });
  // 函数参数那一行：只要上下文
  const rows = plan.kind === "function" ? [Math.max(1, hit - 1), hit, Math.min(lines.length, hit + 1)].filter((x, i, xs) => xs.indexOf(x) === i) : plan.rows;
  const start = rows[0], end = rows[rows.length - 1];
  const pseg: Segment = { id: mkUid("s"), src: seg.src, path: seg.path, lang: seg.lang, start, end, text: lines.slice(start - 1, end), version: seg.version, scope: symbolAt(a.symbols, hit)?.qual };
  const abs = absOf(seg);
  const out: PeekDef = {
    path: hostPath(abs ?? seg.path), line: hit, start, text: rows.map((l) => lines[l - 1] ?? ""), html: await rowsHtml(rows, seg.lang, full, lines), seg: pseg,
    kind: plan.kind === "function" ? "other" : plan.kind, rows, head: plan.kind === "function" ? undefined : plan.head, more: plan.kind === "function" ? undefined : plan.more,
    ...(plan.kind === "field" ? await topOf(plan, null, seg.lang) : {}), lib: abs ? await libOf(abs) : undefined,
  };
  const f = followOf(lines[hit - 1], name);
  if (f) out.follow = { label: f.expr, line: hit, col: f.col, path: hostPath(abs ?? seg.path) };
  return out;
}
