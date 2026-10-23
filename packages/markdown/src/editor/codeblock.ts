// Note 里的代码块：编辑时用和 Free code 卡同一个 CodeMirror（../cm/editor.ts），看上去和显示时一样（同一个 pre.md-code、字体、
// 宿主给的着色，见 ../code.ts），字的位置不动。ProseMirror 的文档还是唯一的来源：CodeMirror 里的改动转成 ProseMirror 的改动，反过来也一样
// （照 CodeMirror 官网 “CodeMirror in ProseMirror” 的做法）。撤销走 ProseMirror；方向键在开头 / 结尾时走出代码块；
// Esc / ⌘↵ 结束整张 Note 的编辑；空代码块里退格变回段落。语言服务、灰字补全和 Free code 卡一样
import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView as PMView, NodeView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";
import type { ViewUpdate, KeyBinding } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { codeEditor, type CodeEditor, type LspHost } from "../cm/editor";
import { cachedCode, highlightCode } from "../code";

/** 代码块要的：所在的编辑器、结束整张 Note 的编辑、灰字补全；行注释记号、语言服务由用的一方给（不给就是 //、没有） */
export type CodeBlockHost = {
  editor: () => Editor; exit: () => void; complete: (before: string, after: string) => Promise<string | null>;
  comment?: (lang: string | undefined) => string | undefined;
  /** 这一块的语言服务（lang 跟着块的语言变）；这种语言没有就给 undefined。块拆掉时代码编辑器调它的 close */
  lsp?: (lang: () => string) => LspHost | undefined;
  /** 代码编辑器里按下不往外冒（见 CodeEditorOpts.stopPointerDown） */
  stopPointerDown?: boolean;
};

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  cm: CodeEditor;
  updating = false;
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
      onUpdate: (u) => this.forward(u),
    });
    this.cm.view.dom.classList.add("cbcm-md");
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
  }

  /** 方向键在开头 / 结尾：光标走出代码块 */
  escape(unit: "line" | "char", dir: -1 | 1): boolean {
    const v = this.cm.view, s = v.state, main = s.selection.main;
    if (completionStatus(s) === "active" || !main.empty) return false;
    // ↑ ↓：在屏幕上的第一 / 最后一行（折行也算）就走出去，光标在行里哪儿都一样（CodeMirror 在最后一行按 ↓ 只是挪到行尾）
    const row = (p: number) => v.coordsAtPos(p, dir)?.top;
    const edge = unit === "line" ? row(v.moveVertically(main, dir > 0).head) === row(main.head) : main.head === (dir < 0 ? 0 : s.doc.length);
    if (!edge) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    const target = pos + (dir < 0 ? 0 : this.node.nodeSize);
    const sel = Selection.near(this.view.state.doc.resolve(target), dir);
    this.view.dispatch(this.view.state.tr.setSelection(sel).scrollIntoView());
    this.view.focus();
    return true;
  }

  /** 空代码块里退格：变回段落 */
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

  /** ProseMirror → CodeMirror（撤销、别处的改动） */
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const langChanged = node.attrs.language !== this.node.attrs.language;
    this.node = node;
    if (langChanged) { const l = (node.attrs.language as string | null) ?? ""; if (l) this.dom.dataset.lang = l; else delete this.dom.dataset.lang; this.cm.setLang(l); }
    if (this.updating) return true;
    const next = node.textContent, cur = this.cm.view.state.doc.toString();
    if (next !== cur) {
      let a = 0, ca = cur.length, na = next.length;
      while (a < ca && a < na && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      while (ca > a && na > a && cur.charCodeAt(ca - 1) === next.charCodeAt(na - 1)) { ca--; na--; }
      this.updating = true;
      this.cm.view.dispatch({ changes: { from: a, to: ca, insert: next.slice(a, na) } });
      this.updating = false;
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
  stopEvent() { return true; }
  ignoreMutation() { return true; }
  destroy() { this.cm.destroy(); }
}
