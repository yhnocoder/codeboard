// Auto Focus 的核对（纯函数，不碰白板状态）：模型只许插 ==…== 和 **…**。回来的字去掉插的记号必须正好是原文，
// 按 Markdown 解析后（去掉粗体、高亮）也必须和原文一样：代码、公式、链接、列表和标题的结构、已有的标记都没动
import { parseMd } from "@yhnocoder/markdown";

type Node = {
  type?: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
  attrs?: Record<string, unknown>;
};
const ADDED = new Set(["bold", "highlight"]);
/** 文档去掉粗体和高亮（代码字上的不去：代码外面包一层也算动了它），相邻的同样的字并起来，用来比较结构和其余的字 */
function plain(ns: Node[] | undefined): Node[] | undefined {
  if (!ns) return ns;
  const out: Node[] = [];
  for (const n of ns) {
    let m = n;
    if (n.type === "text") {
      const code = n.marks?.some((k) => k.type === "code");
      const marks = (code ? n.marks! : (n.marks ?? []).filter((k) => !ADDED.has(k.type)))
        .slice()
        .sort((a, b) => a.type.localeCompare(b.type));
      m = { type: "text", text: n.text, ...(marks.length ? { marks } : {}) };
      const prev = out[out.length - 1];
      if (prev?.type === "text" && JSON.stringify(prev.marks ?? []) === JSON.stringify(m.marks ?? [])) {
        out[out.length - 1] = { ...prev, text: (prev.text ?? "") + (m.text ?? "") };
        continue;
      }
    } else if (n.content) m = { ...n, content: plain(n.content) };
    out.push(m);
  }
  return out;
}

/** 回答外面可能多包了一层：<document> 标签、整段的代码围栏（原文本身不是这样开头的才去） */
function unwrap(reply: string, orig: string): string[] {
  const out = [reply];
  const doc = /^\s*<document>\n?([\s\S]*?)\n?<\/document>\s*$/.exec(reply);
  if (doc) out.push(doc[1]);
  for (const r of [...out]) {
    const f = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(r);
    if (f && !/^\s*```/.test(orig)) out.push(f[1]);
  }
  return out;
}

/**
 * reply 是不是 orig 只插了 == 和 **：一个一个字对，对不上的地方只能是插进来的记号。回插了几个（各算一个记号），对不上回 null。
 * 一样的字先当原文的字对（原文自己的 ** 不会被当成加的）；对错了位置只会让它多拒一次，不会放过改了字的
 */
function inserted(orig: string, reply: string): { hl: number; bold: number } | null {
  let i = 0,
    j = 0,
    hl = 0,
    bold = 0;
  while (j < reply.length) {
    if (i < orig.length && orig[i] === reply[j]) {
      i++;
      j++;
      continue;
    }
    const two = reply.slice(j, j + 2);
    if (two === "==") hl++;
    else if (two === "**") bold++;
    else return null;
    j += 2;
  }
  return i === orig.length && hl % 2 === 0 && bold % 2 === 0 ? { hl: hl / 2, bold: bold / 2 } : null;
}

export type FocusCheck = { md: string; hl: number; bold: number } | { why: "changed" | "same" };
/** 核对模型回来的 Markdown：只加了记号、解析出来别的都一样才回 md（原文开头结尾的空白照旧）；加了 0 个回 same */
export function checkFocus(orig: string, reply: string): FocusCheck {
  const core = orig.trim(),
    lead = orig.slice(0, orig.indexOf(core)),
    trail = orig.slice(lead.length + core.length);
  const base = JSON.stringify(plain(parseMd(core).content));
  for (const cand of unwrap(reply, orig)) {
    const r = cand.trim(),
      n = inserted(core, r);
    if (!n) continue;
    if (!n.hl && !n.bold) return { why: "same" };
    if (JSON.stringify(plain(parseMd(r).content)) !== base) continue;
    return { md: lead + r + trail, ...n };
  }
  return { why: "changed" };
}
