// The editor entry (@yhnocoder/markdown/editor): one editing session of a Note. Parsing and writing back use the one
// MarkdownManager in ../schema; the editor adds only what editing needs (extensions.ts, the menus, the toolbar, paste)
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { MdLayout } from "../layout";
import { layoutOf, sameLayout, sourceMd } from "./srcdoc";
import { sourceMode, type SourceMode } from "./srcmode";
import { noteFind } from "./find";
import { findKey } from "../ui/find";
import { visibleRange } from "./visible";
import { pickImageAt } from "./inline";
import { Bubble } from "./bubble";
import { caretAt, prepKey, stateFor, takeInst, type Sess } from "./session";
import { uiOf, type Ui } from "./ui";
import type { MdEditorHandle, MdEditorOpts } from "./types";
import { coreOf, type Markdown } from "../markdown";
import { mdBlocks } from "./moveblocks";

// The API for npm users (README); an export the board itself does not use is marked @public for the dead-code check
export type { MdBlocks, BlockMark } from "./moveblocks";
export type {
  MdEditorOpts,
  MdEditorHandle,
  RefItem,
  RefGroup,
  RefPick,
} from "./types";
/** @public */
export type { CodeLang } from "./codelang";
/** @public */
export type { MdClasses } from "../ui/classes";
export {
  /** @public */
  prepare,
  warmUp,
} from "./session";

/**
 * Edit o.value in host with md's settings (its resolvers, highlighter, preamble, images)
 * @public
 */
