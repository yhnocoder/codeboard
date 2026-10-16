// 镜头和动效：弹簧（几乎不过冲）、平滑移动、惯性。系统设了「减少动态效果」时全部直接切换。
import { createStore } from "solid-js/store";
import { createSignal, batch } from "solid-js";
import { tune } from "./tune";

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Spring {
  v: number; t: number; vel = 0;
  constructor(v: number, public k = 170, public c = 26, public eps = 0.01) { this.v = v; this.t = v; }
  step(dt: number) {
    const n = 4, h = dt / n;
    for (let i = 0; i < n; i++) { const f = -this.k * (this.v - this.t) - this.c * this.vel; this.vel += f * h; this.v += this.vel * h; }
  }
  get done() { return Math.abs(this.v - this.t) < this.eps && Math.abs(this.vel) < this.eps * 10; }
  set(v: number) { this.v = this.t = v; this.vel = 0; }
}

type Anim = (dt: number, instant: boolean) => boolean;
const anims = new Set<Anim>();
let last = 0, rafOn = false;
function tick(now: number) {
  // Debug 里的慢动作：弹簧、镜头都按比例放慢
  const dt = Math.min(0.032, (now - last) / 1000) * (tune("animSpeed") / 100);
  last = now;
  const instant = reduceMotion();
  for (const a of [...anims]) if (a(dt, instant)) anims.delete(a);
  if (anims.size) requestAnimationFrame(tick); else rafOn = false;
}
/** 每帧跑 fn，直到它返回 true */
export function animate(fn: Anim) {
  anims.add(fn);
  if (!rafOn) { rafOn = true; last = performance.now(); requestAnimationFrame(tick); }
}

// ---------- 镜头 ----------

export const [cam, setCamStore0] = createStore({ x: 80, y: 80, z: 1 });
/** 镜头在动（最后一次变化后 180ms 内）。这时 .world.moving 让浏览器把世界层当位图缩放；停下后按新比例重新清晰绘制（#15） */
export const [camMoving, setCamMoving] = createSignal(false);
let still: number | undefined;
// 「在动」和镜头本身同一批更新：先改镜头再标「在动」的话，第一帧会把按停下比例画的东西（stillZ）多重画一遍
function setCamStore(p: Partial<{ x: number; y: number; z: number }>) {
  batch(() => { if (!camMoving()) setCamMoving(true); setCamStore0(p); });
  clearTimeout(still);
  still = window.setTimeout(() => setCamMoving(false), 180);
}
const sx = new Spring(0, 120, 22, 0.05), sy = new Spring(0, 120, 22, 0.05), sz = new Spring(1, 120, 22, 0.0005);
let running = false, gen = 0;

export const ZMIN = 0.1, ZMAX = 2.5;

export function stopCam() { gen++; running = false; }
export function setCam(x: number, y: number, z: number) {
  if (running) stopCam();
  setCamStore({ x, y, z: Math.min(ZMAX, Math.max(ZMIN, z)) });
}
export function camTo(x: number, y: number, z: number, soft = false) {
  z = Math.min(ZMAX, Math.max(ZMIN, z));
  if (!running) { sx.set(cam.x); sy.set(cam.y); sz.set(cam.z); }
  for (const s of [sx, sy, sz]) { s.k = soft ? 90 : 120; s.c = soft ? 20 : 22; }
  sx.t = x; sy.t = y; sz.t = z;
  if (running) return;
  running = true;
  const g = gen;
  animate((dt, instant) => {
    if (g !== gen) return true;
    for (const s of [sx, sy, sz]) instant ? s.set(s.t) : s.step(dt);
    const done = sx.done && sy.done && sz.done;
    if (done) for (const s of [sx, sy, sz]) s.set(s.t);
    setCamStore({ x: sx.v, y: sy.v, z: sz.v });
    if (done) running = false;
    return done;
  });
}
/** 目标镜头（动画中时是终点） */
export const camTarget = () => (running ? { x: sx.t, y: sy.t, z: sz.t } : { ...cam });

/** 惯性滑动 */
export function fling(vx: number, vy: number) {
  if (reduceMotion() || Math.hypot(vx, vy) < 80) return;
  const g = ++gen;
  animate((dt) => {
    if (g !== gen) return true;
    vx *= Math.pow(0.004, dt); vy *= Math.pow(0.004, dt);
    setCamStore({ x: cam.x + vx * dt, y: cam.y + vy * dt });
    return Math.hypot(vx, vy) < 8;
  });
}

