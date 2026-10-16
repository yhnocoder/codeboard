// 卡片自己的缩放分档（styles.css 的 .lo-ov / .lo-map）和地图档的 --iz。镜头跨过门槛时 .board 的 lod-* 马上换，卡一批一批跟上：
// 每帧最多 PER 张，离屏幕中心近的先换（不能把屏幕外的放到最后：快速缩小时它们正好是刚进到屏幕里的）。241 张一起换要 100+ ms（样式 + 排版 + 重画），分开换每帧几 ms。
// --iz（地图档 = 1/z，让名字和描边在屏幕上大小不变）：镜头动的时候定住，名字跟着整层一起缩放；停下再一批批换成准确的值。
// 每一步都改的话，每一步都要把所有名字重新排版（241 张卡每步 ~60ms）
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { cam, camMoving, lod, view, type Lod } from "./camera";
import { placed, rectOf, state } from "./store";

const PER = 12;
const [cardLod, setCardLod] = createStore<Record<string, Lod>>({});
const [cardIz, setCardIz] = createStore<Record<string, number>>({});
/** 进地图档那一刻的 --iz（地图档门槛的倒数）：提前建好的名字按它排版 */
export const izMap = () => 1 / (state.host.settings?.zoomMap ?? 0.25);
let held: number | undefined;
const izWant = createMemo(() => {
  if (lod() !== "map") return (held = undefined, 1);
  // 动着进地图档：先用门槛那一档的值，和提前建好的名字一样，切档那一帧名字不用重新排版
  if (held === undefined) held = camMoving() ? izMap() : 1 / cam.z;
  else if (!camMoving()) held = 1 / cam.z;
  return +held.toFixed(4);
});
/** 这张卡的 --iz（只在地图档用） */
export const izOf = (id: string) => cardIz[id] ?? izWant();
// 换完了的档：新出现的卡直接用它
const [settled, setSettled] = createSignal<Lod>("full");
/** 这张卡现在按哪一档显示 */
export const lodOf = (id: string): Lod => cardLod[id] ?? settled();

/** Canvas 里调用一次 */
export function trackCardLod() {
  const [tick, setTick] = createSignal(0);
  let again = false;
  createEffect(() => {
    tick();
    const want = lod(), iz = izWant();
    untrack(() => {
      const { w, h } = view(), z = cam.z;
      const todo: [string, number][] = [];
      for (const c of placed()) {
        if (lodOf(c.id) === want && (want !== "map" || cardIz[c.id] === iz)) continue;
        const r = rectOf(c);
        const cx = (r.x + r.w / 2) * z + cam.x, cy = (r.y + r.h / 2) * z + cam.y;
        todo.push([c.id, Math.hypot(cx - w / 2, cy - h / 2)]);
      }
      if (!todo.length) { if (settled() !== want) setSettled(want); return; }
      todo.sort((a, b) => a[1] - b[1]);
      for (const [id] of todo.slice(0, PER)) { setCardLod(id, want); if (want === "map") setCardIz(id, iz); }
      if (todo.length <= PER) setSettled(want);
      else if (!again) { again = true; requestAnimationFrame(() => { again = false; setTick((t) => t + 1); }); }
    });
  });
}
