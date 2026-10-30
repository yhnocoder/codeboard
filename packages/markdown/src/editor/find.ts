// Note 编辑器里的查找 / 替换：prosemirror-search 管查询条件和替换，所有的匹配这里一遍找出（matches），条是 ui/find.ts 的那一个。
// 匹配不用 ProseMirror 的装饰画：长 Note 里几百个匹配一变，每一段都要重画（行内公式的节点视图也跟着重排），查找框里打一个字
// 要几十到几百毫秒。换成 CSS Custom Highlight（::highlight(md-find)，只交几个 Range，不动 DOM）；代码块里的交给它自己的 CodeMirror 画
import { Extension } from "@tiptap/core";
import { Plugin, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { SearchQuery, search, setSearchState, getSearchState, findNext, findPrev, replaceNext, replaceAll } from "prosemirror-search";
import { FindBar, seedText, type FindBarOpts, type FindSpec, type FindTarget } from "../ui/find";
import { codeBlockAt, type CodeBlockView, type Found } from "./codeblock";

const HL = "md-find", CUR = "md-find-cur";

type SearchSt = { query: SearchQuery; range: { from: number; to: number } | null; deco: DecorationSet };

/** prosemirror-search 的插件，只留它记查询（查找、替换的命令要读它）：不画装饰（见上），也不在每次查询、选区变化时
 * 把全文的匹配做成一个 DecorationSet（它每找一个都从文档根往下扫一遍，长 Note 里打一个字要好几毫秒）；匹配由下面的 matches 一遍找出 */
function searchState() {
  const p = search();
  delete (p.props as { decorations?: unknown }).decorations;
  (p.spec as { state: unknown }).state = {
    init: (): SearchSt => ({ query: new SearchQuery({ search: "" }), range: null, deco: DecorationSet.empty }),
    apply(tr: Transaction, st: SearchSt): SearchSt {
      const set = tr.getMeta(p) as Omit<SearchSt, "deco"> | undefined;
      if (set) return { query: set.query, range: set.range, deco: DecorationSet.empty };
      if (!tr.docChanged || !st.range) return st;
      const from = tr.mapping.map(st.range.from, 1), to = tr.mapping.map(st.range.to, -1);
      return { ...st, range: from < to ? { from, to } : null };
    },
  };
  return p;
}

/** 一个文本块里给查找用的字：和 prosemirror-search 的一样（行内叶子算一个 \ufffc，行内的非叶子前后各一个空格），下标就是块里的位置。
 * 节点不变就不重算，小写的那份也一样 */
const blockText = new WeakMap<PMNode, string>(), blockLower = new WeakMap<PMNode, string>();
function textOf(node: PMNode): string {
  let t = blockText.get(node);
  if (t === undefined) {
    t = "";
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      t += c.isText ? c.text! : c.isLeaf ? "\ufffc" : ` ${textOf(c)} `;
    }
    blockText.set(node, t);
  }
  return t;
}
function lowerOf(node: PMNode) {
  let t = blockLower.get(node);
  if (t === undefined) blockLower.set(node, (t = textOf(node).toLowerCase()));
  return t;
}

/** 一个匹配：start 是它所在文本块的内容起点，code 是不是在代码块里 */
type Hit = { from: number; to: number; start: number; code: boolean };

/** 这份文档里这个查询的所有匹配，按位置排好：一遍走过所有文本块，每块 indexOf 到底（和 prosemirror-search 一个一个找的结果一样：
 * 不重叠，从前往后）。只看查询条件和文档，选区变了（上下翻）不重找；重画和数个数共用 */
const hitCache = new WeakMap<PMNode, { key: string; hits: Hit[] }>();
function allHits(doc: PMNode, q: SearchQuery | undefined): Hit[] {
  if (!q?.valid) return [];
  const key = `${q.caseSensitive ? 1 : 0}${q.search}`, had = hitCache.get(doc);
  if (had?.key === key) return had.hits;
  const needle = q.caseSensitive ? q.search : q.search.toLowerCase(), n = needle.length, hits: Hit[] = [];
  doc.descendants((node, pos) => {
    if (!node.inlineContent) return true;
    const t = q.caseSensitive ? textOf(node) : lowerOf(node), start = pos + 1, code = !!node.type.spec.code;
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + n)) hits.push({ from: start + i, to: start + i + n, start, code });
    return false;
  });
  hitCache.set(doc, { key, hits });
  return hits;
}

/** 所有匹配，和选中的是第几个（从 1 起，没选中匹配是 0） */
function matches(state: EditorState) {
  const ds = allHits(state.doc, getSearchState(state)?.query), { from, to } = state.selection;
  let lo = 0, hi = ds.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m].from < from) lo = m + 1; else hi = m; }
  return { ds, at: lo < ds.length && ds[lo].from === from && ds[lo].to === to ? lo + 1 : 0 };
}

/** 屏幕上（窗口里，上下各多半屏）看得见的匹配，和选中的那个上下一屏以内的（滚到它以后看得见的）：下标区间，排好、不重叠。
 * 匹配按位置排好，所在文本块在屏幕上也是从上往下排的，二分着量几个块就够 */
