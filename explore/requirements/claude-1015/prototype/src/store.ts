import { createStore, produce } from "solid-js/store";
import { createSignal } from "solid-js";
import { repo, fileLines, findSymbol, allSymbols, type Symbol } from "./data/repo";
import { diffLines, mapLine } from "./lib/diff";
import { seedBoards } from "./seed/boards";

export type EdgeKind = "call" | "seq" | "data" | "loop";

type Base = { id: string; x: number; y: number; w: number };
export type CodeCard = Base & {
  type: "code";
  path: string;
  start: number;
  end: number;
  commit: string;
  qual?: string; // 有符号就按符号同步，否则按片段内容同步
  title?: string; // 片段卡片的显示名
  hl: number[]; // 显式高亮的行（文件行号）
  step?: string; // 讲解顺序编号，如 "2.1"
  collapsed?: boolean;
  io?: string; // 折叠时显示的输入输出摘要；以后由追踪填充
  note?: string; // 卡片底部的一句批注
};
export type NoteCard = Base & { type: "note"; text: string; tone?: "plain" | "question" };
export type ImageCard = Base & { type: "image"; src: string; svg?: string; caption?: string };
export type LinkCard = Base & { type: "link"; url: string; title: string; desc?: string };
export type GroupCard = Base & { type: "group"; h: number; label: string };
export type Card = CodeCard | NoteCard | ImageCard | LinkCard | GroupCard;

export type Edge = {
  id: string;
  from: { card: string; line?: number };
  to: { card: string };
  kind: EdgeKind;
  label?: string;
};
export type Board = { id: string; name: string; cards: Card[]; edges: Edge[]; cam: { x: number; y: number; z: number } };

export type Layout = "studio" | "focus";
export type SourceView = { path: string; commit: string; reveal?: [number, number]; sel?: [number, number] };

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const [state, setState] = createStore({
  boards: seedBoards() as Board[],
  active: "flow",
  layout: "studio" as Layout,
  sidebarTab: "outline" as "files" | "outline",
  workCommit: repo.head, // 工作区当前看的版本
  selected: null as null | { kind: "card" | "edge"; id: string },
  source: null as null | SourceView,
  diffFor: null as null | string,
  present: null as null | number,
  palette: false,
  showTrace: false, // 叠加示例追踪数据，演示阶段二要填的位置
  menu: null as null | { x: number; y: number; items: { label: string; hint?: string; run: () => void }[] },
});

// 卡片实际渲染尺寸（世界坐标），由 ResizeObserver 写入
export const [sizes, setSizes] = createStore<Record<string, { w: number; h: number }>>({});

export const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: number | undefined;
export function say(msg: string) {
  setToast(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToast(null), 2200);
}

export const board = () => state.boards.find((b) => b.id === state.active)!;
const bi = () => state.boards.findIndex((b) => b.id === state.active);

export function updateCard(id: string, patch: Partial<Card>) {
  setState("boards", bi(), "cards", (c) => c.id === id, patch as any);
}
export function setCam(cam: Partial<Board["cam"]>) {
  setState("boards", bi(), "cam", cam);
}
export function addCard(card: Card) {
  setState("boards", bi(), "cards", (cs) => (card.type === "group" ? [card, ...cs] : [...cs, card]));
  setState("selected", { kind: "card", id: card.id });
  return card;
}
export function addEdge(e: Omit<Edge, "id">) {
  const edge = { ...e, id: uid("e") };
  setState("boards", bi(), "edges", (es) => [...es, edge]);
  return edge;
}
export function removeSelected() {
  const sel = state.selected;
  if (!sel) return;
  setState("boards", bi(), produce((b: Board) => {
    if (sel.kind === "card") {
      b.cards = b.cards.filter((c) => c.id !== sel.id);
      b.edges = b.edges.filter((e) => e.from.card !== sel.id && e.to.card !== sel.id);
    } else b.edges = b.edges.filter((e) => e.id !== sel.id);
  }));
  setState("selected", null);
}
export function bringToFront(id: string) {
  setState("boards", bi(), "cards", produce((cs: Card[]) => {
    const i = cs.findIndex((c) => c.id === id);
    if (i < 0 || cs[i].type === "group" || i === cs.length - 1) return;
    cs.push(cs.splice(i, 1)[0]);
  }));
}

