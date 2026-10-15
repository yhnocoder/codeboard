// 白板上的操作：建卡、展开调用、菜单、合并 / 拆开、Compare、Section、版本、Sidenote、讲解。
// 拖动类的交互在 interact.ts。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards,
  placeChild, besideFree, findFree, tidy, bounds, center, contains, canAttach, canCompare, walkOrder, treeOf, descendants,
  copyText, cardRows, versionLabel, varKey,
  type Board, type Card, type CodeCard, type NoteCard, type CompareCard, type Link, type Section, type Sidenote, type Segment,
  type CallSpan, type NewCard, type ExpandResult, type Var, type Rect, type DiffData, type Commit, type SegView, type Anchor,
} from "@codeboard/core";
import {
  state, setState, mutate, sel, select, clearSel, lineSel, setLineSel, isSel, flows, cardById, rectOf, sizes, toast, allIds,
  type LineSel,
} from "./state/store";
import { camTo, camTarget, ensureVisible, fitRect, fitTop, isVisible, union, viewportCenter, view, toWorld, zoomAt, animate, Spring, reduceMotion } from "./state/camera";
import { flash, ping, setEditing, setPopIn, popIn, setWalk, walk, setConnectFrom, setPaletteOpen, toggleShown, setKeysOpen, setHoverVar } from "./state/ui";
import { openMenu, choose, promptText, type Item } from "./ui/Menu";
import { openPop, closePop, pops, updatePop, pinPop, type At } from "./state/pop";
import { send, ask } from "./host";
import { md, inline } from "./md";
import { frameOf } from "./state/sections";

export * from "./interact";

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
  select({ cards: state.board.cards.filter((c) => !isLocked(c.id)).map((c) => c.id) });
}
export const selCards = () => sel.cards.map((id) => cardById(id)?.card).filter(Boolean) as Card[];

// ---------- 小工具 ----------

export const mdInline = (s: string) => inline(s);
export const mdBlock = (s: string) => md(s);
export const sidenotesOf = (cardId: string) => state.board.sidenotes.filter((n) => n.at.card === cardId);
export const hostRect = (id: string) => { const f = cardById(id); return f ? rectOf(f.host) : null; };
export const allRects = (skip?: Set<string>) => state.board.cards.filter((c) => !skip?.has(c.id)).map((c) => rectOf(c));
export const estSize = (c: Card) => ({ w: c.w, h: c.h ?? (c.kind === "code" ? Math.min(520, 52 + c.segments.reduce((n, s) => n + s.end - s.start + 1, 0) * 19) : 160) });

export function sectionOf(id: string): Section | undefined {
  const f = cardById(id);
  const sid = f?.host.section;
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
  return !!f.host.locked || sectionLocked(sectionOf(f.host.id));
}

// ---------- 镜头 ----------

export function revealCard(id: string, doPing = true) {
  const r = hostRect(id);
  if (!r) return;
  ensureVisible(r);
  if (doPing) ping(cardById(id)!.host.id);
}
export function fitAll() {
  const rs = [...state.board.cards.map((c) => rectOf(c)), ...state.board.sections.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))];
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

// ---------- 新卡 ----------

