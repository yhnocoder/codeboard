import { unwrap } from "solid-js/store";
import {
  isCode,
  cardTitle,
  segOf,
  splitHeadings,
  NEW_CARD_W,
  type Sidenote,
  type SegView,
  type Anchor,
  type BoxFill,
  type HandColor,
} from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { state, cardById, hostOf, rectOf, placeOf } from "../state/store";
import { sel, select, clearSel, lineSel } from "../state/selection";
import { toast } from "../state/toast";
import { IS_MAC } from "@yhnocoder/markdown/ui";
import { editing, liveNoteMd, setEditing } from "../state/ui";
import { cardsMeasured } from "../state/measure";
import { noteImageOf } from "./imagedata";
import { quietHover } from "../state/camera";
import { promptText, type Item } from "../ui/Menu";
import { imageCaption, setImageCaption, setTableCaption, tableCaption } from "@yhnocoder/markdown";
import { noteImageAt, type ImgRef } from "./imageai";
import { openPop, closePop, pops, updatePop, pinPop } from "../state/pop";
import { ask } from "../host";
import { addCards } from "./create";
import { requestViews, putViews } from "../state/views";
import { tune } from "../state/tune";
import { hostRect, popCard, revealCard } from "./common";
import { lastPointer } from "../state/measure";
import { cardSel } from "../cardsel";
import { boardTimer } from "../state/root";

const hoverT = boardTimer(),
  leaveT = boardTimer();
export function hoverMarker(el: Element, ids: string[]) {
  if (quietHover()) return;
  leaveT.stop();
  hoverT.start(() => showNotes(el, ids, false), 120);
  el.addEventListener(
    "pointerleave",
    () => {
      hoverT.stop();
      scheduleHideNotes();
    },
    { once: true },
  );
}
export function scheduleHideNotes() {
  leaveT.start(() => {
    const p = pops().find((q) => !q.pinned && q.pop.kind === "notes");
    if (p && !document.querySelector(`.pop[data-pop="${p.id}"]:hover`)) closePop(p.id);
  }, 260);
}
export const cancelHideNotes = () => leaveT.stop();
export function pinMarker(el: Element, ids: string[]) {
  showNotes(el, ids, true);
}
function showNotes(el: Element, ids: string[], pin: boolean) {
  const n0 = state.board.sidenotes.find((n) => n.id === ids[0]);
  if (!n0) return;
  const same = pops().find((p) => p.pop.kind === "notes" && p.pop.ids.join() === ids.join());
  if (same) {
    if (pin && !same.pinned) pinPop(same.id);
    return;
  }
  const f = cardById(n0.at.card);
  const where = n0.at.lines
    ? n0.at.lines[0] === n0.at.lines[1]
      ? `line ${n0.at.lines[0]}`
      : `lines ${n0.at.lines[0]}–${n0.at.lines[1]}`
    : f
      ? cardTitle(f.card)
      : "card";
  const id = openPop(
    { kind: "notes", card: n0.at.card, ids, title: `Sidenotes · ${where}`, sel: ids[0] },
    { el, prefer: "right" },
  );
  if (pin) pinPop(id);
}

