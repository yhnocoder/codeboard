// 先问 VS Code 的「转到定义」（装了 Pylance、clangd 时最准）；钉的版本不是工作区当前内容、或者语言服务没给结果时，按名字在索引里找。
import * as path from "node:path";
import {
  rankByReceiver,
  renderLine,
  uid,
  type CodeCard,
  type ExpandPick,
  type ExpandResult,
  type ImplPick,
  type DispatchResult,
  type PeekDef,
  type PeekResult,
  type Segment,
} from "@codeboard/core";
import { grammarOf, grammarOfFile } from "@codeboard/analysis/langs";
import { escapeRegExp, type Var } from "@codeboard/analysis/basics";
import {
  isAbstractBody,
  isModuleDef,
  peekPlan,
  splitHover,
  symbolAt,
  varCandidates,
  type CallSite,
  type FileAnalysis,
  type Sym,
} from "@codeboard/analysis";
import {
  crossAfterDefs,
  crossBefore,
  decorate,
  viaOps,
  viaRegistry,
  withAlts,
  type Crossed,
  type Target,
} from "./bridge";
import { pyOpEntry } from "./torchentry";
import { analysisOf, cachedAnalysis, segAnalysis, treeAt } from "./analysis";
import type { Def } from "./defcache";
import { Prio } from "./sched";
import { cardForFileSym, symCard } from "./cards";
import { hasLocalFile } from "./source";
import { makeSegment, workingPlace } from "./versions";
import { highlight, tokensOf } from "./views";
import { dedent } from "./highlight";
import { libOf } from "./scope";
import { type IndexEntry } from "./nameindex";
import { exists, splitLines } from "./ws";
import type { HostContext } from "./context";

export async function symAtDef(
  cx: HostContext,
  d: Def,
  name?: string,
  qual?: string,
): Promise<{ abs: string; sym: Sym } | null> {
  const text = await cx.readText(d.abs);
  if (text === null) return null;
  const syms = analysisOf(cx.langOf(d.abs), text).symbols;
  const sym =
    syms.find((s) => s.defLine === d.line && (!name || s.name === name)) ??
    (qual ? syms.find((s) => s.qual === qual) : undefined) ??
    syms.find((s) => s.defLine === d.line) ??
    (name
      ? symbolAt(
          syms.filter((s) => s.name === name),
          d.line,
        )
      : undefined);
  return sym ? { abs: d.abs, sym } : null;
}

const toSym = (e: IndexEntry): Sym => ({
  name: e.name,
  qual: e.qual,
  kind: e.kind,
  start: e.start,
  end: e.end,
  defLine: e.defLine,
  sig: e.sig,
  params: [],
});

type ExpandReq = { seg: Segment; line: number; col: number; name: string; recv?: string; pick?: ExpandPick };

/** pick 的文件：rel = 相对段自己的来源根（工作区外的类卡点成员），否则是 hostPath */
const pickAbs = (cx: HostContext, seg: Segment, p: ExpandPick) =>
  p.rel ? cx.sources.absOf({ ...seg, path: p.path }) : cx.fromHostPath(p.path);

const none = (reason: string): ExpandResult => ({ none: true, reason });

/** 点击解析时后台的活（预取、预热、名字索引）先等着 */
export const expand = (cx: HostContext, m: ExpandReq): Promise<ExpandResult> =>
  cx.sched.run(Prio.Click, () => expandNow(cx, m));

/** What one click asks, shared read-only by the resolvers; the language service's answer is asked at most once */
type Click = {
  m: ExpandReq;
  seg: Segment;
  site: CallSite | undefined;
  here: { abs: string; text: string } | null;
  /** where the segment's lines are in the working copy */
  place: () => ReturnType<typeof workingPlace>;
  /** Go to Definition at the call, sorted out (see askLsp); null when the segment is not the working copy's content */
  lsp: () => Promise<LspAnswer | null>;
};
type LspAnswer = {
  /** definitions, .pyi stubs of Python code already replaced by the code */
  defs: Def[];
  /** stubs of compiled code (torch._C.*, Tensor.X, extensions): only an answer when nothing else is found */
  stubs: Def[];
  /** C++ landing on generated operator files or DEFINE_DISPATCH: routed through the yaml / REGISTER_DISPATCH */
  crossed: Crossed[];
  /** a method that subclasses may override: the implementations if they came quickly, otherwise true (ask again later) */
  dispatch: Awaited<ReturnType<typeof dispatchOf>> | boolean;
};
/** A resolver's answer: the targets (cross-language ones with their marks), or a reply as it is (a list to pick from) */
type Hit = { crossed: Crossed[] } | { targets: Target[] } | { reply: ExpandResult };
type Resolver = (cx: HostContext, c: Click) => Promise<Hit | null>;

/** The language service gave nothing that is a definition here: a Python call may go to an extension or a kernel */
const pyWithoutLsp = async (c: Click) => c.seg.lang === "python" && !(await c.lsp())?.defs.length;

/**
 * Where a click goes, in order; the first hit wins. Cross-language routes the language service cannot answer
 * (torch.ops, launch macros, JIT compiles) come first, then the language service, then the routes for what it answered
 * with nothing, last the name index
 */
