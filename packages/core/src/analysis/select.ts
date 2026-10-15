// 编辑器选区 → 建什么卡（03 E 的边界情况）。
import { BLANK, symbolAt, type FileAnalysis, type Sym } from "./index";

export type Sel = { startLine: number; startCol: number; endLine: number; endCol: number }; // 1-based 行，0-based 列

export type Range = { start: number; end: number; scope?: string; module?: boolean };

export type Plan =
  | { kind: "function"; sym: Sym } // 函数卡（覆盖某函数 ≥ 90%，或光标所在函数）
  | { kind: "class"; sym: Sym; members?: string[] } // 类卡；members = 只显示选中的方法
  | { kind: "split"; syms: Sym[]; range: Range } // 选中 ≥ 2 个完整函数：问一次 Split / Merge / Keep
  | { kind: "segments"; ranges: Range[] }; // 片段卡（一段或多段）

export const UPGRADE = 0.9;

/** 一个选区收成整行：停在下一行行首的不算那一行；首尾空行去掉 */
export function normalize(sel: Sel, a: FileAnalysis): { start: number; end: number } | null {
  let start = sel.startLine, end = sel.endLine;
  if (end > start && sel.endCol === 0) end--;
  while (start <= end && (a.flags[start - 1] ?? BLANK) & BLANK) start++;
  while (end >= start && (a.flags[end - 1] ?? BLANK) & BLANK) end--;
  return start <= end ? { start, end } : null;
}

function rangeOf(r: { start: number; end: number }, a: FileAnalysis): Range {
  const s = symbolAt(a.symbols, r.start);
  // 前一个函数的尾 + 后一个的头：scope 取开头所在的函数（段内画函数边界线）
  if (s) return { ...r, scope: s.qual };
  const e = symbolAt(a.symbols, r.end);
  if (e && e.start > r.start) return { ...r, scope: e.qual };
  return { ...r, module: true };
}

/** 选区里完整包含的、最外层的符号 */
function completeIn(a: FileAnalysis, start: number, end: number): Sym[] {
  const inside = a.symbols.filter((s) => s.start >= start && s.end <= end);
  return inside.filter((s) => !inside.some((o) => o !== s && o.start <= s.start && o.end >= s.end && (o.start < s.start || o.end > s.end)));
}

export function planSelection(sels: Sel[], a: FileAnalysis): Plan | null {
  const rs = sels.map((s) => normalize(s, a)).filter((r): r is { start: number; end: number } => !!r).sort((x, y) => x.start - y.start);
  if (!rs.length) return null;
  if (rs.length > 1) {
    // 编辑器多选区 → 一张多段卡；重叠的合成一段
    const merged: { start: number; end: number }[] = [];
    for (const r of rs) {
      const p = merged[merged.length - 1];
      if (p && r.start <= p.end + 1) p.end = Math.max(p.end, r.end); else merged.push({ ...r });
    }
    return { kind: "segments", ranges: merged.map((r) => rangeOf(r, a)) };
  }
  const { start, end } = rs[0];
  const size = end - start + 1;
  // 覆盖某个符号 ≥ 90% 且不超出 → 升级（装饰器一起带上）
  const inner = a.symbols.filter((s) => s.start <= start && end <= s.end).sort((x, y) => x.end - x.start - (y.end - y.start))[0];
  if (inner && size / (inner.end - inner.start + 1) >= UPGRADE) return inner.kind === "class" ? { kind: "class", sym: inner } : { kind: "function", sym: inner };
  const complete = completeIn(a, start, end);
  if (complete.length === 1 && (complete[0].end - complete[0].start + 1) / size >= UPGRADE)
    return complete[0].kind === "class" ? { kind: "class", sym: complete[0] } : { kind: "function", sym: complete[0] };
  if (complete.length >= 2) {
    const parents = new Set(complete.map((s) => s.parent));
    const cls = complete[0].parent && parents.size === 1 ? a.symbols.find((s) => s.qual === complete[0].parent && s.kind === "class") : undefined;
    if (cls) return { kind: "class", sym: cls, members: complete.map((s) => s.qual) };
    return { kind: "split", syms: complete, range: rangeOf({ start, end }, a) };
  }
  return { kind: "segments", ranges: [rangeOf({ start, end }, a)] };
}

/** 光标所在的函数（或类）：Add Function at Cursor */
export function symbolAtCursor(a: FileAnalysis, line: number): Sym | undefined {
  return symbolAt(a.symbols, line, "def") ?? symbolAt(a.symbols, line, "class");
}

/** 类的成员方法（直接子级） */
export const membersOf = (a: FileAnalysis, cls: Sym) => a.symbols.filter((s) => s.parent === cls.qual && s.kind === "def");
