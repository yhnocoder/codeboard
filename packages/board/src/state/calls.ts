import { createSignal } from "solid-js";
import type { RunApply } from "@codeboard/core";
import { onBoardSwitch } from "./root";

export const [legendOpen, setLegendOpen] = createSignal(false);
export const [treeOpen, setTreeOpen] = createSignal(false);

/** 最近一次挂到这块白板上的运行：没对上箭头的调用（列在面板里让人挑着建） */
export type RunState = { apply: RunApply; misses: number[]; callers: Record<number, { card: string; seg: string }>; hits: number };
export const [runState, setRunState] = createSignal<RunState | null>(null);

onBoardSwitch(() => { setLegendOpen(false); setTreeOpen(false); setRunState(null); });
