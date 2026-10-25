// 照 Typora 的“边写边变”：
// - 行内：打完收尾的记号就变。解析器（schema.ts）能判断的不另写规则：刚收尾、到光标为止的那一段按解析器解析（retype）；
//   **b** *i* _i_ ~~s~~ 用 TipTap 自带的，`c` 按反引号的长度配对（codeSpanAtEnd）
// - 块：# > - 1. [ ] 加空格用 TipTap 自带的；回车时整段解析出来是代码块、分隔线、目录、公式块的就换成它（enterBlock）；
//   $$ / === / <details> / |表|头| 加回车另有规则（解析器认不出来）
// - 光标移进格式文字、标题、行内公式时展开成能改的 Markdown 原文（source.ts）；还没展开时（刚打完）照旧把记号画在两头（装饰）
// - ⌘Z 紧跟在自动转换后面：撤回成打的字；标题行首退格：变回普通段落
// - 一次进来一大段字（接受补全、粘贴）时打字规则不会触发：把这一段当 Markdown 重新解析一遍（reconvert）
import { Extension, InputRule, Mark as TMark, wrappingInputRule, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Fragment, type Mark, type Node as PMNode, type ResolvedPos, type Schema } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { ESC_MARK, MARK_MD, blockSource, parseSource } from "../schema";
import { SourceMark, headPrefix, sourcePlugin, srcRuns } from "./source";
import { pairsPlugin } from "./pairs";

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
  if (srcRuns(block).length) return tr; // 展开着的原文：光标离开时会整段重新解析
  const src = blockSource(block.toJSON());
  if (!src.trim()) return tr;
  const schema = tr.doc.type.schema;
  let nodes: PMNode[];
  try { nodes = parseSource(src, false)!.map((n) => schema.nodeFromJSON(n)); } catch { return tr; }
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

/** 能收尾一段行内语法的字 → 那段语法开头可能的字 */
const OPENERS: Record<string, string> = { "*": "*", "~": "~", "=": "=", "^": "^", "$": "$", ")": "[!", ">": "<", ":": ":", "]": "[" };
/** 这几种格式打字时用 TipTap 自带的规则（**b** *i* _i_ ~~s~~）；***粗斜体*** 这里变 */
const NATIVE = new Set(["bold", "italic", "strike"]);
const hasFootnote = (f: Fragment) => { let y = false; f.descendants((n) => { if (n.type.name === "footnoteReference") y = true; }); return y; };

/**
 * cut（开头字前面一个字 + 从开头字到光标）解析出来，前面那个字照旧、后面正好是一整段新格式时给这一段：
 * 一个原子节点（公式、图片、表情、引用），或者都带着同一个新的格式。前面那个字只是给解析器看左边（1:100: 不是表情）
 */
function spanOf(ctx: Fragment, cut: Fragment, schema: Schema): Fragment | null {
  const ns = parseSource(blockSource({ type: "paragraph", content: ctx.append(cut).toJSON() }), true);
  if (!ns?.length) return null;
  let all: Fragment;
  try { all = Fragment.fromArray(ns.map((j) => schema.nodeFromJSON(j))); } catch { return null; }
  if (!all.cut(0, ctx.size).eq(ctx)) return null;
  const f = all.cut(ctx.size);
  if (!f.size || f.eq(cut) || hasFootnote(f)) return null;
  if (f.childCount === 1 && !f.firstChild!.isText) return f;
  let common: readonly Mark[] | null = null;
  f.forEach((n) => { common = n.isText ? (common ?? n.marks).filter((m) => m.isInSet(n.marks)) : []; });
  const fresh = (common as readonly Mark[] | null ?? []).filter((m) => !m.isInSet(cut.firstChild!.marks)).map((m) => m.type.name);
  if (!fresh.length) return null;
  if (fresh.every((n) => NATIVE.has(n)) && !(fresh.includes("bold") && fresh.includes("italic"))) return null;
  return f;
}

