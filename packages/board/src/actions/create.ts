// 建卡：宿主建好的卡放到白板上、Note / Text / Image / Web / Code、粘贴、选区拆成几张卡。
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
import { hostRect, popCard } from "./common";
import { fetchMeta, newLinkList } from "./web";

/** 新代码卡按设置默认隐藏注释 / 文档字符串 / 空行（卡上已经有设定的不动） */
function withDefaults(c: Card): Card {
  const h = state.host.settings?.hideOnNew;
  if (c.kind === "code" && !c.hide && h && (h.comments || h.docstrings || h.blank)) c.hide = { ...h };
  return c;
}

/** 把宿主建好的卡放到白板上：有选中的卡就放旁边，没有就放视口中央 */
export function addCards(list: NewCard[], o: { at?: { x: number; y: number }; besideSel?: boolean; section?: string } = {}) {
  if (!list.length) return [];
  setState("views", (v) => ({ ...v, ...Object.assign({}, ...list.map((n) => n.views)) }));
  const ids: string[] = [];
  const anchor = o.besideSel !== false && sel.cards.length ? hostRect(sel.cards[sel.cards.length - 1]) : null;
  mutate((b) => {
    let prev: Rect | null = anchor;
    for (const n of list) {
      const c = withDefaults(structuredClone(n.card) as Card);
      const w = n.w ?? defaultWidth(c);
      const size = estSize(c, { w });
      let p: { x: number; y: number };
      const others = b.cards.filter((k) => b.place[k.id]).map((k) => rectOf(k));
      if (o.at) p = findFree({ ...o.at, ...size }, others);
      else if (prev) p = besideFree(prev, size, others);
      else { const vc = viewportCenter(); p = findFree({ x: vc.x - size.w / 2, y: vc.y - Math.min(size.h, 300) / 2, ...size }, others); }
      const pl: Place = { x: Math.round(p.x), y: Math.round(p.y), w };
      if (o.section) pl.section = o.section;
      b.cards.push(c);
      b.place[c.id] = pl;
      ids.push(c.id);
      prev = { x: pl.x, y: pl.y, ...size };
    }
  });
  select({ cards: ids });
  requestAnimationFrame(() => {
    const rs = ids.map((id) => hostRect(id)!).filter(Boolean);
    const u = bounds(rs);
    if (u && !isVisible(u)) { const f = fitTop(u, camTarget().z); camTo(f.x, f.y, f.z); }
    ids.forEach((id) => popCard(id));
  });
  return ids;
}

export function newNote(at?: { x: number; y: number }, bg = true, text = "") {
  const p = at ?? (() => { const v = viewportCenter(); return { x: v.x - 140, y: v.y - 40 }; })();
  const id = uid("n");
  const add = (b: Board) => { b.cards.push({ id, kind: "note", md: text, bg, size: "body" }); b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w: bg ? 280 : 320 }; };
  if (text) mutate(add); else createFresh(id, add); // 空卡：写了内容才进撤销栈，什么都没写就消失
  select({ cards: [id] });
  if (!text) setEditing({ kind: "note", id });
  popCard(id);
  return id;
}
export async function newImage(at?: { x: number; y: number }) {
  const dataUrl = await ask<string | null>("pickFile", { kind: "image" }).catch(() => null);
  if (!dataUrl) return;
  return addImage(dataUrl, "image.png", at);
}
export async function addImage(dataUrl: string, name: string, at?: { x: number; y: number }) {
  const file = await ask<string>("saveAsset", { name, dataUrl }).catch(() => null);
  const src = file ?? dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  const w = Math.min(480, Math.max(160, img.naturalWidth || 320));
  const id = uid("i");
  addCards([{ card: { id, kind: "image", src }, views: {}, w }], { at });
  return id;
}
export async function newWeb(at?: { x: number; y: number }, url?: string) {
  url = url ?? (await promptText("Add Web Link", "", "https://…", "Add")) ?? undefined;
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  const id = uid("w");
  addCards([{ card: { id, kind: "web", url }, views: {} }], { at });
  fetchMeta(id, url);
}
export function newFreeCode(at?: { x: number; y: number }, text = "", lang = "python", url?: string) {
  const sid = uid("s");
  const seg: Segment = { id: sid, src: { kind: "free", url }, path: "", lang, start: 1, end: Math.max(1, text.split("\n").length), text: text ? text.split("\n") : [""], version: { kind: "none" } };
  const id = uid("c");
  if (text) {
    addCards([{ card: { id, kind: "code", segments: [seg] }, views: {}, w: 480 }], { at });
  } else {
    // 空卡：写了代码才进撤销栈，什么都没写就消失
    const p = at ?? (() => { const v = viewportCenter(); return { x: v.x - 240, y: v.y - 60 }; })();
    createFresh(id, (b) => { b.cards.push({ id, kind: "code", segments: [seg] }); b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w: 480 }; });
    select({ cards: [id] });
    popCard(id);
  }
  requestViews([seg]);
  if (!text) setEditing({ kind: "free", id });
  return id;
}

