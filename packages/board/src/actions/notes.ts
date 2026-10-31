import { unwrap } from "solid-js/store";
import { uid, findCard, isCode, cardTitle, segOf, cardIntoSidenote, imageIntoNote, removeSidenotes, sidenoteCard, sidenoteToCard, splitHeadings, splitNoteByHeadings, turnNoteInto, NEW_CARD_W, type Sidenote, type SegView, type Anchor, type BoxFill, type HandColor } from "@codeboard/core";
import { state, setState, mutate, sel, select, clearSel, lineSel, cardById, hostOf, toast, rectOf, placeOf } from "../state/store";
import { editing, liveNoteMd, setEditing } from "../state/ui";
import { cardsMeasured } from "../state/measure";
import { noteImageOf } from "./imagedata";
import { quietHover } from "../state/camera";
import { choose, promptText, type Item } from "../ui/Menu";
import { imageCaption, setImageCaption } from "@yhnocoder/markdown";
import { noteImageAt, type ImgRef } from "./imageai";
import { openPop, closePop, pops, updatePop, pinPop } from "../state/pop";
import { ask } from "../host";
import { addCards, requestViews } from "./create";
import { tune } from "../state/tune";
import { hostRect, popCard, revealCard } from "./common";
import { lastPointer } from "../state/measure";

let hoverT: number | undefined, leaveT: number | undefined;
export function hoverMarker(el: Element, ids: string[]) {
  if (quietHover()) return;
  clearTimeout(leaveT);
  clearTimeout(hoverT);
  hoverT = window.setTimeout(() => showNotes(el, ids, false), 120);
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
/** @public run from the key table (keymap.ts) */
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
  addCards([{ card, views, w: card.kind === "note" || n.kind === "paste" ? NEW_CARD_W : card.kind === "web" ? 300 : 480 }], { at: { x: r.x + r.w + 48, y: r.y + 20 }, also: (b) => sidenoteToCard(b, id, card.id) });
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
/** 图放进 Note 的 Markdown（at = 第几个字，一块的开头；不给 = 末尾），图片卡删掉：一步撤销 */
export function putImageInNote(imageId: string, noteId: string, src: string, at?: number) {
  let ok = false;
  if (!mutate((b) => { ok = imageIntoNote(b, imageId, noteId, src, at); }) || !ok) return;
  select({ cards: [noteId] });
  toast("Added the image to the Note");
}

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
  mutate((b) => { const n = findCard(b, id)?.card; if (n?.kind === "note" && n.look === "mark") n.hand = hand; });
}

export function setBoxFill(id: string, fill: BoxFill) {
  mutate((b) => { const n = findCard(b, id)?.card; if (n?.kind === "note" && n.look === "box") n.fill = fill; });
}

export function turnNote(id: string, look: "note" | "text") {
  mutate((b) => turnNoteInto(b, id, look));
}

/** Split by Headings 能拆成几张卡（0 = 没有可拆的标题，菜单项灰掉） */
export function headingSplitCount(id: string): number {
  const c = cardById(id)?.card;
  return c?.kind === "note" && c.look === "note" ? splitHeadings(c.md)?.parts.length ?? 0 : 0;
}

