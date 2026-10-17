// 照 Typora 的“边写边变”：
// - 块：行首 ``` / $$ / *** / ___ / |表|头| 加回车，[ ] 加空格（# > - 1. --- 用 TipTap 自带的）
// - 行内：结尾记号一打完就变（**b** *i* ~~s~~ `c` 用 TipTap 自带的；这里加 $m$ $$m$$ [t](url) <url>）
// - 光标所在处显示 Markdown 记号（只是装饰，不进文档）：标题的 ##、粗体斜体代码链接两头的记号、选中的行内公式的源码
// - ⌘Z 紧跟在自动转换后面：撤回成打的字；标题行首退格：变回普通段落
// - 一次进来一大段字（接受补全、粘贴）时打字规则不会触发：把这一段当 Markdown 重新解析一遍（reconvert）
import { Extension, InputRule, wrappingInputRule, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Fragment, type Mark, type Node as PMNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { blockSource, parseMd } from "../schema";

/**
 * 光标所在的这一段（段落或标题）当 Markdown 源码重新解析，变了就换掉；光标留在原来那些字后面（后面剩下的字数不变）。
 * 在同一个 transaction 里做，一次 ⌘Z 连同前面的插入一起撤回
 */
export function reconvert(tr: Transaction): Transaction {
  const sel = tr.selection;
  if (!sel.empty) return tr;
  const $p = sel.$head, block = $p.parent;
  if (!block.isTextblock || block.type.spec.code || !/^(paragraph|heading)$/.test(block.type.name)) return tr;
  let fn = false;
  block.descendants((n) => { if (n.type.name === "footnoteReference") fn = true; });
  if (fn) return tr; // 脚注编号和文末的脚注列表连在一起，不单独重解析
  const src = blockSource(block.toJSON());
  if (!src.trim()) return tr;
  const schema = tr.doc.type.schema;
  let nodes: PMNode[];
  try { nodes = (parseMd(src).content ?? []).filter((n) => n.type !== "footnotes").map((n) => schema.nodeFromJSON(n)); } catch { return tr; }
  if (!nodes.length || (nodes.length === 1 && nodes[0].eq(block))) return tr;
  const frag = Fragment.from(nodes);
  const parent = $p.node(-1), idx = $p.index(-1);
  if (!parent.canReplace(idx, idx + 1, frag)) return tr;
  const after = block.textBetween($p.parentOffset, block.content.size, "", "￼").length;
  const start = $p.before();
  tr.replaceWith(start, $p.after(), frag);
  const end = start + frag.size;
  for (let q = end - 1; q > start; q--) {
    const $q = tr.doc.resolve(q);
    if ($q.parent.isTextblock && !$q.parent.type.spec.code && tr.doc.textBetween(q, end, "", "￼").length >= after) {
      tr.setSelection(TextSelection.create(tr.doc, q));
      if (!after) tr.setStoredMarks([]); // 在段尾：接着打的字不再带 `code` / 链接之类
      return tr;
    }
  }
  // 变成了公式块、表格之类：光标放到后面（后面没有段落就补一个）
  if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
  return tr;
}

// 光标处显示的记号
const MK: Record<string, (m: Mark) => [string, string]> = {
  bold: () => ["**", "**"], italic: () => ["*", "*"], strike: () => ["~~", "~~"], code: () => ["`", "`"],
  link: (m) => ["[", `](${m.attrs.href ?? ""})`], underline: () => ["<u>", "</u>"], kbd: () => ["<kbd>", "</kbd>"],
};
const mkEl = (text: string) => {
  const s = document.createElement("span");
  s.className = "md-mk";
  s.textContent = text;
  s.contentEditable = "false";
  return s;
};
const markerKey = new PluginKey("cbMarkers");

/** 行内代码的打字规则：结尾是一串反引号，往前找一样长的一串配对（CommonMark）；前面有没配上的 `` 时先不转，等它配上 */
export function codeSpanAtEnd(text: string) {
  if (!text.endsWith("`")) return null;
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ i: m.index!, n: m[0].length }));
  let long = false;
  for (let k = 0; k < runs.length; k++) {
    const o = runs[k];
    let c = -1;
    for (let q = k + 1; q < runs.length; q++) if (runs[q].n === o.n) { c = q; break; }
    if (c < 0) { if (o.n > 1) long = true; continue; } // 没配上：这一串是字
    if (c === runs.length - 1 && runs[c].i + runs[c].n === text.length) {
      if (long && o.n === 1) return null;
      let body = text.slice(o.i + o.n, runs[c].i);
      if (!body.trim() || body.includes("%leaf%") || text[o.i - 1] === "\\") return null;
      if (/^ [\s\S]* $/.test(body)) body = body.slice(1, -1);
      return { index: o.i, text: text.slice(o.i), replaceWith: body };
    }
    k = c;
  }
  return null;
}