/**
 * 打字时的行内转换（==hl== H~2~ x^2^ $m$ [t](u) ![a](u) <u>u</u> :e: [[R]] ***bi***）：只看刚打完收尾记号、到光标为止的那一段，
 * 和以前一条条的规则一样——从左往右找一个开头字，从它到光标解析出来正好是一整段新格式就换掉（同一个 transaction，⌘Z 撤回成打的字）。
 * 开头字前面紧挨着同样的字或 \ 时不算（**b* 里的 *b*、~~s~ 里的 ~s~、\$）；前面撤回成字的不会再变；
 * 光标后面的不动（自动补的右括号）；最后一个脚注引用之前的不动，解析出脚注引用也不要。
 * pos：刚打的字后面（打字规则给的 range.to）；盖过自动补的右括号时光标还在那个字前面，不能看光标
 */
export function retype(tr: Transaction, pos = tr.selection.head): boolean {
  const sel = tr.selection, $c = tr.doc.resolve(pos), block = $c.parent, end = $c.parentOffset;
  if (!sel.empty || !block.isTextblock || block.type.spec.code || srcRuns(block).length || end < 2) return false;
  const at = (i: number) => block.textBetween(i, i + 1, undefined, "\ufffc");
  const typed = at(end - 1), opens = OPENERS[typed];
  if (!opens) return false;
  let lo = 0;
  block.forEach((n, off) => { if (n.type.name === "footnoteReference" && off < end) lo = off + n.nodeSize; });
  for (let i = lo; i < end - 1; i++) {
    if (!opens.includes(at(i))) continue;
    const prev = i > lo ? at(i - 1) : "";
    if (prev === typed || prev === "\\") continue;
    const span = spanOf(block.content.cut(Math.max(lo, i - 1), i), block.content.cut(i, end), tr.doc.type.schema);
    if (!span) continue;
    const start = $c.start() + i, marks = $c.marks();
    tr.replaceWith(start, $c.pos, span);
    // 这一段只剩刚变出来的这一个（一整行的 $$m$$）：照存回去再读进来的样子换成块（公式块），编辑时和显示时一样。
    // 表格的格子里写回去是一行行内内容，还是行内的
    const $s = tr.doc.resolve(start), p = $s.parent;
    if (p.type.name === "paragraph" && p.childCount === 1 && span.childCount === 1 && !span.firstChild!.isText && !$s.node(-1).type.spec.tableRole) {
      const n = soleBlock(p, tr.doc.type.schema);
      if (n && !n.isTextblock && n.isAtom && swapBlock(tr, $s, n)) return true;
    }
    tr.setSelection(TextSelection.create(tr.doc, start + span.size));
    tr.setStoredMarks(marks); // 接着打的字不带刚变出来的格式
    return true;
  }
  return false;
}

/** 一段（段落）当 Markdown 原文按块解析出来正好是一个块时给它（存回去再读进来就是它） */
function soleBlock(p: PMNode, schema: Schema): PMNode | null {
  const src = blockSource(p.toJSON());
  if (/^(?: {4}|\t)/.test(src)) return null; // 缩进的代码块打字时不变（Typora 一样）
  try {
    const ns = parseSource(src, false)!.map((j) => schema.nodeFromJSON(j));
    return ns.length === 1 ? ns[0] : null;
  } catch { return null; }
}
/** $in 所在的这一段换成块 n：代码块光标放进去，别的放到它后面那一段（没有就补一个） */
function swapBlock(tr: Transaction, $in: ResolvedPos, n: PMNode): boolean {
  const start = $in.before(), $s = tr.doc.resolve(start);
  if (!$s.parent.canReplace($s.index(), $s.index() + 1, Fragment.from(n))) return false;
  tr.replaceWith(start, $in.after(), n);
  const end = start + n.nodeSize;
  if (n.type.spec.code) tr.setSelection(TextSelection.create(tr.doc, end - 1));
  else {
    if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, tr.doc.type.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
    tr.setStoredMarks([]);
  }
  return true;
}

