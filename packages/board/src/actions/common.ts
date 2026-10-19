// 公用：快捷键符号、选择、锁、镜头、新卡弹出动画、打开编辑器 / 链接 / diff、Fit Content。
import { unwrap } from "solid-js/store";
import { cardTitle, isCode, segOf, bounds, type Card, type Section, type Rect } from "@codeboard/core";
import { state, mutate, sel, select, isSel, cardById, hostOf, rectOf, placeOf, placed, flows } from "../state/store";
import { frames, isHidden, visibleCards } from "../state/sections";
import { camTo, ensureVisible, fitRect, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, ping, setPopIn, popIn, setPaletteOpen } from "../state/ui";
import { openPop, updatePop } from "../state/pop";
import { lastPointer, naturalSize, chromeOf } from "../state/measure";
import { send, ask } from "../host";
import { renderMd, renderMdInline } from "../md/render";

const isMac = () => state.host.isMac;
/** 说明文字里的修饰键（「⌥-click」「⌘↵ to save」）；有绑定的快捷键用 keymap 的 kbd(id) */
export const K = {
  get mod() { return isMac() ? "⌘" : "Ctrl+"; },
  get alt() { return isMac() ? "⌥" : "Alt+"; },
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
  select({ cards: visibleCards().filter((c) => !isLocked(c.id)).map((c) => c.id) });
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

/** 带到眼前：藏在折叠的调用子树、折叠的 Section 里的卡先展开（展开了要等它画出来、量好大小再挪镜头） */
export function revealCard(id: string, doPing = true) {
  const f = cardById(id);
  if (!f) return;
  const show = () => {
    const r = hostRect(id);
    if (!r) return;
    ensureVisible(r);
    if (doPing) ping(f.host.id);
  };
  if (unhide(id)) requestAnimationFrame(show); else show();
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
/** 适应窗口：只框看得见的（折叠的调用子树里的卡不算，折叠的 Section 只算它的标题条） */
export function fitAll() {
  const rs = [...visibleCards().map((c) => rectOf(c)), ...frames().values()];
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

// ---------- 打开 ----------

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
  const el = document.querySelector(`.card[data-id="${hostOf(id)}"] .rev`) ?? undefined;
  const pid = openPop({ kind: "diff", card: id, seg: s.id }, el ? { el, prefer: "below" } : lastPointer());
  ask("diff", { seg: structuredClone(unwrap(s)), against: "worktree" })
    .then((data) => updatePop(pid, (p) => (p.kind === "diff" ? { ...p, data } : p)))
    .catch((e) => updatePop(pid, (p) => (p.kind === "diff" ? { ...p, error: (e as Error).message } : p)));
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
