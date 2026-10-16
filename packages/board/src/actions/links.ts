// 箭头（Link）：普通箭头、连接模式、标签、调用上的变量。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards, colsOf,
  placeChild, besideFree, findFree, bounds, center, contains, canAttach, canExpand, canCompare, removeCards, rebaseSegment, walkOrder, treeOf, descendants, SIB_GAP, GAP,
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
import { lastPointer } from "./common";
import { attachCall, calleeMatches } from "./flow";

// ---------- Plain link ----------

type EndRef = { card: string; seg?: string; line?: number };

/** 这条箭头其实是调用：从代码行连到「这一行调用的函数」所在的卡（#28：只有一种 Arrow，是不是调用自动判断） */
export function callOn(from: EndRef, to: EndRef): CallSpan | undefined {
  if (from.line === undefined || !from.seg || to.line !== undefined) return;
  const t = cardById(to.card)?.card;
  if (!isCode(t) || !isCode(cardById(from.card)?.card)) return;
  return state.views[from.seg]?.calls.find((c) => c.line === from.line && calleeMatches(t, c));
}

/** 新箭头：是调用就建 Call link（编号、Walkthrough、变量），否则普通箭头 */
export function addPlain(from: EndRef, to: EndRef) {
  if (cardById(from.card)?.host.id === cardById(to.card)?.host.id && from.line === to.line) return;
  const call = callOn(from, to);
  if (call && canAttach(state.board, flows(), from.card, to.card).ok) return void attachCall(from.card, from.seg!, call, to.card);
  const id = uid("l");
  mutate((b) => { b.links.push({ id, kind: "plain", from, to }); });
  return id;
}
/** 普通箭头后来能认出是调用（V03 默认不自动转）：箭头上出 Make Call，点了才转 */
export function makeCall(id: string) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || L.kind !== "plain") return;
  const call = callOn(L.from, L.to);
  if (!call) return;
  const ok = canAttach(state.board, flows(), L.from.card, L.to.card);
  if (!ok.ok) return toast(ok.reason);
  mutate((b) => {
    const i = b.links.findIndex((l) => l.id === id);
    if (i >= 0) b.links[i] = { id, kind: "call", from: { ...L.from }, to: { card: L.to.card }, label: L.label, call: { name: call.name, col: call.col }, loop: call.loop || undefined };
  });
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
    if (l?.kind !== "call") return;
    const k = varKey(v);
    const has = (l.vars ?? []).some((x) => varKey(x) === k);
    l.vars = has ? l.vars!.filter((x) => varKey(x) !== k) : [...(l.vars ?? []), v];
    if (!l.vars.length) l.vars = undefined;
  });
}

