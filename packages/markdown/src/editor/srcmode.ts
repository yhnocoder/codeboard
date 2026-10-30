// ⌘/: the whole Note as its Markdown source in a CodeMirror editor, and back. The caret keeps its place both ways (a
// marker character goes through serializing / parsing with the text). Switching back replaces the document in one
// step, so one ⌘Z undoes the whole source session; table widths, row heights and code wrap are carried over by
// position (nth table, nth code block), like the stored layout.
import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { RangeSetBuilder } from "@codemirror/state";
import { ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { codeEditor, Decoration, EditorView } from "../cm/editor";
import { layoutOf, sourceDoc, sourceMd, withLayout } from "./srcdoc";
import { blockInfo, flat } from "./spans";
import { revealMeta } from "./inline";

export type SourceMode = {
  text(): string;
  changed(): boolean;
  /** Back to rich editing: apply = write the text into the document (if it changed); focus = give the editor focus.
   *  True when the document changed */
  close(apply: boolean, focus: boolean): boolean;
  destroy(): void;
};

const CARET = "";

/**
 * The Markdown of doc and where position pos lands in it. The marker replaces the character after the caret (or before
 * it, at the end of a paragraph) instead of being inserted, so padded table columns keep their widths
 */
export function mdAt(doc: PMNode, pos: number): { md: string; at: number } {
  const md = sourceMd(doc.toJSON());
  try {
    const $p = Selection.near(doc.resolve(Math.min(pos, doc.content.size))).$head, p = $p.parent;
    if (!p.isTextblock) return { md, at: md.length };
    const after = $p.parentOffset < p.content.size, from = after ? $p.pos : $p.parentOffset ? $p.pos - 1 : $p.pos;
    const ch = after || $p.parentOffset ? p.textContent[from - $p.start()] : "";
    const d = doc.replace(from, from + ch.length, new Slice(Fragment.from(doc.type.schema.text(CARET)), 0, 0));
    const m = sourceMd(d.toJSON()), i = m.indexOf(CARET);
    if (i >= 0 && m.slice(0, i) + ch + m.slice(i + 1) === md) return { md, at: after || !ch ? i : i + 1 };
  } catch { /* falls through */ }
  return { md, at: md.length };
}

/** The document for Markdown md (with layout carried from old) and where offset at lands in it */
export function docAt(old: PMNode, md: string, at: number): { doc: PMNode; pos: number | null } {
  const schema = old.type.schema, l = layoutOf(old);
  const parse = (t: string) => schema.nodeFromJSON(l ? withLayout(sourceDoc(t), l) : sourceDoc(t));
  const doc = parse(md);
  // the marker can split a syntax it lands in (between the two * of **): then try the start of that word, then the line
  const tries = [at, at - (/[^\s]*$/.exec(md.slice(0, at))?.[0].length ?? 0), md.lastIndexOf("\n", at - 1) + 1];
  for (const a of tries) {
    try {
      const d = parse(md.slice(0, a) + CARET + md.slice(a));
      let pos: number | null = null;
      d.descendants((n, p) => { if (pos === null && n.isText && n.text!.includes(CARET)) pos = p + n.text!.indexOf(CARET); return pos === null; });
      if (pos === null) continue;
      const stripped = d.replace(pos, pos + 1, d.slice(0, 0));
      if (stripped.eq(doc)) return { doc, pos };
    } catch { /* next */ }
  }
  return { doc, pos: null };
}

/** Parser-driven colours for the source: headings (their "## " dimmed), markers, list and quote prefixes, table pipes and
 *  rules, inline and fenced code (fences dimmed), $math$ and $$ blocks, link text (the address dimmed) */
const srcHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = this.build(v); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(v: EditorView): DecorationSet {
    const b = new RangeSetBuilder<Decoration>(), doc = v.state.doc;
    let fence = "", math = false;
    const { from, to } = v.viewport;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n), t = line.text, f = /^ {0,3}(`{3,}|~{3,})/.exec(t), seen = line.from <= to && line.to >= from;
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = ""; if (seen) b.add(line.from, line.to, MARK); }
        else if (seen && t) b.add(line.from, line.to, CODE);
        continue;
      }
      if (f) { fence = f[1]; if (seen) b.add(line.from, line.to, MARK); continue; }
      if (/^ {0,3}\$\$\s*$/.test(t)) { math = !math; if (seen) b.add(line.from, line.to, MARK); continue; }
      if (math) { if (seen && t) b.add(line.from, line.to, MATH); continue; }
      if (!seen || !t) continue;
      const out: [number, number, Decoration][] = [];
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(t) && t.includes("|")) { b.add(line.from, line.to, MARK); continue; }
      const info = blockInfo(t, true);
      if (info.prefix) { out.push([0, info.prefix, MARK]); if (t.length > info.prefix) out.push([info.prefix, t.length, HEAD]); }
      const lead = /^(\s*(?:>\s?)*)(?:[-*+]|\d+[.)])\s(?:\[[ xX]\]\s)?|^\s*(?:>\s?)+/.exec(t);
      if (!info.prefix && lead) out.push([0, lead[0].length, MARK]);
      for (const sp of flat(info.spans)) {
        if (sp.atom?.type === "math") { out.push([sp.from, sp.to, MATH]); continue; }
        for (const [a, c] of sp.marks) if (c > a) out.push([a, c, MARK]);
        if (sp.tag?.nodeName === "code" && sp.inner) out.push([sp.inner[0], sp.inner[1], CODE]);
        if (sp.tag?.nodeName === "a" && sp.inner && sp.inner[1] > sp.inner[0]) out.push([sp.inner[0], sp.inner[1], LINK]);
      }
      // a table row's pipes (not an escaped \| inside a cell)
      if (/^\s*\|/.test(t)) for (let i = t.indexOf("|"); i >= 0; i = t.indexOf("|", i + 1)) if (t[i - 1] !== "\\") out.push([i, i + 1, MARK]);
      // RangeSetBuilder needs ranges in order of start, then of side
      out.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
      for (const [a, c, d] of out) b.add(line.from + a, line.from + c, d);
    }
    return b.finish();
  }
}, { decorations: (p) => p.decorations });
const HEAD = Decoration.mark({ class: "md-s-h" }), MARK = Decoration.mark({ class: "md-s-mk" }), CODE = Decoration.mark({ class: "md-s-code" });
const MATH = Decoration.mark({ class: "md-s-math" }), LINK = Decoration.mark({ class: "md-s-link" });

export function sourceMode(editor: Editor, host: HTMLElement, o: { isMac?: boolean; back: () => void; exit: () => void; blur: (ev: FocusEvent) => void }): SourceMode {
  const { md, at } = mdAt(editor.state.doc, editor.state.selection.head);
  const box = document.createElement("div");
  box.className = "md-srcmode";
  host.append(box);
  editor.view.dom.style.display = "none";
  const cm = codeEditor({
    parent: box, text: md, wrap: true, className: "cbcm-src",
    // ahead of CodeMirror's own ⌘/ (line comments): back to rich editing
    keys: [{ key: "Mod-/", run: () => { o.back(); return true; } }],
    onExit: () => o.exit(),
    onBlur: (e) => o.blur(e),
    extensions: [srcHighlight],
  });
  cm.view.dispatch({ selection: { anchor: Math.min(at, md.length) }, scrollIntoView: true });
  cm.focus();
  let open = true;
  const remove = () => { if (!open) return; open = false; editor.view.dom.style.display = ""; cm.destroy(); box.remove(); };
  return {
    text: () => cm.text(),
    changed: () => cm.text() !== md,
    close(apply, focus) {
      if (!open) return false;
      const text = cm.text(), caret = cm.view.state.selection.main.head;
      let changed = false;
      // focus first, then take the source away: otherwise focus falls to body for a moment and the board sees a blur
      if (focus) editor.view.dom.style.display = "";
      const old = editor.state.doc;
      const { doc, pos } = docAt(old, text, caret);
      const tr = editor.state.tr;
      if (apply && text !== md && !doc.eq(old)) {
        closeHistory(tr).replaceWith(0, old.content.size, doc.content);
        changed = true;
      }
      if (focus) {
        const p = pos ?? tr.doc.content.size;
        tr.setSelection(pos !== null && tr.doc.resolve(p).parent.isTextblock ? TextSelection.create(tr.doc, p) : Selection.near(tr.doc.resolve(Math.min(p, tr.doc.content.size)), -1));
        tr.scrollIntoView();
      }
      if (changed || focus) editor.view.dispatch(revealMeta(tr));
      if (changed) editor.view.dispatch(closeHistory(editor.state.tr));
      if (focus) editor.view.focus();
      remove();
      return changed;
    },
    destroy: remove,
  };
}
