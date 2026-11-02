// The pointer over a code card's lines: which row it is on (that row's link ports show), and a definition preview (Peek) for the
// name under it once it holds still
import { createSignal } from "solid-js";
import { langInfo } from "@codeboard/analysis/langs";
import { dragging } from "../../state/ui";
import { tune } from "../../state/tune";
import { ROW_LEAVE } from "../../state/timing";
import * as act from "../../actions";
import { rowEl, rowOf, type CodeCx } from "./cx";

/** 第 i 个字符前面有没有没配对的引号（单行内；三引号字符串的中间行靠高亮 class 判断） */
function inQuotes(t: string, i: number) {
  let q = "";
  for (let k = 0; k < i; k++) {
    const ch = t[k];
    if (q) {
      if (ch === "\\") k++;
      else if (ch === q) q = "";
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#") return true;
  }
  return !!q;
}

/** inSel(seg, line): the line is in the line selection (no Peek there: selecting lines sweeps over names) */
export function useLineHover(cx: CodeCx, inSel: (seg: string, line: number) => boolean) {
  const [hoverRow, setHoverRow] = createSignal(-1);
  let peekKey = "",
    peekTimer: number | undefined,
    peekPt = { x: 0, y: 0 },
    leaveT: number | undefined;
  const clearPeek = () => {
    if (peekKey) {
      peekKey = "";
      clearTimeout(peekTimer);
      act.scheduleHidePeek();
    }
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons || dragging().size) return;
    const rowE = rowEl(cx, e.target as Node);
    clearTimeout(leaveT);
    setHoverRow(rowE ? +rowE.dataset.r! : -1);
    act.hoverCall(cx.card().id, (rowOf(cx, rowE) as { seg?: string } | undefined)?.seg, e.target);
    // caretPositionFromPoint is the standard one; engines without it have caretRangeFromPoint
    const pos = "caretPositionFromPoint" in document ? document.caretPositionFromPoint(e.clientX, e.clientY) : null;
    const rng: Range | null = pos
      ? (() => {
          const r = document.createRange();
          r.setStart(pos.offsetNode, pos.offset);
          return r;
        })()
      : (document.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null);
    const r = rowOf(cx, rowE);
    if (!rng || !rowE || !r || r.t !== "line" || !rowE.contains(rng.startContainer)) return clearPeek();
    const pre = document.createRange();
    pre.selectNodeContents(rowE);
    pre.setEnd(rng.startContainer, rng.startOffset);
    const col = pre.toString().length;
    const s = cx.segById(r.seg)!;
    const text = s.text[r.line - s.start] ?? "";
    let a = col,
      b = col;
    while (a > 0 && /\w/.test(text[a - 1])) a--;
    while (b < text.length && /\w/.test(text[b])) b++;
    const word = text.slice(a, b);
    // 鼠标确实在这个词上（不是行尾空白）
    const tr = (rng.startContainer as Text).length !== undefined ? rng : null;
    if (!word || !/^[A-Za-z_]/.test(word) || langInfo(s.lang)?.keywords?.has(word) || !tr || /#/.test(text.slice(0, a)))
      return clearPeek();
    // 字符串、注释里的字不是代码里的名字：不弹 Peek（看高亮的 class；没高亮时数引号）
    const tok = (rng.startContainer.parentElement as HTMLElement | null)?.closest?.(".str, .com");
    if (tok || inQuotes(text, a)) return clearPeek();
    // 选中的行上不弹（选行时很容易扫过名字）
    if (inSel(r.seg, r.line)) return clearPeek();
    const key = `${r.seg}:${r.line}:${a}`;
    // 按住 ⌘ 移动和不按一样：同时只一个、不固定。固定只靠按下 ⌘ 那一下（interact.ts）或菜单的 Peek Definition
    // 同一个词上：鼠标还在晃就重新计时，停稳了才弹
    if (key === peekKey) {
      if (Math.hypot(e.clientX - peekPt.x, e.clientY - peekPt.y) <= tune("peekStill")) return;
      clearTimeout(peekTimer);
    } else {
      clearPeek();
      peekKey = key;
    }
    peekPt = { x: e.clientX, y: e.clientY };
    peekTimer = window.setTimeout(() => {
      if (peekKey === key) act.showPeek(rowE, cx.card().id, r.seg, r.line, a, word);
    }, tune("peekDelay"));
  };
  return {
    hoverRow,
    onMove,
    onLeave: () => {
      clearPeek();
      clearTimeout(leaveT);
      leaveT = window.setTimeout(() => setHoverRow(-1), ROW_LEAVE);
    },
    /** The pointer went onto the row's link port: the row stays */
    keepRow: () => clearTimeout(leaveT),
    /** A line number hovered: that line's ports show, as on its code */
    hoverNo: (e: PointerEvent, row: number) => {
      if (e.buttons || dragging().size) return;
      clearTimeout(leaveT);
      clearPeek();
      setHoverRow(row);
    },
    /** A press on the code: no Peek coming */
    stopPeek: () => clearTimeout(peekTimer),
  };
}
