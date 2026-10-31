// 照 Typora：选中时展开成能改的 LaTeX 原文，下面是边打边变的预览。原文改到一半不进文档：离开时一步写回（一次 ⌘Z 撤回整次修改）
import katex from "katex";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { keepKey } from "../ui/editkeys";
import { markTex, mathMacros } from "../math";
import { MathHints, textareaCaret } from "./mathhints";

export class MathBlockView implements NodeView {
  dom: HTMLElement;
  private src: HTMLTextAreaElement;
  private preview: HTMLElement;
  private open = false;
  /** 正在写回（写回时会拿走焦点，那一下的 blur 不再写一次） */
  private leaving = false;
  private width: ResizeObserver;
  private hints: MathHints;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "tiptap-mathematics-render";
    this.dom.dataset.type = "block-math";
    this.src = document.createElement("textarea");
    this.src.className = "md-mathsrc";
    this.src.spellcheck = false;
    this.src.placeholder = "LaTeX, e.g. \\frac{a}{b}";
    this.preview = document.createElement("div");
    this.preview.className = "block-math-inner";
    this.dom.append(this.src, this.preview);
    // 原文按排出来的高度量（长的一行会折行）：只有一行时也只占一行；Note 变宽变窄时重量
    this.src.rows = 1;
    let w = 0;
    this.width = new ResizeObserver(([e]) => {
      if (e.contentRect.width !== w) {
        w = e.contentRect.width;
        if (this.open) this.fit();
      }
    });
    this.width.observe(this.dom);
    this.hints = new MathHints(
      {
        text: () => this.src.value,
        caret: () => this.src.selectionStart,
        caretRect: () => textareaCaret(this.src, this.src.selectionStart),
        replace: (from, to, text, caret) => {
          this.src.focus({ preventScroll: true });
          this.src.setSelectionRange(from, to);
          // insertText 进文本框自己的撤销记录（⌘Z 撤回这次补全）；不支持时直接换字
          if (!document.execCommand("insertText", false, text)) this.src.setRangeText(text, from, to);
          this.src.setSelectionRange(caret, caret);
          this.fit();
          this.hints.refresh(false);
        },
        display: true,
      },
      { preview: this.preview },
    );
    this.src.addEventListener("input", () => {
      this.fit();
      this.hints.refresh(true);
    });
    this.src.addEventListener("keydown", (e) => this.key(e));
    // 只挪了光标（点、方向键）：补全跟着光标；命令名打到一半时的报错也看光标在哪
    this.src.addEventListener("keyup", (e) => {
      if (/^(Arrow|Home|End)/.test(e.key) && this.open) this.hints.refresh(false);
    });
    this.src.addEventListener("pointerup", () => {
      if (this.open) this.hints.refresh(false);
    });
    this.src.addEventListener("blur", (e) => {
      this.hints.close();
      if (this.open && !this.leaving) this.commit();
      // 焦点从原文直接去了编辑器外面（点了别的卡片）：ProseMirror 只听它自己的 blur，收不到，替它发一个，用的一方照常保存退出
      const to = e.relatedTarget;
      if (!(to instanceof Node && this.view.dom.contains(to)))
        this.view.dom.dispatchEvent(new FocusEvent("blur", { relatedTarget: to }));
    });
    this.render(node.attrs.latex);
  }

  private render(latex: string) {
    katex.render(latex, this.preview, { displayMode: true, throwOnError: false, output: "html", macros: mathMacros() });
    markTex(this.preview, latex);
    if (!latex.trim()) this.preview.textContent = "";
  }
  /** 原文排出来多高就多高（折行也算），不在框里滚、不被裁掉 */
  private fit() {
    this.src.style.height = "auto";
    this.src.style.height = `${this.src.scrollHeight}px`;
  }

  selectNode() {
    this.open = true;
    this.dom.classList.add("is-open");
    this.src.value = this.node.attrs.latex;
    this.fit();
    // 等这一次选区更新完再拿焦点（鼠标点进来时 ProseMirror 还在处理这一下）
    queueMicrotask(() => {
      if (!this.open || document.activeElement === this.src) return;
      this.src.focus({ preventScroll: true });
      this.src.setSelectionRange(this.src.value.length, this.src.value.length);
      this.hints.refresh(false);
    });
  }
  deselectNode() {
    this.open = false;
    this.dom.classList.remove("is-open");
    this.hints.close();
    this.render(this.node.attrs.latex);
  }

  /** 原文写回文档（一步，进撤销）；dir：光标放到块前面（-1）、后面（1），不给就不动选区（点了别处，选区由那一下定） */
  private commit(dir?: -1 | 1) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const latex = this.src.value,
      tr = this.view.state.tr;
    let end = pos + this.node.nodeSize;
    if (!latex.trim()) {
      tr.delete(pos, end);
      end = pos;
    } else if (latex !== this.node.attrs.latex) tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, latex });
    if (dir) tr.setSelection(TextSelection.near(tr.doc.resolve(dir < 0 || end === pos ? pos : end), dir));
    else if (end === pos && tr.selection instanceof NodeSelection)
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
    if (!tr.docChanged && !dir) return;
    this.leaving = true;
    this.view.dispatch(tr.scrollIntoView());
    if (dir) this.view.focus();
    this.leaving = false;
  }

  private key(e: KeyboardEvent) {
    const t = this.src,
      v = t.value,
      a = t.selectionStart,
      b = t.selectionEnd,
      mod = e.metaKey || e.ctrlKey;
    const leave = (dir: -1 | 1) => {
      e.preventDefault();
      e.stopPropagation();
      this.commit(dir);
    };
    if (e.isComposing) return keepKey(e);
    if (this.hints.key(e)) return e.stopPropagation();
    if (e.key === "Escape" || (e.key === "Enter" && mod)) return leave(1);
    if (a === b && !e.shiftKey && !e.altKey && !mod) {
      if ((e.key === "ArrowUp" && !v.slice(0, a).includes("\n")) || (e.key === "ArrowLeft" && a === 0))
        return leave(-1);
      if ((e.key === "ArrowDown" && !v.slice(a).includes("\n")) || (e.key === "ArrowRight" && a === v.length))
        return leave(1);
      if (e.key === "Backspace" && !v) return leave(-1);
    }
    keepKey(e);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.open) this.render(node.attrs.latex);
    return true;
  }
  stopEvent(e: Event) {
    return e.target === this.src;
  }
  ignoreMutation() {
    return true;
  }
  destroy() {
    this.width.disconnect();
    this.hints.close();
  }
}
