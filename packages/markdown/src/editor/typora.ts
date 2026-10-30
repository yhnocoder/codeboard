// Typing rules and shortcuts. Inline formatting needs no rules: a paragraph is its own Markdown source, so what was
// typed is what is stored, and inline.ts draws it. Blocks are still nodes:
// - `> ` `- ` `1. ` `[ ] ` plus space use TipTap's own wrapping rules (and `1) ` here);
// - on Enter, a paragraph whose whole source parses as one non-text block (code fence, rule, [toc], one-line $$m$$)
//   becomes that block (enterBlock); `$$`, `===`, `<details>` and `|a|b|` plus Enter have their own rules.
// Shortcuts that format (⌘B, ⌘I…) insert or remove markers around the selection; heading shortcuts edit the `#` prefix.
import { Extension, InputRule, wrappingInputRule, type Editor } from "@tiptap/core";
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { parseMd } from "../schema";
import { pairsPlugin } from "./pairs";
import { blockInfo } from "./spans";
import { inlinePlugin, revealMeta, toggleWrap } from "./inline";
import { sourceBlock } from "./srcdoc";

/** The block a paragraph's source parses as, when it is exactly one (what saving and reloading would make of it) */
function soleBlock(p: PMNode, schema: EditorState["schema"]): PMNode | null {
  const src = p.textContent;
  if (/^(?: {4}|\t)/.test(src)) return null; // an indented code block does not form while typing (as in Typora)
  try {
    const ns = (parseMd(src).content ?? []).filter((n) => n.type !== "footnotes");
    return ns.length === 1 ? schema.nodeFromJSON(sourceBlock(ns[0])) : null;
  } catch { return null; }
}
/** Replaces the paragraph at $in with block n: the caret goes into a code block, otherwise after it */
function swapBlock(tr: Transaction, $in: ResolvedPos, n: PMNode): boolean {
  const start = $in.before(), $s = tr.doc.resolve(start);
  if (!$s.parent.canReplace($s.index(), $s.index() + 1, Fragment.from(n))) return false;
  tr.replaceWith(start, $in.after(), n);
  const end = start + n.nodeSize;
  if (n.type.spec.code) tr.setSelection(TextSelection.create(tr.doc, end - 1));
  else {
    if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, tr.doc.type.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
  }
  return true;
}
/** Enter at the end of a paragraph that parses as a block that is not text (code block, rule, toc, formula): swap it in */
export function enterBlock(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const tr = state.tr, $c = tr.selection.$head, p = $c.parent;
  if (!tr.selection.empty || p.type.name !== "paragraph" || !p.content.size || $c.parentOffset !== p.content.size) return false;
  if ($c.depth && /cell/.test($c.node(-1).type.spec.tableRole ?? "")) return false;
  const n = soleBlock(p, state.schema);
  if (!n || !(n.isAtom || n.type.spec.code) || !swapBlock(tr, $c, n)) return false;
  dispatch?.(tr);
  return true;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** Sets the heading level of the caret's paragraph by rewriting its `#` prefix (0 = plain paragraph) */
export function setHeading(e: Editor, level: number | ((cur: number) => number)): boolean {
  const $h = e.state.selection.$head, p = $h.parent;
  if (!p.isTextblock || p.type.name !== "paragraph" || ($h.depth && /cell/.test($h.node(-1).type.spec.tableRole ?? ""))) return false;
  const info = blockInfo(p.textContent, true), next = Math.max(0, Math.min(6, typeof level === "function" ? level(info.level) : level));
  if (next === info.level) return true;
  const start = $h.start(), prefix = next ? `${"#".repeat(next)} ` : "";
  const tr = e.state.tr.insertText(prefix, start, start + info.prefix);
  e.view.dispatch(revealMeta(tr));
  return true;
}
const listType = (e: Editor) => {
  const $h = e.state.selection.$head;
  for (let d = $h.depth; d > 0; d--) { const n = $h.node(d).type.name; if (n === "listItem" || n === "taskItem") return n; }
  return "listItem";
};
/** Puts a block after the caret's paragraph (replacing it when empty); caret gives the caret position, else it is selected */
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
  const t = p.textContent, o = $h.parentOffset;
  const w = /[\p{L}\p{N}_]/u;
  let a = o, b = o;
  while (a > 0 && w.test(t[a - 1])) a--;
  while (b < t.length && w.test(t[b])) b++;
  if (a === b) return false;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, $h.start() + a, $h.start() + b)));
  return true;
}
const wrap = (e: Editor, open: string, close = open) => toggleWrap(e.state, e.view.dispatch, open, close);

