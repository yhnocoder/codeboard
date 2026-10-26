// Sidenote（弹窗、添加、Place on Board、卡变成 Sidenote）和定义预览。
import { unwrap } from "solid-js/store";
import { uid, findCard, isCode, cardTitle, segOf, cardIntoSidenote, imageIntoNote, removeSidenotes, sidenoteCard, sidenoteToCard, type Sidenote, type SegView, type Anchor, type HandColor } from "@codeboard/core";
import { state, setState, mutate, sel, select, clearSel, lineSel, cardById, hostOf, toast } from "../state/store";
import { noteImageOf } from "./imagedata";
import { quietHover } from "../state/camera";
import { choose } from "../ui/Menu";
import { openPop, closePop, pops, updatePop, pinPop } from "../state/pop";
import { ask } from "../host";
import { addCards, requestViews } from "./create";
import { tune } from "../state/tune";
import { hostRect, revealCard } from "./common";
import { lastPointer } from "../state/measure";

// ---------- Sidenote ----------

let hoverT: number | undefined, leaveT: number | undefined;
export function hoverMarker(el: Element, ids: string[], e: PointerEvent) {
  if (quietHover()) return;
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
  const host = hostOf(at.card);
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
/** 一次加好几条（一个撤销步骤），返回新 id */
export function addSidenotes(list: Omit<Sidenote, "id">[]) {
  const sns = list.map((n) => ({ ...n, id: uid("n") }) as Sidenote);
  mutate((b) => { b.sidenotes.push(...sns); });
  return sns.map((n) => n.id);
}
export function updateSidenote(id: string, f: (n: Sidenote) => void) {
  mutate((b) => { const n = b.sidenotes.find((k) => k.id === id); if (n) f(n); });
}
export function deleteSidenote(id: string) {
  mutate((b) => removeSidenotes(b, [id]));
}
/** Place on Board：Sidenote 变成卡，放在源卡旁边，自动连一条箭头（从原来挂的那一行连出） */
export function placeSidenote(id: string) {
  const n = state.board.sidenotes.find((k) => k.id === id);
  if (!n) return;
  if (n.kind === "card") return revealCard(n.card);
  const r = hostRect(n.at.card);
  const card = sidenoteCard(unwrap(n));
  if (!r || !card) return;
  const views: Record<string, SegView> = {};
  if (n.kind === "code" && isCode(card) && state.views[n.code.id]) views[card.segments[0].id] = state.views[n.code.id];
  // 放卡、去掉 Sidenote、连箭头是同一步（一次撤销）
  addCards([{ card, views, w: card.kind === "note" ? 280 : card.kind === "web" ? 300 : 480 }], { at: { x: r.x + r.w + 48, y: r.y + 20 }, also: (b) => sidenoteToCard(b, id, card.id) });
  if (isCode(card) && card.segments[0].src.kind === "free") requestViews(card.segments);
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
  // 多段卡：挂成 Card sidenote，卡留着
  const id = uid("n");
  const n: Sidenote | null = isCode(c) && c.segments.length > 1 ? { id, at, kind: "card", card: cardId }
    : c.kind === "note" ? { id, at, kind: "text", md: c.md }
    : isCode(c) ? { id, at, kind: "code", code: structuredClone(unwrap(c.segments[0])), why: c.desc }
    : null;
  if (!n) return;
  const ok = mutate((b) => cardIntoSidenote(b, cardId, n));
  if (!ok) return;
  clearSel();
  toast("Added as Sidenote");
}

/** 图片卡拖到 Note 上松手：先把图存成 Note 的图（和 Note 里粘贴的图同一条路），回 Markdown 里写的地址；存不了回 null（已经提示过） */
export async function noteImageFor(imageId: string): Promise<string | null> {
  const c = cardById(imageId)?.card;
  return c?.kind === "image" ? noteImageOf(unwrap(c)) : null;
}
/** 图放进 Note 的 Markdown 末尾，图片卡删掉：一步撤销 */
export function putImageInNote(imageId: string, noteId: string, src: string) {
  let ok = false;
  if (!mutate((b) => { ok = imageIntoNote(b, imageId, noteId, src); }) || !ok) return;
  select({ cards: [noteId] });
  toast("Added the image to the Note");
}

// ---------- 定义预览 ----------

let peekLeave: number | undefined;
export function scheduleHidePeek() {
  clearTimeout(peekLeave);
  peekLeave = window.setTimeout(() => {
    const p = pops().find((q) => !q.pinned && q.pop.kind === "peek");
    if (p && !document.querySelector(`.pop[data-pop="${p.id}"]:hover`)) closePop(p.id);
  }, tune("peekHide"));
}
export const cancelHidePeek = () => clearTimeout(peekLeave);
export async function showPeek(el: Element, cardId: string, segId: string, line: number, col: number, word: string, pin = false, at?: { path: string; line: number; col: number }) {
  if (quietHover() && !pin) return;
  const c = cardById(cardId)?.card;
  const s = isCode(c) ? segOf(c, segId) : undefined;
  if (!s) return;
  const pid = openPop({ kind: "peek", card: cardId, seg: segId, line, word }, { el, prefer: "below" });
  if (pin) pinPop(pid);
  try {
    const r = await ask("peek", { seg: structuredClone(unwrap(s)), line, col, word, at });
    updatePop(pid, (p) => ({ ...(p as any), data: r ?? { none: "No definition found", word } }));
  } catch { updatePop(pid, (p) => ({ ...(p as any), data: { none: "No definition found", word } })); }
}


/** Mark 的颜色（它的箭头跟着变） */
export function setMarkColor(id: string, hand: HandColor) {
  mutate((b) => { const n = findCard(b, id)?.card; if (n?.kind === "note" && n.hand) n.hand = hand; });
}

/** Note 背景开关：打开时卡至少 260 宽 */
export function setNoteBg(id: string, on: boolean) {
  mutate((b) => {
    const n = findCard(b, id)?.card;
    if (n?.kind !== "note") return;
    if (!!n.bg === on) return;
    n.bg = on;
    // 字留在原地：Note 的字在标题栏（36，含下边线）下面、内边距 10 / 14；Text 的内边距 2 / 4。卡挪一下、宽度跟着变，字的位置和折行都不变
    const p = b.place[id];
    if (!p) return;
    const dx = 14 - 4, dy = 36 + 10 - 2;
    if (on) { p.x -= dx; p.y -= dy; p.w += 2 * dx; if (p.h) p.h += dy + 12 - 2; }
    else { p.x += dx; p.y += dy; p.w -= 2 * dx; if (p.h) p.h = Math.max(24, p.h - dy - 12 + 2); }
  });
}