export type Rect = { x: number; y: number; w: number; h: number };

let viewport = { w: 800, h: 600 };
const [viewSig, setViewSig] = createSignal(viewport);
export const setViewport = (w: number, h: number) => { viewport = { w, h }; setViewSig(viewport); };
/** 同 view()，但能被跟踪（视野大小变了会重算） */
export const viewTracked = viewSig;
export const view = () => viewport;
export const SAFE = { l: 24, r: 24, t: 60, b: 64 };

/** 能放下 r 的镜头（不超过 maxZ） */
export function fitRect(r: Rect, maxZ = 1) {
  const { w, h } = viewport;
  const z = Math.max(ZMIN, Math.min(maxZ, (w - SAFE.l - SAFE.r) / r.w, (h - SAFE.t - SAFE.b) / r.h));
  return { z, x: SAFE.l + (w - SAFE.l - SAFE.r - r.w * z) / 2 - r.x * z, y: SAFE.t + (h - SAFE.t - SAFE.b - r.h * z) / 2 - r.y * z };
}
/** 很高的东西：保证宽度放得下，顶部对齐 */
export function fitTop(r: Rect, maxZ = 1) {
  const { w, h } = viewport;
  const z = Math.max(ZMIN, Math.min(maxZ, (w - SAFE.l - SAFE.r) / r.w));
  if (r.h * z <= h - SAFE.t - SAFE.b) return fitRect(r, z);
  return { z, x: SAFE.l + (w - SAFE.l - SAFE.r - r.w * z) / 2 - r.x * z, y: SAFE.t - r.y * z };
}
export function isVisible(r: Rect, c = camTarget()) {
  const { w, h } = viewport;
  const x = r.x * c.z + c.x, y = r.y * c.z + c.y;
  return x >= SAFE.l && y >= SAFE.t && x + r.w * c.z <= w - SAFE.r && y + Math.min(r.h * c.z, h - SAFE.t - SAFE.b) <= h - SAFE.b;
}
/** 视野（去掉四周留白）在白板坐标里的矩形 */
export function worldView(c = camTarget()): Rect {
  const { w, h } = viewport;
  return { x: (SAFE.l - c.x) / c.z, y: (SAFE.t - c.y) / c.z, w: (w - SAFE.l - SAFE.r) / c.z, h: (h - SAFE.t - SAFE.b) / c.z };
}
/** 不在视野里时平移把它带进来（必要时缩小，不放大） */
export function ensureVisible(r: Rect, also?: Rect) {
  const c = camTarget();
  if (isVisible(r, c)) return;
  const u = also ? union(r, also) : r;
  const f = fitTop(u, c.z);
  camTo(f.x, f.y, f.z);
}
export const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
export function zoomAt(f: number, px = viewport.w / 2, py = viewport.h / 2, smooth = true) {
  const c = camTarget();
  const z = Math.min(ZMAX, Math.max(ZMIN, c.z * f));
  const x = px - ((px - c.x) * z) / c.z, y = py - ((py - c.y) * z) / c.z;
  smooth ? camTo(x, y, z) : setCam(x, y, z);
}
export const toWorld = (px: number, py: number) => ({ x: (px - cam.x) / cam.z, y: (py - cam.y) / cam.z });
export const viewportCenter = () => toWorld(viewport.w / 2, viewport.h / 2);

// ---------- 缩放分档（#11）：100% 正常；概览只剩卡片名、编号和灰条；地图只剩名字和色块 ----------

import { createMemo } from "solid-js";
let heldZ = 1;
/**
 * 停下来时的缩放比例，镜头动的时候不变。按 1/z 保持屏幕上粗细的东西（箭头的点击区等）用它：
 * 缩放的每一帧都改 196 条线的样式，会让整层重新绘制（每帧 ~25ms）；动的时候整层本来就按位图缩放，停下再按准确比例画
 */
export const stillZ = createMemo(() => (camMoving() ? heldZ : (heldZ = cam.z)));
import { state } from "./store";
export type Lod = "full" | "overview" | "map";
export const lod = createMemo<Lod>(() => {
  const s = state.host.settings;
  return cam.z >= (s?.zoomOverview ?? 0.6) ? "full" : cam.z >= (s?.zoomMap ?? 0.25) ? "overview" : "map";
});
/** 缩得很小时不弹定义预览、旁注（#12） */
export const quietHover = () => lod() !== "full";