/** 新卡弹出来：从 from 点（世界坐标）放大淡入。透明度只增不减。 */
export function popCard(id: string, from?: { x: number; y: number }) {
  const c = cardById(id)?.host;
  if (!c) return;
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

/** 把宿主建好的卡放到白板上：有选中的卡就放旁边，没有就放视口中央 */
export function addCards(list: NewCard[], o: { at?: { x: number; y: number }; besideSel?: boolean } = {}) {
  if (!list.length) return [];
  setState("views", (v) => ({ ...v, ...Object.assign({}, ...list.map((n) => n.views)) }));
  const ids: string[] = [];
  const anchor = o.besideSel !== false && sel.cards.length ? hostRect(sel.cards[sel.cards.length - 1]) : null;
  mutate((b) => {
    let prev: Rect | null = anchor;
    for (const n of list) {
      const c = structuredClone(n.card) as Card;
      const size = estSize(c);
      let p: { x: number; y: number };
      const others = b.cards.map((k) => rectOf(k));
      if (o.at) p = findFree({ ...o.at, ...size }, others);
      else if (prev) p = besideFree(prev, size, others);
      else { const vc = viewportCenter(); p = findFree({ x: vc.x - size.w / 2, y: vc.y - Math.min(size.h, 300) / 2, ...size }, others); }
      c.x = Math.round(p.x); c.y = Math.round(p.y);
      b.cards.push(c);
      ids.push(c.id);
      prev = { x: c.x, y: c.y, ...size };
    }
  });
  select({ cards: ids });
  requestAnimationFrame(() => {
    const rs = ids.map((id) => hostRect(id)!).filter(Boolean);
    const u = bounds(rs);
    if (u && !isVisible(u)) { const f = fitTop(u, camTarget().z); camTo(f.x, f.y, f.z); }
    ids.forEach((id) => popCard(id));
  });
  return ids;
}

export function newNote(at?: { x: number; y: number }, bg = true, text = "") {
  const p = at ?? (() => { const v = viewportCenter(); return { x: v.x - 140, y: v.y - 40 }; })();
  const id = uid("n");
  mutate((b) => { b.cards.push({ id, kind: "note", md: text, bg, x: Math.round(p.x), y: Math.round(p.y), w: bg ? 280 : 320, size: "body" }); });
  select({ cards: [id] });
  if (!text) setEditing({ kind: "note", id });
  popCard(id);
  return id;
}
export async function newImage(at?: { x: number; y: number }) {
  const dataUrl = await ask<string | null>("pickFile", { kind: "image" }).catch(() => null);
  if (!dataUrl) return;
  return addImage(dataUrl, "image.png", at);
}
export async function addImage(dataUrl: string, name: string, at?: { x: number; y: number }) {
  const file = await ask<string>("saveAsset", { name, dataUrl }).catch(() => null);
  const src = file ?? dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  const w = Math.min(480, Math.max(160, img.naturalWidth || 320));
  const id = uid("i");
  addCards([{ card: { id, kind: "image", src, x: 0, y: 0, w }, views: {} }], { at });
  return id;
}
export async function newWeb(at?: { x: number; y: number }, url?: string) {
  url = url ?? (await promptText("Add Web Link", "", "https://…", "Add")) ?? undefined;
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  const id = uid("w");
  addCards([{ card: { id, kind: "web", url, x: 0, y: 0, w: 300 }, views: {} }], { at });
}
export function newFreeCode(at?: { x: number; y: number }, text = "", lang = "python", url?: string) {
  const sid = uid("s");
  const seg: Segment = { id: sid, src: { kind: "free", url }, path: "", lang, start: 1, end: Math.max(1, text.split("\n").length), text: text ? text.split("\n") : [""], version: { kind: "none" } };
  const id = uid("c");
  const ids = addCards([{ card: { id, kind: "code", segments: [seg], x: 0, y: 0, w: 480 }, views: {} }], { at });
  requestViews([seg]);
  if (!text) setEditing({ kind: "free", id });
  return ids[0];
}

/** 白板自己生成的段（合并、Free code 改动）找宿主要高亮 */
export async function requestViews(segs: Segment[]) {
  if (!segs.length) return;
  const v = await ask<Record<string, SegView>>("views", { segs: unwrap(segs).map((s) => structuredClone(unwrap(s))) }).catch(() => null);
  if (v) setState("views", (o) => ({ ...o, ...v }));
}

// ---------- 点调用展开 ----------

const pending = new Set<string>();

/**
 * 点调用 = 新建一张卡（永远新建，不复用已有的），连一条 Call link。
 * at：拖出来松在画布上时的位置。
 */
export async function expandCall(cardId: string, segId: string, call: CallSpan, at?: { x: number; y: number }, pick?: { path: string; line: number }) {
  const f = cardById(cardId);
  if (!f || !isCode(f.card)) return;
  const seg = segOf(f.card, segId);
  if (!seg) return;
  const key = `${cardId}:${segId}:${call.line}:${call.col}`;
  if (pending.has(key)) return;
  if (call.dispatch) { toast(`${call.name}("${call.dispatch}") is dispatched by name. Not resolved; drag the call onto a card to link it.`); return; }
  pending.add(key);
  let r: ExpandResult;
  try {
    r = await ask<ExpandResult>("expand", { seg: structuredClone(unwrap(seg)), line: call.line, col: call.col, name: call.name, recv: call.recv, pick });
  } catch (e) {
    toast(`Could not expand ${call.name}(): ${(e as Error).message}`);
    return;
  } finally { pending.delete(key); }
  if ("none" in r) { toast(r.reason || `No definition found for ${call.name}()`); return; }
  if ("pick" in r) {
    showPicker(`${call.name}() · ${r.pick.length} definitions`, r.pick.map((p) => ({ label: p.label, detail: p.detail, run: () => expandCall(cardId, segId, call, at, { path: p.path, line: p.line }) })));
    return;
  }
  placeExpanded(cardId, segId, call, r.card, r.views, r.vars, at);
}

function placeExpanded(cardId: string, segId: string, call: CallSpan, card: CodeCard, views: Record<string, SegView>, vars: Var[], at?: { x: number; y: number }) {
  setState("views", (v) => ({ ...v, ...views }));
  const host = cardById(cardId)!.host;
  const id = card.id;
  const size = estSize(card);
  mutate((b) => {
    const nc = structuredClone(card) as CodeCard;
    if (at) { nc.x = Math.round(at.x); nc.y = Math.round(at.y); }
    else {
      const node = flows().byId.get(cardId);
      // 出发行在它前面的兄弟（及其子树）：新卡放在它们下面
      const before: Rect[] = [];
      for (const k of node?.kids ?? []) {
        const kl = k.link!;
        const kseg = kl.from.seg === segId ? 0 : 1;
        if (kseg === 0 && (kl.from.line ?? 0) > call.line) continue;
        for (const d of [k.id, ...descendants(k)]) { const r = hostRect(d); if (r) before.push(r); }
      }
      const p = placeChild(rectOf(host), size, before, b.cards.map((k) => rectOf(k)));
      nc.x = Math.round(p.x); nc.y = Math.round(p.y);
    }
    const sec = host.section;
    if (sec) nc.section = sec;
    const hc = findCard(b, host.id)!.host;
    if (hc.collapsed) hc.collapsed = false;
    b.cards.push(nc);
    b.links.push({ id: uid("l"), kind: "call", from: { card: cardId, seg: segId, line: call.line }, to: { card: id }, call: { name: call.name, col: call.col }, loop: call.loop || undefined, cands: vars.length ? vars : undefined });
  });
  select({ cards: [id] });
  flash(cardId, segId, [call.line]);
  requestAnimationFrame(() => {
    const r = hostRect(id)!;
    if (!isVisible(r)) {
      const p = rectOf(host);
      const pr = { x: p.x, y: Math.max(p.y, r.y - 260), w: p.w, h: 60 };
      const u = union(pr, { ...r, h: Math.min(r.h, 420) });
      const f = fitRect(u, camTarget().z);
      camTo(f.x, f.y, f.z);
    }
    const from = anchorPoint(cardId, segId, call.line);
    popCard(id, from ?? undefined);
  });
}

/** 一行在世界坐标里的左端点（Call link 出发处） */
export function anchorPoint(cardId: string, seg?: string, line?: number) {
  const el = document.querySelector(`.card[data-id="${cardById(cardId)?.host.id}"]`);
  const r = hostRect(cardId);
  if (!el || !r) return null;
  return { x: r.x, y: r.y + 20 };
}

/** 把调用接到白板上已有的卡（拖过去，或右键 Link to Existing Card…） */
export function attachCall(cardId: string, segId: string, call: CallSpan, target: string) {
  const t = cardById(target);
  if (!t || !isCode(t.card)) return toast("Only code cards can be the target of a Call link.");
  if (t.host.id === cardById(cardId)?.host.id) return toast("A card cannot call itself.");
  const ok = canAttach(flows(), cardId, target);
  if (!ok.ok) return toast(ok.reason);
  mutate((b) => { b.links.push({ id: uid("l"), kind: "call", from: { card: cardId, seg: segId, line: call.line }, to: { card: target }, call: { name: call.name, col: call.col }, loop: call.loop || undefined }); });
  toast(`Linked to ${cardTitle(t.card)}`);
  ping(t.host.id);
}

/** 这张卡是不是这个调用的被调函数（拖动时高亮候选） */
export function calleeMatches(c: Card, call: CallSpan) {
  if (!isCode(c)) return false;
  return c.segments.some((s) => s.symbol && s.symbol.qual.split(".").pop() === call.name);
}

export const allCodeCandidates = (call: CallSpan) => allCodeCards(state.board).filter((k) => calleeMatches(k, call)).map((k) => k.id);

export function showPicker(title: string, items: { label: string; detail: string; run: () => void }[]) {
  const p = lastPointer();
  openPop({ kind: "pick", title, items }, { x: p.x, y: p.y + 12 });
}

let lastPtr = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
window.addEventListener("pointerdown", (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
export const lastPointer = () => lastPtr;

export function callMenu(cardId: string, segId: string, call: CallSpan, x: number, y: number) {
  selectCard(cardId);
  const f = cardById(cardId)!;
  const cands = allCodeCards(state.board).filter((k) => k.id !== cardId && calleeMatches(k, call));
  const items: Item[] = [
    { label: "Expand", kbd: "Click", run: () => expandCall(cardId, segId, call) },
    {
      label: "Link to Existing Card", kbd: "Drag", sub: cands.length ? cands.map((k) => {
        const n = flows().byId.get(k.id);
        const ok = canAttach(flows(), cardId, k.id);
        return { label: `${n ? n.label + "  " : ""}${cardTitle(k)}`, disabled: ok.ok ? false : ok.reason, run: () => attachCall(cardId, segId, call, k.id) };
      }) : [{ label: "No card for this function on the board", disabled: "Drag the call onto any code card to link it" }],
    },
    null,
    ...lineItems({ card: f.card.id, seg: segId, start: call.line, end: call.line }),
  ];
  openMenu(items, x, y);
}

// ---------- 行 ----------

function lineItems(ls: LineSel): Item[] {
  const f = cardById(ls.card);
  if (!f || !isCode(f.card)) return [];
  const s = segOf(f.card, ls.seg)!;
  const n = ls.end - ls.start + 1;
  const hlAll = Array.from({ length: n }, (_, i) => ls.start + i).every((l) => s.hl?.includes(l));
  return [
    { label: "Hide Lines", kbd: "H", run: () => hideLines(ls) },
    { label: hlAll ? "Remove Highlight" : "Highlight Lines", run: () => toggleHl(ls) },
    { label: "Add Sidenote", kbd: "S", run: () => openAddNote({ card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] }) },
    { label: "Copy", kbd: `${K.mod}C`, run: () => copyLines(ls) },
  ];
}
export function lineMenu(ls: LineSel, x: number, y: number) {
  selectCard(ls.card);
  openMenu(lineItems(ls), x, y);
}
export function copyLines(ls: LineSel) {
  const f = cardById(ls.card);
  if (!f || !isCode(f.card)) return;
  const s = segOf(f.card, ls.seg)!;
  const t = copyText(s.text.slice(ls.start - s.start, ls.end - s.start + 1));
  navigator.clipboard?.writeText(t).catch(() => {});
  toast(`Copied ${ls.end - ls.start + 1} line${ls.end > ls.start ? "s" : ""}`);
}
export function hideLines(ls: LineSel) {
  mutate((b) => {
    const c = findCard(b, ls.card)?.card;
    if (!isCode(c)) return;
    const s = segOf(c, ls.seg)!;
    let r: [number, number] = [ls.start, ls.end];
    const keep = (s.hidden ?? []).filter((h) => {
      if (h[1] < r[0] - 1 || h[0] > r[1] + 1) return true;
      r = [Math.min(h[0], r[0]), Math.max(h[1], r[1])];
      return false;
    });
    s.hidden = [...keep, r].sort((a, c2) => a[0] - c2[0]);
  });
  window.getSelection()?.removeAllRanges();
  setLineSel(null);
}
export function toggleHl(ls: LineSel) {
  mutate((b) => {
    const c = findCard(b, ls.card)?.card;
    if (!isCode(c)) return;
    const s = segOf(c, ls.seg)!;
    const ln = Array.from({ length: ls.end - ls.start + 1 }, (_, i) => ls.start + i);
    const all = ln.every((l) => s.hl?.includes(l));
    s.hl = all ? (s.hl ?? []).filter((l) => l < ls.start || l > ls.end) : [...new Set([...(s.hl ?? []), ...ln])];
  });
}

// ---------- 卡片菜单 ----------

export function cardMenu(id: string, x: number, y: number) {
  const f = cardById(id);
  if (!f) return;
  if (!isSel(f.host.id)) selectCard(id);
  if (sel.cards.length + sel.sections.length > 1) return openMenu(multiItems(), x, y);
  const c = f.card;
  const host = f.host;
  const lockItem: Item = { label: host.locked ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock([host.id]) };
  const common: Item[] = [
    { label: "Connect…", run: () => startConnect(c.id) },
    { label: "Move to New Section", run: () => moveToNewSection() },
    lockItem,
  ];
  if (c.kind === "note") return openMenu([
    { label: "Edit", kbd: "Double-click", run: () => setEditing({ kind: "note", id }) },
    { label: c.bg ? "Hide Background" : "Show Background", run: () => mutate((b) => { const n = findCard(b, id)!.card as NoteCard; n.bg = !n.bg; if (n.bg) n.w = Math.max(n.w, 260); }) },
    null, ...common, null,
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ], x, y);
  if (c.kind === "image" || c.kind === "web") return openMenu([
    ...(c.kind === "web" ? [{ label: "Open in Browser", run: () => openLink(c.url) } as Item] : []),
    { label: "Rename", kbd: "Double-click Title", run: () => setEditing({ kind: "title", id }) },
    { label: "Edit Description", run: () => setEditing({ kind: "desc", id }) },
    null, ...common, null,
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ], x, y);
  if (c.kind === "compare") {
    const inFlow = c.cols.some((k) => flows().byId.has(k.id));
    return openMenu([
      { label: "Swap", run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.swap = !k.swap; }) },
      { label: "Unified", checked: !!c.unified, run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.unified = !k.unified; }) },
      { label: "Hide Same Lines", checked: !!c.hideSame, run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.hideSame = !k.hideSame; }) },
      null,
      { label: "Separate", run: () => separate(id) },
      { label: "Walk Through Flow", kbd: "P", disabled: inFlow ? false : "Not in a call flow", run: () => startWalk(c.cols.find((k) => flows().byId.has(k.id))!.id) },
      { label: "Move to New Section", run: () => moveToNewSection() },
      lockItem, null,
      { label: "Delete", kbd: "⌫", run: deleteSel },
    ], x, y);
  }
  // 代码卡（也可能是 Compare 里的一栏）
  const col = f.host.id !== c.id;
  const node = flows().byId.get(c.id);
  const hasKids = !!node?.kids.length;
  const ls = lineSel();
  const free = c.segments[0]?.src.kind === "free";
  const anyHidden = c.segments.some((s) => s.hidden?.length);
  const items: Item[] = [
    ...(free ? [] : [{ label: "Open in Editor", kbd: "↵", run: () => openCode(c.id) } as Item]),
    { label: "Rename", kbd: "Double-click Title", run: () => setEditing({ kind: "title", id: c.id }) },
    { label: "Edit Description", run: () => setEditing({ kind: "desc", id: c.id }) },
    { label: "Add Sidenote", kbd: "S", disabled: ls?.card === c.id ? false : "Select lines in the card first", run: () => openAddNote({ card: ls!.card, seg: ls!.seg, lines: [ls!.start, ls!.end] }) },
    { label: "Add Sidenote to Card", run: () => openAddNote({ card: c.id }) },
    null,
    { label: "Hide Comments", checked: !!c.hide?.comments, run: () => toggleHide(c.id, "comments") },
    { label: "Hide Docstrings", checked: !!c.hide?.docstrings, run: () => toggleHide(c.id, "docstrings") },
    { label: "Hide Blank Lines", checked: !!c.hide?.blank, run: () => toggleHide(c.id, "blank") },
    { label: "Show All Hidden Lines", disabled: !anyHidden, run: () => mutate((b) => { const k = findCard(b, c.id)!.card as CodeCard; k.segments.forEach((s) => (s.hidden = undefined)); }) },
    { label: "Wrap Lines", kbd: `${K.alt}Z`, checked: !!c.wrap, run: () => toggleWrap([c.id]) },
    null,
    { label: "Walk Through Flow", kbd: "P", disabled: node ? false : "Not in a call flow", run: () => startWalk(c.id) },
    ...(node ? [{ label: "Tidy Layout", hint: "Rearranges this flow only", run: () => tidyFlow(c.id) } as Item] : []),
    ...(hasKids ? [{ label: c.collapsed ? "Expand Subtree" : "Collapse Subtree", run: () => toggleCollapse(c.id) } as Item] : []),
    null,
    ...(c.segments.length > 1 || c.mergedFrom ? [{ label: "Unmerge", run: () => unmerge(c.id) } as Item] : []),
    ...(col ? [] : common),
    null,
    { label: "Copy Code", run: () => copyCard(c) },
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ];
  openMenu(items, x, y);
}

