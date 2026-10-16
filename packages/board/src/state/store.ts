// 白板状态：白板数据（持久化、进撤销栈）+ 界面状态（选择、弹窗、讲解……，不持久化）
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { batch, createMemo, createSignal } from "solid-js";
import {
  brokenBy, danglingRefs, computeFlows, emptyBoard, hiddenByCollapse, removeCards, DEFAULT_SETTINGS,
  type Board, type BoardMeta, type Card, type HostInfo, type Place, type SegView, type Stale,
} from "@codeboard/core";
import { ask, send } from "../host";
import { ghostOut } from "./ghost";

export const [state, setState] = createStore({
  loaded: false,
  board: emptyBoard("", "") as Board,
  boards: [] as BoardMeta[],
  host: { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS } as HostInfo,
  views: {} as Record<string, SegView>,
  stale: {} as Record<string, Stale>,
});

// ---------- 选择 ----------

export type Sel = { cards: string[]; links: string[]; sections: string[] };
export const [sel, setSel] = createStore<Sel>({ cards: [], links: [], sections: [] });
/** 卡里选中的行（Sidenote、Hide Lines、Highlight 用） */
export type LineSel = { card: string; seg: string; start: number; end: number };
export const [lineSel, setLineSel] = createSignal<LineSel | null>(null);

