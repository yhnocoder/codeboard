// 缩到 Simplify Below 以下，Note 的字画成字条（styles.css .world.greek 和 .card.note.bars）。
// 所有 Note 在同一帧换，那一帧要重算三千来个节点的样式、把每张 Note 重画一遍（persona 的白板上各 ~12 ms 和 ~16 ms），
// 比前后的帧长出一截，缩放到这儿顿一下。所以分帧换：一帧最多 TURN 张，离屏幕中心近的先；每帧多出来的只有几毫秒。
// 镜头的比例跟着镜头走（不等停下），回到字要比这个比例高出一点（BAND），在它附近来回捏不会每步都换。
// 新出现的卡（开白板、新建、粘贴）直接是现在的样子，不排队。静态图（still）一直是字
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { cam, viewTracked } from "./camera";
import { boardStore } from "./root";
import { still } from "./still";
import { onBoard, placed, rectOf, state } from "./store";

const BAND = 1.1,
  TURN = 3;
const [bars, setBars] = boardStore<Record<string, boolean>>(() => ({}), onBoard);
/** 这张 Note 的字现在画成字条 */
export const asBars = (id: string) => !!bars[id];

/** Canvas 里调用一次；返回白板现在是不是在 Simplify Below 以下 */
export function trackGreek() {
  const greek = createMemo<boolean>((was) => {
    if (still()) return false;
    const at = state.host.settings.simpleBelow;
    return cam.z < at || (was && cam.z < at * BAND);
  }, false);
  const [tick, setTick] = createSignal(0);
  let again = false;
  createEffect(() => {
    tick();
    const on = greek();
    const cards = placed();
    untrack(() => {
      const { w, h } = viewTracked();
      const todo: [string, number][] = [];
      for (const c of cards) {
        if (c.kind !== "note") continue;
        const was = bars[c.id];
        if (was === undefined) setBars(c.id, on);
        else if (was !== on) {
          const r = rectOf(c);
          todo.push([
            c.id,
            Math.hypot((r.x + r.w / 2) * cam.z + cam.x - w / 2, (r.y + r.h / 2) * cam.z + cam.y - h / 2),
          ]);
        }
      }
      todo.sort((a, b) => a[1] - b[1]);
      for (const [id] of todo.slice(0, TURN)) setBars(id, on);
      if (todo.length > TURN && !again) {
        again = true;
        requestAnimationFrame(() => {
          again = false;
          setTick((t) => t + 1);
        });
      }
    });
  });
  return greek;
}
