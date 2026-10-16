// 定义预览（peek）的源码部分按定义类型取：字段 → 所在类的所有字段；函数 → 开头几行；模块 → 不放源码。
// 没有语言服务的 hover 时，签名和文档也从这里出（docstring 转成 Markdown）。
import { COMMENT, DOCSTRING, BLANK, symbolAt, type FileAnalysis, type Sym } from "./index";

export type PeekKind = "field" | "function" | "class" | "module" | "other";

export type PeekPlan = {
  kind: PeekKind;
  rows: number[]; // 要显示的行号（不一定连续）；module 为空
  head?: string; // 行上面的小标题：class Config
  more?: number; // 「⋯ N more lines」
  sig?: string; // 兜底的 hover 签名：(function) def load_model(model, path)
  doc?: string; // 兜底的文档（Markdown）
};

const FN_ROWS = 3; // 函数：签名之后显示几行
const MAX_ROWS = 16;

const indentOf = (l: string) => l.length - l.trimStart().length;

/** 定义跳到的是不是一个模块（文件开头，那一行里没有这个名字） */
export function isModuleDef(lines: string[], line: number, col: number, word: string): boolean {
  if (line !== 1 || col !== 0) return false;
  const w = word.split(".").pop()!;
  return !new RegExp(`\\b${w.replace(/[^\w]/g, "")}\\b`).test(lines[0] ?? "");
}

/** 类体里直接写的字段行（不在方法里、不是注释 / docstring / 装饰器） */
export function classFields(a: FileAnalysis, lines: string[], cls: Sym): number[] {
  const kids = a.symbols.filter((s) => s.parent === cls.qual || (s.qual.startsWith(cls.qual + ".") && s.qual.split(".").length === cls.qual.split(".").length + 1));
  let base = -1;
  const out: number[] = [];
  for (let l = cls.defLine + 1; l <= cls.end; l++) {
    const k = kids.find((s) => s.start <= l && l <= s.end);
    if (k) { l = k.end; continue; }
    const t = lines[l - 1] ?? "";
    if (((a.flags[l - 1] ?? 0) & (BLANK | COMMENT | DOCSTRING)) || !t.trim()) continue;
    const ind = indentOf(t);
    if (base < 0) base = ind;
    if (ind !== base || /^\s*@/.test(t) || /^\s*(pass|\.\.\.)\s*$/.test(t)) continue;
    out.push(l);
  }
  return out;
}

/** 太多行时以当前行为中心截一段 */
const around = (rows: number[], line: number, n = MAX_ROWS) => {
  if (rows.length <= n) return rows;
  const i = Math.max(0, rows.indexOf(line));
  const a = Math.max(0, Math.min(rows.length - n, i - (n >> 1)));
  return rows.slice(a, a + n);
};