/** 回车：整段（光标在段尾）解析出来是一个不是字的块（代码块、分隔线、目录、公式块）时换成它 */
function enterBlock(state: EditorState): boolean {
  const tr = state.tr, $c = tr.selection.$head, p = $c.parent;
  if (!tr.selection.empty || p.type.name !== "paragraph" || !p.content.size || $c.parentOffset !== p.content.size) return false;
  const n = soleBlock(p, state.schema);
  if (!n || !(n.isAtom || n.type.spec.code)) return false;
  return swapBlock(tr, $c, n);
}
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
function markerDecos(state: EditorState): DecorationSet | null {
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
  // 展开着的原文：里面的记号淡一点
  for (const r of srcRuns(p)) {
    for (const m of r.text.matchAll(/^#{1,6}[ \t]+|\*+|_+|~+|==|\^|`+|\$+|\\(?=[!-/:-@[-`{-~])|!?\[|\]\([^)]*\)|\]/g)) {
      ds.push(Decoration.inline(start + r.from + m.index!, start + r.from + m.index! + m[0].length, { class: "md-mkc" }));
    }
  }
  // 记号用 CSS 的 ::before / ::after 画（attr(data-mk…)）：插一个不可编辑的小部件的话，Home / End、上下键会卡在它上面
  if (p.type.name === "heading" && !srcRuns(p).some((r) => r.from === 0)) ds.push(Decoration.node($h.before(), $h.after(), { class: "md-mkh", "data-mka": `${"#".repeat(p.attrs.level)} ` }));
  const near = [...($h.nodeBefore?.marks ?? []), ...($h.nodeAfter?.marks ?? [])];
  const seen = new Set<string>();
  for (const m of near) {
    const f = MARK_MD[m.type.name];
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
    const [a, b] = f(m.attrs);
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
/** 在光标这一段后面放一个块（这一段是空的就换掉它）；caret 给出光标位置，不给就选中它 */
function blockAfter(e: Editor, node: PMNode, caret?: (start: number) => number) {
  const $h = e.state.selection.$head;
  if ($h.depth < 1) return false;
  const d = $h.depth, empty = $h.parent.isTextblock && !$h.parent.content.size;
  const from = empty ? $h.before(d) : $h.after(d), to = empty ? $h.after(d) : from;
  const $f = e.state.doc.resolve(from);
  if (!$f.parent.canReplaceWith($f.index(), $f.indexAfter(), node.type)) return false;
  const tr = closeHistory(e.state.tr).replaceWith(from, to, node);
  tr.setSelection(caret ? TextSelection.near(tr.doc.resolve(caret(from))) : NodeSelection.create(tr.doc, from));
  e.view.dispatch(tr.scrollIntoView());
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

/** 打字时的转义 \X 里的那个 \（#27）：光标不在旁边时不显示；写出时原样是 \X（schema.ts 的 escPairs） */
const EscMark = TMark.create({ name: ESC_MARK, inclusive: false, parseHTML: () => [], renderHTML: () => ["span", { class: "md-esc" }, 0] });
const escKey = new PluginKey("cbEsc");
/** 光标不在旁边（\ 前、\ 和字之间、字后面）的转义 \：藏起来 */
function escDecos(state: EditorState): DecorationSet | null {
  const type = state.schema.marks[ESC_MARK], h = state.selection.head, ds: Decoration[] = [];
  state.doc.descendants((n, pos) => {
    if (!n.isText) return true;
    if (type.isInSet(n.marks) && !(state.selection.empty && h >= pos && h <= pos + n.nodeSize + 1)) ds.push(Decoration.inline(pos, pos + n.nodeSize, { class: "md-esch" }));
    return false;
  });
  return ds.length ? DecorationSet.create(state.doc, ds) : null;
}

export const Typora = Extension.create<{ openMath: (e: Editor, pos: number) => void; openLink: (e: Editor) => void }>({
  name: "cbTypora",
  // 规则要排在 TipTap 自带的（代码块、任务）前面；Tab / Esc 还是灰字先拿（1000）
  priority: 900,
  addOptions() { return { openMath: () => {}, openLink: () => {} }; },
  addExtensions() { return [SourceMark, EscMark]; },

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
          if (r.then) queueMicrotask(() => r.then!(start)); // 派发完马上打开（下一个键就打进公式原文）
          return undefined;
        },
      });
    return [
      // 反斜杠后面打标点：这一对是转义（#27）。\ 带 mdEsc 标记（平时不显示，写出时原样 \X）；\ 自己是被转义的那个字时不算
      // （这一版 TipTap 先把打的字插进去了，range 已经包含它）
      new InputRule({ find: /\\[!-/:-@[-`{-~]$/, handler: ({ state, range }) => {
        const esc = s.marks[ESC_MARK], at = range.from;
        if (at > 0 && state.doc.rangeHasMark(at - 1, at, esc)) return null;
        state.tr.addMark(at, at + 1, esc.create());
      } }),
      // 行内格式、公式、链接、图片、表情、[[引用]]：打完收尾的字就重解析（retype）
      new InputRule({
        find: (text) => { const c = text.slice(-1), o = OPENERS[c]; return o && [...o].some((x) => text.slice(0, -1).includes(x)) ? { index: text.length - 1, text: c } : null; },
        handler: ({ state, range }) => (retype(state.tr, range.to) ? undefined : null),
      }),
      // 行内代码：反引号一串配一串一样长的（``a ` b`` 里的单个 ` 是字）。TipTap 自带的会把 `` 里的 ` y` 先转掉，关掉了
      new InputRule({ find: codeSpanAtEnd, handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, s.text(match[1], [...state.doc.resolve(range.from).marks(), s.marks.code.create()]));
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
      // ```语言 / *** / --- / ___ / [toc] / 一整行的 $$m$$ 加回车：解析出来的块（enterBlock）
      new InputRule({ find: (text) => (text.endsWith("\n") ? { index: text.length - 1, text: "\n" } : null), undoable: false, handler: ({ state }) => (enterBlock(state) ? undefined : null) }),
      // $$ 加回车：空的公式块，展开原文
      enterRule(/^\$\$\n$/, () => ({ nodes: [s.nodes.blockMath.create({ latex: "" })], then: (st) => openMath(ed, st) })),
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
        // 展开着的标题，光标紧跟在 "## " 后面：一次退一个 #（## → # → 普通段落，和 Typora 一样；没展开时在行首退格也一样）
        const pre = headPrefix($h.parent);
        if (pre && $h.parentOffset === pre) {
          const st = $h.start(), level = /^#*/.exec($h.parent.textBetween(0, pre))![0].length, tr = e.state.tr;
          if (level > 1) tr.delete(st + level - 1, st + level).setNodeMarkup($h.before(), undefined, { ...$h.parent.attrs, level: level - 1 });
          else tr.delete(st, st + pre).setNodeMarkup($h.before(), e.schema.nodes.paragraph);
          e.view.dispatch(tr);
          return true;
        }
        if ($h.parentOffset !== 0) return false;
        if (e.commands.undoInputRule()) return true;
        // 标题行首：降一级，一级标题变回普通段落
        if ($h.parent.type.name === "heading") {
          const level = $h.parent.attrs.level as number;
          return level > 1 ? e.commands.setHeading({ level: (level - 1) as 1 }) : e.commands.setParagraph();
        }
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
      "Mod-Alt-b": () => blockAfter(e, e.schema.nodes.blockMath.create({ latex: "" })), // 选中它：公式块展开原文（mathblock.ts）
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
      // ⌘⇧H 高亮（==hl==）
      "Mod-Shift-h": () => e.commands.toggleMark("highlight"),
      "Mod-k": () => { this.options.openLink(e); return true; },
      // ⌘⇧V：粘贴成纯文字（不当 Markdown、不要格式）
      "Mod-Shift-v": () => {
        void navigator.clipboard?.readText?.().then((t) => { if (t && !e.isDestroyed) e.view.dispatch(e.state.tr.insertText(t.replace(/\r\n?/g, "\n"))); }).catch(() => {});
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [pairsPlugin(), sourcePlugin(), new Plugin({ key: markerKey, props: { decorations: markerDecos } }), new Plugin({ key: escKey, props: { decorations: escDecos } })];
  },
});