const RESOLVERS: Resolver[] = [
  // a pick from an earlier reply: only that
  async (cx, { m, seg }) => {
    if (!m.pick) return null;
    const abs = pickAbs(cx, seg, m.pick);
    const t =
      abs && (await symAtDef(cx, { abs, line: m.pick.line, col: 0 }, m.pick.rel ? m.name : undefined, m.pick.qual));
    return { targets: t ? [t] : [] };
  },
  // the language service is asked only to tell apart several PyTorch checkouts in the workspace (the same request goes on)
  async (cx, c) => {
    const lspAt = async () => {
      const p = await c.place();
      return p?.exact ? (await cx.lsp.defs(p.abs, p.start + (c.m.line - c.seg.start), c.m.col)).map((d) => d.abs) : [];
    };
    const crossed = await crossBefore(cx, c.site, c.seg.lang, c.here, lspAt);
    return crossed.length ? { crossed } : null;
  },
  async (_cx, c) => {
    const l = await c.lsp();
    return l?.crossed.length ? { crossed: l.crossed } : null;
  },
  async (_cx, c) => {
    const d = (await c.lsp())?.dispatch;
    return d && d !== true ? { reply: d.result } : null;
  },
  async (cx, c) => {
    const targets: Target[] = [];
    for (const d of (await c.lsp())?.defs ?? []) {
      const t = await symAtDef(cx, d, c.m.name);
      if (t && !targets.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)) targets.push(t);
    }
    return targets.length ? { targets } : null;
  },
  // PyTorch's x.X(…): x may be a Tensor and X an operator with a method variant, so the yaml's kernels are candidates.
  // Before the registrations: Tensor methods all have generated PyMethodDef bindings (THPVariable_softmax), only glue
  async (cx, c) => {
    if (!c.site || !c.here || !(await pyWithoutLsp(c))) return null;
    const crossed = await tensorMethod(cx, c.site, c.here);
    return crossed.length ? { crossed } : null;
  },
  // Python calling into C / C++ / Rust: the pybind / PyO3 registrations, unless the name index has a Python definition of
  // that name (self.model.forward is not the C++ .def("forward")). With PyTorch's operator index only already analysed
  // files count: no workspace scan for this
  async (cx, c) => {
    if (!(await pyWithoutLsp(c))) return null;
    const { m, here } = c;
    const torch = !!(await cx.ops.opTableFor(here?.abs));
    if ((torch ? cx.index.knownEntries(m.name) : await cx.index.lookupName(m.name)).some((e) => /\.py$/.test(e.abs)))
      return null;
    const crossed = await viaRegistry(cx, m.name, here?.abs);
    return crossed.length ? { crossed } : null;
  },
  async (cx, c) => {
    const targets: Target[] = [];
    for (const d of (await c.lsp())?.stubs ?? []) {
      const t = await symAtDef(cx, d, c.m.name);
      if (t && !targets.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)) targets.push(t);
    }
    return targets.length ? { targets } : null;
  },
  // By name. When the language service gave a definition that is not a function or class (a variable, attribute,
  // parameter), only the current file and files already analysed: no workspace scan (tens of seconds in big repositories)
  async (cx, { m, seg, site, place, lsp }) => {
    let ents = (await lsp())?.defs.length
      ? await nearbyEntries(cx, m.name, (await place())?.abs)
      : await cx.index.lookupName(m.name);
    if (grammarOf(seg.lang) === "cpp") ents = await cppCands(cx, ents, site);
    const cands = ents.map((e) => ({ ...e, path: cx.hostPath(e.abs), line: e.defLine }));
    if (!cands.length) return null;
    const selfClass =
      (seg.symbol?.kind === "class" ? seg.symbol.qual : seg.symbol?.qual.split(".").slice(0, -1).join(".")) ||
      seg.scope?.split(".").slice(0, -1).join(".");
    const { ranked, best } = rankByReceiver(cands, m.recv ?? site?.recv, {
      path: await currentFile(cx, seg),
      selfClass,
    });
    if (best) return { targets: [{ abs: best.abs, sym: toSym(best) }] };
    return {
      reply: {
        pick: ranked
          .slice(0, 20)
          .map((e) => ({ label: e.qual, detail: `${e.path}:${e.defLine}`, path: e.path, line: e.defLine })),
      },
    };
  },
];

/**
 * Go to Definition at the call in the working copy. A .pyi stub next to a .py stands for the definition in that .py.
 * Stubs with no .py next to them in the project (torch._C.*, Tensor.X, compiled extensions) are not the code: they are
 * kept aside and become the answer only when nothing else is found. Library stubs (typeshed's builtins.pyi, packages
 * outside the workspace or under .venv) are answers as usual: a pybind .def("get") of the same name has nothing to do
 * with dict.get
 */
