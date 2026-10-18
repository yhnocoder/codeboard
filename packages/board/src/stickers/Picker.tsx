// 选贴纸的面板：Built-in / 自定义包 / Emoji，搜索，颜色。开在工具栏 Sticker 按钮上面。
// 下面是画在白板上的贴纸：画布上的、绑在卡 / 线上的、卡角上的、代码行上的（每张卡、每条线只读 state/stickers 里自己那一组）
import { keepKey } from "../ui/editkeys";
import { createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { firstLine, type IconRef, type Sticker } from "@codeboard/core";
import { linkCurve } from "../canvas/Links";
import { bezAt } from "../canvas/geom";
import { BUILTIN, EMOJI, STICKER_COLORS, Glyph, packs } from "./glyphs";
import { pickSticker, stickerDown, stickerMenu, stickerLabel } from "../actions/stickers";
import { stickerPick, setStickerPick, stickerColor, setStickerColor, isSelSticker, stickerList, freeStickers, boundStickers, linkStickers } from "../state/stickers";
import { placing } from "../state/mode";
import { state } from "../state/store";
import { send } from "../host";
import { cam, lod } from "../state/camera";
import { shownIcon, stickerClick } from "../actions/questions";
import { useOverlay } from "../ui/overlay";

const MAX = 240; // 大图标包只画前这么多个（搜索缩小范围）

export function StickerPicker() {
  const [tab, setTab] = createSignal("builtin");
  const [q, setQ] = createSignal("");
  let el!: HTMLDivElement;
  // 工具栏的 Sticker 按钮自己会开关面板：点它不算点外面
  useOverlay({ close: () => setStickerPick(null), inside: (t) => el.contains(t) || !!t.closest('[aria-label="Sticker"]'), outside: true, grab: true });
  const items = createMemo<{ icon: IconRef; label: string }[]>(() => {
    const s = q().trim().toLowerCase();
    const t = tab();
    let all: { icon: IconRef; label: string }[];
    if (t === "builtin") all = BUILTIN.map((b) => ({ icon: { pack: "builtin", name: b.name }, label: b.label }));
    else if (t === "emoji") all = EMOJI.map((e) => ({ icon: { pack: "emoji", name: e }, label: e }));
    else all = (packs()?.find((p) => p.id === t)?.icons ?? []).map((i) => ({ icon: { pack: t, name: i.name }, label: i.name }));
    return (s ? all.filter((x) => x.label.toLowerCase().includes(s) || x.icon.name.toLowerCase().includes(s)) : all).slice(0, MAX);
  });
  const p = () => stickerPick()!;
  return (
    <div ref={el} class="pill stkpick" data-nodrag style={{ left: `${p().x}px`, top: `${p().y}px` }}>
      <div class="stabs">
        <button classList={{ on: tab() === "builtin" }} onClick={() => setTab("builtin")}>Built-in</button>
        <For each={packs() ?? []}>{(pk) => <button classList={{ on: tab() === pk.id }} onClick={() => setTab(pk.id)}>{pk.name}</button>}</For>
        <button classList={{ on: tab() === "emoji" }} onClick={() => setTab("emoji")}>Emoji</button>
      </div>
      <input class="sq" placeholder="Search icons…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={keepKey} />
      <div class="sgrid">
        <For each={items()}>{(it) => <button class="scell" data-tip={it.label} onClick={() => pickSticker(it.icon)}><Glyph icon={it.icon} color={tab() === "emoji" ? undefined : stickerColor()} size={22} /></button>}</For>
        <Show when={!items().length}><div class="sempty">{tab() === "builtin" || tab() === "emoji" ? "No match" : "No icons in this pack"}</div></Show>
      </div>
      <Show when={tab() !== "emoji"}>
        <div class="scolors">
          <span>Color</span>
          <button class="sw def" classList={{ on: !stickerColor() }} data-tip="Default" onClick={() => setStickerColor(undefined)} />
          <For each={STICKER_COLORS}>{(c) => <button class="sw" classList={{ on: stickerColor() === c }} style={{ background: c }} onClick={() => setStickerColor(c)} />}</For>
        </div>
      </Show>
      <div class="sfoot">
        <span>Your packs: {state.host.settings.stickerDir || "~/.codeboard/stickers"}</span>
        <button class="tlink" onClick={() => send({ type: "openStickerDir" })}>Open Folder</button>
      </div>
    </div>
  );
}

/** 放贴纸时跟着指针走的影子（只在放的时候听指针） */
export function PlacingGhost() {
  return <Show when={placing()}>{(p) => {
    const [pt, setPt] = createSignal({ x: -100, y: -100 });
    const mv = (e: PointerEvent) => setPt({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", mv, true);
    onCleanup(() => window.removeEventListener("pointermove", mv, true));
    return <div class="stkghost" style={{ left: `${pt().x}px`, top: `${pt().y}px` }}><Glyph icon={p().icon} color={p().color} size={28} /></div>;
  }}</Show>;
}

type FreeAt = Extract<Sticker["at"], { kind: "canvas" }>;
const menuAt = (id: string) => (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); stickerMenu(id, e.clientX, e.clientY); };

/** 一枚可拖、可改大小的贴纸；x、y 是它所在那一层的坐标（画布 = 世界坐标，卡里 = 相对卡左上角） */
function FreeSticker(p: { s: Sticker; x: number; y: number }) {
  const at = () => p.s.at as FreeAt;
  const size = () => at().size ?? 32;
  const sel = () => isSelSticker(p.s.id);
  return (
    <div class="stk canvas" classList={{ q: !!p.s.q, done: !!p.s.q?.done, sel: sel(), bound: !!at().on, "lod-map": lod() === "map" }} data-sticker={p.s.id} data-tip={stickerLabel(p.s.icon)}
      style={{ left: `${p.x}px`, top: `${p.y}px`, "min-width": `${size()}px`, height: `${size()}px`, "--s": `${size()}px` }}
      onPointerDown={(e) => stickerDown(e, p.s.id)} onClick={(e) => stickerClick(p.s.id, e.currentTarget)} onContextMenu={menuAt(p.s.id)}>
      <Glyph icon={shownIcon(p.s).icon} color={shownIcon(p.s).color} size={size()} />
      <Show when={sel()}><span class="sgrip" data-nodrag data-export="strip" style={{ scale: `${1 / cam.z}` }} onPointerDown={(e) => stickerDown(e, p.s.id, true)} /></Show>
    </div>
  );
}

/** 卡角上、代码行上的小贴纸（不能改大小） */
export function StickerChip(p: { s: Sticker; size: number }) {
  return (
    <span class="stk" classList={{ sel: isSelSticker(p.s.id), q: !!p.s.q, done: !!p.s.q?.done }} data-sticker={p.s.id} data-tip={p.s.q?.md ? firstLine(p.s.q.md) : stickerLabel(p.s.icon)}
      onPointerDown={(e) => stickerDown(e, p.s.id)} onClick={(e) => { e.stopPropagation(); stickerClick(p.s.id, e.currentTarget); }} onContextMenu={menuAt(p.s.id)}>
      <Glyph icon={shownIcon(p.s).icon} color={shownIcon(p.s).color} size={p.size} />
    </span>
  );
}

const FreeList = (p: { list: Sticker[] }) => <For each={p.list}>{(s) => <FreeSticker s={s} x={(s.at as FreeAt).x} y={(s.at as FreeAt).y} />}</For>;

/** 画布上没绑东西的贴纸（世界坐标层，在所有卡上面） */
export function CanvasStickers() {
  const list = stickerList(freeStickers);
  return <FreeList list={list()} />;
}

/** 绑在卡上的贴纸：放在卡里面，跟卡同一图层、一起走 */
export function BoundStickers(p: { card: string }) {
  const list = stickerList(() => boundStickers(p.card));
  return <FreeList list={list()} />;
}

/** 绑在一条箭头上的贴纸：沿线位置 t + 偏移；选中时画一条虚线连到线上那一点。跟这条线在同一层（canvas/Links.tsx） */
export function LinkStickers(p: { link: string }) {
  const list = stickerList(() => linkStickers(p.link));
  return (
    <For each={list()}>
      {(s) => {
        const at = () => s.at as FreeAt;
        const anchor = createMemo(() => { const on = at().on as { link: string; t: number }; const c = linkCurve(on.link); return c ? bezAt(c, on.t) : null; });
        const half = () => (at().size ?? 32) / 2;
        return (
          <Show when={anchor()}>
            {(q) => <>
              <Show when={isSelSticker(s.id)}>
                <svg class="tether" data-export="strip" width="1" height="1"><line x1={q().x} y1={q().y} x2={q().x + at().x + half()} y2={q().y + at().y + half()} style={{ "stroke-width": `${1 / cam.z}px` }} /><circle cx={q().x} cy={q().y} r={3 / Math.max(cam.z, 0.5)} /></svg>
              </Show>
              <FreeSticker s={s} x={q().x + at().x} y={q().y + at().y} />
            </>}
          </Show>
        );
      }}
    </For>
  );
}
