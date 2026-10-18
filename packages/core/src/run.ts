// 运行记录（线框 13 三）：「指定一个入口跑一次，只抓 Study Scope 里的调用」的结果。宿主写进 <存储目录>/runs/<id>.json，
// 再拿它给白板上已有的 Call 箭头挂上 observed 证据和实参；对不上箭头的调用列出来让人挑着建。
//
// 一次调用 = 运行时从 from（调用方的文件:行）进入了 to（被调函数：文件 + def 那一行 + qualname）。同一对 from → to 合成一条，
// count = 次数，samples = 前几次 + 最后一次的实参（tensor 只记 shape / dtype / device，标量记 repr 截短）。
//
// 文件格式（version 1，JSON）：
// {
//   "version": 1, "id": "r…", "entry": "python -m toyllm.run --steps 2",  // 用户给的命令
//   "cwd": "/abs/workspace", "commit": "9f3e2a1…" | null,                  // 跑的时候工作区的 HEAD
//   "at": 1760000000000, "ms": 412, "exit": 0,                            // 开始时间、耗时、退出码
//   "scope": ["/abs/workspace"], "pkgs": ["vllm"],                       // 算 Study Scope 的根目录、包名
//   "calls": [{ "from": { "file": "/abs/a.py", "line": 52 },
//               "to": { "file": "/abs/b.py", "line": 30, "qual": "Scheduler.schedule" },
//               "count": 64, "samples": [{ "n": 1, "args": [["seqs", "list · len 4"], ["is_prefill", "False"]] }] }],
//   "truncated": false                                                   // 不同的调用对太多，后面的丢了
// }
// 纯函数，白板和宿主都用。
import * as v from "valibot";
import { sameSource, type Board, type CallSample, type CodeCard, type Link, type Source } from "./model";

export type RunSite = { file: string; line: number };
export type RunDef = { file: string; line: number; qual: string };
export type RunCall = { from: RunSite; to: RunDef; count: number; samples: CallSample[] };
export type RunRecord = {
  version: 1; id: string; entry: string; cwd: string; commit: string | null;
  at: number; ms: number; exit: number; scope: string[]; pkgs: string[]; calls: RunCall[]; truncated?: boolean;
};

const str = v.string(), num = v.number();
const Sample = v.looseObject({ n: num, args: v.array(v.tuple([str, str])) });
export const RunRecordSchema = v.looseObject({
  version: v.literal(1), id: str, entry: str, cwd: str, commit: v.nullable(str),
  at: num, ms: num, exit: num, scope: v.array(str), pkgs: v.array(str),
  calls: v.array(v.looseObject({
    from: v.looseObject({ file: str, line: num }),
    to: v.looseObject({ file: str, line: num, qual: str }),
    count: num, samples: v.array(Sample),
  })),
  truncated: v.nullish(v.boolean()),
});

/** 读进来的运行记录 → 校验过的；不对抛出 */
export function loadRun(raw: unknown): RunRecord {
  const r = v.safeParse(RunRecordSchema, raw);
  if (!r.success) throw new Error(`Invalid run record: ${r.issues.slice(0, 2).map((i) => `${v.getDotPath(i) ?? "(root)"}: ${i.message}`).join("; ")}`);
  return r.output as RunRecord;
}

/** 运行记录里的绝对路径在白板上是哪个来源的哪个文件（宿主按 locOfFile 算好发给白板）；hp = 宿主的显示路径（建卡时用） */
export type RunLoc = { src: Source; path: string; hp: string };
/** 发给白板的一次运行：记录 + 路径 → 位置 */
export type RunApply = { run: RunRecord; locs: Record<string, RunLoc> };

/** 代码卡里含 (loc, line) 的段 */
function segAt(c: CodeCard, loc: RunLoc, line: number) {
  return c.segments.find((s) => s.src.kind !== "free" && s.path === loc.path && sameSource(s.src, loc.src) && s.start <= line && line <= s.end);
}

