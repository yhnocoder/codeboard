// 屏幕外的卡把内容（.cface）藏起来，卡片本身（底色、阴影、地图档的名字）照常画。
// 镜头动的时候 Chromium 会把世界层上下左右各多画 4000px，241 张卡的一行行代码全要重新分层（缩到 60% 时每帧 ~14ms）；
// 藏掉屏幕外的以后每帧 ~3ms。离屏幕一整屏以外才藏，进到半屏以内就显示，所以平移过来时内容早就画好了。
// 显示一张卡要算它的样式、画它的代码（~1–3ms），所以一帧最多显示 SHOW 张（离屏幕近的先；已经在屏幕里的不限）；藏只在镜头停下以后做，
// 也分帧，一帧最多 HIDE 张：缩小后停下时一次藏一两百张，那一帧要 100+ ms（visibility 会继承，藏一张要把里面几百个节点的样式重算一遍）。
// 卡片一批批换缩放分档的那些帧（lodcards.ts）只显示已经进到屏幕里的，别的等换完：两样挤在一帧里那一帧就超了。
// 地图档的卡内容整块被 clip-path 藏着（styles.css 的 .lo-map > .cface），显示了也看不见：先不显示，换出地图档的那一帧再显示（lodcards.ts 把它算进那一帧的量）。
// 用 visibility：布局不变，measure.ts 照常能量到行的位置
import { createEffect, createMemo, createSignal, mapArray, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { cam, camMoving, viewTracked } from "./camera";
import { placed, rectOf } from "./store";
import { sel } from "./selection";
import { editing, dragging } from "./ui";
import { lodOf, lodBusy } from "./lodcards";

// 一帧最多显示 SHOW 份：代码卡算 1 份；Note 算 1.5 份（表格、高亮的代码、勾选框、公式，画起来比一张代码卡还贵），一帧最多两张
const SHOW = 3, HIDE = 4, NOTE_COST = 1.5;
const [off, setOff] = createStore<Record<string, boolean>>({});
/** 这张卡离屏幕很远，内容不画 */
export const offscreen = (id: string) => !!off[id];
// 藏着内容、又在屏幕外半屏以外的卡，连卡片本身（底色、阴影）也不画：镜头动的时候世界层每隔几百 px 按新范围重画一遍，
// 范围是屏幕外 4000px，里面上百张空卡的底色、阴影占了重画的四成（Paint）和分层的四分之一（Layerize）。
// 进到半屏以内马上显示（只是卡片自己和它直接的几个子节点重算样式：里面的内容本来就藏着，值不变，浏览器不往下传），内容照旧按 SHOW 排队。
// 地图档的卡在屏幕附近时内容藏着、卡片照常画（off 但不 far）
const [distant, setDistant] = createStore<Record<string, boolean>>({});
/** 这张卡藏着内容、离屏幕半屏以外：整张不画 */
export const farAway = (id: string) => !!distant[id];

/**
 * 世界坐标里的一块（动图贴纸）在不在屏幕附近：进到屏幕外 1/4 屏以内算在，离开半屏以外才算不在（was = 上一次的结果，免得在边上来回切）。
 * 只是几次乘加；跟踪镜头和视野大小，在 memo 里用
 */
export function nearView(r: { x: number; y: number; w: number; h: number }, was: boolean) {
  const { w, h } = viewTracked(), z = cam.z;
  const L = r.x * z + cam.x, T = r.y * z + cam.y, R = L + r.w * z, B = T + r.h * z, m = was ? 0.5 : 0.25;
  return !(R < -w * m || L > w * (1 + m) || B < -h * m || T > h * (1 + m));
}

/** Canvas 里调用一次 */
export function trackOffscreen() {
  // 每张卡一个 memo：卡的位置、大小很少变，拖一张卡时只重算它自己的；镜头每帧变，下面只做算术
  const rects = mapArray(placed, (c) => ({ id: c.id, r: createMemo(() => rectOf(c)), cost: c.kind === "note" ? NOTE_COST : 1 }));
  const [tick, setTick] = createSignal(0);
  let again = false;
  createEffect(() => {
    tick();
    const { w, h } = viewTracked(), z = cam.z, x = cam.x, y = cam.y, moving = camMoving();
    const ed = editing()?.id, dr = dragging(), keep = new Set(sel.cards), busy = lodBusy();
    const show: [string, number, number][] = [], hide: string[] = [], away: [string, boolean][] = [];
    for (const { id, r: rr, cost } of rects()) {
      const r = rr();
      const L = r.x * z + x, T = r.y * z + y, R = L + r.w * z, B = T + r.h * z;
      const was = untrack(() => !!off[id]);
      // 显示：进到屏幕外半屏以内；隐藏：离开一整屏以外（中间这段不变，免得在边上来回切）
      const m = was ? 0.5 : 1;
      const far = R < -w * m || L > w * (1 + m) || B < -h * m || T > h * (1 + m);
      const free = !keep.has(id) && ed !== id && !dr.has(id);
      const hidden = far && free;
      away.push([id, free && (R < -w * 0.5 || L > w * 1.5 || B < -h * 0.5 || T > h * 1.5)]);
      // 已经进到屏幕里的（平移极快时会有）不排队，这一帧就显示，不能让人看到空卡
      if (was && !hidden && !(free && lodOf(id) === "map")) {
        const d = R > 0 && L < w && B > 0 && T < h ? -1 : Math.hypot((L + R) / 2 - w / 2, (T + B) / 2 - h / 2);
        if (d < 0 || !busy) show.push([id, d, cost]);
      }
      else if (!was && hidden && !moving) hide.push(id);
    }
    show.sort((a, b) => a[1] - b[1]);
    let n = 0, k = 0;
    for (const [id, d, cost] of show) { if (d >= 0 && n + cost > SHOW) break; setOff(id, false); n += cost; k++; }
    for (const id of hide.slice(0, HIDE)) setOff(id, true);
    // 不画只在镜头停下以后加（和藏内容一样）：缩放时一圈圈的卡进出半屏，每帧都换的话缩放每步多出一截重画
    untrack(() => { for (const [id, a] of away) { const f = a && !!off[id]; if (f !== !!distant[id] && (!f || !moving)) setDistant(id, f); } });
    if ((show.length > k || hide.length > HIDE) && !again) { again = true; requestAnimationFrame(() => { again = false; setTick((t) => t + 1); }); }
  });
}