function multiItems(): Item[] {
  const cs = selCards();
  const codes = cs.filter((c) => c.kind === "code") as CodeCard[];
  const mc = mergeCheck(cs);
  const cmp = compareCheck();
  const lockAll = cs.every((c) => c.locked) && sel.sections.every((s) => sectionById(s)?.locked);
  return [
    ...(cs.length === 2 && codes.length === 2 ? [{ label: "Compare", disabled: cmp.ok ? false : cmp.why, run: doCompare } as Item] : []),
    ...(codes.length >= 2 ? [{ label: "Merge into One Card", disabled: mc.ok ? false : mc.why, run: () => mergeCards(sel.cards) } as Item] : []),
    { label: "Connect with Plain Link", disabled: cs.length === 2 ? false : "Select exactly two cards", run: () => { const [a, b] = cs; addPlain({ card: a.id }, { card: b.id }); } },
    { label: "Move to New Section", run: () => moveToNewSection() },
    { label: lockAll ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock(sel.cards, sel.sections) },
    null,
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ];
}

export function canvasMenu(x: number, y: number) {
  const w = toWorld(x - boardOffset().x, y - boardOffset().y);
  openMenu([
    { label: "New Text", kbd: "T", run: () => newNote(w, false) },
    { label: "New Note", kbd: "N", run: () => newNote(w, true) },
    { label: "New Free Code", run: () => newFreeCode(w) },
    { label: "Add Function…", kbd: `${K.mod}K`, run: () => setPaletteOpen({ mode: "code" }) },
    { label: "Paste", kbd: `${K.mod}V`, run: () => navigator.clipboard?.readText().then((t) => pasteText(t, w)).catch(() => toast("Clipboard not available here. Press ⌘V instead.")) },
    null,
    { label: "Select All", kbd: `${K.mod}A`, run: selectAll },
    { label: "Fit to Window", kbd: `${K.shift}1`, run: fitAll },
    null,
    { label: "Hide All Comments", checked: !!state.board.hideAllComments, run: () => mutate((b) => { b.hideAllComments = !b.hideAllComments; }) },
    { label: "Hide Flow Numbers", checked: !!state.board.hideNumbers, run: () => mutate((b) => { b.hideNumbers = !b.hideNumbers; }) },
  ], x, y);
}
export const boardOffset = () => { const r = document.getElementById("board")?.getBoundingClientRect(); return { x: r?.left ?? 0, y: r?.top ?? 0 }; };

export function linkMenu(id: string, x: number, y: number) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L) return;
  select({ links: [id] });
  const set = (f: (l: Link) => void) => mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) f(l); });
  const edit: Item = { label: L.label ? "Edit Label" : "Add Label", kbd: "Double-click", run: () => setEditing({ kind: "label", id }) };
  const del: Item = { label: "Delete Link", kbd: "⌫", run: () => deleteLinks([id]) };
  if (L.kind === "call") return openMenu([edit, { label: "Add Variables…", run: () => openVars(id) }, { label: "Convert to Plain Link", run: () => set((l) => { l.kind = "plain"; }) }, null, del], x, y);
  openMenu([
    edit,
    { label: "Arrow", sub: ([["none", "None"], ["end", "One-way  →"], ["both", "Both  ↔"]] as const).map(([v, lb]) => ({ label: lb, checked: (L.arrow ?? "none") === v, run: () => set((l) => { l.arrow = v; }) })) },
    { label: "Style", sub: [{ label: "Dashed", checked: !L.solid, run: () => set((l) => { l.solid = false; }) }, { label: "Solid", checked: !!L.solid, run: () => set((l) => { l.solid = true; }) }] },
    { label: "Color", sub: LINK_COLORS.map(([v, lb]) => ({ label: lb, checked: (L.color ?? "grey") === v, run: () => set((l) => { l.color = v === "grey" ? undefined : v; }) })) },
    null, del,
  ], x, y);
}
export const LINK_COLORS = [["grey", "Grey"], ["orange", "Orange"], ["blue", "Blue"], ["green", "Green"]] as const;
export const SECTION_COLORS = [["none", "None"], ["sand", "Warm Sand"], ["blue", "Light Blue"], ["green", "Light Green"], ["pink", "Light Pink"]] as const;

export function sectionMenu(id: string, x: number, y: number) {
  const s = sectionById(id);
  if (!s) return;
  if (!sel.sections.includes(id)) select({ sections: [id] });
  const set = (f: (q: Section) => void) => mutate((b) => { const q = b.sections.find((k) => k.id === id); if (q) f(q); });
  openMenu([
    { label: "Rename", kbd: "Double-click", run: () => setEditing({ kind: "section", id }) },
    { label: s.collapsed ? "Expand" : "Collapse", run: () => toggleSection(id) },
    { label: s.locked ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock([], [id]) },
    ...(s.parent ? [{ label: "Move Out of Parent Section", run: () => set((q) => { q.parent = sectionById(q.parent)?.parent; }) } as Item] : []),
    { label: "Color", sub: SECTION_COLORS.map(([v, lb]) => ({ label: lb, checked: (s.color ?? "none") === v, run: () => set((q) => { q.color = v === "none" ? undefined : v; }) })) },
    null,
    { label: "Remove Section", hint: "Cards and inner sections stay", run: () => removeSections([id]) },
  ], x, y);
}

