// 代码卡、Compare、调用图、版本、Peek 小样共用：段和展示数据的拼法、假宿主多回答的几种请求、开浮层。
// 状态还是照宿主和用户的路从外面喂（onHost、store / ui / pop 的 setter），不为小样改组件
import {
  renderLine,
  viewKey,
  addVariant,
  switchVariant,
  UPSTREAM,
  type Board,
  type CallMark,
  type CallSpan,
  type CodeCard,
  type DiffData,
  type Link,
  type PeekDef,
  type Segment,
  type SegView,
  type Variant,
} from "@codeboard/core";
import { F_BLANK } from "@codeboard/analysis/basics";
import { codeCard } from "./board";
import { VIEWS, PASS, reply } from "./host";
import { el, frames } from "./play";
import { openPop, pinPop, type At, type Pop } from "../../src/state/pop";
import code from "../fixtures/code.json";

export type Fx = keyof typeof code;
export const FX = code as unknown as Record<Fx, { seg: Segment; view: SegView }>;

// 和 test/harness.ts 的 tokenize 一样粗的 Python 着色：改过的行、手写的代码在浏览器里现算，颜色和预先算好的 code.json 一致
const KW = new Set(
  "def return for in if else elif while and or not is None True False class break continue del import from as with lambda yield assert pass raise try except finally global nonlocal async await".split(
    " ",
  ),
);
const CKW = new Set(
  "void int float double char const return for if else while struct unsigned auto template typename __global__ __shared__ __syncthreads".split(
    " ",
  ),
);
function tokenize(t: string, lang: string) {
  const out: { text: string; cls?: string }[] = [];
  const c = lang !== "python";
  const re = c
    ? /(\/\/.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?f?\b)|(\b[A-Za-z_]\w*\b)|(\s+)|(.)/g
    : /(#.*$)|("""|'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m[1]) out.push({ text: m[1], cls: "com" });
    else if (m[2]) out.push({ text: m[2], cls: "str" });
    else if (m[3]) out.push({ text: m[3], cls: "num" });
    else if (m[4])
      out.push({ text: m[4], cls: (c ? CKW : KW).has(m[4]) ? "kw" : m[4] === "self" ? "self" : undefined });
    else out.push({ text: m[0], cls: m[6] ? "p" : undefined });
  }
  return out;
}

// 文件 + 行文字 → 那一行在预先算好的展示数据里的调用、标记：改过的段里没改的行照样能点调用
type LineInfo = { flag: number; calls: Omit<CallSpan, "line">[]; def?: { name: string; qual: string } };
const LINES = new Map<string, LineInfo>();
for (const x of Object.values(FX)) {
  x.seg.text.forEach((t, i) => {
    const l = x.seg.start + i,
      k = `${x.seg.path}\0${t}`;
    if (LINES.has(k)) return;
    const d = x.view.defs.find((q) => q.line === l);
    LINES.set(k, {
      flag: x.view.flags[i] ?? 0,
      calls: x.view.calls.filter((c) => c.line === l).map(({ line: _, ...c }) => c),
      ...(d ? { def: { name: d.name, qual: d.qual } } : {}),
    });
  });
}

/** 任意一段代码的展示数据：着色现算，调用和函数边界按行文字从 code.json 里借 */
export function viewFor(seg: Segment): SegView {
  const html: string[] = [],
    flags: number[] = [],
    calls: CallSpan[] = [],
    defs: SegView["defs"] = [];
  seg.text.forEach((t, i) => {
    const l = seg.start + i,
      info = seg.path ? LINES.get(`${seg.path}\0${t}`) : undefined;
    const marks = (info?.calls ?? []).map((c) => {
      calls.push({ ...c, line: l });
      return { col: c.col, end: c.end, idx: calls.length - 1, pkg: c.pkg };
    });
    html.push(renderLine(tokenize(t, seg.lang), marks));
    flags.push(info?.flag ?? (t.trim() ? 0 : F_BLANK));
    if (info?.def) defs.push({ line: l, ...info.def });
  });
  return { html, flags, calls, defs };
}

/** 段 id 对上自己算的展示数据：宿主问 views（Variant 切换、Free code 编辑时的着色）时按这张表答 */
const MINE = new Set<string>();
export function register(seg: Segment, view: SegView = viewFor(seg), key = seg.id) {
  VIEWS[key] = view;
  MINE.add(seg.id);
}