export function newBoard() {
  const id = uid("b");
  setState("boards", (bs) => [...bs, { id, name: "未命名白板", cards: [], edges: [], cam: { x: 240, y: 160, z: 1 } }]);
  setState({ active: id, selected: null, present: null });
}

// ---------- 代码卡片 ----------

export function codeCardFromSymbol(sym: Symbol, commit: string, x: number, y: number): CodeCard {
  return { id: uid("c"), type: "code", x, y, w: 540, path: sym.path, start: sym.start, end: sym.end, commit, qual: sym.qual, hl: [] };
}
export function cardLines(c: CodeCard) {
  return fileLines(c.commit, c.path).slice(c.start - 1, c.end);
}

export type Sync =
  | { state: "ok" }
  | { state: "moved"; start: number; end: number }
  | { state: "changed"; start: number; end: number; added: number; removed: number }
  | { state: "lost" };

/** 卡片钉住的版本和工作区版本比较：一致、只是位置变了、内容变了、找不到了 */
export function syncOf(c: CodeCard, target = state.workCommit): Sync {
  if (c.commit === target) return { state: "ok" };
  const oldText = cardLines(c);
  let start: number | undefined, end: number | undefined;
  if (c.qual) {
    const s = findSymbol(target, c.path, c.qual) ?? allSymbols(target).find((s) => s.qual === c.qual);
    if (s) { start = s.start; end = s.end; }
  } else {
    const lines = fileLines(target, c.path);
    const at = lines.findIndex((_, i) => oldText.every((t, k) => lines[i + k] === t));
    if (at >= 0) { start = at + 1; end = at + oldText.length; }
    else { start = c.start; end = Math.min(c.end, lines.length); }
  }
  if (start === undefined || end === undefined) return { state: "lost" };
  const newText = fileLines(target, c.path).slice(start - 1, end);
  if (newText.join("\n") === oldText.join("\n")) return start === c.start ? { state: "ok" } : { state: "moved", start, end };
  const d = diffLines(oldText, newText);
  return { state: "changed", start, end, added: d.filter((l) => l.op === "+").length, removed: d.filter((l) => l.op === "-").length };
}

/** 跟进到工作区版本：范围、高亮行、从行出发的箭头一起迁移 */
export function followLatest(id: string) {
  const c = board().cards.find((x) => x.id === id) as CodeCard;
  const s = syncOf(c);
  if (s.state === "ok" || s.state === "lost") return;
  const target = state.workCommit;
  const d = diffLines(cardLines(c), fileLines(target, c.path).slice(s.start - 1, s.end), c.start, s.start);
  const hl = c.hl.map((l) => mapLine(d, l)).filter((l): l is number => l !== undefined);
  setState("boards", bi(), produce((b: Board) => {
    for (const e of b.edges) if (e.from.card === id && e.from.line) e.from.line = mapLine(d, e.from.line) ?? undefined;
    const card = b.cards.find((x) => x.id === id) as CodeCard;
    Object.assign(card, { commit: target, start: s.start, end: s.end, hl });
  }));
  setState("diffFor", null);
  say(`已跟进到 ${target}`);
}

// ---------- 视图 ----------

export function viewportCenter(): { x: number; y: number } {
  const el = document.querySelector(".canvas") as HTMLElement | null;
  const cam = board().cam;
  const w = el?.clientWidth ?? 1000, h = el?.clientHeight ?? 700;
  return { x: (w / 2 - cam.x) / cam.z, y: (h / 2 - cam.y) / cam.z };
}

