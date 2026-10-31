import { createSignal } from "solid-js";
import { boardSignal } from "./root";

/** 正在抓：key = 卡 id，或「卡 id/行 id」 */
const [fetchingKeys, setFetchingKeys] = boardSignal<Set<string>>(new Set());
export { setFetchingKeys };
export const fetching = (k: string) => fetchingKeys().has(k);

export type RowDrag = { card: string; item: string; index: number; out: boolean; x: number; y: number; label: string };
export const [rowDrag, setRowDrag] = boardSignal<RowDrag | null>(null);

/** From GitHub… 面板（工具栏 Code ▾、侧栏 Add Repo…）；repo 可以预填 owner/repo 或链接 */
export const [ghPicker, setGhPicker] = createSignal<false | { repo?: string }>(false);
