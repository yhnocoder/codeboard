// 画布：镜头变换后的世界层（Section 框 → Link → 卡片 → Section 标签 → Link 标签 → 参考线），
// 加上屏幕坐标的框选框、对齐工具条。
import { For, Show, onMount, onCleanup, createMemo, createEffect, on } from "solid-js";
import { bounds, type AlignOp } from "@codeboard/core";
import { state, sel, rectOf, cardById, mutate, placed } from "../state/store";
import { cam, setViewport, lod } from "../state/camera";
import { guides, sizeHint, marquee, dragging, dropTarget, connectFrom, walk } from "../state/ui";
import { CardView } from "../cards/Card";
import { CanvasStickers, LinkStickers } from "../stickers/Picker";
import { LinksSvg, LinkLabels } from "./Links";
import { SectionFrames, SectionLabels } from "./Sections";
import { canvasPointerDown, canvasWheel, canvasContextMenu } from "../interact";
import { Icon } from "../ui/icons";
import * as A from "../actions";
import { align } from "@codeboard/core";

export function Canvas() {
  let el!: HTMLDivElement, world!: HTMLDivElement;
  // 镜头动的时候才让浏览器把世界层当位图缩放；停下 ~180ms 后去掉，按新比例重新清晰绘制（#15）
  let still: number | undefined;
  createEffect(on(() => [cam.x, cam.y, cam.z], () => {
    if (!world) return;
    world.classList.add("moving");
    clearTimeout(still);
    still = window.setTimeout(() => world.classList.remove("moving"), 180);
  }, { defer: true }));
  onMount(() => {
    const ro = new ResizeObserver(() => setViewport(el.clientWidth, el.clientHeight));
    ro.observe(el);
    setViewport(el.clientWidth, el.clientHeight);
    el.addEventListener("wheel", canvasWheel, { passive: false });
    onCleanup(() => { ro.disconnect(); el.removeEventListener("wheel", canvasWheel); });
  });
  return (
    <div ref={el} id="board" class="board" classList={{ connecting: !!connectFrom(), walking: !!walk(), dragging: dragging().size > 0, placing: !!A.placing(), "lod-overview": lod() === "overview", "lod-map": lod() === "map" }}
      onPointerDown={canvasPointerDown} onContextMenu={canvasContextMenu}>
      <div ref={world} class="world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`, "--iz": lod() === "map" ? String(1 / cam.z) : undefined }}>
        <SectionFrames />
        <LinksSvg />
        <For each={placed()}>{(c) => <CardView card={c} />}</For>
        <CanvasStickers />
        <SectionLabels />
        <div class="labels"><LinkLabels /><LinkStickers /></div>
        <div class="guides">
          <For each={guides()}>
            {(g) => g.axis === "x"
              ? <div class="guide v" style={{ left: `${g.at}px`, top: `${g.from - 8}px`, height: `${g.to - g.from + 16}px`, "border-left-width": `${1 / cam.z}px` }} />
              : <div class="guide h" style={{ top: `${g.at}px`, left: `${g.from - 8}px`, width: `${g.to - g.from + 16}px`, "border-top-width": `${1 / cam.z}px` }} />}
          </For>
          <Show when={sizeHint()}>{(h) => <div class="ghint" style={{ left: `${h().x}px`, top: `${h().y}px`, transform: `translate(-50%, 0) scale(${1 / cam.z})` }}>{h().text}</div>}</Show>
          <DropHint />
        </div>
      </div>
      <Show when={marquee()}>{(m) => <div class="marquee" style={{ left: `${m().x}px`, top: `${m().y}px`, width: `${m().w}px`, height: `${m().h}px`, display: "block" }} />}</Show>
      <AlignBar />
      <Show when={!placed().length && state.loaded}><EmptyHint /></Show>
    </div>
  );
}

/** 拖动中的提示：Release to merge / Release to add as Sidenote */
function DropHint() {
  const d = () => dropTarget();
  const r = createMemo(() => { const t = d(); return t && t.card ? rectOf(cardById(t.card)!.host) : null; });
  return (
    <Show when={d() && r() && (d()!.kind === "merge" ? d()!.armed : d()!.kind === "line" && dragging().size > 0)}>
      <div class="drophint" style={{ left: `${r()!.x + r()!.w / 2}px`, top: `${r()!.y - 8}px`, transform: `translate(-50%, -100%) scale(${1 / cam.z})` }}>
        {d()!.kind === "merge" ? "Release to merge" : [...dragging()].some((id) => cardById(id)?.card.kind === "note") ? "Release to add as Sidenote" : "Release to add as Code Sidenote"}
      </div>
    </Show>
  );
}

const AL: { op: AlignOp; icon: string; tip: string }[] = [
  { op: "left", icon: "alignL", tip: "Align Left" }, { op: "hcenter", icon: "alignC", tip: "Align Centre" }, { op: "right", icon: "alignR", tip: "Align Right" },
  { op: "top", icon: "alignT", tip: "Align Top" }, { op: "bottom", icon: "alignB", tip: "Align Bottom" },
  { op: "hdist", icon: "distH", tip: "Distribute Horizontally" }, { op: "vdist", icon: "distV", tip: "Distribute Vertically" },
];

/** 选中 ≥2 张卡时浮在上方的对齐工具条 */
function AlignBar() {
  const rs = createMemo(() => sel.cards.map((id) => { const f = cardById(id); return f ? { id: f.host.id, ...rectOf(f.host) } : null; }).filter(Boolean) as ({ id: string; x: number; y: number; w: number; h: number })[]);
  const box = createMemo(() => bounds(rs()));
  const pos = () => { const b = box()!; return { x: b.x * cam.z + cam.x + (b.w * cam.z) / 2, y: b.y * cam.z + cam.y - 12 }; };
  const run = (op: AlignOp) => {
    const m = align(rs(), op);
    mutate((b) => { for (const [id, p] of m) { const c = b.place[id]; if (c && !A.isLocked(id)) Object.assign(c, p); } });
  };
  return (
    <Show when={rs().length >= 2 && dragging().size === 0 && !walk()}>
      <div class="alignbar pill show" style={{ left: `${pos().x}px`, top: `${Math.max(56, pos().y)}px` }} onPointerDown={(e) => e.stopPropagation()}>
        <For each={AL}>{(a, i) => <>
          <Show when={i() === 3 || i() === 5}><span class="sep" /></Show>
          <button class="ib" aria-label={a.tip} data-tip={a.tip} onClick={() => run(a.op)}><Icon name={a.icon} /></button>
        </>}</For>
      </div>
    </Show>
  );
}

function EmptyHint() {
  return (
    <div class="emptyhint">
      <div class="eh-t">This board is empty</div>
      <div class="eh-d">In the editor, put the cursor in a function and press <kbd>{A.K.alt}B</kbd>.<br />Or press <kbd>{A.K.mod}K</kbd> to search for a function, or <kbd>{A.K.mod}V</kbd> to paste code.</div>
    </div>
  );
}
