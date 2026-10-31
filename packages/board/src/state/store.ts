// The board's reactive state (Solid stores) and what is derived from it: indices, placement, measured sizes. Changes to the board go
// through state/changes.ts (mutate / sync / live); segment views and version states through state/views.ts
import { createStore, reconcile } from "solid-js/store";
import { createMemo } from "solid-js";
import {
  computeFlows, emptyBoard, hiddenByCollapse, DEFAULT_SETTINGS, CODE_HEAD,
  type Board, type BoardMeta, type Card, type HostInfo, type Place, type SegView, type SharedInfo, type Stale,
} from "@codeboard/core";
import { rooted, boardSignal, onBoardSwitch } from "./root";

export const [state, setState] = createStore({
  loaded: false,
  board: emptyBoard("", "") as Board,
  boards: [] as BoardMeta[],
  host: { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS } as HostInfo,
  views: {} as Record<string, SegView>,
  stale: {} as Record<string, Stale | undefined>,
});

/** 共享卡在几块白板上、别的白板上谁连到它。宿主存盘后算好整个发来；只有在两块以上白板上的卡才有；不进撤销栈、不存盘 */
export const [shared, setShared] = createStore<Record<string, SharedInfo>>({});
onBoardSwitch(() => setShared(reconcile({})));
export const sharedOn = (id: string) => shared[id]?.boards.length ?? 0;

/** 只读卡的 id / 段、线的两端和 Call 标记、born / marks：拖动卡片不会让它重算 */
export const flows = rooted(() => createMemo(() => computeFlows(state.board)));
/** 因为折叠藏起来的卡（不管 Walkthrough 有没有临时展开） */
export const collapsedSet = rooted(() => createMemo(() => hiddenByCollapse(state.board, flows())));
/** Walkthrough 时临时展开所有折叠的卡：只影响显示，不进撤销、不存盘 */
const [showCollapsed, setShowCollapsed] = boardSignal(false);
export { setShowCollapsed };
export const collapsedAway = rooted(() => createMemo(() => (showCollapsed() ? new Set<string>() : collapsedSet())));

/** id → 卡（Compare 的栏也在里面，host 是外面的 Compare）。卡的增删、换 id 时才重建；拖动、改内容不动它 */
const cardIndex = rooted(() => createMemo(() => {
  const m = new Map<string, { card: Card; host: Card }>();
  for (const c of state.board.cards) if (!m.has(c.id)) m.set(c.id, { card: c, host: c });
  for (const c of state.board.cards) if (c.kind === "compare") for (const k of c.cols) { const f = m.get(k); if (f) m.set(k, { card: f.card, host: c }); }
  return m;
}));
export const cardById = (id: string) => cardIndex().get(id);
export const hostOf = (id: string) => cardById(id)?.host.id ?? id;
/** 按叠放顺序 */
export const placed = rooted(() => createMemo(() => state.board.cards.filter((c) => state.board.place[c.id])));

const NOWHERE: Place = { x: 0, y: 0, w: 320 };
export function placeOf(id: string): Place {
  return state.board.place[id] ?? state.board.place[hostOf(id)] ?? NOWHERE;
}

// 卡片实测尺寸（世界坐标）；Section 实际框
export const [sizes, setSizes] = createStore<Record<string, { w: number; h: number }>>({});
/** 宽高优先用实测；量到 0 的不算（卡被藏起来时量到的） */
export function rectOf(c: { id: string } | string) {
  const id = typeof c === "string" ? c : c.id;
  const p = placeOf(id);
  const s = sizes[hostOf(id)];
  // 还没量到：代码卡的 h 只是内容区，按 Warm Ink 的卡头加回去
  return { x: p.x, y: p.y, w: s && s.w > 0 ? s.w : p.w, h: s && s.h > 0 ? s.h : p.h ? p.h + (cardById(id)?.host.kind === "code" ? CODE_HEAD : 0) : 120 };
}

/** 和 id 是同一张卡的几处（含它自己，按叠放顺序）；不是的话空 */
const twinIndex = rooted(() => createMemo(() => {
  const m = new Map<string, string[]>();
  for (const c of state.board.cards) if (c.same) { const a = m.get(c.same); if (a) a.push(c.id); else m.set(c.same, [c.id]); }
  return m;
}));
export const twinsOf = (id: string): string[] => {
  const g = cardById(id)?.card.same;
  const a = g ? twinIndex().get(g) : undefined;
  return a && a.length > 1 ? a : [];
};