async function askLsp(cx: HostContext, c: Omit<Click, "lsp">): Promise<LspAnswer | null> {
  const wp = await c.place();
  if (!wp?.exact) return null;
  const { m, seg } = c;
  let defs: Def[] = [];
  let stubs: Def[] = [];
  for (const d of await cx.lsp.clickDefs(wp.abs, wp.start + (m.line - seg.start), m.col)) {
    const impl = isStub(d)
      ? ((await stubImpl(cx, d, m.name)) ?? (cx.inWorkspace(d.abs) && !cx.inExcludedDir(d.abs) ? null : d))
      : d;
    if (!impl) stubs.push(d);
    else if (!defs.some((x) => x.abs === impl.abs && x.line === impl.line)) defs.push(impl);
  }
  if (defs.length) stubs = [];
  const crossed = await crossAfterDefs(cx, c.site, seg.lang, defs, c.here?.abs);
  if (crossed.length) defs = [];
  // Dynamic dispatch: the definition is a base class's method that subclasses override → all implementations to pick
  // from. Go to Implementation makes Pylance search the whole workspace for subclasses (seconds when cold, on slow
  // machines): a click waits only a moment (a prefetch may have it cached already); otherwise the card is built from the
  // definition and the reply says dispatching, so the board asks again (dispatchAt) and offers the overrides then
  let dispatch: LspAnswer["dispatch"] = false;
  if (defs.length === 1) {
    const dsp = dispatchOf(cx, defs[0], m.name);
    const quick = await within(dsp, DISPATCH_WAIT);
    if (quick === LATE) {
      dsp.catch(() => null);
      dispatch = await mayDispatch(cx, defs[0], m.name);
    } else dispatch = quick ?? false;
  }
  return { defs, stubs, crossed, dispatch };
}

async function expandNow(cx: HostContext, m: ExpandReq): Promise<ExpandResult> {
  const seg = m.seg;
  if (seg.src.kind === "free") return none("Free code has no source to follow.");
  if (seg.src.kind === "github") return none("Expanding calls in GitHub code is not supported yet.");
  const full = await cx.sources.versionText(seg);
  const site = callSite(cx, seg, full, m);
  if (!site)
    cx.log(
      "warn",
      `expand ${m.name} → callSite miss path=${seg.path}:${m.line}:${m.col}${full ? "" : " (file text unavailable, used saved lines)"}`,
    );
  const here = full ? { abs: cx.sources.absOf(seg) ?? seg.path, text: full } : null;
  let place: ReturnType<typeof workingPlace> | undefined;
  let lsp: Promise<LspAnswer | null> | undefined;
  const base = { m, seg, site, here, place: () => (place ??= workingPlace(cx, seg)) };
  const c: Click = { ...base, lsp: () => (lsp ??= askLsp(cx, base)) };

  let hit: Hit | null = null;
  for (const r of RESOLVERS) if ((hit = await r(cx, c))) break;
  if (hit && "reply" in hit) return hit.reply;
  let crossed = hit && "crossed" in hit ? hit.crossed : [];
  const targets = hit && "targets" in hit ? hit.targets : [];
  const l = lsp && (await lsp);
  // a cross-language answer still offers the compiled code's stubs as alternatives
  if (crossed.length && l?.stubs.length) crossed = await withStubs(cx, crossed, l.stubs, m.name);

  if (!crossed.length && !targets.length) {
    const why = site?.dispatch ? "Dynamic dispatch: not resolved" : `No definition found for “${m.name}”.`;
    const wp = place && (await place);
    const resolved = wp
      ? `${cx.hostPath(wp.abs)}:${wp.start + (m.line - seg.start)}${wp.exact ? "" : " (inexact)"}`
      : "none";
    cx.log(
      "warn",
      `expand ${m.name} → ${why} path=${seg.path}:${m.line}:${m.col} resolved=${resolved} lsp=${l?.defs.length ?? 0}${m.pick ? ` pick=${m.pick.path}:${m.pick.line}` : ""}`,
    );
    return { ...none(why), name: m.name };
  }
  if (targets.length > 1)
    return {
      pick: targets.map((t) => ({
        label: t.sym.qual,
        detail: `${cx.hostPath(t.abs)}:${t.sym.defLine}`,
        path: cx.hostPath(t.abs),
        line: t.sym.defLine,
      })),
    };

  // 目标找到了：Triton 的 [grid]、CUDA 的 <<<>>>、TileLang 工厂补上边界和取值
  const x = crossed.length
    ? await withAlts(cx, crossed)
    : await decorate(cx, site, targets[0], full ? callerOf(seg.lang, full, m.line) : undefined);
  const t = x.t;
  if (crossed.length)
    cx.log(
      "info",
      `expand ${m.name} → ${x.mark.bound ?? "definition"} → ${t.sym.qual} (${cx.hostPath(t.abs)}:${t.sym.defLine})${crossed.length > 1 ? ` +${crossed.length - 1} alternatives` : ""}`,
    );
  const nc = await cardForFileSym(cx, t.abs, t.sym);
  if (!nc) {
    cx.log("error", `expand ${m.name} → cannot read ${cx.hostPath(t.abs)}`);
    return none(`Cannot read ${cx.hostPath(t.abs)}.`);
  }
  const mark = Object.keys(x.mark).length ? x.mark : undefined;
  return {
    card: nc.card as CodeCard,
    views: nc.views,
    w: nc.w,
    vars: site && !t.sym.name.startsWith("<") ? await varsFor(cx, site, t) : [],
    ...(mark ? { mark } : {}),
    ...(x.title ? { title: x.title } : {}),
    ...(l?.dispatch === true && !crossed.length ? { dispatching: true as const } : {}),
  };
}

