export type DiffLine = { op: " " | "+" | "-"; text: string; a?: number; b?: number };

/** 行级 LCS diff；a、b 是行号（1-based，相对各自起点） */
export function diffLines(a: string[], b: string[], aStart = 1, bStart = 1): DiffLine[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ op: " ", text: a[i], a: aStart + i, b: bStart + j }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ op: "+", text: b[j], b: bStart + j }); j++; }
    else { out.push({ op: "-", text: a[i], a: aStart + i }); i++; }
  }
  return out;
}

/** 把旧片段里的行号映射到新片段：内容相同就跟过去，否则找最近的保留行 */
export function mapLine(diff: DiffLine[], oldLine: number): number | undefined {
  const hit = diff.find((d) => d.op === " " && d.a === oldLine);
  if (hit) return hit.b;
  let best: number | undefined;
  for (const d of diff) {
    if (d.a !== undefined && d.a > oldLine) break;
    if (d.op === " ") best = d.b;
  }
  return best;
}
