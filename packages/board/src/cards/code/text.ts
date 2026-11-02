// Text in a code card: selecting lines by dragging over the code, copying only the code (no line numbers, relative indentation
// kept), and where a selection is in the source (for the line menu's annotations and for editing free code)
import { onCleanup, onMount } from "solid-js";
import { copyText } from "@codeboard/core";
import { setLineSel, reportSelection } from "../../state/selection";
import { rowEl, rowOf, type CodeCx } from "./cx";

/** Dragging over the code selects whole lines of one segment (the line selection), as clicking line numbers does */
export function useLineSelection(cx: CodeCx) {
  const onSelChange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const src = cx.src();
    if (!src.contains(r.startContainer) || !src.contains(r.endContainer)) return;
    const ra = rowOf(cx, rowEl(cx, r.startContainer)),
      rb = rowOf(cx, rowEl(cx, r.endContainer));
    if (ra?.t !== "line" || rb?.t !== "line" || ra.seg !== rb.seg) return;
    setLineSel({ card: cx.card().id, seg: ra.seg, start: Math.min(ra.line, rb.line), end: Math.max(ra.line, rb.line) });
    reportSelection();
  };
  onMount(() => {
    document.addEventListener("selectionchange", onSelChange);
    onCleanup(() => document.removeEventListener("selectionchange", onSelChange));
  });
}

/** Copy: only the code text (the first and last lines cut at the selection), keeping the lines' relative indentation */
export function copyCode(cx: CodeCx, e: ClipboardEvent) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const src = cx.src();
  if (!src.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== src) return;
  const out: string[] = [];
  src.querySelectorAll<HTMLElement>(":scope > .l").forEach((el) => {
    if (!range.intersectsNode(el)) return;
    const r = rowOf(cx, el);
    if (r?.t !== "line") return;
    const s = cx.segById(r.seg)!;
    let t = s.text[r.line - s.start] ?? "";
    const pre = document.createRange();
    pre.selectNodeContents(el);
    if (el.contains(range.endContainer)) {
      pre.setEnd(range.endContainer, range.endOffset);
      t = t.slice(0, pre.toString().length);
    }
    if (el.contains(range.startContainer)) {
      const p2 = document.createRange();
      p2.selectNodeContents(el);
      p2.setEnd(range.startContainer, range.startOffset);
      t = t.slice(p2.toString().length);
      if (!el.contains(range.endContainer)) t = " ".repeat(p2.toString().length) + t; // 首行从中间选起：保留和下面几行的相对缩进
    }
    out.push(t);
  });
  if (!out.length) return;
  e.preventDefault();
  e.clipboardData?.setData("text/plain", out.length > 1 ? copyText(out) : out[0]);
}

/** 选中的字在同一行里时：第几行、第几到第几个字（按原文算） */
export function textSel(cx: CodeCx) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined;
  const rg = sel.getRangeAt(0),
    a = rowEl(cx, rg.startContainer);
  if (!a || a !== rowEl(cx, rg.endContainer)) return undefined;
  const r = rowOf(cx, a);
  if (r?.t !== "line") return undefined;
  const off = (n: Node, o: number) => {
    const p = document.createRange();
    p.selectNodeContents(a);
    p.setEnd(n, o);
    return p.toString().length;
  };
  const s = cx.segById(r.seg),
    t = s?.text[r.line - s.start] ?? "";
  let from = off(rg.startContainer, rg.startOffset),
    to = off(rg.endContainer, rg.endOffset);
  while (from < to && /\s/.test(t[from])) from++;
  while (to > from && /\s/.test(t[to - 1])) to--;
  return to > from ? { card: cx.card().id, seg: r.seg, line: r.line, from, to } : undefined;
}

/** 选区两头：第几段第几行第几个字（见 codeTextRange）。显示的字和原文的开头对不上时给 null */
export function textRange(cx: CodeCx, rg: Range) {
  const at = (n: Node, o: number) => {
    const a = rowEl(cx, n),
      r = rowOf(cx, a);
    const s = r?.t === "line" ? cx.segById(r.seg) : undefined;
    if (!a || r?.t !== "line" || !s) return null;
    const p = document.createRange();
    p.selectNodeContents(a);
    p.setEnd(n, o);
    const pre = p.toString().replace(/​/g, ""),
      i = r.line - s.start;
    return (s.text[i] ?? "").startsWith(pre) ? { seg: r.seg, pos: [i, pre.length] as [number, number] } : null;
  };
  const a = at(rg.startContainer, rg.startOffset),
    b = at(rg.endContainer, rg.endOffset);
  return a && b && a.seg === b.seg ? { seg: a.seg, from: a.pos, to: b.pos } : null;
}