/** 卡里的元素到卡左上角的距离（布局像素，不受画布缩放、斜贴影响） */
function topIn(el: HTMLElement, card: HTMLElement): number {
  let y = 0;
  for (let e: HTMLElement | null = el; e && e !== card; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
  return y;
}

/**
 * 按显示着的这张 Note 量：每个要拆的标题在卡里的位置（新卡从那里飞出去）、拆完原卡和每张新卡大概多高
 * （新卡的标题进了卡头，正文少了标题那一块）。量不到（不在画面上、标题对不上）回 null，按估计摆
 */
function measureSplit(id: string, cut: number, n: number): { tops: number[]; root: number; parts: number[] } | null {
  const card = document.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"]`);
  const body = card?.querySelector<HTMLElement>(".nbody.md:not(.editing)");
  if (!card || !body) return null;
  const hs = [...body.children].filter((e): e is HTMLElement => /^H[1-6]$/.test(e.tagName) && +e.tagName[1] <= cut);
  const end = topIn(body, card) + body.offsetHeight - parseFloat(getComputedStyle(body).paddingBottom);
  const chrome = card.offsetHeight - (end - topIn(body, card)) + parseFloat(getComputedStyle(body).paddingTop);
  // 开头的标题就是卡头时它在正文里藏着（不占位置）：拆的时候原卡留着它那一段，只量后面的
  const shown = hs.filter((h) => h.offsetParent);
  if (shown.length < n) return null;
  const use = shown.slice(shown.length - n);
  const tops = use.map((h) => topIn(h, card));
  const bodyTop = topIn(body, card) + parseFloat(getComputedStyle(body).paddingTop);
  return {
    tops,
    root: Math.round(chrome + tops[0] - bodyTop),
    parts: use.map((h, i) => Math.round(chrome + (tops[i + 1] ?? end) - (tops[i] + h.offsetHeight))),
  };
}

/** Note 右键 Split by Headings：一步改动（⌘Z 一下撤回），新卡从原卡里各自那一段的位置弹出来 */
export async function splitByHeadings(id: string) {
  const c = cardById(id)?.card;
  const sp = c?.kind === "note" ? splitHeadings(c.md) : null;
  if (!sp) return;
  // 正在编辑：先存下编辑器里的字，等静态显示画出来再量
  if (editing()?.id === id) { setEditing(null); await cardsMeasured(); return splitByHeadings(id); }
  const m = measureSplit(id, sp.cut, sp.parts.length);
  const p0 = { ...placeOf(id) };
  const others = state.board.cards.filter((k) => k.id !== id && state.board.place[k.id]).map((k) => rectOf(k));
  let ids: string[] | null = null;
  if (!mutate((b) => { ids = splitNoteByHeadings(b, id, { heights: m ? { root: m.root, parts: m.parts } : undefined, others }); }) || !ids) return;
  const made: string[] = ids;
  select({ cards: [id, ...made] });
  made.forEach((k, i) => popCard(k, { x: p0.x, y: p0.y + (m?.tops[i] ?? 40) }));
  toast(`Split into ${made.length} card${made.length > 1 ? "s" : ""}. ${state.host.isMac ? "⌘Z" : "Ctrl+Z"} undoes it`);
}

/** 右键的这张图是 Note 里同一个地址的图里的第几张（按显示的先后，和 Markdown 里的先后一样） */
function imageIndex(el: Element, ref: ImgRef): number {
  const face = el.closest(".cface");
  const same = [...(face?.querySelectorAll("img") ?? [])].filter((i) => noteImageAt(i, ref.card)?.note === ref.note);
  return Math.max(0, same.indexOf(el as HTMLImageElement));
}

/** Note 里一张图的图注（Markdown 里图的 title）：Add Caption… / Edit Caption…、Remove Caption。el = 右键点的那张图 */
export function captionItems(ref: ImgRef, el: Element | null): Item[] {
  const c = cardById(ref.card)?.card;
  if (c?.kind !== "note" || ref.note === undefined || !el) return [];
  // 编辑中：刚贴进来的图还没存回卡上，按编辑器里眼前的字找
  const nth = imageIndex(el, ref), src = ref.note, cap = imageCaption(liveNoteMd(ref.card) ?? c.md, src, nth);
  if (cap === null) return [];
  return [
    { label: cap ? "Edit Caption…" : "Add Caption…", run: () => void editCaption(ref.card, src, nth, cap) },
    ...(cap ? [{ label: "Remove Caption", run: () => setCaption(ref.card, src, nth, "") } as Item] : []),
  ];
}
async function editCaption(card: string, src: string, nth: number, cap: string) {
  const v = await promptText(cap ? "Edit Caption" : "Add Caption", cap, "Figure 1: …", cap ? "Save" : "Add", { text: "Shown under the image, like a figure caption" });
  if (v !== null && v !== cap) setCaption(card, src, nth, v);
}
function setCaption(card: string, src: string, nth: number, cap: string) {
  // 正在编辑这张 Note：先存下编辑器里的字，再改图注（编辑器里的文档不跟着外面的改动走）
  if (editing()?.kind === "note" && editing()?.id === card) setEditing(null);
  mutate((b) => { const n = findCard(b, card)?.card; if (n?.kind === "note") n.md = setImageCaption(n.md, src, nth, cap); });
}
