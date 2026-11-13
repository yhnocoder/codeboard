// 这里只管外框（贴着锚点放、跟着镜头走、悬停时不收起）；每种浮层的内容按 kind 查 registry.ts
import { For, Show, createSignal, createEffect, createMemo, onCleanup, on, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { autoUpdate } from "@floating-ui/dom";
import { spotKey, within, type Anchor } from "@codeboard/core";
import { hostOf } from "../../state/store";
import { cam } from "../../state/camera";
import { noteBlockOf } from "../../state/blocks";
import { pops, closeAllPops, pinPop, type PopInst, type Pop } from "../../state/pop";
import * as A from "../../actions";
import { track } from "../../gesture";
import { pushLayer } from "../overlay";
import { place, virtual } from "@yhnocoder/markdown/ui";
import { POPS } from "./registry";
import type { PopProps } from "./common";
import { attrSel, cardSel } from "../../cardsel";

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

const GAP = 12,
  PAD = 8;
/**
 * One predictable place, whatever is around: right of what the popup belongs to (the card, with the badges past its right edge; a
 * Section's title with its badge; a free badge), its top at `el`'s (the lines, the block, the badge); with no room on the right it
 * goes over the card, in the window. Nothing is avoided and the board does not move for it
 */
function besidePos(el: Element, box: HTMLElement): { x: number; y: number } {
  const W = document.documentElement.clientWidth,
    H = document.documentElement.clientHeight,
    b = el.getBoundingClientRect();
  const card = el.closest(".card");
  let right = (card ?? el).getBoundingClientRect().right;
  // its badges sit past its right edge: right of them, so they stay where they are clicked
  if (card)
    for (const m of card.querySelectorAll(".snspots .snb")) right = Math.max(right, m.getBoundingClientRect().right);
  // a Section's badge sits in its title: right of the title
  const label = el.closest(".slabel");
  if (label) right = Math.max(right, label.getBoundingClientRect().right);
  const x = Math.max(PAD, Math.min(right + GAP, W - PAD - box.offsetWidth));
  const y = Math.max(PAD, Math.min(b.top - 6, H - PAD - box.offsetHeight));
  return { x, y };
}

/** How much of a dragged popup stays in the window, so its title bar can be taken again */
const KEEP_IN = 40;

/** Where a sidenote popup goes once what it was put beside is drawn again: a spot's badge (else what the spot is on), a Highlight's
 *  gutter area holding its lines (it may have grown, or the lines just got one), else `now` (the selected line it opened at) if it
 *  is still there, else the card */
function besideAnchor(pop: Pop, now?: Element): Element | null {
  if (pop.kind === "notes") return spotElement(pop.spot);
  if (pop.kind !== "highlight") return null;
  const pre = `${pop.card}:${pop.seg}:`;
  for (const h of document.querySelectorAll<HTMLElement>(".hxhit[data-hl]")) {
    const k = h.dataset.hl!;
    if (k.startsWith(pre) && within(pop.lines, k.slice(pre.length).split("-").map(Number))) return h;
  }
  return now ?? document.querySelector(cardSel(hostOf(pop.card)));
}

/** What shows a spot on screen: its badge, else the Note's block, the Section's title or the card it is on (a free spot with no badge
 *  yet has none) */
function spotElement(spot: Anchor): Element | null {
  const mk = document.querySelector(`[data-spot]${attrSel("data-spot", spotKey(spot))}`);
  if (mk) return mk;
  if (spot.section !== undefined) return document.querySelector(`.slabel${attrSel("data-sect", spot.section)}`);
  if (spot.card === undefined) return null;
  return (spot.block && noteBlockOf(spot.card, spot.block)?.el) || document.querySelector(cardSel(hostOf(spot.card)));
}

function PopFrame(p: { inst: PopInst }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [anchor, setAnchor] = createSignal<Element | undefined>();
  // dragged by its title bar: it keeps that offset from what it is on (its badge, its lines) on the board as the camera moves (z:
  // the zoom it was dropped at), kept on screen while they are, with a thin dashed line back to them
  const [held, setHeld] = createSignal<{ x: number; y: number; z: number } | null>(null);
  const [line, setLine] = createSignal<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  let last: { x: number; y: number } | undefined,
    n = 0;
  const followHeld = (h: { x: number; y: number; z: number }) => {
    const a = p.inst.at.el?.isConnected ? p.inst.at.el.getBoundingClientRect() : null;
    if (!a) return;
    const w = el.offsetWidth,
      hh = el.offsetHeight,
      k = cam.z / h.z,
      W = document.documentElement.clientWidth,
      H = document.documentElement.clientHeight;
    let x = a.left + h.x * k,
      y = a.top + h.y * k;
    if (a.right > 0 && a.left < W && a.bottom > 0 && a.top < H) {
      x = Math.min(Math.max(x, PAD), Math.max(PAD, W - PAD - w));
      y = Math.min(Math.max(y, PAD), Math.max(PAD, H - PAD - hh));
    }
    setPos((last = { x, y }));
    const cx = a.left + a.width / 2,
      cy = a.top + a.height / 2;
    const nx = Math.max(x, Math.min(cx, x + w)),
      ny = Math.max(y, Math.min(cy, y + hh));
    setLine(Math.hypot(nx - cx, ny - cy) > 16 ? { x1: cx, y1: cy, x2: nx, y2: ny } : null);
  };
  const reposition = () => {
    const at = p.inst.at;
    // what a sidenote popup is beside was drawn again (a Highlight's notes changed, the lines just got one, a spot got its badge): it
    // goes to the new one; found nowhere, it stays where it is
    const kind = p.inst.pop.kind;
    const settled =
      at.el?.isConnected && (kind === "notes" ? at.el.matches(".snb, .card, .slabel") : at.el.matches(".hxhit, .card"));
    if ((at.prefer === "beside" || kind === "notes") && !settled) {
      const to = besideAnchor(p.inst.pop, at.el?.isConnected ? at.el : undefined);
      if (to && to !== at.el) {
        at.el = to;
        at.prefer = "beside";
        setAnchor(to);
      }
    }
    const h = held();
    if (h) {
      ++n;
      followHeld(h);
      return;
    }
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
    const o = pos(),
      sx = e.clientX,
      sy = e.clientY;
    track(
      e,
      (ev) => {
        if (!p.inst.pinned) pinPop(p.inst.id);
        const a = p.inst.at.el?.isConnected ? p.inst.at.el.getBoundingClientRect() : null;
        if (!a) return;
        const W = document.documentElement.clientWidth,
          H = document.documentElement.clientHeight;
        const x = Math.min(Math.max(o.x + ev.clientX - sx, KEEP_IN - el.offsetWidth), W - KEEP_IN),
          y = Math.min(Math.max(o.y + ev.clientY - sy, 0), H - KEEP_IN);
        const next = { x: x - a.left, y: y - a.top, z: cam.z };
        setHeld(next);
        followHeld(next);
      },
      () => {},
    );
  };
  const k = () => p.inst.pop.kind;
  // registry 按 kind 保证了组件和 pop 对得上；查表后 TS 只认得出并集
  const body = () => POPS[k()] as Component<PopProps<Pop["kind"]>>;
  return (
    <>
      <Show when={line()}>
        {(l) => (
          <svg class="popline" aria-hidden="true">
            <line x1={l().x1} y1={l().y1} x2={l().x2} y2={l().y2} />
            <circle cx={l().x1} cy={l().y1} r="2.5" />
          </svg>
        )}
      </Show>
      <div
        ref={el}
        class={`pop open k-${k()}`}
        classList={{ pinned: p.inst.pinned, held: !!held() }}
        data-pop={p.inst.id}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        data-nodrag
        onContextMenu={(e) => e.stopPropagation()}
        onPointerDown={grab}
        onPointerEnter={() => A.cancelHidePeek()}
        onPointerLeave={() => {
          if (!p.inst.pinned && k() === "peek") A.scheduleHidePeek();
        }}
      >
        <Dynamic component={body()} inst={p.inst} pop={p.inst.pop} />
      </div>
    </>
  );
}
