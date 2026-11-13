import { unwrap } from "solid-js/store";
import {
  isCode,
  segOf,
  splitHeadings,
  NEW_CARD_W,
  type NewSidenote,
  type SearchItem,
  type SegView,
  type Anchor,
  type BoxFill,
  type TextSize,
  type HlRange,
  isTextCard,
  sameRange,
  shownRanges,
  within,
  freeAt,
  spotKey,
  spotOf,
} from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { state, cardById, hostOf, rectOf, placeOf } from "../state/store";
import { sel, select, clearSel, lineSel } from "../state/selection";
import { toast } from "../state/toast";
import { IS_MAC } from "@yhnocoder/markdown/ui";
import { editing, liveNoteMd, setEditing } from "../state/ui";
import { cardsMeasured } from "../state/measure";
import { fitMeasure } from "./fit";
import { noteImageOf } from "./imagedata";
import { promptText, type Item } from "../ui/Menu";
import {
  imageCaption,
  setImageCaption,
  setImagePlayback,
  setTableCaption,
  tableCaption,
  type ImagePlayback,
} from "@yhnocoder/markdown";
import { noteImageAt, type ImgRef } from "./imageai";
import { openPop, closePop, pops, updatePop, pinPop, type OpenFor } from "../state/pop";
import { ask, switched } from "../host";
import { addCards } from "./create";
import { removedNotes } from "./edit";
import { requestViews, putViews } from "../state/views";
import { tune } from "../state/tune";
import { hostRect, popCard } from "./common";
import { lastPointer } from "../state/measure";
import { attrSel, cardSel } from "../cardsel";
import { boardTimer } from "../state/root";
import { cam, camRest, camTarget, ensureVisible, toWorld, viewTracked } from "../state/camera";
import { aimBlock, blockBandNow, hoverBlock, noteBlockOf } from "../state/blocks";
import type { SpotAim } from "../ui/SnBadge";

/** A click on a sidenote badge: the popup of its spot opens and stays, or closes when it is open */
export function pinMarker(el: Element, spot: Anchor) {
  const key = spotKey(spot);
  const same = pops().find((p) => p.pop.kind === "notes" && spotKey(p.pop.spot) === key);
  if (same) return closePop(same.id);
  openSpot(spot, {}, el);
}

/** A context menu opens on a code card's lines: only the menu shows; a Highlight popup open closes */
export function menuOverHighlights() {
  for (const p of pops()) if (p.pop.kind === "highlight") closePop(p.id);
}
/** A click on a Highlight's gutter area or marker: its popup opens and stays, or closes when it is open */
export function pinHighlight(card: string, seg: string, lines: HlRange) {
  const same = pops().find(
    (p) => p.pop.kind === "highlight" && p.pop.card === card && p.pop.seg === seg && sameRange(p.pop.lines, lines),
  );
  if (same) return closePop(same.id);
  const el = document.querySelector(`.hxhit${attrSel("data-hl", highlightKey(card, seg, lines))}`);
  if (el) pinPop(openPop({ kind: "highlight", card, seg, lines: [lines[0], lines[1]] }, { el, prefer: "beside" }));
}
/** The key a Highlight's gutter area (.hxhit) carries in data-hl: where its popup finds it */
export const highlightKey = (card: string, seg: string, lines: HlRange) => `${card}:${seg}:${lines[0]}-${lines[1]}`;
/** Remove Highlight (its popup): the lines and the sidenotes on them, one undo step */
export function removeHighlight(card: string, seg: string, lines: HlRange) {
  removedNotes(C.removeHighlight(commandEnv, card, seg, lines, fitMeasure));
}
/** Delete in a spot's sidenote popup (a whole card, a Note's block, a Section, a point): those sidenotes, one undo step */
export function deleteSpotNotes(spot: Anchor) {
  removedNotes(C.deleteSpotSidenotes(commandEnv, spot), "card");
}

/**
 * Add Sidenote: the popup of what it goes on, pinned, its input ready. On lines: the popup of the Highlight they are in (of the
 * lines alone when they are in none yet); elsewhere (a whole card, a Note's block, a Section, a point on the canvas) the popup of
 * that spot. ask: the input starts as a question
 */
