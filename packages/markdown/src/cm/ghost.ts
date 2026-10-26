// 补全菜单开着时不显示灰字，Tab 归菜单
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { GhostAsker, eatGhost, nextWord, wantGhost, type Complete, type Ghost } from "../ui/ghost";

export type GhostHost = { complete: Complete };

const setGhost = StateEffect.define<Ghost>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: GhostWidget) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "md-ghost"; s.textContent = this.text; s.setAttribute("aria-hidden", "true"); return s; }
  ignoreEvent() { return true; }
}

const ghostField = StateField.define<Ghost>({
  create: () => null,
  update(g, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!g) return null;
    if (tr.docChanged) {
      let typed = "", ok = true;
      tr.changes.iterChanges((a, b, _c, _d, ins) => { if (a !== g.pos || b !== a) ok = false; else typed += ins.toString(); });
      return ok ? eatGhost(g, typed, g.pos + typed.length) : null;
    }
    if (tr.selection && tr.selection.main.head !== g.pos) return null;
    return g;
  },
  provide: (f) => EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none)),
});

/** all = 整段，否则一个词 */
export function acceptGhost(v: EditorView, all = true): boolean {
  const g = v.state.field(ghostField, false);
  if (!g) return false;
  const w = all ? g.text : nextWord(g.text);
  v.dispatch({ changes: { from: g.pos, insert: w }, selection: { anchor: g.pos + w.length }, userEvent: "input.complete" });
  return true;
}
export function dropGhost(v: EditorView): boolean {
  if (!v.state.field(ghostField, false)) return false;
  v.dispatch({ effects: setGhost.of(null) });
  return true;
}

export function ghostExtension(host: GhostHost): Extension {
  const plugin = ViewPlugin.fromClass(class {
    asker = new GhostAsker(host.complete, () => dropGhost(this.view));
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.docChanged && !u.selectionSet && !u.focusChanged) return;
      // 灰字还在（打的字吃掉了一部分）就不再问
      if (u.state.field(ghostField, false)) this.asker.cancel();
      else this.asker.schedule(() => this.probe());
    }
    probe() {
      const v = this.view, s = v.state, sel = s.selection;
      if (!v.hasFocus || !sel.main.empty || sel.ranges.length > 1) return null;
      const pos = sel.main.head, l = s.doc.lineAt(pos);
      if (!wantGhost(l.text, pos - l.from)) return null;
      return {
        context: (): [string, string] => [s.sliceDoc(0, pos), s.sliceDoc(pos)],
        still: () => v.dom.isConnected && v.state.doc === s.doc && v.state.selection.main.head === pos && !completionStatus(v.state),
        show: (text: string) => v.dispatch({ effects: setGhost.of({ text, pos }) }),
      };
    }
    destroy() { this.asker.dispose(); }
  });
  return [ghostField, plugin];
}
