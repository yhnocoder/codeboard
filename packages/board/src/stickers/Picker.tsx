// 选贴纸的面板：Built-in / 自定义包 / Emoji，搜索，颜色。开在工具栏 Sticker 按钮上面。
import { keepKey } from "../ui/editkeys";
import { createMemo, createRoot, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type { IconRef, Sticker } from "@codeboard/core";
import { linkCurve, curveAt } from "../canvas/Links";
import { BUILTIN, EMOJI, STICKER_COLORS, Glyph, packs } from "./glyphs";
import { stickerPick, setStickerPick, pickSticker, stickerColor, setStickerColor, placing, selSticker, stickerDown, stickerMenu, stickerLabel } from "../actions/stickers";
import { state } from "../state/store";
import { send } from "../host";
import { cam, lod } from "../state/camera";

const MAX = 240; // 大图标包只画前这么多个（搜索缩小范围）

export function StickerPicker() {
  const [tab, setTab] = createSignal("builtin");
  const [q, setQ] = createSignal("");
  let el!: HTMLDivElement;
  const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[aria-label="Sticker"]')) setStickerPick(null); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setStickerPick(null); } };
  onMount(() => { window.addEventListener("pointerdown", onDown, true); window.addEventListener("keydown", onKey, true); });
  onCleanup(() => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); });
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
    <div ref={el} class="pill stkpick" style={{ left: `${p().x}px`, top: `${p().y}px` }} onPointerDown={(e) => e.stopPropagation()}>
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

/** 放贴纸时跟着指针走的影子 */
export function PlacingGhost() {
  const [pt, setPt] = createSignal({ x: -100, y: -100 });
  const mv = (e: PointerEvent) => setPt({ x: e.clientX, y: e.clientY });
  onMount(() => window.addEventListener("pointermove", mv, true));
  onCleanup(() => window.removeEventListener("pointermove", mv, true));
  return <Show when={placing()}>{(p) => <div class="stkghost" style={{ left: `${pt().x}px`, top: `${pt().y}px` }}><Glyph icon={p().icon} color={p().color} size={28} /></div>}</Show>;
}

type FreeAt = Extract<Sticker["at"], { kind: "canvas" }>;

/** 一枚可拖、可改大小的贴纸；x、y 是它所在那一层的坐标（画布 = 世界坐标，卡里 = 相对卡左上角） */
function FreeSticker(p: { s: Sticker; x: number; y: number }) {
  const at = () => p.s.at as FreeAt;
  const size = () => at().size ?? 32;
  return (
    <div class="stk canvas" classList={{ sel: selSticker() === p.s.id, bound: !!at().on, "lod-map": lod() === "map" }} data-sticker={p.s.id} data-tip={stickerLabel(p.s.icon)}
      style={{ left: `${p.x}px`, top: `${p.y}px`, "min-width": `${size()}px`, height: `${size()}px`, "--s": `${size()}px` }}
      onPointerDown={(e) => stickerDown(e, p.s.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); stickerMenu(p.s.id, e.clientX, e.clientY); }}>
      <Glyph icon={p.s.icon} color={p.s.color} size={size()} />
      <Show when={selSticker() === p.s.id}><span class="sgrip" style={{ scale: `${1 / cam.z}` }} onPointerDown={(e) => stickerDown(e, p.s.id, true)} /></Show>
    </div>
  );
}

/** 画布上没绑东西的贴纸（世界坐标层，在所有卡上面） */
export function CanvasStickers() {
  const list = createMemo(() => state.board.stickers.filter((s) => s.at.kind === "canvas" && !s.at.on));
  return <For each={list()}>{(s) => <FreeSticker s={s} x={(s.at as FreeAt).x} y={(s.at as FreeAt).y} />}</For>;
}

/** 绑在卡上的贴纸：放在卡里面，跟卡同一图层、一起走 */
export function BoundStickers(p: { card: string }) {
  const list = createMemo(() => state.board.stickers.filter((s) => s.at.kind === "canvas" && s.at.on && "card" in s.at.on && s.at.on.card === p.card));
  return <For each={list()}>{(s) => <FreeSticker s={s} x={(s.at as FreeAt).x} y={(s.at as FreeAt).y} />}</For>;
}

// 绑在箭头上的贴纸，按线分好组（每条线的 LinkStickers 都要问）
const NO_STK: Sticker[] = [];
const byLink = createRoot(() => createMemo(() => {
  const m = new Map<string, Sticker[]>();
  for (const s of state.board.stickers) if (s.at.kind === "canvas" && s.at.on && "link" in s.at.on) { const k = s.at.on.link, a = m.get(k); a ? a.push(s) : m.set(k, [s]); }
  return m;
}));

/** 绑在一条箭头上的贴纸：沿线位置 t + 偏移；选中时画一条虚线连到线上那一点。跟这条线在同一层（canvas/Links.tsx） */
export function LinkStickers(p: { link: string }) {
  const list = createMemo(() => byLink().get(p.link) ?? NO_STK, NO_STK, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  return (
    <For each={list()}>
      {(s) => {
        const at = () => s.at as FreeAt;
        const anchor = createMemo(() => { const on = at().on as { link: string; t: number }; const c = linkCurve(on.link); return c ? curveAt(c, on.t) : null; });
        const half = () => (at().size ?? 32) / 2;
        return (
          <Show when={anchor()}>
            {(q) => <>
              <Show when={selSticker() === s.id}>
                <svg class="tether" width="1" height="1"><line x1={q().x} y1={q().y} x2={q().x + at().x + half()} y2={q().y + at().y + half()} style={{ "stroke-width": `${1 / cam.z}px` }} /><circle cx={q().x} cy={q().y} r={3 / Math.max(cam.z, 0.5)} /></svg>
              </Show>
              <FreeSticker s={s} x={q().x + at().x} y={q().y + at().y} />
            </>}
          </Show>
        );
      }}
    </For>
  );
}

/** 贴在卡片角上的贴纸：右上角一排，跟卡片一起走 */
export function CardStickers(p: { card: string }) {
  const list = createMemo(() => state.board.stickers.filter((s) => s.at.kind === "card" && s.at.card === p.card));
  return (
    <Show when={list().length}>
      <div class="cstks">
        <For each={list()}>{(s) => (
          <span class="stk" classList={{ sel: selSticker() === s.id }} data-sticker={s.id} data-tip={stickerLabel(s.icon)}
            onPointerDown={(e) => { e.stopPropagation(); stickerDown(e, s.id); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); stickerMenu(s.id, e.clientX, e.clientY); }}>
            <Glyph icon={s.icon} color={s.color} size={22} />
          </span>
        )}</For>
      </div>
    </Show>
  );
}