/** 只看光标所在的那一段：标题的 ##，光标两边带的格式各自那一段的头尾 */
function markerDecos(state: import("@tiptap/pm/state").EditorState): DecorationSet | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === "inlineMath") {
    const d = sel.node.attrs.display ? "$$" : "$";
    return DecorationSet.create(state.doc, [Decoration.widget(sel.to, () => mkEl(`${d}${sel.node.attrs.latex}${d}`), { side: 1, key: `m${sel.from}${sel.node.attrs.latex}` })]);
  }
  if (!sel.empty) return null;
  const $h = sel.$head, p = $h.parent;
  if (!p.isTextblock || p.type.spec.code) return null;
  const start = $h.start(), off = $h.parentOffset;
  const ds: Decoration[] = [];
  // 记号用 CSS 的 ::before / ::after 画（attr(data-mk…)）：插一个不可编辑的小部件的话，Home / End、上下键会卡在它上面
  if (p.type.name === "heading") ds.push(Decoration.node($h.before(), $h.after(), { class: "md-mkh", "data-mka": `${"#".repeat(p.attrs.level)} ` }));
  const near = [...($h.nodeBefore?.marks ?? []), ...($h.nodeAfter?.marks ?? [])];
  const seen = new Set<string>();
  for (const m of near) {
    const f = MK[m.type.name];
    if (!f || seen.has(m.type.name)) continue;
    seen.add(m.type.name);
    // 这个格式连着的那一段（包含光标）
    let s = -1, e = -1, at = 0, hit: [number, number] | null = null;
    p.forEach((c) => {
      const has = m.isInSet(c.marks);
      if (has) { if (s < 0) s = at; e = at + c.nodeSize; } else if (s >= 0) { if (s <= off && off <= e) hit = [s, e]; s = -1; }
      at += c.nodeSize;
    });
    if (s >= 0 && s <= off && off <= e) hit = [s, e];
    if (!hit) continue;
    const [a, b] = f(m);
    if (hit[1] <= hit[0]) continue;
    // 头一个字前面、最后一个字后面（只有一个字时两个都在它身上）
    if (hit[1] - hit[0] === 1) ds.push(Decoration.inline(start + hit[0], start + hit[1], { class: "md-mka md-mkb", "data-mka": a, "data-mkb": b }));
    else {
      ds.push(Decoration.inline(start + hit[0], start + hit[0] + 1, { class: "md-mka", "data-mka": a }));
      ds.push(Decoration.inline(start + hit[1] - 1, start + hit[1], { class: "md-mkb", "data-mkb": b }));
    }
  }
  return ds.length ? DecorationSet.create(state.doc, ds) : null;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
function headingStep(e: Editor, d: number) {
  const p = e.state.selection.$head.parent;
  const cur = p.type.name === "heading" ? p.attrs.level : 7;
  const next = Math.min(7, Math.max(1, cur + d));
  if (next === cur) return true;
  return next === 7 ? e.commands.setParagraph() : e.commands.setHeading({ level: next as 1 });
}
const listType = (e: Editor) => {
  const $h = e.state.selection.$head;
  for (let d = $h.depth; d > 0; d--) { const n = $h.node(d).type.name; if (n === "listItem" || n === "taskItem") return n; }
  return "listItem";
};
/** 在光标这一段后面放一个块（这一段是空的就换掉它）；caret 给出光标位置，不给就选不动，then 之后再做的事 */
function blockAfter(e: Editor, node: PMNode, caret?: (start: number) => number, then?: (start: number) => void) {
  const $h = e.state.selection.$head;
  if ($h.depth < 1) return false;
  const d = $h.depth, empty = $h.parent.isTextblock && !$h.parent.content.size;
  const from = empty ? $h.before(d) : $h.after(d), to = empty ? $h.after(d) : from;
  const $f = e.state.doc.resolve(from);
  if (!$f.parent.canReplaceWith($f.index(), $f.indexAfter(), node.type)) return false;
  const tr = closeHistory(e.state.tr).replaceWith(from, to, node);
  const end = from + node.nodeSize;
  if (!tr.doc.resolve(end).nodeAfter) tr.insert(end, e.schema.nodes.paragraph.create());
  tr.setSelection(caret ? TextSelection.near(tr.doc.resolve(caret(from))) : NodeSelection.create(tr.doc, from));
  e.view.dispatch(tr.scrollIntoView());
  if (then) then(from);
  return true;
}
function selectWord(e: Editor) {
  const $h = e.state.selection.$head, p = $h.parent;
  if (!p.isTextblock) return false;
  const t = p.textBetween(0, p.content.size, undefined, "\ufffc"), o = $h.parentOffset;
  const w = /[\p{L}\p{N}_]/u;
  let a = o, b = o;
  while (a > 0 && w.test(t[a - 1])) a--;
  while (b < t.length && w.test(t[b])) b++;
  if (a === b) return false;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, $h.start() + a, $h.start() + b)));
  return true;
}

