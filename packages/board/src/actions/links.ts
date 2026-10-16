// 箭头（Link）：普通箭头、连接模式、标签、调用上的变量。
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
import { lastPointer } from "./common";

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
    if (l?.kind !== "call") return;
    const k = varKey(v);
    const has = (l.vars ?? []).some((x) => varKey(x) === k);
    l.vars = has ? l.vars!.filter((x) => varKey(x) !== k) : [...(l.vars ?? []), v];
    if (!l.vars.length) l.vars = undefined;
  });
}

