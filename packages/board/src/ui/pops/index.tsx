// 这里只管外框（贴着锚点放、跟着镜头走、悬停时不收起）；每种浮层的内容按 kind 查 registry.ts
import { For, createSignal, createEffect, onCleanup, on, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { autoUpdate, type VirtualElement } from "@floating-ui/dom";
import { state } from "../../state/store";
import { cam } from "../../state/camera";
import { pops, closeAllPops, type PopInst, type Pop } from "../../state/pop";
import * as A from "../../actions";
import { pushLayer } from "../overlay";
import { place, virtual } from "@yhnocoder/markdown/ui";
import { POPS } from "./registry";
import type { PopProps } from "./common";
import { attrSel } from "../../cardsel";

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
  return <For each={pops()}>{(p) => <PopFrame inst={p} />}</For>;
}

/** A Highlight's lines (its gutter area, .hxhit) as one box: from where its code starts (data-in) to the code's right */
function rangeBox(hit: Element): VirtualElement {
  return {
    contextElement: hit,
    getBoundingClientRect: () => {
      const a = hit.getBoundingClientRect(),
        k = a.width / ((hit as HTMLElement).offsetWidth || 1);
      const x = a.right + (Number((hit as HTMLElement).dataset.in) || 0) * k - 12 * k,
        y = a.top,
        right = x + 1,
        bottom = a.bottom;
      return { x, y, left: x, top: y, right, bottom, width: right - x, height: bottom - y };
    },
  };
}

function PopFrame(p: { inst: PopInst }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [anchor, setAnchor] = createSignal<Element | undefined>();
  let last: { x: number; y: number } | undefined,
    n = 0;
  const reposition = () => {
    const at = p.inst.at;
    // 锚点元素被重画掉了（比如删了一条旁注，标记换成新的）：Sidenote 弹窗改挂到还剩的那条的标记上；找不到就停在原地
    if (at.el && !at.el.isConnected && p.inst.pop.kind === "notes") {
      const ids = p.inst.pop.ids.filter((id) => state.board.sidenotes.some((n) => n.id === id));
      const mk = [...document.querySelectorAll<HTMLElement>("[data-notes]")].find((m) =>
        m.dataset.notes!.split(",").some((id) => ids.includes(id)),
      );
      if (mk) {
        at.el = mk;
        setAnchor(mk);
      }
    }
    // a Highlight's gutter area drawn again (its notes changed): the popup goes to the new one
    if (at.el && !at.el.isConnected && p.inst.pop.kind === "highlight") {
      const { card, seg, lines } = p.inst.pop;
      const hit = document.querySelector(`.hxhit${attrSel("data-hl", `${card}:${seg}:${lines[0]}-${lines[1]}`)}`);
      if (hit) {
        at.el = hit;
        setAnchor(hit);
      }
    }
    if (at.el && !at.el.isConnected && last) return;
    const k = ++n;
    // 贴着锚点元素：下方 / 右侧 / 上方，放不下翻到另一边；没有元素就放在点 (x, y)
    const ref = at.el?.isConnected ? at.el : virtual({ x: at.x ?? 0, y: at.y ?? 0 });
    const r =
      at.el?.isConnected && at.prefer === "range"
        ? place(el, rangeBox(at.el), "bottom-start", { gap: 4 })
        : at.el?.isConnected && at.prefer === "right"
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
  const k = () => p.inst.pop.kind;
  // registry 按 kind 保证了组件和 pop 对得上；查表后 TS 只认得出并集
  const body = () => POPS[k()] as Component<PopProps<Pop["kind"]>>;
  return (
    <div
      ref={el}
      class={`pop open k-${k()}`}
      classList={{ pinned: p.inst.pinned }}
      data-pop={p.inst.id}
      style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
      data-nodrag
      onContextMenu={(e) => e.stopPropagation()}
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
