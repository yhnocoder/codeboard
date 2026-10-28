// ProseMirror 的文档是唯一的来源：CodeMirror 里的改动转成 ProseMirror 的改动，反过来也一样，撤销走 ProseMirror
// （照 CodeMirror 官网 “CodeMirror in ProseMirror” 的做法）
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView as PMView, NodeView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";
import { Decoration as CmDeco, EditorView as CmView, type DecorationSet as CmDecos, type ViewUpdate, type KeyBinding } from "@codemirror/view";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { completionStatus } from "@codemirror/autocomplete";
import { codeEditor, type CodeEditor, type LspHost } from "../cm/editor";
import { cachedCode, highlightCode } from "../code";
import { LangBox, type CodeLang } from "./codelang";

/** GapCursor.valid 是 prosemirror-gapcursor 自己的箭头键用的判断，有，只是类型里没写 */
const gapAt = ($p: ResolvedPos) => (GapCursor as unknown as { valid($p: ResolvedPos): boolean }).valid($p);

/**
 * 点在两个代码块之间的空隙里、或者点在代码块靠那条缝的内边距上：光标停在两块中间。prosemirror-gapcursor 自己的点击只看
 * 离点的地方最近的字，那是代码块里的字，进的是代码块
 */
export const codeGapClick = () => new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, e) {
        const t = e.target as HTMLElement;
        if (e.button !== 0 || !view.editable || (t !== view.dom && !(t.parentElement === view.dom && t.matches("pre.md-code")))) return false;
        const doc = view.state.doc, y = e.clientY;
        for (let i = 0, at = 0; i <= doc.childCount; at += i < doc.childCount ? doc.child(i).nodeSize : 0, i++) {
          const before = i > 0 ? (view.nodeDOM(at - doc.child(i - 1).nodeSize) as HTMLElement | null) : null;
          const after = i < doc.childCount ? (view.nodeDOM(at) as HTMLElement | null) : null;
          if (!(before?.matches("pre.md-code") || after?.matches("pre.md-code"))) continue;
          // 缝从上一块的字的下沿到下一块的字的上沿（代码块的内边距算在缝里）
          const top = before ? edge(before, "bottom") : -Infinity, bottom = after ? edge(after, "top") : Infinity;
          if (y < top || y > bottom) continue;
          const $p = doc.resolve(at);
          if (!gapAt($p)) return false;
          e.preventDefault();
          view.dispatch(view.state.tr.setSelection(new GapCursor($p)));
          view.focus();
          return true;
        }
        return false;
      },
    },
  },
});
/** 一块的内容的上沿 / 下沿：代码块不算内边距，别的块就是它的边 */
function edge(el: HTMLElement, side: "top" | "bottom") {
  const r = el.getBoundingClientRect();
  if (!el.matches("pre.md-code")) return r[side];
  const cs = getComputedStyle(el);
  return side === "top" ? r.top + parseFloat(cs.paddingTop) : r.bottom - parseFloat(cs.paddingBottom);
}

// Note 的查找（editor/find.ts）在代码块里的匹配：代码块是 CodeMirror 自己画的，匹配用它的装饰画（class 和正文里的高亮同名）
export type Found = { from: number; to: number; cls: string };
const setFound = StateEffect.define<Found[]>();
const foundField = StateField.define<CmDecos>({
  create: () => CmDeco.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFound)) v = CmDeco.set(e.value.map((r) => CmDeco.mark({ class: r.cls }).range(r.from, r.to)), true);
    return v;
  },
  provide: (f) => CmView.decorations.from(f),
});
/** 代码块的根元素（pre）→ 它的节点视图 */
export const codeBlockAt = new WeakMap<Element, CodeBlockView>();

