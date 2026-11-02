// One editor is built once (warmed up while idle) and moved into each Note being edited with a fresh EditorState (document,
// undo and every plugin's state new): entering editing only draws the document, without rebuilding the schema, extensions,
// plugins and view
import { Editor } from "@tiptap/core";
import { EditorState, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { DOMSerializer, Node as PMNode } from "@tiptap/pm/model";
import type { MdLayout } from "../layout";
import { revealIn, scroller } from "../ui/reveal";
import { clipboardHtml, clipboardText } from "./clipboard";
import { sourceDoc, sourceMd } from "./srcdoc";
import { editorExtensions } from "./extensions";
import { handlePaste } from "./paste";
import { bodyEnd, padEnd } from "./pad";
import type { MdEditorOpts } from "./types";
import { coreOf, type Markdown, type Md } from "../markdown";

export type Sess = {
  o: MdEditorOpts;
  onTx: (tr: Transaction) => void;
  onFocus: () => void;
  onBlur: (ev: FocusEvent) => void;
  finish: () => void;
};
type Inst = {
  editor: Editor;
  box: HTMLElement;
  dragHandle: boolean;
  sess: Sess | null;
  prepared?: string;
  host?: HTMLElement;
};
/** The instance's kept editor (one per Markdown instance: its extensions read that instance) */
const poolOf = (md: Md) => md.editorPool as Inst | undefined;

/** The editor for a new session: the kept one, unless it is busy (the hand-over between two sessions) or its drag handle
 *  differs, then one built for this session (pooled = it is the kept one) */
export function takeInst(md: Md, dragHandle: boolean): { inst: Inst; pooled: boolean } {
  const pool = poolOf(md) ?? (md.editorPool = makeInst(md, dragHandle));
  const inst = pool.sess || pool.dragHandle !== dragHandle ? makeInst(md, dragHandle) : pool;
  return { inst, pooled: inst === pool };
}

/** dragHandle：带不带拖动把手（扩展在建编辑器时就定下了，带和不带的是两个编辑器） */
function makeInst(md: Md, dragHandle = false): Inst {
  const box = document.createElement("div");
  box.style.display = "contents";
  let handle: HTMLElement | null = null;
  if (dragHandle) {
    handle = document.createElement("div");
    handle.className = "md-handle";
    handle.textContent = "⋮⋮";
    handle.setAttribute("data-tip", "Drag to move");
  }
  const inst: Inst = { editor: undefined as unknown as Editor, box, dragHandle, sess: null };
  // 扩展里读到的选项都转到当前这次编辑上
  const o = new Proxy({} as MdEditorOpts, {
    get: (_t, k) => (inst.sess?.o as Record<string | symbol, unknown> | undefined)?.[k],
  });
  const complete = (b: string, a: string) => (o.complete ? o.complete(b, a) : Promise.resolve(null));
  inst.editor = new Editor({
    element: box,
    extensions: editorExtensions(
      md,
      o,
      () => inst.editor,
      handle,
      () => inst.sess?.finish(),
      complete,
    ),
    content: { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: false,
    injectCSS: false, // 基础样式在 markdown.css
    editorProps: {
      attributes: { class: "md-pm", spellcheck: "false" },
      handlePaste: (_v, ev) => (inst.sess ? handlePaste(inst.editor, inst.sess.o, ev) : false),
      clipboardTextSerializer: clipboardText,
      clipboardSerializer: clipboardHtml(() => inst.editor.view) as unknown as DOMSerializer,
      // scrollOwnBox: the caret is brought into view only inside the nearest scrolling box (a fixed-height body scrolls with
      // overflow: auto); finding it reads styles first, so an auto-height editor measures no layout. Code blocks (they scroll
      // sideways) as usual
      handleScrollToSelection: (v) => {
        if (v.state.selection.$head.parent.type.spec.code || !inst.sess?.o.scrollOwnBox) return false;
        const box = scroller(v.dom);
        if (box) {
          const c = v.coordsAtPos(v.state.selection.head);
          revealIn(box, c.top, c.bottom);
        }
        return true;
      },
      handleClick: (_v, _pos, ev) => {
        const a = (ev.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
        if (a && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          o.openLink?.(a.getAttribute("href")!);
          return true;
        }
        return false;
      },
    },
    onTransaction: ({ transaction }) => inst.sess?.onTx(transaction),
    onFocus: () => inst.sess?.onFocus(),
    onBlur: ({ event }) => inst.sess?.onBlur(event as FocusEvent),
  });
  return inst;
}
const freshState = (prev: EditorState, doc: PMNode) => EditorState.create({ doc, plugins: prev.plugins });
/** 一次编辑的初始状态：文档、撤销栈、各插件都从头来。光标放到正文末尾；垫的空段落不算改动（没打字就不保存） */
export function stateFor(editor: Editor, value: string, layout?: MdLayout | null): EditorState {
  const st = freshState(editor.state, editor.schema.nodeFromJSON(sourceDoc(value, layout)));
  const tr = st.tr;
  if (padEnd(tr)) tr.setMeta("addToHistory", false);
  tr.setSelection(Selection.near(tr.doc.resolve(bodyEnd(tr.doc)), -1));
  return st.apply(tr);
}
/**
 * 预备：鼠标停在一张 Note 上（多半接着要双击）时，在页面外把它的文档画进那一个编辑器（先拿下来再换：挂在页面上换的话，
 * ProseMirror 读 DOM 选区会强制整页排版一次）。双击时只剩挂上去、拿焦点。编辑器正在用时不做
 */
export const prepKey = (value: string, layout?: MdLayout | null) =>
  layout ? `${JSON.stringify(layout)}\n${value}` : value;
/**
 * The caret at pos, or where a caret can be nearest to it: a point between blocks, at a table cell's edge or past the last
 * block resolves to no text, and a text selection there is invalid (ProseMirror warns and the caret goes nowhere visible)
 */
export function caretAt(e: Editor, pos: number) {
  const doc = e.state.doc,
    $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($p.parent.inlineContent) {
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(doc, $p.pos)));
    return;
  }
  // the nearer text of the two sides: a cell's start goes into that cell, the end of a row into its last cell
  const back = Selection.findFrom($p, -1, true),
    fwd = Selection.findFrom($p, 1, true);
  const near =
    back && fwd ? ($p.pos - back.head <= fwd.head - $p.pos ? back : fwd) : (back ?? fwd ?? Selection.near($p, -1));
  e.view.dispatch(e.state.tr.setSelection(near));
}
/** Prepare md's kept editor for value (see above) */
export function prepare(md: Markdown, value: string, layout?: MdLayout | null) {
  const inst = poolOf(coreOf(md)),
    key = prepKey(value, layout);
  if (!inst || inst.sess || inst.prepared === key) return;
  try {
    inst.box.remove();
    inst.editor.view.updateState(stateFor(inst.editor, value, layout));
    inst.prepared = key;
  } catch {
    inst.prepared = undefined;
  }
}
const SAMPLE =
  "## a\n\ntext **b** `c` $x$ [[d]][^1]\n\n- [ ] t\n\n```python\ndef f(): pass\n```\n\n$$\nx\n$$\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<details>\n<summary>s</summary>\n\nb\n\n</details>\n\n[^1]: n";
/** 预热：空闲时建好 md 的那一个编辑器，屏幕外画一遍各种节点（编译、各插件第一次初始化） */
export function warmUp(md: Markdown, extra?: string) {
  const core = coreOf(md);
  if (poolOf(core)) return;
  try {
    const inst = makeInst(core);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;visibility:hidden;contain:strict";
    document.body.append(host);
    host.append(inst.box);
    const e = inst.editor;
    // 样例里各种节点都有；再画一遍白板上真有的一张 Note（真实内容走到的路径更多）
    for (const md of extra ? [SAMPLE, extra] : [SAMPLE]) {
      e.view.updateState(freshState(e.state, e.schema.nodeFromJSON(sourceDoc(md))));
      sourceMd(e.getJSON());
    }
    // ProseMirror 第一次 focus 时要先探测浏览器支不支持 preventScroll（会读一遍所有祖先的滚动位置，强制整页排版）：
    // 在这里探测掉。宿主是 visibility:hidden，拿不到焦点，不会把焦点从白板上抢走
    e.view.focus();
    inst.box.remove();
    host.remove();
    core.editorPool = inst;
  } catch {
    /* 预热失败不要紧，第一次编辑时再建 */
  }
}
