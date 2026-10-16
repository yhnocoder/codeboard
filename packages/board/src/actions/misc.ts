// 其他：宿主转来的快捷键、导出 PNG、点选一张卡、Search Workspace、工作区 diff。
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
import { duplicateSel, toggleLock } from "./edit";
import { fitAll, lastPointer, openCode } from "./common";
import { toggleSettings, openSettings } from "./settings";

export { toggleShown, setKeysOpen, zoomAt, view, center, contains };

export const currentLineSel = () => lineSel();


/** 宿主转来的快捷键（VS Code 会先拦下这些键） */
export function keyAction(a: KeyAction) {
  switch (a) {
    case "search": return setPaletteOpen({ mode: "all" });
    case "duplicate": return duplicateSel();
    case "fitAll": return fitAll();
    case "zoom100": return zoomAt(1 / camTarget().z);
    case "zoomIn": return zoomAt(1.25);
    case "zoomOut": return zoomAt(0.8);
    case "lock": return toggleLock(sel.cards.slice(), sel.sections.slice());
    case "settings": return toggleSettings();
    case "openSettings": return openSettings();
  }
}


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


