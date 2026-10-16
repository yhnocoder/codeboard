// 箭头（Link）：新建、连接模式、标签。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards, colsOf,
  placeChild, besideFree, findFree, bounds, center, contains, removeCards, rebaseSegment, walkOrder, reachable, SIB_GAP, GAP,
  copyText, cardRows, versionLabel, varKey, LANGS, classifyPaste, guessLang, estSize, defaultWidth,
  type Board, type Card, type CodeCard, type NoteCard, type CompareCard, type Link, type Section, type Sidenote, type Segment, type Place,
  type WebMeta, type CallSpan, type NewCard, type ExpandResult, type Var, type Rect, type DiffData, type Commit, type SegView, type Anchor, type PeekResult, type KeyAction,
} from "@codeboard/core";
import {
  state, setState, mutate, live, createFresh, isFresh, settleFresh, sel, select, clearSel, lineSel, setLineSel, isSel, cardById, rectOf, sizes, toast, allIds, placeOf, placed,
  type LineSel,
} from "../state/store";
import { camTo, camTarget, ensureVisible, fitRect, fitTop, isVisible, union, viewportCenter, view, toWorld, zoomAt, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, flash, ping, setEditing, setPopIn, popIn, setWalk, walk, setConnectFrom, setPaletteOpen, toggleShown, setKeysOpen } from "../state/ui";
import { openMenu, choose, promptText, type Item } from "../ui/Menu";
import { openPop, closePop, pops, updatePop, pinPop, type At } from "../state/pop";
import { send, ask } from "../host";
import { md, inline } from "../md";
import { frameOf } from "../state/sections";
import { lastPointer } from "./common";

// ---------- Plain link ----------

type EndRef = { card: string; seg?: string; line?: number };

/** 新箭头：两端各是整张卡或某一行，数量不限 */
export function addPlain(from: EndRef, to: EndRef) {
  if (cardById(from.card)?.host.id === cardById(to.card)?.host.id && from.line === to.line) return;
  const id = uid("l");
  mutate((b) => { b.links.push({ id, kind: "plain", from, to }); });
  return id;
}
export function startConnect(id: string) {
  setConnectFrom({ card: id });
  toast("Click a card to connect · Esc to cancel");
}
export const setLinkEditing = (id: string) => { select({ links: [id] }); setEditing({ kind: "label", id }); };
export function setLinkLabel(id: string, v: string) {
  mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) l.label = v.trim() || undefined; });
}

