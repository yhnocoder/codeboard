// The empty paragraph kept after a last block nothing can be typed into (code, a formula, a table): not written to the file
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/** End of the body */
export const bodyEnd = (d: PMNode) => d.content.size;
const TYPABLE = /^(paragraph|heading|bulletList|orderedList|taskList)$/;
/** 最后一块是代码、公式、表格、折叠块这类时补一个空段落（不写进文件）。补了返回 true */
export function padEnd(tr: Transaction): boolean {
  const end = bodyEnd(tr.doc),
    last = tr.doc.resolve(end).nodeBefore;
  if (!last || TYPABLE.test(last.type.name)) return false;
  tr.insert(end, tr.doc.type.schema.nodes.paragraph.create());
  return true;
}
/** 垫的空段落（padEnd）还空着时它的位置：正文最后一个空段落，前面一块是代码、公式、表格这类。没有给 null */
export function padAt(doc: PMNode): number | null {
  const end = bodyEnd(doc),
    last = doc.resolve(end).nodeBefore;
  if (last?.type.name !== "paragraph" || last.content.size) return null;
  const at = end - last.nodeSize,
    before = doc.resolve(at).nodeBefore;
  return before && !TYPABLE.test(before.type.name) ? at : null;
}