function nearby(view: EditorView, ds: Hit[], at: number): [number, number][] {
  const rect = (i: number) => (view.nodeDOM(ds[i].start - 1) as Element | null)?.getBoundingClientRect?.();
  const span = (top: number, bottom: number): [number, number] => {
    let lo = 0, hi = ds.length;
    while (lo < hi) { const m = (lo + hi) >> 1, r = rect(m); if (r && r.bottom < top) lo = m + 1; else hi = m; }
    const a = lo;
    hi = ds.length;
    while (lo < hi) { const m = (lo + hi) >> 1, r = rect(m); if (!r || r.top <= bottom) lo = m + 1; else hi = m; }
    return [a, lo];
  };
  const vh = window.innerHeight, out = [span(-vh / 2, vh * 1.5)], r = at ? rect(at - 1) : undefined;
  if (r) out.push(span(r.top - vh, r.bottom + vh));
  out.sort((x, y) => x[0] - y[0]);
  // 合起来；代码块里的一串匹配不拆开（块要一次拿到它的全部）
  const merged: [number, number][] = [];
  for (let [a, z] of out) {
    if (a >= z) continue;
    while (a > 0 && ds[a - 1].code && ds[a - 1].start === ds[a].start) a--;
    while (z < ds.length && ds[z].code && ds[z].start === ds[z - 1].start) z++;
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], z); else merged.push([a, z]);
  }
  return merged;
}

/** 分批画看不见的匹配时，一批最多用这么久（毫秒），然后让出去（排版、绘制、下一次按键） */
const PAINT_SLICE = 4;

/** 编辑器每次更新（文档、选区、查找条件变了，DOM 已经是新的）后重画匹配：正文的是 Range，代码块里的交给块自己。
 * 一个字母在长 Note 里能有上千个匹配，每个都要 domAtPos（从文档根往下找）：这一次更新里只画屏幕上和选中的那个附近的，
 * 其余的之后分批（每批 PAINT_SLICE）加进同一个 Highlight，打字时每一下的工作量不随 Note 变长。
 * 同一个文本节点里的匹配借上一次找到的节点。用 StaticRange 不用 Range：活的 Range 每次 DOM 有改动（编辑器里打字、查找条改个数）
 * 浏览器都要挨个调整，几百个就是每次一两毫秒；这里每次更新都整个重画，用不着它们跟着变 */
function painter() {
  let blocks = new Set<CodeBlockView>(), painted = false, job: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(job); job = undefined; CSS.highlights.delete(HL); CSS.highlights.delete(CUR); };
  return new Plugin({
    view: () => ({
      update(view) {
        const { ds, at } = matches(view.state);
        if (!ds.length && !painted && !blocks.size) return;
        clear();
        const all = new Highlight(), cur = new Highlight(), inCode = new Set<CodeBlockView>();
        let text: Text | null = null, textAt = 0;
        /** 画 ds[a..z)（z 落在代码块那一串匹配的中间时往后画完那一串）：返回画到哪 */
        const paint = (a: number, z: number, until = Infinity) => {
          let i = a;
          while (i < z && performance.now() < until) {
            const d = ds[i];
            if (d.code) {
              const rs: Found[] = [];
              for (; i < ds.length && ds[i].code && ds[i].start === d.start; i++) rs.push({ from: ds[i].from - d.start, to: ds[i].to - d.start, cls: i + 1 === at ? "md-find-on" : "md-find-hit" });
              const b = codeBlockAt.get(view.nodeDOM(d.start - 1) as Element);
              if (b) { b.showFound(rs); inCode.add(b); }
              continue;
            }
            let s: { node: Node; offset: number }, e: { node: Node; offset: number };
            if (text && d.from >= textAt && d.to <= textAt + text.length) {
              s = { node: text, offset: d.from - textAt };
              e = { node: text, offset: d.to - textAt };
            } else {
              s = view.domAtPos(d.from);
              if (s.node instanceof Text) { text = s.node; textAt = d.from - s.offset; } else text = null;
              e = text && d.to <= textAt + text.length ? { node: text, offset: d.to - textAt } : view.domAtPos(d.to);
            }
            (i + 1 === at ? cur : all).add(new StaticRange({ startContainer: s.node, startOffset: s.offset, endContainer: e.node, endOffset: e.offset }));
            i++;
          }
          return i;
        };
        // 上一次画过、这次（可能）没有匹配的代码块先清掉；有的下面会再画
        for (const b of blocks) if (b.dom.isConnected) b.showFound([]);
        blocks = inCode;
        painted = ds.length > 0;
        if (!ds.length) return;
        CSS.highlights.set(HL, all);
        CSS.highlights.set(CUR, cur);
        const near = nearby(view, ds, at), rest: [number, number][] = [];
        let from = 0;
        for (const [a, z] of near) { paint(a, z); if (from < a) rest.push([from, a]); from = z; }
        if (from < ds.length) rest.push([from, ds.length]);
        const more = () => {
          const until = performance.now() + PAINT_SLICE;
          while (rest.length) {
            const r = rest[0];
            text = null;
            r[0] = paint(r[0], r[1], until);
            if (r[0] < r[1]) { job = setTimeout(more); return; }
            rest.shift();
          }
          job = undefined;
        };
        if (rest.length) job = setTimeout(more);
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
      const q = query(spec), tr = setSearchState(view.state.tr, q);
      if (moved) {
        // 从打开查找时的光标往后的第一个，后面没有就回到第一个（和 findNext 绕回去一样）
        const ds = allHits(tr.doc, q), o = origin(), m = ds.find((d) => d.from >= o) ?? ds[0];
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