/** 定义在 line（col = 定义处的列）：peek 的源码部分怎么取 */
export function peekPlan(a: FileAnalysis, lines: string[], line: number, o: { word?: string; module?: boolean } = {}): PeekPlan {
  const word = (o.word ?? "").split(".").pop() ?? "";
  if (o.module) return { kind: "module", rows: [], sig: `(module) ${word}`, doc: a.doc ? docToMd(a.doc) : undefined };
  const sym = a.symbols.find((s) => s.defLine === line);
  if (sym?.kind === "def") {
    const rows: number[] = [];
    let body = 0;
    for (let l = sym.start; l <= sym.end && body < FN_ROWS; l++) {
      if ((a.flags[l - 1] ?? 0) & DOCSTRING) continue;
      if (!(lines[l - 1] ?? "").trim()) continue;
      rows.push(l);
      if (l > sym.defLine && sigDone(lines, sym, l)) body++;
    }
    const last = rows[rows.length - 1] ?? sym.end;
    return { kind: "function", rows, more: sym.end - last || undefined, sig: `(${sym.parent ? "method" : "function"}) ${sym.sig}`, doc: sym.doc ? docToMd(sym.doc) : undefined };
  }
  if (sym?.kind === "class") {
    let rows = classFields(a, lines, sym);
    if (!rows.length) rows = a.symbols.filter((s) => s.parent === sym.qual).map((s) => s.defLine);
    const shown = around([...new Set([...range(sym.start, sym.defLine), ...rows])], line);
    return { kind: "class", rows: shown, more: rows.length + (sym.defLine - sym.start + 1) - shown.length || undefined, sig: `(class) ${sym.sig}`, doc: sym.doc ? docToMd(sym.doc) : undefined };
  }
  const text = lines[line - 1] ?? "";
  const field = `(variable) ${text.trim().replace(/\s*#.*$/, "")}`;
  const inner = symbolAt(a.symbols, line);
  // 类体里的字段：整个类的字段，当前这个高亮
  if (inner?.kind === "class") {
    const rows = classFields(a, lines, inner);
    if (rows.includes(line)) {
      const shown = around(rows, line);
      return { kind: "field", rows: shown, head: inner.sig, more: rows.length - shown.length || undefined, sig: field };
    }
  }
  // __init__ 里的 self.x = …：同一个方法里所有 self.x 赋值
  const selfRe = /^\s*self\.\w+\s*(:[^=]*)?=(?!=)/;
  if (inner?.kind === "def" && selfRe.test(text)) {
    const rows = range(inner.defLine + 1, inner.end).filter((l) => selfRe.test(lines[l - 1] ?? "") && indentOf(lines[l - 1]) === indentOf(text));
    const shown = around(rows, line);
    return { kind: "field", rows: shown, head: inner.qual, more: rows.length - shown.length || undefined, sig: field };
  }
  const s = Math.max(1, line - 1), e = Math.min(lines.length, line + 1);
  return { kind: "other", rows: range(s, e), sig: /^\s*\w[\w.]*\s*(:[^=]*)?=/.test(text) ? field : undefined };
}

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
/** 多行签名：def 行到冒号结束的那一行都不算正文 */
function sigDone(lines: string[], sym: Sym, l: number) {
  for (let k = sym.defLine; k < l; k++) if (/:\s*(#.*)?$/.test(lines[k - 1] ?? "")) return true;
  return false;
}

/**
 * docstring → Markdown：reST 的 :mod:`x` / ``x`` 变成行内代码，同一段里折行的句子接成一行，
 * 缩进的行（Args: 下面的参数、代码示例）保持一行一段，>>> 示例放进代码块。
 */
export function docToMd(doc: string): string {
  const src = doc.replace(/:[\w:]+:`~?([^`]+)`/g, "`$1`").replace(/``([^`]+)``/g, "`$1`").split("\n");
  const out: string[] = [];
  let para = false, code = false;
  for (const raw of src) {
    const l = raw.trimEnd();
    const ex = /^\s*(>>>|\.\.\.)\s?/.test(l);
    if (ex !== code) { out.push("```"); code = ex; para = false; }
    if (code) { out.push(l.trim()); continue; }
    if (!l.trim()) { out.push(""); para = false; continue; }
    const ind = indentOf(l) > 0, item = /^\s*([-*]|\d+[.)])\s/.test(l), head = /:\s*$/.test(l) || /^[-=~]{3,}$/.test(l.trim());
    if (/^[-=~]{3,}$/.test(l.trim()) && out.length) { const t = out.pop()!; out.push(`**${t}**`); para = false; continue; }
    if (para && !ind && !item && !head) out[out.length - 1] += " " + l.trim();
    else out.push(item ? l.trim() : ind ? `- ${l.trim()}` : l.trim());
    para = !ind && !item && !head;
  }
  if (code) out.push("```");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** VS Code hover 的 Markdown → 签名（第一个代码块）+ 文档；Pylance 会把 _ 之类转义，去掉 */
export function splitHover(md: string): { sig?: string; doc?: string } {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n```[ \t]*\n?/.exec(md);
  let sig: string | undefined, rest = md;
  if (m) { sig = m[1].trim(); rest = md.slice(m[0].length); }
  rest = rest.replace(/^\s*(---|\*\*\*|___)[ \t]*(\n|$)/, "").replace(/&nbsp;/g, " ");
  // 代码块里不去转义
  rest = rest.split(/(```[\s\S]*?```)/).map((p, i) => (i % 2 ? p : p.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1"))).join("").trim();
  return { sig: sig || undefined, doc: rest || undefined };
}