export const Typora = Extension.create<{ openMath: (e: Editor, pos: number) => void; openLink: (e: Editor) => void }>({
  name: "cbTypora",
  // ahead of TipTap's own rules (code block, task); ghost text still takes Tab / Esc first (1000)
  priority: 900,
  addOptions() { return { openMath: () => {}, openLink: () => {} }; },

  addInputRules() {
    const s = this.editor.schema;
    const openMath = this.options.openMath;
    const ed = this.editor;
    /** A rule triggered by Enter: the paragraph becomes `nodes`, the caret goes to caret(start), or into the next paragraph */
    const enterRule = (find: RegExp, make: (m: RegExpMatchArray, state: EditorState, start: number) => { nodes: PMNode[]; from?: number; caret?: (start: number) => number; then?: (start: number) => void } | null) =>
      new InputRule({
        find, undoable: false,
        handler: ({ state, range, match }) => {
          const $f = state.doc.resolve(range.from);
          if ($f.parent.type.name !== "paragraph" || range.from !== $f.start() || range.to !== $f.end()) return null;
          if (/cell/.test($f.node(-1).type.spec.tableRole ?? "")) return null;
          const r = make(match, state, $f.before());
          if (!r) return null;
          const frag = Fragment.from(r.nodes);
          const start = r.from ?? $f.before();
          if (r.from === undefined && !$f.node(-1).canReplace($f.index(-1), $f.index(-1) + 1, frag)) return null;
          const tr = state.tr.replaceWith(start, $f.after(), frag);
          const caret = r.caret?.(start);
          if (caret !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
          else {
            const end = start + frag.size;
            if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, s.nodes.paragraph.create());
            tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
          }
          if (r.then) queueMicrotask(() => r.then!(start)); // open right after dispatch: the next key goes into the formula
          return undefined;
        },
      });
    const para = (t: string) => s.nodes.paragraph.create(null, t ? s.text(t) : null);
    return [
      // 1) is an ordered list too (CommonMark); written back as 1.
      wrappingInputRule({ find: /^(\d+)\)\s$/, type: s.nodes.orderedList, getAttributes: (m) => ({ start: +m[1] }), joinPredicate: (m, n) => n.childCount + n.attrs.start === +m[1] }),
      // [ ] / [x] plus space in a list item: this item becomes a task (the items around it stay a plain list)
      new InputRule({ find: /^\[([ xX]?)\]\s$/, handler: ({ state, range, match }) => {
        const $f = state.doc.resolve(range.from);
        if ($f.depth < 3 || $f.node(-1).type.name !== "listItem" || $f.index(-1) !== 0 || $f.node(-2).type.name !== "bulletList") return null;
        const list = $f.node(-2), li = $f.node(-1), i = $f.index(-2), listStart = $f.before(-2);
        const p = li.child(0).cut(range.to - $f.start());
        const item = s.nodes.taskItem.create({ checked: /x/i.test(match[1]) }, [p, ...li.content.content.slice(1)]);
        const parts: PMNode[] = [];
        const before = list.content.content.slice(0, i), after = list.content.content.slice(i + 1);
        if (before.length) parts.push(list.type.create(list.attrs, before));
        parts.push(s.nodes.taskList.create(null, item));
        if (after.length) parts.push(list.type.create(list.attrs, after));
        const tr = state.tr.replaceWith(listStart, listStart + list.nodeSize, parts);
        const itemStart = listStart + (before.length ? parts[0].nodeSize : 0) + 1;
        tr.setSelection(TextSelection.near(tr.doc.resolve(itemStart + 2)));
        return undefined;
      } }),
      // ```lang / *** / --- / ___ / [toc] / a whole line of $$m$$ plus Enter: the parsed block (enterBlock)
      new InputRule({ find: (text) => (text.endsWith("\n") ? { index: text.length - 1, text: "\n" } : null), undoable: false, handler: ({ state }) => (enterBlock(state) ? undefined : null) }),
      // the closing $$ of a whole line $$m$$: the formula block it is saved and shown as, at once (no Enter needed)
      enterRule(/^\$\$([^$\n]*[^$\s][^$\n]*)\$\$$/, (m) => ({ nodes: [s.nodes.blockMath.create({ latex: m[1].trim() })] })),
      enterRule(/^\$\$\n$/, () => ({ nodes: [s.nodes.blockMath.create({ latex: "" })], then: (st) => openMath(ed, st) })),
      // === under a paragraph plus Enter: that paragraph becomes a level-1 heading (setext), written as `# `
      enterRule(/^=+\n$/, (_m, state, start) => {
        const $s = state.doc.resolve(start), i = $s.index();
        if (!i) return null;
        const prev = $s.parent.child(i - 1);
        if (prev.type.name !== "paragraph" || !prev.content.size || blockInfo(prev.textContent).level) return null;
        const from = start - prev.nodeSize;
        return { nodes: [para(`# ${prev.textContent}`), para("")], from, caret: (st) => st + prev.nodeSize + 3 };
      }),
      enterRule(/^<details>\n$/i, () => ({
        nodes: [s.nodes.details.create(null, [s.nodes.detailsSummary.create(), s.nodes.detailsContent.create(null, para(""))])],
        caret: (st) => st + 2,
      })),
      enterRule(/^\|(.+)\|\n$/, (m) => {
        const heads = m[1].split("|").map((x) => x.trim());
        if (!heads.length || heads.length > 20) return null;
        const cell = (t: string, type: "tableHeader" | "tableCell") => s.nodes[type].create(null, para(t));
        const table = s.nodes.table.create(null, [
          s.nodes.tableRow.create(null, heads.map((h) => cell(h, "tableHeader"))),
          s.nodes.tableRow.create(null, heads.map(() => cell("", "tableCell"))),
        ]);
        // first cell of the second row: table 1 + first row + row 1 + cell 1 + paragraph 1
        return { nodes: [table], caret: (st) => st + 1 + table.child(0).nodeSize + 3 };
      }),
    ];
  },

  addKeyboardShortcuts() {
    const e = this.editor;
    return {
      // right after an automatic conversion: back to what was typed (as in Typora); otherwise a normal undo
      "Mod-z": () => e.commands.undoInputRule() || e.commands.undo(),
      // the keymap falls back from Shift-Mod-z to Mod-z when the key is a lowercase z: catch redo here first
      "Shift-Mod-z": () => e.commands.redo(),
      // Home on a paragraph's first line goes to the start of its source (the browser would stop after a hidden opening
      // marker, so the caret's place would depend on what is hidden); on a heading to the start of its text, after the
      // "## " (a second Home goes before it)
      Home: () => {
        const sel = e.state.selection, $h = sel.$head, p = $h.parent;
        if (!sel.empty || p.type.name !== "paragraph" || !$h.depth) return false;
        const cell = /cell/.test($h.node(-1).type.spec.tableRole ?? "");
        const info = cell ? { level: 0, prefix: 0 } : blockInfo(p.textContent, true), to = $h.start() + (info.level ? info.prefix : 0);
        if (info.level ? $h.parentOffset <= info.prefix : $h.parentOffset === 0) return false;
        // the caret's line against the paragraph's top (the start itself may be a hidden marker, which has no place)
        const v = e.view, c = v.coordsAtPos(sel.head, -1), box = (v.nodeDOM($h.before()) as HTMLElement | null)?.getBoundingClientRect();
        if (!box || c.top - box.top > (c.bottom - c.top) * 0.8) return false; // a later line of a wrapped paragraph: the browser's own Home
        v.dispatch(revealMeta(e.state.tr.setSelection(TextSelection.create(e.state.doc, to))).scrollIntoView());
        return true;
      },
      Backspace: () => {
        const sel = e.state.selection;
        if (!sel.empty) return false;
        const $h = sel.$head, p = $h.parent;
        // right after a heading's "## " (or before it): one # at a time (## → # → paragraph), as in Typora
        if (p.type.name === "paragraph" && $h.depth && !/cell/.test($h.node(-1).type.spec.tableRole ?? "")) {
          const info = blockInfo(p.textContent, true);
          if (info.level && ($h.parentOffset === info.prefix || $h.parentOffset === 0)) return setHeading(e, info.level - 1);
        }
        if ($h.parentOffset !== 0) return false;
        if (e.commands.undoInputRule()) return true;
        // first paragraph of a list item or quote: take it out to body text
        if ($h.depth >= 2 && $h.index(-1) === 0) {
          const outer = $h.node(-1).type.name;
          if (outer === "listItem" || outer === "taskItem") return e.commands.liftListItem(outer);
          if (outer === "blockquote") return e.commands.lift("blockquote");
        }
        return false;
      },
      // Typora's block shortcuts: ⌘1–6 headings, ⌘0 body text, ⌘= / ⌘- one level up / down
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((l) => [`Mod-${l}`, () => setHeading(e, l)])),
      "Mod-0": () => setHeading(e, 0),
      "Mod-=": () => setHeading(e, (c) => (c ? c - 1 : 6) || 1),
      "Mod--": () => setHeading(e, (c) => (c && c < 6 ? c + 1 : 0)),
      "Mod-Alt-o": () => e.commands.toggleOrderedList(),
      "Mod-Alt-u": () => e.commands.toggleBulletList(),
      "Mod-Alt-q": () => e.commands.toggleBlockquote(),
      "Mod-Alt-x": () => e.commands.toggleTaskList(),
      // ⌘⌥T table, ⌘⌥B formula block: after this paragraph (an empty one is replaced), without splitting it
      "Mod-Alt-t": () => {
        const s = e.schema, row = (t: "tableHeader" | "tableCell") => s.nodes.tableRow.create(null, [0, 1].map(() => s.nodes[t].create(null, s.nodes.paragraph.create())));
        const table = s.nodes.table.create(null, [row("tableHeader"), row("tableCell"), row("tableCell")]);
        return blockAfter(e, table, (st) => st + 4);
      },
      "Mod-Alt-b": () => blockAfter(e, e.schema.nodes.blockMath.create({ latex: "" })), // selected: the formula block opens (mathblock.ts)
      "Mod-]": () => e.commands.sinkListItem(listType(e)),
      "Mod-[": () => e.commands.liftListItem(listType(e)),
      "Mod-b": () => wrap(e, "**"),
      "Mod-i": () => wrap(e, "*"),
      "Mod-u": () => wrap(e, "<u>", "</u>"),
      "Mod-e": () => wrap(e, "`"),
      // ⌘⇧` inline code; on a Mac ⌃⇧` strikethrough (on Windows / Linux both are the same key, which goes to code)
      "Mod-Shift-`": () => wrap(e, "`"),
      ...(IS_MAC ? { "Ctrl-Shift-`": () => wrap(e, "~~") } : {}),
      "Mod-Shift-s": () => wrap(e, "~~"),
      "Mod-Shift-x": () => wrap(e, "~~"),
      "Mod-Shift-h": () => wrap(e, "=="),
      "Mod-d": () => selectWord(e),
      "Mod-l": () => { const $h = e.state.selection.$head; if (!$h.parent.isTextblock) return false; e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, $h.start(), $h.end()))); return true; },
      "Mod-k": () => { this.options.openLink(e); return true; },
      // ⌘⇧V: paste as plain text
      "Mod-Shift-v": () => {
        void navigator.clipboard?.readText?.().then((t) => { if (t && !e.isDestroyed) e.view.dispatch(e.state.tr.insertText(t.replace(/\r\n?/g, "\n"))); }).catch(() => {});
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [pairsPlugin(), inlinePlugin()];
  },
});