// ---------- 删除 / 复制 ----------

export function deleteSel() {
  const ids = new Set<string>();
  for (const id of sel.cards) { const f = cardById(id); if (!f) continue; ids.add(f.host.id); if (f.host.kind === "compare") f.host.cols.forEach((k) => ids.add(k.id)); }
  const links = new Set(sel.links);
  const secs = new Set(sel.sections);
  if (!ids.size && !links.size && !secs.size) return;
  clearSel();
  mutate((b) => {
    b.cards = b.cards.filter((c) => !ids.has(c.id));
    b.links = b.links.filter((l) => !links.has(l.id) && !ids.has(l.from.card) && !ids.has(l.to.card));
    b.sidenotes = b.sidenotes.filter((n) => !ids.has(n.at.card) && !(n.kind === "card" && ids.has(n.card)));
    if (secs.size) dropSections(b, secs);
  });
}
export function deleteLinks(ids: string[]) {
  const s = new Set(ids);
  mutate((b) => { b.links = b.links.filter((l) => !s.has(l.id)); });
  select({});
}
function dropSections(b: Board, secs: Set<string>) {
  for (const s of b.sections) if (secs.has(s.id)) {
    for (const ch of b.sections) if (ch.parent === s.id && !secs.has(ch.id)) ch.parent = s.parent;
    for (const c of b.cards) if (c.section === s.id) c.section = s.parent;
  }
  b.sections = b.sections.filter((s) => !secs.has(s.id));
}
export function removeSections(ids: string[]) { mutate((b) => dropSections(b, new Set(ids))); select({}); }

export function duplicateSel() {
  const cs = selCards().filter((c) => c.kind !== "compare");
  if (!cs.length) return toast("Select a card to duplicate");
  const made: string[] = [];
  mutate((b) => {
    for (const c of cs) {
      const d = structuredClone(unwrap(c)) as Card;
      d.id = uid(d.kind[0]);
      d.x += 48; d.y += 48;
      d.collapsed = undefined;
      if (d.kind === "code") d.segments.forEach((s) => (s.id = uid("s")));
      b.cards.push(d);
      made.push(d.id);
      // 各段的展示数据跟着复制
      if (c.kind === "code" && d.kind === "code") c.segments.forEach((s, i) => { const v = state.views[s.id]; if (v) setState("views", d.segments[i].id, v); });
    }
  });
  select({ cards: made });
  made.forEach((id) => popCard(id));
  toast(made.length > 1 ? `Duplicated ${made.length} cards (no links, no number)` : "Duplicated. The copy has no links and no number.");
}
export function copyCard(c: CodeCard) {
  const rows = cardRows(c, { views: state.views, hideAllComments: state.board.hideAllComments });
  const lines: string[] = [];
  for (const r of rows) if (r.t === "line") { const s = c.segments.find((q) => q.id === r.seg)!; lines.push(s.text[r.line - s.start] ?? ""); }
  navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
  toast(`Copied ${lines.length} lines`);
}

// ---------- 卡片属性 ----------

