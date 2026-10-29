// 粘贴的 HTML 里没排出来的 ==高亮==、~~删除线~~ 和单独一段的 ---：不认这些写法的网页、聊天应用、阅读器把它们原样当字放进 <p>
// （usage feedback #53）。ProseMirror 按 schema 读 HTML 时它们只是字；这里交给解析器按 Markdown 读，和打字、粘贴纯文字一样。
// 字里别的 ASCII 标点先藏起来再解析：HTML 里的 * _ [ ] $ # 之类本来就是字（要的格式 HTML 自己带着），单个的 ~ 也是（3~5 是范围，不当下标）
import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { parseSource } from "../schema";

// 藏成私用区的字（和 schema.ts 的 SHIELD、PAIR0 错开）：解析器当普通字，位置、长度不变，读完再换回来
const HIDE = 0xe400;
const hide = (s: string) => s.replace(/[!-/:-<>-@[-`{-}]/g, (c) => String.fromCharCode(HIDE + c.charCodeAt(0)))
  .replace(/~+/g, (m) => (m.length === 2 ? m : String.fromCharCode(HIDE + 0x7e).repeat(m.length)));
const unhide = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - HIDE));

/** slice 里字中原样留着的 ==…==、~~…~~ 变成高亮、删除线，顶层只有 --- 的一段变成分隔线；代码里的不动。没变返回 null */
export function marksInSlice(slice: Slice, schema: Schema): Slice | null {
  let changed = false, openStart = slice.openStart, openEnd = slice.openEnd;
  const walk = (f: Fragment, top: boolean): Fragment => {
    const out: PMNode[] = [];
    f.forEach((n, _o, i) => {
      if (top && isRule(n, schema)) {
        changed = true;
        // 分隔线没有内容，不能是 slice 敞开的一头
        if (i === 0) openStart = 0;
        if (i === f.childCount - 1) openEnd = 0;
        out.push(schema.nodes.horizontalRule.create());
      } else if (n.isTextblock) {
        const m = n.type.spec.code ? n : marksInBlock(n, schema);
        if (m !== n) changed = true;
        out.push(m);
      } else out.push(n.isLeaf ? n : n.copy(walk(n.content, false)));
    });
    return Fragment.from(out);
  };
  const content = walk(slice.content, true);
  return changed ? new Slice(content, openStart, openEnd) : null;
}

function isRule(n: PMNode, schema: Schema): boolean {
  if (n.type !== schema.nodes.paragraph || !schema.nodes.horizontalRule || n.childCount !== 1) return false;
  const c = n.firstChild!;
  if (!c.isText || c.marks.length || !/^[-*_ \t]+$/.test(c.text!)) return false;
  const ns = parseSource(c.text!.trim(), false);
  return ns?.length === 1 && ns[0].type === "horizontalRule";
}

function marksInBlock(b: PMNode, schema: Schema): PMNode {
  if (!/==|~~/.test(b.textContent)) return b;
  const out: PMNode[] = [];
  let changed = false;
  b.forEach((c) => {
    if (!c.isText || c.marks.some((m) => m.type.spec.code) || !/==|~~/.test(c.text!)) { out.push(c); return; }
    const ns = parseSource(hide(c.text!), true);
    if (!ns?.length || ns.some((j) => j.type !== "text") || !ns.some((j) => j.marks?.length)) { out.push(c); return; }
    for (const j of ns) {
      let marks: readonly Mark[] = (j.marks ?? []).map((m) => schema.mark(m.type, m.attrs));
      for (const m of c.marks) marks = m.addToSet(marks);
      out.push(schema.text(unhide(j.text!), marks.filter((m) => b.type.allowsMarkType(m.type))));
    }
    changed = true;
  });
  return changed ? b.type.create(b.attrs, out, b.marks) : b;
}
