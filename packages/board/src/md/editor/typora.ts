// 照 Typora 的“边写边变”：
// - 块：行首 ``` / $$ / *** / ___ / |表|头| 加回车，[ ] 加空格（# > - 1. --- 用 TipTap 自带的）
// - 行内：结尾记号一打完就变（**b** *i* ~~s~~ `c` 用 TipTap 自带的；这里加 $m$ $$m$$ [t](url) <url>）
// - 光标所在处显示 Markdown 记号（只是装饰，不进文档）：标题的 ##、粗体斜体代码链接两头的记号、选中的行内公式的源码
// - ⌘Z 紧跟在自动转换后面：撤回成打的字；标题行首退格：变回普通段落
// - 一次进来一大段字（接受补全、粘贴）时打字规则不会触发：把这一段当 Markdown 重新解析一遍（reconvert）
import { Extension, InputRule, type Editor } from "@tiptap/core";
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
  link: (m) => ["[", `](${m.attrs.href ?? ""})`],
};
const mkEl = (text: string) => {
  const s = document.createElement("span");
  s.className = "md-mk";
  s.textContent = text;
  s.contentEditable = "false";
  return s;
};
const markerKey = new PluginKey("cbMarkers");

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
          if (r.then) setTimeout(() => r.then!(start));
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
      // ![说明](地址) 单独一段：换成图片块（图片在这里是块）
      new InputRule({ find: /^!\[([^\]\n]*)\]\(([^()\s]+)\)$/, handler: ({ state, range, match }) => {
        const $f = state.doc.resolve(range.from);
        if ($f.parent.type.name !== "paragraph" || range.from !== $f.start() || range.to !== $f.end()) return null;
        const start = $f.before(), img = s.nodes.image.create({ src: match[2], alt: match[1] });
        const tr = state.tr.replaceWith(start, $f.after(), [img, s.nodes.paragraph.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(start + img.nodeSize + 1)));
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
      // *** / ___ 加回车：分隔线（--- 打完就变）
      enterRule(/^(?:\*\*\*|___|---)\n$/, () => ({ nodes: [s.nodes.horizontalRule.create()] })),
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
      // 标题行首退格：变回普通段落
      Backspace: () => {
        const sel = e.state.selection;
        if (!sel.empty || sel.$head.parentOffset !== 0 || sel.$head.parent.type.name !== "heading") return false;
        if (e.commands.undoInputRule()) return true;
        return e.commands.setParagraph();
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
