// 界面状态（不持久化、不进撤销栈）
import { createSignal, createMemo } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { noteShown, type CodeCard, type Guide, type Link, type Sidenote } from "@codeboard/core";
import { state } from "./store";
import { rooted, onBoardSwitch } from "./root";
import type { StaticTextRange } from "@yhnocoder/markdown";

// 临时展开的手动隐藏范围（Show）："seg:from"
export const [shown, setShown] = createSignal<Set<string>>(new Set());
export function toggleShown(k: string) {
  const s = new Set(shown());
  s.has(k) ? s.delete(k) : s.add(k);
  setShown(s);
}

// 卡片 id → 从它出发的 Link
const fromIndex = rooted(() => createMemo(() => {
  const m = new Map<string, Link[]>();
  for (const l of state.board.links) {
    const a = m.get(l.from.card) ?? [];
    a.push(l);
    m.set(l.from.card, a);
  }
  return m;
}));
export const linksFrom = (id: string) => fromIndex().get(id) ?? [];

// Always Show 的 Sidenote 变化时要重新量行位置
export const notesOn = (id: string) => notesOf(id).filter((n) => n.kind === "text" && n.alwaysShow).length;

// 卡片 id → 挂在它上面的 Sidenote（每行都要问，按卡分好组）
const notesIndex = rooted(() => createMemo(() => {
  const m = new Map<string, Sidenote[]>();
  for (const n of state.board.sidenotes) {
    // 「只在某个 Variant」：卡显示着那个 Variant 才算
    if (n.variant && !noteShown(n, state.board.cards.find((c) => c.id === n.at.card) as CodeCard | undefined)) continue;
    const a = m.get(n.at.card); a ? a.push(n) : m.set(n.at.card, [n]);
  }
  return m;
}));
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

export type Editing = { kind: "title" | "desc" | "note" | "label" | "section" | "free" | "board" | "sidenote" | "gen" | "question" | "vnote" | "annot"; id: string } | null;
export const [editing, setEditing] = createSignal<Editing>(null);
/**
 * 显示时选中一段字再按 ⌫ / Delete：进入编辑，把同一段选上，再把这个键交给编辑器（和在编辑器里按一样）。
 * note：静态 Markdown 上数出来的一段（staticTextRange）；free：自由代码卡的第几行第几个字（行从 0 数）。编辑器挂上时取走（takeEditEntry）
 */
export type EditEntry = { key: "Backspace" | "Delete"; id: string } & (
  | { kind: "note"; range: StaticTextRange }
  | { kind: "free"; from: [line: number, col: number]; to: [line: number, col: number] }
);
/** 代码卡显示的代码（.src）→ 选区两头在第几段第几行第几个字（行从 0 数，按原文算）；两头不在同一段的代码行里给 null。CodeBody 挂上 */
export const codeTextRange = new WeakMap<Element, (rg: Range) => { seg: string; from: [number, number]; to: [number, number] } | null>();
let entry: EditEntry | null = null;
export const setEditEntry = (e: EditEntry | null) => { entry = e; };
export function takeEditEntry<K extends EditEntry["kind"]>(kind: K, id: string): Extract<EditEntry, { kind: K }> | null {
  const e = entry;
  if (e?.kind !== kind || e.id !== id) return null;
  entry = null;
  return e as Extract<EditEntry, { kind: K }>;
}

// 拖动中：吸附参考线、合并目标、落点行、图片卡要放进的 Note（note）……
export const [guides, setGuides] = createSignal<Guide[]>([]);
export const [sizeHint, setSizeHint] = createSignal<{ x: number; y: number; text: string } | null>(null);
export const [dropTarget, setDropTarget] = createSignal<{ kind: "merge" | "line" | "card" | "cand" | "note"; card: string; seg?: string; line?: number; sub?: string; armed?: boolean; cands?: string[] } | null>(null);
export const [dragging, setDragging] = createSignal<Set<string>>(new Set());
export const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
export const [rubber, setRubber] = createSignal<{ x1: number; y1: number; x2: number; y2: number; plain?: boolean } | null>(null);
// 正在拖的线（拖起点圆点、拖标签框）；指针下的卡和线在 state/hover.ts
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
// 卡的大小变过去的动画（Fit Content）：id → 这一帧画出来的宽、高（高是存着高度的那一块：代码卡的内容区，别的卡整张）。
// 白板里已经是新的大小；同样存成 store，每帧只重算在变的卡
export type SizeAnim = { w: number; h: number };
const [sizeStore, setSizeStore] = createStore<Record<string, SizeAnim | undefined>>({});
export const sizeIn = () => sizeStore;
export const setSizeIn = (id: string, s: SizeAnim | undefined) => setSizeStore(id, s);
export type Walk = { root: string; order: string[]; i: number; before: { x: number; y: number; z: number }; expanded: string[] };
export const [walk, setWalk] = createSignal<Walk | null>(null);
export const [paletteOpen, setPaletteOpen] = createSignal<false | { mode: "all" | "code" | "entry"; q?: string }>(false);
export const [keysOpen, setKeysOpen] = createSignal(false);
// Settings 页（整窗）；section = 打开时滚到哪一节
export const [settingsOpen, setSettingsOpen] = createSignal<false | { section?: string }>(false);
export const [banner, setBanner] = createSignal(true);

onBoardSwitch(() => { setWalk(null); setBanner(true); setEditing(null); });