/** comment 不给就是 // */
export type CodeBlockHost = {
  editor: () => Editor; exit: () => void; complete: (before: string, after: string) => Promise<string | null>;
  comment?: (lang: string | undefined) => string | undefined;
  /** 这一块的语言服务（lang 跟着块的语言变）；这种语言没有就给 undefined。块拆掉时代码编辑器调它的 close */
  lsp?: (lang: () => string) => LspHost | undefined;
  /** 代码编辑器里按下不往外冒（见 CodeEditorOpts.stopPointerDown） */
  stopPointerDown?: boolean;
  /** 语言框里列出的语言（着色认得的）；不给就只有 Mermaid，打别的照打的写 */
  langs?: () => readonly CodeLang[];
};

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  cm: CodeEditor;
  langBox: LangBox;
  updating = false;
  private fitting = 0;
  private found = "";
  constructor(public node: PMNode, public view: PMView, public getPos: () => number | undefined, host: CodeBlockHost) {
    const lang = () => (this.node.attrs.language as string | null) ?? "";
    this.dom = document.createElement("pre");
    this.dom.className = "md-code";
    if (lang()) this.dom.dataset.lang = lang();
    const l = lang();
    const keys: KeyBinding[] = [
      { key: "ArrowUp", run: () => this.escape("line", -1) },
      { key: "ArrowLeft", run: () => this.escape("char", -1) },
      { key: "ArrowDown", run: () => this.escape("line", 1) },
      { key: "ArrowRight", run: () => this.escape("char", 1) },
      { key: "Mod-z", run: () => host.editor().commands.undo() },
      { key: "Mod-Shift-z", run: () => host.editor().commands.redo() },
      { key: "Mod-y", run: () => host.editor().commands.redo() },
      { key: "Backspace", run: () => this.unwrapIfEmpty() },
    ];
    this.cm = codeEditor({
      parent: this.dom,
      text: node.textContent,
      lang: l,
      html: cachedCode(node.textContent, l),
      highlight: (t) => highlightCode(t, lang()),
      history: false,
      activeLine: false,
      keys,
      comment: host.comment,
      lsp: host.lsp?.(lang),
      stopPointerDown: host.stopPointerDown,
      ghost: { complete: host.complete },
      onExit: () => host.exit(),
      // 焦点从代码直接去了编辑器外面：ProseMirror 只听它自己根元素的 blur，代码编辑器是它里面另一个可编辑的元素（stopEvent），
      // 收不到，替它发一个，用的一方照常保存退出（和公式块的原文一样）
      onBlur: (e) => {
        const to = e.relatedTarget;
        if (!(to instanceof Node && this.view.dom.contains(to))) this.view.dom.dispatchEvent(new FocusEvent("blur", { relatedTarget: to }));
      },
      onUpdate: (u) => this.forward(u),
      className: "cbcm-md",
      extensions: [foundField],
    });
    codeBlockAt.set(this.dom, this);
    this.langBox = new LangBox({
      lang,
      langs: () => host.langs?.() ?? [],
      // 一步（自己一步撤销，不和前面打的字连在一起）；着色跟着换（update）
      set: (language) => {
        const pos = this.getPos();
        if (pos === undefined) return;
        this.view.dispatch(closeHistory(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language })));
      },
      back: () => this.cm.focus(),
      left: (to) => this.view.dom.dispatchEvent(new FocusEvent("blur", { relatedTarget: to })),
    });
    this.dom.append(this.langBox.label);
    // 第一行长到伸进语言名下面（.md-under）：悬停、光标在块里时都不显示它，不盖住代码（见 markdown.css）
    this.dom.addEventListener("pointerenter", () => this.fitLabel());
    this.dom.addEventListener("focusin", () => this.fitLabel());
    this.fitLabel();
  }

  /** 下一帧量一次：第一行（屏幕上的第一行，折行也算）的末尾伸到了语言名的左边没有 */
  fitLabel() {
    if (this.fitting) return;
    this.fitting = requestAnimationFrame(() => {
      this.fitting = 0;
      const v = this.cm.view, lb = this.langBox.label;
      if (!lb.isConnected) return;
      const r = lb.getBoundingClientRect();
      const c = v.coordsAtPos(v.moveToLineBoundary(EditorSelection.cursor(0), true).head, -1);
      lb.classList.toggle("md-under", !!c && c.right > r.left - 4 && c.top < r.bottom);
    });
  }

  /** CodeMirror → ProseMirror：改动和选区 */
  forward(u: ViewUpdate) {
    if (this.updating || !this.cm?.view.hasFocus && !u.docChanged) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    let off = pos + 1;
    const { main } = u.state.selection;
    const selFrom = off + main.from, selTo = off + main.to;
    const pm = this.view.state.selection;
    if (!u.docChanged && pm.from === selFrom && pm.to === selTo) return;
    const tr = this.view.state.tr;
    u.changes.iterChanges((fA, tA, fB, tB, text) => {
      if (text.length) tr.replaceWith(off + fA, off + tA, this.view.state.schema.text(text.toString()));
      else tr.delete(off + fA, off + tA);
      off += tB - fB - (tA - fA);
    });
    tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
    this.view.dispatch(tr);
    if (u.docChanged) this.fitLabel();
  }

  escape(unit: "line" | "char", dir: -1 | 1): boolean {
    const v = this.cm.view, s = v.state, main = s.selection.main;
    if (completionStatus(s) === "active" || !main.empty) return false;
    // ↑ ↓：在屏幕上的第一 / 最后一行（折行也算）就走出去，光标在行里哪儿都一样（CodeMirror 在最后一行按 ↓ 只是挪到行尾）
    const row = (p: number) => v.coordsAtPos(p, dir)?.top;
    const edge = unit === "line" ? row(v.moveVertically(main, dir > 0).head) === row(main.head) : main.head === (dir < 0 ? 0 : s.doc.length);
    if (!edge) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    // 挨着的是另一个代码块（或文档的头尾）时停在两块中间（gapcursor）；Selection.near 只找字和节点，会直接进到下一块里
    const $t = this.view.state.doc.resolve(pos + (dir < 0 ? 0 : this.node.nodeSize));
    const sel = gapAt($t) ? new GapCursor($t) : Selection.near($t, dir);
    this.view.dispatch(this.view.state.tr.setSelection(sel).scrollIntoView());
    this.view.focus();
    return true;
  }

  unwrapIfEmpty(): boolean {
    if (this.cm.view.state.doc.length) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    const st = this.view.state;
    const tr = st.tr.replaceWith(pos, pos + this.node.nodeSize, st.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    this.view.dispatch(tr);
    this.view.focus();
    return true;
  }

  /** 查找的匹配（块里的偏移）：和上次一样就不动 */
  showFound(rs: Found[]) {
    const n = this.cm.view.state.doc.length, key = JSON.stringify(rs = rs.filter((r) => r.from < r.to && r.to <= n));
    if (key === this.found) return;
    this.found = key;
    this.cm.view.dispatch({ effects: setFound.of(rs) });
  }

  /** ProseMirror → CodeMirror（撤销、别处的改动） */
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const langChanged = node.attrs.language !== this.node.attrs.language;
    this.node = node;
    if (langChanged) { const l = (node.attrs.language as string | null) ?? ""; if (l) this.dom.dataset.lang = l; else delete this.dom.dataset.lang; this.cm.setLang(l); this.langBox.sync(); }
    if (this.updating) return true;
    const next = node.textContent, cur = this.cm.view.state.doc.toString();
    if (next !== cur) {
      let a = 0, ca = cur.length, na = next.length;
      while (a < ca && a < na && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      while (ca > a && na > a && cur.charCodeAt(ca - 1) === next.charCodeAt(na - 1)) { ca--; na--; }
      this.updating = true;
      this.cm.view.dispatch({ changes: { from: a, to: ca, insert: next.slice(a, na) } });
      this.updating = false;
      this.fitLabel();
    }
    return true;
  }

  setSelection(anchor: number, head: number) {
    this.cm.view.focus();
    this.updating = true;
    const n = this.cm.view.state.doc.length;
    this.cm.view.dispatch({ selection: { anchor: Math.min(anchor, n), head: Math.min(head, n) } });
    this.updating = false;
  }
  selectNode() { this.cm.view.focus(); }
  // 按在块自己的内边距上（不在代码里）交给 ProseMirror：codeGapClick 看是不是点在两块之间的缝上
  stopEvent(e: Event) { return !(e.type === "mousedown" && e.target === this.dom); }
  ignoreMutation() { return true; }
  destroy() { cancelAnimationFrame(this.fitting); this.cm.destroy(); this.langBox.destroy(); }
}
