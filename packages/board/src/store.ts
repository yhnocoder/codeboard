import { createStore, produce, reconcile } from "solid-js/store";
import { createSignal, createEffect, on } from "solid-js";
import {
  steps as stepsOf, type Board, type BoardMeta, type Card, type CardView, type CodeCard, type Edge, type HostToBoard, type NewCodeCard,
} from "@codeboard/core";
import { send } from "./host";

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const [state, setState] = createStore({
  loaded: false,
  board: { id: "", name: "", cards: [], edges: [], cam: { x: 120, y: 120, z: 1 }, version: 1 } as Board,
  boards: [] as BoardMeta[],
  views: {} as Record<string, CardView>,
  selected: null as null | { kind: "card" | "edge"; id: string },
  diff: null as null | Extract<HostToBoard, { type: "diff" }>,
  present: null as null | number,
});

// 卡片实际渲染尺寸（世界坐标），由 ResizeObserver 写入
export const [sizes, setSizes] = createStore<Record<string, { w: number; h: number }>>({});

export const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: number | undefined;
export function say(msg: string) {
  setToast(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToast(null), 2400);
}

// ---------- 保存：任何改动 400ms 后整板发给宿主 ----------

let saveTimer: number | undefined;
let suppressSave = false;
export function installAutosave() {
  createEffect(on(() => JSON.stringify(state.board), () => {
    if (!state.loaded || suppressSave) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => send({ type: "save", board: JSON.parse(JSON.stringify(state.board)) }), 400);
  }, { defer: true }));
}

// ---------- 宿主消息 ----------

export function onHost(m: HostToBoard) {
  switch (m.type) {
    case "load":
      suppressSave = true;
      setState({ board: m.board, boards: m.boards, views: m.views, loaded: true, selected: null, present: null, diff: null });
      queueMicrotask(() => (suppressSave = false));
      applyMoves();
      break;
    case "views":
      setState("views", reconcile({ ...state.views, ...m.views }));
      applyMoves();
      break;
    case "addCode":
      addCodeCard(m.card, m.view, m.from);
      break;
    case "followed":
      applyFollow(m);
      break;
    case "diff":
      setState("diff", m);
      break;
    case "focusCard":
      flyToCard(m.id);
      break;
    case "toast":
      say(m.text);
      break;
  }
}

/** 代码只是挪了位置：静默更新卡片的行号，箭头和高亮跟着平移 */
function applyMoves() {
  for (const c of state.board.cards) {
    if (c.type !== "code") continue;
    const s = state.views[c.id]?.sync;
    if (s?.state !== "moved") continue;
    const delta = s.start - c.start;
    setState("board", produce((b: Board) => {
      const card = b.cards.find((x) => x.id === c.id) as CodeCard;
      card.start = s.start;
      card.end = s.end;
      card.hl = card.hl.map((l) => l + delta);
      for (const e of b.edges) if (e.from.card === c.id && e.from.line) e.from.line += delta;
    }));
    setState("views", c.id, "sync", { state: "ok" });
  }
}

function applyFollow(m: Extract<HostToBoard, { type: "followed" }>) {
  setState("board", produce((b: Board) => {
    const card = b.cards.find((x) => x.id === m.id) as CodeCard | undefined;
    if (!card) return;
    card.hl = card.hl.map((l) => m.lineMap[l]).filter((l): l is number => l !== undefined);
    for (const e of b.edges) if (e.from.card === m.id && e.from.line) e.from.line = m.lineMap[e.from.line];
    Object.assign(card, m.patch);
  }));
  setState("views", m.id, m.view);
  setState("diff", null);
  say("已跟进到最新代码");
}

// ---------- 修改 ----------

export function updateCard(id: string, patch: Partial<Card>) {
  setState("board", "cards", (c) => c.id === id, patch as any);
}
export function setCam(cam: Partial<Board["cam"]>) {
  setState("board", "cam", cam);
}
export function addCard(card: Card) {
  setState("board", "cards", (cs) => (card.type === "group" ? [card, ...cs] : [...cs, card]));
  setState("selected", { kind: "card", id: card.id });
  return card;
}
export function addEdge(e: Omit<Edge, "id">) {
  const edge = { ...e, id: uid("e") };
  setState("board", "edges", (es) => [...es, edge]);
  return edge;
}
export function updateEdge(id: string, patch: Partial<Edge>) {
  setState("board", "edges", (e) => e.id === id, patch);
}
export function removeSelected() {
  const sel = state.selected;
  if (!sel) return;
  setState("board", produce((b: Board) => {
    if (sel.kind === "card") {
      b.cards = b.cards.filter((c) => c.id !== sel.id);
      b.edges = b.edges.filter((e) => e.from.card !== sel.id && e.to.card !== sel.id);
    } else b.edges = b.edges.filter((e) => e.id !== sel.id);
  }));
  setState("selected", null);
}
export function bringToFront(id: string) {
  setState("board", "cards", produce((cs: Card[]) => {
    const i = cs.findIndex((c) => c.id === id);
    if (i < 0 || cs[i].type === "group" || i === cs.length - 1) return;
    cs.push(cs.splice(i, 1)[0]);
  }));
}