export const compareTitle = (c: CompareCard) => cardTitle(c);
export function renameCard(id: string, v: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c) c.title = v.trim() && v.trim() !== cardTitle({ ...c, title: undefined } as Card) ? v.trim() : undefined; });
}
export function setDesc(id: string, v: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c) c.desc = v.trim() || undefined; });
}
export function setNoteText(id: string, v: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c?.kind === "note") c.md = v; });
  const c = cardById(id)?.card;
  if (c?.kind === "note" && !c.md.trim()) mutate((b) => { b.cards = b.cards.filter((k) => k.id !== id); b.links = b.links.filter((l) => l.from.card !== id && l.to.card !== id); });
}
export function setFreeCode(id: string, text: string) {
  let seg: Segment | undefined;
  mutate((b) => {
    const c = findCard(b, id)?.card;
    if (!isCode(c)) return;
    const s = c.segments[0];
    s.text = text.split("\n");
    s.end = s.start + s.text.length - 1;
    seg = structuredClone(unwrap(s));
  });
  if (seg) requestViews([seg]);
}
export function setLang(id: string, lang: string) {
  let seg: Segment | undefined;
  mutate((b) => { const c = findCard(b, id)?.card; if (isCode(c)) { c.segments[0].lang = lang; seg = structuredClone(unwrap(c.segments[0])); } });
  if (seg) requestViews([seg]);
}
export function langMenu(id: string, el: Element) {
  const r = el.getBoundingClientRect();
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  import("@codeboard/core").then(({ LANGS }) => openMenu(LANGS.map((l) => ({ label: l.label, checked: c.segments[0].lang === l.id, run: () => setLang(id, l.id) })), r.left, r.bottom + 4));
}
export function toggleHide(id: string, k: "comments" | "docstrings" | "blank") {
  mutate((b) => { const c = findCard(b, id)?.card; if (isCode(c)) c.hide = { ...c.hide, [k]: !c.hide?.[k] }; });
}
export function toggleWrap(ids: string[]) {
  const cs = ids.map((i) => cardById(i)?.card).filter(isCode);
  if (!cs.length) return;
  const on = !cs.every((c) => c.wrap);
  mutate((b) => { for (const c of cs) { const k = findCard(b, c.id)?.card; if (isCode(k)) k.wrap = on || undefined; } });
}
export function toggleCollapse(id: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c) c.collapsed = !c.collapsed || undefined; });
}
export function toggleLock(cards: string[], sections: string[] = []) {
  const cs = cards.map((i) => cardById(i)?.host).filter(Boolean) as Card[];
  const ss = sections.map(sectionById).filter(Boolean) as Section[];
  if (!cs.length && !ss.length) return;
  const on = !(cs.every((c) => c.locked) && ss.every((s) => s.locked));
  mutate((b) => {
    for (const c of cs) { const k = findCard(b, c.id)?.host; if (k) k.locked = on || undefined; }
    for (const s of ss) { const k = b.sections.find((q) => q.id === s.id); if (k) k.locked = on || undefined; }
  });
  toast(on ? "Locked. It stays put; code inside still works." : "Unlocked");
}
export function missingNote(c: CodeCard): string | null {
  const st = c.segments.map((s) => state.stale[s.id]?.state);
  if (st.includes("missing")) return state.host.readonly ?? "Repository not found. Showing the saved snapshot (read-only).";
  if (st.includes("lost")) return "Symbol not found in the current code (deleted or renamed). Showing the saved version.";
  if (st.includes("many")) return "This snippet now appears in several places. Showing the saved version.";
  return null;
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

// ---------- 流程 ----------

export function tidyFlow(id: string) {
  const root = treeOf(flows(), id);
  if (!root) return;
  const r = hostRect(root.id)!;
  const pos = tidy(root, (cid) => { const h = hostRect(cid); return { w: h?.w ?? 400, h: h?.h ?? 200 }; }, { x: r.x, y: r.y });
  const from = new Map([...pos.keys()].map((k) => [k, { ...hostRect(k)! }]));
  mutate((b) => { for (const [cid, p] of pos) { const c = findCard(b, cid)?.host; if (c) { c.x = Math.round(p.x); c.y = Math.round(p.y); } } });
  // 平滑过去
  if (reduceMotion()) return;
  const sp = new Spring(0, 170, 26, 0.002); sp.t = 1;
  setPopIn((p) => { const n = { ...p }; for (const [cid] of pos) { const a = from.get(cid)!, c = cardById(cid)!.host; n[cid] = { ox: a.x - c.x, oy: a.y - c.y, v: 0, slide: true } as any; } return n; });
  animate((dt) => {
    sp.step(dt);
    const done = sp.done;
    setPopIn((p) => { const n = { ...p }; for (const [cid] of pos) { if (done) delete n[cid]; else n[cid] = { ...(n[cid] as any), v: sp.v }; } return n; });
    return done;
  });
}

// ---------- Compare ----------

export function compareCheck(): { ok: true } | { ok: false; why: string } {
  const cs = selCards();
  if (cs.length !== 2 || !cs.every((c) => c.kind === "code")) return { ok: false, why: "Select exactly two code cards" };
  const r = canCompare(flows(), cs[0].id, cs[1].id);
  return r.ok ? { ok: true } : { ok: false, why: r.reason };
}
export function doCompare() {
  const chk = compareCheck();
  if (!chk.ok) return toast(chk.why);
  const [p, q] = (selCards() as CodeCard[]).sort((a, b) => a.x - b.x);
  const id = uid("k");
  mutate((b) => {
    const a = findCard(b, p.id)!.card as CodeCard, c = findCard(b, q.id)!.card as CodeCard;
    const k: CompareCard = { id, kind: "compare", cols: [structuredClone(unwrap(a)), structuredClone(unwrap(c))], x: a.x, y: a.y, w: Math.min(1280, Math.max(760, a.w + c.w)), section: a.section ?? c.section };
    b.cards = b.cards.filter((x) => x.id !== a.id && x.id !== c.id);
    b.cards.push(k);
  });
  select({ cards: [id] });
  requestAnimationFrame(() => revealCard(id));
}
export function separate(id: string) {
  const k = cardById(id)?.card;
  if (k?.kind !== "compare") return;
  const ids = k.cols.map((c) => c.id);
  mutate((b) => {
    const kk = findCard(b, id)!.card as CompareCard;
    const [a, c] = structuredClone(unwrap(kk.cols));
    // 拆回：左栏在原位，右栏放在它右边
    a.x = kk.x; a.y = kk.y; c.x = kk.x + a.w + 40; c.y = kk.y;
    a.section = c.section = kk.section;
    b.cards = b.cards.filter((x) => x.id !== id);
    b.cards.push(a, c);
  });
  select({ cards: ids });
}

// ---------- 合并 / 拆开 ----------

const mergeable = (c?: Card) => isCode(c) && !(c.segments.length === 1 && c.segments[0].src.kind === "free" && false);
export function mergeCheck(cs: Card[]): { ok: true } | { ok: false; why: string } {
  if (cs.length < 2) return { ok: false, why: "Select two or more code cards" };
  if (!cs.every((c) => c.kind === "code" && !c.members)) return { ok: false, why: "Only code cards can be merged (not Note, Image, Web, Compare or class cards)" };
  return { ok: true };
}
/** 合并：target 是被拖到的那张卡（标题、说明、文件顺序以它为准） */
export function mergeCards(ids: string[], target?: string) {
  const cs = ids.map((i) => cardById(i)?.card).filter(Boolean) as Card[];
  const chk = mergeCheck(cs);
  if (!chk.ok) return toast(chk.why);
  const tgt = (cs.find((c) => c.id === target) ?? cs[0]) as CodeCard;
  const others = cs.filter((c) => c !== tgt) as CodeCard[];
  const set = new Set(cs.map((c) => c.id));
  const mid = uid("c");
  let newSegs: Segment[] = [];
  mutate((b) => {
    const orig = cs.map((c) => structuredClone(unwrap(findCard(b, c.id)!.card)) as CodeCard);
    const T = orig.find((c) => c.id === tgt.id)!;
    const segs = mergeOverlapping(sortSegments(orig.flatMap((c) => c.segments), T.segments[0]?.path));
    // 合并后段 id 变了的，Link / Sidenote 要跟着换：旧段 id → 新段（按文件 + 行找）
    const segFor = (old: Segment, line?: number) => segs.find((s) => s.path === old.path && s.src.kind === old.src.kind && sameVersion(s.version, old.version) && (line === undefined || (line >= s.start && line <= s.end))) ?? segs[0];
    const oldSegs = new Map(orig.flatMap((c) => c.segments.map((s) => [s.id, s] as const)));
    const M: CodeCard = {
      id: mid, kind: "code", segments: segs, x: T.x, y: T.y, w: Math.max(560, ...orig.map((c) => c.w)),
      title: T.title, desc: T.desc, hide: T.hide, section: T.section,
      mergedFrom: orig.flatMap((c) => c.mergedFrom ?? [c]),
    };
    // 另一张卡的说明转成 Text sidenote 挂在整张卡上
    for (const o of orig) if (o !== T && o.desc) b.sidenotes.push({ id: uid("n"), at: { card: mid }, kind: "text", md: o.desc });
    for (const l of b.links) {
      if (set.has(l.from.card)) {
        const os = l.from.seg ? oldSegs.get(l.from.seg) : undefined;
        l.from = { card: mid, seg: os ? segFor(os, l.from.line).id : undefined, line: l.from.line };
      }
      if (set.has(l.to.card)) l.to = { card: mid };
    }
    b.links = b.links.filter((l) => !(l.from.card === mid && l.to.card === mid));
    for (const n of b.sidenotes) if (set.has(n.at.card)) {
      const os = n.at.seg ? oldSegs.get(n.at.seg) : undefined;
      n.at = { card: mid, seg: os ? segFor(os, n.at.lines?.[0]).id : undefined, lines: n.at.lines };
    }
    b.cards = b.cards.filter((c) => !set.has(c.id));
    b.cards.push(M);
    newSegs = structuredClone(segs);
  });
  // 段 id 没变的直接沿用展示数据；合出来的新段（范围变了）找宿主要
  const fresh = newSegs.filter((s) => { const v = state.views[s.id]; return !v || v.html.length !== s.text.length; });
  requestViews(fresh);
  select({ cards: [mid] });
  requestAnimationFrame(() => revealCard(mid));
  toast(`Merged ${cs.length} cards · ${newSegs.length} segment${newSegs.length > 1 ? "s" : ""}`);
}

/** 拆开：有合并记录就拆回原来的卡（放回原位、Link 回到各自的卡）；没有就按段拆 */
export function unmerge(id: string) {
  const M = cardById(id)?.card;
  if (!isCode(M)) return;
  if (!M.mergedFrom && M.segments.length < 2) return;
  const made: string[] = [];
  const need: Segment[] = [];
  mutate((b) => {
    const m = findCard(b, id)!.card as CodeCard;
    const dx = m.mergedFrom ? m.x - m.mergedFrom.find((o) => o.title === m.title || true)!.x : 0;
    const parts: CodeCard[] = m.mergedFrom
      ? m.mergedFrom.map((o) => ({ ...structuredClone(unwrap(o)), x: o.x + dx, y: o.y + (m.y - m.mergedFrom![0].y), section: m.section }))
      : m.segments.map((s, i) => ({ id: uid("c"), kind: "code", segments: [structuredClone(unwrap(s))], x: m.x + i * 40, y: m.y + i * 40, w: m.w, hide: m.hide, section: m.section }));
    // 段的高亮 / 隐藏跟着行走
    for (const p of parts) for (const s of p.segments) {
      const src = m.segments.filter((q) => q.path === s.path && sameVersion(q.version, s.version) && q.start <= s.end && q.end >= s.start);
      s.hl = [...new Set(src.flatMap((q) => q.hl ?? []).filter((l) => l >= s.start && l <= s.end))];
      s.hidden = src.flatMap((q) => q.hidden ?? []).map(([a, c]) => [Math.max(a, s.start), Math.min(c, s.end)] as [number, number]).filter(([a, c]) => a <= c);
      if (!s.hl.length) s.hl = undefined;
      if (!s.hidden.length) s.hidden = undefined;
    }
    const owner = (seg?: string, line?: number) => {
      const ms = m.segments.find((q) => q.id === seg);
      if (!ms) return { card: parts[0].id, seg: undefined as string | undefined };
      for (const p of parts) for (const s of p.segments) if (s.path === ms.path && sameVersion(s.version, ms.version) && (line === undefined ? s.start <= ms.end && s.end >= ms.start : line >= s.start && line <= s.end)) return { card: p.id, seg: s.id };
      return { card: parts[0].id, seg: undefined };
    };
    for (const l of b.links) {
      if (l.from.card === id) { const o = owner(l.from.seg, l.from.line); l.from = { card: o.card, seg: o.seg, line: o.seg ? l.from.line : undefined }; }
      if (l.to.card === id) l.to = { card: parts[0].id };
    }
    for (const n of b.sidenotes) if (n.at.card === id) { const o = owner(n.at.seg, n.at.lines?.[0]); n.at = { card: o.card, seg: o.seg, lines: o.seg ? n.at.lines : undefined }; }
    b.cards = b.cards.filter((c) => c.id !== id);
    for (const p of parts) { b.cards.push(p); made.push(p.id); need.push(...p.segments); }
  });
  requestViews(need.filter((s) => !state.views[s.id]));
  select({ cards: made });
  toast(`Split into ${made.length} cards`);
}

// ---------- Section ----------

export function moveToNewSection(rect?: Rect) {
  const ids = sel.cards.map((i) => cardById(i)?.host.id).filter(Boolean) as string[];
  const subs = sel.sections.slice();
  if (!ids.length && !subs.length && !rect) return;
  const id = uid("g");
  mutate((b) => {
    const homes = [...new Set(ids.map((i) => findCard(b, i)!.host.section))];
    const parent = homes.length === 1 ? homes[0] : undefined;
    const r = rect ?? bounds(ids.map((i) => rectOf(findCard(b, i)!.host))) ?? { x: 0, y: 0, w: 200, h: 120 };
    b.sections.push({ id, title: "Untitled Section", x: r.x, y: r.y, w: r.w, h: r.h, parent });
    for (const i of ids) findCard(b, i)!.host.section = id;
    for (const q of subs) {
      // 不能把祖先放进自己里面
      let ok = true;
      for (let a: Section | undefined = b.sections.find((s) => s.id === id); a; a = b.sections.find((s) => s.id === a!.parent)) if (a.id === q) ok = false;
      const s = b.sections.find((x) => x.id === q);
      if (ok && s) s.parent = id;
    }
  });
  select({ sections: [id] });
  setEditing({ kind: "section", id });
}
export function toggleSection(id: string) {
  const s0 = sectionById(id);
  if (!s0) return;
  // 折叠前把实际框存下来：标题条放在框的左上角，展开后框不变
  const f = s0.collapsed ? null : frameOf(s0);
  mutate((b) => {
    const s = b.sections.find((q) => q.id === id);
    if (!s) return;
    if (f) Object.assign(s, { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) });
    s.collapsed = !s.collapsed || undefined;
  });
}
export function renameSection(id: string, v: string) {
  mutate((b) => { const s = b.sections.find((q) => q.id === id); if (s) s.title = v.trim() || "Untitled Section"; });
}

