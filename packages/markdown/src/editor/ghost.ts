import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { sourceMd } from "./srcdoc";
import { autoClosersAt } from "./pairs";
import { GhostAsker, eatGhost, nextWord, wantGhost, type Complete, type Ghost as G } from "../ui/ghost";
import { revealIn, scroller } from "../ui/reveal";

const CARET = "\uE000";
/** 问 Markdown 原文：模型看到 **b**、`c`、$x$、[[Ref]]、# 才知道该写 Markdown */
export function mdAround(s: EditorState, pos: number): [string, string] {
  try {
    const md = sourceMd(s.tr.insertText(CARET, pos).doc.toJSON());
    const i = md.indexOf(CARET);
    if (i >= 0) return [md.slice(0, i), md.slice(i + 1)];
  } catch { /* 退回纯文字 */ }
  return [s.doc.textBetween(0, pos, "\n", " "), s.doc.textBetween(pos, s.doc.content.size, "\n", " ")];
}

export const ghostKey = new PluginKey<G>("cbGhost");

/** 编辑器在自己会滚的框里时：灰字整段滚进来，光标那一行不滚出去 */
function reveal(view: EditorView, pos: number) {
  const box = scroller(view.dom), span = view.dom.querySelector(".md-ghost");
  if (!box || !span) return;
  revealIn(box, view.coordsAtPos(pos).top, span.getBoundingClientRect().bottom);
}

function probe(view: EditorView) {
  const s = view.state, sel = s.selection, $p = sel.$head, p = $p.parent;
  if (!view.hasFocus() || view.composing || !sel.empty) return null;
  if (!p.isTextblock || p.type.spec.code || p.type.name === "detailsSummary") return null;
  if (!wantGhost(p.textBetween(0, p.content.size, undefined, "\ufffc"), $p.parentOffset)) return null;
  const pos = sel.head;
  return {
    context: () => mdAround(s, pos),
    still: () => !view.isDestroyed && view.state.doc === s.doc && view.state.selection.head === pos,
    show: (text: string) => view.dispatch(view.state.tr.setMeta(ghostKey, { text, pos })),
  };
}

export const Ghost = Extension.create<{ complete?: Complete }>({
  name: "cbGhost",
  priority: 1000, // Tab / Esc 先到这里
  addOptions() { return { complete: undefined }; },
  addProseMirrorPlugins() {
    const complete = this.options.complete;
    if (!complete) return [];
    return [new Plugin<G>({
      key: ghostKey,
      state: {
        init: () => null,
        apply(tr, g) {
          const m = tr.getMeta(ghostKey);
          if (m !== undefined) return m as G;
          if (!g) return null;
          if (tr.docChanged) {
            const typed = tr.steps.length === 1 && tr.selection.empty && tr.selection.head > g.pos && tr.mapping.map(g.pos, -1) === g.pos ? tr.doc.textBetween(g.pos, tr.selection.head, "") : "";
            return eatGhost(g, typed, tr.selection.head);
          }
          if (tr.selectionSet && tr.selection.head !== g.pos) return null;
          return g;
        },
      },
      props: {
        decorations(s) {
          const g = ghostKey.getState(s);
          if (!g) return null;
          const span = document.createElement("span");
          span.className = "md-ghost";
          span.textContent = g.text;
          span.setAttribute("aria-hidden", "true");
          return DecorationSet.create(s.doc, [Decoration.widget(g.pos, span, { side: 1, ignoreSelection: true, key: `g${g.pos}${g.text}` })]);
        },
        handleKeyDown(view, e) {
          const g = ghostKey.getState(view.state);
          if (!g || e.isComposing) return false;
          if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // the whole suggestion comes in as source, one undo step of its own
            // 光标后面是自动补的右括号（打 $\frac{ 时补的 }），补全里按顺序也写了它们：先删掉，不然多出一个
            const auto = autoClosersAt(view.state, g.pos);
            let n = 0;
            for (let i = 0; n < auto.length && i < g.text.length; i++) if (g.text[i] === auto[n]) n++;
            const tr = closeHistory(view.state.tr);
            if (n) tr.delete(g.pos, g.pos + n);
            view.dispatch(tr.insertText(g.text, g.pos).setMeta(ghostKey, null));
            return true;
          }
          // ⌘→（Windows / Linux 上 Ctrl+→）：只接受下一个词
          if (e.key === "ArrowRight" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
            const w = nextWord(g.text);
            const tr = view.state.tr.insertText(w, g.pos);
            view.dispatch(w.length === g.text.length ? tr.setMeta(ghostKey, null) : tr);
            return true;
          }
          if (e.key === "Escape") { view.dispatch(view.state.tr.setMeta(ghostKey, null)); return true; }
          return false;
        },
      },
      view: (v) => {
        const asker = new GhostAsker(complete, () => { if (!v.isDestroyed && ghostKey.getState(v.state)) v.dispatch(v.state.tr.setMeta(ghostKey, null)); });
        return {
          update(view, prev) {
            const g = ghostKey.getState(view.state);
            if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection)) {
              // 灰字还在（打的字吃掉了一部分）就不再问
              if (!g) asker.schedule(() => probe(view));
              else asker.cancel();
            }
            if (g && g !== ghostKey.getState(prev)) reveal(view, g.pos);
          },
          destroy() { asker.dispose(); },
        };
      },
    })];
  },
});
