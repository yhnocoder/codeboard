// Split by Headings：Note 按标题拆成几张卡。只认行首的 ATX 标题（# …），代码块、$$ 公式块里的不算。
// 规则：第一个标题是第 L 级，级别 ≤ L+1 的标题各开一张卡（比 L 浅的也开），更深的留在所在的卡里；第一个标题前的字留在原卡。
// 拆的改动本身（放卡、连箭头、改原卡）在 edit.ts 的 splitNoteByHeadings
import { overlaps, type Rect } from "./layout";

/** 拆出来的一段：标题行连同下面的内容（到下一个要拆的标题为止）；parent = 上一级那段的下标，-1 = 原卡 */
export type HeadingPart = { level: number; title: string; md: string; parent: number };
export type HeadingSplit = { pre: string; parts: HeadingPart[]; cut: number };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** 按标题拆开 md；没有可拆的标题（或拆了只剩原卡本身）返回 null */
export function splitHeadings(md: string): HeadingSplit | null {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const heads: { line: number; level: number; title: string }[] = [];
  let fence = "", math = false;
  lines.forEach((l, i) => {
    if (fence) { if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(l)) fence = ""; return; }
    const f = FENCE.exec(l);
    if (f) { fence = f[1]; return; }
    if (l.trim() === "$$") { math = !math; return; }
    if (math) return;
    const m = HEADING.exec(l);
    if (m) heads.push({ line: i, level: m[1].length, title: (m[2] ?? "").trim() });
  });
  if (!heads.length) return null;
  const cut = heads[0].level + 1;
  const split = heads.filter((h) => h.level <= cut);
  const text = (a: number, e: number) => lines.slice(a, e).join("\n").replace(/^\s*\n|\s+$/g, "");
  const parts: HeadingPart[] = [];
  const stack: number[] = [];
  split.forEach((h, k) => {
    while (stack.length && parts[stack[stack.length - 1]].level >= h.level) stack.pop();
    parts.push({ level: h.level, title: h.title, md: text(h.line, split[k + 1]?.line ?? lines.length), parent: stack.length ? stack[stack.length - 1] : -1 });
    stack.push(k);
  });
  const pre = text(0, split[0].line);
  // 第一个标题前没有字：原卡留着第一段（不然原卡空了），它下面的段直接挂在原卡上
  if (!pre) {
    const first = parts.shift()!;
    for (const p of parts) p.parent = p.parent === 0 ? -1 : p.parent - 1;
    return parts.length ? { pre: first.md, parts, cut } : null;
  }
  return { pre, parts, cut };
}

/**
 * 拆出来的卡怎么摆（向下的树）：子卡在父卡下面排成一行、父卡居中，同一层的卡顶端对齐（行高取这层最高的）；原卡 root 不动。
 * 每张卡都和原卡一样宽。others = 别的卡：碰上了就把拆出来的卡整体往下挪到不碰为止（挪太远就不挪了）。返回每段的左上角
 */
export function headingTree(root: Rect, parts: { h: number; parent: number }[], others: Rect[] = [], o: { gx?: number; gy?: number } = {}): { x: number; y: number }[] {
  const gx = o.gx ?? 28, gy = o.gy ?? 56, W = root.w;
  const kids = (i: number) => parts.flatMap((p, k) => (p.parent === i ? [k] : []));
  const hOf = (i: number) => (i < 0 ? root.h : parts[i].h);
  const rowH: number[] = [];
  const depth = new Map<number, number>();
  const walk = (i: number, d: number) => { depth.set(i, d); rowH[d] = Math.max(rowH[d] ?? 0, hOf(i)); for (const k of kids(i)) walk(k, d + 1); };
  walk(-1, 0);
  const rowY = [0];
  for (let d = 1; d < rowH.length; d++) rowY[d] = rowY[d - 1] + rowH[d - 1] + gy;
  const widths = new Map<number, number>();
  const wid = (i: number): number => {
    let w = widths.get(i);
    if (w === undefined) { const ks = kids(i); w = Math.max(W, ks.reduce((s, k) => s + wid(k), 0) + gx * Math.max(0, ks.length - 1)); widths.set(i, w); }
    return w;
  };
  const xs = new Map<number, number>();
  const put = (i: number, left: number) => {
    const w = wid(i), ks = kids(i);
    xs.set(i, left + (w - W) / 2);
    const span = ks.reduce((s, k) => s + wid(k), 0) + gx * Math.max(0, ks.length - 1);
    let x = left + (w - span) / 2;
    for (const k of ks) { put(k, x); x += wid(k) + gx; }
  };
  put(-1, 0);
  const dx = root.x - xs.get(-1)!;
  const at = parts.map((_, k) => ({ x: Math.round(xs.get(k)! + dx), y: Math.round(root.y + rowY[depth.get(k)!]) }));
  // 不和别的卡叠在一起：整体往下挪（一张张卡挪会打乱树形）
  let dy = 0;
  for (let i = 0; i < 100; i++) {
    const hit = others.filter((r) => at.some((p, k) => overlaps({ x: p.x, y: p.y + dy, w: W, h: parts[k].h }, r, 12)));
    if (!hit.length) return at.map((p) => ({ x: p.x, y: p.y + dy }));
    dy = Math.max(dy + 1, ...hit.map((r) => r.y + r.h + gy - Math.min(...at.map((p) => p.y))));
    if (dy > 4000) break;
  }
  return at;
}
