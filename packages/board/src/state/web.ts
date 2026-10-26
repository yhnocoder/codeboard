import { createSignal } from "solid-js";
import { onBoardSwitch } from "./root";

/** 正在抓：key = 卡 id，或「卡 id/行 id」 */
export const [fetchingKeys, setFetchingKeys] = createSignal<Set<string>>(new Set());
export const fetching = (k: string) => fetchingKeys().has(k);

export type RowDrag = { card: string; item: string; index: number; out: boolean; x: number; y: number; label: string };
export const [rowDrag, setRowDrag] = createSignal<RowDrag | null>(null);

/** From GitHub… 面板（工具栏 Code ▾、侧栏 Add Repo…）；repo 可以预填 owner/repo 或链接 */
export const [ghPicker, setGhPicker] = createSignal<false | { repo?: string }>(false);

onBoardSwitch(() => setRowDrag(null));