export function openAddNote(at: Anchor, o: { ask?: boolean } = {}) {
  const ask = o.ask ? { ask: true as const } : {};
  if (at.card === undefined || !at.seg || !at.lines) {
    openSpot(at, { write: true, ...ask });
    return;
  }
  const write: HlRange = [at.lines[0], at.lines[1]];
  const hl = highlightOf(at.card, at.seg, write);
  const same = pops().find(
    (p) => p.pop.kind === "highlight" && p.pop.card === at.card && p.pop.seg === at.seg && sameRange(p.pop.lines, hl),
  );
  if (same) closePop(same.id);
  const el =
    document.querySelector(`.hxhit${attrSel("data-hl", highlightKey(at.card, at.seg, hl))}`) ??
    document.querySelector(`${cardSel(at.card)} .gutter .no.sel`) ??
    document.querySelector(cardSel(hostOf(at.card)));
  const id = openPop(
    { kind: "highlight", card: at.card, seg: at.seg, lines: [hl[0], hl[1]], write, ...ask },
    el ? { el, prefer: "beside" } : lastPointer(),
  );
  pinPop(id);
}
/** The Highlight shown on a segment that holds these lines, else the lines themselves */
function highlightOf(card: string, seg: string, lines: HlRange): HlRange {
  const c = cardById(card)?.card,
    s = isCode(c) ? segOf(c, seg) : undefined;
  return (s && shownRanges(state.board, s).find((r) => within(lines, r))) ?? lines;
}
/** The pinned popup of the sidenotes at a spot, beside what shows it: its badge, else the block, the Section's title, the card, or
 *  (a free spot with no badge yet) the point */
function openSpot(spot: Anchor, o: OpenFor, el?: Element) {
  const at = spotOf(spot);
  if (!at) return;
  const key = spotKey(at);
  const same = pops().find((p) => p.pop.kind === "notes" && spotKey(p.pop.spot) === key);
  if (same) closePop(same.id);
  const near =
    el ??
    document.querySelector(`[data-spot]${attrSel("data-spot", key)}`) ??
    (at.card !== undefined && at.block ? noteBlockOf(at.card, at.block)?.el : undefined) ??
    (at.section !== undefined ? document.querySelector(`.slabel${attrSel("data-sect", at.section)}`) : undefined) ??
    (at.card !== undefined ? document.querySelector(cardSel(hostOf(at.card))) : undefined);
  const f = freeAt(at) ? at : undefined;
  pinPop(
    openPop(
      { kind: "notes", spot: at, ...o },
      near ? { el: near, prefer: "beside" } : f ? toScreen(f.x, f.y) : lastPointer(),
    ),
  );
}
/** World point → where it is on screen */
const toScreen = (x: number, y: number) => ({ x: x * cam.z + cam.x, y: y * cam.z + cam.y });
/** A question resolved (true) or open again; only the user's check does this */
export const setQuestionDone = (id: string, done: boolean) => C.setQuestionDone(commandEnv, id, done);
/** A reply under a question; returns its id */
export const addAnswer = (id: string, md: string) => C.addAnswer(commandEnv, id, md);
/** An answer's Markdown; written empty it goes */
export const writeAnswer = (id: string, answer: string, md: string) => C.writeAnswer(commandEnv, id, answer, md);
/** A question picked in the question list: the camera goes to where it is, and its popup opens there with the question shown */
export async function goToQuestion(id: string) {
  const n = state.board.sidenotes.find((k) => k.id === id);
  if (!n) return;
  for (const q of pops()) if (q.pop.kind === "notes" || q.pop.kind === "highlight") closePop(q.id);
  const at = n.at;
  const sec = at.section !== undefined ? state.board.sections.find((x) => x.id === at.section) : undefined;
  const r =
    at.card !== undefined
      ? hostRect(at.card)
      : sec
        ? { x: sec.x, y: sec.y, w: sec.w, h: Math.min(sec.h, 120) }
        : freeAt(at)
          ? { x: at.x - 20, y: at.y - 20, w: 40, h: 40 }
          : undefined;
  if (r) {
    const z = camTarget().z;
    // room on its right for the popup; a narrow window has none, the popup goes where it fits there anyway
    const room = viewTracked().w < 700 ? 0 : 500;
    ensureVisible(r, { x: r.x + r.w, y: r.y, w: room / z, h: Math.min(r.h, 320 / z) });
    await camRest();
  }
  if (at.card !== undefined && at.seg && at.lines) {
    const hl = highlightOf(at.card, at.seg, at.lines);
    const el = document.querySelector(`.hxhit${attrSel("data-hl", highlightKey(at.card, at.seg, hl))}`);
    if (!el) return;
    pinPop(
      openPop(
        { kind: "highlight", card: at.card, seg: at.seg, lines: [hl[0], hl[1]], focus: id },
        { el, prefer: "beside" },
      ),
    );
  } else openSpot(at, { focus: id });
}
/**
 * Add Sidenote from the keyboard (S): on the lines selected; on the one card selected (a Note: the block the pointer is on, its two
 * dots showing, else the whole Note); on the one Section selected; else free on the canvas where the pointer is
 * @public run from the key table (keymap.ts)
 */
