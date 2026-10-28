// 代码编辑器里的查找 / 替换：@codemirror/search 管查询、高亮（.cm-searchMatch）和替换，条是 ui/find.ts 的那一个，
// 放在 CodeMirror 的面板里（search 的 createPanel），浮在右上角不占排版
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, type Panel } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { SearchQuery, search, setSearchQuery, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { FindBar, findKey, seedText, type FindSpec, type FindTarget } from "../ui/find";

const bars = new WeakMap<EditorView, FindBar>();
/** 数到这么多就不往下数了（显示 n+） */
const MAX_COUNT = 9999;

function target(view: EditorView, origin: () => number): FindTarget {
  const isolate = () => view.dispatch({ annotations: isolateHistory.of("full") });
  return {
    query(spec: FindSpec, moved) {
      const q = new SearchQuery({ search: spec.search, replace: spec.replace, caseSensitive: spec.caseSensitive, literal: true });
      let m: { from: number; to: number } | null = null;
      if (moved && q.valid) {
        const a = q.getCursor(view.state, origin()).next();
        m = a.done ? (q.getCursor(view.state).next().value ?? null) : a.value;
      }
      view.dispatch({ effects: setSearchQuery.of(q), ...(m ? { selection: { anchor: m.from, head: m.to }, scrollIntoView: true } : {}) });
    },
    next: () => { findNext(view); },
    prev: () => { findPrevious(view); },
    replace: () => { replaceNext(view); },
    // 一步：前后各断开撤销记录，不和前后打的字连成一次撤销
    replaceAll: () => { isolate(); replaceAll(view); isolate(); },
    count() {
      const q = getSearchQuery(view.state), main = view.state.selection.main;
      if (!q.valid) return { at: 0, total: 0 };
      let total = 0, at = 0;
      for (const c = q.getCursor(view.state); total < MAX_COUNT;) {
        const r = c.next();
        if (r.done) break;
        total++;
        if (r.value.from === main.from && r.value.to === main.to) at = total;
      }
      return { at, total };
    },
    closed() { view.focus(); closeSearchPanel(view); },
  };
}

/** 打开（已经开着就再选中查找框） */
function openFind(view: EditorView, replace: boolean) {
  const { from, to } = view.state.selection.main;
  if (!searchPanelOpen(view.state)) openSearchPanel(view);
  bars.get(view)?.show(replace, seedText(view.state.sliceDoc(from, to)));
  return true;
}

/** 查找条开着就关上（Esc） */
export function closeFind(view: EditorView) {
  if (!searchPanelOpen(view.state)) return false;
  const b = bars.get(view);
  if (b) b.close(); else closeSearchPanel(view);
  return true;
}

/** leave：焦点从查找条去了编辑器外面（和编辑器失焦一样） */
export function findExtension(o: { isMac?: boolean; leave: (e: FocusEvent) => void }): Extension[] {
  return [
    search({
      top: true,
      literal: true,
      createPanel: (view): Panel => {
        const origin = view.state.selection.main.from;
        const bar = new FindBar(target(view, () => origin), { isMac: o.isMac, owns: (n) => view.dom.contains(n), leave: o.leave });
        bars.set(view, bar);
        return {
          dom: bar.el,
          top: true,
          update: (u) => { if (u.docChanged || u.selectionSet) bar.refresh(); },
          destroy: () => { if (bars.get(view) === bar) bars.delete(view); },
        };
      },
    }),
    // ⌘F / ⌥⌘F / ⌘H（和 Note 一样按 e.code 认字母：⌥ 在 mac 上改了 e.key，键表认不出来）
    Prec.highest(EditorView.domEventHandlers({ keydown: (e, v) => { const k = findKey(e); if (!k) return false; e.preventDefault(); return openFind(v, k === "replace"); } })),
    EditorView.theme({
      // 面板不占地方：条浮在右上角（ui/find.ts 的 .md-find）
      ".cm-panels": { background: "transparent", color: "inherit", height: "0", overflow: "visible" },
      ".cm-panels.cm-panels-top": { border: "none" },
      ".cm-searchMatch": { background: "color-mix(in srgb, var(--accent) 18%, transparent)", borderRadius: "2px" },
      ".cm-searchMatch.cm-searchMatch-selected": { background: "color-mix(in srgb, var(--accent) 42%, transparent)" },
    }),
  ];
}
