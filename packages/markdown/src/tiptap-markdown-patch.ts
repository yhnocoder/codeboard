// Workarounds for @tiptap/markdown's MarkdownManager, in one place: it puts marks only on text, and escapes text its own way
import type { JSONContent } from "@tiptap/core";
import type { Attrs, Schema } from "@tiptap/pm/model";
import type { MarkdownManager } from "@tiptap/markdown";

// 包着行内原子节点的格式：**a $x$**、==:tada:==、[![i](u)](l)
// @tiptap/markdown 只给字加格式（applyMarkToContent 只认 text，往下找 content），行内的公式、表情、图片、[[引用]] 这些没有内容的
// 节点就没了外面的格式；写回时它又在每个非文字节点前把格式全关掉。两头都在这里补：读的时候行内原子节点也带上格式，
// 写的时候带格式的原子节点先写成自己的 Markdown 字（见 schema.ts 的 toMd），和两边的字一起被同一对记号包住
export const markableLeaf = (schema: Schema, type: string | undefined) => {
  const t = type ? schema.nodes[type] : undefined;
  return !!t && t.isInline && t.isLeaf && type !== "hardBreak";
};
type ApplyMark = (mark: string, content: JSONContent[], attrs?: Attrs) => JSONContent[];
/** Reading: a mark around inline atoms goes on them too (replaces the manager's applyMarkToContent) */
export function marksOnAtoms(mm: MarkdownManager, schema: () => Schema) {
  const textMarks = (mm as unknown as { applyMarkToContent: ApplyMark }).applyMarkToContent.bind(mm);
  (mm as unknown as { applyMarkToContent: ApplyMark }).applyMarkToContent = (mark, content, attrs) =>
    content.flatMap((n) =>
      markableLeaf(schema(), n.type)
        ? [{ ...n, marks: [...(n.marks ?? []), attrs ? { type: mark, attrs } : { type: mark }] }]
        : textMarks(mark, [n], attrs),
    );
}

// 字的转义由 escText 决定：交给 MarkdownManager 之前，把它会转义、变实体的字符换成私用区的字，写完再换回来，它就原样写出
export const SHIELD = 0xe200;
export const shield = (s: string) => s.replace(/[&<>\\`*_[\]~]/g, (c) => String.fromCharCode(SHIELD + c.charCodeAt(0)));
export const unshield = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - SHIELD));