// 只答自己登记过的段（register）、DIFFS 里有的：别的交给假宿主的下一层
reply("views", (m: { segs: Segment[] }) =>
  m.segs.every((s) => MINE.has(s.id)) ? Object.fromEntries(m.segs.map((s) => [s.id, viewFor(s)])) : PASS,
);
reply("diff", (m: { seg: Segment }) => DIFFS[m.seg.id] ?? PASS);
export const DIFFS: Record<string, DiffData> = {};
export { COMMITS } from "./host";

let n = 0;
/** 函数卡：codeCard 之外再改段（高亮、隐藏、版本、来源……）；改了文字的段自己算展示数据 */
export function fn(
  id: string,
  f: Fx,
  o: { title?: string; seg?: (s: Segment) => void; card?: Partial<CodeCard> } = {},
): CodeCard {
  const c = codeCard(id, f, { title: o.title });
  const s = c.segments[0];
  const t0 = s.text.join("\n");
  o.seg?.(s);
  if (s.text.join("\n") !== t0) register(s);
  return Object.assign(c, o.card);
}
/** 函数里的几行（片段卡）：没有符号，按所在函数取名 */
export function slice(f: Fx, from: number, to: number, id = `x${++n}`): Segment {
  const x = FX[f],
    a = from - x.seg.start,
    b = to - x.seg.start + 1;
  const seg: Segment = {
    ...structuredClone(x.seg),
    id: `${x.seg.id}-${id}`,
    start: from,
    end: to,
    text: x.seg.text.slice(a, b),
    scope: x.seg.symbol?.qual,
  };
  delete seg.symbol;
  register(seg, {
    html: x.view.html.slice(a, b),
    flags: x.view.flags.slice(a, b),
    calls: x.view.calls.filter((c) => c.line >= from && c.line <= to),
    defs: x.view.defs.filter((d) => d.line >= from && d.line <= to),
    bare: x.view.bare,
  });
  return seg;
}
export const seg0 = (f: Fx, id: string): Segment => {
  const x = FX[f];
  const seg: Segment = { ...structuredClone(x.seg), id: `${x.seg.id}-${id}` };
  register(seg, x.view);
  return seg;
};
export const multi = (id: string, segs: Segment[], o: Partial<CodeCard> = {}): CodeCard => ({
  id,
  kind: "code",
  segments: segs,
  ...o,
});
/** 某个函数里第一处含 word 的行号 */
export const lineOf = (s: Segment, word: string) =>
  s.start +
  Math.max(
    0,
    s.text.findIndex((t) => t.includes(word)),
  );

/** 手写 / 粘贴的代码（Free code） */
export function free(
  id: string,
  text: string[],
  o: { lang?: string; title?: string; url?: string; card?: Partial<CodeCard> } = {},
): CodeCard {
  const seg: Segment = {
    id: `sf-${id}`,
    src: { kind: "free", ...(o.url ? { url: o.url } : {}) },
    path: "",
    lang: o.lang ?? "python",
    start: 1,
    end: text.length,
    text,
    version: { kind: "none" },
  };
  register(seg);
  return { id, kind: "code", segments: [seg], ...(o.title ? { title: o.title } : {}), ...o.card };
}

/** 改几行：edit 拿到文字改，返回同一个段 id 的新段（另一个分支、HEAD 上的新版本） */
export function edited(s: Segment, edit: (t: string[]) => void, o: Partial<Segment> = {}): Segment {
  const text = [...s.text];
  edit(text);
  const start = o.start ?? s.start;
  return { ...structuredClone(s), ...o, start, end: start + text.length - 1, text };
}
const find = (t: string[], word: string) => t.findIndex((l) => l.includes(word));
/** 另一个 worktree 上的 schedule：一行改、一行加（和 harness 的 variants 场景同一种改法） */
export const wtEdit = (t: string[]) => {
  const i = find(t, "scheduled_seqs = []");
  t[i] = t[i].replace("[]", "list()  # keep order");
  t.splice(i + 1, 0, t[i].replace(/\S.*/, "budget = self.max_num_batched_tokens  # 8192 → 131 TFLOPS"));
};
export const branchEdit = (t: string[]) => {
  t.splice(1, 0, t[1].replace(/\S.*/, "# fix-spec-bug: all-accepted rows"));
};
/** 上游最新：和 wtEdit 冲突的一行，另加一行只有上游改的 */
export const latestEdit = (t: string[]) => {
  const i = find(t, "scheduled_seqs = []");
  t[i] = t[i].replace("[]", "deque()");
  t[i + 1] = `${t[i + 1]}  # upstream tweak`;
};

