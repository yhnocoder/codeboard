// 画布：镜头变换后的世界层（Section 框 → 线 → 卡片 → 车流、线头圆点 → 画布贴纸、Section 标签 → 临时浮上来的线 → 参考线），
// 加上屏幕坐标的框选框、对齐工具条。
import { For, Show, onMount, onCleanup, createMemo, createEffect, createSignal, on } from "solid-js";
import { bounds, type AlignOp } from "@codeboard/core";
import { state, sel, rectOf, cardById, mutate, placed } from "../state/store";
import { cam, setViewport, lod, camMoving, stillZ } from "../state/camera";
import { trackOffscreen } from "../state/cull";
import { trackCardLod, izMap } from "../state/lodcards";
import { trackSkeletons } from "../state/subboards";
import { guides, sizeHint, marquee, dragging, dropTarget, walk } from "../state/ui";
import { CardView } from "../cards/Card";
import { CanvasStickers } from "../stickers/Picker";
import { trackLinks, LinkLayer } from "./Links";
import { Traffic } from "./Traffic";
import { AltBoxes } from "./Labels";
import { SectionFrames, SectionLabels } from "./Sections";
import { frames } from "../state/sections";
import { canvasPointerDown, canvasWheel, canvasContextMenu } from "../interact";
import { Icon } from "../ui/icons";
import * as A from "../actions";
import { align } from "@codeboard/core";
import { boardMode } from "../state/mode";

const EXT = 2048;

export function Canvas() {
  let el!: HTMLDivElement, world!: HTMLDivElement;
  trackOffscreen();
  trackCardLod();
  trackLinks();
  trackSkeletons();
  // 停下以后一两帧去掉 will-change 的提示（styles.css 的 .world.settle）：位图缩放过的内容按新比例重新清晰栅格化
  const [settle, setSettle] = createSignal(false);
  createEffect(on(camMoving, (m) => {
    setSettle(!m);
    if (!m) requestAnimationFrame(() => requestAnimationFrame(() => setSettle(false)));
  }, { defer: true }));
  // 打开白板后，世界层的 transform 要先变过一次，之后的平移才便宜：没变过时，Chromium 每帧都把整块世界层重新分层（实测每帧 40+ ms，
  // 变过一次以后 ~13 ms）。所以白板一加载好就悄悄动 0.01px 再放回，用户的第一段平移就不会卡
  createEffect(on(() => state.loaded, (ok) => {
    if (!ok || !world) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      world.style.translate = "0.01px 0";
      requestAnimationFrame(() => { world.style.translate = ""; });
    }));
  }));
  // 线的 SVG 后面紧跟一块空的、盖住整块白板的方框（.wext，不画东西）。线在所有卡下面，卡都压在线那个合成层上面，只能并进它（或者更上面的层）；
  // Chromium 合并时看两块范围拼起来空不空（稀疏就另起一层），线那层的范围只是线画到的地方，卡并不进去，相隔很远的卡彼此也并不了，
  // 结果几乎每张卡一个合成层（实测 74 层，CDP 的原因都是 Overlap；SVG 自己没有 will-change、动画、滤镜之类的原因）。
  // 这一块先并进线那层、把范围撑到整块白板，后面的卡就都并得进去：层数跟以前一样（25 层，Section 框还是各自一层）。
  // 放在最前面（Section 框前面）也行，但那样 Section 框、线、卡全挤进一个层，缩放、捏合的慢帧多。范围按卡和 Section 的外框往外留 EXT、对齐到 EXT 的整数倍，拖动中不重算
  const extent = createMemo<string>((prev) => {
    if (prev && dragging().size) return prev;
    let x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    const add = (r: { x: number; y: number; w: number; h: number }) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
    for (const c of placed()) add(rectOf(c));
    for (const r of frames().values()) add(r);
    x0 = Math.floor(x0 / EXT - 1) * EXT; y0 = Math.floor(y0 / EXT - 1) * EXT; x1 = Math.ceil(x1 / EXT + 1) * EXT; y1 = Math.ceil(y1 / EXT + 1) * EXT;
    return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
  });
  onMount(() => {
    const ro = new ResizeObserver(() => setViewport(el.clientWidth, el.clientHeight));
    ro.observe(el);
    setViewport(el.clientWidth, el.clientHeight);
    el.addEventListener("wheel", canvasWheel, { passive: false });
    onCleanup(() => { ro.disconnect(); el.removeEventListener("wheel", canvasWheel); });
  });
  return (
    <div ref={el} id="board" class="board" data-mode={boardMode()} classList={{ walking: !!walk(), dragging: dragging().size > 0, "lod-overview": lod() === "overview", "lod-map": lod() === "map" }}
      onPointerDown={canvasPointerDown} onContextMenu={canvasContextMenu}>
      <div ref={world} class="world" classList={{ moving: camMoving(), settle: settle() }} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`, "--izmap": String(izMap()) }}>
        <SectionFrames />
        <LinkLayer bottom />
        <div class="wext" style={(() => { const [x, y, w, h] = extent().split(" "); return { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }; })()} />
        <For each={placed()}>{(c) => <CardView card={c} />}</For>
        <Traffic />
        <LinkLayer ports />
        <CanvasStickers />
        <SectionLabels />
        {/* 灰色备选：在所有卡上面、浮上来的线下面 */}
        <div class="alts" classList={{ "lod-overview": lod() === "overview" }}><Show when={lod() !== "map"}><AltBoxes /></Show></div>
        <LinkLayer top />
        {/* Walkthrough 的步数：卡上方的小号码（算出来的，不存；走过的卡不再走），在卡外面一层，变暗的卡也看得清 */}
        <Show when={walk()}><WalkSteps /></Show>
        <div class="guides" data-export="strip">
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

function WalkSteps() {
  const items = createMemo(() => [...(A.walkSteps() ?? new Map<string, number>()).entries()]);
  const cur = () => { const w = walk(); return w ? cardById(w.order[w.i])?.host.id : undefined; };
  // 字号跟着镜头停下后的缩放反向放大一点（镜头动的时候不重算）
  const k = () => Math.max(1, 0.9 / stillZ());
  return (
    <div class="wsteps" data-export="strip">
      <For each={items()}>{([id, n]) => {
        const r = () => rectOf(id);
        return <span class="wstep" classList={{ cur: cur() === id }} data-card={id} style={{ left: `${r().x}px`, top: `${r().y - 6}px`, transform: `translateY(-100%) scale(${k()})` }}>{n}</span>;
      }}</For>
    </div>
  );
}

/** 拖动中的提示：Release to merge / Release to add as Sidenote */
function DropHint() {
  const d = () => dropTarget();
  const r = createMemo(() => { const t = d(); return t && t.card ? rectOf(cardById(t.card)!.host) : null; });
  return (
    <Show when={d() && r() && (d()!.kind === "merge" ? d()!.armed : d()!.kind === "line" && dragging().size > 0)}>
      <div class="drophint" data-export="strip" style={{ left: `${r()!.x + r()!.w / 2}px`, top: `${r()!.y - 8}px`, transform: `translate(-50%, -100%) scale(${1 / cam.z})` }}>
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
      <div class="alignbar pill show" data-nodrag style={{ left: `${pos().x}px`, top: `${Math.max(56, pos().y)}px` }}>
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
