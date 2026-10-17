// 灰字补全：停笔一会儿后问宿主要一段续写，作为光标后的灰字显示（只是装饰，不进文档）。
// Tab 接受，Esc / 继续打字清掉（打的字正好是灰字的开头就只吃掉那几个字）；输入法组字时不问
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { reconvert } from "./typora";

type G = { text: string; pos: number } | null;
export const ghostKey = new PluginKey<G>("cbGhost");

export const Ghost = Extension.create<{ complete?: (before: string, after: string) => Promise<string | null>; delay: number }>({
  name: "cbGhost",
  priority: 1000, // Tab / Esc 先到这里
  addOptions() { return { complete: undefined, delay: 700 }; },
  addProseMirrorPlugins() {
    const complete = this.options.complete;
    const delay = this.options.delay;
    if (!complete) return [];
    let timer: number | undefined, ask = 0;
    const want = (s: EditorState) => {
      const { selection: sel } = s;
      if (!sel.empty) return false;
      const $p = sel.$head;
      const p = $p.parent;
      if (!p.isTextblock || p.type.spec.code || p.type.name === "detailsSummary") return false;
      // 只在一段的末尾、前面有字时
      return $p.parentOffset === p.content.size && p.textContent.trim().length >= 3;
    };
    const schedule = (view: EditorView) => {
      clearTimeout(timer);
      const id = ++ask;
      if (!view.hasFocus() || view.composing || !want(view.state)) return;
      timer = window.setTimeout(async () => {
        const s = view.state;
        if (id !== ask || view.composing || !want(s)) return;
        const pos = s.selection.head;
        const before = s.doc.textBetween(0, pos, "\n", " "), after = s.doc.textBetween(pos, s.doc.content.size, "\n", " ");
        const text = await complete(before, after).catch(() => null);
        // 等回答的时候又动过：作废
        if (id !== ask || !text || view.isDestroyed || view.state.doc !== s.doc || view.state.selection.head !== pos) return;
        view.dispatch(view.state.tr.setMeta(ghostKey, { text, pos }));
      }, delay);
    };
    return [new Plugin<G>({
      key: ghostKey,
      state: {
        init: () => null,
        apply(tr, g) {
          const m = tr.getMeta(ghostKey);
          if (m !== undefined) return m as G;
          if (!g) return null;
          if (tr.docChanged) {
            // 打的字正好是灰字开头：留下剩下的
            const typed = tr.steps.length === 1 && tr.selection.empty ? tr.doc.textBetween(g.pos, tr.selection.head, "") : "";
            if (typed && tr.selection.head > g.pos && g.text.startsWith(typed) && tr.mapping.map(g.pos, -1) === g.pos) {
              const rest = g.text.slice(typed.length);
              return rest ? { text: rest, pos: tr.selection.head } : null;
            }
            return null;
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
            // 一次进来一整段：打字规则不会触发，这一段当 Markdown 重新解析（$a$、**b**、补完前面打了一半的 $\frac{…）。单独一步撤销
            view.dispatch(reconvert(closeHistory(view.state.tr).insertText(g.text, g.pos).setMeta(ghostKey, null)));
            return true;
          }
          if (e.key === "Escape") { view.dispatch(view.state.tr.setMeta(ghostKey, null)); return true; }
          return false;
        },
      },
      view: () => ({
        update(view, prev) {
          if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection)) {
            const g = ghostKey.getState(view.state);
            // 灰字还在（打的字吃掉了一部分）就不再问
            if (!g) schedule(view);
            else { clearTimeout(timer); ask++; }
          }
        },
        destroy() { clearTimeout(timer); ask++; },
      }),
    })];
  },
});
