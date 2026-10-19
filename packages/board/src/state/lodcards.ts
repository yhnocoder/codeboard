// 卡片自己的缩放分档（styles.css 的 .lo-ov / .lo-map）和地图档的 --iz。镜头跨过门槛时 .board 的 lod-* 马上换，卡一批一批跟上：
// 每帧最多 PER 张，离屏幕中心近的先换（不能把屏幕外的放到最后：快速缩小时它们正好是刚进到屏幕里的）。241 张一起换要 100+ ms（样式 + 排版 + 重画），分开换每帧几 ms。
// --iz（地图档 = 1/z，让名字和描边在屏幕上大小不变）：镜头动的时候定住，名字跟着整层一起缩放；停下再一批批换成准确的值。
// 每一步都改的话，每一步都要把所有名字重新排版（241 张卡每步 ~60ms）
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { cam, camMoving, lod, view, type Lod } from "./camera";
import { placed, rectOf, sizes, state } from "./store";
import { offscreen } from "./cull";

const PER = 12;
// 正在一批批换档（还没换完）：cull.ts 这时先不显示屏幕外的卡
const [busy, setBusy] = createSignal(false);
export const lodBusy = busy;
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
  // 换档只在 rAF 里做：在滚轮事件里（镜头一变 lod() 就变）先换一批的话，同一帧的 rAF 里又换一批，那一帧就是两批
  let on = false;
  const later = () => { if (!on) { on = true; requestAnimationFrame(run); } };
  function run() {
    on = false;
    const want = lod(), iz = izWant();
    const { w, h } = view(), z = cam.z;
    const todo: [string, number, boolean][] = [];
    // 每帧都要给还没换的卡排一次序（换一次档 ~20 帧 × 241 张）：直接读原始对象，不走 store 代理（rAF 里本来就不追踪依赖）
    const P = unwrap(state.board.place), Z = unwrap(sizes), CL = unwrap(cardLod), CI = unwrap(cardIz), st = settled();
    for (const c of placed()) {
      const was = CL[c.id] ?? st;
      if (was === want && (want !== "map" || CI[c.id] === iz)) continue;
      const p = P[c.id], sz = Z[c.id];
      const r = p ? { x: p.x, y: p.y, w: sz && sz.w > 0 ? sz.w : p.w, h: sz && sz.h > 0 ? sz.h : p.h ?? 120 } : rectOf(c);
      const L = r.x * z + cam.x, T = r.y * z + cam.y, R = L + r.w * z, B = T + r.h * z;
      todo.push([c.id, Math.hypot((L + R) / 2 - w / 2, (T + B) / 2 - h / 2), was === "map" && want !== "map" && offscreen(c.id) && R > 0 && L < w && B > 0 && T < h]);
    }
    if (!todo.length) { batch(() => { if (settled() !== want) setSettled(want); setBusy(false); }); return; }
    todo.sort((a, b) => a[1] - b[1]);
    // 一帧的量：换一张算 1；从地图档换出来、内容还藏着（cull.ts）又已经在屏幕里的，这一帧还要显示内容，算 3
    let n = 0, i = 0;
    for (; i < todo.length && n < PER; i++) n += todo[i][2] ? 3 : 1;
    batch(() => {
      for (const [id] of todo.slice(0, i)) { setCardLod(id, want); if (want === "map") setCardIz(id, iz); }
      if (i === todo.length) setSettled(want);
      setBusy(i < todo.length);
    });
    if (i < todo.length) later();
  }
  // 卡片增减时也看一遍：换了白板（进出子白板）后，同 id 的卡可能还留着上一块白板上的档
  createEffect(() => { lod(); izWant(); placed(); later(); });
}