const rectOf = (o: Card) => ({ x: o.x, y: o.y, w: sizes[o.id]?.w ?? o.w, h: sizes[o.id]?.h ?? (o.type === "group" ? o.h : 120) });
const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap = 24) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** 从 (x, y) 开始往下找一块不和其他卡片重叠的位置 */
export function placeFree(x: number, y: number, w: number, h = 220) {
  const others = state.board.cards.filter((o) => o.type !== "group");
  const p = { x: Math.round(x), y: Math.round(y) };
  for (let i = 0; i < 80 && others.some((o) => hit({ ...p, w, h }, rectOf(o))); i++) p.y += 40;
  return p;
}

/** 展开出来的卡片：优先放在那一行的右边；右边挤了就缩进放到源卡片下方 */
function placeNear(src: CodeCard, line: number, w: number) {
  const others = state.board.cards.filter((o) => o.type !== "group" && o.id !== src.id);
  const free = (x: number, y: number) => !others.some((o) => hit({ x, y, w, h: 220 }, rectOf(o)));
  const r = rectOf(src);
  const ly = src.collapsed ? src.y : src.y + 40 + 6 + (line - src.start) * 20 - 30;
  const right = { x: r.x + r.w + 90, y: Math.round(ly) };
  for (let i = 0; i < 3; i++) if (free(right.x, right.y + i * 60)) return { x: right.x, y: right.y + i * 60 };
  const kids = state.board.edges.filter((e) => e.from.card === src.id).map((e) => others.find((o) => o.id === e.to.card)).filter(Boolean) as Card[];
  let y = Math.max(r.y + r.h, ...kids.filter((k) => k.x >= r.x - 20 && k.x <= r.x + 120).map((k) => rectOf(k).y + rectOf(k).h)) + 30;
  const x = r.x + 50;
  for (let i = 0; i < 80 && !free(x, y); i++) y += 40;
  return { x, y };
}

export function addCodeCard(nc: NewCodeCard, view: CardView, from?: { card: string; line: number }) {
  const src = from && (state.board.cards.find((c) => c.id === from.card) as CodeCard | undefined);
  // 画布上已有同一个函数：只补一条箭头
  const existing = nc.symbol && state.board.cards.find((c) => c.type === "code" && c.path === nc.path && c.symbol === nc.symbol);
  if (src && existing) {
    const dup = state.board.edges.some((e) => e.from.card === from!.card && e.from.line === from!.line && e.to.card === existing.id);
    if (!dup) {
      addEdge({ from, to: { card: existing.id }, kind: "call" });
      renumberChildren(src.id);
    }
    say(dup ? `${nc.symbol} 已经展开过了` : `已连到画布上已有的 ${nc.symbol}`);
    ensureVisible(existing.id);
    return;
  }
  const w = 560;
  let p: { x: number; y: number };
  if (src) p = placeNear(src, from!.line, w);
  else { const c = viewportCenter(); p = placeFree(c.x - w / 2, c.y - 140, w); }
  const card: CodeCard = { ...nc, id: uid("c"), x: p.x, y: p.y, w, hl: [] };
  // 第一次从一张没编号的卡片展开：它成为新的一个主步骤
  if (src && !src.step) {
    const top = state.board.cards.map((c) => (c.type === "code" && c.step ? parseInt(c.step) : 0));
    updateCard(src.id, { step: String(Math.max(0, ...top) + 1) });
  }
  const srcStep = src && (state.board.cards.find((c) => c.id === src.id) as CodeCard).step;
  if (srcStep) card.step = `${srcStep}.0`;
  setState("views", card.id, view);
  addCard(card);
  if (src) {
    addEdge({ from, to: { card: card.id }, kind: "call" });
    renumberChildren(src.id);
    ensureVisible(card.id);
  } else {
    // 面板窄时整张卡片放不下：缩小到能看清整行宽度，不放大
    const z = state.board.cam.z;
    requestAnimationFrame(() => requestAnimationFrame(() => flyToCard(card.id, z)));
  }
}

