// 贴纸（#44 #45）：工具栏 Sticker → 选图标 → 点一下放下。贴在代码行（进行号栏，随 Update 跟行走）、卡片角上、或画布任意位置。
import { createSignal } from "solid-js";
import { uid, type IconRef, type Sticker, type StickerAt } from "@codeboard/core";
import { state, mutate, live, beginGesture, cardById, toast, rectOf } from "../state/store";
import { linkCurve, curveAt, nearestT } from "../canvas/Links";
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

/** 放下：看指针下面是什么。行号栏 → 贴在那一行；卡 / 箭头 → 绑上去（⌥ = 只放在画布上）；空白 → 画布 */
export function placeStickerAt(e: PointerEvent): boolean {
  const p = placing();
  if (!p) return false;
  e.preventDefault(); e.stopPropagation();
  setPlacing(null);
  const t = e.target as HTMLElement;
  const ce = t.closest?.(".card") as HTMLElement | null;
  let at: StickerAt;
  const row = t.closest?.(".gutter .no") as HTMLElement | null;
  const lineAt = row && ce ? rowLine(ce, row) : null;
  if (lineAt) at = { kind: "line", ...lineAt };
  else {
    const o = boardOffset(); const w = toWorld(e.clientX - o.x, e.clientY - o.y);
    at = bindAt({ x: Math.round(w.x - 16), y: Math.round(w.y - 16) }, 32, e.altKey ? null : targetAt(e.clientX, e.clientY));
  }
  const id = uid("k");
  const st: Sticker = { id, icon: p.icon, color: p.color && p.color !== defaultColor(p.icon) ? p.color : undefined, at };
  mutate((b) => { b.stickers.push(st); });
  setSelSticker(id);
  return true;
}

type Target = { card: string } | { link: string };
/** 拖贴纸时指针下面能绑的东西（亮起来） */
export const [bindHot, setBindHot] = createSignal<Target | null>(null);
/** 选中的贴纸绑在哪张卡上（那张卡画一圈虚线） */
export const boundCardOf = (id: string | null) => {
  const s = id ? state.board.stickers.find((k) => k.id === id) : undefined;
  return s?.at.kind === "canvas" && s.at.on && "card" in s.at.on ? s.at.on.card : null;
};

/** 指针下面第一张卡或第一条箭头（跳过贴纸自己） */
function targetAt(cx: number, cy: number): Target | null {
  for (const el of document.elementsFromPoint(cx, cy) as HTMLElement[]) {
    if (el.closest?.(".stk, .ctx, .toolbar")) continue;
    const l = (el as HTMLElement).dataset?.link ?? el.closest?.("[data-link]")?.getAttribute("data-link");
    if (l && state.board.links.some((k) => k.id === l)) return { link: l };
    const c = el.closest?.(".card[data-id]") as HTMLElement | null;
    if (c && state.board.place[c.dataset.id!]) return { card: c.dataset.id! };
  }
  return null;
}

/** 贴纸左上角的世界坐标 */
export function stickerWorld(s: Sticker): { x: number; y: number } | null {
  if (s.at.kind !== "canvas") return null;
  const on = s.at.on;
  if (!on) return { x: s.at.x, y: s.at.y };
  if ("card" in on) { const r = rectOf({ id: on.card } as any); return { x: r.x + s.at.x, y: r.y + s.at.y }; }
  const c = linkCurve(on.link);
  if (!c) return null;
  const q = curveAt(c, on.t);
  return { x: q.x + s.at.x, y: q.y + s.at.y };
}

/** 世界坐标 + 绑定目标 → StickerAt */
function bindAt(w: { x: number; y: number }, size: number, t: Target | null): StickerAt {
  if (t && "card" in t) { const r = rectOf({ id: t.card } as any); return { kind: "canvas", x: Math.round(w.x - r.x), y: Math.round(w.y - r.y), size, on: { card: t.card } }; }
  if (t && "link" in t) {
    const c = linkCurve(t.link);
    if (c) {
      const tt = nearestT(c, w.x + size / 2, w.y + size / 2), q = curveAt(c, tt);
      return { kind: "canvas", x: Math.round(w.x - q.x), y: Math.round(w.y - q.y), size, on: { link: t.link, t: tt } };
    }
  }
  return { kind: "canvas", x: Math.round(w.x), y: Math.round(w.y), size };
}

/** 解绑：留在原地，变成画布上的贴纸 */
export function detachSticker(id: string) {
  const s = state.board.stickers.find((k) => k.id === id);
  const w = s && stickerWorld(s);
  if (!s || !w || s.at.kind !== "canvas") return;
  const size = s.at.size;
  mutate((b) => { const k = b.stickers.find((q) => q.id === id); if (k) k.at = { kind: "canvas", x: Math.round(w.x), y: Math.round(w.y), size }; });
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
    ...(s.at.kind === "canvas" && s.at.on ? [{ label: "card" in s.at.on ? "Detach from Card" : "Detach from Arrow", hint: "Keep it here on the canvas", run: () => detachSticker(id) } as Item] : []),
    null,
    { label: "Delete", kbd: "⌫", run: () => removeSticker(id) },
  ];
  openMenu(items, x, y);
}
export const stickerLabel = (i: IconRef) => (i.pack === "builtin" ? BUILTIN.find((b) => b.name === i.name)?.label ?? i.name : i.pack === "emoji" ? i.name : `${i.pack}:${i.name}`);

/** 画布上 / 绑着的贴纸：拖动移动（松手时绑到指针下面的卡或箭头，⌥ = 只放画布），右下角拖动改大小 */
export function stickerDown(e: PointerEvent, id: string, resize = false) {
  if (e.button === 2) return;
  e.stopPropagation(); e.preventDefault();
  setSelSticker(id);
  const s = state.board.stickers.find((k) => k.id === id);
  if (s?.at.kind !== "canvas") return;
  const w0 = stickerWorld(s);
  if (!w0) return;
  const a0 = { ...s.at }, size = a0.size ?? 32, sx = e.clientX, sy = e.clientY;
  const end = beginGesture();
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / cam.z, dy = (ev.clientY - sy) / cam.z;
    if (resize) {
      live((b) => { const k = b.stickers.find((q) => q.id === id); if (k?.at.kind === "canvas") k.at.size = Math.round(Math.max(16, Math.min(240, size + Math.max(dx, dy)))); });
      return;
    }
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    // 拖的时候先放到最上层（画布层），松手再决定绑到哪
    live((b) => { const k = b.stickers.find((q) => q.id === id); if (k) k.at = { kind: "canvas", x: Math.round(w0.x + dx), y: Math.round(w0.y + dy), size: a0.size }; });
    setBindHot(ev.altKey ? null : targetAt(ev.clientX, ev.clientY));
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    if (moved) {
      const t = ev.altKey ? null : targetAt(ev.clientX, ev.clientY);
      const w = { x: w0.x + (ev.clientX - sx) / cam.z, y: w0.y + (ev.clientY - sy) / cam.z };
      const at = bindAt(w, size, t);
      if (a0.size === undefined) delete (at as any).size;
      live((b) => { const k = b.stickers.find((q) => q.id === id); if (k) k.at = at; });
    }
    setBindHot(null);
    end();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
