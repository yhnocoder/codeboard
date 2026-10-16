// 公用：快捷键符号、选择、锁、镜头、新卡弹出动画、指针位置、打开编辑器 / 链接。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards, colsOf,
  placeChild, besideFree, findFree, tidy, bounds, center, contains, canAttach, canExpand, canCompare, removeCards, rebaseSegment, walkOrder, treeOf, descendants, SIB_GAP, GAP,
  copyText, cardRows, versionLabel, varKey, LANGS, classifyPaste, guessLang, estSize, defaultWidth,
  type Board, type Card, type CodeCard, type NoteCard, type CompareCard, type Link, type Section, type Sidenote, type Segment, type Place,
  type WebMeta, type CallSpan, type NewCard, type ExpandResult, type Var, type Rect, type DiffData, type Commit, type SegView, type Anchor, type PeekResult, type KeyAction,
} from "@codeboard/core";
import {
  state, setState, mutate, live, createFresh, isFresh, settleFresh, sel, select, clearSel, lineSel, setLineSel, isSel, flows, cardById, rectOf, sizes, toast, allIds, setShowCollapsed, placeOf, placed,
  type LineSel,
} from "../state/store";
import { camTo, camTarget, ensureVisible, fitRect, fitTop, isVisible, union, viewportCenter, view, toWorld, zoomAt, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, flash, ping, setEditing, setPopIn, popIn, setWalk, walk, setConnectFrom, setPaletteOpen, toggleShown, setKeysOpen, setHoverVar } from "../state/ui";
import { openMenu, choose, promptText, type Item } from "../ui/Menu";
import { openPop, closePop, pops, updatePop, pinPop, type At } from "../state/pop";
import { send, ask } from "../host";
import { md, inline } from "../md";
import { frameOf } from "../state/sections";

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

export const mdInline = (s: string) => inline(s);
export const mdBlock = (s: string) => md(s);
export const sidenotesOf = notesOf;
export const hostRect = (id: string) => { const f = cardById(id); return f ? rectOf(f.host) : null; };
export const allRects = (skip?: Set<string>) => placed().filter((c) => !skip?.has(c.id)).map((c) => rectOf(c));

export function sectionOf(id: string): Section | undefined {
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
    if (performance.now() - start < (reduceMotion() ? 0 : 90)) return false;
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

/** 一行在世界坐标里的左端点（Call link 出发处） */
export function anchorPoint(cardId: string, seg?: string, line?: number) {
  const el = document.querySelector(`.card[data-id="${cardById(cardId)?.host.id}"]`);
  const r = hostRect(cardId);
  if (!el || !r) return null;
  return { x: r.x, y: r.y + 20 };
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