export function openAddNote(at: Anchor, tab: "code" | "paste" | "text" | "link" | "card" = "code") {
  const host = hostOf(at.card);
  const el =
    (at.lines && document.querySelector(`${cardSel(host)} .addn`)) || document.querySelector(`${cardSel(host)}`);
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
  const sn = n as Sidenote;
  if (sn.kind === "code" && view) putViews({ [sn.code.id]: view });
  return C.addSidenotes(commandEnv, [n])[0];
}
/** 一次加好几条（一个撤销步骤），返回新 id */
export const addSidenotes = (list: Omit<Sidenote, "id">[]) => C.addSidenotes(commandEnv, list);
/** A Text sidenote's Markdown; written empty it goes */
export const writeSidenote = (id: string, md: string) => C.writeSidenote(commandEnv, id, md);
export const toggleAlwaysShow = (id: string) => C.toggleAlwaysShow(commandEnv, id);
export function deleteSidenote(id: string) {
  C.deleteItems(commandEnv, { sidenotes: [id] });
}
/** Place on Board：Sidenote 变成卡，放在源卡旁边，自动连一条箭头（从原来挂的那一行连出） */
export function placeSidenote(id: string) {
  const n = state.board.sidenotes.find((k) => k.id === id);
  if (!n) return;
  if (n.kind === "card") return revealCard(n.card);
  const r = hostRect(n.at.card);
  if (!r) return;
  // 放卡、去掉 Sidenote、连箭头是同一步（一次撤销）
  const card = C.sidenoteOnBoard(commandEnv, id, (card, n, also) => {
    const views: Record<string, SegView> = {};
    if (n.kind === "code" && isCode(card) && state.views[n.code.id])
      views[card.segments[0].id] = state.views[n.code.id];
    addCards(
      [{ card, views, w: card.kind === "note" || n.kind === "paste" ? NEW_CARD_W : card.kind === "web" ? 300 : 480 }],
      { at: { x: r.x + r.w + 48, y: r.y + 20 }, also },
    );
  });
  if (!card) return;
  if (isCode(card) && card.segments[0].src.kind === "free") requestViews(card.segments);
  closePop();
}
/** Note 拖到某一行 → Text sidenote；⌥ 拖代码卡到某一行 → Code sidenote */
export async function cardToSidenote(cardId: string, at: Anchor) {
  if (!(await C.cardToSidenote(commandEnv, cardId, at))) return;
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
  if (!C.putImageInNote(commandEnv, imageId, noteId, src, at)) return;
  select({ cards: [noteId] });
  toast("Added the image to the Note");
}

const peekLeave = boardTimer();
export function scheduleHidePeek() {
  peekLeave.start(() => {
    const p = pops().find((q) => !q.pinned && q.pop.kind === "peek");
    if (p && !document.querySelector(`.pop[data-pop="${p.id}"]:hover`)) closePop(p.id);
  }, tune("peekHide"));
}
export const cancelHidePeek = () => peekLeave.stop();
export async function showPeek(
  el: Element,
  cardId: string,
  segId: string,
  line: number,
  col: number,
  word: string,
  pin = false,
  at?: { path: string; line: number; col: number },
) {
  if (quietHover() && !pin) return;
  const c = cardById(cardId)?.card;
  const s = isCode(c) ? segOf(c, segId) : undefined;
  if (!s) return;
  const pid = openPop({ kind: "peek", card: cardId, seg: segId, line, word }, { el, prefer: "below" });
  if (pin) pinPop(pid);
  try {
    const r = await ask("peek", { seg: s, line, col, word, at });
    updatePop(pid, "peek", (p) => ({ ...p, data: r ?? { none: "No definition found", word } }));
  } catch {
    updatePop(pid, "peek", (p) => ({ ...p, data: { none: "No definition found", word } }));
  }
}

/** Mark 的颜色（它的箭头跟着变） */
export const setMarkColor = (id: string, hand: HandColor) => C.setMarkColor(commandEnv, id, hand);
export const setBoxFill = (id: string, fill: BoxFill) => C.setBoxFill(commandEnv, id, fill);

export const turnNote = (id: string, look: "note" | "text") => C.turnNote(commandEnv, id, look);

