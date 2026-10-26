// 照 Typora：光标走进格式文字、标题，或走到行内公式时，那一段换成真的 Markdown 原文（能直接改记号），离开时重新解析回去。
// - 原文带 mdSrc 标记（code: true：打字规则在原文里不触发，不然改到一半的 ** 会被马上转掉）
// - 只在光标单纯移动时展开：刚打完 **b** 接着往下打字，不会冒出原文
// - 收回、展开都跟着引起它的那一步进撤销记录（appendTransaction），撤销时原文和格式一起回去
// - 写出 Markdown 时 schema.ts 的 unsource 把还展开着的收回去
import { Mark } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { MARK_MD, SRC_MARK, parseInlineSrc, serializeMd } from "../schema";

const CARET = "";
// 标题开头的 "## "；紧跟着打的字会带上原文标记（标记是 inclusive 的），那些字是标题的正文，不算记号
const HEAD = /^(#{1,6})[ \t]+/;
export const sourceKey = new PluginKey<number[]>("cbSource");

export const SourceMark = Mark.create({
  name: SRC_MARK,
  inclusive: true,
  excludes: "_",
  code: true,
  parseHTML: () => [],
  renderHTML: () => ["span", { class: "md-src" }, 0],
});

const isSrc = (n: PMNode | null | undefined) => !!n?.isText && n.marks.some((m) => m.type.name === SRC_MARK);
/** 带着有 Markdown 记号的格式（展开成原文的就是它们） */
const formatted = (n: PMNode) => n.isText && !isSrc(n) && n.marks.some((m) => m.type.name in MARK_MD);

/** 文字块里带原文标记的几段：[from, to)（块里的偏移）和字 */
export function srcRuns(block: PMNode) {
  const out: { from: number; to: number; text: string }[] = [];
  let at = 0;
  block.forEach((c) => {
    const last = out[out.length - 1];
    if (isSrc(c)) { if (last && last.to === at) { last.to += c.nodeSize; last.text += c.text; } else out.push({ from: at, to: at + c.nodeSize, text: c.text! }); }
    at += c.nodeSize;
  });
  return out;
}

/** 标题开头的原文 "## " 的长度（没展开就是 0） */
export function headPrefix(block: PMNode) {
  if (block.type.name !== "heading") return 0;
  const r = srcRuns(block)[0], m = r && r.from === 0 ? HEAD.exec(r.text) : null;
  return m ? m[0].length : 0;
}

/** 光标不在里面的原文收回去；展开着的标题按 ## 的个数改级别。heads：展开过的标题（原文整个删掉了也要变回段落） */
function collapse(state: EditorState, tr: Transaction, heads: number[]): boolean {
  const sel = state.selection, head = sel.head, s = state.schema;
  type Op = { pos: number; run: (tr: Transaction) => void };
  const ops: Op[] = [];
  state.doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    const isHead = n.type.name === "heading", runs = srcRuns(n), wasOpen = isHead && heads.includes(pos);
    if (!runs.length && !wasOpen) return false;
    const start = pos + 1, inBlock = sel.empty && head >= start && head <= start + n.content.size;
    const pre = isHead && runs[0]?.from === 0 ? runs[0] : null;
    for (const r of runs) {
      if (r === pre) continue;
      if (inBlock && r.from + start <= head && head <= r.to + start) continue;
      ops.push({ pos: start + r.from, run: (t) => t.replaceWith(start + r.from, start + r.to, parseInlineSrc(r.text).map((j) => s.nodeFromJSON(j))) });
    }
    const m = pre ? HEAD.exec(pre.text) : null, preLen = m ? m[0].length : 0;
    // "## " 后面打的字：是正文，去掉原文标记
    if (m && pre && preLen < pre.to) ops.push({ pos: start + preLen, run: (t) => t.removeMark(start + preLen, start + pre.to, s.marks[SRC_MARK]) });
    if (m && m[1].length !== n.attrs.level) ops.push({ pos, run: (t) => t.setNodeMarkup(pos, undefined, { ...n.attrs, level: m[1].length }) });
    if (!inBlock && isHead) {
      if (pre && m) ops.push({ pos: start, run: (t) => t.delete(start, start + preLen) });
      else if (pre || wasOpen) {
        // ## 改坏了或整个删掉了：变回普通段落，改坏的那几个字当正文
        if (pre) ops.push({ pos: start, run: (t) => t.replaceWith(start, start + pre.to, parseInlineSrc(pre.text).map((j) => s.nodeFromJSON(j))) });
        ops.push({ pos: pos - 0.5, run: (t) => t.setNodeMarkup(pos, s.nodes.paragraph) });
      }
    }
    return false;
  });
  // 从后往前做，前面的位置不受影响
  ops.sort((a, b) => b.pos - a.pos).forEach((o) => o.run(tr));
  return ops.length > 0;
}

