// 浮层：Sidenote 弹窗、定义预览、加 Sidenote、版本 diff、多个定义的选择、commit 列表、变量。
// 不固定的同时只开一个；⌘ + 悬停 / Pin 固定后变成独立的一个，可以开好几个对照着看。
import { createSignal } from "solid-js";
import type { Anchor, DiffData, PeekDef, Commit, Segment } from "@codeboard/core";
import type { ImplPop, NamesPop } from "../actions/chains";

/** 浮层挂在哪：一个元素（跟着它走，镜头动也跟），或一个屏幕坐标 */
export type At = { el?: Element; x?: number; y?: number; prefer?: "below" | "right" | "above" };

export type Pop =
  | { kind: "notes"; card: string; ids: string[]; title: string; sel?: string }
  | { kind: "peek"; card: string; seg: string; line: number; word: string; trail?: PeekDef[]; data?: PeekDef | { none: string; word: string } | { pick: PeekDef[] } }
  | { kind: "addNote"; at: Anchor; tab: "code" | "paste" | "text" | "link" | "card"; editing?: string }
  | { kind: "diff"; card: string; seg: string; data?: DiffData; error?: string }
  | { kind: "pick"; title: string; items: { label: string; detail: string; run: () => void }[] }
  | { kind: "commits"; card: string; seg: Segment; list?: Commit[] }
  | { kind: "vars"; link: string }
  | { kind: "mark"; card: string }
  /** 共享卡在哪几块白板上（卡头的「⧉ N boards」） */
  | { kind: "boards"; card: string }
  /** 动态分发：N 个实现选一个（线框 01） */
  | { kind: "impls"; data: ImplPop }
  /** 跨边界的取值（kNumRanks 取几） */
  | { kind: "vals"; link: string; val: number }
  /** 解析不到：按名字在所有语言里搜 */
  | { kind: "names"; data: NamesPop }
  /** RPC 箭头的属性：机制、消息名、一对多、消息卡、↩ back to（线框 03） */
  | { kind: "rpc"; link: string }
  /** 「?」贴纸上的问题（线框 06） */
  | { kind: "question"; sticker: string }

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
