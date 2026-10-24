// 静态 Markdown 放进元素里。打开一大块白板时：视野附近的 Note 马上渲染；远处的、还没缓存的先占位（原文排版、但整块藏着，
// 绝不让人看到没渲染的原文），之后：
// - 每一帧：已经在屏幕里的（平移、缩小极快时会有）不限，这一帧全部渲染（和 cull.ts 一样：不能让人看到空卡）；
//   进到视野外一圈（和 cull.ts 显示卡片的范围一样，半屏）的，近的先，一帧最多 FRAME_MS，超了的下一帧接着（这一帧它还藏着，不会露出原文）
// - 空闲时：其余的由近到远补完（镜头在动时每段最多 3ms，免得挤进平移、缩放的帧）
import { createEffect, createRoot, on, untrack } from "solid-js";
import { cam, camMoving } from "../state/camera";
import { renderMd, renderMdInline, mdCached, hydrate } from "@yhnocoder/markdown";

type Job = { el: HTMLElement; src: string; inline?: boolean };
const pending = new Map<HTMLElement, Job>();
let idleOn = false, frameOn = false;
const FRAME_MS = 4;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 卡片中心离视野中心多远（屏幕像素）；在视野外一圈以内或不在卡片上（浮层、批注）返回 -1 */
function offView(el: HTMLElement): number {
  const c = el.closest(".card") as HTMLElement | null;
  if (!c) return -1;
  const x = parseFloat(c.style.left), y = parseFloat(c.style.top), w = parseFloat(c.style.width) || 400;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const hh = parseFloat(c.style.height) || 900; // 没定高度的 Note：按一张长 Note 估
  const W = window.innerWidth, H = window.innerHeight;
  const l = x * cam.z + cam.x, t = y * cam.z + cam.y, r = l + w * cam.z, b = t + hh * cam.z;
  if (r > -W / 2 && l < W * 1.5 && b > -H / 2 && t < H * 1.5) return -1;
  return Math.hypot((l + r) / 2 - W / 2, (t + b) / 2 - H / 2);
}
function inView(el: HTMLElement) {
  const c = el.closest(".card") as HTMLElement | null;
  if (!c) return true;
  const x = parseFloat(c.style.left), y = parseFloat(c.style.top), w = parseFloat(c.style.width) || 400, hh = parseFloat(c.style.height) || 900;
  const l = x * cam.z + cam.x, t = y * cam.z + cam.y;
  return l + w * cam.z > 0 && l < window.innerWidth && t + hh * cam.z > 0 && t < window.innerHeight;
}
function paint(j: Job) {
  const h = j.inline ? renderMdInline(j.src) : renderMd(j.src);
  j.el.classList.remove("md-pend");
  j.el.innerHTML = h;
  hydrate(j.el, h);
}
// 已经在屏幕里的排最前（-2），屏幕外一圈里的其次（-1），远处的按距离
const byDist = () => [...pending.values()].map((j) => { const d = offView(j.el); return { j, d: d < 0 && inView(j.el) ? -2 : d }; }).sort((a, b) => a.d - b.d);
function run(j: Job) { pending.delete(j.el); if (j.el.isConnected) paint(j); }

// 视野附近的先渲染：镜头一变就做（同一帧、画之前），另外每帧再补一次
let spent = 0, spentAt = 0;
function near() {
  if (!pending.size) return;
  // 同一帧里镜头可能变好几次：预算按帧算
  const now = performance.now();
  if (now - spentAt > 12) { spent = 0; spentAt = now; }
  for (const { j, d } of byDist()) {
    if (d >= 0) break;
    // 已经在屏幕里的不看预算，这一帧一定画出来；只在屏幕外一圈里的守 FRAME_MS
    if (d === -1 && spent > FRAME_MS) break;
    const t = performance.now();
    run(j);
    spent += performance.now() - t;
  }
}
function frame() {
  frameOn = false;
  near();
  if (pending.size) { frameOn = true; requestAnimationFrame(frame); }
}
let watching = false;
function watchCam() {
  if (watching) return;
  watching = true;
  createRoot(() => createEffect(on(() => [cam.x, cam.y, cam.z], () => near(), { defer: true })));
}
function idle(dl?: IdleDeadline) {
  idleOn = false;
  if (!pending.size) return;
  // 镜头在动时只用帧间真空出来的一小段（新内容还要排版、重画，算在下一帧里）：缩小、平移过去之前多半已经补好
  const moving = camMoving(), t0 = performance.now();
  const left = () => (moving ? performance.now() - t0 < 3 && (!dl || dl.timeRemaining() > 6) : dl ? dl.timeRemaining() > 2 : performance.now() - t0 < 8);
  for (const { j } of byDist()) { if (!left()) break; run(j); }
  if (pending.size) scheduleIdle();
}
function scheduleIdle() {
  if (idleOn) return;
  idleOn = true;
  if ("requestIdleCallback" in window) requestIdleCallback(idle, { timeout: 200 }); else setTimeout(idle, 16);
}
function schedule() {
  watchCam();
  scheduleIdle();
  if (!frameOn) { frameOn = true; requestAnimationFrame(frame); }
}
/** 把还没补上的全部渲染完（导出图片前） */
export function flushMd() { for (const j of [...pending.values()]) run(j); }
/** 还在排队的（测试用） */
export const mdPending = () => pending.size;

/** 渲染进 el（远处的、没缓存的排队，见上） */
export function mdInto(el: HTMLElement, src: string, inline?: boolean) {
  const j: Job = { el, src, inline };
  pending.delete(el);
  // 不跟踪镜头：镜头动了不该让每个 Note 的 effect 重跑
  if (!inline && !mdCached(src) && src.trim() && untrack(() => offView(el)) >= 0) {
    // 占位：原文撑出差不多的高度，但藏着
    el.classList.add("md-pend");
    el.innerHTML = `<p>${esc(src)}</p>`;
    pending.set(el, j);
    schedule();
    return;
  }
  el.classList.remove("md-pend");
  paint(j);
}
export const mdForget = (el: HTMLElement) => { pending.delete(el); };
