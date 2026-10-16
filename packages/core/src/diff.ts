// 行级 / 词级 diff，Compare 卡和「新版本」diff 窗共用的对齐算法，以及按内容迁移行号。
import { diffArrays } from "diff";

export type DiffLine = { op: " " | "+" | "-"; text: string; a?: number; b?: number };

/** 行级 diff；a、b 是行号（相对各自起点） */
export function diffLines(a: string[], b: string[], aStart = 1, bStart = 1): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  for (const op of ops(a, b)) {
    if (op === "-") out.push({ op, text: a[i], a: aStart + i++ });
    else if (op === "+") out.push({ op, text: b[j], b: bStart + j++ });
    else out.push({ op, text: a[i], a: aStart + i++, b: bStart + j++ });
  }
  return out;
}

type Op = DiffLine["op"];
/** 改动超过这么多行就不再找最短编辑（Myers 是 O((n+m)·D)），改用两边各只出现一次的行做锚点分段 */
const MAX_EDIT = 1000;

/** 剥掉头尾后不超过这么多格（n·m）就用 LCS 表（16 MB 以内） */
const MAX_TABLE = 1 << 22;

/**
 * 先剥掉相同的头尾：长文件也快，而且新增的整段贴在共同的尾巴前面。
 * 中间部分小的用 LCS 表，大的用 jsdiff 的 Myers（时间 / 内存随改动量增长，不是 n·m）。
 * 小的不用 Myers：等长的公共子序列有多种取法时，Myers 和这里取得不一样（Compare 的行对齐、词级高亮会变），
 * 这里的取法是「能删就先删」，界面一直是这样。
 */
function ops(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const out: Op[] = Array(pre).fill(" ");
  if (A.length * B.length <= MAX_TABLE) out.push(...table(A, B));
  else {
    const cs = diffArrays(A, B, { maxEditLength: MAX_EDIT });
    if (cs) for (const c of cs) for (let k = 0; k < c.count; k++) out.push(c.removed ? "-" : c.added ? "+" : " ");
    else out.push(...anchored(A, B));
  }
  for (let k = 0; k < suf; k++) out.push(" ");
  return out;
}

/** LCS 表：从后往前填，从前往后走；不相等时能删（不丢公共行）就先删 */
function table(A: string[], B: string[]): Op[] {
  const n = A.length, m = B.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: Op[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push(" "); i++; j++; }
    else if (i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) { out.push("-"); i++; }
    else { out.push("+"); j++; }
  }
  return out;
}

/** 两段差得太多：两边都只出现一次的行按顺序（最长递增）当锚点，锚点之间再分别 diff；没有锚点就整段删 + 整段加 */
function anchored(a: string[], b: string[]): Op[] {
  const seen = new Map<string, { na: number; nb: number; ia: number; ib: number }>();
  a.forEach((l, i) => { const e = seen.get(l); if (e) e.na++; else seen.set(l, { na: 1, nb: 0, ia: i, ib: -1 }); });
  b.forEach((l, j) => { const e = seen.get(l); if (e) { e.nb++; e.ib = j; } });
  const cand = [...seen.values()].filter((e) => e.na === 1 && e.nb === 1).sort((x, y) => x.ia - y.ia);
  // b 下标的最长递增子序列（耐心排序）
  const tails: number[] = [], prev: number[] = [];
  cand.forEach((e, k) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cand[tails[mid]].ib < e.ib) lo = mid + 1; else hi = mid; }
    prev[k] = lo ? tails[lo - 1] : -1; tails[lo] = k;
  });
  const anchors: { ia: number; ib: number }[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) anchors.unshift(cand[k]);
  if (!anchors.length) return [...Array(a.length).fill("-"), ...Array(b.length).fill("+")];
  const out: Op[] = [];
  let i = 0, j = 0;
  for (const x of [...anchors, { ia: a.length, ib: b.length }]) {
    out.push(...ops(a.slice(i, x.ia), b.slice(j, x.ib)));
    if (x.ia < a.length) out.push(" ");
    i = x.ia + 1; j = x.ib + 1;
  }
  return out;
}

/** 两栏对齐的一行：same = 两边相同；changed = 两边都有但不同；left / right = 只有一边有 */
export type AlignRow = { kind: "same" | "changed" | "left" | "right"; l?: number; r?: number };

/**
 * 两段代码并排对齐：相同的行放在同一水平线上；连续的删除和增加两两配成 changed，
 * 多出来的只在一边（另一边留斜纹空位）。l / r 是下标（0-based）。
 */
