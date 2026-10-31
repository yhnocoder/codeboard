// 斜贴的卡（card.tilt）此刻转了多少度。卡片（Card.tsx 的 rotate）和箭头的端点（Links.tsx）读同一个值，
// 所以转动中箭头每一帧都贴着转过去的边走。编辑时回正，编辑完再斜回去
import { batch, createEffect, createMemo, on, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import type { Card } from "@codeboard/core";
import { hostOf } from "./store";
import { editing } from "./ui";
import { reduceMotion } from "./camera";
import { tune } from "./tune";
import { TILT_MS } from "./timing";

/** 和便签贴纸一样的角度（逆时针） */
const TILT_DEG = -1.2;

const [now, setNow] = createStore<Record<string, number | undefined>>({});
/** 整张卡（Compare 的栏算整张 Compare）此刻的角度，度 */
export const tiltOf = (host: string) => now[host] ?? 0;

const runs = new Map<string, { from: number; to: number; t0: number; dur: number }>();
let raf = 0;
function tick(t: number) {
  raf = 0;
  batch(() => {
    for (const [id, r] of runs) {
      if (r.t0 < 0) r.t0 = t;
      const p = Math.min(1, (t - r.t0) / r.dur);
      setNow(id, r.from + (r.to - r.from) * (1 - (1 - p) ** 3));
      if (p >= 1) runs.delete(id);
    }
  });
  if (runs.size) raf = requestAnimationFrame(tick);
}
function turn(id: string, to: number, animate: boolean) {
  const from = tiltOf(id);
  const dur = TILT_MS * (100 / tune("animSpeed"));
  runs.delete(id);
  if (!animate || from === to || reduceMotion() || dur <= 0) return void setNow(id, to || undefined);
  runs.set(id, { from, to, t0: -1, dur });
  if (!raf) raf = requestAnimationFrame(tick);
}

/** 卡片组件里调用一次：目标角度按 tilt 和是不是正在编辑这张卡定，变了就转过去（刚放上白板时直接到位） */
export function trackTilt(card: () => Card) {
  const id = card().id;
  const edited = createMemo(() => {
    const e = editing();
    return !!e && hostOf(e.id) === id;
  });
  createEffect(
    on(
      () => (card().tilt && !edited() ? TILT_DEG : 0),
      (to, before) => turn(id, to, before !== undefined),
    ),
  );
  onCleanup(() => {
    runs.delete(id);
    setNow(id, undefined);
  });
}