/** The stubs' definitions added to a cross-language answer as alternatives */
async function withStubs(cx: HostContext, crossed: Crossed[], stubs: Def[], name: string): Promise<Crossed[]> {
  const out = [...crossed];
  for (const d of stubs) {
    const t = await symAtDef(cx, d, name);
    if (t && !out.some((x) => x.t.abs === t.abs && x.t.sym.qual === t.sym.qual))
      out.push({ t, mark: {}, label: `stub · ${path.basename(t.abs)} ${t.sym.qual}` });
  }
  return out;
}

/**
 * recv.X(…) 而 X 是有 method 变体的 PyTorch 算子：它的 kernel。名字索引里已有的同名 Python 方法只在 recv 明显是它们的类时接手；
 * 它们从不和 kernel 一起当备选（索引建的过程中有哪些会变，同名的模块级函数、包括调用处自己，也不是方法）
 */
async function tensorMethod(cx: HostContext, site: CallSite, here: { abs: string; text: string }): Promise<Crossed[]> {
  const t = await cx.ops.opTableFor(here.abs);
  const e = t && pyOpEntry(t, site, here.text);
  if (!t || e?.how !== "method") return [];
  const methods = cx.index
    .knownEntries(site.name)
    .filter(
      (x) =>
        /\.py$/.test(x.abs) &&
        x.kind === "def" &&
        x.qual.includes(".") &&
        !(x.abs === here.abs && site.line >= x.start && site.line <= x.end),
    )
    .map((x) => ({ ...x, path: cx.hostPath(x.abs), line: x.defLine })); // 不为这个扫工作区
  if (methods.length > 1 && rankByReceiver(methods, site.recv, { path: cx.hostPath(here.abs) }).best) return [];
  return viaOps(cx, t, e.op);
}

/**
 * C++ 里按名字找到的候选：只要 C / C++ / CUDA 的；ns::f(…) 要 qual 以 ns::f 结尾的；普通调用不会是 __global__ kernel（那要 <<<>>> 或 launch）。
 * 筛完一个都不剩就照原样
 */
async function cppCands(cx: HostContext, ents: IndexEntry[], site: CallSite | undefined): Promise<IndexEntry[]> {
  const keep = (xs: IndexEntry[], f: (e: IndexEntry) => boolean | Promise<boolean>) =>
    Promise.all(xs.map(async (e) => [e, await f(e)] as const)).then((r) => {
      const k = r.filter(([, ok]) => ok).map(([e]) => e);
      return k.length ? k : xs;
    });
  let out = await keep(ents, (e) => grammarOfFile(e.abs) === "cpp");
  if (site?.recv && /^[A-Za-z_][\w:]*$/.test(site.recv) && !site.recv.includes("."))
    out = await keep(out, (e) => e.qual.endsWith(`${site.recv}::${e.name}`));
  if (!site?.launch)
    out = await keep(out, async (e) => {
      const t = await cx.readText(e.abs);
      return (
        !t ||
        !/__global__/.test(
          splitLines(t)
            .slice(e.start - 1, e.defLine)
            .join("\n"),
        )
      );
    });
  return out;
}

/** 调用所在的那一行和函数的文本（CUDA 的 <<<>>> 要读模板实参、constexpr） */
function callerOf(lang: string, full: string, line: number): { lang: string; line: string; fnText: string } {
  const lines = splitLines(full);
  const fn = symbolAt(
    analysisOf(lang, full).symbols.filter((s) => s.kind === "def"),
    line,
  );
  return { lang, line: lines[line - 1] ?? "", fnText: fn ? lines.slice(fn.start - 1, fn.end).join("\n") : "" };
}

/** 点击时最多等转到实现多久（ms）：缓存里有、或者语言服务热着时够用；再久就先建卡 */
export const DISPATCH_WAIT = 200;
const LATE = Symbol("late");
const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<typeof LATE>((r) => {
      t = setTimeout(() => r(LATE), ms);
    }),
  ]).finally(() => clearTimeout(t));
};
const isStub = (d: Def) => /\.pyi$/.test(d.abs);

/** .pyi 存根声明的定义在旁边 .py 里的位置（typeshed 式的 Python 代码存根）；编译代码的存根返回 null */
async function stubImpl(cx: HostContext, d: Def, name?: string): Promise<Def | null> {
  const py = d.abs.replace(/\.pyi$/, ".py");
  const stub = await symAtDef(cx, d, name);
  const text = stub && (await cx.readText(py, false));
  if (!stub || !text) return null;
  const sym = analysisOf("python", text).symbols.find((s) => s.qual === stub.sym.qual && s.kind === stub.sym.kind);
  if (!sym) return null;
  const col = splitLines(text)[sym.defLine - 1]?.indexOf(sym.name) ?? 0;
  return { abs: py, line: sym.defLine, col: Math.max(0, col) };
}

