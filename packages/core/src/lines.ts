// 代码卡的「行」：哪些行显示、哪里画省略条 / 函数边界线 / 文件分隔条。
// 白板按它渲染，Link 端点、Sidenote 标记按它找位置。
import type { CodeCard, HideFlags, Segment } from "./model";

export const F_BLANK = 1, F_COMMENT = 2, F_DOCSTRING = 4;

/** 宿主为每一段算好的展示数据（不持久化） */
export type SegView = {
  html: string[]; // 每行高亮后的 HTML（和 seg.text 一一对应）
  bare?: Record<number, string>; // 去掉行尾注释后的 HTML（Hide Comments 时用），键是行号
  flags: number[]; // 每行 F_BLANK / F_COMMENT / F_DOCSTRING
  calls: CallSpan[]; // 可以点开的调用
  defs: { line: number; name: string; qual: string }[]; // 段里开始的函数（画函数边界线）
};
/** pkg = 调用绑到的 library 包（工作区外）；在 Study Scope 里的包白板照 project 处理 */
export type CallSpan = { line: number; col: number; end: number; name: string; recv?: string; loop: boolean; dispatch?: string; pkg?: string };

export type Row =
  | { t: "line"; seg: string; line: number; skipped: boolean } // skipped = 上面有被开关藏掉的行（行号栏画虚线）
  | { t: "gap"; seg: string; from: number; to: number; manual: boolean } // 「⋯ N lines hidden (a–b)」；manual = 手动隐藏的（可 Show）
  | { t: "fn"; seg: string; name: string } // 同一文件换了函数：细线 + 函数名
  | { t: "file"; seg: string; path: string; version?: string }; // 换了文件

export type RowOpts = {
  hide?: HideFlags;
  hideAllComments?: boolean;
  shown?: Set<string>; // 临时展开的手动隐藏范围：`${seg}:${from}`
  views?: Record<string, SegView | undefined>; // 段 id → 展示数据
  versionOf?: (s: Segment) => string | undefined; // 和其他段版本不同时，文件条上显示
};

const inRanges = (rs: [number, number][] | undefined, l: number) => rs?.find(([a, b]) => a <= l && l <= b);

/** 一张代码卡要渲染的行 */
export function cardRows(c: Pick<CodeCard, "segments" | "hide">, o: RowOpts = {}): Row[] {
  const rows: Row[] = [];
  const hide = { ...c.hide, comments: c.hide?.comments || o.hideAllComments };
  c.segments.forEach((s, si) => {
    const prev = c.segments[si - 1];
    const v = o.views?.[s.id];
    if (prev) {
      if (prev.path !== s.path || prev.src.kind !== s.src.kind) rows.push({ t: "file", seg: s.id, path: s.src.kind === "free" ? "Free code" : s.path, version: o.versionOf?.(s) });
      else if (s.scope && prev.scope !== s.scope && !v?.defs.some((d) => d.line === s.start)) rows.push({ t: "fn", seg: s.id, name: shortFn(s.scope) });
      // 段与段之间总要看得出边界：中间隔着行 → 「⋯ N lines」；紧挨着、新段从一个定义开始 → 细线 + 定义名（同段里换函数也是这样）
      else if (s.start > prev.end + 1) rows.push({ t: "gap", seg: s.id, from: prev.end + 1, to: s.start - 1, manual: false });
      else {
        let dl = s.start;
        while (dl < s.end && /^\s*@/.test(s.text[dl - s.start] ?? "")) dl++;
        const d = v?.defs.find((x) => x.line === dl);
        if (d) rows.push({ t: "fn", seg: s.id, name: d.name });
      }
    }
    let skipped = false;
    let l = s.start;
    while (l <= s.end) {
      const r = inRanges(s.hidden, l);
      if (r && !o.shown?.has(`${s.id}:${r[0]}`)) {
        rows.push({ t: "gap", seg: s.id, from: Math.max(r[0], l), to: Math.min(r[1], s.end), manual: true });
        l = Math.min(r[1], s.end) + 1;
        skipped = false;
        continue;
      }
      const f = v?.flags[l - s.start] ?? 0;
      const off = (hide.blank && f & F_BLANK) || (hide.comments && f & F_COMMENT) || (hide.docstrings && f & F_DOCSTRING);
      if (off) { skipped = true; l++; continue; }
      // 装饰器是定义的一部分：线画在装饰器上面，不画在装饰器和 def 之间
      const isDec = (k: number) => /^\s*@/.test(s.text[k - s.start] ?? "");
      let dl = l;
      while (dl < s.end && isDec(dl)) dl++;
      const d = l > s.start && !isDec(l - 1) ? v?.defs.find((x) => x.line === dl) : undefined;
      if (d && rows.length && rows[rows.length - 1].t === "line") rows.push({ t: "fn", seg: s.id, name: d.name });
      rows.push({ t: "line", seg: s.id, line: l, skipped });
      skipped = false;
      l++;
    }
  });
  return rows;
}

const shortFn = (q: string) => `def ${q.split(".").pop()}`;

const unesc = (h: string) => h.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/**
 * 一行显示出来的文字（tab 展开成 4 格）：Hide Comments 时去掉行尾注释（和渲染用的 bare 一样长）。
 * Fit Content 按它量宽，所以藏掉的东西不算
 */
export function shownText(s: Pick<Segment, "start" | "text">, line: number, v: SegView | undefined, hideComments?: boolean): string {
  let t = s.text[line - s.start] ?? "";
  const bare = hideComments ? v?.bare?.[line] : undefined;
  if (bare !== undefined) t = t.slice(0, unesc(bare).length);
  return t.replace(/\t/g, "    ");
}
/** 所有非空行共有的缩进（不到 2 格算 0）：缩得很深的片段把它藏起来，代码靠左 */
export function commonIndent(texts: Iterable<string>): number {
  let m = Infinity;
  for (const t of texts) {
    if (!t.trim()) continue;
    m = Math.min(m, t.length - t.trimStart().length);
    if (m < 2) return 0;
  }
  return m === Infinity ? 0 : m;
}

/**
 * 一行在渲染结果里落在哪一行：显示着就是它自己；被手动隐藏就落在省略条上；
 * 被开关藏掉就落在下一条可见行（没有就上一条）。
 */
export function rowIndexOf(rows: Row[], seg: string, line: number): number {
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.seg !== seg) continue;
    if (r.t === "line" && r.line === line) return i;
    if (r.t === "gap" && r.from <= line && line <= r.to) return i;
    if (r.t === "line" && r.line > line && best < 0) best = i;
  }
  if (best >= 0) return best;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].seg === seg && rows[i].t === "line") return i;
  return rows.findIndex((r) => r.t === "line");
}

/** 复制选中的行：只要代码文本，保留相对缩进（去掉公共缩进） */
export function copyText(lines: string[]): string {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => (Number.isFinite(ind) ? l.slice(Math.min(ind, l.length - l.trimStart().length)) : l)).join("\n");
}

/** 合并卡片时的标题版本标记：所有段版本一样 → 那个版本；不一样 → Mixed versions */
export function mixedVersions(c: CodeCard): boolean {
  const vs = new Set(c.segments.filter((s) => s.src.kind !== "free").map((s) => JSON.stringify(s.version)));
  return vs.size > 1;
}

/** 卡里一共有多少个文件 */
export const fileCount = (c: CodeCard) => new Set(c.segments.map((s) => s.path)).size;
