// 静态 Markdown 放进元素里。打开一大块白板时：视野里的 Note 马上渲染；视野外、还没缓存的先放纯文字，空闲时按离视野中心由近到远补上
import { untrack } from "solid-js";
import { cam } from "../state/camera";
import { renderMd, renderMdInline, mdCached } from "./render";
import { hydrate } from "./view";

type Job = { el: HTMLElement; src: string; inline?: boolean };
const pending = new Map<HTMLElement, Job>();
let idleOn = false;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 卡片中心离视野中心多远（屏幕像素）；在视野里或不在卡片上（浮层、批注）返回 -1 */
function offView(el: HTMLElement): number {
  const c = el.closest(".card") as HTMLElement | null;
  if (!c) return -1;
  const x = parseFloat(c.style.left), y = parseFloat(c.style.top), w = parseFloat(c.style.width) || 400;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const W = window.innerWidth, H = window.innerHeight;
  const l = x * cam.z + cam.x, t = y * cam.z + cam.y, r = l + w * cam.z, b = t + 900 * cam.z; // 高度还不知道：按一张长 Note 估
  if (r > -W / 2 && l < W * 1.5 && b > -H / 2 && t < H * 1.5) return -1;
  return Math.hypot((l + r) / 2 - W / 2, (t + b) / 2 - H / 2);
}
function paint(j: Job) {
  const h = j.inline ? renderMdInline(j.src) : renderMd(j.src);
  j.el.innerHTML = h;
  hydrate(j.el, h);
}
function idle(dl?: IdleDeadline) {
  const t0 = performance.now();
  const left = () => (dl ? dl.timeRemaining() > 2 : performance.now() - t0 < 8);
  // 每轮按镜头当前位置重新排：平移过去的先补
  const jobs = [...pending.values()].map((j) => ({ j, d: offView(j.el) })).sort((a, b) => a.d - b.d);
  for (const { j } of jobs) {
    if (!left()) break;
    pending.delete(j.el);
    if (j.el.isConnected) paint(j);
  }
  if (pending.size) schedule(); else idleOn = false;
}
function schedule() {
  idleOn = true;
  if ("requestIdleCallback" in window) requestIdleCallback(idle, { timeout: 200 }); else setTimeout(idle, 16);
}
/** 把还没补上的全部渲染完（导出图片前） */
export function flushMd() { for (const j of [...pending.values()]) { pending.delete(j.el); paint(j); } }

/** 渲染进 el（视野外的、没缓存的排到空闲时） */
export function mdInto(el: HTMLElement, src: string, inline?: boolean) {
  const j: Job = { el, src, inline };
  pending.delete(el);
  // 不跟踪镜头：镜头动了不该让每个 Note 的 effect 重跑
  if (!inline && !mdCached(src) && src.trim() && untrack(() => offView(el)) >= 0) {
    el.innerHTML = `<p>${esc(src)}</p>`;
    pending.set(el, j);
    if (!idleOn) schedule();
    return;
  }
  paint(j);
}
export const mdForget = (el: HTMLElement) => { pending.delete(el); };
