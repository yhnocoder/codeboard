// 屏幕外的卡把内容（.cface）藏起来，卡片本身（底色、阴影、地图档的名字）照常画。
// 镜头动的时候 Chromium 会把世界层上下左右各多画 4000px，241 张卡的一行行代码全要重新分层（缩到 60% 时每帧 ~14ms）；
// 藏掉屏幕外的以后每帧 ~3ms。离屏幕一整屏以外才藏，进到半屏以内就显示，所以平移过来时内容早就画好了。
// 显示一张卡要算它的样式、画它的代码（~1–3ms），所以一帧最多显示 SHOW 张（离屏幕近的先；已经在屏幕里的不限）；藏只在镜头停下以后做。
// 用 visibility：布局不变，measure.ts 照常能量到行的位置
import { createEffect, createMemo, createSignal, mapArray, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { cam, camMoving, viewTracked } from "./camera";
import { placed, rectOf, sel } from "./store";
import { editing, dragging } from "./ui";

const SHOW = 3;
const [off, setOff] = createStore<Record<string, boolean>>({});
/** 这张卡离屏幕很远，内容不画 */
export const offscreen = (id: string) => !!off[id];

/** Canvas 里调用一次 */
export function trackOffscreen() {
  // 每张卡一个 memo：卡的位置、大小很少变，拖一张卡时只重算它自己的；镜头每帧变，下面只做算术
  const rects = mapArray(placed, (c) => ({ id: c.id, r: createMemo(() => rectOf(c)) }));
  const [tick, setTick] = createSignal(0);
  let again = false;
  createEffect(() => {
    tick();
    const { w, h } = viewTracked(), z = cam.z, x = cam.x, y = cam.y, moving = camMoving();
    const ed = editing()?.id, dr = dragging(), keep = new Set(sel.cards);
    const show: [string, number][] = [], hide: string[] = [];
    for (const { id, r: rr } of rects()) {
      const r = rr();
      const L = r.x * z + x, T = r.y * z + y, R = L + r.w * z, B = T + r.h * z;
      const was = untrack(() => !!off[id]);
      // 显示：进到屏幕外半屏以内；隐藏：离开一整屏以外（中间这段不变，免得在边上来回切）
      const m = was ? 0.5 : 1;
      const far = R < -w * m || L > w * (1 + m) || B < -h * m || T > h * (1 + m);
      const hidden = far && !keep.has(id) && ed !== id && !dr.has(id);
      // 已经进到屏幕里的（平移极快时会有）不排队，这一帧就显示，不能让人看到空卡
      if (was && !hidden) show.push([id, R > 0 && L < w && B > 0 && T < h ? -1 : Math.hypot((L + R) / 2 - w / 2, (T + B) / 2 - h / 2)]);
      else if (!was && hidden && !moving) hide.push(id);
    }
    show.sort((a, b) => a[1] - b[1]);
    let n = 0;
    for (const [id, d] of show) { if (d >= 0 && n >= SHOW) break; setOff(id, false); n++; }
    for (const id of hide) setOff(id, true);
    if (show.length > n && !again) { again = true; requestAnimationFrame(() => { again = false; setTick((t) => t + 1); }); }
  });
}