/** 箭头的终点卡是不是这次调用的被调函数：同一个文件里、def 那一行在段里；有符号时 qualname 也要对（__init__ 也认类卡） */
function calleeIs(c: CodeCard, loc: RunLoc, to: RunDef): boolean {
  const s = segAt(c, loc, to.line);
  if (!s) return false;
  const q = s.symbol?.qual;
  if (!q || s.symbol!.kind === "module") return true;
  return q === to.qual || to.qual.startsWith(`${q}.`) || (to.qual.endsWith(".__init__") && to.qual.slice(0, -9) === q);
}

export type RunMatch = { hits: { link: string; call: number }[]; misses: number[]; callers: Record<number, { card: string; seg: string }> };

/**
 * 运行记录对白板：哪条 Call 箭头是哪次调用（出发行 = 调用行，终点卡 = 被调函数），哪些调用白板上没有箭头。
 * callers：没有箭头的调用里，调用方那一行在白板上哪张卡里（建卡时从那一行连过去）
 */
export function matchRun(b: Pick<Board, "cards" | "links">, a: RunApply): RunMatch {
  const byId = new Map(b.cards.map((c) => [c.id, c]));
  const hits: RunMatch["hits"] = [];
  const used = new Set<number>();
  for (const l of b.links) {
    if (!l.call || l.from.line === undefined) continue;
    const f = byId.get(l.from.card), t = byId.get(l.to.card);
    if (f?.kind !== "code" || t?.kind !== "code") continue;
    const fs = f.segments.find((s) => s.id === l.from.seg);
    if (!fs || fs.src.kind === "free") continue;
    a.run.calls.forEach((c, i) => {
      const fl = a.locs[c.from.file], tl = a.locs[c.to.file];
      if (!fl || !tl || c.from.line !== l.from.line || fl.path !== fs.path || !sameSource(fl.src, fs.src)) return;
      if (!calleeIs(t, tl, c.to)) return;
      hits.push({ link: l.id, call: i });
      used.add(i);
    });
  }
  const misses: number[] = [];
  const callers: RunMatch["callers"] = {};
  a.run.calls.forEach((c, i) => {
    if (used.has(i)) return;
    misses.push(i);
    const fl = a.locs[c.from.file];
    if (!fl) return;
    for (const k of b.cards) {
      if (k.kind !== "code") continue;
      const s = segAt(k, fl, c.from.line);
      if (s) { callers[i] = { card: k.id, seg: s.id }; break; }
    }
  });
  return { hits, misses, callers };
}

/**
 * 把一次运行挂到对上的箭头上（直接改 b）：证据变成 observed（原来是手标的记在 base），带上命令、次数、时间、commit 和实参。
 * 一条箭头对上几次调用（同一行调了好几回）：次数相加，实参接在一起。返回改了几条
 */
export function applyRun(b: Pick<Board, "links">, a: RunApply, m: RunMatch): number {
  const byLink = new Map<string, number[]>();
  for (const h of m.hits) byLink.set(h.link, [...(byLink.get(h.link) ?? []), h.call]);
  let n = 0;
  for (const l of b.links) {
    const cs = byLink.get(l.id);
    if (!cs || !l.call) continue;
    const calls = cs.map((i) => a.run.calls[i]);
    const old = l.call.ev;
    const ev: NonNullable<NonNullable<Link["call"]>["ev"]> = {
      kind: "observed", cmd: a.run.entry, at: a.run.at, count: calls.reduce((s, c) => s + c.count, 0), run: a.run.id,
    };
    if (a.run.commit) ev.commit = a.run.commit;
    if (old?.kind === "manual" || old?.base === "manual") ev.base = "manual";
    if (old?.via) ev.via = old.via;
    l.call.ev = ev;
    const seen = calls.flatMap((c) => c.samples);
    if (seen.length) l.call.seen = seen; else delete l.call.seen;
    n++;
  }
  return n;
}
