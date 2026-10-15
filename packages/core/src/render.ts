// 宿主用：把一行代码的高亮 token 拼成 HTML，调用名字外面套一层可点击的 .call。
// 颜色用白板自己的 class（kw / fn / str / com / num / self / p / dec），亮色暗色由白板的 CSS 决定。

export type Tok = { text: string; cls?: string };
/** 一行里的调用：[col, end) 是 UTF-16 下标，idx = SegView.calls 里的下标 */
export type Mark = { col: number; end: number; idx: number };

export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 拼一行 HTML。cut = 从这一列开始不要了（去掉行尾注释的版本，末尾空白也去掉）。
 * token 和调用的边界不一定对齐，按两者的边界切开再拼。
 */
export function renderLine(toks: Tok[], marks: Mark[] = [], cut?: number): string {
  let line = toks.map((t) => t.text).join("");
  let tk = toks;
  if (cut !== undefined) {
    const keep = line.slice(0, cut).trimEnd().length;
    tk = [];
    let col = 0;
    for (const t of toks) {
      if (col >= keep) break;
      tk.push(col + t.text.length <= keep ? t : { ...t, text: t.text.slice(0, keep - col) });
      col += t.text.length;
    }
    line = line.slice(0, keep);
  }
  const ms = marks.filter((m) => m.col < line.length && m.end > m.col).sort((a, b) => a.col - b.col);
  // 所有切点
  const cuts = new Set<number>([0, line.length]);
  let c = 0;
  for (const t of tk) { cuts.add(c); c += t.text.length; }
  for (const m of ms) { cuts.add(m.col); cuts.add(Math.min(m.end, line.length)); }
  const pts = [...cuts].sort((a, b) => a - b);
  const clsAt = (i: number) => {
    let col = 0;
    for (const t of tk) { if (i < col + t.text.length) return t.cls; col += t.text.length; }
    return undefined;
  };
  let out = "", open: Mark | undefined;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    const m = ms.find((x) => x.col <= a && a < x.end);
    if (m !== open) {
      if (open) out += "</span>";
      if (m) out += `<span class="call" data-c="${m.idx}">`;
      open = m;
    }
    const piece = escHtml(line.slice(a, b));
    const cls = clsAt(a);
    out += cls ? `<span class="${cls}">${piece}</span>` : piece;
  }
  if (open) out += "</span>";
  return out;
}

/** shiki css-variables 主题的颜色变量 → 白板的 class */
export function tokenClass(color: string | undefined, text: string): string | undefined {
  if (/^(self|cls|this)$/.test(text.trim())) return "self";
  const m = /--shiki-token-([\w-]+)/.exec(color ?? "");
  switch (m?.[1]) {
    case "keyword": return "kw";
    case "function": return "fn";
    case "string": case "string-expression": return "str";
    case "comment": return "com";
    case "constant": return "num";
    case "punctuation": return "p";
    default: return undefined;
  }
}
