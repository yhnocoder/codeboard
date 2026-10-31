import { cardTitle, isCode, segOf, bounds, type Card, type Section, type Rect } from "@codeboard/core";
import { state, mutate, sel, select, isSel, cardById, hostOf, rectOf, placeOf, placed, flows } from "../state/store";
import { frames, isHidden, visibleCards } from "../state/sections";
import { subRef } from "../state/subboards";
import { linkCurve } from "../state/geo";
import { extraList } from "../state/extent";
import { bezAt, bezBox } from "../canvas/geom";
import { camTo, camRest, ensureVisible, fitRect, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, ping, setPopIn, popIn, setPaletteOpen, setSizeIn, type SizeAnim } from "../state/ui";
import { openPop, updatePop } from "../state/pop";
import { lastPointer, naturalSize, chromeOf, cardsMeasured, CODE_MAX } from "../state/measure";
import { send, ask } from "../host";
import { renderMd, renderMdInline, type RefBroken, type RefTarget } from "@yhnocoder/markdown";
import { crossRef } from "../md/refs";
import { mathRev } from "../md/math";
import { cardSel } from "../cardsel";

const isMac = () => state.host.isMac;
/** 说明文字里的修饰键（「⌥-click」「⌘↵ to save」）；有绑定的快捷键用 keymap 的 kbd(id) */
export const K = {
  get mod() { return isMac() ? "⌘" : "Ctrl+"; },
  get alt() { return isMac() ? "⌥" : "Alt+"; },
};

export function selectCard(id: string, add = false) {
  const f = cardById(id);
  if (!f) return;
  const top = f.host.id;
  if (add) { if (!isSel(top)) select({ cards: [top] }, true); return; }
  if (!(sel.cards.length === 1 && sel.cards[0] === top && !sel.links.length && !sel.sections.length)) select({ cards: [top] });
}
export function selectAll() {
  select({ cards: visibleCards().filter((c) => !isLocked(c.id)).map((c) => c.id) });
}
export const selCards = () => sel.cards.map((id) => cardById(id)?.card).filter(Boolean) as Card[];

