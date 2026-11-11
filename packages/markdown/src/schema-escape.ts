// Escaping text written back as Markdown: the characters, and the line starts that would be read as blocks
import type { JSONContent } from "@tiptap/core";
import { EMOJI_AT, isEmoji, mathAt } from "./schema-nodes";
import { annotAt, HL_RE, SUP_RE } from "./schema-marks";
import { ESC_DOLLAR } from "./placeholders";

// 原版把 \ ` * _ [ ] ~ 全部转义，还把 < & 变成实体：block_manager 会写成 block\_manager。这里只在重新解析会变样时才转义
const PUNCT = /[!-/:-@[-`{-~]/;
/**
 * 一行开头会被读成块的写法：# 标题、> 引用、- + * 列表、1. 1) 有序列表、--- *** ___ 分隔线、=== --- setext 标题的下划线、[toc]。
 * 匹配到的末尾就是要放 \ 的地方：有序列表转义的是数字后面的 . )（\1. 不是转义），别的是第一个记号。
 * 一行到这段字的末尾就算完（后面可能还有别的行内内容）：多转义一个 \ 不改意思，少转义会变结构
 */
const LINE_START =
  /^ {0,3}(?:\d{1,9}(?=[.)](?:[ \t]|$))|(?=#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|([-*_])[ \t]*(?:\1[ \t]*){2,}$|[-=]+[ \t]*$|\[toc\][ \t]*$))/gim;
const ESC = "\u0001"; // 行首要转义的位置先放个记号，escText 把它和后面那个字写成 \X
export function escText(s: string): string {
  // * ~ ` 一段里只有一个时配不成对，不用转义；两边都是空白的 * ~ 也不会成强调（a * b）。_ 不当强调（解析时关掉了），不转义
  // 只数可能成对的（不是两边都空白的）
  const pairs = (c: string) => {
    let n = 0;
    for (let i = 0; i < s.length; i++)
      if (s[i] === c && !(/\s/.test(s[i - 1] ?? " ") && /\s/.test(s[i + 1] ?? " "))) n++;
    return n > 1;
  };
  const star = pairs("*"),
    tilde = pairs("~"),
    tick = pairs("`");
  const dollars = openingDollars(s);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i],
      next = s[i + 1] ?? "",
      prev = s[i - 1] ?? "";
    switch (c) {
      case ESC:
        out += `\\${next}`;
        i++;
        break;
      case "\\":
        out += !next || PUNCT.test(next) ? "\\\\" : c;
        break;
      case "`":
        out += tick ? "\\`" : c;
        break;
      case "*":
      case "~":
        out += (c === "*" ? star : tilde) && !(/\s/.test(prev || " ") && /\s/.test(next || " ")) ? `\\${c}` : c;
        break;
      case "[":
        out += next === "[" || next === "^" || /^[^\]]*\]\s*[(\[]/.test(s.slice(i + 1)) ? "\\[" : c;
        break;
      case "$":
        out += dollars.has(i) ? "\\$" : c;
        break;
      case "<":
        out += /[A-Za-z/!?]/.test(next) ? "\\<" : c;
        break;
      // 字面的 ^2^、==x==：会被读成上标、高亮的才转义
      case "^":
        out += SUP_RE.test(s.slice(i)) && prev !== "^" ? "\\^" : c;
        break;
      case "=":
        out += HL_RE.test(s.slice(i)) && prev !== "=" ? "\\=" : c;
        break;
      case "{":
        out += annotAt(s.slice(i)) ? "\\{" : c;
        break;
      // 字面的 :smile:（会被读成表情的）：转义前一个冒号
      case ":": {
        const m = EMOJI_AT.exec(s.slice(i));
        out += m && isEmoji(m[1]) && !/[\p{L}\p{N}_]/u.test(prev) ? "\\:" : c;
        break;
      }
      case "&":
        out += /^&(?:#\d+|#x[\da-f]+|\w+);/i.test(s.slice(i)) ? "&amp;" : c;
        break;
      default:
        out += c;
    }
  }
  return out;
}

/**
 * 字里要写成 \$ 的 $：读回来时会开头一个公式的（照 mathAt）。转义过的 \$ 读回来不再是 $，原来配给它的那个 $ 就可能和更后面的
 * $ 配成公式（$a$ 只转义开头写成 \$a$，后面那个 $ 会和下一个 $ 配上），所以按写出来的样子反复看，直到没有新的要转义
 */
function openingDollars(s: string): Set<number> {
  const esc = new Set<number>();
  if (!s.includes("$")) return esc;
  for (let grew = true; grew; ) {
    grew = false;
    const out = s
      .split("")
      .map((c, i) => (esc.has(i) ? ESC_DOLLAR : c))
      .join("");
    for (let i = s.indexOf("$"); i >= 0; i = s.indexOf("$", i + 1)) {
      if (!esc.has(i) && mathAt(out.slice(i), out[i - 1] ?? "")) {
        esc.add(i);
        grew = true;
      }
    }
  }
  return esc;
}

// 段落里每一行的开头（段首、硬换行后面、字里的换行后面）会被读成块的写法：转义（只看没有格式的字，有格式的前面有记号）
export function markStarts(ns: JSONContent[]): JSONContent[] {
  return ns.map((n): JSONContent => {
    if (n.type !== "paragraph") return n.content ? { ...n, content: markStarts(n.content) } : n;
    let atLine = true;
    return {
      ...n,
      content: n.content?.map((t) => {
        const start = atLine;
        atLine = t.type === "hardBreak" || (t.type === "text" && !!t.text?.endsWith("\n"));
        if (t.type !== "text" || !t.text || t.marks?.length) return t;
        return {
          ...t,
          text: t.text.replace(LINE_START, (m0: string, _c: string, off: number) =>
            off === 0 && !start ? m0 : m0 + ESC,
          ),
        };
      }),
    };
  });
}
