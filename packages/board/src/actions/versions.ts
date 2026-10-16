// 版本：新版本提示、diff、Update / Keep、commit 列表、切换 commit。
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
import { addCards } from "./create";
import { hostRect, lastPointer, revealCard } from "./common";

// ---------- 版本 ----------

/** 卡片标题上的版本点：changed = 黄点；hidden = 只有隐藏的行变了（空心点） */
export function cardStale(c: CodeCard): "changed" | "hidden" | "lost" | "missing" | null {
  let hidden = false;
  for (const s of c.segments) {
    const st = state.stale[s.id];
    if (!st) continue;
    if (st.state === "changed" && s.keep && st.head.startsWith(s.keep)) continue;
    if (st.state === "changed") { if (!st.hiddenOnly) return "changed"; hidden = true; }
    if ((st.state === "lost" || st.state === "many") && !c.keepOld) return "lost";
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
  mutate((b) => rebaseSegment(b, cardId, ns));
  if (data.newView) setState("views", segId, data.newView);
  setState("stale", segId, { state: "ok" });
  toast("Updated to the new version");
}
/** Keep：留在钉住的版本，记下这次的 HEAD，同一个新版本不再提醒 */
export function keepVersion(cardId: string, segId: string) {
  const st = state.stale[segId];
  const head = st?.state === "changed" ? st.head : undefined;
  if (head) mutate((b) => { const c = findCard(b, cardId)?.card; if (isCode(c)) { const s = c.segments.find((q) => q.id === segId); if (s) s.keep = head; } });
  else setState("stale", segId, { state: "ok" });
}
/** 横幅里的 Update All：每段都取 diff 再更新，跟一张张点 Update 一样 */
export async function updateAll() {
  const todo: [string, Segment][] = [];
  for (const c of allCodeCards(state.board)) if (cardStale(c) === "changed") for (const s of c.segments) if (state.stale[s.id]?.state === "changed") todo.push([c.id, s]);
  let n = 0;
  for (const [cid, s] of todo) {
    try {
      const data = await ask<DiffData>("diff", { seg: structuredClone(unwrap(s)) });
      if (data.canUpdate) { applyNewVersion(cid, s.id, data); n++; }
    } catch { /* 这张跳过 */ }
  }
  toast(n === todo.length ? `Updated ${n} card${n === 1 ? "" : "s"}` : `Updated ${n} of ${todo.length}; open the others to review`);
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


/** Relocate 之后宿主送来新段（同一个 id）：换掉旧段，行号跟过去，状态回到正常 */
export function replaceSegment(cardId: string, seg: Segment, view: SegView) {
  setState("views", seg.id, view);
  setState("stale", seg.id, { state: "ok" });
  mutate((b) => rebaseSegment(b, cardId, seg));
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

