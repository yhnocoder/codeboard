// 贴纸（#44 #45）：工具栏 Sticker → 选图标 → 点一下放下。贴在代码行（进行号栏，随 Update 跟行走）、卡片角上、或画布任意位置。
import { createSignal } from "solid-js";
import { uid, type IconRef, type Sticker, type StickerAt } from "@codeboard/core";
import { state, mutate, live, beginGesture, cardById, toast } from "../state/store";
import { cam } from "../state/camera";
import { openMenu, type Item } from "../ui/Menu";
import { STICKER_COLORS, BUILTIN, defaultColor, loadPacks } from "../stickers/glyphs";
import { boardOffset } from "./common";
import { toWorld } from "../state/camera";
import { geo } from "../state/geo";

/** 选图标面板：开在哪个按钮上面 */
export const [stickerPick, setStickerPick] = createSignal<{ x: number; y: number } | null>(null);
/** 正在放的贴纸（跟着指针走，点一下放下） */
export const [placing, setPlacing] = createSignal<{ icon: IconRef; color?: string } | null>(null);
export const [selSticker, setSelSticker] = createSignal<string | null>(null);
/** 选图标面板里上次选的颜色 */
export const [stickerColor, setStickerColor] = createSignal<string | undefined>(undefined);

export function stickerPicker(el: HTMLElement) {
  if (stickerPick()) return setStickerPick(null);
  const r = el.getBoundingClientRect();
  setStickerPick({ x: r.left + r.width / 2, y: r.top - 8 });
  void loadPacks();
}
export function pickSticker(icon: IconRef) {
  setStickerPick(null);
  setPlacing({ icon, color: stickerColor() });
  toast("Click a code line, a card or empty canvas to place it · Esc to cancel");
}

/** 放下：看指针下面是什么 */
export function placeStickerAt(e: PointerEvent): boolean {
  const p = placing();
  if (!p) return false;
  e.preventDefault(); e.stopPropagation();
  setPlacing(null);
  const t = e.target as HTMLElement;
  const ce = t.closest?.(".card") as HTMLElement | null;
  let at: StickerAt;
  const row = t.closest?.(".src > .l, .gutter .no") as HTMLElement | null;
  const lineAt = row && ce ? rowLine(ce, row) : null;
  if (lineAt) at = { kind: "line", ...lineAt };
  else if (ce && cardById(ce.dataset.id!)) at = { kind: "card", card: ce.dataset.id! };
  else { const o = boardOffset(); const w = toWorld(e.clientX - o.x, e.clientY - o.y); at = { kind: "canvas", x: Math.round(w.x - 16), y: Math.round(w.y - 16), size: 32 }; }
  const id = uid("k");
  const st: Sticker = { id, icon: p.icon, color: p.color && p.color !== defaultColor(p.icon) ? p.color : undefined, at };
  mutate((b) => { b.stickers.push(st); });
  setSelSticker(id);
  return true;
}
/** 行号栏或代码行 → 卡、段、行（data-r 是 CodeBody 量好的行序号） */
function rowLine(cardEl: HTMLElement, el: HTMLElement): { card: string; seg: string; line: number } | null {
  const id = (el.closest("[data-col]") as HTMLElement | null)?.dataset.col ?? cardEl.dataset.id!;
  const r = geo[id]?.rows[+(el.dataset.r ?? -1)];
  return r?.t === "line" ? { card: id, seg: r.seg, line: r.line } : null;
}

export function removeSticker(id: string) {
  mutate((b) => { b.stickers = b.stickers.filter((s) => s.id !== id); });
  if (selSticker() === id) setSelSticker(null);
}
export function setStickerColorOf(id: string, color: string | undefined) {
  mutate((b) => { const s = b.stickers.find((k) => k.id === id); if (s) s.color = color && color !== defaultColor(s.icon) ? color : undefined; });
}
export function stickerMenu(id: string, x: number, y: number) {
  const s = state.board.stickers.find((k) => k.id === id);
  if (!s) return;
  setSelSticker(id);
  const names = ["Gold", "Orange", "Red", "Pink", "Purple", "Blue", "Green", "Grey"];
  const items: Item[] = [
    ...(s.icon.pack === "emoji" ? [] : [{ label: "Color", sub: [{ label: "Default", checked: !s.color, run: () => setStickerColorOf(id, undefined) } as Item, ...STICKER_COLORS.map((c, i) => ({ label: names[i], checked: s.color === c, run: () => setStickerColorOf(id, c) }))] } as Item]),
    ...(s.at.kind === "canvas" ? [{ label: "Size", sub: [24, 32, 48, 72].map((n) => ({ label: `${n}px`, checked: (s.at as any).size === n, run: () => mutate((b) => { const k = b.stickers.find((q) => q.id === id); if (k?.at.kind === "canvas") k.at.size = n; }) })) } as Item] : []),
    null,
    { label: "Delete", kbd: "⌫", run: () => removeSticker(id) },
  ];
  openMenu(items, x, y);
}
export const stickerLabel = (i: IconRef) => (i.pack === "builtin" ? BUILTIN.find((b) => b.name === i.name)?.label ?? i.name : i.pack === "emoji" ? i.name : `${i.pack}:${i.name}`);

/** 画布上的贴纸：拖动移动，右下角拖动改大小 */
export function stickerDown(e: PointerEvent, id: string, resize = false) {
  if (e.button === 2) return;
  e.stopPropagation(); e.preventDefault();
  setSelSticker(id);
  const s = state.board.stickers.find((k) => k.id === id);
  if (s?.at.kind !== "canvas") return;
  const a0 = { ...s.at }, sx = e.clientX, sy = e.clientY;
  const end = beginGesture();
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / cam.z, dy = (ev.clientY - sy) / cam.z;
    live((b) => {
      const k = b.stickers.find((q) => q.id === id);
      if (k?.at.kind !== "canvas") return;
      if (resize) k.at.size = Math.round(Math.max(16, Math.min(240, (a0.size ?? 32) + Math.max(dx, dy))));
      else { k.at.x = Math.round(a0.x + dx); k.at.y = Math.round(a0.y + dy); }
    });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); end(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
