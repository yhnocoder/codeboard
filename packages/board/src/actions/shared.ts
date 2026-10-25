// 多白板与共享卡：⌘C 记下卡、贴到别的白板（默认共享，⌥ 独立副本）、⌘X 剪下卡（这块白板上 ⌘V 原样放回）、「⧉ N boards」列表和跳转、
// Remove from This Board / Delete Everywhere / Unlink、共享卡 Update 先问范围、Sidenote 的 Board-only 和复查标记。
// 卡在几块白板上、谁连到它由宿主算好（state/store 的 shared），这里只读。
import { unwrap } from "solid-js/store";
import {
  bounds, cardTitle, isCode, placeCards, findFree, removeCards, unlinkCard, notesOnChangedLines, versionLabel, cardCopies,
  type Card, type CardCopy, type DiffData, type Link, type PastedCards, type SegView,
} from "@codeboard/core";
import { state, setState, mutate, sel, select, clearSel, cardById, hostOf, toast, flushSave, shared, sharedOn, rectOf } from "../state/store";
import { isHidden, settleHome } from "../state/sections";
import { camTo, camTarget, fitTop, isVisible } from "../state/camera";
import { ghostOut } from "../state/ghost";
import { openPop } from "../state/pop";
import { choose } from "../ui/Menu";
import { ask, send } from "../host";
import { hostRect, popCard, revealCard, selCards } from "./common";
import { cardText, remember } from "./edit";
import { updateSidenote } from "./notes";

// ---------- 复制 / 粘贴 ----------

/** ⌘C：选中的卡记到宿主（贴到别的白板时用），文字照旧写进剪贴板（代码卡 = 看得见的行，其他卡 = 内容 / 标题） */
export function copyCardsSel(): boolean {
  const cs = selHosts();
  if (!cs.length) return false;
  const text = copyCards(cs);
  const code = cs.length === 1 && isCode(cs[0]) ? text.split("\n").length : 0;
  toast(code ? `Copied ${code} lines · paste on another board for a linked card` : `Copied ${cs.length} card${cs.length > 1 ? "s" : ""}`);
  return true;
}
/** 选中的卡（Compare 的栏算它的 Compare），去重 */
const selHosts = () => selCards().map((c) => cardById(c.id)?.host ?? c).filter((c, i, a) => a.indexOf(c) === i);
/** 卡的文字进剪贴板，宿主记下是哪几张卡；返回文字 */
function copyCards(cs: Card[]): string {
  flushSave(); // 宿主那边是最新的内容
  const text = cs.map(textOf).join("\n\n");
  remember(cs[0].id, text); // 同一块白板上 ⌘V：放在原卡旁边
  navigator.clipboard?.writeText(text).catch(() => {});
  send({ type: "copyCards", cards: cs.map((c) => c.id), text });
  return text;
}

/** ⌘X 剪下的卡：内容、Sidenote、连着它们的箭头。这块白板上 ⌘V（剪贴板里还是这些字）时原样放回：同一个 id，箭头接回还在的卡 */
let cutClip: { board: string; text: string; cards: CardCopy[]; links: Link[]; views: Record<string, SegView> } | null = null;
/** ⌘X：复制 + 删除，一步撤销。看不见的卡（折叠起来的）不剪 */
export function cutCardsSel(): boolean {
  const cs = selHosts().filter((c) => !isHidden(c.id));
  if (!cs.length) return false;
  const ids = new Set(cs.map((c) => c.id));
  const b = unwrap(state.board);
  const cards = structuredClone(cardCopies(b, ids));
  const links = structuredClone(b.links.filter((l) => ids.has(l.from.card) || ids.has(l.to.card)));
  const views: Record<string, SegView> = {}, all = unwrap(state.views);
  for (const x of cards) if (x.card.kind === "code") for (const sg of x.card.segments) if (all[sg.id]) views[sg.id] = all[sg.id];
  const text = copyCards(cs);
  ghostOut(ids);
  if (!mutate((d) => removeCards(d, ids))) return true;
  cutClip = { board: state.board.id, text, cards, links, views };
  clearSel();
  toast(`Cut ${cs.length} card${cs.length > 1 ? "s" : ""}`);
  return true;
}
const norm = (t: string) => t.replace(/\r\n/g, "\n").trim();
/** ⌘V 在剪下它们的白板上：放回剪下的卡（都还不在白板上 = 原来的 id；再贴一次 = 副本）。text 为空 = 菜单里的 Paste，按宿主记的剪贴板 */
function pasteCut(text: string | undefined, at: { x: number; y: number }): boolean {
  const c = cutClip;
  if (!c || c.board !== state.board.id) return false;
  if (text !== undefined ? norm(text) !== norm(c.text) : state.host.clip?.board !== state.board.id) return false;
  const back = c.cards.every((x) => !cardById(x.card.id));
  const ids = putCards(c.cards, c.links, !back, at, c.views);
  if (ids) toast(back ? `Pasted ${ids.length} card${ids.length > 1 ? "s" : ""}` : `Pasted ${ids.length > 1 ? `${ids.length} copies` : "a copy"}`);
  return true;
}
function textOf(c: Card): string {
  if (isCode(c)) return cardText(c).join("\n");
  if (c.kind === "note") return c.md;
  if (c.kind === "web") return c.url;
  if (c.kind === "links") return c.items.map((i) => i.url).join("\n");
  if (c.kind === "compare") return c.cols.map((k) => { const x = cardById(k)?.card; return x ? textOf(x) : ""; }).join("\n\n");
  return cardTitle(c, state.board);
}