export const Typora = Extension.create<{ openMath: (e: Editor, pos: number) => void; openLink: (e: Editor) => void }>({
  name: "cbTypora",
  // 规则要排在 TipTap 自带的（代码块、任务）前面；Tab / Esc 还是灰字先拿（1000）
  priority: 900,
  addOptions() { return { openMath: () => {}, openLink: () => {} }; },

  addInputRules() {
    const s = this.editor.schema;
    const openMath = this.options.openMath;
    const ed = this.editor;
    /** 回车触发的块规则：这一段换成 nodes，光标放进 at(起点) 返回的位置 */
    const enterRule = (find: RegExp, make: (m: RegExpMatchArray) => { nodes: PMNode[]; caret?: (start: number) => number; then?: (start: number) => void } | null) =>
      new InputRule({
        find, undoable: false,
        handler: ({ state, range, match }) => {
          const $f = state.doc.resolve(range.from);
          if ($f.parent.type.name !== "paragraph" || range.from !== $f.start() || range.to !== $f.end()) return null;
          const r = make(match);
          if (!r) return null;
          const frag = Fragment.from(r.nodes);
          const start = $f.before();
          if (!$f.node(-1).canReplace($f.index(-1), $f.index(-1) + 1, frag)) return null;
          const tr = state.tr.replaceWith(start, $f.after(), frag);
          const caret = r.caret?.(start);
          if (caret !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
          else {
            const end = start + frag.size;
            if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, s.nodes.paragraph.create());
            tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
          }
          if (r.then) queueMicrotask(() => r.then!(start)); // 派发完马上打开（下一个键就进源码框）
          return undefined;
        },
      });
    return [
      // 行内公式：$$m$$ 是行内的大号公式（单独一行时回车变公式块）；$m$ 照 Pandoc：$ 后、结尾 $ 前都不是空白
      new InputRule({ find: /(?:^|[^$\\])(\$\$([^$\n]+?)\$\$)$/, handler: ({ range, match, chain }) => {
        const from = range.from + (match[0].length - match[1].length);
        chain().insertContentAt({ from, to: range.to }, { type: "inlineMath", attrs: { latex: match[2].trim(), display: true } }).run();
      } }),
      new InputRule({ find: /(?:^|[^$\\])(\$([^$\s](?:[^$]*[^$\s\\])?)\$)$/, handler: ({ range, match, chain }) => {
        const from = range.from + (match[0].length - match[1].length);
        chain().insertContentAt({ from, to: range.to }, { type: "inlineMath", attrs: { latex: match[2] } }).run();
      } }),
      // [字](网址)、<网址>
      new InputRule({ find: /(?:^|[^!\\\]])(\[([^[\]\n]+)\]\(([^()\s]+)\))$/, handler: ({ state, range, match }) => {
        const from = range.from + (match[0].length - match[1].length);
        state.tr.replaceWith(from, range.to, s.text(match[2], [...state.doc.resolve(from).marks(), s.marks.link.create({ href: match[3] })]));
      } }),
      new InputRule({ find: /(<((?:https?:\/\/|mailto:)[^<>\s]+)>)$/, handler: ({ state, range, match }) => {
        const from = range.from + (match[0].length - match[1].length);
        state.tr.replaceWith(from, range.to, s.text(match[2], [s.marks.link.create({ href: match[2] })]));
      } }),
      // ![说明](地址)：行内图片
      new InputRule({ find: /(?:^|[^\\])(!\[([^\]\n]*)\]\(([^()\s]+)\))$/, handler: ({ state, range, match }) => {
        const from = range.from + (match[0].length - match[1].length);
        state.tr.replaceWith(from, range.to, s.nodes.image.create({ src: match[3], alt: match[2] }));
      } }),
      // ***粗斜体***
      new InputRule({ find: /(?:^|[^*\\])(\*\*\*([^*\s](?:[^*]*[^*\s])?)\*\*\*)$/, handler: ({ state, range, match }) => {
        const from = range.from + (match[0].length - match[1].length);
        state.tr.replaceWith(from, range.to, s.text(match[2], [...state.doc.resolve(from).marks(), s.marks.bold.create(), s.marks.italic.create()]));
        state.tr.setStoredMarks([]);
      } }),
      // 行内代码：反引号一串配一串一样长的（``a ` b`` 里的单个 ` 是字）。TipTap 自带的会把 `` 里的 ` y` 先转掉，关掉了
      new InputRule({ find: codeSpanAtEnd, handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, s.text(match[1], [...state.doc.resolve(range.from).marks(), s.marks.code.create()]));
        state.tr.setStoredMarks([]);
      } }),
      // <u>下划线</u>、<kbd>键</kbd>
      new InputRule({ find: /<(u|kbd)>([^<>\n]+)<\/\1>$/, handler: ({ state, range, match }) => {
        const mark = match[1] === "u" ? s.marks.underline : s.marks.kbd;
        state.tr.replaceWith(range.from, range.to, s.text(match[2], [...state.doc.resolve(range.from).marks(), mark.create()]));
        state.tr.setStoredMarks([]);
      } }),
      // 1) 也是有序列表（CommonMark）；写回成 1.
      wrappingInputRule({ find: /^(\d+)\)\s$/, type: s.nodes.orderedList, getAttributes: (m) => ({ start: +m[1] }), joinPredicate: (m, n) => n.childCount + n.attrs.start === +m[1] }),
      // 段首 [^1]: 加空格：跳到脚注 1 的定义里写（没有这个脚注就留着字）
      new InputRule({ find: /^\[\^([^\]\s]+)\]:\s$/, handler: ({ state, range, match }) => {
        const $f = state.doc.resolve(range.from);
        if ($f.parent.type.name !== "paragraph" || range.from !== $f.start() || $f.depth !== 1) return null;
        let id: string | undefined;
        state.doc.descendants((n) => { if (!id && n.type.name === "footnoteReference" && String(n.attrs.referenceNumber) === match[1]) id = n.attrs["data-id"]; });
        let at = -1;
        if (id) state.doc.descendants((n, pos) => { if (at < 0 && n.type.name === "footnote" && n.attrs["data-id"] === id) at = pos; });
        if (at < 0) return null;
        const tr = state.tr;
        // 这一段里冒号后面还有字的话一起搬过去
        const rest = $f.parent.content.cut(range.to - $f.start());
        const fn = state.doc.nodeAt(at)!, end = at + fn.nodeSize - 2; // 脚注里最后一段的末尾
        if (fn.lastChild?.type.name !== "paragraph") return null;
        if (rest.size) tr.insert(end, rest);
        const caret = end + rest.size;
        const pStart = $f.before(), pEnd = $f.after();
        tr.delete(pStart, pEnd);
        const m = tr.mapping.map(caret);
        tr.setSelection(TextSelection.near(tr.doc.resolve(m), -1));
        return undefined;
      } }),
      // 列表项里打 [ ] / [x] 加空格：这一项变成任务（前后的项还是普通列表）
      new InputRule({ find: /^\[([ xX]?)\]\s$/, handler: ({ state, range, match }) => {
        const $f = state.doc.resolve(range.from);
        if ($f.depth < 3 || $f.node(-1).type.name !== "listItem" || $f.index(-1) !== 0 || $f.node(-2).type.name !== "bulletList") return null;
        const list = $f.node(-2), li = $f.node(-1), i = $f.index(-2), listStart = $f.before(-2);
        const para = li.child(0).cut(range.to - $f.start());
        const item = s.nodes.taskItem.create({ checked: /x/i.test(match[1]) }, [para, ...li.content.content.slice(1)]);
        const parts: PMNode[] = [];
        const before = list.content.content.slice(0, i), after = list.content.content.slice(i + 1);
        if (before.length) parts.push(list.type.create(list.attrs, before));
        parts.push(s.nodes.taskList.create(null, item));
        if (after.length) parts.push(list.type.create(list.attrs, after));
        const tr = state.tr.replaceWith(listStart, listStart + list.nodeSize, parts);
        const itemStart = listStart + (before.length ? parts[0].nodeSize : 0) + 1; // taskList 里
        tr.setSelection(TextSelection.near(tr.doc.resolve(itemStart + 2)));
        return undefined;
      } }),
      // ```语言 加回车：代码块（TipTap 自带的只认小写字母的语言名）
      enterRule(/^```([\w+#.-]*)\n$/, (m) => ({ nodes: [s.nodes.codeBlock.create({ language: m[1] || null })], caret: (st) => st + 1 })),
      // $$ 加回车：空的公式块，打开源码框
      enterRule(/^\$\$\n$/, () => ({ nodes: [s.nodes.blockMath.create({ latex: "" })], then: (st) => openMath(ed, st) })),
      // *** / ___ / --- 加回车：分隔线
      enterRule(/^(?:\*\*\*|___|---)\n$/, () => ({ nodes: [s.nodes.horizontalRule.create()] })),
      // 上一段下面一行 === 加回车：上一段变一级标题（setext）
      new InputRule({ find: /^=+\n$/, undoable: false, handler: ({ state, range }) => {
        const $f = state.doc.resolve(range.from);
        if ($f.parent.type.name !== "paragraph" || range.from !== $f.start() || range.to !== $f.end() || $f.index(-1) === 0) return null;
        const prev = $f.node(-1).child($f.index(-1) - 1);
        if (prev.type.name !== "paragraph" || !prev.content.size) return null;
        const start = $f.before() - prev.nodeSize;
        const tr = state.tr.replaceWith(start, $f.after(), [s.nodes.heading.create({ level: 1 }, prev.content), s.nodes.paragraph.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(start + prev.nodeSize + 1)));
        return undefined;
      } }),
      // <details> 加回车：折叠块，光标在标题里
      enterRule(/^<details>\n$/i, () => ({
        nodes: [s.nodes.details.create(null, [s.nodes.detailsSummary.create(), s.nodes.detailsContent.create(null, s.nodes.paragraph.create())])],
        caret: (st) => st + 2,
      })),
      // |a|b| 加回车：以这一行为表头的表格，光标在第一格
      enterRule(/^\|(.+)\|\n$/, (m) => {
        const heads = m[1].split("|").map((x) => x.trim());
        if (!heads.length || heads.length > 20) return null;
        const cell = (t: string, type: "tableHeader" | "tableCell") => s.nodes[type].create(null, s.nodes.paragraph.create(null, t ? s.text(t) : null));
        const table = s.nodes.table.create(null, [
          s.nodes.tableRow.create(null, heads.map((h) => cell(h, "tableHeader"))),
          s.nodes.tableRow.create(null, heads.map(() => cell("", "tableCell"))),
        ]);
        // 第二行第一格：表格 1 + 第一行 + 行 1 + 格 1 + 段落 1
        return { nodes: [table], caret: (st) => st + 1 + table.child(0).nodeSize + 3 };
      }),
    ];
  },

  addKeyboardShortcuts() {
    const e = this.editor;
    return {
      // 紧跟在自动转换后面：撤回成打的字（Typora 一样）；否则普通撤销
      "Mod-z": () => e.commands.undoInputRule() || e.commands.undo(),
      // keymap 找不到带 Shift 的会退回去找不带的（key 是小写 z 时），先在这里接住重做
      "Shift-Mod-z": () => e.commands.redo(),
      Enter: () => {
        const sel = e.state.selection;
        // 选中的公式：打开源码框
        if (sel instanceof NodeSelection && /^(inlineMath|blockMath)$/.test(sel.node.type.name)) { this.options.openMath(e, sel.from); return true; }
        // 一段里只有一个 $$m$$：变成公式块
        const $h = sel.$head, p = $h.parent;
        if (sel.empty && p.type.name === "paragraph" && p.childCount === 1 && p.firstChild!.type.name === "inlineMath" && p.firstChild!.attrs.display) {
          const start = $h.before();
          const tr = closeHistory(e.state.tr).replaceWith(start, $h.after(), e.schema.nodes.blockMath.create({ latex: p.firstChild!.attrs.latex }));
          const end = start + tr.doc.nodeAt(start)!.nodeSize;
          if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, e.schema.nodes.paragraph.create());
          e.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1))));
          return true;
        }
        return false;
      },
      Backspace: () => {
        const sel = e.state.selection;
        if (!sel.empty) return false;
        const $h = sel.$head;
        // 紧跟在公式后面：公式变回源码，删掉最后那个 $（再打 $ 又变回公式）
        const before = $h.nodeBefore;
        if (before?.type.name === "inlineMath") {
          const d = before.attrs.display ? "$$" : "$";
          const src = `${d}${before.attrs.latex}${d}`.slice(0, -1);
          const from = $h.pos - before.nodeSize;
          e.view.dispatch(e.state.tr.replaceWith(from, $h.pos, e.schema.text(src, $h.marks())));
          return true;
        }
        if ($h.parentOffset !== 0) return false;
        if (e.commands.undoInputRule()) return true;
        // 标题行首：变回普通段落
        if ($h.parent.type.name === "heading") return e.commands.setParagraph();
        // 列表项、引用的第一段开头：拿出来变回正文
        if ($h.depth >= 2 && $h.index(-1) === 0) {
          const outer = $h.node(-1).type.name;
          if (outer === "listItem" || outer === "taskItem") return e.commands.liftListItem(outer);
          if (outer === "blockquote") return e.commands.lift("blockquote");
        }
        return false;
      },
      // Typora 的块级快捷键：⌘1–6 标题、⌘0 正文、⌘= / ⌘- 升降级
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((l) => [`Mod-${l}`, () => e.commands.setHeading({ level: l as 1 })])),
      "Mod-0": () => e.commands.setParagraph(),
      "Mod-=": () => headingStep(e, -1),
      "Mod--": () => headingStep(e, 1),
      "Mod-Alt-o": () => e.commands.toggleOrderedList(),
      "Mod-Alt-u": () => e.commands.toggleBulletList(),
      "Mod-Alt-q": () => e.commands.toggleBlockquote(),
      "Mod-Alt-x": () => e.commands.toggleTaskList(),
      // ⌘⌥T 表格、⌘⌥B 公式块：放在这一段后面（空段就换掉它），不把这一段拆开
      "Mod-Alt-t": () => {
        const s = e.schema, row = (t: "tableHeader" | "tableCell") => s.nodes.tableRow.create(null, [0, 1].map(() => s.nodes[t].create(null, s.nodes.paragraph.create())));
        const table = s.nodes.table.create(null, [row("tableHeader"), row("tableCell"), row("tableCell")]);
        return blockAfter(e, table, (st) => st + 4);
      },
      "Mod-Alt-b": () => blockAfter(e, e.schema.nodes.blockMath.create({ latex: "" }), undefined, (st) => this.options.openMath(e, st)),
      "Mod-]": () => e.commands.sinkListItem(listType(e)),
      "Mod-[": () => e.commands.liftListItem(listType(e)),
      // ⌘⇧` 行内代码；Mac 上 ⌃⇧` 删除线（Windows / Linux 上这两个是同一个键，归行内代码）
      "Mod-Shift-`": () => e.commands.toggleCode(),
      ...(IS_MAC ? { "Ctrl-Shift-`": () => e.commands.toggleStrike() } : {}),
      // ⌘D 选中光标处的词，⌘L 选中这一段
      "Mod-d": () => selectWord(e),
      "Mod-l": () => { const $h = e.state.selection.$head; if (!$h.parent.isTextblock) return false; e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, $h.start(), $h.end()))); return true; },
      // 表格里 ⌘↵：下面加一行，光标到新行第一格（表格外才是保存退出）
      "Mod-Enter": () => {
        const $h = e.state.selection.$head;
        let row = -1;
        for (let d = $h.depth; d > 0; d--) if ($h.node(d).type.name === "tableRow") { row = d; break; }
        if (row < 0) return false;
        const after = $h.after(row);
        if (!e.commands.addRowAfter()) return false;
        e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(after + 3))));
        return true;
      },
      // ⌘⇧X 也是删除线（⌘⇧S 是 TipTap 自带的）
      "Mod-Shift-x": () => e.commands.toggleStrike(),
      "Mod-k": () => { this.options.openLink(e); return true; },
      // ⌘⇧V：粘贴成纯文字（不当 Markdown、不要格式）
      "Mod-Shift-v": () => {
        void navigator.clipboard?.readText?.().then((t) => { if (t && !e.isDestroyed) e.view.dispatch(e.state.tr.insertText(t.replace(/\r\n?/g, "\n"))); }).catch(() => {});
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({ key: markerKey, props: { decorations: markerDecos } })];
  },
});
