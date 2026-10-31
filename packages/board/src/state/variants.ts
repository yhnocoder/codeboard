// Variant 的界面状态：宿主给的、不存盘的上游最新和落后几个 commit，对比基准，提示过的合入（都按卡 id）
import { createStore, reconcile } from "solid-js/store";
import type { Segment, SegView } from "@codeboard/core";
import { boardSignal, onBoardSwitch } from "./root";

export type VLive = {
  latest?: { label: string; segs: Segment[]; views: Record<string, SegView> };
  behind?: Record<string, number>;
};
export const [vlive, setVlive] = createStore<Record<string, VLive>>({});
/** 对比基准（卡 id → "up" | "latest" | Variant id）；默认上游。只是看的方式，不存盘 */
export const [vbase, setVbase] = createStore<Record<string, string | undefined>>({});
/** 合进上游的 Variant（卡头的提示点，Convert / Keep Variants） */
export const [merged, setMergedSig] = boardSignal<Record<string, { vid: string; into: string; tip: string }>>({});

onBoardSwitch(() => {
  setVlive(reconcile({}));
  setVbase(reconcile({}));
});