// ---------- Plain link ----------

export function addPlain(from: { card: string; seg?: string; line?: number }, to: { card: string; seg?: string; line?: number }) {
  if (cardById(from.card)?.host.id === cardById(to.card)?.host.id && from.line === to.line) return;
  const id = uid("l");
  mutate((b) => { b.links.push({ id, kind: "plain", from, to }); });
  toast("Plain link added");
  return id;
}
export function startConnect(id: string) {
  setConnectFrom({ card: id });
  toast("Click a card to connect · Esc to cancel");
}
export const setLinkEditing = (id: string) => { select({ links: [id] }); setEditing({ kind: "label", id }); };
/** 悬停变量 chip：两张卡里出现这个名字的行高亮 */
export function hiVar(L: Link, v: Var, on: boolean) {
  setHoverVar(on ? { link: L.id, names: [v.a, v.b].filter(Boolean) as string[], from: L.from.card, to: L.to.card } : null);
}
export function setLinkLabel(id: string, v: string) {
  mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) l.label = v.trim() || undefined; });
}
export function openVars(id: string) {
  const el = document.querySelector(`[data-link="${id}"].lmid`) ?? document.querySelector(`[data-link="${id}"]`);
  openPop({ kind: "vars", link: id }, el ? { el, prefer: "below" } : lastPointer());
}
export function toggleVar(id: string, v: Var) {
  mutate((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l) return;
    const k = varKey(v);
    const has = (l.vars ?? []).some((x) => varKey(x) === k);
    l.vars = has ? l.vars!.filter((x) => varKey(x) !== k) : [...(l.vars ?? []), v];
    if (!l.vars.length) l.vars = undefined;
  });
}

// ---------- 版本 ----------

/** 卡片标题上的版本点：changed = 黄点；hidden = 只有隐藏的行变了（空心点） */
export function cardStale(c: CodeCard): "changed" | "hidden" | "lost" | "missing" | null {
  let hidden = false;
  for (const s of c.segments) {
    const st = state.stale[s.id];
    if (!st) continue;
    if (st.state === "changed") { if (!st.hiddenOnly) return "changed"; hidden = true; }
    if (st.state === "lost" || st.state === "many") return "lost";
    if (st.state === "missing") return "missing";
  }
  return hidden ? "hidden" : null;
}
export const uncommitted = (c: CodeCard) => c.segments.some((s) => s.version.kind === "git" && s.version.uncommitted);

export async function openDiff(id: string, segId?: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = segId ? segOf(c, segId) : c.segments.find((q) => state.stale[q.id]?.state === "changed") ?? c.segments[0];
  if (!s) return;
  const el = document.querySelector(`.card[data-id="${cardById(id)!.host.id}"] .rev`) ?? undefined;
  const pid = openPop({ kind: "diff", card: id, seg: s.id }, el ? { el, prefer: "below" } : lastPointer());
  try {
    const data = await ask<DiffData>("diff", { seg: structuredClone(unwrap(s)) });
    updatePop(pid, (p) => ({ ...(p as any), data }));
  } catch (e) { updatePop(pid, (p) => ({ ...(p as any), error: (e as Error).message })); }
}
/** Update：换成新版本；Sidenote 跟着行走，那一行被删了改挂整卡 */
export function applyNewVersion(cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  const ns = structuredClone(data.newSeg);
  ns.id = segId;
  mutate((b) => {
    const c = findCard(b, cardId)?.card;
    if (!isCode(c)) return;
    const i = c.segments.findIndex((s) => s.id === segId);
    if (i < 0) return;
    const old = c.segments[i];
    const map = lineMap(old, ns);
    ns.hidden = (old.hidden ?? []).map(([a, e]) => [map(a), map(e)]).filter(([a, e]) => a && e && a <= e) as [number, number][];
    ns.hl = (old.hl ?? []).map(map).filter(Boolean) as number[];
    c.segments[i] = ns;
    for (const l of b.links) if (l.from.card === cardId && l.from.seg === segId && l.from.line) { const m = map(l.from.line); if (m) l.from.line = m; else { l.from.seg = undefined; l.from.line = undefined; } }
    for (const n of b.sidenotes) if (n.at.card === cardId && n.at.seg === segId && n.at.lines) {
      const a = map(n.at.lines[0]), e = map(n.at.lines[1]);
      if (a && e) n.at.lines = [a, e]; else { n.at = { card: cardId }; n.lineRemoved = true; }
    }
  });
  if (data.newView) setState("views", segId, data.newView);
  setState("stale", segId, { state: "ok" });
  toast("Updated to the new version");
}
function lineMap(old: Segment, ns: Segment) {
  // 按内容对行：同样的行映射过去；改动的行就近映射；删掉的返回 0
  const m = new Map<number, number>();
  const a = old.text, b = ns.text;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    let k = j;
    while (k < b.length && b[k] !== a[i]) k++;
    if (k < b.length) { m.set(old.start + i, ns.start + k); j = k + 1; }
  }
  return (l: number) => m.get(l) ?? 0;
}
export function keepVersion(cardId: string, segId: string) {
  setState("stale", segId, { state: "ok" });
  void cardId;
}
export async function duplicateNewVersion(cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  const c = cardById(cardId)?.card;
  if (!isCode(c)) return;
  const d = structuredClone(unwrap(c)) as CodeCard;
  d.id = uid("c");
  d.title = undefined;
  d.segments = d.segments.map((s) => (s.id === segId ? { ...structuredClone(data.newSeg!), id: uid("s") } : { ...s, id: uid("s") }));
  const r = hostRect(cardId)!;
  const views: Record<string, SegView> = {};
  c.segments.forEach((s, i) => { const v = s.id === segId ? data.newView : state.views[s.id]; if (v) views[d.segments[i].id] = v; });
  addCards([{ card: d, views }], { at: { x: r.x + r.w + 40, y: r.y } });
}

export async function commitMenu(id: string, el: Element) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  if (s.src.kind === "github" || s.src.kind === "free") return;
  const pid = openPop({ kind: "commits", card: id, seg: structuredClone(unwrap(s)) }, { el, prefer: "below" });
  const list = await ask<Commit[]>("commits", { seg: structuredClone(unwrap(s)) }).catch(() => [] as Commit[]);
  updatePop(pid, (p) => ({ ...(p as any), list }));
}
export async function switchCommit(id: string, commit: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const segs: { seg: Segment; view: SegView }[] = [];
  for (const s of c.segments) {
    if (s.src.kind !== "repo" && s.src.kind !== "external") continue;
    try { segs.push(await ask<{ seg: Segment; view: SegView }>("switchCommit", { seg: structuredClone(unwrap(s)), commit })); }
    catch (e) { return toast((e as Error).message); }
  }
  mutate((b) => {
    const k = findCard(b, id)?.card;
    if (!isCode(k)) return;
    for (const r of segs) { const i = k.segments.findIndex((s) => s.id === r.seg.id); if (i >= 0) k.segments[i] = r.seg; }
  });
  for (const r of segs) { setState("views", r.seg.id, r.view); setState("stale", r.seg.id, undefined as any); }
  send({ type: "checkVersions" });
  toast(`Switched to ${commit.slice(0, 7)}`);
}

// ---------- Sidenote ----------

