// 公用：快捷键符号、选择、锁、镜头、新卡弹出动画、指针位置、打开编辑器 / 链接。
import { cardTitle, isCode, segOf, bounds, type Card, type Section, type Rect } from "@codeboard/core";
import { state, mutate, sel, select, isSel, cardById, rectOf, placeOf, placed } from "../state/store";
import { camTo, ensureVisible, fitRect, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, ping, setPopIn, popIn } from "../state/ui";
import { openPop } from "../state/pop";
import { send } from "../host";
import { renderMd, renderMdInline } from "../md/render";

const isMac = () => state.host.isMac;
export const K = {
  get mod() { return isMac() ? "⌘" : "Ctrl+"; },
  get shift() { return isMac() ? "⇧" : "Shift+"; },
  get alt() { return isMac() ? "⌥" : "Alt+"; },
  get lock() { return `${K.mod}${K.shift}L`; },
};

// ---------- 选择 ----------

export function selectCard(id: string, add = false) {
  const f = cardById(id);
  if (!f) return;
  const top = f.host.id;
  if (add) { if (!isSel(top)) select({ cards: [top] }, true); return; }
  if (!(sel.cards.length === 1 && sel.cards[0] === top && !sel.links.length && !sel.sections.length)) select({ cards: [top] });
}
export function selectAll() {
  select({ cards: placed().filter((c) => !isLocked(c.id)).map((c) => c.id) });
}
export const selCards = () => sel.cards.map((id) => cardById(id)?.card).filter(Boolean) as Card[];

// ---------- 小工具 ----------

export const mdInline = (s: string) => renderMdInline(s);
export const mdBlock = (s: string) => renderMd(s);
export const sidenotesOf = notesOf;
/** [[引用]] 找卡：先当 id，再按标题（不分大小写，重名时取第一张） */
export function resolveCardRef(label: string): { id: string; title: string } | null {
  const l = label.trim();
  if (!l) return null;
  const byId = cardById(l);
  if (byId) return { id: byId.card.id, title: cardTitle(byId.card, state.board) };
  const low = l.toLowerCase();
  for (const c of placed()) { const t = cardTitle(c, state.board); if (t.trim().toLowerCase() === low) return { id: c.id, title: t.trim() }; }
  return null;
}
export const hostRect = (id: string) => { const f = cardById(id); return f ? rectOf(f.host) : null; };

function sectionOf(id: string): Section | undefined {
  const f = cardById(id);
  const sid = f && placeOf(f.host.id).section;
  return sid ? state.board.sections.find((s) => s.id === sid) : undefined;
}
export const sectionById = (id?: string) => (id ? state.board.sections.find((s) => s.id === id) : undefined);
export function sectionLocked(s?: Section): boolean {
  for (let q = s, i = 0; q && i < 50; q = sectionById(q.parent), i++) if (q.locked) return true;
  return false;
}
export function isLocked(id: string) {
  const f = cardById(id);
  if (!f) return false;
  return !!placeOf(f.host.id).locked || sectionLocked(sectionOf(f.host.id));
}

// ---------- 镜头 ----------

export function revealCard(id: string, doPing = true) {
  const r = hostRect(id);
  if (!r) return;
  ensureVisible(r);
  if (doPing) ping(cardById(id)!.host.id);
}
export function fitAll() {
  const rs = [...placed().map((c) => rectOf(c)), ...state.board.sections.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))];
  const b = bounds(rs);
  if (!b) return camTo(80, 80, 1);
  const f = fitRect(b, 1);
  camTo(f.x, f.y, f.z);
}
export function fitSelection() {
  const rs = sel.cards.map((id) => hostRect(id)).filter(Boolean) as Rect[];
  const b = bounds(rs);
  if (!b) return fitAll();
  const f = fitRect(b, 1.4);
  camTo(f.x, f.y, f.z);
}



/** 新卡弹出来：从 from 点（世界坐标）放大淡入。透明度只增不减。 */
export function popCard(id: string, from?: { x: number; y: number }) {
  const h = cardById(id)?.host;
  if (!h) return;
  const c = placeOf(h.id);
  const ox = from ? (from.x - c.x) * 0.7 : 0, oy = from ? (from.y - c.y) * 0.7 : 24;
  const sp = new Spring(0, 260, 26, 0.002);
  sp.t = 1;
  setPopIn((p) => ({ ...p, [id]: { ox, oy, v: 0 } }));
  const start = performance.now();
  animate((dt, instant) => {
    if (performance.now() - start < (reduceMotion() ? 0 : 20)) return false;
    instant ? sp.set(1) : sp.step(dt);
    const v = Math.min(1, Math.max(popIn()[id]?.v ?? 0, sp.v)); // 不回退
    const done = sp.done || instant;
    setPopIn((p) => {
      const n = { ...p };
      if (done) delete n[id]; else n[id] = { ox, oy, v };
      return n;
    });
    return done;
  });
}


