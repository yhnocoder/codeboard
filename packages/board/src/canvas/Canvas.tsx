import { For, Show, onMount, onCleanup, createMemo, createEffect, createSignal, on } from "solid-js";
import { bounds, type AlignOp } from "@codeboard/core";
import { state, sel, rectOf, cardById, hostOf, mutate, placed } from "../state/store";
import { cam, setViewport, viewTracked, lod, camMoving, stillZ, camTarget, camTo, fitRect } from "../state/camera";
import { trackOffscreen } from "../state/cull";
import { trackCardLod, izMap } from "../state/lodcards";
import { trackSkeletons } from "../state/subboards";
import { guides, sizeHint, marquee, dragging, dropTarget, walk, editing } from "../state/ui";
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
import { kbd } from "../keymap";
import { observeResize, queueMeasure } from "@yhnocoder/markdown/ui";

const EXT = 2048;

/** 正在写的字在屏幕上至少这么大（px） */
const READ_PX = 11;

const PORT = 9;
function portZoomRule(z: number) {
  const uz = Math.max(1, 1 / z), uv = Math.sqrt(uz);
  return `.eport, .lport { --uv: ${uv}; --port-hit: ${(PORT - PORT * uz / uv) / 2}px; }`;
}

export function Canvas() {
  let el!: HTMLDivElement, world!: HTMLDivElement;
  trackOffscreen();
  trackCardLod();
  trackLinks();
  trackSkeletons();
  // 开始写 Note / Text 时字太小（缩得很小时按 N、双击）：镜头放大到看得清（最多 100%），卡放得下就整张放进来。退出编辑不缩回去
  createEffect(on(editing, (e) => {
    if (e?.kind !== "note") return;
    requestAnimationFrame(() => {
      const el = world.querySelector(`.card[data-id="${e.id}"] :is(.nbody, .tx)`), f = cardById(e.id);
      if (!el || !f) return;
      const fs = parseFloat(getComputedStyle(el).fontSize), c = camTarget();
      if (!fs || fs * c.z >= READ_PX) return;
      const t = fitRect(rectOf(f.host), 1, Math.min(1, READ_PX / fs));
      camTo(t.x, t.y, t.z);
    });
  }));
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
  // 这一块先并进线那层、把范围撑到整块白板，后面的卡就都并得进去：层数回到 25 层（Section 框还是各自一层）。
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
      {/* Zoomed out, the link ports' hit area keeps its 100% size on screen, while the drawn dot grows only by the square root
          (a full-size dot looks oversized on a small board). A rule only they match, not a variable on .world: changing an
          inherited variable there restyles every element on the board, this restyles only the ports, once each time the camera stops */}
      <style data-export="strip">{portZoomRule(stillZ())}</style>
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
  const cur = () => { const w = walk(); return w ? hostOf(w.order[w.i]) : undefined; };
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

/** 工具条的高度（4 + 30 + 4）：上面放不下时翻到选中的卡下面 */
const BAR_H = 38;
/** 工具条离视野左右两边至少留这么多 */
const BAR_PAD = 8;
/** 上下各让出的高度：顶上是白板的标题栏；底下是工具栏和右下角的缩放（bottom 12 + 高 36），再留 BAR_PAD */
const CHROME_Y = 56;

/** 选中 ≥2 张卡时浮在上方的工具条：Create Section、Create Sub-board、Tidy Up，··· 里是对齐和分布 */
function AlignBar() {
  const rs = createMemo(() => sel.cards.map((id) => { const f = cardById(id); return f ? { id: f.host.id, ...rectOf(f.host) } : null; }).filter(Boolean) as ({ id: string; x: number; y: number; w: number; h: number })[]);
  const box = createMemo(() => bounds(rs()));
  const shown = () => rs().length >= 2 && dragging().size === 0 && !walk();
  // 工具条宽度只随按钮变，量一次存下来：镜头每动一帧都要按它夹进视野，不能每帧去读 DOM
  const [barW, setBarW] = createSignal(0);
  // 上方：卡的上边往上 12px；顶上 CHROME_Y 内（白板的标题栏）放不下就放到卡的下边下面。
  // 再整条夹进视野（左右留 BAR_PAD，上下让开白板自己的工具栏）：靠边时平移进来，而不是让绝对定位的盒子缩到剩下的宽度、按钮文字折行
  const pos = () => {
    const b = box()!, v = viewTracked(), w = barW();
    const cx = b.x * cam.z + cam.x + (b.w * cam.z) / 2, top = b.y * cam.z + cam.y - 12 - BAR_H;
    const y = top >= CHROME_Y ? top : (b.y + b.h) * cam.z + cam.y + 12;
    // 取整：落在半个像素上图标会发糊
    return { x: Math.round(Math.max(BAR_PAD, Math.min(cx - w / 2, v.w - BAR_PAD - w))), y: Math.max(CHROME_Y, Math.min(y, v.h - CHROME_Y - BAR_H)) };
  };
  const [more, setMore] = createSignal(false);
  let el: HTMLDivElement | undefined;
  const track = (e: HTMLDivElement) => {
    el = e;
    const off = observeResize(e, () => queueMeasure(e, () => { const w = e.offsetWidth; return () => setBarW(w); }));
    onCleanup(off);
  };
  createEffect(on(() => sel.cards.join(" "), () => setMore(false), { defer: true }));
  createEffect(on(shown, (s) => { if (!s) setMore(false); }));
  createEffect(() => {
    if (!more()) return;
    const down = (e: PointerEvent) => { if (!el?.contains(e.target as Node)) setMore(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMore(false); } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); });
  });
  const run = (op: AlignOp) => {
    const m = align(rs(), op);
    mutate((b) => { for (const [id, p] of m) { const c = b.place[id]; if (c && !A.isLocked(id)) Object.assign(c, p); } });
  };
  const tip = (label: string, id?: string) => { const k = id && kbd(id); return k ? `${label} (${k})` : label; };
  return (
    <Show when={shown()}>
      <div ref={track} class="alignbar pill show" data-nodrag style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
        <button class="tbtn" data-tip="Create Section" onClick={() => { setMore(false); A.moveToNewSection(); }}><Icon name="newSection" />Create Section</button>
        <button class="tbtn" data-tip={tip("Create Sub-board", "turnIntoBoard")} onClick={() => { setMore(false); void A.turnIntoBoard(); }}><Icon name="subBoard" />Create Sub-board</button>
        <button class="tbtn" data-tip={tip("Tidy Up", "tidyUp")} onClick={() => { setMore(false); void A.tidyUp(); }}><Icon name="tidy" />Tidy Up</button>
        <span class="sep" />
        <button class="ib" classList={{ on: more() }} aria-label="More" aria-haspopup="menu" aria-expanded={more()} data-tip={more() ? undefined : "More"} onClick={() => setMore(!more())}><Icon name="more" /></button>
        <div class="alignmore" classList={{ open: more() }} role="menu" aria-label="Align and Distribute">
          <div class="t">Align</div>
          <For each={AL.slice(0, 5)}>{(a) => <button class="ib" role="menuitem" aria-label={a.tip} data-tip={a.tip} tabIndex={more() ? 0 : -1} onClick={() => run(a.op)}><Icon name={a.icon} /></button>}</For>
          <div class="t">Distribute</div>
          <For each={AL.slice(5)}>{(a) => <button class="ib" role="menuitem" aria-label={a.tip} data-tip={a.tip} tabIndex={more() ? 0 : -1} onClick={() => run(a.op)}><Icon name={a.icon} /></button>}</For>
        </div>
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
