import type { CodeCard, Sync } from "./model";
import { diffLines, mapLine } from "./diff";
import type { Sym } from "./symbols";

/**
 * 卡片快照和工作区当前文件比较：一致、只是位置变了、内容变了、找不到了。
 * current 是文件当前的所有行；syms 是当前文件的符号（按符号同步时用）。
 */
export function computeSync(card: Pick<CodeCard, "start" | "end" | "snapshot" | "symbol">, current: string[] | undefined, syms: Sym[]): Sync {
  if (!current) return { state: "unknown" };
  const old = card.snapshot;
  let start: number | undefined, end: number | undefined;

  // 1. 原位置内容没变
  if (same(current.slice(card.start - 1, card.end), old)) return { state: "ok" };
  // 2. 按符号找
  if (card.symbol) {
    const s = syms.find((x) => x.qual === card.symbol);
    if (s) { start = s.start; end = s.end; }
  }
  // 3. 按内容找（整段原样出现）
  if (start === undefined) {
    const at = findBlock(current, old);
    if (at >= 0) { start = at + 1; end = at + old.length; }
  }
  if (start === undefined || end === undefined) {
    if (card.symbol) return { state: "lost" };
    // 片段卡片找不到原文时，按原行号比较，提示内容变了
    start = card.start;
    end = Math.min(card.end, current.length);
    if (start > current.length) return { state: "lost" };
  }
  const now = current.slice(start - 1, end);
  if (same(now, old)) return { state: "moved", start, end };
  const d = diffLines(old, now);
  return { state: "changed", start, end, added: d.filter((l) => l.op === "+").length, removed: d.filter((l) => l.op === "-").length };
}

/** 跟进到新版本时，旧行号到新行号的映射（用于高亮行和箭头起点） */
export function followMap(card: Pick<CodeCard, "start" | "snapshot">, current: string[], start: number, end: number): Record<number, number> {
  const d = diffLines(card.snapshot, current.slice(start - 1, end), card.start, start);
  const map: Record<number, number> = {};
  for (let i = 0; i < card.snapshot.length; i++) {
    const n = mapLine(d, card.start + i);
    if (n !== undefined) map[card.start + i] = n;
  }
  return map;
}

function same(a: string[], b: string[]) {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
function findBlock(lines: string[], block: string[]) {
  if (!block.length) return -1;
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let k = 0; k < block.length; k++) if (lines[i + k] !== block[k]) continue outer;
    return i;
  }
  return -1;
}