/** 卡片已经挪到新位置，画面上从旧位置滑过去 */
export function slideFrom(list: { id: string; ox: number; oy: number }[]) {
  if (reduceMotion()) return;
  const sp = new Spring(0, 170, 26, 0.002); sp.t = 1;
  setPopIn((p) => { const n = { ...p }; for (const q of list) n[q.id] = { ox: q.ox, oy: q.oy, v: 0, slide: true } as any; return n; });
  animate((dt) => {
    sp.step(dt);
    const done = sp.done;
    setPopIn((p) => { const n = { ...p }; for (const q of list) { if (done) delete n[q.id]; else n[q.id] = { ...(n[q.id] as any), v: sp.v }; } return n; });
    return done;
  });
}

/** 卡（所在宿主卡）卡头左端在世界坐标里的位置：展开出来的新卡从这里弹出 */
export function headPoint(cardId: string) {
  const r = hostRect(cardId);
  return r ? { x: r.x, y: r.y + 20 } : null;
}


export function showPicker(title: string, items: { label: string; detail: string; run: () => void }[]) {
  const p = lastPointer();
  openPop({ kind: "pick", title, items }, { x: p.x, y: p.y + 12 });
}

let lastPtr = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
window.addEventListener("pointerdown", (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
export const lastPointer = () => lastPtr;


export const boardOffset = () => { const r = document.getElementById("board")?.getBoundingClientRect(); return { x: r?.left ?? 0, y: r?.top ?? 0 }; };

// ---------- 打开 ----------

export function openCode(id: string, seg?: string, line?: number) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = segOf(c, seg);
  if (!s || s.src.kind === "free") return;
  send({ type: "open", card: id, seg: s.id, line: line ?? s.start });
}
export function openLink(url: string) { send({ type: "openLink", url }); }


// ---------- 内容本来的大小（Fit Content、改大小时用；直接量 DOM） ----------

let charW = 0;
/** 等宽字体一个字的宽度 */
function monoW(el: Element) {
  if (charW) return charW;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = getComputedStyle(el).font;
  charW = ctx.measureText("0".repeat(100)).width / 100 || 6.6;
  return charW;
}
/** 代码卡的卡头 / 色带 / 底栏一共多高：主题决定，直接量布局。代码卡的 Place.h 存的是中间内容区（.carea）的高度，不含这些 */
export function chromeOf(id: string): number {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  const a = el?.querySelector<HTMLElement>(":scope > .cface > .carea");
  return el && a ? el.offsetHeight - a.offsetHeight : 0;
}
/** 卡片内容刚好装下的宽高；minH = 头部 + 一行 */
export function naturalSize(id: string): { w?: number; h: number; minH: number } | null {
  const el = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  if (!el) return null;
  const f = cardById(id);
  const body = el.querySelector<HTMLElement>(".cbody");
  const code = body?.querySelector<HTMLElement>(":scope > .code");
  const head = el.querySelector<HTMLElement>(":scope > .cface > .chead")?.offsetHeight ?? 0;
  if (f && isCode(f.card) && body && code) {
    const src = code.querySelector<HTMLElement>(".src");
    const top = body.offsetTop;
    const h = top + code.offsetHeight + 2;
    let w: number | undefined;
    if (src && !f.card.wrap) {
      const cs = getComputedStyle(src);
      const longest = Math.max(12, ...f.card.segments.flatMap((s) => s.text.map((t) => t.replace(/\t/g, "    ").length)));
      w = Math.ceil(longest * monoW(src) + parseFloat(cs.marginLeft) + parseFloat(cs.paddingRight) + 4);
    }
    return { w, h, minH: top + 6 + 20 + 8 + 2 };
  }
  if (f?.card.kind === "image") {
    const img = el.querySelector("img");
    const w = el.offsetWidth;
    return img?.naturalWidth ? { h: Math.round(head + (w * img.naturalHeight) / img.naturalWidth), minH: head + 40 } : null;
  }
  return { h: el.scrollHeight, minH: head + 30 };
}

/** Fit Content（#25）：宽 = 最长行，高 = 所有可见行；多选时各自适配 */
export function fitContent(ids: string[]) {
  const sz = new Map<string, { w?: number; h: number }>();
  for (const id of ids) { const h = cardById(id)?.host.id; const n = h && naturalSize(h); if (h && n) sz.set(h, n); }
  if (!sz.size) return;
  const chrome = new Map([...sz.keys()].map((id) => [id, chromeOf(id)]));
  mutate((b) => {
    for (const [id, n] of sz) {
      const p = b.place[id];
      if (!p) continue;
      if (n.w) p.w = Math.max(240, Math.min(1600, n.w));
      const c = b.cards.find((k) => k.id === id);
      p.h = c?.kind === "note" || c?.kind === "web" ? undefined : Math.round(n.h - (c?.kind === "code" ? chrome.get(id)! : 0));
    }
  });
}