// 读 mathRev：公式预设换了，用它的地方重画
export const mdInline = (s: string) => (mathRev(), renderMdInline(s));
export const mdBlock = (s: string) => (mathRev(), renderMd(s));
export const sidenotesOf = notesOf;
/** [[引用]] 找卡：先当 id，再按标题（不分大小写，重名时取第一张），再到子白板里找，最后是别的白板上的（[[白板 › 卡]]） */
export function resolveCardRef(label: string): RefTarget | RefBroken | null {
  const l = label.trim();
  if (!l) return null;
  const byId = cardById(l);
  if (byId) return { id: byId.card.id, title: cardTitle(byId.card, state.board) };
  const low = l.toLowerCase();
  for (const c of placed()) { const t = cardTitle(c, state.board); if (t.trim().toLowerCase() === low) return { id: c.id, title: t.trim() }; }
  // 子白板里的卡：[[子白板 › 卡]]
  const s = subRef(l);
  if (s) return { id: s.id, title: s.label };
  // 卡以外：这块白板上的 Section，再是别的白板（@ 引用列出它们，同名时卡优先）
  const sec = state.board.sections.find((x) => x.title.trim().toLowerCase() === low);
  if (sec) return { id: sec.id, title: sec.title.trim() };
  const b = state.boards.find((m) => m.id !== state.board.id && m.name.trim().toLowerCase() === low);
  if (b) return { id: b.id, title: b.name.trim() };
  return crossRef(l, (t) => { const r = resolveCardRef(t); return r && !("broken" in r) ? r : null; });
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

/** 带到眼前：藏在折叠的调用子树、折叠的 Section 里的卡先展开（展开了要等它量好大小再挪镜头）。镜头停下时 resolve */
export async function revealCard(id: string, doPing = true): Promise<void> {
  const f = cardById(id);
  if (!f) return;
  if (unhide(id)) await cardsMeasured();
  const r = hostRect(id);
  if (!r) return;
  ensureVisible(r);
  if (doPing) ping(f.host.id);
  await camRest();
}
/** 展开藏着这张卡的：调用图里它上面折叠着的卡、它所在的折叠的 Section（一层层往外）。返回有没有展开什么 */
function unhide(id: string): boolean {
  if (!isHidden(id)) return false;
  const h = hostOf(id), up = new Set<string>(), todo = [id];
  while (todo.length) for (const l of flows().parents.get(todo.pop()!) ?? []) {
    const p = hostOf(l.from.card);
    if (!up.has(p)) { up.add(p); todo.push(l.from.card); }
  }
  return mutate((b) => {
    for (const k of up) if (b.place[k]?.collapsed) b.place[k].collapsed = undefined;
    const seen = new Set<string>();
    for (let s = b.sections.find((q) => q.id === b.place[h]?.section); s && !seen.has(s.id); s = b.sections.find((q) => q.id === s!.parent)) { seen.add(s.id); if (s.collapsed) s.collapsed = undefined; }
  });
}
/**
 * What is drawn outside the cards for these host cards (null = every visible card): the lines between them (a curve can
 * bulge past both cards), their label boxes, the alternatives column beside a call's target, and stickers on the canvas,
 * on the cards or on the lines. Only model geometry and sizes measured earlier: no layout read
 */
function drawnAround(hosts: Set<string> | null): Rect[] {
  const ours = (card: string) => { const f = cardById(card); return !!f && (hosts ? hosts.has(f.host.id) : !isHidden(f.host.id)); };
  const out: Rect[] = [];
  const lines = new Set<string>();
  for (const L of state.board.links) {
    if (!ours(L.from.card) || !ours(L.to.card)) continue;
    const c = linkCurve(L.id);
    if (c) { out.push(bezBox(c)); lines.add(L.id); }
  }
  for (const e of extraList()) {
    if (e.kind === "label" ? !lines.has(e.link) : !ours(state.board.links.find((l) => l.id === e.link)?.to.card ?? "")) continue;
    const r = e.rect();
    if (r) out.push(r);
  }
  for (const s of state.board.stickers) {
    if (s.at.kind !== "canvas") continue;
    const { x, y, on } = s.at, n = s.at.size ?? 32;
    if (!on) { if (!hosts) out.push({ x, y, w: n, h: n }); continue; }
    if ("card" in on) { if (ours(on.card)) { const p = placeOf(on.card); out.push({ x: p.x + x, y: p.y + y, w: n, h: n }); } continue; }
    const c = lines.has(on.link) ? linkCurve(on.link) : null;
    if (c) { const q = bezAt(c, on.t); out.push({ x: q.x + x, y: q.y + y, w: n, h: n }); }
  }
  return out;
}

/** 适应窗口：只框看得见的（折叠的调用子树里的卡不算，折叠的 Section 只算它的标题条） */
export function fitAll() {
  const rs = [...visibleCards().map((c) => rectOf(c)), ...frames().values(), ...drawnAround(null)];
  const b = bounds(rs);
  if (!b) return camTo(80, 80, 1);
  const f = fitRect(b, 1);
  camTo(f.x, f.y, f.z);
}
/** @public run from the key table (keymap.ts) */
export function fitSelection() {
  const hosts = new Set(sel.cards.flatMap((id) => { const f = cardById(id); return f ? [f.host.id] : []; }));
  const rs = [...[...hosts].map((id) => hostRect(id)).filter(Boolean) as Rect[], ...(hosts.size ? drawnAround(hosts) : [])];
  const b = bounds(rs);
  if (!b) return fitAll();
  const f = fitRect(b, 1.4);
  camTo(f.x, f.y, f.z);
}

/** 弹出的起点：离卡的位置多远（popCard 从这里开始） */
function popStart(id: string, from?: { x: number; y: number }) {
  const h = cardById(id)?.host;
  const c = placeOf(h?.id ?? id);
  return { ox: from ? (from.x - c.x) * 0.7 : 0, oy: from ? (from.y - c.y) * 0.7 : 24 };
}
/** 新卡弹出来：从 from 点（世界坐标）放大淡入。透明度只增不减。 */
export function popCard(id: string, from?: { x: number; y: number }) {
  if (!cardById(id)) return;
  const { ox, oy } = popStart(id, from);
  const sp = new Spring(0, 260, 26, 0.002);
  sp.t = 1;
  setPopIn(id, { ox, oy, v: 0 });
  const start = performance.now();
  animate((dt, instant) => {
    if (performance.now() - start < (reduceMotion() ? 0 : 20)) return false;
    instant ? sp.set(1) : sp.step(dt);
    const v = Math.min(1, Math.max(popIn()[id]?.v ?? 0, sp.v));
    const done = sp.done || instant;
    setPopIn(id, done ? undefined : { ox, oy, v });
    return done;
  });
}

/** 卡片已经挪到新位置，画面上从旧位置滑过去 */
export function slideFrom(list: { id: string; ox: number; oy: number }[]) {
  if (reduceMotion()) return;
  const sp = new Spring(0, 170, 26, 0.002); sp.t = 1;
  for (const q of list) setPopIn(q.id, { ox: q.ox, oy: q.oy, v: 0, slide: true });
  animate((dt) => {
    sp.step(dt);
    const done = sp.done;
    for (const q of list) setPopIn(q.id, done ? undefined : { ox: q.ox, oy: q.oy, v: sp.v, slide: true });
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

export function openCode(id: string, seg?: string, line?: number) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = segOf(c, seg);
  if (!s || s.src.kind === "free") return;
  send({ type: "open", card: id, seg: s.id, line: line ?? s.start });
}
export function openLink(url: string) { send({ type: "openLink", url }); }
export function searchWorkspace(word: string) { setPaletteOpen({ mode: "code", q: word }); }

/** HEAD 和工作区的 diff（卡头的「+ uncommitted」） */
export function openWorktreeDiff(id: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  const el = document.querySelector(`${cardSel(hostOf(id))} .rev`) ?? undefined;
  const pid = openPop({ kind: "diff", card: id, seg: s.id }, el ? { el, prefer: "below" } : lastPointer());
  ask("diff", { seg: s, against: "worktree" })
    .then((data) => updatePop(pid, "diff", (p) => ({ ...p, data })))
    .catch((e) => updatePop(pid, "diff", (p) => ({ ...p, error: (e as Error).message })));
}

/** Fit Content：宽 = 最长行，高 = 所有可见行；多选时各自适配。
 *  高度不存（Note、代码卡和新卡一样跟着内容：加行变高、删行变矮），只有代码比没存高度时的上限（CODE_MAX）还高的代码卡存下内容区的高度 */
export function fitContent(ids: string[]) {
  const sz = new Map<string, { w?: number; h: number; body?: number }>();
  for (const id of ids) { const h = cardById(id)?.host.id; const n = h && naturalSize(h); if (h && n) sz.set(h, n); }
  if (!sz.size) return;
  const chrome = new Map([...sz.keys()].map((id) => [id, chromeOf(id)]));
  const from = new Map([...sz.keys()].flatMap((id) => { const s = shownSize(id); return s ? [[id, s] as const] : []; }));
  mutate((b) => {
    for (const [id, n] of sz) {
      const p = b.place[id];
      if (!p) continue;
      if (n.w) p.w = Math.max(240, Math.min(1600, n.w));
      const c = b.cards.find((k) => k.id === id);
      const code = c?.kind === "code";
      p.h = c?.kind === "note" || c?.kind === "web" || c?.kind === "image" || (code && n.body !== undefined && n.body <= CODE_MAX) ? undefined : Math.round(n.h - (code ? chrome.get(id)! : 0));
    }
  });
  growFrom(from);
}

/** 卡画出来的宽和存着高度的那一块的高（代码卡是内容区 .carea，别的卡整张） */
function shownSize(id: string): SizeAnim | null {
  const el = document.querySelector<HTMLElement>(`${cardSel(id)}`);
  if (!el) return null;
  const box = el.querySelector<HTMLElement>(":scope > .cface > .carea") ?? el;
  return { w: el.offsetWidth, h: box.offsetHeight };
}
/** 卡已经是新的大小（白板里改好了）：画面上从旧的大小平滑地变过去 */
function growFrom(from: Map<string, SizeAnim>) {
  if (reduceMotion()) return;
  const runs = [...from].flatMap(([id, a]) => {
    const b = shownSize(id);
    return b && (Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1) ? [{ id, a, b }] : [];
  });
  if (!runs.length) return;
  const me = {};
  for (const r of runs) growing.set(r.id, me);
  const sp = new Spring(0, 170, 26, 0.002); sp.t = 1;
  // 动画中又变了一次（再按一次 Fit Content）：那张卡归新的这一轮，从它画到一半的大小接着变
  const at = (v: number | null) => { for (const r of runs) if (growing.get(r.id) === me) setSizeIn(r.id, v === null ? undefined : { w: r.a.w + (r.b.w - r.a.w) * v, h: r.a.h + (r.b.h - r.a.h) * v }); };
  at(0);
  animate((dt, instant) => {
    instant ? sp.set(1) : sp.step(dt);
    if (sp.done) { at(null); for (const r of runs) if (growing.get(r.id) === me) growing.delete(r.id); return true; }
    at(Math.min(1, sp.v));
    return false;
  });
}
const growing = new Map<string, object>();