let hoverT: number | undefined, leaveT: number | undefined;
export function hoverMarker(el: Element, ids: string[], e: PointerEvent) {
  clearTimeout(leaveT);
  const pin = e.metaKey || e.ctrlKey;
  clearTimeout(hoverT);
  hoverT = window.setTimeout(() => showNotes(el, ids, pin), pin ? 0 : 120);
  el.addEventListener("pointerleave", () => { clearTimeout(hoverT); scheduleHideNotes(); }, { once: true });
}
export function scheduleHideNotes() {
  clearTimeout(leaveT);
  leaveT = window.setTimeout(() => {
    const p = pops().find((q) => !q.pinned && q.pop.kind === "notes");
    if (p && !document.querySelector(`.pop[data-pop="${p.id}"]:hover`)) closePop(p.id);
  }, 260);
}
export const cancelHideNotes = () => clearTimeout(leaveT);
export function pinMarker(el: Element, ids: string[]) { showNotes(el, ids, true); }
function showNotes(el: Element, ids: string[], pin: boolean) {
  const n0 = state.board.sidenotes.find((n) => n.id === ids[0]);
  if (!n0) return;
  const same = pops().find((p) => p.pop.kind === "notes" && p.pop.ids.join() === ids.join());
  if (same) { if (pin && !same.pinned) pinPop(same.id); return; }
  const f = cardById(n0.at.card);
  const where = n0.at.lines ? (n0.at.lines[0] === n0.at.lines[1] ? `line ${n0.at.lines[0]}` : `lines ${n0.at.lines[0]}–${n0.at.lines[1]}`) : f ? cardTitle(f.card) : "card";
  const id = openPop({ kind: "notes", card: n0.at.card, ids, title: `Sidenotes · ${where}`, sel: ids[0] }, { el, prefer: "right" });
  if (pin) pinPop(id);
}

export function openAddNote(at: Anchor, tab: "code" | "paste" | "text" | "link" | "card" = "code") {
  const host = cardById(at.card)?.host.id;
  const el = (at.lines && document.querySelector(`.card[data-id="${host}"] .addn`)) || document.querySelector(`.card[data-id="${host}"]`);
  openPop({ kind: "addNote", at, tab }, el ? { el, prefer: "right" } : lastPointer());
}
export function addSidenoteUI() {
  const ls = lineSel();
  if (ls) openAddNote({ card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] });
  else if (sel.cards.length === 1) openAddNote({ card: sel.cards[0] });
  else toast("Select lines in a card first");
}
export function addSidenote(n: Omit<Sidenote, "id">, view?: SegView) {
  const id = uid("n");
  const sn = { ...n, id } as Sidenote;
  if (sn.kind === "code" && view) setState("views", sn.code.id, view);
  mutate((b) => { b.sidenotes.push(sn); });
  return id;
}
export function updateSidenote(id: string, f: (n: Sidenote) => void) {
  mutate((b) => { const n = b.sidenotes.find((k) => k.id === id); if (n) f(n); });
}
export function deleteSidenote(id: string) {
  mutate((b) => { b.sidenotes = b.sidenotes.filter((n) => n.id !== id); });
}
/** Place on Board：Sidenote 变成卡，放在源卡旁边，自动连一条 Plain link（从原来挂的那一行连出） */
export function placeSidenote(id: string) {
  const n = state.board.sidenotes.find((k) => k.id === id);
  if (!n) return;
  const r = hostRect(n.at.card);
  if (!r) return;
  let card: Card | null = null;
  const views: Record<string, SegView> = {};
  const nid = uid("c");
  if (n.kind === "code") { const sid = uid("s"); card = { id: nid, kind: "code", segments: [{ ...structuredClone(unwrap(n.code)), id: sid }], x: 0, y: 0, w: 480, desc: n.why }; const v = state.views[n.code.id]; if (v) views[sid] = v; }
  else if (n.kind === "paste") { const sid = uid("s"); const t = n.text.split("\n"); card = { id: nid, kind: "code", segments: [{ id: sid, src: { kind: "free", url: n.url }, path: "", lang: n.lang, start: 1, end: t.length, text: t, version: { kind: "none" } }], x: 0, y: 0, w: 480, desc: n.why }; }
  else if (n.kind === "text") card = { id: nid, kind: "note", md: n.md, bg: true, x: 0, y: 0, w: 280 };
  else if (n.kind === "link") card = { id: nid, kind: "web", url: n.url, pageTitle: n.title, x: 0, y: 0, w: 300, desc: n.why };
  else if (n.kind === "card") { revealCard(n.card); return; }
  if (!card) return;
  addCards([{ card, views }], { at: { x: r.x + r.w + 48, y: r.y + 20 } });
  if (isCode(card) && card.segments[0].src.kind === "free") requestViews(card.segments);
  mutate((b) => {
    b.sidenotes = b.sidenotes.filter((k) => k.id !== id);
    b.links.push({ id: uid("l"), kind: "plain", from: { card: n.at.card, seg: n.at.seg, line: n.at.lines?.[0] }, to: { card: nid } });
  });
  closePop();
}
/** Note 拖到某一行 → Text sidenote；⌥ 拖代码卡到某一行 → Code sidenote */
export async function cardToSidenote(cardId: string, at: Anchor) {
  const c = cardById(cardId)?.card;
  if (!c) return;
  const links = state.board.links.filter((l) => l.from.card === cardId || l.to.card === cardId).length;
  if (links) {
    const ok = await choose(`Turn into a Sidenote?`, ["Turn into Sidenote", "Cancel"], { text: `${links} link${links > 1 ? "s" : ""} on this card will be deleted.` });
    if (ok !== 0) return;
  }
  mutate((b) => {
    if (c.kind === "note") b.sidenotes.push({ id: uid("n"), at, kind: "text", md: c.md });
    else if (isCode(c)) {
      if (c.segments.length === 1) b.sidenotes.push({ id: uid("n"), at, kind: "code", code: structuredClone(unwrap(c.segments[0])), why: c.desc });
      else b.sidenotes.push({ id: uid("n"), at, kind: "card", card: cardId });
    }
    if (isCode(c) && c.segments.length > 1) return; // 多段卡：挂成 Card sidenote，卡留着
    b.cards = b.cards.filter((k) => k.id !== cardId);
    b.links = b.links.filter((l) => l.from.card !== cardId && l.to.card !== cardId);
  });
  clearSel();
  toast("Added as Sidenote");
}

// ---------- 定义预览 ----------

let peekT: number | undefined;
export function hoverIdent(el: HTMLElement, cardId: string, segId: string, line: number, col: number, word: string, e: PointerEvent) {
  clearTimeout(peekT);
  const pin = e.metaKey || e.ctrlKey;
  peekT = window.setTimeout(() => showPeek(el, cardId, segId, line, col, word, pin), pin ? 0 : 450);
  el.addEventListener("pointerleave", () => { clearTimeout(peekT); scheduleHidePeek(); }, { once: true });
}
let peekLeave: number | undefined;
export function scheduleHidePeek() {
  clearTimeout(peekLeave);
  peekLeave = window.setTimeout(() => {
    const p = pops().find((q) => !q.pinned && q.pop.kind === "peek");
    if (p && !document.querySelector(`.pop[data-pop="${p.id}"]:hover`)) closePop(p.id);
  }, 260);
}
export const cancelHidePeek = () => clearTimeout(peekLeave);
export async function showPeek(el: Element, cardId: string, segId: string, line: number, col: number, word: string, pin = false, at?: { path: string; line: number; col: number }) {
  const c = cardById(cardId)?.card;
  const s = isCode(c) ? segOf(c, segId) : undefined;
  if (!s) return;
  const pid = openPop({ kind: "peek", card: cardId, seg: segId, line, word }, { el, prefer: "below" });
  if (pin) pinPop(pid);
  try {
    const r = await ask<PeekResult>("peek", { seg: structuredClone(unwrap(s)), line, col, word, at });
    updatePop(pid, (p) => ({ ...(p as any), data: r }));
  } catch { updatePop(pid, (p) => ({ ...(p as any), data: { none: "No definition found", word } })); }
}
type PeekResult = import("@codeboard/core").PeekDef | { none: string; word: string } | { pick: import("@codeboard/core").PeekDef[] };

// ---------- 粘贴 ----------

export async function pasteText(text: string, at?: { x: number; y: number }) {
  if (!text.trim()) return;
  const { classifyPaste, guessLang } = await import("@codeboard/core");
  const k = classifyPaste(text);
  if (k.kind === "web") return newWeb(at, k.url);
  if (k.kind === "note") return newNote(at, true, text);
  // 代码：先问宿主是不是工作区里的代码 / GitHub 链接
  const r = await ask<import("@codeboard/core").NewCard | null>("paste", { text }).catch(() => null);
  if (r) return addCards([r], { at });
  if (k.kind === "github") return toast("Could not fetch this GitHub file");
  newFreeCode(at, text.replace(/\s+$/, ""), guessLang(text) ?? "python");
}

