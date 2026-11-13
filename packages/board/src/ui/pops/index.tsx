// 这里只管外框（贴着锚点放、跟着镜头走、悬停时不收起）；每种浮层的内容按 kind 查 registry.ts
import { For, Show, createSignal, createEffect, createMemo, onCleanup, on, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { autoUpdate } from "@floating-ui/dom";
import { spotKey, within, type Anchor } from "@codeboard/core";
import { hostOf } from "../../state/store";
import { cam, camTarget, camTo } from "../../state/camera";
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

type Box = { left: number; top: number; right: number; bottom: number };
const unite = (a: Box, b: Box): Box => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});
/** What a popup of sidenotes belongs to, on screen, which it never covers: the card (with the badge past its edge), else the
 *  Section's frame and title, else the free badge alone. A Section's frame can be bigger than the window: its title then */
function owners(pop: Pop, el: Element): Box[] {
  const mk =
    pop.kind === "notes" ? document.querySelector(`[data-spot]${attrSel("data-spot", spotKey(pop.spot))}`) : null;
  const badge =
    mk && mk !== el ? unite(el.getBoundingClientRect(), mk.getBoundingClientRect()) : el.getBoundingClientRect();
  const card = el.closest(".card");
  if (card) return [unite(card.getBoundingClientRect(), badge)];
  if (pop.kind === "notes" && pop.spot.section !== undefined) {
    const sel = attrSel("data-sect", pop.spot.section);
    const frame = document.querySelector(`.sect${sel}`),
      label = document.querySelector(`.slabel${sel}`);
    const title = label ? unite(label.getBoundingClientRect(), badge) : badge;
    return frame ? [unite(frame.getBoundingClientRect(), title), title] : [title];
  }
  return [badge];
}
const GAP = 12,
  PAD = 8;
/**
 * Beside what the popup belongs to (owners): of right, left, below and above, the side with room that covers the least of the
 * other cards (the first of them when that is a tie), its top at the badge. A popup placed already keeps its side (`keep`) while
 * that has room, and when it grows past that room once something in it has been written in, a pinned one moves the board just
 * enough (`grow`), so it does not jump to another side under the caret. When no side has room, a pinned popup moves the board just enough for the right or left
 * side to fit (once: `pan`); otherwise it takes the side with the most room, as close as it can without covering the badge
 */