export function mountEditor(md: Markdown, host: HTMLElement, o: MdEditorOpts): MdEditorHandle {
  const core = coreOf(md);
  let changed = false,
    done = false,
    src: SourceMode | null = null,
    doc0: PMNode | null = null;
  let find: ReturnType<typeof noteFind> | undefined;
  const [tick, setTick] = createSignal(0);
  const [menu, setMenu] = createSignal<ReturnType<Ui["menu"]>>(null);
  // the shared editor is busy (the hand-over between two sessions), or its drag handle differs: build one for this session
  const dragHandle = !!o.dragHandle;
  const { inst, pooled } = takeInst(core, dragHandle);
  const editor = inst.editor;
  const sess: Sess = {
    o,
    onTx: (tr) => {
      if (tr.docChanged) {
        doc0 ??= tr.before;
        changed = true;
      }
      setTick((t) => t + 1);
      find?.refresh();
    },
    onFocus: () => setTick((t) => t + 1),
    onBlur: (ev) => {
      setTick((t) => t + 1);
      blurred(ev);
    },
    finish: () => finish(),
  };
  inst.sess = sess;
  editor.view.dom.style.display = "";
  // a fresh state (stateFor); when the pointer rested on this Note it was usually prepared off-page already
  if (!pooled || inst.prepared !== prepKey(o.value, o.layout)) {
    inst.box.remove();
    inst.editor.view.updateState(stateFor(editor, o.value, o.layout));
  }
  inst.prepared = undefined;
  host.append(inst.box);
  {
    // focus within this task (not TipTap's next frame), so the caret appears with the editor. In a microtask: a double-click
    // enters from pointerdown and the same event bubbling to the canvas blurs; entering from a menu returns focus to body
    queueMicrotask(() => {
      if (inst.sess === sess && !editor.view.hasFocus()) editor.view.focus();
    });
    // the next frame only repairs "focus fell to body": on a slow machine $$⏎ or ⌘K may already have moved focus into the
    // formula source or the link box, which must not be taken back
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (inst.sess === sess && !editor.isDestroyed && !editor.view.hasFocus() && (!a || a === document.body))
        editor.view.focus();
    });
  }
  const [link, setLink] = createSignal<string | null>(null);
  const layer = document.createElement("div");
  layer.className = "mdui";
  document.body.append(layer);
  // the find bar is in host (top right of the editor): focus moving between it and the editor is not leaving
  find = noteFind(editor.view, host, {
    owns: (n) => host.contains(n) || layer.contains(n),
    leave: (ev) => blurred(ev),
    classes: o.classes,
    passKeys: core.passKeys,
  });
  const ui: Ui = { menu, setMenu, link, setLink, closeFind: () => !!find?.close(), follow: false, opts: o };
  uiOf.set(editor, ui);
  const disposeUi = render(() => <Bubble editor={editor} tick={tick} ui={ui} />, layer);

  const value = (): string | null => {
    if (src?.changed()) return src.text().replace(/\s+$/, "");
    if (!changed) return null;
    // changes that write the same Markdown (a column width, kept as layout) leave the text as the user wrote it
    const md = sourceMd(editor.getJSON());
    return doc0 && sourceMd(doc0.toJSON()) === md ? null : md;
  };
  const layout = (): MdLayout | null => layoutOf(editor.state.doc);
  let blocks: ReturnType<typeof mdBlocks> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    const v = value();
    // in source mode the text is saved as written; the layout (nth table, nth code block) is carried onto it by applying it
    if (src) {
      const s0 = src;
      src = null;
      if (s0.close(true, false)) changed = true;
      o.onSourceMode?.(false);
    }
    const l = layout();
    destroy();
    if (sameLayout(l, o.layout)) o.onDone(v);
    else o.onDone(v, l);
  };
  // focus leaving the editor and its overlays: save and leave (the toolbar, the link box do not count)
  function blurred(ev?: FocusEvent) {
    const inside = (n: EventTarget | null | undefined) =>
      n instanceof Node &&
      (host.contains(n) ||
        layer.contains(n) ||
        !!(n as Element).closest?.(".mdui, .mdui-anchor, .md-handle, [data-md-keep]"));
    if (inside(ev?.relatedTarget)) return;
    setTimeout(() => {
      if (!done && !inside(document.activeElement)) finish();
    }, 0);
  }
  // ⌘/: the whole Note as Markdown source (CodeMirror), and back; the caret keeps its place both ways
  const toggleSource = () => {
    if (done) return;
    if (!src) {
      src = sourceMode(editor, host, { back: () => toggleSource(), exit: () => finish(), blur: (ev) => blurred(ev) });
      o.onSourceMode?.(true);
    } else {
      const s0 = src;
      src = null;
      if (s0.close(true, true)) changed = true;
      o.onSourceMode?.(false);
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.isComposing || ev.key === "Process") return;
    // a code block's CodeMirror keeps ⌘/ for line comments (it stops the key there); everywhere else it is source mode
    if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "/" || ev.code === "Slash")) {
      ev.preventDefault();
      toggleSource();
    }
  };
  // ⌘F / ⌥⌘F in the capture phase: also from inside a code block (CodeMirror stops its keys), it searches the whole Note
  const onFind = (ev: KeyboardEvent) => {
    const k = findKey(ev);
    if (!k || src) return;
    ev.preventDefault();
    ev.stopPropagation();
    find?.open(k === "replace");
  };
  host.addEventListener("keydown", onKey);
  host.addEventListener("keydown", onFind, true);
  const destroy = () => {
    host.removeEventListener("keydown", onKey);
    host.removeEventListener("keydown", onFind, true);
    find?.destroy();
    inst.sess = null;
    const s0 = src;
    src = null;
    if (s0) o.onSourceMode?.(false);
    // cleanup after this frame is drawn: the frame that leaves only swaps the static content back
    requestAnimationFrame(() =>
      setTimeout(() => {
        disposeUi();
        layer.remove();
        s0?.destroy();
        if (inst.sess) return; // already taken by the next session
        // a focused element taken out of the page fires no blur, and ProseMirror would think it still has focus
        const focused = editor.view.hasFocus();
        inst.box.remove();
        if (focused) editor.view.dom.dispatchEvent(new FocusEvent("blur"));
        if (!pooled) {
          if (!editor.isDestroyed) editor.destroy();
          return;
        }
        // the kept one does not keep this document: node views go too (code blocks close their language-service documents)
        editor.view.updateState(stateFor(editor, ""));
      }),
    );
  };
  return {
    value,
    layout,
    placeCaret: (at) => {
      const end = () => {
        caretAt(editor, editor.state.doc.content.size);
        return true;
      };
      if (at === "end") return end();
      if ("visible" in at) {
        const c = visibleRange(editor.state.doc, at.visible);
        if (c) caretAt(editor, at.after ? c.to : c.from);
        return !!c;
      }
      const r = editor.view.dom.getBoundingClientRect();
      if (at.y >= r.bottom) return end();
      const p = editor.view.posAtCoords({
        left: Math.min(Math.max(at.x, r.left + 1), r.right - 1),
        top: Math.max(at.y, r.top + 1),
      });
      if (p) caretAt(editor, p.pos);
      return !!p;
    },
    pickImage: (at) => pickImageAt(editor.view, at.x, at.y),
    selectVisible: (r) => {
      const c = visibleRange(editor.state.doc, r);
      if (c) editor.commands.setTextSelection(c);
      return !!c;
    },
    press: (key) => {
      if (editor.isDestroyed) return;
      const ev = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
      editor.view.dom.dispatchEvent(ev);
      if (!ev.defaultPrevented) editor.commands.deleteSelection();
    },
    type: (text) => {
      if (editor.isDestroyed) return;
      const view = editor.view;
      for (const ch of text) {
        // the key first, as a keystroke reaches the editor: its key bindings (Enter, the auto-closed brackets) may take it
        const key = ch === "\n" ? "Enter" : ch;
        const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        view.dom.dispatchEvent(ev);
        if (ev.defaultPrevented || key === "Enter") continue;
        // then as text the browser put in, which ProseMirror offers to handleTextInput (the input rules) before inserting it
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(ch, from, to);
        if (!view.someProp("handleTextInput", (f) => f(view, from, to, ch, insert)))
          view.dispatch(insert().scrollIntoView());
      }
    },
    toggleSource,
    blocks: () => (done || src || editor.isDestroyed ? null : (blocks ??= mdBlocks(editor))),
    destroy: () => {
      if (!done) {
        done = true;
        destroy();
      }
    },
  };
}