export function alignRows(a: string[], b: string[]): AlignRow[] {
  const d = diffLines(a, b, 0, 0);
  const rows: AlignRow[] = [];
  let k = 0;
  while (k < d.length) {
    if (d[k].op === " ") { rows.push({ kind: "same", l: d[k].a, r: d[k].b }); k++; continue; }
    const dels: number[] = [], adds: number[] = [];
    while (k < d.length && d[k].op !== " ") {
      if (d[k].op === "-") dels.push(d[k].a!);
      else adds.push(d[k].b!);
      k++;
    }
    // 按顺序配对：先找相似的行对齐（单调，不交叉），中间夹着的按位置并排；
    // 只剩一边的才留斜纹空位。两段完全不同时也是逐行并排，不会一行一个空位。
    let i = 0, j = 0;
    const side = (ie: number, je: number) => {
      while (i < ie && j < je) rows.push({ kind: "changed", l: dels[i++], r: adds[j++] });
      while (i < ie) rows.push({ kind: "left", l: dels[i++] });
      while (j < je) rows.push({ kind: "right", r: adds[j++] });
    };
    for (let p = 0; p < dels.length; p++) {
      if (p < i) continue;
      let q = -1;
      for (let t = j; t < Math.min(adds.length, j + 12); t++) if (similar(a[dels[p]], b[adds[t]])) { q = t; break; }
      if (q < 0) continue;
      side(p, q);
      rows.push({ kind: "changed", l: dels[i++], r: adds[j++] });
    }
    side(dels.length, adds.length);
  }
  return rows;
}

function similar(x: string, y: string) {
  const tx = new Set(tokens(x).filter((t) => /\w/.test(t))), ty = tokens(y).filter((t) => /\w/.test(t));
  if (!tx.size || !ty.length) return x.trim() === "" && y.trim() === "" ? true : false;
  const common = ty.filter((t) => tx.has(t)).length;
  return common / Math.max(tx.size, ty.length) >= 0.34;
}

const tokens = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

/** 词级 diff：返回两边各自变了的字符区间 [start, end) */
export function wordDiff(x: string, y: string): { a: [number, number][]; b: [number, number][] } {
  const tx = tokens(x), ty = tokens(y);
  const d = diffLines(tx, ty, 0, 0);
  const pos = (ts: string[]) => { const p = [0]; for (const t of ts) p.push(p[p.length - 1] + t.length); return p; };
  const px = pos(tx), py = pos(ty);
  const a: [number, number][] = [], b: [number, number][] = [];
  const push = (arr: [number, number][], s: number, e: number) => {
    const last = arr[arr.length - 1];
    if (last && last[1] === s) last[1] = e; else arr.push([s, e]);
  };
  for (const l of d) {
    if (l.op === "-") push(a, px[l.a!], px[l.a! + 1]);
    else if (l.op === "+") push(b, py[l.b!], py[l.b! + 1]);
  }
  return { a, b };
}

/**
 * 按内容把旧代码的行号映射到新代码：内容相同（LCS 对上）就跟过去，对不上返回 undefined（行被删了 / 改了）。
 * fuzzy = true 时，改过的行如果和新代码里正好一行配对（Compare 里的 changed），也跟过去。
 */
export function mapLines(oldText: string[], oldStart: number, newText: string[], newStart: number, fuzzy = true): Map<number, number> {
  const map = new Map<number, number>();
  if (fuzzy) {
    for (const r of alignRows(oldText, newText)) if (r.l !== undefined && r.r !== undefined) map.set(oldStart + r.l, newStart + r.r);
  } else {
    for (const d of diffLines(oldText, newText, oldStart, newStart)) if (d.op === " ") map.set(d.a!, d.b!);
  }
  return map;
}

/** 在 lines 里按内容找一段：先找完全一样的整段，再按首行 + 末行找 */
export function findBlock(lines: string[], block: string[], near?: number): { start: number; end: number } | "many" | null {
  if (!block.length) return null;
  const hits: number[] = [];
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let k = 0; k < block.length; k++) if (lines[i + k] !== block[k]) continue outer;
    hits.push(i);
  }
  const pick = (hs: number[]) => (near === undefined ? hs[0] : hs.reduce((p, h) => (Math.abs(h + 1 - near) < Math.abs(p + 1 - near) ? h : p)));
  if (hits.length === 1 || (hits.length > 1 && near !== undefined)) { const i = pick(hits); return { start: i + 1, end: i + block.length }; }
  if (hits.length > 1) return "many";
  // 首末行定位（中间改了）
  const first = block[0], last = block[block.length - 1];
  if (!first.trim() || !last.trim()) return null;
  const firsts = lines.map((l, i) => (l === first ? i : -1)).filter((i) => i >= 0);
  const cands: { s: number; e: number }[] = [];
  for (const s of firsts) {
    for (let e = s; e < Math.min(lines.length, s + block.length * 3 + 20); e++) if (lines[e] === last && e >= s) { cands.push({ s, e }); break; }
  }
  if (cands.length === 1) return { start: cands[0].s + 1, end: cands[0].e + 1 };
  if (cands.length > 1) return "many";
  return null;
}

export const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** 简单内容指纹（FNV-1a 64 位的十六进制），宿主用它判断仓库外文件变没变 */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