/** 光标单纯移动到格式文字、标题里，或选中了行内公式（方向键走到、点一下）：换成原文 */
function expand(state: EditorState, tr: Transaction, fromHead: number): number | null {
  const sel = tr.selection, s = state.schema, src = s.marks[SRC_MARK];
  if (sel instanceof NodeSelection && sel.node.type.name === "inlineMath") {
    const d = sel.node.attrs.display ? "$$" : "$", text = `${d}${sel.node.attrs.latex ?? ""}${d}`;
    tr.replaceWith(sel.from, sel.to, s.text(text, [src.create()]));
    tr.setSelection(TextSelection.create(tr.doc, fromHead <= sel.from ? sel.from + d.length : sel.from + text.length - d.length));
    return sel.from;
  }
  if (!sel.empty) return null;
  const $h = sel.$head, p = $h.parent;
  if (!p.isTextblock || p.type.spec.code) return null;
  const start = $h.start(), off = $h.parentOffset;
  let caret = off, opened: number | null = null;
  // 光标两边的格式文字连成的那一段
  const kids: { n: PMNode; from: number; to: number }[] = [];
  p.forEach((n, o) => kids.push({ n, from: o, to: o + n.nodeSize }));
  let i = kids.findIndex((k) => k.from < off && off < k.to && formatted(k.n));
  if (i < 0) i = kids.findIndex((k) => k.to === off && formatted(k.n));
  if (i < 0) i = kids.findIndex((k) => k.from === off && formatted(k.n));
  if (i >= 0) {
    let a = i, b = i;
    while (a > 0 && formatted(kids[a - 1].n)) a--;
    while (b < kids.length - 1 && formatted(kids[b + 1].n)) b++;
    const from = kids[a].from, to = kids[b].to;
    // 光标在格式里面：记一个占位字（带两边都有的格式），写出原文后看它落在哪；在两头时算在记号外面
    const before = $h.nodeBefore, after = $h.nodeAfter;
    const inside = from < off && off < to;
    const marks = inside && before && after ? before.marks.filter((m) => m.isInSet(after.marks)) : [];
    const frag = p.content.cut(from, off).append(Fragment.from(s.text(CARET, marks))).append(p.content.cut(off, to));
    let text: string;
    try { text = serializeMd({ type: "doc", content: [{ type: "paragraph", content: frag.toJSON() }] }); } catch { return null; }
    const at = text.indexOf(CARET);
    if (at >= 0 && !text.includes("\n")) {
      text = text.replace(CARET, "");
      tr.replaceWith(start + from, start + to, s.text(text, [src.create()]));
      caret = from + at;
    }
  }
  // 标题：开头放上 "## "（光标在最前面时放到它后面）
  if (p.type.name === "heading" && !srcRuns(p).some((r) => r.from === 0)) {
    const pre = `${"#".repeat(p.attrs.level)} `;
    tr.insert(start, s.text(pre, [src.create()]));
    caret += pre.length;
    opened = $h.before();
  }
  if (tr.docChanged) tr.setSelection(TextSelection.create(tr.doc, start + caret));
  return opened;
}

export function sourcePlugin() {
  // nav：这次光标是用户自己移的（方向键、Home / End、翻页；点一下在松开时另发一个 check）。程序里设的选区（原文模式切回来、
  // 走出代码块之类）不展开
  let down = false, nav = false, view: EditorView | null = null;
  const up = () => { if (!down) return; down = false; if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(sourceKey, { check: true })); };
  return new Plugin<number[]>({
    key: sourceKey,
    state: {
      init: () => [],
      apply: (tr, heads) => {
        const meta = tr.getMeta(sourceKey) as { heads?: number[] } | undefined;
        if (meta?.heads) return meta.heads;
        return tr.docChanged ? heads.map((p) => tr.mapping.map(p)) : heads;
      },
    },
    view: (v) => {
      view = v;
      window.addEventListener("mouseup", up, true);
      return { destroy: () => { window.removeEventListener("mouseup", up, true); view = null; } };
    },
    props: {
      handleKeyDown: (_v, ev) => { nav = /^(Arrow|Home$|End$|Page)/.test(ev.key) && !ev.shiftKey; return false; },
      handleDOMEvents: { mousedown: () => { down = true; nav = false; return false; } },
    },
    appendTransaction(trs, old, state) {
      if (trs.some((t) => t.getMeta(sourceKey)?.own)) return null;
      if (view?.composing) return null;
      const heads = sourceKey.getState(state) ?? [];
      const tr = state.tr;
      collapse(state, tr, heads);
      // 单纯移动光标（没改字）才展开；鼠标按着的时候先不动字（拖选会乱），松开时再看
      const moved = trs.every((t) => !t.docChanged) && trs.some((t) => (nav && t.selectionSet) || t.getMeta(sourceKey)?.check);
      let opened: number | null = null;
      if (moved && !down) opened = expand(state, tr, old.selection.head);
      if (!tr.docChanged) return null;
      // 还展开着的标题：还有 ## 的，或者 ## 删光了但光标还在里面的（离开时变回段落）
      const h = tr.selection.head;
      const live = heads.map((p) => tr.mapping.map(p)).filter((p) => {
        const n = tr.doc.nodeAt(p);
        return n?.type.name === "heading" && (headPrefix(n) > 0 || (h > p && h < p + n.nodeSize));
      });
      if (opened !== null) live.push(tr.mapping.map(opened, -1));
      return tr.setMeta(sourceKey, { own: true, heads: live });
    },
  });
}
