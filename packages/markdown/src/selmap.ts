// 静态 HTML 和编辑器是同一份 schema、同一套 renderHTML，所以按"字"对得上：文字算它的长度，公式、[[引用]]、图片、
// 脚注号、换行这类一个节点算一个字（￼），块和块之间不算。两边各数一遍，数到同一个字就是同一个位置；最后再比一遍
// 两边是不是同样的字，对不上（比如原样写的行内 HTML）就给 null。
// 用法：静态显示上按下键时记下 staticTextRange（DOM 马上要换成编辑器），编辑器建好以后用 docRange 换成文档位置
import type { Node as PMNode } from "@tiptap/pm/model";

const LEAF_CHAR = "￼";
/** 静态显示里一个节点占一整块、在文档里是一个叶子节点的：算一个字 */
const LEAF = ".katex, .math, .md-ref, .fnref, .md-emoji, .md-toc, .md-html, img, br, hr";

/** 静态显示上的一段：从第几个字到第几个字（按上面的数法），和这一段的字（叶子是 ￼） */
export type StaticTextRange = { from: number; to: number; text: string };

/**
 * root 是一篇静态 Markdown（renderMd 的 HTML 放进去的元素）；range 两头都要在 root 里，否则给 null。
 * 一头落在公式这类叶子里面：开头算到它前面，结尾算到它后面（整个叶子都选上）
 */
export function staticTextRange(root: HTMLElement, range: Range): StaticTextRange | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  let text = "", from = -1, to = -1;
  const mark = (n: Node, o: number) => {
    if (from < 0 && n === range.startContainer && o === range.startOffset) from = text.length;
    if (to < 0 && n === range.endContainer && o === range.endOffset) to = text.length;
  };
  const visit = (n: Node) => {
    if (n.nodeType === 3) {
      const d = (n as Text).data;
      if (n === range.startContainer && from < 0) from = text.length + Math.min(range.startOffset, d.length);
      if (n === range.endContainer && to < 0) to = text.length + Math.min(range.endOffset, d.length);
      text += d;
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as HTMLElement;
    // Mermaid：挂上页面后换成了图，文档里是代码块的原文
    const mmd = e.classList.contains("mmd");
    if (mmd || e.matches(LEAF)) {
      const s = mmd ? e.dataset.src ?? "" : LEAF_CHAR;
      if (from < 0 && (e === range.startContainer || e.contains(range.startContainer))) from = text.length;
      text += s;
      if (to < 0 && (e === range.endContainer || e.contains(range.endContainer))) to = text.length;
      return;
    }
    const kids = e.childNodes;
    for (let i = 0; i < kids.length; i++) { mark(e, i); visit(kids[i]); }
    mark(e, kids.length);
  };
  visit(root);
  if (from < 0 || to < 0 || to <= from) return null;
  return { from, to, text: text.slice(from, to) };
}

/** staticTextRange 反过来：root 里第 from 到第 to 个字的 DOM Range（重画以后把选区放回同一段字上）；数不到给 null */
export function staticDomRange(root: HTMLElement, from: number, to: number): Range | null {
  const r = document.createRange();
  let n = 0, start = false;
  const visit = (node: Node): boolean => {
    let len = 0, leaf: HTMLElement | null = null;
    if (node.nodeType === 3) len = (node as Text).data.length;
    else if (node.nodeType === 1) {
      const e = node as HTMLElement, mmd = e.classList.contains("mmd");
      if (!mmd && !e.matches(LEAF)) { for (const k of e.childNodes) if (visit(k)) return true; return false; }
      leaf = e;
      len = mmd ? (e.dataset.src ?? "").length : LEAF_CHAR.length;
    } else return false;
    if (!start && from < n + len) { if (leaf) r.setStartBefore(leaf); else r.setStart(node, from - n); start = true; }
    const end = start && to > n && to <= n + len;
    if (end) { if (leaf) r.setEndAfter(leaf); else r.setEnd(node, to - n); }
    n += len;
    return end;
  };
  return visit(root) ? r : null;
}

/** 文档里第 k 个字的位置。start：块和块之间、叶子前面取后一个位置（下一块的开头）；否则取前一个（上一块的末尾） */
function posAt(doc: PMNode, k: number, start: boolean): number | null {
  let n = 0, at: number | null = null;
  doc.descendants((node, pos) => {
    if (at !== null) return false;
    if (!node.isText && !node.isLeaf) return true;
    const len = node.isText ? node.text!.length : 1;
    if (start ? k < n + len : k > n && k <= n + len) at = node.isText ? pos + (k - n) : start ? pos : pos + node.nodeSize;
    n += len;
    return false;
  });
  return at;
}

/** staticTextRange 记下的一段在文档 doc 里的位置；两边的字对不上给 null */
export function docRange(doc: PMNode, r: StaticTextRange): { from: number; to: number } | null {
  const from = posAt(doc, r.from, true), to = posAt(doc, r.to, false);
  if (from === null || to === null || to <= from) return null;
  return doc.textBetween(from, to, "", LEAF_CHAR) === r.text ? { from, to } : null;
}
