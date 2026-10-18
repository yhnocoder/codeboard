// 代码里的灰字补全：和 Note 的一样问宿主的 complete（DeepSeek FIM / Copilot…），停笔一会儿后在光标后显示灰字。
// Tab 接受（补全菜单开着时 Tab 归菜单），⌘→ 接受一个词，Esc / 继续打字清掉（打的正好是灰字开头就只吃掉那几个字）
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";

export type GhostHost = { complete(before: string, after: string): Promise<string | null>; delay?: number };

type G = { text: string; pos: number } | null;
const setGhost = StateEffect.define<G>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: GhostWidget) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "md-ghost"; s.textContent = this.text; s.setAttribute("aria-hidden", "true"); return s; }
  ignoreEvent() { return true; }
}

export const ghostField = StateField.define<G>({
  create: () => null,
  update(g, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!g) return null;
    if (tr.docChanged) {
      let typed = "", ok = true;
      tr.changes.iterChanges((a, b, _c, _d, ins) => { if (a !== g.pos || b !== a) ok = false; else typed += ins.toString(); });
      if (ok && typed && g.text.startsWith(typed)) { const rest = g.text.slice(typed.length); return rest ? { text: rest, pos: g.pos + typed.length } : null; }
      return null;
    }
    if (tr.selection && tr.selection.main.head !== g.pos) return null;
    return g;
  },
  provide: (f) => EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none)),
});

/** 有灰字就接受（all = 整段，否则一个词）；没有回 false */
export function acceptGhost(v: EditorView, all = true): boolean {
  const g = v.state.field(ghostField, false);
  if (!g) return false;
  const w = all ? g.text : (/^\s*[^\s]+/.exec(g.text)?.[0] ?? g.text);
  v.dispatch({ changes: { from: g.pos, insert: w }, selection: { anchor: g.pos + w.length }, userEvent: "input.complete" });
  return true;
}
export function dropGhost(v: EditorView): boolean {
  if (!v.state.field(ghostField, false)) return false;
  v.dispatch({ effects: setGhost.of(null) });
  return true;
}

export function ghostExtension(host: GhostHost): Extension {
  const delay = host.delay ?? 700;
  const plugin = ViewPlugin.fromClass(class {
    timer: number | undefined;
    n = 0;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.docChanged && !u.selectionSet && !u.focusChanged) return;
      if (u.state.field(ghostField, false)) { clearTimeout(this.timer); this.n++; return; }
      this.schedule();
    }
    schedule() {
      clearTimeout(this.timer);
      const id = ++this.n, v = this.view;
      if (!v.hasFocus || !this.want()) return;
      this.timer = window.setTimeout(async () => {
        if (id !== this.n || !this.want() || completionStatus(v.state)) return;
        const s = v.state, pos = s.selection.main.head;
        const text = await host.complete(s.sliceDoc(0, pos), s.sliceDoc(pos)).catch(() => null);
        if (id !== this.n || !text || !v.dom.isConnected || v.state.doc !== s.doc || v.state.selection.main.head !== pos || completionStatus(v.state)) return;
        v.dispatch({ effects: setGhost.of({ text, pos }) });
      }, delay);
    }
    /** 光标在行尾（或后面只有空白、收尾的括号），这一行有字 */
    want() {
      const s = this.view.state, sel = s.selection.main;
      if (!sel.empty || s.selection.ranges.length > 1) return false;
      const l = s.doc.lineAt(sel.head), after = l.text.slice(sel.head - l.from);
      return /^[\s)\]}]*$/.test(after) && l.text.trim().length >= 2;
    }
    destroy() { clearTimeout(this.timer); this.n++; }
  });
  return [ghostField, plugin];
}
