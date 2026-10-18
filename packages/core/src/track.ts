// 宿主用：在另一个版本的文件里重新找到一段代码，并判断它和钉住的内容比起来变没变（「新版本」黄点）。
// 纯函数，读文件、跑 git 由宿主做。
import type { Segment, Version } from "./model";
import type { Stale } from "./protocol";
import { diffLines, findBlock, sameLines } from "./diff";

/** 宿主给的符号（只用到这几个字段；analysis 的 Sym 可以直接传进来） */
export type SymLoc = { qual: string; start: number; end: number };

export type Located = { start: number; end: number };

/**
 * 在 lines 里找这一段：函数卡 / 类卡按符号全名找（同名多个时取离原位置最近的），
 * 片段卡、模块顶部按内容找。找不到返回 null，按内容找到多处返回 "many"。
 */
export function locateSeg(seg: Pick<Segment, "symbol" | "text" | "start" | "end">, lines: string[], syms: SymLoc[]): Located | "many" | null {
  const sym = seg.symbol;
  if (sym && sym.kind !== "module") {
    const hits = syms.filter((s) => s.qual === sym.qual);
    if (!hits.length) return null;
    const best = hits.reduce((p, h) => (Math.abs(h.start - seg.start) < Math.abs(p.start - seg.start) ? h : p));
    return { start: best.start, end: best.end };
  }
  // 先看原位置是不是一字不差（最常见），再按内容找
  if (sameLines(lines.slice(seg.start - 1, seg.end), seg.text)) return { start: seg.start, end: seg.end };
  return findBlock(lines, seg.text, seg.start);
}

const inRanges = (rs: [number, number][] | undefined, l: number) => !!rs?.some(([a, b]) => a <= l && l <= b);

/**
 * 内容变了，变化是不是全在手动隐藏的行里：删掉 / 改掉的旧行都是隐藏行，
 * 新增的行夹在两条隐藏行之间（或贴着开头 / 结尾的隐藏行）。
 */
export function onlyHiddenChanged(oldText: string[], oldStart: number, newText: string[], hidden: [number, number][] | undefined): boolean {
  if (!hidden?.length) return false;
  const d = diffLines(oldText, newText, oldStart, 1);
  let prev: number | undefined;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    if (x.op === " ") { prev = x.a; continue; }
    if (x.op === "-") { if (!inRanges(hidden, x.a!)) return false; prev = x.a; continue; }
    // 新增：找后面第一条旧行
    let next: number | undefined;
    for (let k = i + 1; k < d.length; k++) if (d[k].a !== undefined) { next = d[k].a; break; }
    const ph = prev !== undefined && inRanges(hidden, prev), nh = next !== undefined && inRanges(hidden, next);
    if (!ph && !nh) return false;
  }
  return true;
}

/**
 * 一段代码在另一个版本（HEAD、装的新版本包、改过的文件）里的状态。
 * against = 拿来比的那个版本和它的显示名（短 commit / 包版本，放进 changed 里给白板显示）。
 * 只是挪了位置（moved）时段就钉到这个版本上：行号是哪个版本的，钉的就是哪个版本
 */
export function trackSeg(seg: Segment, lines: string[], syms: SymLoc[], against: { label: string; version: Version }): Stale & { at?: Located } {
  const loc = locateSeg(seg, lines, syms);
  if (loc === null) return { state: "lost" };
  if (loc === "many") return { state: "many" };
  const now = lines.slice(loc.start - 1, loc.end);
  if (sameLines(now, seg.text)) {
    if (loc.start === seg.start && loc.end === seg.end) return { state: "ok", at: loc };
    return { state: "moved", start: loc.start, end: loc.end, version: against.version, at: loc };
  }
  return { state: "changed", hiddenOnly: onlyHiddenChanged(seg.text, seg.start, now, seg.hidden), head: against.label, at: loc };
}

/** 卡片上的某一行在新版本里是第几行（按内容映射；这一行被删了就落在它前面最近一条还在的行上） */
export function mapLineTo(seg: Pick<Segment, "text" | "start">, line: number, now: string[], nowStart: number): number {
  if (sameLines(seg.text, now)) return line - seg.start + nowStart;
  let best = nowStart;
  for (const x of diffLines(seg.text, now, seg.start, nowStart)) {
    if (x.a === undefined || x.op !== " ") continue;
    if (x.a > line) break;
    best = x.b!;
  }
  return best;
}
