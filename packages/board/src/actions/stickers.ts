import { uid, removeStickers, isQuestion, type IconRef, type Sticker, type StickerAt } from "@codeboard/core";
import { openQuestion, setAnswered, linkAnswer, setStickerDragged } from "./questions";
import { state, rectOf } from "../state/store";
import { mutate, live } from "../state/changes";
import { toast } from "../state/toast";
import { linkCurve } from "../state/geo";
import { bezAt, nearestT } from "../canvas/geom";
import { cam, toWorld } from "../state/camera";
import { boardOffset } from "../state/measure";
import { openMenu, type Item } from "../ui/Menu";
import { STICKER_COLORS, BUILTIN, defaultColor, loadPacks } from "../stickers/glyphs";
import { geo } from "../state/geo";
import { stickerPick, setStickerPick, stickerColor, selSticker, setSelSticker, setBindHot, type BindTarget } from "../state/stickers";
import { setMode, placing, idle } from "../state/mode";
import { track, undoGesture } from "../gesture";

export function stickerPicker(el: HTMLElement) {
  if (stickerPick()) return setStickerPick(null);
  const r = el.getBoundingClientRect();
  setStickerPick({ x: r.left + r.width / 2, y: r.top - 8 });
  void loadPacks();
}
export function pickSticker(icon: IconRef) {
  setStickerPick(null);
  setMode({ kind: "place", icon, color: stickerColor() });
  toast("Click a code line, a card or empty canvas to place it · Esc to cancel");
}

/** 放下：看指针下面是什么。行号栏 → 贴在那一行；卡 / 箭头 → 绑上去（⌥ = 只放在画布上）；空白 → 画布 */
export function placeStickerAt(e: PointerEvent): boolean {
  const p = placing();
  if (!p) return false;
  e.preventDefault(); e.stopPropagation();
  idle();
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
  // 「?」贴纸：放下就写问题
  const q = isQuestion(st);
  if (q) st.q = { md: "", at: Date.now() };
  mutate((b) => { b.stickers.push(st); });
  setSelSticker(id);
  if (q) requestAnimationFrame(() => openQuestion(id, undefined, true));
  return true;
}

/**
 * 指针下面的卡或箭头（跳过贴纸自己）；不在任何东西上时吸附最近的：
 * 离卡边 40px、离箭头 24px（屏幕距离）以内都算，像贴在卡角外面也能绑上
 */
const MAG_CARD = 40, MAG_LINK = 24;
/**
 * 画布上看得见的卡（折叠起来的不在 DOM 里）和它们占的地方。一次拖动里不会变：拖之前量一次，不要每次 pointermove 对每张卡各查一次 DOM。
 * near：指针不在哪张卡附近时不用问浏览器指针下面是什么（同拖卡的 nearOther）：elementsFromPoint 在几百张卡的白板上每次几毫秒，
 * 箭头离得近由下面的吸附算出来。外面留一圈：浮在卡上方的卡头、斜贴的卡角
 */