/** 白板自己生成的段（合并、Free code 改动）找宿主要高亮 */
export async function requestViews(segs: Segment[]) {
  if (!segs.length) return;
  const v = await ask<Record<string, SegView>>("views", { segs: unwrap(segs).map((s) => structuredClone(unwrap(s))) }).catch(() => null);
  if (v) setState("views", (o) => ({ ...o, ...v }));
}


// ---------- 粘贴 ----------

export async function pasteText(text: string, at?: { x: number; y: number }) {
  if (!text.trim()) return;
  const k = classifyPaste(text);
  if (k.kind === "web") return newWeb(at, k.url);
  if (k.kind === "links") return newLinkList(k.urls, at);
  if (k.kind === "note") return newNote(at, true, text);
  // 代码：先问宿主是不是工作区里的代码 / GitHub 链接
  let err = "";
  const r = await ask<NewCard | null>("paste", { text }).catch((e) => { err = (e as Error).message; return null; });
  if (r) return addCards([r], { at });
  // GitHub 文件拿不到（离线、私有仓库没登录）：先留一张书签，链接不丢
  if (k.kind === "github") { toast(`Could not fetch this GitHub file${err ? `: ${err}` : ""}`); return newWeb(at, text.trim()); }
  newFreeCode(at, text.replace(/\s+$/, ""), guessLang(text) ?? "python");
}


/** 选中的片段跨了几个顶层函数：按函数拆成几张卡，或一张多段卡 */
export function splitSnippet(id: string, merge: boolean) {
  const c = cardById(id)?.card;
  if (!isCode(c) || c.segments.length !== 1) return;
  const s = c.segments[0];
  const defs = (state.views[s.id]?.defs ?? []).filter((d) => d.line >= s.start && d.line <= s.end);
  const tops = defs.filter((d) => !defs.some((o) => o !== d && d.qual.startsWith(o.qual + ".")));
  if (tops.length < 2) return;
  const parts: Segment[] = tops.map((d, i) => {
    const a = i === 0 ? s.start : d.line, e = i + 1 < tops.length ? tops[i + 1].line - 1 : s.end;
    return { ...structuredClone(unwrap(s)), id: uid("s"), start: a, end: e, text: s.text.slice(a - s.start, e - s.start + 1), symbol: { qual: d.qual, kind: "function" as const }, scope: d.qual, hidden: undefined, hl: undefined };
  });
  if (merge) {
    mutate((b) => { const k = findCard(b, id)?.card; if (isCode(k)) k.segments = parts; });
  } else {
    const r = hostRect(id)!;
    const pl = placeOf(id);
    mutate((b) => {
      b.cards = b.cards.filter((k) => k.id !== id);
      delete b.place[id];
      let y = r.y;
      for (const p of parts) {
        const k: CodeCard = { id: uid("c"), kind: "code", segments: [p] };
        b.cards.push(k);
        b.place[k.id] = { x: r.x, y, w: r.w, section: pl.section };
        y += estSize(k, { w: r.w }).h + GAP;
      }
    });
  }
  requestViews(parts);
}