/**
 * 对一个定义去哪里问 Go to Implementation：存根的 .py；PyTorch 编译代码的存根不问，算子路由代替它
 * （Pylance 在那里搜整个工作区 ~24 s，什么也找不到）
 */
async function implSite(cx: HostContext, d: Def, name: string): Promise<Def | null> {
  if (!isStub(d)) return d;
  const impl = await stubImpl(cx, d, name);
  if (impl) return impl;
  return (await cx.ops.opTableFor(d.abs)) ? null : d;
}

/** dispatchOf 会去问转到实现的那种定义：Python 类里的方法 */
async function mayDispatch(cx: HostContext, d: Def, name: string): Promise<boolean> {
  if (cx.langOf(d.abs) !== "python") return false;
  const b = await symAtDef(cx, d, name);
  return overridable(b, name);
}
/**
 * 被调用的方法本身：类里的 def，名字就是调用的名字。名字不同的（x.foo 落到 __getattr__，torch.ops.aten.X 落到 _OpNamespace.__getattr__）
 * 覆盖它的子类和这次调用无关，不为它问转到实现（Pylance 在大工作区里要找十几秒）
 */
const overridable = (b: Target | null, name: string): b is Target & { sym: { parent: string } } =>
  !!b && !!b.sym.parent && b.sym.kind === "def" && b.sym.name === name;

/** expand 回了 dispatching 之后白板来问：同一个调用点的定义处有没有被覆盖（定义、转到实现都走缓存，和 expand 发出去的是同一个请求） */
export async function dispatchAt(
  cx: HostContext,
  m: {
    seg: Segment;
    line: number;
    col: number;
    name: string;
  },
): Promise<DispatchResult> {
  if (!hasLocalFile(m.seg.src)) return null;
  const wp = await workingPlace(cx, m.seg);
  if (!wp?.exact) return null;
  const defs = await cx.lsp.clickDefs(wp.abs, wp.start + (m.line - m.seg.start), m.col);
  if (defs.length !== 1) return null;
  const d = await dispatchOf(cx, defs[0], m.name);
  return d ? { ...d.result, ...(d.abstract ? { abstract: true as const } : {}) } : null;
}

/**
 * 定义处是类里的方法：在它上面问「转到实现」（Pylance 回所有覆盖它的子类方法）。有覆盖就是动态分发：
 * 列出全部实现（基类自己不是抽象的也算一个），library 里的标上包名（⌥ 才展开）
 */
export async function dispatchOf(
  cx: HostContext,
  def: Def,
  name: string,
): Promise<{ result: Extract<ExpandResult, { impls: unknown }>; n: number; base: string; abstract: boolean } | null> {
  if (cx.langOf(def.abs) !== "python") return null;
  const d = await implSite(cx, def, name);
  if (!d) return null;
  const b = await symAtDef(cx, d, name);
  if (!overridable(b, name)) return null;
  let locs: Def[] = [];
  try {
    locs = await cx.lsp.impls(d);
  } catch {
    return null;
  }
  const impls: Target[] = [];
  for (const l of locs) {
    if (l.abs === d.abs && l.line === d.line) continue;
    const t = await symAtDef(cx, l, name);
    if (
      t &&
      !(t.abs === b.abs && t.sym.qual === b.sym.qual) &&
      !impls.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)
    )
      impls.push(t);
  }
  if (!impls.length) return null;
  const text = await cx.readText(b.abs);
  const abstract = text !== null && isAbstractBody(splitLines(text), b.sym);
  const pick = async (t: Target, base?: true): Promise<ImplPick> => {
    const lib = await libOf(cx, t.abs);
    return {
      label: t.sym.qual,
      detail: `${cx.hostPath(t.abs)}:${t.sym.defLine}`,
      path: cx.hostPath(t.abs),
      line: t.sym.defLine,
      qual: t.sym.qual,
      ...(lib ? { lib } : {}),
      ...(base ? { base } : {}),
    };
  };
  const list = [...(abstract ? [] : [await pick(b, true)]), ...(await Promise.all(impls.map((t) => pick(t))))];
  cx.log("info", `dynamic dispatch ${b.sym.qual} → ${list.length} implementations`);
  return { result: { impls: list, base: b.sym.qual }, n: list.length, base: b.sym.parent, abstract };
}

/** 不扫工作区的名字查找：当前文件 + 最近读过、分析还在缓存里的文件 */
async function nearbyEntries(cx: HostContext, name: string, here?: string): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  const files = [...new Set([...(here ? [here] : []), ...cx.recentFiles()])];
  for (const abs of files) {
    const text = await cx.readText(abs);
    if (text === null) continue;
    const a = abs === here ? analysisOf(cx.langOf(abs), text) : cachedAnalysis(cx.langOf(abs), text);
    for (const s of a?.symbols ?? [])
      if (s.name === name)
        out.push({
          name: s.name,
          qual: s.qual,
          kind: s.kind,
          abs,
          start: s.start,
          end: s.end,
          defLine: s.defLine,
          sig: s.sig,
        });
  }
  return out;
}

