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

/** The lines a gutter Sidenote marker marks, as one box: from the marker's top (the first line) to the bottom of the last line
 *  (its data-last row), from the marker's left to the code's right. Below it, or above when there's no room (place flips) */
function markedLines(mk: Element): VirtualElement | undefined {
  const row = (mk as HTMLElement).dataset.last;
  const last = row && mk.closest(".code")?.querySelector(`.src > .l[data-r="${row}"]`);
  if (!last) return undefined;
  return {
    contextElement: mk,
    getBoundingClientRect: () => {
      const a = mk.getBoundingClientRect(),
        b = last.getBoundingClientRect();
      const x = a.left,
        y = a.top,
        right = Math.max(a.right, b.right),
        bottom = Math.max(a.bottom, b.bottom);
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
    if (at.el && !at.el.isConnected && last) return;
    const k = ++n;
    // 贴着锚点元素：下方 / 右侧 / 上方，放不下翻到另一边；没有元素就放在点 (x, y)
    const ref = at.el?.isConnected ? at.el : virtual({ x: at.x ?? 0, y: at.y ?? 0 });
    const lines = at.el?.isConnected && at.prefer === "lines" ? markedLines(at.el) : undefined;
    const r = lines
      ? place(el, lines, "bottom-start", { gap: 6 })
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
        if (k() === "notes") A.scheduleHideNotes();
        if (k() === "peek") A.scheduleHidePeek();
      }}
    >
      <Dynamic component={body()} inst={p.inst} pop={p.inst.pop} />
    </div>
  );
}