/** 按出发行号给一张卡片的直接下级重新编号，例如 3.2.1、3.2.2 */
export function renumberChildren(parentId: string) {
  const b = state.board;
  const parent = b.cards.find((c) => c.id === parentId) as CodeCard | undefined;
  if (!parent?.step) return;
  const kids = b.edges
    .filter((e) => e.from.card === parentId && e.kind === "call")
    .sort((x, y) => (x.from.line ?? 0) - (y.from.line ?? 0))
    .map((e) => b.cards.find((c) => c.id === e.to.card))
    .filter((c): c is CodeCard => !!c && c.type === "code" && (!c.step || c.step.startsWith(parent.step + ".")));
  kids.forEach((k, i) => updateCard(k.id, { step: `${parent.step}.${i + 1}` }));
}

export const steps = () => stepsOf(state.board);

// ---------- 视图 ----------

export const canvasEl = () => document.querySelector(".canvas") as HTMLElement | null;

export function viewportCenter(): { x: number; y: number } {
  const el = canvasEl();
  const cam = state.board.cam;
  const w = el?.clientWidth ?? 800, h = el?.clientHeight ?? 600;
  return { x: (w / 2 - cam.x) / cam.z, y: (h / 2 - cam.y) / cam.z };
}

let flying = 0;
export function animateCam(target: Board["cam"]) {
  const from = { ...state.board.cam };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t0 = performance.now(), dur = reduce ? 0 : 380;
  const id = ++flying;
  const tick = (t: number) => {
    if (id !== flying) return;
    const k = dur ? Math.min(1, (t - t0) / dur) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    setCam({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e });
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export function flyTo(x: number, y: number, w: number, h: number, maxZ = 1) {
  const el = canvasEl();
  if (!el) return;
  const W = el.clientWidth, H = el.clientHeight, m = 48;
  // 面板只有半屏宽时也要看得清：先保证宽度放得下，很高的卡片顶部对齐
  const z = Math.max(0.2, Math.min(maxZ, (W - 2 * m) / w, Math.max((H - 2 * m) / h, Math.min(0.75, maxZ))));
  const tall = h * z > H - 2 * m;
  animateCam({ x: W / 2 - (x + w / 2) * z, y: tall ? m - y * z : H / 2 - (y + h / 2) * z, z });
}
export function flyToCard(id: string, maxZ = 1) {
  const c = state.board.cards.find((x) => x.id === id);
  if (!c) return;
  const r = rectOf(c);
  flyTo(r.x, r.y, r.w, r.h, maxZ);
  setState("selected", { kind: "card", id });
}
export function fitAll() {
  const cs = state.board.cards;
  if (!cs.length) return animateCam({ x: 120, y: 120, z: 1 });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) {
    const r = rectOf(c);
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  const el = canvasEl();
  if (!el) return;
  const W = el.clientWidth, H = el.clientHeight, m = 40;
  const z = Math.max(0.1, Math.min(1, (W - 2 * m) / (x1 - x0), (H - 2 * m) / (y1 - y0)));
  animateCam({ x: W / 2 - ((x0 + x1) / 2) * z, y: H / 2 - ((y0 + y1) / 2) * z, z });
}
/** 卡片不在视口里时平移画布把它带进来（不改缩放） */
export function ensureVisible(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = canvasEl();
    const c = state.board.cards.find((x) => x.id === id);
    if (!el || !c) return;
    const cam = state.board.cam, r = rectOf(c), m = 32;
    const W = el.clientWidth, H = el.clientHeight;
    const x0 = r.x * cam.z + cam.x, y0 = r.y * cam.z + cam.y;
    const x1 = x0 + Math.min(r.w * cam.z, W - 2 * m), y1 = y0 + Math.min(r.h * cam.z, H - 2 * m - 60);
    let dx = 0, dy = 0;
    if (x1 > W - m) dx = W - m - x1;
    if (x0 + dx < m) dx = m - x0;
    if (y1 > H - m - 60) dy = H - m - 60 - y1;
    if (y0 + dy < m) dy = m - y0;
    if (dx || dy) animateCam({ x: cam.x + dx, y: cam.y + dy, z: cam.z });
  }));
}
export function zoomAt(k: number, mx?: number, my?: number) {
  const el = canvasEl();
  if (!el) return;
  const c = state.board.cam;
  const x = mx ?? el.clientWidth / 2, y = my ?? el.clientHeight / 2;
  const z = Math.min(2.5, Math.max(0.1, c.z * k));
  setCam({ z, x: x - ((x - c.x) / c.z) * z, y: y - ((y - c.y) / c.z) * z });
}