async function currentFile(cx: HostContext, seg: Segment) {
  const loc = (await workingPlace(cx, seg))?.abs;
  return loc ? cx.hostPath(loc) : seg.path;
}

function callSite(cx: HostContext, seg: Segment, full: string | null, m: ExpandReq): CallSite | undefined {
  let calls: CallSite[];
  let shift = 0,
    colOff = 0;
  if (full) calls = segAnalysis(seg.lang, full, m.line, m.line, treeAt(cx, cx.sources.absOf(seg))).calls;
  else {
    const d = dedent(seg.text);
    colOff = d.cut;
    calls = analysisOf(seg.lang, d.lines.join("\n")).calls;
    shift = seg.start - 1;
  }
  const on = calls.filter((c) => c.line + shift === m.line);
  return on.find((c) => c.col + colOff === m.col) ?? on.find((c) => c.name === m.name || c.dispatch === m.name);
}

/** 带 Call 标记的箭头的变量候选：类的话用 __init__ 的参数 */
async function varsFor(cx: HostContext, site: CallSite, t: { abs: string; sym: Sym }): Promise<Var[]> {
  const text = t.sym.kind === "class" || !t.sym.params.length ? await cx.readText(t.abs) : null;
  return varCandidates(site, calleeOf(t.sym, text ? analysisOf(cx.langOf(t.abs), text).symbols : []));
}
/** 被调的函数：类 → __init__；索引里来的 Sym 没有参数，按 qual 在分析结果里补 */
function calleeOf(sym: Sym, syms: Sym[]): Sym {
  if (sym.kind === "class") return syms.find((s) => s.qual === `${sym.qual}.__init__`) ?? sym;
  return sym.params.length
    ? sym
    : (syms.find((s) => s.qual === sym.qual && s.start === sym.start) ?? syms.find((s) => s.qual === sym.qual) ?? sym);
}

type CallVarsReq = { seg: Segment; line: number; col: number; name: string; target: Segment };

/** 调用接到已有的卡上（拖过去 / Link to Existing Card）：按目标卡的符号算变量候选 */
export async function callVars(cx: HostContext, m: CallVarsReq): Promise<Var[]> {
  if (m.seg.src.kind === "free") return [];
  const site = callSite(cx, m.seg, await cx.sources.versionText(m.seg), m);
  if (!site) return [];
  const t = m.target;
  const full = t.src.kind === "free" ? null : await cx.sources.versionText(t);
  let syms: Sym[];
  if (full) syms = analysisOf(t.lang, full).symbols;
  else {
    // 只有段文本：去掉公共缩进再分析，行号对回去
    syms = analysisOf(t.lang, dedent(t.text).lines.join("\n")).symbols.map((s) => ({
      ...s,
      start: s.start + t.start - 1,
      defLine: s.defLine + t.start - 1,
      end: s.end + t.start - 1,
      params: s.params.map((p, i) => (i === 0 && /^(self|cls)$/.test(p.name) ? { ...p, kind: "self" as const } : p)), // 方法单独分析时看不出 self
    }));
  }
  const top =
    (t.symbol && syms.find((s) => s.qual === t.symbol!.qual)) ??
    syms.filter(
      (s) => s.start >= t.start && s.end <= t.end && (s.name === m.name || s.qual.endsWith(`.${m.name}`)),
    )[0] ??
    symbolAt(syms, t.start);
  return top ? varCandidates(site, calleeOf(top, syms)) : [];
}

type PeekReq = {
  seg: Segment;
  line: number;
  col: number;
  word: string;
  at?: { path: string; line: number; col: number };
};
type Hover = { sig?: string; doc?: string };

/** VS Code 的 hover（Pylance：签名代码块 + Markdown 文档）；没有语言服务时为 null */
async function hoverAt(cx: HostContext, abs: string, line: number, col: number): Promise<Hover | null> {
  try {
    const parts = await cx.ws.language.hover(abs, line, col);
    // Pylance 在文档末尾带 <!--moduleHash:...--> 之类的 HTML 注释，Markdown 渲染时会原样显示，先去掉
    const r = splitHover(
      parts
        .join("\n\n")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim(),
    );
    return r.sig || r.doc ? r : null;
  } catch {
    return null;
  }
}