// ---------- 讲解（Walkthrough）：沿一棵 Call 树一步步移镜头 ----------

export function startWalk(id?: string) {
  const start = id ?? sel.cards[0] ?? flows().roots[0]?.id;
  if (!start) return toast("No call flow on this board yet. Click a call in a code card to start one.");
  const root = treeOf(flows(), start);
  if (!root) return toast("Not in a call flow");
  const order = walkOrder(root).map((n) => n.id);
  const before = { ...camTarget() };
  // 折叠的子树讲解时临时展开
  const expanded = order.filter((cid) => cardById(cid)?.host.collapsed);
  if (expanded.length) mutate((b) => { for (const cid of expanded) { const c = findCard(b, cid)?.host; if (c) c.collapsed = undefined; } });
  const i = Math.max(0, order.indexOf(start));
  setWalk({ root: root.id, order, i, before, expanded });
  clearSel();
  requestAnimationFrame(() => walkTo(i));
}
export function walkTo(i: number) {
  const w = walk();
  if (!w) return;
  i = Math.max(0, Math.min(w.order.length - 1, i));
  setWalk({ ...w, i });
  const r = hostRect(w.order[i]);
  if (!r) return;
  const f = fitTop({ x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }, 1.15);
  camTo(f.x, f.y, f.z, true);
}
export function exitWalk() {
  const w = walk();
  if (!w) return;
  setWalk(null);
  if (w.expanded.length) mutate((b) => { for (const cid of w.expanded) { const c = findCard(b, cid)?.host; if (c) c.collapsed = true; } });
  camTo(w.before.x, w.before.y, w.before.z, true);
}

export { toggleShown, setKeysOpen, zoomAt, view, center, contains };

export const currentLineSel = () => lineSel();

/** 选中的片段跨了几个顶层函数：按函数拆成几张卡，或一张多段卡 */
export function splitSnippet(id: string, merge: boolean) {
  const c = cardById(id)?.card;
  if (!isCode(c) || c.segments.length !== 1) return;
  const s = c.segments[0];
  const defs = (state.views[s.id]?.defs ?? []).filter((d) => !d.qual.includes(".") || true).filter((d) => d.line >= s.start && d.line <= s.end);
  const tops = defs.filter((d) => !defs.some((o) => o !== d && d.qual.startsWith(o.qual + ".")));
  if (tops.length < 2) return;
  const parts: Segment[] = tops.map((d, i) => {
    const a = i === 0 ? s.start : d.line, e = i + 1 < tops.length ? tops[i + 1].line - 1 : s.end;
    return { ...structuredClone(unwrap(s)), id: uid("s"), start: a, end: e, text: s.text.slice(a - s.start, e - s.start + 1), symbol: { qual: d.qual, kind: "function" as const }, scope: d.qual, hidden: undefined, hl: undefined };
  });
  if (merge) {
    mutate((b) => { const k = findCard(b, id)?.card; if (isCode(k)) k.segments = parts; });
  } else {
    const r = hostRect(id)!;
    mutate((b) => {
      b.cards = b.cards.filter((k) => k.id !== id);
      let y = r.y;
      for (const p of parts) { b.cards.push({ id: uid("c"), kind: "code", segments: [p], x: r.x, y, w: r.w }); y += Math.min(520, 52 + (p.end - p.start + 1) * 19) + 28; }
    });
  }
  requestViews(parts);
}

/** 宿主（命令面板、快捷键、状态栏）发来的命令 */
export function runCommand(name: string, arg?: unknown) {
  switch (name) {
    case "fit": return fitAll();
    case "search": return setPaletteOpen({ mode: "all" });
    case "walk": return startWalk(arg as string | undefined);
    case "exportPng": return exportPng();
    case "undo": return import("./state/store").then((m) => m.undo());
    case "redo": return import("./state/store").then((m) => m.redo());
    case "review": return reviewNext();
    case "reveal": return revealCard(arg as string);
    case "newNote": return newNote();
    case "keys": return setKeysOpen(true);
  }
}

/** 新版本横幅里的 Review：一张张打开 diff */
export function reviewNext() {
  for (const c of allCodeCards(state.board)) {
    const st = cardStale(c);
    if (st === "changed" || st === "hidden") { select({ cards: [cardById(c.id)!.host.id] }); revealCard(c.id, false); setTimeout(() => openDiff(c.id), 350); return; }
  }
  toast("All cards are up to date");
}
export const staleCount = () => allCodeCards(state.board).filter((c) => cardStale(c) === "changed").length;

/** 导出 PNG：把整块白板画到 canvas 上（用 SVG foreignObject 克隆 DOM） */
export async function exportPng() {
  const world = document.querySelector(".world") as HTMLElement | null;
  if (!world) return;
  const rs = [...state.board.cards.map((c) => rectOf(c)), ...state.board.sections.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))];
  const b = bounds(rs);
  if (!b) return toast("Nothing to export");
  const pad = 40, scale = 2;
  const W = Math.ceil(b.w + pad * 2), H = Math.ceil(b.h + pad * 2);
  const clone = world.cloneNode(true) as HTMLElement;
  clone.style.transform = `translate(${-b.x + pad}px, ${-b.y + pad}px)`;
  clone.querySelectorAll(".sel, .lift").forEach((n) => n.classList.remove("sel", "lift"));
  const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; } }).join("\n");
  const bg = getComputedStyle(document.body).getPropertyValue("--canvas") || getComputedStyle(document.body).backgroundColor;
  const rootStyle = document.body.getAttribute("style") ?? "";
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><foreignObject width="${W}" height="${H}"><div xmlns="http://www.w3.org/1999/xhtml" class="${document.body.className}" style="${rootStyle};position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg}"><style>${css.replace(/</g, "\\3c ")}</style>${xml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await img.decode(); } catch { return toast("Export failed"); }
  const cv = document.createElement("canvas");
  cv.width = W * scale; cv.height = H * scale;
  const g = cv.getContext("2d")!;
  g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0);
  try { send({ type: "exportPng", dataUrl: cv.toDataURL("image/png"), name: `${state.board.name || "board"}.png` }); }
  catch { toast("Export failed: an image on the board blocks export"); }
}

// ---------- 其他入口 ----------

/** 点一张卡（Card sidenote 用） */
let pickCb: ((id: string) => void) | null = null;
export function pickCardThen(cb: (id: string) => void) { pickCb = cb; document.getElementById("board")?.classList.add("connecting"); }
export function takePick(): ((id: string) => void) | null { const c = pickCb; pickCb = null; document.getElementById("board")?.classList.remove("connecting"); return c; }
export const picking = () => !!pickCb;

export function searchWorkspace(word: string) { setPaletteOpen({ mode: "code", q: word } as any); }

export function openWorktreeDiff(id: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  const el = document.querySelector(`.card[data-id="${cardById(id)!.host.id}"] .rev`) ?? undefined;
  const pid = openPop({ kind: "diff", card: id, seg: s.id }, el ? { el, prefer: "below" } : lastPointer());
  ask<DiffData>("diff", { seg: structuredClone(unwrap(s)), against: "worktree" })
    .then((data) => updatePop(pid, (p) => ({ ...(p as any), data })))
    .catch((e) => updatePop(pid, (p) => ({ ...(p as any), error: (e as Error).message })));
}

/** Focus 下点卡片路径：不跳编辑器，浮出只读源码 */
export async function showSource(id: string) {
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  const el = document.querySelector(`.card[data-id="${cardById(id)!.host.id}"] .cpath`) ?? undefined;
  const pid = openPop({ kind: "source", card: id, seg: structuredClone(unwrap(s)) }, el ? { el, prefer: "below" } : lastPointer());
  try {
    const r = await ask<{ html: string[]; start: number }>("source", { seg: structuredClone(unwrap(s)) });
    updatePop(pid, (p) => ({ ...(p as any), html: r.html, start: r.start }));
  } catch (e) { closePop(pid); toast((e as Error).message); }
}
export function openCodeFromFocus(id: string) {
  import("./state/ui").then((u) => { u.setFocusMode(false); send({ type: "focusMode", on: false }); openCode(id); });
}
/** 卡头上的路径：Workbench 打开编辑器，Focus 浮出源码 */
export function pathClick(id: string) {
  import("./state/ui").then((u) => (u.focusMode() ? showSource(id) : openCode(id)));
}

/** 类卡里点一个成员：展开成函数卡，从类卡那一行连 Call link */
export function expandMember(cardId: string, d: { line: number; name: string; qual: string }) {
  const c = cardById(cardId)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  expandCall(cardId, s.id, { line: d.line, col: 0, end: d.name.length, name: d.name, loop: false }, undefined, { path: s.path, line: d.line });
}
export function showAllMembers(id: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (isCode(c) && c.members) c.members.shown = []; });
}