export function select(o: Partial<Sel>, add = false) {
  batch(() => {
    if (!add) setSel({ cards: [], links: [], sections: [] });
    for (const k of ["cards", "links", "sections"] as const) {
      const v = o[k];
      if (v) setSel(k, (old) => (add ? [...new Set([...old, ...v])] : v));
    }
  });
  reportSelection();
}
export function toggleSel(kind: keyof Sel, id: string) {
  setSel(kind, (old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  reportSelection();
}
export const clearSel = () => { select({}); setLineSel(null); };
export const isSel = (id: string) => sel.cards.includes(id);
export const selCount = () => sel.cards.length + sel.links.length + sel.sections.length;

let selTimer: number | undefined;
export function reportSelection() {
  clearTimeout(selTimer);
  selTimer = window.setTimeout(() => {
    const ls = lineSel();
    send({ type: "selection", cards: [...sel.cards], lines: ls ?? undefined });
  }, 60);
}

// ---------- 派生 ----------

export const flows = createMemo(() => computeFlows(state.board));
/** Walkthrough 时临时展开所有折叠的子树：只影响显示，不写进白板（不进撤销、不存盘） */
export const [showCollapsed, setShowCollapsed] = createSignal(false);
export const collapsedAway = createMemo(() => (showCollapsed() ? new Set<string>() : hiddenByCollapse(state.board, flows())));

/** id → 卡（Compare 的栏也在里面，host 是外面的 Compare）。卡的增删、换 id 时才重建；拖动、改内容不动它 */
const cardIndex = createMemo(() => {
  const m = new Map<string, { card: Card; host: Card }>();
  for (const c of state.board.cards) if (!m.has(c.id)) m.set(c.id, { card: c, host: c });
  for (const c of state.board.cards) if (c.kind === "compare") for (const k of c.cols) { const f = m.get(k); if (f) m.set(k, { card: f.card, host: c }); }
  return m;
});
export const cardById = (id: string) => cardIndex().get(id);
/** 画布上摆着的卡（有 Place 的），按叠放顺序 */
export const placed = createMemo(() => state.board.cards.filter((c) => state.board.place[c.id]));

const NOWHERE: Place = { x: 0, y: 0, w: 320 };
/** 卡（或 Compare 的栏 → 它的 Compare）的摆放 */
export function placeOf(id: string): Place {
  return state.board.place[id] ?? state.board.place[cardById(id)?.host.id ?? ""] ?? NOWHERE;
}

// 卡片实测尺寸（世界坐标）；Section 实际框
export const [sizes, setSizes] = createStore<Record<string, { w: number; h: number }>>({});
/** 卡片在画布上的矩形：位置来自 Place，宽高优先用实测（量到 0 的不算：卡被藏起来时量到的） */
export function rectOf(c: { id: string } | string) {
  const id = typeof c === "string" ? c : c.id;
  const p = placeOf(id);
  const s = sizes[cardById(id)?.host.id ?? id];
  return { x: p.x, y: p.y, w: s && s.w > 0 ? s.w : p.w, h: s && s.h > 0 ? s.h : p.h ?? 120 };
}

// ---------- 撤销 / 重做 ----------

// 快照按「每张卡 / 每条线 / 每个 Section / 每条 Sidenote 一段 JSON」存，没变的那段直接沿用上一份快照里的字符串，
// 所以 300 步撤销只多占改过的那几项，而不是 300 份整块白板。镜头不进快照。
type Snap = { head: string; cards: string[]; place: string[]; links: string[]; sections: string[]; sidenotes: string[]; stickers: string[] };
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];
export const [canUndo, setCanUndo] = createSignal(false);
export const [canRedo, setCanRedo] = createSignal(false);
const last = new Map<string, string>();
function piece(k: string, o: unknown) {
  const s = JSON.stringify(o);
  const p = last.get(k);
  if (p === s) return p; // 内容一样：用旧的那个字符串，新的马上就能回收
  last.set(k, s);
  return s;
}
function snap(): Snap {
  const { cards, place, links, sections, sidenotes, stickers, cam: _cam, ...head } = unwrap(state.board);
  return {
    head: JSON.stringify(head),
    cards: cards.map((x) => piece(`c${x.id}`, x)),
    place: Object.entries(place).map(([id, x]) => piece(`p${id}`, [id, x])),
    links: links.map((x) => piece(`l${x.id}`, x)),
    sections: sections.map((x) => piece(`s${x.id}`, x)),
    sidenotes: sidenotes.map((x) => piece(`n${x.id}`, x)),
    stickers: stickers.map((x) => piece(`k${x.id}`, x)),
  };
}
const KEYS = ["cards", "place", "links", "sections", "sidenotes", "stickers"] as const;
const sameArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const same = (a: Snap, b: Snap) => a.head === b.head && KEYS.every((k) => sameArr(a[k], b[k]));
const parse = (s: Snap): Board => {
  const p = (xs: string[]) => xs.map((x) => JSON.parse(x));
  return { ...JSON.parse(s.head), cards: p(s.cards), place: Object.fromEntries(p(s.place)), links: p(s.links), sections: p(s.sections), sidenotes: p(s.sidenotes), stickers: p(s.stickers) };
};
const updUndo = () => { setCanUndo(undoStack.length > 0); setCanRedo(redoStack.length > 0); };

/**
 * 一次可撤销的修改。fn 里直接改 board（immer 风格）。
 * 改完会过一遍白板不变量（core 的 brokenBy）：被破坏就整次撤回、提示原因，返回 false。
 */
export function mutate(fn: (b: Board) => void): boolean {
  const before = snap();
  try { setState("board", produce(fn)); }
  catch (e) {
    // 改到一半抛错：produce 已经改了一部分，整次撤回，别留下半截的白板
    restore(before);
    console.error("mutate failed", e);
    toast("Something went wrong; the change was undone.");
    return false;
  }
  const bad = danglingRefs(unwrap(state.board));
  if (bad.length) console.warn("[codeboard] dangling references after a change:", bad); // 自检：应该永远是空的，harness 会把它当失败
  const why = brokenBy(unwrap(state.board), () => parse(before));
  if (why) {
    restore(before);
    toast(why);
    return false;
  }
  if (same(snap(), before)) return true;
  changed();
  pushUndo(before);
  return true;
}

function pushUndo(before: Snap) {
  undoStack.push(before);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  updUndo();
}

// 新建、还没写内容的 Note / Text / Code：建卡这一步先不进撤销栈。
// 写了内容 → 「建卡 + 内容」算撤销栈里的一步；什么都没写就失焦 → 卡自动消失，就像没建过。
const fresh = new Map<string, Snap>();
export function createFresh(id: string, fn: (b: Board) => void) {
  const before = snap();
  live(fn);
  fresh.set(id, before);
}
export const isFresh = (id: string) => fresh.has(id);
/** 结束新卡的第一次编辑：keep = 写了内容（fn 是写内容的修改） */
export function settleFresh(id: string, keep: boolean, fn?: (b: Board) => void) {
  const before = fresh.get(id);
  if (!before) return;
  fresh.delete(id);
  if (!keep) { ghostOut([id]); live((b) => removeCards(b, [id])); setSel("cards", (c) => c.filter((x) => x !== id)); return; }
  if (fn) live(fn);
  pushUndo(before);
}

/** 拖动这种连续的修改：开始时记一下，结束时如果变了才进撤销栈 */
export function beginGesture(): () => void {
  const before = snap();
  return () => { if (!same(snap(), before)) pushUndo(before); };
}
/** 拖动中的修改（不进撤销栈） */
export function live(fn: (b: Board) => void) {
  setState("board", produce(fn));
  changed();
}

function restore(s: Snap) {
  const b = parse(s);
  b.cam = { ...state.board.cam };
  setState("board", reconcile(b));
  changed();
  const ids = new Set(allIds());
  setSel("cards", (c) => c.filter((x) => ids.has(x)));
  setSel("links", (l) => l.filter((x) => state.board.links.some((k) => k.id === x)));
  setSel("sections", (l) => l.filter((x) => state.board.sections.some((k) => k.id === x)));
}
export function undo() {
  const s = undoStack.pop();
  if (!s) return false;
  redoStack.push(snap());
  restore(s);
  updUndo();
  return true;
}
export function redo() {
  const s = redoStack.pop();
  if (!s) return false;
  undoStack.push(snap());
  restore(s);
  updUndo();
  return true;
}
export function resetHistory() { undoStack.length = 0; redoStack.length = 0; last.clear(); updUndo(); }

export function allIds(): string[] {
  return state.board.cards.map((c) => c.id);
}

// ---------- 自动保存：改动后约 1 秒写盘，没有保存按钮 ----------

// 白板只在这个文件里被改（mutate / live / 撤销重做），改完直接排一次保存，不用盯着整块白板的 JSON 看它变没变
const changed = () => scheduleSave();
let saveTimer: number | undefined;
let lastSaved = "";
export function scheduleSave() {
  if (!state.loaded) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 800);
}
export function flushSave() {
  clearTimeout(saveTimer);
  const s = JSON.stringify(unwrap(state.board));
  if (s === lastSaved) return;
  lastSaved = s;
  // 宿主写盘成功才算存上；失败（磁盘满、没权限）就记成没存，过几秒再试，关窗前的 flush 也会再发
  ask("save", { board: JSON.parse(s) }).catch((e: Error) => {
    if (lastSaved !== s) return;
    lastSaved = "";
    toast(`Couldn't save the board: ${e.message}. Retrying…`);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, 5000);
  });
}
export function markSaved() { lastSaved = JSON.stringify(unwrap(state.board)); }

// ---------- toast ----------

export type ToastT = { text: string; actions?: { label: string; run: () => void }[]; n: number };
export const [toastMsg, setToastMsg] = createSignal<ToastT | null>(null);
let toastTimer: number | undefined, toastN = 0;
export function toast(text: string, actions?: ToastT["actions"], ms = 2600) {
  setToastMsg({ text, actions, n: ++toastN });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToastMsg(null), actions ? Math.max(ms, 5000) : ms);
}