export async function peek(cx: HostContext, m: PeekReq): Promise<PeekResult> {
  let defs: Def[] = [];
  let use: { abs: string; line: number; col: number } | undefined;
  if (m.at) use = { abs: cx.fromHostPath(m.at.path), line: m.at.line, col: m.at.col };
  else if (m.seg.src.kind !== "free") {
    const wp = await workingPlace(cx, m.seg);
    if (wp?.exact) use = { abs: wp.abs, line: wp.start + (m.line - m.seg.start), col: m.col };
  }
  if (use) defs = await cx.lsp.clickDefs(use.abs, use.line, use.col);
  if (defs.length) {
    // hover 在使用处问（Pylance 给的类型更具体），没有再问定义处
    const hov =
      (use && (await hoverAt(cx, use.abs, use.line, use.col))) ||
      (await hoverAt(cx, defs[0].abs, defs[0].line, defs[0].col));
    // 动态分发的提示也不让 peek 等转到实现：等不到这次就不显示（请求还在跑，进了缓存下次就有）
    const dp = defs.length === 1 ? dispatchOf(cx, defs[0], m.word.split(".").pop()!) : null;
    const [out, q] = await Promise.all([peekAt(cx, defs[0], m.word, hov), dp ? within(dp, DISPATCH_WAIT) : null]);
    if (q === LATE) dp!.catch(() => null);
    const dsp = q === LATE ? null : q;
    if (out && dsp) out.dispatch = { n: dsp.n, base: dsp.base, ...(dsp.abstract ? { abstract: true } : {}) };
    return out;
  }
  // 兜底 1：import 进来的模块（mp → torch.multiprocessing）
  const mod = await importedModule(cx, m);
  if (mod) return mod;
  // 兜底 2：同一个函数里的赋值 / 参数（按那个版本的文本）
  const local = await localDef(cx, m);
  if (local) return local;
  // 兜底 3：名字索引里的函数 / 类
  const word = m.word.split(".").pop()!;
  const hits = await cx.index.lookupName(word);
  if (hits?.length) {
    const e =
      hits.length === 1
        ? hits[0]
        : rankByReceiver(
            hits.map((h) => ({ ...h, path: cx.hostPath(h.abs), line: h.defLine })),
            m.word.includes(".") ? m.word.split(".").slice(0, -1).join(".") : undefined,
            { path: m.seg.path },
          ).ranked[0];
    return peekAt(cx, { abs: e.abs, line: e.defLine, col: 0 }, word);
  }
  // 兜底 4：x.field → 有类的文件里找类体字段 field: … = …（只看前 400 个文件）
  const f = await classField(cx, word);
  return f ? peekAt(cx, f, word) : null;
}

