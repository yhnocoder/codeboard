// 浮层：Sidenote 弹窗、定义预览、加 Sidenote、版本 diff、多个定义的选择、commit 列表、变量。
// 不固定的同时只开一个；⌘ + 悬停 / Pin 固定后变成独立的一个，可以开好几个对照着看。
import { createSignal } from "solid-js";
import type { Anchor, DiffData, PeekDef, Commit, Segment } from "@codeboard/core";

/** 浮层挂在哪：一个元素（跟着它走，镜头动也跟），或一个屏幕坐标 */
export type At = { el?: Element; x?: number; y?: number; prefer?: "below" | "right" | "above" };

export type Pop =
  | { kind: "notes"; card: string; ids: string[]; title: string; sel?: string }
  | { kind: "peek"; card: string; seg: string; line: number; word: string; data?: PeekDef | { none: string; word: string } | { pick: PeekDef[] } }
  | { kind: "addNote"; at: Anchor; tab: "code" | "paste" | "text" | "link" | "card"; editing?: string }
  | { kind: "diff"; card: string; seg: string; data?: DiffData; error?: string }
  | { kind: "pick"; title: string; items: { label: string; detail: string; run: () => void }[] }
  | { kind: "commits"; card: string; seg: Segment; list?: Commit[] }
  | { kind: "vars"; link: string }
  | { kind: "source"; card: string; seg: Segment; html?: string[]; start?: number };

export type PopInst = { id: number; pop: Pop; at: At; pinned: boolean };

let n = 0;
export const [pops, setPops] = createSignal<PopInst[]>([]);

/** 开一个浮层：替换掉没固定的那个 */
export function openPop(pop: Pop, at: At): number {
  const id = ++n;
  setPops((ps) => [...ps.filter((p) => p.pinned), { id, pop, at, pinned: false }]);
  return id;
}
export function updatePop(id: number, f: (p: Pop) => Pop) {
  setPops((ps) => ps.map((p) => (p.id === id ? { ...p, pop: f(p.pop) } : p)));
}
export function pinPop(id: number) {
  setPops((ps) => ps.map((p) => (p.id === id ? { ...p, pinned: true } : p)));
}
export function closePop(id?: number) {
  setPops((ps) => (id === undefined ? ps.filter((p) => p.pinned) : ps.filter((p) => p.id !== id)));
}
export const closeAllPops = () => setPops([]);
export const popOf = (kind: Pop["kind"]) => pops().find((p) => !p.pinned && p.pop.kind === kind);
export const anyPopOpen = () => pops().length > 0;
