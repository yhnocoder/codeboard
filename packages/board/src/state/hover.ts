// 指针下的卡和线：它们的线临时浮到所有卡上面（canvas/Links.tsx 的图层）。卡片、标签、贴纸都从这里读写，不从组件 import
import { createEffect, createMemo, createSelector, on, onCleanup, untrack } from "solid-js";
import { state, hostOf } from "./store";
import { camMoving, stillZ } from "./camera";
import { tune } from "./tune";
import { boardSignal, rooted } from "./root";

export const [hoverLink, setHoverLink] = boardSignal<string | null>(null);
export const [hoverCard, setHoverCard] = boardSignal<string | null>(null);
const isHovered = rooted(() => createSelector(hoverCard));

const PORT = 9;
const portZoom = rooted(() => createMemo(() => {
  const uz = Math.max(1, 1 / stillZ()), uv = Math.sqrt(uz);
  return { "--uv": String(uv), "--port-hit": `${(PORT - PORT * uz / uv) / 2}px` };
}));
/**
 * Zoomed out, the link ports (.eport, .lport) keep their 100% hit area on screen while the drawn dot grows only by the square root
 * (a full-size dot looks oversized on a small board). Only the hovered card's ports get the sizes (inline, on the ports themselves):
 * the others are hidden, and the pointer reaches a port through its card. Updating every port on each camera stop, through a rule
 * or an inherited variable, made zooming restyle the board (+18% work per zoom step)
 */
export const portStyle = (card: string) => (isHovered(card) ? portZoom() : undefined);

// 指针下的卡：离开后过 linkLeave 才算离开，鼠标从卡移到它的线上时线不掉下去。镜头动的时候不换（内容从指针下滑过也会进出卡），停下再按最后的那张算
let hovNow: string | null = null, cardT: number | undefined;
const settleHover = () => { clearTimeout(cardT); cardT = window.setTimeout(() => { if (!camMoving()) setHoverCard(hovNow); }, tune("linkLeave")); };
export const enterCard = (id: string) => { hovNow = id; clearTimeout(cardT); if (!camMoving()) setHoverCard(id); };
export const leaveCard = (id: string) => { if (hovNow === id) hovNow = null; settleHover(); };
// 不只靠 pointerleave：它会丢（卡在指针下被挪位置 / 重排、指针捕获刚释放、慢机器上事件挤在一起），丢了那张卡就一直算悬停，它的线一直浮在所有卡上面。
// 所以指针每动一下都核对一次：落点已经不在悬停的那张卡里 → 当它离开了；卡重排之后指针不动也在下一帧按指针下面是什么核对一次。
// 走的还是 leaveCard → settleHover，落回去照样过 linkLeave、照样淡出
let ptr: { x: number; y: number } | null = null;
const inHovered = (el: EventTarget | Element | null) => !!hovNow && el instanceof Element && !!el.closest(`.card[data-id="${CSS.escape(hovNow)}"]`);
const checkHover = (el: EventTarget | Element | null) => { if (hovNow && !inHovered(el)) leaveCard(hovNow); };
/** trackLinks 里调用一次 */
export function watchHover() {
  const move = (e: PointerEvent) => { ptr = { x: e.clientX, y: e.clientY }; checkHover(e.target); };
  window.addEventListener("pointermove", move, { capture: true, passive: true });
  onCleanup(() => window.removeEventListener("pointermove", move, { capture: true }));
  // 只在有悬停的卡、而且是这张卡在 b.cards 里的位置变了（重排）时才看：撤销 / 重做 / 同步换掉 b.cards 不会每次都去读指针下面是什么（会强制排版）
  let raf = 0;
  createEffect(on(() => { const id = hoverCard(); return id ? `${id} ${state.board.cards.findIndex((c) => c.id === id)}` : ""; }, (k, prev) => {
    if (!k || !prev || k === prev || k.split(" ")[0] !== prev.split(" ")[0]) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (hovNow && ptr) checkHover(document.elementFromPoint(ptr.x, ptr.y)); });
  }));
  onCleanup(() => cancelAnimationFrame(raf));
  // 镜头停下：按最后在指针下的那张卡算
  createEffect(on(camMoving, (mv) => { if (!mv) setHoverCard(hovNow); }, { defer: true }));
}

// 离开连线后过 linkLeave 才算离开：鼠标从线移到 "+" 或变量框的路上不丢悬停。移到指针下那张卡的线上时，那张卡也还算悬停着
let leaveT: number | undefined;
export const enterLink = (id: string) => {
  clearTimeout(leaveT); setHoverLink(id);
  const hc = untrack(hoverCard);
  if (!hc) return;
  const L = state.board.links.find((l) => l.id === id);
  if (L && (hostOf(L.from.card) === hc || hostOf(L.to.card) === hc)) clearTimeout(cardT);
};
export const leaveLink = () => { clearTimeout(leaveT); leaveT = window.setTimeout(() => setHoverLink(null), tune("linkLeave")); if (untrack(hoverCard) !== hovNow) settleHover(); };
