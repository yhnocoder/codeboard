// 箭头上的标签框要用到的纯文本小工具：调用处的文字、参数在新代码里还在不在、↺ 是哪一行的循环。
import { escapeRegExp, type Segment, type Var } from "./model";

const lineText = (s: Segment, line: number) => s.text[line - s.start];
const hasWord = (text: string, w: string) => new RegExp(`(^|[^\\w$])${escapeRegExp(w)}(?![\\w$])`).test(text);
const words = (t: string) => t.match(/[A-Za-z_$][\w$]*/g) ?? [];

/**
 * 调用处的文字：出发行整行，加上括号没合上时后面接着的几行（实参常常分行写）。
 * 从 col 开始数括号，最多往下看 30 行；行不在段里时为空串
 */
export function callText(s: Segment, line: number, col = 0): string {
  const first = lineText(s, line);
  if (first === undefined) return "";
  const out = [first];
  let depth = 0, opened = false;
  const scan = (t: string, from: number) => {
    for (let i = from; i < t.length; i++) {
      const ch = t[i];
      if (ch === "#") break;
      if (ch === "(" || ch === "[" || ch === "{") { depth++; opened = true; }
      else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (opened && depth <= 0) return true; }
    }
    return false;
  };
  if (scan(first, Math.max(0, col))) return first;
  for (let l = line + 1; l <= Math.min(s.end, line + 30) && opened && depth > 0; l++) {
    const t = lineText(s, l);
    if (t === undefined) break;
    out.push(t);
    if (scan(t, 0)) break;
  }
  return out.join("\n");
}

/**
 * 勾选过的参数在现在的代码里还在不在（代码更新后用）。调用处那一边看 callText，被调那一边看被调卡的全部代码。
 * 用户自己写的（custom）不检查；名字被 … 截短时最后那个词不检查
 */
export function varGone(v: Var, site: string, callee: string): boolean {
  if (v.custom) return false;
  const ws = words(v.a);
  if (v.a.endsWith("…")) ws.pop();
  if (ws.some((w) => !hasWord(site, w))) return true;
  if (v.b && !v.ret && !hasWord(callee, v.b)) return true;
  return false;
}

const LOOP = /^\s*(?:(?:async\s+)?for\b|while\b|do\b(?!\w))/;
const INLINE_LOOP = /[[({].*\bfor\b.+\bin\b/; // 推导式 / 生成器：[f(x) for x in xs]
const indent = (t: string) => t.match(/^\s*/)![0].replace(/\t/g, "    ").length;

/**
 * ↺ 是哪一行的循环：从调用行往上找缩进更浅的 for / while（C++ 也认 for( / while( / do）；调用行本身是推导式就是它自己。
 * 碰到缩进更浅的 def / class 就停（出了函数）。找不到为 undefined
 */
export function loopLine(s: Segment, line: number): { line: number; text: string } | undefined {
  const own = lineText(s, line);
  if (own === undefined) return;
  if (INLINE_LOOP.test(own)) return { line, text: own.trim() };
  let lim = own.trim() ? indent(own) : Infinity;
  for (let l = line - 1; l >= s.start; l--) {
    const t = lineText(s, l) ?? "";
    if (!t.trim() || /^\s*(#|\/\/)/.test(t)) continue;
    const d = indent(t);
    if (d >= lim) continue;
    lim = d;
    if (LOOP.test(t)) return { line: l, text: t.trim() };
    if (/^\s*(async\s+)?(def|class)\b/.test(t)) return;
  }
  return;
}