/** Split by Headings 能拆成几张卡（0 = 没有可拆的标题，菜单项灰掉） */
export function headingSplitCount(id: string): number {
  const c = cardById(id)?.card;
  return c?.kind === "note" && c.look === "note" ? (splitHeadings(c.md)?.parts.length ?? 0) : 0;
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
  const card = document.querySelector<HTMLElement>(`${cardSel(id)}`);
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
  if (editing()?.id === id) {
    setEditing(null);
    await cardsMeasured();
    return splitByHeadings(id);
  }
  const m = measureSplit(id, sp.cut, sp.parts.length);
  const p0 = { ...placeOf(id) };
  const others = state.board.cards.filter((k) => k.id !== id && state.board.place[k.id]).map((k) => rectOf(k));
  const made = C.splitByHeadings(commandEnv, id, {
    heights: m ? { root: m.root, parts: m.parts } : undefined,
    others,
  });
  if (!made) return;
  select({ cards: [id, ...made] });
  made.forEach((k, i) => popCard(k, { x: p0.x, y: p0.y + (m?.tops[i] ?? 40) }));
  toast(`Split into ${made.length} card${made.length > 1 ? "s" : ""}. ${IS_MAC ? "⌘Z" : "Ctrl+Z"} undoes it`);
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
  const nth = imageIndex(el, ref),
    src = ref.note,
    cap = imageCaption(liveNoteMd(ref.card) ?? c.md, src, nth);
  if (cap === null) return [];
  return [
    { label: cap ? "Edit Caption…" : "Add Caption…", run: () => void editCaption(ref.card, src, nth, cap) },
    ...(cap ? [{ label: "Remove Caption", run: () => setCaption(ref.card, src, nth, "") } as Item] : []),
  ];
}
async function editCaption(card: string, src: string, nth: number, cap: string) {
  const v = await promptText(cap ? "Edit Caption" : "Add Caption", cap, "Figure 1: …", cap ? "Save" : "Add", {
    text: "Shown under the image, like a figure caption; $…$ for math",
  });
  if (v !== null && v !== cap) setCaption(card, src, nth, v);
}
function setCaption(card: string, src: string, nth: number, cap: string) {
  // 正在编辑这张 Note：先存下编辑器里的字，再改图注（编辑器里的文档不跟着外面的改动走）
  if (editing()?.kind === "note" && editing()?.id === card) setEditing(null);
  const n = cardById(card)?.card;
  if (n?.kind === "note") C.setNoteMarkdown(commandEnv, card, setImageCaption(n.md, src, nth, cap));
}

/** 右键落在 Note 里的一张表格上（静态显示或编辑中）：它是这张 Note 的第几张表格（原样写的 HTML 里的表格不算，文档里没有它） */
export function noteTableAt(t: Element, card: string): number | null {
  const tb = t.closest("table"),
    face = tb?.closest(".cface");
  if (!tb || !face || cardById(card)?.card.kind !== "note" || tb.closest(".md-html")) return null;
  const i = [...face.querySelectorAll("table")].filter((x) => !x.closest(".md-html")).indexOf(tb);
  return i < 0 ? null : i;
}
/** Note 里一张表格的图注（表格后面的 "Table: …" 一行）：Add Caption… / Edit Caption…、Remove Caption */
export function tableCaptionItems(card: string, nth: number): Item[] {
  const c = cardById(card)?.card;
  if (c?.kind !== "note") return [];
  const cap = tableCaption(liveNoteMd(card) ?? c.md, nth);
  if (cap === null) return [];
  return [
    { label: cap ? "Edit Caption…" : "Add Caption…", run: () => void editTableCaption(card, nth, cap) },
    ...(cap ? [{ label: "Remove Caption", run: () => setTableCaptionOf(card, nth, "") } as Item] : []),
  ];
}
async function editTableCaption(card: string, nth: number, cap: string) {
  const v = await promptText(cap ? "Edit Caption" : "Add Caption", cap, "Table 1: …", cap ? "Save" : "Add", {
    text: "Shown under the table, like a table caption; $…$ for math",
  });
  if (v !== null && v !== cap) setTableCaptionOf(card, nth, v);
}
function setTableCaptionOf(card: string, nth: number, cap: string) {
  if (editing()?.kind === "note" && editing()?.id === card) setEditing(null);
  const n = cardById(card)?.card;
  if (n?.kind === "note") C.setNoteMarkdown(commandEnv, card, setTableCaption(n.md, nth, cap));
}
