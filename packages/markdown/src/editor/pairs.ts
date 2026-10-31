// 照 Typora 的默认：Markdown 记号（* _ ` $ ~）不配对
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { blockInfo, flat } from "./spans";

const inCodeSpan = (state: EditorState, pos: number) => {
  const $p = state.doc.resolve(pos),
    off = $p.parentOffset;
  return flat(blockInfo($p.parent.textContent, false).spans).some(
    (s) => s.tag?.nodeName === "code" && s.inner && off > s.inner[0] && off < s.inner[1],
  );
};

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const CLOSE = new Set(Object.values(PAIRS));
const WORD = /[\p{L}\p{N}_]/u;
/** 右边是这些（或什么都没有）时才补右括号：紧贴着字的时候多半是在已有的字前面加括号 */
const OPEN_BEFORE = /^$|[\s)\]}.,;:!?'"]/;
type Auto = { pos: number; ch: string };
const pairsKey = new PluginKey<Auto[]>("cbPairs");

const charAt = (view: EditorView, pos: number) => {
  const $p = view.state.doc.resolve(pos);
  return $p.parent.isTextblock ? $p.parent.textBetween(Math.max(0, $p.parentOffset - 1), $p.parentOffset, "", "￼") : "";
};
const nextChar = (view: EditorView, pos: number) => (pos < view.state.doc.content.size ? charAt(view, pos + 1) : "");

/** pos 起连着的、自动补上的右括号（灰字补全接受时用：补全里已经写了它们就不再多留一个） */
export function autoClosersAt(state: EditorState, pos: number): string {
  const list = pairsKey.getState(state) ?? [];
  let out = "";
  for (let p = pos; ; p++) {
    const a = list.find((x) => x.pos === p);
    if (!a) return out;
    out += a.ch;
  }
}

export function pairsPlugin() {
  return new Plugin<Auto[]>({
    key: pairsKey,
    state: {
      init: () => [],
      apply: (tr, list) => {
        const meta = tr.getMeta(pairsKey) as { add?: Auto; drop?: number } | undefined;
        // drop 是这一步之前的位置：先去掉再映射（被删的那个和它后面的那个会映射到同一个位置）
        let out = meta?.drop !== undefined ? list.filter((a) => a.pos !== meta.drop) : list;
        if (tr.docChanged)
          out = out
            .map((a) => ({ ...a, pos: tr.mapping.map(a.pos, 1) }))
            .filter((a) => tr.doc.textBetween(a.pos, Math.min(a.pos + 1, tr.doc.content.size), "", "￼") === a.ch);
        if (meta?.add) out = [...out.filter((a) => a.pos !== meta.add!.pos), meta.add];
        return out;
      },
    },
    props: {
      handleKeyDown(view, ev) {
        if (ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey || ev.key === "Process") return false;
        const { state } = view,
          sel = state.selection;
        if (!(sel instanceof TextSelection)) return false;
        const $f = sel.$from;
        if (!$f.parent.inlineContent || $f.parent.type.spec.code) return false;
        // Not inside an inline code span: quotes and brackets there are code
        if (inCodeSpan(state, $f.pos)) return false;
        const k = ev.key,
          list = pairsKey.getState(state) ?? [];
        if (k === "Backspace" && sel.empty) {
          const prev = charAt(view, sel.from),
            next = nextChar(view, sel.from);
          if (PAIRS[prev] && PAIRS[prev] === next) {
            view.dispatch(state.tr.delete(sel.from - 1, sel.from + 1));
            return true;
          }
          return false;
        }
        // 盖过自己补的右括号：打的字换掉它，和打字一样先过打字规则（[t](url)、`c` 之类要在这时候变）；没有规则接手就只是光标走过去。
        // 不能删了它再让浏览器把字插进来：紧挨着一样的字（)) ""）时 ProseMirror 从 DOM 读改动分不清插在哪一边
        if (CLOSE.has(k) && sel.empty && list.some((a) => a.pos === sel.from && a.ch === k)) {
          const at = sel.from;
          view.dispatch(state.tr.setMeta(pairsKey, { drop: at }));
          const ruled = view.someProp("handleTextInput", (f) =>
            f(view, at, at + 1, k, () => view.state.tr.insertText(k, at, at + 1)),
          );
          if (!ruled)
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1)).scrollIntoView());
          ev.preventDefault();
          return true;
        }
        const close = PAIRS[k];
        if (!close) return false;
        const prev = charAt(view, sel.from),
          next = nextChar(view, sel.to);
        const tr = state.tr;
        if (!sel.empty) {
          tr.insertText(close, sel.to).insertText(k, sel.from);
          tr.setSelection(TextSelection.create(tr.doc, sel.from + 1, sel.to + 1));
        } else {
          if (k === close && (WORD.test(prev) || WORD.test(next))) return false; // 引号挨着字：撇号、英尺
          if (!OPEN_BEFORE.test(next)) return false;
          tr.insertText(k + close, sel.from);
          tr.setSelection(TextSelection.create(tr.doc, sel.from + 1));
          tr.setMeta(pairsKey, { add: { pos: sel.from + 1, ch: close } });
        }
        view.dispatch(tr.scrollIntoView());
        ev.preventDefault();
        return true;
      },
    },
  });
}
