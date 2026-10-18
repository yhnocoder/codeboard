// 界面状态（不持久化、不进撤销栈）
import { createSignal, createMemo } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { noteShown, type CallSpan, type CodeCard, type Guide, type Link, type Sidenote } from "@codeboard/core";
import { state } from "./store";

// 临时展开的手动隐藏范围（Show）："seg:from"
export const [shown, setShown] = createSignal<Set<string>>(new Set());
export function toggleShown(k: string) {
  const s = new Set(shown());
  s.has(k) ? s.delete(k) : s.add(k);
  setShown(s);
}

// 卡片 id → 从它出发的 Link
const fromIndex = createMemo(() => {
  const m = new Map<string, Link[]>();
  for (const l of state.board.links) {
    const a = m.get(l.from.card) ?? [];
    a.push(l);
    m.set(l.from.card, a);
  }
  return m;
});
export const linksFrom = (id: string) => fromIndex().get(id) ?? [];

// Always Show 的 Sidenote 变化时要重新量行位置
export const notesOn = (id: string) => notesOf(id).filter((n) => n.kind === "text" && n.alwaysShow).length;

// 卡片 id → 挂在它上面的 Sidenote（每行都要问，按卡分好组）
const notesIndex = createMemo(() => {
  const m = new Map<string, Sidenote[]>();
  for (const n of state.board.sidenotes) {
    // 「只在某个 Variant」：卡显示着那个 Variant 才算（线框 07）
    if (n.variant && !noteShown(n, state.board.cards.find((c) => c.id === n.at.card) as CodeCard | undefined)) continue;
    const a = m.get(n.at.card); a ? a.push(n) : m.set(n.at.card, [n]);
  }
  return m;
});
export const notesOf = (id: string): Sidenote[] => notesIndex().get(id) ?? [];

// 闪一下的行："card:seg:line"
export const [flashRows, setFlashRows] = createSignal<Set<string>>(new Set());
export function flash(card: string, seg: string, lines: number[]) {
  const keys = lines.map((l) => `${card}:${seg}:${l}`);
  setFlashRows(new Set([...flashRows(), ...keys]));
  setTimeout(() => { const s = new Set(flashRows()); keys.forEach((k) => s.delete(k)); setFlashRows(s); }, 700);
}
export const [pingCard, setPingCard] = createSignal<{ id: string; n: number } | null>(null);
let pingN = 0;
export const ping = (id: string) => setPingCard({ id, n: ++pingN });

// 正在编辑的东西
export type Editing = { kind: "title" | "desc" | "note" | "label" | "section" | "free" | "board" | "sidenote" | "gen" | "question" | "vnote"; id: string } | null;
export const [editing, setEditing] = createSignal<Editing>(null);

// 拖动中：吸附参考线、合并目标、落点行……
export const [guides, setGuides] = createSignal<Guide[]>([]);
export const [sizeHint, setSizeHint] = createSignal<{ x: number; y: number; text: string } | null>(null);
export const [dropTarget, setDropTarget] = createSignal<{ kind: "merge" | "line" | "card" | "cand"; card: string; seg?: string; line?: number; sub?: string; armed?: boolean; cands?: string[] } | null>(null);
export const [dragging, setDragging] = createSignal<Set<string>>(new Set());
export const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
export const [rubber, setRubber] = createSignal<{ x1: number; y1: number; x2: number; y2: number; plain?: boolean } | null>(null);
export const [spaceDown, setSpaceDown] = createSignal(false);
export const [connectFrom, setConnectFrom] = createSignal<{ card: string; seg?: string; line?: number; call?: CallSpan } | null>(null);
export const [hoverLink, setHoverLink] = createSignal<string | null>(null);
// 指针下的卡（它的线临时浮到最上面一层，见 canvas/Links.tsx 的 enterCard）、正在拖的线（拖起点圆点、拖标签框）
export const [hoverCard, setHoverCard] = createSignal<string | null>(null);
export const [dragLink, setDragLink] = createSignal<string | null>(null);
export const [hoverVar, setHoverVar] = createSignal<{ link: string; names: string[]; from: string; to: string } | null>(null);
// 新卡弹出动画：id → 起点偏移
// 存成 store：卡和线只订阅自己那一项，动画每帧只重算正在弹出的卡，而不是整块白板
export type PopAnim = { ox: number; oy: number; v: number; slide?: boolean };
const [popStore, setPopStore] = createStore<Record<string, PopAnim>>({});
export const popIn = () => popStore;
export function setPopIn(f: (p: Record<string, PopAnim>) => Record<string, PopAnim>) {
  setPopStore(reconcile(f({ ...unwrap(popStore) })));
}
// 讲解
export type Walk = { root: string; order: string[]; i: number; before: { x: number; y: number; z: number }; expanded: string[] };
export const [walk, setWalk] = createSignal<Walk | null>(null);
// 弹窗
export const [paletteOpen, setPaletteOpen] = createSignal<false | { mode: "all" | "code" | "entry"; q?: string }>(false);
export const [keysOpen, setKeysOpen] = createSignal(false);
// Settings 页（整窗）；section = 打开时滚到哪一节
export const [settingsOpen, setSettingsOpen] = createSignal<false | { section?: string }>(false);
export const [banner, setBanner] = createSignal(true);
