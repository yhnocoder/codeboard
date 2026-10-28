// 粘贴的 HTML 里没排出来的公式：聊天应用、网页常把 $…$ 原样当字放进 <p>。ProseMirror 按 schema 读 HTML 时它们只是字，
// 这里照解析器的行内公式规则（schema.ts 的 mathAt）把它们变成公式，和打字、粘贴纯文字的 Markdown 一样
import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { parseSource, splitMath } from "../schema";

/** slice 里字中的 $…$ / $$…$$ 变成公式；一段只有一个 $$…$$（或几行 $$ … $$）的变成公式块。没变返回 null */
export function mathInSlice(slice: Slice, schema: Schema): Slice | null {
  let changed = false;
  const walk = (f: Fragment, cell: boolean): Fragment => {
    const out: PMNode[] = [];
    f.forEach((n) => {
      if (n.isTextblock) {
        const m = n.type.spec.code ? n : mathInBlock(n, schema, cell);
        if (m !== n) changed = true;
        out.push(m);
      } else out.push(n.isLeaf ? n : n.copy(walk(n.content, cell || /cell/.test(n.type.spec.tableRole ?? ""))));
    });
    return Fragment.from(out);
  };
  const content = walk(slice.content, false);
  return changed ? new Slice(content, slice.openStart, slice.openEnd) : null;
}

function mathInBlock(b: PMNode, schema: Schema, cell: boolean): PMNode {
  if (!b.textContent.includes("$")) return b;
  const math = schema.nodes.inlineMath, block = schema.nodes.blockMath;
  // 公式块：$$、TeX、$$ 各占一行（<br> 断开）；整段当 Markdown 读出来正好是一个公式块才算
  if (!cell && block && b.type.name === "paragraph" && b.textContent.trimStart().startsWith("$$")) {
    let plain = true, src = "";
    b.forEach((c) => { if (c.isText && !c.marks.length) src += c.text; else if (c.type.name === "hardBreak") src += "\n"; else plain = false; });
    const ns = plain ? parseSource(src, false) : null;
    if (ns?.length === 1 && ns[0].type === "blockMath") return block.create(ns[0].attrs);
  }
  const out: PMNode[] = [];
  let prev = "", changed = false;
  b.forEach((c) => {
    if (!c.isText || c.marks.some((m) => m.type.spec.code) || !c.text!.includes("$")) { out.push(c); prev = c.isText ? c.text!.slice(-1) : ""; return; }
    for (const p of splitMath(c.text!, prev)) {
      if ("text" in p) out.push(schema.text(p.text, c.marks));
      else { out.push(math.create({ latex: p.latex, display: p.display }, null, c.marks.filter((m) => b.type.allowsMarkType(m.type)))); changed = true; }
    }
    prev = c.text!.slice(-1);
  });
  if (!changed) return b;
  // 一整段只有一个 $$…$$：和打字时一样换成公式块（存回去再读进来也是它）
  if (!cell && block && b.type.name === "paragraph" && out.length === 1 && out[0].type === math && out[0].attrs.display) return block.create({ latex: out[0].attrs.latex });
  return b.type.create(b.attrs, out, b.marks);
}