/** 给卡加 Variant（core 的 addVariant），可以直接切过去；各个 Variant 的展示数据按 viewKey 登记好 */
export function withVariants(
  b: Board,
  c: CodeCard,
  vs: (Omit<Variant, "segs"> & { edit: (t: string[]) => void; seg?: Partial<Segment> })[],
  active?: string,
) {
  const s = c.segments[0],
    up = VIEWS[s.id] ?? viewFor(s);
  for (const v of vs) {
    const { edit, seg: so, ...rest } = v;
    const ns = edited(s, edit, so);
    addVariant(b, c.id, { ...rest, segs: [ns] });
    register(ns, viewFor(ns), viewKey(s.id, v.id));
  }
  if (active) {
    switchVariant(b, c.id, active);
    const cur = (b.cards.find((k) => k.id === c.id) as CodeCard).segments[0];
    register(cur, viewFor(cur));
    VIEWS[viewKey(s.id, UPSTREAM)] = up;
  }
}

/** 第 line 行调用了 to（Call 标记） */
export function callLink(
  id: string,
  from: CodeCard,
  word: string,
  to: string,
  call: Partial<CallMark> = {},
  o: Partial<Link> = {},
): Link {
  const s = from.segments[0];
  const line = lineOf(s, word);
  const name = call.name ?? word.replace(/\($/, "").split(".").pop()!;
  return {
    id,
    from: { card: from.id, seg: s.id, line },
    to: { card: to },
    call: { name, col: 0, ...call },
    ...o,
  } as Link;
}

/** HEAD 上的新版本：Update 弹窗的数据 */
export function diffOf(
  s: Segment,
  ns: Segment,
  title: string,
  lastChange = "Last changed in f64d821 · scheduler: chunked prefill only for the first seq · 2026-10-21",
): DiffData {
  const vs = VIEWS[s.id] ?? viewFor(s),
    vn = viewFor(ns);
  return {
    title,
    lastChange,
    canUpdate: true,
    newSeg: ns,
    newView: vn,
    left: {
      label: `Pinned ${s.version.kind === "git" ? s.version.commit.slice(0, 7) : ""}`,
      path: s.path,
      start: s.start,
      text: s.text,
      html: vs.html,
    },
    right: {
      label: `HEAD ${ns.version.kind === "git" ? ns.version.commit.slice(0, 7) : ""}`,
      path: ns.path,
      start: ns.start,
      text: ns.text,
      html: vn.html,
    },
  };
}

/** Peek 的定义：code.json 里一个函数（或其中几行） */
export function peekOf(f: Fx, o: Partial<PeekDef> & { lines?: [number, number] } = {}): PeekDef {
  const x = FX[f],
    [a, b] = o.lines ?? [x.seg.start, Math.min(x.seg.end, x.seg.start + 7)];
  const i = a - x.seg.start,
    j = b - x.seg.start + 1;
  const { lines: _, ...rest } = o;
  return {
    path: x.seg.path,
    line: x.seg.start,
    start: a,
    html: x.view.html.slice(i, j),
    text: x.seg.text.slice(i, j),
    seg: x.seg,
    kind: "function",
    ...(x.seg.end > b ? { more: x.seg.end - b } : {}),
    ...rest,
  };
}
/** 不在 code.json 里的定义（config.py、torch 里的）：几行手写的代码 */
export function peekText(path: string, line: number, text: string[], o: Partial<PeekDef> = {}): PeekDef {
  const seg: Segment = {
    id: `pk-${++n}`,
    src: { kind: "repo", repo: "" },
    path,
    lang: "python",
    start: line,
    end: line + text.length - 1,
    text,
    version: { kind: "git", commit: "bb823b3c0ffee" },
  };
  return {
    path,
    line,
    start: line,
    html: text.map((t) => renderLine(tokenize(t, "python"))),
    text,
    seg,
    kind: "field",
    ...o,
  };
}

/** 浮层挂在 sel 那个元素上；pin = 固定（固定的可以同时开好几个，Overview 里用） */
export async function popAt(pop: Pop, sel: string, o: { prefer?: At["prefer"]; pin?: boolean } = {}) {
  const at = await el(sel);
  await frames();
  const id = openPop(pop, { el: at, prefer: o.prefer ?? "below" });
  if (o.pin) pinPop(id);
  return id;
}

export const card = (id: string) => `.card[data-id="${id}"]`;
/** 代码区第 i 行（rows 的下标，不是行号） */
export const rowAt = (id: string, i: number) => `${card(id)} .src > .l[data-r="${i}"]`;
