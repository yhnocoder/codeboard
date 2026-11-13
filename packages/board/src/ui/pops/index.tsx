// 这里只管外框（贴着锚点放、跟着镜头走、悬停时不收起）；每种浮层的内容按 kind 查 registry.ts
import { For, createSignal, createEffect, createMemo, onCleanup, on, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { autoUpdate } from "@floating-ui/dom";
import { within } from "@codeboard/core";
import { hostOf } from "../../state/store";
import { cam } from "../../state/camera";
import { pops, closeAllPops, pinPop, type PopInst, type Pop } from "../../state/pop";
import * as A from "../../actions";
import { track } from "../../gesture";
import { pushLayer } from "../overlay";
import { place, virtual } from "@yhnocoder/markdown/ui";
import { POPS } from "./registry";
import type { PopProps } from "./common";
import { cardSel } from "../../cardsel";

export function Popovers() {
  // 开着弹窗时是一层：Esc 全关（点画布关掉在 interact.ts，拖卡时也关）
  createEffect(
    on(
      () => pops().length > 0,
      (has) => {
        if (has) onCleanup(pushLayer({ close: closeAllPops }));
      },
    ),
  );
  // one frame per popover id, kept while its entry changes (pinned, its data arrived): a frame made again would be placed again
  // and fade in again
  return (
    <For each={pops().map((p) => p.id)}>
      {(id) => {
        const inst = createMemo<PopInst>(
          (prev) => pops().find((q) => q.id === id) ?? prev,
          pops().find((q) => q.id === id)!,
        );
        return <PopFrame inst={inst()} />;
      }}
    </For>
  );
}

/** Beside a card: right of it, its top at `el`'s (the lines it is on, or the card itself); over the card when the window has no
 *  room on its right */
function besidePos(el: Element, pop: HTMLElement) {
  const card = el.closest(".card") ?? el,
    c = card.getBoundingClientRect(),
    l = el.getBoundingClientRect();
  const W = document.documentElement.clientWidth,
    H = document.documentElement.clientHeight;
  const x = Math.min(c.right + BESIDE_GAP, W - EDGE - pop.offsetWidth);
  return { x: Math.max(EDGE, x), y: Math.max(EDGE, Math.min(l.top - 6, H - EDGE - pop.offsetHeight)) };
}
/** From the card's right edge, and from the window's */
const BESIDE_GAP = 12,
  EDGE = 8;
/** How much of a dragged popup stays in the window, so its title bar can be taken again */
const KEEP_IN = 40;

/** Where a sidenote popup goes once what it was put beside is drawn again: a Highlight's gutter area holding its lines (it may have
 *  grown, or the lines just got one), else `now` (the selected line it opened at) if it is still there, else the card */
function besideAnchor(pop: Pop, now?: Element): Element | null {
  if (pop.kind === "notes") return document.querySelector(cardSel(hostOf(pop.card)));
  if (pop.kind !== "highlight") return null;
  const pre = `${pop.card}:${pop.seg}:`;
  for (const h of document.querySelectorAll<HTMLElement>(".hxhit[data-hl]")) {
    const k = h.dataset.hl!;
    if (k.startsWith(pre) && within(pop.lines, k.slice(pre.length).split("-").map(Number))) return h;
  }
  return now ?? document.querySelector(cardSel(hostOf(pop.card)));
}

function PopFrame(p: { inst: PopInst }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [anchor, setAnchor] = createSignal<Element | undefined>();
  // dragged by its title bar: it stays at that place in the window, whatever the camera does, until it closes
  const [held, setHeld] = createSignal<{ x: number; y: number } | null>(null);
  let last: { x: number; y: number } | undefined,
    n = 0;
  const reposition = () => {
    const at = p.inst.at;
    // what a sidenote popup is beside was drawn again (a Highlight's notes changed, the lines just got one): it goes to the new one;
    // found nowhere, it stays where it is
    if (at.prefer === "beside" && !(at.el?.isConnected && at.el.matches(".hxhit, .card"))) {
      const to = besideAnchor(p.inst.pop, at.el?.isConnected ? at.el : undefined);
      if (to && to !== at.el) {
        at.el = to;
        setAnchor(to);
      }
    }
    if (held()) return;
    if (at.el && !at.el.isConnected && last) return;
    const k = ++n;
    if (at.el?.isConnected && at.prefer === "beside") {
      setPos((last = besidePos(at.el, el)));
      return;
    }
    // 贴着锚点元素：下方 / 右侧 / 上方，放不下翻到另一边；没有元素就放在点 (x, y)
    const ref = at.el?.isConnected ? at.el : virtual({ x: at.x ?? 0, y: at.y ?? 0 });
    const r =
      at.el?.isConnected && at.prefer === "right"
        ? place(el, ref, "right-start", { gap: { mainAxis: 8, crossAxis: -6 } })
        : place(el, ref, at.prefer === "above" ? "top-start" : "bottom-start", { gap: at.el?.isConnected ? 6 : 0 });
    void r.then((r) => {
      if (k === n) setPos((last = { x: r.x, y: r.y }));
    });
  };
  // 镜头动时跟着元素走；弹窗自己或锚点变大小、窗口变大小时重新放（autoUpdate）
  createEffect(() => setAnchor(p.inst.at.el));
  createEffect(() => {
    const a = anchor();
    onCleanup(autoUpdate(a?.isConnected ? a : virtual({ x: 0, y: 0 }), el, reposition, { layoutShift: false }));
  });
  createEffect(() => {
    void cam.x;
    void cam.y;
    void cam.z;
    reposition();
  });
  /** A press on its title bar ([data-grip], not on a button there): a drag moves it there in the window, and pins it */
  const grab = (e: PointerEvent) => {
    const t = e.target as Element;
    if (e.button !== 0 || !t.closest("[data-grip]") || t.closest("button, input, a, [contenteditable]")) return;
    e.preventDefault();
    const o = held() ?? pos(),
      sx = e.clientX,
      sy = e.clientY;
    track(
      e,
      (ev) => {
        if (!p.inst.pinned) pinPop(p.inst.id);
        const W = document.documentElement.clientWidth,
          H = document.documentElement.clientHeight;
        setHeld({
          x: Math.min(Math.max(o.x + ev.clientX - sx, KEEP_IN - el.offsetWidth), W - KEEP_IN),
          y: Math.min(Math.max(o.y + ev.clientY - sy, 0), H - KEEP_IN),
        });
      },
      () => {},
    );
  };
  const xy = () => held() ?? pos();
  const k = () => p.inst.pop.kind;
  // registry 按 kind 保证了组件和 pop 对得上；查表后 TS 只认得出并集
  const body = () => POPS[k()] as Component<PopProps<Pop["kind"]>>;
  return (
    <div
      ref={el}
      class={`pop open k-${k()}`}
      classList={{ pinned: p.inst.pinned, held: !!held() }}
      data-pop={p.inst.id}
      style={{ left: `${xy().x}px`, top: `${xy().y}px` }}
      data-nodrag
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={grab}
      onPointerEnter={() => {
        A.cancelHideNotes();
        A.cancelHidePeek();
      }}
      onPointerLeave={() => {
        if (p.inst.pinned) return;
        if (k() === "notes" || k() === "highlight") A.scheduleHideNotes();
        if (k() === "peek") A.scheduleHidePeek();
      }}
    >
      <Dynamic component={body()} inst={p.inst} pop={p.inst.pop} />
    </div>
  );
}