let flying = 0;
export function flyTo(x: number, y: number, w: number, h: number, maxZ = 1) {
  const el = document.querySelector(".canvas") as HTMLElement | null;
  if (!el) return;
  const W = el.clientWidth, H = el.clientHeight;
  // 很高的卡片不为了塞进屏幕而缩到看不清：保证宽度放得下，顶部对齐
  const z = Math.min(maxZ, (W - 120) / w, Math.max((H - 140) / h, Math.min(0.8, maxZ)));
  const tall = h * z > H - 140;
  animateCam({ x: W / 2 - (x + w / 2) * z, y: tall ? 60 - y * z : H / 2 - (y + h / 2) * z, z });
}
export function animateCam(target: Board["cam"]) {
  const from = { ...board().cam };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t0 = performance.now(), dur = reduce ? 0 : 420;
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
export function flyToCard(id: string, maxZ = 1) {
  const c = board().cards.find((x) => x.id === id);
  if (!c) return;
  const sz = sizes[id] ?? { w: c.w, h: 200 };
  flyTo(c.x, c.y, sz.w, sz.h, maxZ);
  setState("selected", { kind: "card", id });
}
export function fitAll() {
  const cs = board().cards;
  if (!cs.length) return setCam({ x: 240, y: 160, z: 1 });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cs) {
    const s = sizes[c.id] ?? { w: c.w, h: 200 };
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + s.w); y1 = Math.max(y1, c.y + s.h);
  }
  flyTo(x0, y0, x1 - x0, y1 - y0, 1);
}

/** 从 (x, y) 开始往下找一块不和其他卡片重叠的位置 */
export function placeFree(x: number, y: number, w: number, h = 240) {
  const others = board().cards.filter((o) => o.type !== "group");
  const rect = (o: Card) => ({ x: o.x, y: o.y, w: sizes[o.id]?.w ?? o.w, h: sizes[o.id]?.h ?? 120 });
  const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w + 24 && b.x < a.x + a.w + 24 && a.y < b.y + b.h + 24 && b.y < a.y + a.h + 24;
  const p = { x: Math.round(x), y: Math.round(y) };
  for (let i = 0; i < 60 && others.some((o) => hit({ ...p, w, h }, rect(o))); i++) p.y += 40;
  return p;
}

/** 按出发行号给一张卡片的直接下级重新编号，例如 3.2.1、3.2.2 */
export function renumberChildren(parentId: string) {
  const b = board();
  const parent = b.cards.find((c) => c.id === parentId) as CodeCard | undefined;
  if (!parent?.step) return;
  const kids = b.edges
    .filter((e) => e.from.card === parentId && e.kind === "call")
    .sort((x, y) => (x.from.line ?? 0) - (y.from.line ?? 0))
    .map((e) => b.cards.find((c) => c.id === e.to.card))
    .filter((c): c is CodeCard => !!c && c.type === "code" && (!c.step || c.step.startsWith(parent.step + ".")));
  kids.forEach((k, i) => updateCard(k.id, { step: `${parent.step}.${i + 1}` }));
}

/** 卡片不在视口里时，平移画布把它带进来（不改缩放） */
export function ensureVisible(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.querySelector(".canvas") as HTMLElement | null;
    const c = board().cards.find((x) => x.id === id);
    if (!el || !c) return;
    const cam = board().cam, s = sizes[id] ?? { w: c.w, h: 200 }, m = 48;
    const W = el.clientWidth, H = el.clientHeight;
    const x0 = c.x * cam.z + cam.x, y0 = c.y * cam.z + cam.y, x1 = x0 + s.w * cam.z, y1 = y0 + Math.min(s.h * cam.z, H - 2 * m);
    let dx = 0, dy = 0;
    if (x1 > W - m) dx = W - m - x1; if (x0 + dx < m) dx = m - x0;
    if (y1 > H - 120) dy = H - 120 - y1; if (y0 + dy < m) dy = m - y0;
    if (dx || dy) animateCam({ x: cam.x + dx, y: cam.y + dy, z: cam.z });
  }));
}

/** 讲解顺序：有编号的卡片按编号排序 */
export function steps(): Card[] {
  const key = (s: string) => s.split(".").map((n) => n.padStart(3, "0")).join(".");
  return board().cards.filter((c) => c.type === "code" && c.step).sort((a, b) => key((a as CodeCard).step!).localeCompare(key((b as CodeCard).step!)));
}