/** 粘贴默认做什么：设置里的 Paste onto Another Board；alt = ⌥ 粘贴，换成另一种 */
const pasteCopy = (alt: boolean) => (state.host.settings.pasteOther === "copy") !== alt;

/**
 * 粘贴：剪贴板里是别的白板上复制的卡（宿主核对文字）就放到这块白板上，返回 true；不是返回 false（照旧按文字粘贴）。
 * text 为空 = 不核对文字（菜单、⌥⌘V）
 */
export async function pasteFromBoard(text: string | undefined, at: { x: number; y: number }, alt = false): Promise<boolean> {
  if (pasteCut(text, at)) return true;
  const r = await ask("pasteCards", { text, copy: pasteCopy(alt) }).catch(() => null);
  if (!r) return false;
  placePasted(r, at);
  return true;
}

/** 贴过来的卡放在 at：几张卡之间的相对位置不变 */
export function placePasted(r: PastedCards, at: { x: number; y: number }) {
  const tops = r.cards.filter((x) => x.place);
  if (r.shared && tops.length && tops.every((x) => cardById(x.card.id))) {
    const id = tops[0].card.id;
    select({ cards: tops.map((x) => x.card.id) });
    revealCard(id);
    return toast("Already on this board");
  }
  const ids = putCards(r.cards, r.links, !r.shared, at, r.views);
  if (!ids) return;
  const n = ids.length;
  toast(r.shared ? `Pasted as linked card${n > 1 ? "s" : ""} · also on ${r.from}` : `Pasted ${n > 1 ? `${n} copies` : "a copy"} from ${r.from}`);
}
/**
 * 把卡放到指针 at 附近的空地上（一步撤销），组内的相对位置不变；落在哪个 Section 里（卡的中心，和拖卡同一个算法）就进哪个。
 * copy = 独立副本（新 id），否则原样放（同一个 id）。返回放下的卡（摆着的那几张），没有可放的返回 null
 */
function putCards(items: CardCopy[], links: Link[], copy: boolean, at: { x: number; y: number }, views: Record<string, SegView>): string[] | null {
  const tops = items.filter((x) => x.place);
  const box = bounds(tops.map((x) => ({ x: x.place!.x, y: x.place!.y, w: x.place!.w, h: (x.place!.h ?? 300) + 40 })));
  if (!box) return null;
  // 整组放在指针处附近的空地上（不压住别的卡），组内的相对位置不变
  const free = findFree({ ...box, x: at.x, y: at.y }, state.board.cards.filter((c) => state.board.place[c.id]).map((c) => rectOf(c)));
  const dx = Math.round(free.x - box.x), dy = Math.round(free.y - box.y);
  let ids: string[] = [], segs: Record<string, string> = {};
  mutate((b) => {
    const m = placeCards(b, items, { copy, links, at: (p) => ({ ...p, x: p.x + dx, y: p.y + dy }) });
    ids = tops.map((x) => m.cards[x.card.id]).filter(Boolean);
    segs = m.segs;
    for (const id of ids) settleHome(b, id);
  });
  setState("views", (v) => { const n = { ...v }; for (const [o, k] of Object.entries(segs)) if (views[o]) n[k] = views[o]; for (const [k, x] of Object.entries(views)) if (!segs[k]) n[k] = x; return n; });
  select({ cards: ids });
  requestAnimationFrame(() => {
    const u = bounds(ids.map((id) => hostRect(id)!).filter(Boolean));
    if (u && !isVisible(u)) { const f = fitTop(u, camTarget().z); camTo(f.x, f.y, f.z); }
    ids.forEach((id) => popCard(id));
  });
  return ids;
}

// ---------- 「⧉ N boards」 ----------

