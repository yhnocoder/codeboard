// 白板状态：白板数据（持久化、进撤销栈）+ 界面状态（选择、弹窗、讲解……，不持久化）
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { batch, createMemo, createSignal } from "solid-js";
import {
  brokenBy, computeFlows, emptyBoard, hiddenByCollapse, findCard,
  type Board, type BoardMeta, type Card, type HostInfo, type SegView, type Stale,
} from "@codeboard/core";
import { send } from "../host";

export const [state, setState] = createStore({
  loaded: false,
  board: emptyBoard("", "") as Board,
  boards: [] as BoardMeta[],
  host: { isMac: true, assetBase: "", target: true } as HostInfo,
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

export const cardById = (id: string) => findCard(state.board, id);

// 卡片实测尺寸（世界坐标）；Section 实际框
export const [sizes, setSizes] = createStore<Record<string, { w: number; h: number }>>({});
export function rectOf(c: Pick<Card, "id" | "x" | "y" | "w" | "h">) {
  const s = sizes[c.id];
  return { x: c.x, y: c.y, w: s?.w ?? c.w, h: s?.h ?? c.h ?? 120 };
}

// ---------- 撤销 / 重做 ----------

type Snap = string;
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];
export const [canUndo, setCanUndo] = createSignal(false);
export const [canRedo, setCanRedo] = createSignal(false);
const snap = (): Snap => JSON.stringify({ ...unwrap(state.board), cam: undefined });
const updUndo = () => { setCanUndo(undoStack.length > 0); setCanRedo(redoStack.length > 0); };

/**
 * 一次可撤销的修改。fn 里直接改 board（immer 风格）。
 * 改完会过一遍白板不变量（core 的 brokenBy）：被破坏就整次撤回、提示原因，返回 false。
 */
export function mutate(fn: (b: Board) => void): boolean {
  const before = snap();
  setState("board", produce(fn));
  const why = brokenBy(unwrap(state.board), () => JSON.parse(before) as Board);
  if (why) {
    restore(before);
    toast(why);
    return false;
  }
  if (snap() === before) return true;
  undoStack.push(before);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  updUndo();
  return true;
}

/** 拖动这种连续的修改：开始时记一下，结束时如果变了才进撤销栈 */
export function beginGesture(): () => void {
  const before = snap();
  return () => {
    if (snap() === before) return;
    undoStack.push(before);
    redoStack.length = 0;
    updUndo();
  };
}
/** 拖动中的修改（不进撤销栈） */
export function live(fn: (b: Board) => void) {
  setState("board", produce(fn));
}

function restore(s: Snap) {
  const b = JSON.parse(s) as Board;
  b.cam = { ...state.board.cam };
  setState("board", reconcile(b));
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
export function resetHistory() { undoStack.length = 0; redoStack.length = 0; updUndo(); }

export function allIds(): string[] {
  const out: string[] = [];
  for (const c of state.board.cards) {
    out.push(c.id);
    if (c.kind === "compare") out.push(...c.cols.map((k) => k.id));
  }
  return out;
}

// ---------- 自动保存：改动后约 1 秒写盘，没有保存按钮 ----------

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
  send({ type: "save", board: JSON.parse(s) });
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
