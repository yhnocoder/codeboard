// Note 编辑器里的查找 / 替换：prosemirror-search 管查询、找出所有匹配和替换，条是 ui/find.ts 的那一个。
// 匹配不用 ProseMirror 的装饰画：长 Note 里几百个匹配一变，每一段都要重画（行内公式的节点视图也跟着重排），查找框里打一个字
// 要几十到几百毫秒。换成 CSS Custom Highlight（::highlight(md-find)，只交几个 Range，不动 DOM）；代码块里的交给它自己的 CodeMirror 画
import { Extension } from "@tiptap/core";
import { Plugin, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { SearchQuery, search, setSearchState, getSearchState, getMatchHighlights, findNext, findPrev, replaceNext, replaceAll } from "prosemirror-search";
import { FindBar, seedText, type FindBarOpts, type FindSpec, type FindTarget } from "../ui/find";
import { codeBlockAt, type CodeBlockView, type Found } from "./codeblock";

const HL = "md-find", CUR = "md-find-cur";

/** prosemirror-search 的插件，去掉它画装饰的那一项（见上） */
function searchState() {
  const p = search();
  delete (p.props as { decorations?: unknown }).decorations;
  return p;
}

/** 这个状态下所有的匹配（prosemirror-search 找好的），和选中的是第几个（从 1 起，没选中匹配是 0）：重画和数个数共用，一个状态只算一次 */
const matchCache = new WeakMap<EditorState, { ds: { from: number; to: number }[]; at: number }>();
function matches(state: EditorState) {
  let m = matchCache.get(state);
  if (!m) {
    const ds = getMatchHighlights(state).find(), { from, to } = state.selection;
    m = { ds, at: ds.findIndex((d) => d.from === from && d.to === to) + 1 };
    matchCache.set(state, m);
  }
  return m;
}

/** 编辑器每次更新（文档、选区、查找条件变了，DOM 已经是新的）后重画匹配：正文的是 Range，代码块里的交给块自己 */
function painter() {
  let blocks = new Set<CodeBlockView>(), painted = false;
  const clear = () => { CSS.highlights.delete(HL); CSS.highlights.delete(CUR); };
  return new Plugin({
    view: () => ({
      update(view) {
        const { ds, at } = matches(view.state);
        if (!ds.length && !painted && !blocks.size) return;
        const all: Range[] = [], cur: Range[] = [], inCode = new Map<CodeBlockView, Found[]>();
        for (let i = 0; i < ds.length; i++) {
          const d = ds[i], on = i + 1 === at, $f = view.state.doc.resolve(d.from);
          if ($f.parent.type.spec.code) {
            const b = codeBlockAt.get(view.nodeDOM($f.before()) as Element);
            if (b) inCode.set(b, [...(inCode.get(b) ?? []), { from: d.from - $f.start(), to: d.to - $f.start(), cls: on ? "md-find-on" : "md-find-hit" }]);
            continue;
          }
          const a = view.domAtPos(d.from), z = view.domAtPos(d.to), r = document.createRange();
          r.setStart(a.node, a.offset);
          r.setEnd(z.node, z.offset);
          (on ? cur : all).push(r);
        }
        clear();
        if (all.length) CSS.highlights.set(HL, new Highlight(...all));
        if (cur.length) CSS.highlights.set(CUR, new Highlight(...cur));
        painted = all.length + cur.length > 0;
        for (const b of blocks) if (!inCode.has(b) && b.dom.isConnected) b.showFound([]);
        for (const [b, rs] of inCode) b.showFound(rs);
        blocks = new Set(inCode.keys());
      },
      destroy: () => { clear(); blocks.clear(); painted = false; },
    }),
  });
}

/** 查找条开着时 Esc 先关它（菜单、灰字、公式提示还是先拿 Esc，见优先级；关不了的才轮到保存退出） */
export const FindExt = (close: (view: EditorView) => boolean) => Extension.create({
  name: "cbFind",
  priority: 2,
  addProseMirrorPlugins: () => [searchState(), painter()],
  addKeyboardShortcuts() { return { Escape: () => close(this.editor.view) }; },
});

const query = (q: FindSpec) => new SearchQuery({ search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, literal: true });

function target(view: EditorView, origin: () => number): FindTarget {
  const run = (cmd: typeof findNext) => cmd(view.state, (tr) => view.dispatch(tr));
  return {
    query(spec, moved) {
      const st = view.state, q = query(spec), tr = setSearchState(st.tr, q);
      if (moved && q.valid) {
        const m = q.findNext(st, origin()) ?? q.findNext(st, 0);
        if (m) tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
      }
      view.dispatch(tr);
    },
    next: () => run(findNext),
    prev: () => run(findPrev),
    replace: () => run(replaceNext),
    // 一步：前后各断开撤销记录，不和前后打的字连成一次撤销
    replaceAll: () => {
      if (replaceAll(view.state, (tr) => view.dispatch(closeHistory(tr)))) view.dispatch(closeHistory(view.state.tr));
    },
    count() { const { ds, at } = matches(view.state); return { at, total: ds.length }; },
    closed() {
      view.focus();
      if (getSearchState(view.state)?.query.search) view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: "" })));
    },
  };
}

/** 一次编辑的查找条：第一次 ⌘F 时建，挂在 host 里（编辑器右上角） */
export function noteFind(view: EditorView, host: HTMLElement, o: FindBarOpts) {
  let bar: FindBar | null = null, origin = 0;
  return {
    open(replace: boolean) {
      const { from, to } = view.state.selection;
      if (!bar?.open) origin = from;
      bar ??= new FindBar(target(view, () => origin), o);
      if (!bar.open) { host.classList.add("md-findhost"); host.append(bar.el); }
      bar.show(replace, seedText(view.state.doc.textBetween(from, to, "\n")));
    },
    /** 开着就关上（Esc） */
    close: () => { if (!bar?.open) return false; bar.close(); host.classList.remove("md-findhost"); return true; },
    refresh: () => { if (bar?.open) bar.refresh(); },
    destroy: () => { bar?.el.remove(); host.classList.remove("md-findhost"); },
  };
}
