// 不进编辑器给一段字加 / 去掉格式（白板上在静态显示里选了字按 Bold、Highlight）：原文解析成文档，在 staticTextRange
// 数出来的那一段上加减格式，再写回 Markdown。只重写改到的那几个顶层块，别的块原文一个字不动
import { Transform } from "@tiptap/pm/transform";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { mdSchema, parseMd, serializeMd, mdBlockStarts } from "./schema";
import { docRange, type StaticTextRange } from "./selmap";

export type StaticMark = "bold" | "highlight";

/** 两头的空白不算进去（** 、== 包着空白读回来就不是格式了） */
function trimmed(r: StaticTextRange): StaticTextRange | null {
  const a = r.text.length - r.text.trimStart().length, b = r.text.length - r.text.trimEnd().length;
  return a + b >= r.text.length ? null : { from: r.from + a, to: r.to - b, text: r.text.slice(a, r.text.length - b) };
}
function locate(src: string, r: StaticTextRange) {
  const t = trimmed(r);
  if (!t) return null;
  const doc = mdSchema().nodeFromJSON(parseMd(src));
  const at = docRange(doc, t);
  return at && { doc, ...at };
}
/** 这一段里能带这种格式的字是不是全带着（一个字都没有的算不带） */
function covered(doc: PMNode, from: number, to: number, type: MarkType) {
  let any = false, all = true;
  doc.nodesBetween(from, to, (n, _pos, parent) => {
    if (!n.isText || !parent?.type.allowsMarkType(type)) return;
    any = true;
    if (!type.isInSet(n.marks)) all = false;
  });
  return any && all;
}

/** 原文 src 里静态显示的这一段是不是全带着 mark */
export function staticMarkActive(src: string, r: StaticTextRange, mark: StaticMark): boolean {
  const l = locate(src, r);
  return !!l && covered(l.doc, l.from, l.to, mdSchema().marks[mark]);
}

/** 给这一段加上 mark；整段已经带着就去掉（和编辑器里的 ⌘B 一样）。数不到、什么都没变给 null */
export function toggleStaticMark(src: string, r: StaticTextRange, mark: StaticMark): string | null {
  const l = locate(src, r);
  if (!l) return null;
  const type = mdSchema().marks[mark], tr = new Transform(l.doc);
  if (covered(l.doc, l.from, l.to, type)) tr.removeMark(l.from, l.to, type);
  else tr.addMark(l.from, l.to, type.create());
  if (!tr.docChanged) return null;
  return spliceBlocks(src, l.doc, tr.doc) ?? serializeMd(tr.doc.toJSON());
}

/** 只把变了的顶层块换成它新写出来的 Markdown；块对不上原文、变了的块里有脚注引用（单独写会重新编号）时给 null */
function spliceBlocks(src: string, before: PMNode, after: PMNode): string | null {
  const starts = mdBlockStarts(src);
  if (!starts || before.childCount !== starts.length || after.childCount !== starts.length) return null;
  let out = "", at = 0;
  for (let i = 0; i < starts.length; i++) {
    const nb = after.child(i);
    if (nb.eq(before.child(i))) continue;
    let refs = false;
    nb.descendants((n) => { if (n.type.name === "footnoteReference") refs = true; return !refs; });
    if (refs) return null;
    const s = starts[i];
    out += src.slice(at, s) + serializeMd({ type: "doc", content: [nb.toJSON()] });
    at = s + src.slice(s, starts[i + 1] ?? src.length).trimEnd().length;
  }
  return out + src.slice(at);
}