function shownCards() {
  const ids = new Set([...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((e) => e.dataset.id!));
  const rs = [...ids].filter((id) => state.board.place[id]).map((id) => rectOf(id));
  const near = (w: { x: number; y: number }, z: number) => {
    const pad = Math.max(64, 24 / z);
    return rs.some((r) => w.x >= r.x - pad && w.x <= r.x + r.w + pad && w.y >= r.y - pad && w.y <= r.y + r.h + pad);
  };
  return { ids, near };
}
function targetAt(cx: number, cy: number, shown = shownCards()): BindTarget | null {
  const o = boardOffset(), w = toWorld(cx - o.x, cy - o.y), z = cam.z;
  if (shown.near(w, z)) for (const el of document.elementsFromPoint(cx, cy) as HTMLElement[]) {
    if (el.closest?.(".stk, .ctx, .toolbar, .bbar")) continue;
    const l = (el as HTMLElement).dataset?.link ?? el.closest?.("[data-link]")?.getAttribute("data-link");
    if (l && state.board.links.some((k) => k.id === l)) return { link: l };
    const c = el.closest?.(".card[data-id]") as HTMLElement | null;
    if (c && state.board.place[c.dataset.id!]) return { card: c.dataset.id! };
  }
  let best: BindTarget | null = null, bd = Infinity;
  for (const id of Object.keys(state.board.place)) {
    if (!shown.ids.has(id)) continue;
    const r = rectOf(id);
    const dx = Math.max(r.x - w.x, 0, w.x - (r.x + r.w)), dy = Math.max(r.y - w.y, 0, w.y - (r.y + r.h));
    const d = Math.hypot(dx, dy) * z;
    if (d <= MAG_CARD && d < bd) { bd = d; best = { card: id }; }
  }
  for (const l of state.board.links) {
    const c = linkCurve(l.id);
    if (!c) continue;
    // 贝塞尔曲线在四个控制点的包围盒里：离包围盒都超过吸附距离的线不用逐点找最近点
    const m = MAG_LINK / z;
    if (w.x < Math.min(c[0], c[2], c[4], c[6]) - m || w.x > Math.max(c[0], c[2], c[4], c[6]) + m || w.y < Math.min(c[1], c[3], c[5], c[7]) - m || w.y > Math.max(c[1], c[3], c[5], c[7]) + m) continue;
    const q = bezAt(c, nearestT(c, w.x, w.y)), d = Math.hypot(q.x - w.x, q.y - w.y) * z;
    if (d <= MAG_LINK && d < bd) { bd = d; best = { link: l.id }; }
  }
  return best;
}

/** 贴纸左上角的世界坐标 */
function stickerWorld(s: Sticker): { x: number; y: number } | null {
  if (s.at.kind !== "canvas") return null;
  const on = s.at.on;
  if (!on) return { x: s.at.x, y: s.at.y };
  if ("card" in on) { const r = rectOf(on.card); return { x: r.x + s.at.x, y: r.y + s.at.y }; }
  const c = linkCurve(on.link);
  if (!c) return null;
  const q = bezAt(c, on.t);
  return { x: q.x + s.at.x, y: q.y + s.at.y };
}

function bindAt(w: { x: number; y: number }, size: number, t: BindTarget | null): StickerAt {
  if (t && "card" in t) { const r = rectOf(t.card); return { kind: "canvas", x: Math.round(w.x - r.x), y: Math.round(w.y - r.y), size, on: { card: t.card } }; }
  if (t && "link" in t) {
    const c = linkCurve(t.link);
    if (c) {
      const tt = nearestT(c, w.x + size / 2, w.y + size / 2), q = bezAt(c, tt);
      return { kind: "canvas", x: Math.round(w.x - q.x), y: Math.round(w.y - q.y), size, on: { link: t.link, t: tt } };
    }
  }
  return { kind: "canvas", x: Math.round(w.x), y: Math.round(w.y), size };
}

/** 解绑：留在原地，变成画布上的贴纸 */
function detachSticker(id: string) {
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

/** @public run from the key table (keymap.ts) */
export function removeSticker(id: string) {
  mutate((b) => removeStickers(b, [id]));
  if (selSticker() === id) setSelSticker(null);
}
function setStickerColorOf(id: string, color: string | undefined) {
  mutate((b) => { const s = b.stickers.find((k) => k.id === id); if (s) s.color = color && color !== defaultColor(s.icon) ? color : undefined; });
}
export function stickerMenu(id: string, x: number, y: number) {
  const s = state.board.stickers.find((k) => k.id === id);
  if (!s) return;
  setSelSticker(id);
  const names = ["Gold", "Orange", "Red", "Pink", "Purple", "Blue", "Green", "Grey"];
  const qi: Item[] = isQuestion(s) ? [
    { label: s.q?.md ? "Edit Question" : "Write Question", kbd: "Click", run: () => openQuestion(id, undefined, true) },
    s.q?.done ? { label: "Reopen", run: () => setAnswered(id, false) } : { label: "Mark Answered", run: () => setAnswered(id, true) },
    { label: "Link Answer…", hint: "The card or Note that answers it", run: () => linkAnswer(id) },
    null,
  ] : [];
  const items: Item[] = [
    ...qi,
    ...(s.icon.pack === "emoji" ? [] : [{ label: "Color", sub: [{ label: "Default", checked: !s.color, run: () => setStickerColorOf(id, undefined) } as Item, ...STICKER_COLORS.map((c, i) => ({ label: names[i], checked: s.color === c, run: () => setStickerColorOf(id, c) }))] } as Item]),
    ...(s.at.kind === "canvas" ? [{ label: "Size", sub: [24, 32, 48, 72].map((n) => ({ label: `${n}px`, checked: s.at.kind === "canvas" && s.at.size === n, run: () => mutate((b) => { const k = b.stickers.find((q) => q.id === id); if (k?.at.kind === "canvas") k.at.size = n; }) })) } as Item] : []),
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
  const g = undoGesture();
  let moved = false, shown: ReturnType<typeof shownCards> | undefined;
  setStickerDragged(false);
  track(e, (ev) => {
    const dx = (ev.clientX - sx) / cam.z, dy = (ev.clientY - sy) / cam.z;
    if (resize) {
      live((b) => { const k = b.stickers.find((q) => q.id === id); if (k?.at.kind === "canvas") k.at.size = Math.round(Math.max(16, Math.min(240, size + Math.max(dx, dy)))); });
      return;
    }
    // 拖的时候先放到最上层（画布层），松手再决定绑到哪。只在第一下换 at（解绑），之后只改 x、y：
    // 换掉 at 会通知所有按卡分组的贴纸列表，只改坐标只通知这一枚贴纸自己
    const x = Math.round(w0.x + dx), y = Math.round(w0.y + dy);
    live((b) => {
      const k = b.stickers.find((q) => q.id === id);
      if (!k) return;
      if (moved && k.at.kind === "canvas" && !k.at.on) { k.at.x = x; k.at.y = y; } else k.at = { kind: "canvas", x, y, size: a0.size };
    });
    moved = true;
    setBindHot(ev.altKey ? null : targetAt(ev.clientX, ev.clientY, (shown ??= shownCards())));
  }, (ev) => {
    if (moved) {
      const t = ev.altKey ? null : targetAt(ev.clientX, ev.clientY, shown);
      const w = { x: w0.x + (ev.clientX - sx) / cam.z, y: w0.y + (ev.clientY - sy) / cam.z };
      const at = bindAt(w, size, t);
      if (a0.size === undefined && at.kind === "canvas") delete at.size;
      live((b) => { const k = b.stickers.find((q) => q.id === id); if (k) k.at = at; });
    }
    setStickerDragged(moved); // 拖过的不算点一下（不打开问题）
    setBindHot(null);
    g.end();
  }, resize ? 0 : 3, g.drop);
}