/** How many files with classes classField looks through */
const CLASS_FILES = 400;
async function classField(cx: HostContext, word: string): Promise<Def | null> {
  if (!/^[A-Za-z_]\w*$/.test(word)) return null;
  const re = new RegExp(`^\\s+${word}\\s*(:[^=]*)?=(?!=)`);
  let n = 0;
  for (const { abs, ents: known } of await cx.index.indexedFiles()) {
    let ents = known,
      text: string | null | undefined;
    if (!ents) {
      // 还没分析过：文本里没有这个词就不用分析
      text = await cx.readText(abs);
      if (!text || !text.includes(word)) continue;
      ents = await cx.index.entriesOf(abs);
    }
    if (!ents.some((e) => e.kind === "class")) continue;
    if (++n > CLASS_FILES) break;
    text ??= await cx.readText(abs);
    if (!text || !text.includes(word)) continue;
    const lines = splitLines(text);
    const a = analysisOf(cx.langOf(abs), text);
    for (let i = 0; i < lines.length; i++)
      if (re.test(lines[i]) && symbolAt(a.symbols, i + 1)?.kind === "class")
        return { abs, line: i + 1, col: lines[i].indexOf(word) };
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
  return {
    sig,
    sigHtml: sig ? (await highlight(splitLines(sig), lang)).join("\n") : undefined,
    doc: hov?.doc ?? plan.doc,
  };
}

/** 模块的显示名：torch/multiprocessing/__init__.py → torch/multiprocessing */
const modTitle = (p: string) => p.replace(/\/__init__\.pyi?$/, "").replace(/\.pyi?$/, "");

/** 定义的那几行（按定义类型取）+ hover + Pin / Place 用的段 + 下一跳 */
async function peekAt(
  cx: HostContext,
  d: Def,
  word: string,
  hov?: Hover | null,
  forceModule = false,
): Promise<PeekDef | null> {
  const text = await cx.readText(d.abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = cx.langOf(d.abs);
  const a = analysisOf(lang, text);
  const module = forceModule || /^\(module\)/.test(hov?.sig ?? "") || isModuleDef(lines, d.line, d.col, word);
  const plan = peekPlan(a, lines, d.line, { word, module });
  const sym = a.symbols.find((s) => s.defLine === d.line);
  const loc = await cx.sources.locOfFile(d.abs);
  const rows = plan.rows;
  let seg: Segment;
  if (sym && !module) seg = (await symCard(cx, loc, lines, sym, lang)).segments[0];
  else {
    const s = rows[0] ?? 1,
      e = rows[rows.length - 1] ?? Math.min(lines.length, 1);
    seg = await makeSegment(cx, loc, lines, s, e, { lang, scope: symbolAt(a.symbols, d.line)?.qual });
  }
  const out: PeekDef = {
    path: cx.hostPath(d.abs),
    line: d.line,
    start: rows[0] ?? d.line,
    text: rows.map((l) => lines[l - 1] ?? ""),
    html: await rowsHtml(rows, lang, text, lines),
    seg,
    kind: plan.kind,
    rows,
    head: plan.head,
    more: plan.more,
    ...(await topOf(plan, hov, lang)),
    lib: await libOf(cx, d.abs),
    title: module ? modTitle(loc.src.kind === "repo" ? cx.hostPath(d.abs) : loc.path) : undefined,
  };
  const f = !module && followOf(lines[d.line - 1] ?? "", word);
  if (f) {
    const next = await cx.lsp.defs(d.abs, d.line, f.col);
    const where = next[0] ? ` · ${path.basename(next[0].abs)}:${next[0].line}` : "";
    out.follow = { label: `${f.expr}${where}`, line: d.line, col: f.col, path: cx.hostPath(d.abs) };
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
async function importedModule(cx: HostContext, m: PeekReq): Promise<PeekDef | null> {
  const seg = m.seg;
  if (seg.src.kind === "free" || m.word.includes(".")) return null;
  const full = await cx.sources.versionText(seg);
  const a: FileAnalysis | null = full ? segAnalysis(seg.lang, full, 1, 0, treeAt(cx, cx.sources.absOf(seg))) : null; // 只用 import
  const im = a?.imports.find((i) => i.name === m.word && !i.from);
  if (!a || !im || !full) return null;
  const rel = im.module.split(".");
  for (const f of cx.roots())
    for (const c of [path.join(f, ...rel, "__init__.py"), path.join(f, ...rel) + ".py"])
      if (await exists(c)) return peekAt(cx, { abs: c, line: 1, col: 0 }, m.word, null, true);
  const lines = splitLines(full);
  const pseg: Segment = {
    id: uid("s"),
    src: seg.src,
    path: seg.path,
    lang: seg.lang,
    start: im.line,
    end: im.line,
    text: [lines[im.line - 1] ?? ""],
    version: seg.version,
  };
  const abs = cx.sources.absOf(seg);
  return {
    path: cx.hostPath(abs ?? seg.path),
    line: im.line,
    start: im.line,
    text: [],
    html: [],
    seg: pseg,
    kind: "module",
    rows: [],
    ...(await topOf({ sig: `(module) ${m.word}` }, null, seg.lang)),
    lib: rel[0],
    title: rel.join("/"),
  };
}

/** 没有语言服务：在段所在的函数里往上找 word = … / 参数 */
async function localDef(cx: HostContext, m: PeekReq): Promise<PeekDef | null> {
  const seg = m.seg;
  const full = await cx.sources.versionText(seg);
  if (!full) return null;
  const lines = splitLines(full);
  const name = m.word.replace(/^self\./, "");
  const esc = escapeRegExp(name);
  const isSelf = m.word.startsWith("self.");
  const re = new RegExp(
    isSelf
      ? `^\\s*self\\.${esc}\\s*(:[^=]*)?=(?!=)`
      : `^\\s*${esc}\\s*(:[^=]*)?=(?!=)|^\\s*(?:async\\s+)?def\\s+\\w+\\(.*\\b${esc}\\b`,
  );
  const a = analysisOf(seg.lang, full, treeAt(cx, cx.sources.absOf(seg)));
  const fn = symbolAt(a.symbols, m.line, "def");
  const cls = isSelf ? a.symbols.find((s) => s.kind === "class" && fn?.parent === s.qual) : undefined;
  const lo = cls?.start ?? fn?.start ?? 1,
    hi = cls ? cls.end : m.line - 1;
  let hit = -1;
  for (let l = isSelf ? lo : hi; isSelf ? l <= hi : l >= lo; isSelf ? l++ : l--)
    if (re.test(lines[l - 1] ?? "") && l !== m.line) {
      hit = l;
      break;
    }
  if (hit < 0) return null;
  const plan = peekPlan(a, lines, hit, { word: name });
  // 函数参数那一行：只要上下文
  const rows =
    plan.kind === "function"
      ? [Math.max(1, hit - 1), hit, Math.min(lines.length, hit + 1)].filter((x, i, xs) => xs.indexOf(x) === i)
      : plan.rows;
  const start = rows[0],
    end = rows[rows.length - 1];
  const pseg: Segment = {
    id: uid("s"),
    src: seg.src,
    path: seg.path,
    lang: seg.lang,
    start,
    end,
    text: lines.slice(start - 1, end),
    version: seg.version,
    scope: symbolAt(a.symbols, hit)?.qual,
  };
  const abs = cx.sources.absOf(seg);
  const out: PeekDef = {
    path: cx.hostPath(abs ?? seg.path),
    line: hit,
    start,
    text: rows.map((l) => lines[l - 1] ?? ""),
    html: await rowsHtml(rows, seg.lang, full, lines),
    seg: pseg,
    kind: plan.kind === "function" ? "other" : plan.kind,
    rows,
    head: plan.kind === "function" ? undefined : plan.head,
    more: plan.kind === "function" ? undefined : plan.more,
    ...(plan.kind === "field" ? await topOf(plan, null, seg.lang) : {}),
    lib: abs ? await libOf(cx, abs) : undefined,
  };
  const f = followOf(lines[hit - 1], name);
  if (f) out.follow = { label: f.expr, line: hit, col: f.col, path: cx.hostPath(abs ?? seg.path) };
  return out;
}
