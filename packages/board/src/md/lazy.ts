// 静态 Markdown 放进元素里。打开一大块白板时：视野附近的 Note 马上渲染；远处的、还没缓存的先占位（原文排版、但整块藏着，
// 绝不让人看到没渲染的原文），之后：
// - 每一帧：已经在屏幕里的、镜头照上一帧的动法再走几帧会看到的（state/lead.ts，和 cull.ts 一样）不限，这一帧全部渲染：
//   藏着的 Note 绝不在屏幕里，也不在进到屏幕的那一帧才渲染（那一帧的瓦片要现画，GPU 显存紧时那一帧是空白的）；
//   进到视野外一圈（和 cull.ts 显示卡片的范围一样，半屏）的，近的先，一帧最多 FRAME_MS，超了的下一帧接着（这一帧它还藏着，不会露出原文）
// - 空闲时：其余的由近到远补完（镜头在动时每段最多 3ms，免得挤进平移、缩放的帧）
import { createEffect, createRoot, on, untrack } from "solid-js";
import { cam, camMoving } from "../state/camera";
import { leadView, meets, type ScreenBox } from "../state/lead";
import { applyMdLayout, type Markdown, type MdLayout } from "@yhnocoder/markdown";
import { escHtml } from "@codeboard/core";

type Job = {
  md: Markdown;
  el: HTMLElement;
  src: string;
  inline?: boolean;
  layout?: MdLayout | null;
  painted?: (el: HTMLElement) => void;
};
const pending = new Map<HTMLElement, Job>();
let idleOn = false,
  frameOn = false;
const FRAME_MS = 4;

/** 卡片在屏幕上的框（屏幕像素）；不在卡片上（浮层、批注）返回 null */
function boxOf(el: HTMLElement): ScreenBox | null {
  const c = el.closest(".card") as HTMLElement | null;
  if (!c) return null;
  const x = parseFloat(c.style.left),
    y = parseFloat(c.style.top),
    w = parseFloat(c.style.width) || 400;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const hh = parseFloat(c.style.height) || 900; // 没定高度的 Note：按一张长 Note 估
  const l = x * cam.z + cam.x,
    t = y * cam.z + cam.y;
  return { l, t, r: l + w * cam.z, b: t + hh * cam.z };
}
/** 卡片中心离视野中心多远（屏幕像素）；在视野外一圈以内或不在卡片上返回 -1 */
function offView(el: HTMLElement): number {
  const k = boxOf(el);
  if (!k) return -1;
  const W = window.innerWidth,
    H = window.innerHeight;
  if (k.r > -W / 2 && k.l < W * 1.5 && k.b > -H / 2 && k.t < H * 1.5) return -1;
  return Math.hypot((k.l + k.r) / 2 - W / 2, (k.t + k.b) / 2 - H / 2);
}
function inView(el: HTMLElement) {
  const k = boxOf(el);
  return !k || meets({ l: 0, t: 0, r: window.innerWidth, b: window.innerHeight }, k.l, k.t, k.r, k.b);
}
/** 在屏幕里，或者镜头几帧以后会看到（state/lead.ts） */
function soon(el: HTMLElement, lead: ScreenBox) {
  const k = boxOf(el);
  return !k || meets(lead, k.l, k.t, k.r, k.b);
}
/** A Note in view still waits for its Markdown (still.ts: a still picture is taken only once there is none) */
export const mdPendingInView = () => [...pending.values()].some((j) => j.el.isConnected && inView(j.el));
function paint(j: Job) {
  const h = j.inline ? j.md.renderInline(j.src) : j.md.render(j.src);
  j.el.classList.remove("md-pend");
  j.el.innerHTML = h;
  j.md.hydrate(j.el, h);
  // table widths, row heights and code wrap are card data, not Markdown: put onto the shared cached HTML here
  if (!j.inline) applyMdLayout(j.el, j.layout);
  j.painted?.(j.el);
}
// 已经在屏幕里、几帧以后会进来的排最前（-2），屏幕外一圈里的其次（-1），远处的按距离
const byDist = () => {
  const lead = leadView();
  return [...pending.values()].map((j) => ({ j, d: soon(j.el, lead) ? -2 : offView(j.el) })).sort((a, b) => a.d - b.d);
};
function run(j: Job) {
  pending.delete(j.el);
  if (j.el.isConnected) paint(j);
}

// 视野附近的先渲染：镜头一变就做（同一帧、画之前），另外每帧再补一次
let spent = 0,
  spentAt = 0;
function near() {
  if (!pending.size) return;
  // 同一帧里镜头可能变好几次：预算按帧算
  const now = performance.now();
  if (now - spentAt > 12) {
    spent = 0;
    spentAt = now;
  }
  for (const { j, d } of byDist()) {
    if (d >= 0) break;
    // 已经在屏幕里、几帧以后会进来的不看预算，这一帧一定画出来；只在屏幕外一圈里的守 FRAME_MS
    if (d === -1 && spent > FRAME_MS) break;
    const t = performance.now();
    run(j);
    spent += performance.now() - t;
  }
}
function frame() {
  frameOn = false;
  near();
  if (pending.size) {
    frameOn = true;
    requestAnimationFrame(frame);
  }
}
let watching = false;
function watchCam() {
  if (watching) return;
  watching = true;
  createRoot(() =>
    createEffect(
      on(
        () => [cam.x, cam.y, cam.z],
        () => near(),
        { defer: true },
      ),
    ),
  );
}
function idle(dl?: IdleDeadline) {
  idleOn = false;
  if (!pending.size) return;
  // 镜头在动时只用帧间真空出来的一小段（新内容还要排版、重画，算在下一帧里）：缩小、平移过去之前多半已经补好
  const moving = camMoving(),
    t0 = performance.now();
  const left = () =>
    moving
      ? performance.now() - t0 < 3 && (!dl || dl.timeRemaining() > 6)
      : dl
        ? dl.timeRemaining() > 2
        : performance.now() - t0 < 8;
  for (const { j } of byDist()) {
    if (!left()) break;
    run(j);
  }
  if (pending.size) scheduleIdle();
}
function scheduleIdle() {
  if (idleOn) return;
  idleOn = true;
  if ("requestIdleCallback" in window) requestIdleCallback(idle, { timeout: 200 });
  else setTimeout(idle, 16);
}
function schedule() {
  watchCam();
  scheduleIdle();
  if (!frameOn) {
    frameOn = true;
    requestAnimationFrame(frame);
  }
}
/** 把还没补上的全部渲染完（导出图片前） */
export function flushMd() {
  for (const j of [...pending.values()]) run(j);
}

/** md 渲染进 el（远处的、没缓存的排队，见上）；painted: called each time it is painted */
export function mdInto(
  md: Markdown,
  el: HTMLElement,
  src: string,
  inline?: boolean,
  layout?: MdLayout | null,
  painted?: (el: HTMLElement) => void,
) {
  const j: Job = { md, el, src, inline, layout, painted };
  pending.delete(el);
  // 不跟踪镜头：镜头动了不该让每个 Note 的 effect 重跑
  if (!inline && !md.isCached(src) && src.trim() && untrack(() => offView(el) >= 0 && !soon(el, leadView()))) {
    // 占位：原文撑出差不多的高度，但藏着
    el.classList.add("md-pend");
    el.innerHTML = `<p>${escHtml(src)}</p>`;
    pending.set(el, j);
    schedule();
    return;
  }
  el.classList.remove("md-pend");
  paint(j);
}
export const mdForget = (el: HTMLElement) => {
  pending.delete(el);
};