/** 卡头的徽标：列出它在哪几块白板上（各自的调用图标记），点一块跳过去并定位 */
export function showBoardsOf(id: string, el: Element) {
  if (sharedOn(id) < 2) return;
  openPop({ kind: "boards", card: id }, { el, prefer: "below" });
}
/** 去另一块白板上看这张卡（line = 闪那一行） */
export function openOnBoard(board: string, card: string, line?: number) {
  if (board === state.board.id) { select({ cards: [hostOf(card)] }); revealCard(card); return; }
  send({ type: "openBoard", id: board, card, line });
}
/** 「This card is on 3 boards: A, B, C.」 */
export function boardsText(id: string) {
  const bs = shared[id]?.boards ?? [];
  return `This card is on ${bs.length} boards: ${bs.map((b) => b.name).join(", ")}.`;
}

// ---------- 删除 ----------

/** 选中的卡里有在别的白板上也有的共享卡 */
export const selShared = () => sel.cards.map(hostOf).filter((id) => sharedOn(id) > 1);

/** Delete Everywhere…（⌘⌫）：问一下，从所有白板上删掉（这块白板上这一步能撤销，撤销回来是一份独立副本） */
export async function deleteEverywhere(ids = selShared()) {
  const id = ids[0];
  if (!id) return toast("Only linked cards on several boards can be deleted everywhere. Press ⌫ to delete.");
  const c = cardById(id)?.card;
  if (!c) return;
  const n = sharedOn(id);
  const ok = await choose(`Delete “${cardTitle(c, state.board)}” everywhere?`, ["Delete Everywhere", "Cancel"], {
    text: `${boardsText(id)} Its arrows and sidenotes go too, on every board.`, def: 1,
  });
  if (ok !== 0) return;
  ghostOut(new Set([id]));
  if (!mutate((b) => removeCards(b, [id]))) return;
  select({});
  const done = await ask("deleteEverywhere", { card: id }).catch((e: Error) => { toast(`Couldn't delete everywhere: ${e.message}`); return -1; });
  if (done >= 0) toast(`Deleted from ${Math.max(done, n)} boards`);
}

// ---------- Update ----------

/**
 * 共享卡 Update：先按设置决定范围（问 / 所有白板 / 只这块白板）。只这块白板 = 先拆成副本（别的白板留在旧版本），再更新。
 * 返回 false = 用户选了 Keep 或关掉了
 */
export async function updateScoped(cardId: string, segId: string, data: DiffData, apply: (card: string) => void, keep: () => void): Promise<boolean> {
  const n = sharedOn(cardId);
  if (n < 2 || !data.newSeg) { apply(cardId); return true; }
  let scope = state.host.settings.sharedUpdate;
  if (scope === "ask") {
    const c = cardById(cardId)?.card;
    const ns = { ...data.newSeg, id: segId };
    const hit = notesOnChangedLines(unwrap(state.board), cardId, ns).length;
    const i = await choose(`Update ${c ? cardTitle(c, state.board) : "this card"} to ${versionLabel(ns.version)}?`, ["Update on All Boards", "This Board Only", "Keep"], {
      text: boardsText(cardId),
      warn: hit ? `${hit} sidenote${hit > 1 ? "s are" : " is"} on a changed line` : undefined,
      note: "This Board Only makes a copy here, so the other boards keep the old version.",
    });
    if (i === null) return false;
    if (i === 2) { keep(); return false; }
    scope = i === 0 ? "all" : "this";
  }
  if (scope === "this") {
    let to = cardId;
    mutate((b) => { to = unlinkCard(b, cardId); });
    apply(to);
    select({ cards: [to] });
    return true;
  }
  apply(cardId);
  return true;
}

/** Update 时用的复查标签：新版本的短名 */
export const reviewLabel = (data: DiffData) => (data.newSeg ? versionLabel(data.newSeg.version) : "");

/** Update 后数一下要复查的 Sidenote，提示一下 */
export function reviewToast(cardId: string) {
  const n = state.board.sidenotes.filter((x) => x.at.card === cardId && x.review).length;
  return n ? ` · ${n} sidenote${n > 1 ? "s" : ""} on changed lines, check ${n > 1 ? "them" : "it"}` : "";
}

// ---------- Sidenote ----------

/** Board-only：共享卡上的这条 Sidenote 只留在这块白板（不跟着卡去别的白板），再点一次又跟着走 */
export function toggleBoardOnly(id: string) {
  updateSidenote(id, (n) => { n.boardOnly = n.boardOnly ? undefined : true; });
}
/** 看过了：去掉复查标记 */
export function markReviewed(id: string) {
  updateSidenote(id, (n) => { delete n.review; });
}
