// City 材质的组件：停在路尽头的车（箭头的位置上）、路面标线、红绿灯是绿灯时沿路开的车流。几何在 city.ts；Links.tsx 只管箭头。
import { For, Index, Show, createEffect, createMemo, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { Link } from "@codeboard/core";
import { look, traffic } from "../state/look";
import { reduceMotion, camMoving, worldView } from "../state/camera";
import { carPaths, laneOf, zebraBack, driveFrames, type CarPose, type Road } from "./city";

/** 停着的车：同一份位置烤成三条 path（车身、车顶、车灯 + 人行横道） */
export function Car(p: { cls: string; at: CarPose; road?: Road }) {
  const c = createMemo(() => carPaths(p.at, p.road));
  return <g class={p.cls} data-deg={p.at.deg}><path class="cbody" d={c().body} /><path class="croof" d={c().roof} /><path class="clamp" d={c().lamp} /></g>;
}
/**
 * City 的路面标线（一个 path）：大路是双黄线，小街是一道白中线；停车和人行横道那头剪掉（车停在横道前，见 carPaths）。
 * 实线不用 stroke-dasharray（见 themes.css 里 .lane 的注释）
 */
export function Lane(p: { d: string; road: Road; s: number; start: boolean; end: boolean }) {
  const d = createMemo(() => {
    const t = (zebraBack(p.road) + 1) * p.s;
    return laneOf(p.d, p.road === "main" ? 1.1 : 0, p.start ? t : 0, p.end ? t : 0);
  });
  return <path class={p.road === "main" ? "lane" : "cline"} d={d()} />;
}

/** 车流要读的那部分走线状态（Links.tsx 的 Route） */
type Way = { L: Link; base: Accessor<{ kind: string } | null>; geo?: Accessor<{ d: string; pts: number[] } | null> };

/**
 * City 的车流（红绿灯是绿灯时）：镜头附近最多 MAX_ROADS 条调用路上各开两辆车。车是 HTML 小块，用 Web Animations 沿路走：
 * 关键帧只有 transform 和 opacity，整段交给合成器跑，主线程每帧什么都不做；只在路变了（拖卡片）时重建那条路上的两段动画。
 * 车不跟着路分到各张卡的那一层，跟以前一样全在一层（.movers，在所有卡上面）：分开的话每层车都要另起合成层，拖、改动时慢一倍以上。
 * 停着的车（.ahead.car）和路一起在路的那一层。
 * 红灯、别的材质、系统开了「减少动态效果」时整层不存在（没有动画、没有计时器）。挑哪几条路只在镜头停下时算一次（trackTraffic 的 pick）
 */
const MAX_ROADS = 16;
let pick: Accessor<Way[]> = () => [];
/** 挑车流开哪几条路：Links.tsx 的 trackLinks 在它的 root 里调一次，views = 画着的线 */
export function trackTraffic(views: Accessor<Way[]>) {
  const trafficOn = () => look() === "city" && traffic() && !reduceMotion();
  pick = createMemo(on([camMoving, views, trafficOn], ([moving, rs, ok], _, prev?: Way[]) => {
    if (!ok) return [];
    if (moving && prev?.length) return prev;
    return untrack(() => {
      const v = worldView(), m = 200;
      const out: Way[] = [];
      for (const r of rs) {
        if (!r.L.call || r.base()?.kind !== "normal") continue;
        const p = r.geo?.()?.pts;
        if (!p) continue;
        const xs = [p[0], p[2], p[4], p[6]], ys = [p[1], p[3], p[5], p[7]];
        if (Math.max(...xs) < v.x - m || Math.min(...xs) > v.x + v.w + m || Math.max(...ys) < v.y - m || Math.min(...ys) > v.y + v.h + m) continue;
        out.push(r);
        if (out.length >= MAX_ROADS) break;
      }
      return out;
    });
  }));
}
export function Traffic() {
  return <Show when={look() === "city" && traffic() && !reduceMotion()}><Movers /></Show>;
}
function Movers() {
  return (
    <div class="movers">
      <For each={pick()}>
        {(r, i) => {
          const d = () => r.geo?.()?.d ?? "";
          return <Index each={[0, 1]}>{(k) => <Mover d={d} k={(i() + k()) % 3} phase={k() / 2 + i() * 0.17} />}</Index>;
        }}
      </For>
    </div>
  );
}
/** 一辆车：路（d）变了就换一段动画，接着原来开到的地方（按比例）往下开 */
function Mover(p: { d: () => string; k: number; phase: number }) {
  let el!: HTMLDivElement;
  let anims: Animation[] = [];
  const stop = () => { for (const a of anims) a.cancel(); anims = []; };
  createEffect(on(p.d, (d) => {
    const old = anims[0], was = old ? ((old.currentTime as number) ?? 0) / ((old.effect?.getTiming().duration as number) || 1) : p.phase;
    stop();
    const f = d ? driveFrames(d) : null;
    if (!f) return;
    // 车速大约 50px/s
    const ms = Math.max(3000, (f.len / 50) * 1000);
    const at = ((was % 1) + 1) % 1 * ms;
    const opt: KeyframeAnimationOptions = { duration: ms, iterations: Infinity, easing: "linear" };
    anims = [el.animate(f.frames, opt), el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.88 }, { opacity: 0 }], opt)];
    for (const a of anims) a.currentTime = at;
  }));
  onCleanup(stop);
  return <div ref={el} class={`mover k${p.k}`} />;
}
