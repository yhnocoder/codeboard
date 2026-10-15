// 界面状态（不持久化、不进撤销栈）
import { createSignal, createMemo } from "solid-js";
import type { Guide, Link } from "@codeboard/core";
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
export const notesOn = (id: string) => state.board.sidenotes.filter((n) => n.at.card === id && n.kind === "text" && n.alwaysShow).length;

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
export type Editing = { kind: "title" | "desc" | "note" | "label" | "section" | "free" | "board" | "sidenote"; id: string } | null;
export const [editing, setEditing] = createSignal<Editing>(null);

// 拖动中：吸附参考线、合并目标、落点行……
export const [guides, setGuides] = createSignal<Guide[]>([]);
export const [sizeHint, setSizeHint] = createSignal<{ x: number; y: number; text: string } | null>(null);
export const [dropTarget, setDropTarget] = createSignal<{ kind: "merge" | "line" | "card" | "cand"; card: string; seg?: string; line?: number; armed?: boolean; cands?: string[] } | null>(null);
export const [dragging, setDragging] = createSignal<Set<string>>(new Set());
export const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
export const [rubber, setRubber] = createSignal<{ x1: number; y1: number; x2: number; y2: number; plain?: boolean } | null>(null);
export const [spaceDown, setSpaceDown] = createSignal(false);
export const [connectFrom, setConnectFrom] = createSignal<{ card: string; seg?: string; line?: number } | null>(null);
export const [hoverLink, setHoverLink] = createSignal<string | null>(null);
export const [hoverVar, setHoverVar] = createSignal<{ link: string; i: number } | null>(null);
// 新卡弹出动画：id → 起点偏移
export const [popIn, setPopIn] = createSignal<Record<string, { ox: number; oy: number; v: number; slide?: boolean }>>({});
// 讲解
export type Walk = { root: string; order: string[]; i: number; before: { x: number; y: number; z: number }; expanded: string[] };
export const [walk, setWalk] = createSignal<Walk | null>(null);
// 弹窗
export const [paletteOpen, setPaletteOpen] = createSignal<false | { mode: "all" | "code" | "entry"; then?: (item: unknown) => void }>(false);
export const [keysOpen, setKeysOpen] = createSignal(false);
export const [focusMode, setFocusMode] = createSignal(false);
export const [banner, setBanner] = createSignal(true);