type Side = "right" | "left" | "below" | "above";
function besidePos(
  pop: Pop,
  el: Element,
  box: HTMLElement,
  pan: ((dx: number, dy: number) => void) | null,
  keep?: Side,
  grow?: (dx: number, dy: number) => void,
): { x: number; y: number; side?: Side } {
  const W = document.documentElement.clientWidth,
    H = document.documentElement.clientHeight,
    w = box.offsetWidth,
    h = box.offsetHeight,
    b = el.getBoundingClientRect();
  const yBy = (top: number) => Math.max(PAD, Math.min(top - 6, H - PAD - h));
  const xBy = (left: number) => Math.max(PAD, Math.min(left - 20, W - PAD - w));
  const all = owners(pop, el);
  // of the sides with room, the one that covers the least of the other cards in view; a Section's title or a free badge, which
  // are small and there to be clicked, count as much as a card
  const mine = el.closest(".card");
  const others = [...document.querySelectorAll(".world :is(.card, .slabel, .snb.free)")].flatMap((c) => {
    const r = c.getBoundingClientRect();
    if (c === mine || c.contains(el) || c === el || r.right < 0 || r.left > W || r.bottom < 0 || r.top > H) return [];
    return [{ r, k: c.classList.contains("card") ? 1 : 40 }];
  });
  const covers = (x: number, y: number) =>
    others.reduce(
      (s, { r, k }) =>
        s +
        k *
          Math.max(0, Math.min(x + w, r.right) - Math.max(x, r.left)) *
          Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top)),
      0,
    );
  const at = (R: Box, side: Side) =>
    side === "right"
      ? { x: R.right + GAP, y: yBy(b.top), side, short: R.right + GAP + w - (W - PAD) }
      : side === "left"
        ? { x: R.left - GAP - w, y: yBy(b.top), side, short: PAD - (R.left - GAP - w) }
        : side === "below"
          ? { x: xBy(b.left), y: R.bottom + GAP, side, short: R.bottom + GAP + h - (H - PAD) }
          : { x: xBy(b.left), y: R.top - GAP - h, side, short: PAD - (R.top - GAP - h) };
  if (keep) {
    const c = at(all[0], keep);
    if (c.short <= 0) return c;
    if (grow && (keep === "above" || keep === "below") && all[0].bottom - all[0].top + 2 * GAP + h <= H - 2 * PAD) {
      const d = keep === "above" ? c.short : -c.short;
      grow(0, d);
      return { ...c, y: c.y + d };
    }
    if (grow && (keep === "left" || keep === "right")) {
      const d = keep === "left" ? c.short : -c.short;
      grow(d, 0);
      return { ...c, x: c.x + d };
    }
  }
  for (const R of all) {
    const sides = (["right", "left", "below", "above"] as const).map((k) => at(R, k)).filter((c) => c.short <= 0);
    if (!sides.length) continue;
    let best = sides[0],
      least = covers(best.x, best.y);
    for (const c of sides.slice(1)) {
      const k = covers(c.x, c.y);
      if (k < least) {
        best = c;
        least = k;
      }
    }
    return best;
  }
  const R = all[0];
  if (pan && R.right - R.left + 2 * GAP + w <= W - 2 * PAD) {
    const toRight = R.right + GAP + w - (W - PAD),
      toLeft = PAD - (R.left - GAP - w);
    if (toRight <= toLeft) {
      pan(-toRight, 0);
      return { x: R.right + GAP - toRight, y: yBy(b.top) };
    }
    pan(toLeft, 0);
    return { x: R.left - GAP - w + toLeft, y: yBy(b.top) };
  }
  if (pan && R.bottom - R.top + 2 * GAP + h <= H - 2 * PAD) {
    const down = R.bottom + GAP + h - (H - PAD);
    pan(0, -down);
    return { x: xBy(b.left), y: R.bottom + GAP - down };
  }
  // no room anywhere: the side with the most room, never over the badge
  const right = W - R.right,
    left = R.left;
  const x = right >= left ? W - PAD - w : PAD;
  const y = x < b.right + GAP && x + w > b.left - GAP ? (b.top > H / 2 ? b.top - GAP - h : b.bottom + GAP) : yBy(b.top);
  return { x, y: Math.max(PAD, Math.min(y, H - PAD - h)) };
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
    side: Side | undefined,
    tall = 0,
    growTo: { x: number; y: number } | undefined,
    wrote = false,
    n = 0,
    panned = false;
  const panBy = (dx: number, dy: number) => {
    panned = true;
    const c = camTarget();
    camTo(c.x + dx, c.y + dy, c.z, true);
  };
  // from where the board is now, not where it is going: this runs on every frame of that move, measuring what is still short
  const growBy = (dx: number, dy: number) => {
    growTo = { x: cam.x + dx, y: cam.y + dy };
    camTo(growTo.x, growTo.y, camTarget().z, true);
  };
  // it grew once something in it has been written in (or the board is still moving to make the room it grew into, nothing else
  // having moved it since)
  const growing = () => {
    const grew = el.offsetHeight > tall;
    tall = el.offsetHeight;
    if (!(wrote ||= el.contains(document.activeElement))) return false;
    const t = camTarget();
    return (
      grew ||
      (!!growTo && Math.abs(t.x - growTo.x) < 1 && Math.abs(t.y - growTo.y) < 1 && (t.x !== cam.x || t.y !== cam.y))
    );
  };
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
        side = undefined;
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
      const r = besidePos(
        p.inst.pop,
        at.el,
        el,
        p.inst.pinned && !panned ? panBy : null,
        side,
        p.inst.pinned && growing() ? growBy : undefined,
      );
      side = r.side;
      setPos((last = { x: r.x, y: r.y }));
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
    void p.inst.pinned;
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
