// 行级 / 词级 diff，Compare 卡和「新版本」diff 窗共用的对齐算法，以及按内容迁移行号。

export type DiffLine = { op: " " | "+" | "-"; text: string; a?: number; b?: number };

/** 行级 LCS diff；a、b 是行号（相对各自起点） */
export function diffLines(a: string[], b: string[], aStart = 1, bStart = 1): DiffLine[] {
  // 先剥掉相同的头尾，长文件也快
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  for (let k = 0; k < pre; k++) out.push({ op: " ", text: a[k], a: aStart + k, b: bStart + k });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push({ op: " ", text: A[i], a: aStart + pre + i, b: bStart + pre + j }); i++; j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { out.push({ op: "-", text: A[i], a: aStart + pre + i }); i++; }
    else { out.push({ op: "+", text: B[j], b: bStart + pre + j }); j++; }
  }
  for (let k = 0; k < suf; k++) out.push({ op: " ", text: a[a.length - suf + k], a: aStart + a.length - suf + k, b: bStart + b.length - suf + k });
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
    // 相似的行配对（同一缩进、共有词多），配不上的单独放
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const l = dels[i], r = adds[i];
      if (l !== undefined && r !== undefined && similar(a[l], b[r])) rows.push({ kind: "changed", l, r });
      else {
        if (l !== undefined) rows.push({ kind: "left", l });
        if (r !== undefined) rows.push({ kind: "right", r });
      }
    }
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