export function addSidenoteUI() {
  const ls = lineSel();
  if (ls) return openAddNote({ card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] });
  if (sel.cards.length === 1) {
    const id = sel.cards[0],
      h = hoverBlock();
    return openAddNote(h?.card === id ? { card: id, block: { ...h.ref } } : { card: id });
  }
  if (sel.sections.length === 1 && !sel.cards.length) return openAddNote({ section: sel.sections[0] });
  const p = lastPointer(),
    w = toWorld(p.x, p.y);
  openAddNote({ x: Math.round(w.x), y: Math.round(w.y) });
}
/** A free badge starts moving: a popup open on a free spot closes (its spot is about to change) */
export function freeDragStart() {
  for (const q of pops()) if (q.pop.kind === "notes" && freeAt(q.pop.spot)) closePop(q.id);
}
/** What a free badge dragged to this point would sit on: a card under it, or the block of a Note's body under it (with where that
 *  block is in the card, for its tint); null over the canvas */
export function spotAim(clientX: number, clientY: number): SpotAim | null {
  const under = document.elementsFromPoint(clientX, clientY).filter((e) => !e.closest(".snb, .pop"));
  const card = under.map((e) => e.closest<HTMLElement>(".card[data-id]")).find(Boolean);
  const id = card?.dataset.id;
  if (!card || !id) return null;
  if (under.some((e) => e.closest(".nbody") && e.closest(".card") === card)) {
    const a = aimBlock(id, clientY);
    if (a) return { card: id, block: { ...a.ref }, band: blockBandNow(a) };
  }
  return { card: id };
}
/** A free sidenote's badge dragged: to another point, or dropped onto a card or a Note's block (aim, spotAim), where it then sits */
export function dropFreeNotes(ids: string[], aim: SpotAim | null, worldX: number, worldY: number) {
  freeDragStart();
  C.moveFreeSidenotes(
    commandEnv,
    ids,
    aim
      ? aim.block
        ? { card: aim.card, block: aim.block }
        : { card: aim.card }
      : { x: Math.round(worldX), y: Math.round(worldY) },
  );
}
export function addSidenote(n: NewSidenote, view?: SegView) {
  if (n.kind === "code" && view) putViews({ [n.code.id]: view });
  return C.addSidenotes(commandEnv, [n], fitMeasure)[0];
}
/** A Code sidenote at `at` of the code a search found (item): false when it could not be read (said) or the board switched */
export async function addCodeSidenote(at: Anchor, item: SearchItem): Promise<boolean> {
  const r = await ask("searchPick", { item, alt: true }).then(
    (v) => v ?? null,
    (e) => (switched(e) ? undefined : null),
  );
  if (r === undefined) return false;
  const c = r?.card;
  if (!c || !isCode(c)) {
    toast("Could not read that code");
    return false;
  }
  const seg = c.segments[0];
  addSidenote({ kind: "code", code: seg, at }, r.views[seg.id]);
  return true;
}
/** 一次加好几条（一个撤销步骤），返回新 id */
export const addSidenotes = (list: NewSidenote[]) => C.addSidenotes(commandEnv, list, fitMeasure);
/** A Text sidenote's Markdown; written empty it goes */
export const writeSidenote = (id: string, md: string) => C.writeSidenote(commandEnv, id, md, fitMeasure);
export const toggleAlwaysShow = (id: string) => C.toggleAlwaysShow(commandEnv, id, fitMeasure);
export const deleteSidenote = (id: string) => C.deleteSidenote(commandEnv, id, fitMeasure);
/** Place on Board：Sidenote 变成卡，放在源卡旁边，自动连一条箭头（从原来挂的那一行连出） */
export function placeSidenote(id: string) {
  const n = state.board.sidenotes.find((k) => k.id === id);
  if (n?.at.card === undefined) return;
  const r = hostRect(n.at.card);
  if (!r) return;
  // 放卡、去掉 Sidenote、连箭头是同一步（一次撤销）
  const card = C.sidenoteOnBoard(commandEnv, id, (card, n, also) => {
    const views: Record<string, SegView> = {};
    if (n.kind === "code" && isCode(card) && state.views[n.code.id])
      views[card.segments[0].id] = state.views[n.code.id];
    addCards(
      [
        {
          card,
          views,
          w: card.kind === "note" || (isCode(card) && card.segments[0].src.kind === "free") ? NEW_CARD_W : 480,
        },
      ],
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

export const setBoxFill = (id: string, fill: BoxFill) => C.setBoxFill(commandEnv, id, fill);
export const setTextSize = (id: string, size: TextSize) => C.setTextSize(commandEnv, id, size);

/** Text ↔ Box: the text stays where it is on the board (its first line, its size, where it wraps); only the box around it comes
 *  or goes */
export function setTextLook(id: string, look: "text" | "box") {
  const c = cardById(id)?.card,
    el = document.querySelector<HTMLElement>(cardSel(id));
  if (!isTextCard(c) || c.look === look) return;
  C.setTextLook(commandEnv, id, look, el ? keptAt(el, id, look, !!c.wrap) : undefined);
}
/**
 * Where a Text or Box goes in the other look, and how wide it is, for its first line to stay where it is: the card is laid out once
 * more in that look, as a hidden copy beside it, and its first character found in both. One that wraps keeps the width its text
 * wraps at; a Box centres its lines, so the first line's place in it depends on the others
 */
function keptAt(el: HTMLElement, id: string, look: "text" | "box", wrap: boolean) {
  const p = placeOf(id),
    twin = el.cloneNode(true) as HTMLElement;
  twin.removeAttribute("data-id");
  twin.classList.toggle("box", look === "box");
  twin.style.visibility = "hidden";
  el.after(twin);
  try {
    const sides = (e: HTMLElement) => {
      const s = getComputedStyle(e);
      return ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce(
        (n, k) => n + parseFloat(s[k as "paddingLeft"]),
        0,
      );
    };
    const w = wrap ? el.offsetWidth - sides(el) + sides(twin) : p.w;
    if (wrap) twin.style.width = `${w}px`;
    const a = firstGlyph(el),
      b = firstGlyph(twin);
    if (!a || !b) return undefined;
    const ra = el.getBoundingClientRect(),
      rb = twin.getBoundingClientRect(),
      k = el.offsetWidth / ra.width || 1;
    return {
      x: p.x + (a.left - ra.left - (b.left - rb.left)) * k,
      y: p.y + (a.top - ra.top - (b.top - rb.top)) * k,
      w,
    };
  } finally {
    twin.remove();
  }
}
/** The box of the first character a card's text shows (screen pixels); its text's own box when it shows no characters (only an
 *  image) */
function firstGlyph(card: HTMLElement): DOMRect | null {
  const body = card.querySelector<HTMLElement>(":scope > .cface > .tx");
  if (!body) return null;
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const at = n.data.search(/\S/);
    if (at < 0) continue;
    const r = document.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + 1);
    const box = r.getClientRects()[0];
    if (box) return box;
  }
  return body.getBoundingClientRect();
}

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
/** An animated image's snapshot frame or always-play, into its Note's Markdown ({frame=N loop=true}; md/anim.ts) */
export function setImagePlaybackIn(card: string, src: string, nth: number, p: ImagePlayback) {
  const n = cardById(card)?.card;
  if (n?.kind !== "note" || editing()?.id === card) return;
  const md = setImagePlayback(n.md, src, nth, p);
  if (md !== n.md) C.setNoteMarkdown(commandEnv, card, md);
}
/** The same for an image card: its frame and loop fields */
export function setCardPlayback(card: string, p: ImagePlayback) {
  if (p.loop !== undefined) C.setImageLoop(commandEnv, card, p.loop, p.frame);
  else if (p.frame !== undefined) C.setImageFrame(commandEnv, card, p.frame);
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
