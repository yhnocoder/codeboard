// Section 折叠、展开的动画（actions/edit.ts toggleSection）：界面状态，不进 store、不进撤销栈。
// 一个弹簧 v（1 = 展开着，0 = 折叠好）带着这几样一起走，每帧只写变换和几个属性：
// - Section 的框从展开的框（open）缩到刚好包住标题的框（shut，左上角不动），canvas/Sections.tsx
// - 成员卡、子 Section 朝标题文字的中间（tx, ty）收：整体按 v 缩放，p → t + v·(p − t)，卡的中心沿直线走过去。
//   卡之间的线套同一个变换就跟着卡走，不用每帧重新走线（canvas/Links.tsx）
// - 外面连进来的线终点从卡边滑到框边、再到标题那一行，折好时就是连在折叠的 Section 上的那条线（Links.tsx endOf）
// - 飞的时候卡里的内容换成几道骨架线（skel）
import { createSignal, untrack, type Signal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Rect } from "@codeboard/core";
import { SKEL_IN } from "./timing";

export type Fold = { v: number; open: Rect; shut: Rect; /** 标题文字的中间（世界坐标） */ tx: number; ty: number; /** 折叠（true）还是展开 */ shutting: boolean };
// 每个 Section 一个信号，值是普通对象（每帧换一个新的）：每帧几十处读 v、框、标题中间，不走 store 的代理
const folds = new Map<string, Signal<Fold | undefined>>();
const foldSig = (sid: string) => { let q = folds.get(sid); if (!q) folds.set(sid, (q = createSignal<Fold | undefined>(undefined))); return q; };
export const foldOf = (sid: string) => foldSig(sid)[0]();
export const setFold = (sid: string, f: Fold | undefined) => { foldSig(sid)[1](() => f); };
export function setFoldV(sid: string, v: number) {
  const [get, set] = foldSig(sid), f = untrack(get);
  if (f) set({ ...f, v });
}

// 跟着收的卡（宿主卡 id，折叠的子 Section 里藏着的也算：连着它们的线也要跟着走）和子 Section → 正在折叠、展开的那个 Section
const [homes, setHomes] = createStore<Record<string, string | undefined>>({});
export const foldHome = (id: string) => homes[id];
export const setFoldHome = (id: string, sid: string | undefined) => setHomes(id, sid);
/** 跟着收的这张卡 / 子 Section 这一帧的动画 */
export const foldAt = (id: string) => { const s = homes[id]; return s ? foldOf(s) : undefined; };

export const lerp = (a: number, b: number, v: number) => a + (b - a) * v;
/** 这一帧 Section 的框 */
export const frameAt = (f: Fold): Rect => ({ x: lerp(f.shut.x, f.open.x, f.v), y: lerp(f.shut.y, f.open.y, f.v), w: lerp(f.shut.w, f.open.w, f.v), h: lerp(f.shut.h, f.open.h, f.v) });
/** 原点在世界坐标 (ox, oy) 的元素这一帧要平移多少（再按 v 缩放）：整个元素按 v 朝标题中间收 */
export const toTitle = (f: Fold, ox: number, oy: number) => ({ x: (1 - f.v) * (f.tx - ox), y: (1 - f.v) * (f.ty - oy) });
/** 卡、子 Section 的透明度 */
export const fadeAt = (f: Fold) => Math.min(1, 1.8 * f.v);
/** 收得这么小、这么淡（几个像素、透明度 4% 以下）就看不见了：只写一次透明度 0，弹簧最后那一段不再每帧写它们 */
export const goneAt = (f: Fold) => f.v < 0.02;
/** 卡之间的线：v 从 0.85 到 0.45 淡掉（展开时反过来） */
export const linkFadeAt = (f: Fold) => Math.max(0, Math.min(1, (f.v - 0.45) / 0.4));
/** 标题上显示折叠的样子（「· N cards」、朝右的小箭头）：一开始折叠就显示，展开到一半收起 */
export const shutLook = (f: Fold) => f.shutting || f.v < 0.5;

// 飞的时候卡里的内容换成骨架线（styles.css .skel、Card.tsx 的 .skl）：十几张满是字的卡缩小、叠在一起很乱。
// "out" = 骨架线（内容淡出 SKEL_OUT）；"in" = 内容正在淡回来、骨架线淡掉（SKEL_IN），完了清掉
export type Skel = "out" | "in";
const [skels, setSkels] = createStore<Record<string, Skel | undefined>>({});
export const skel = (id: string) => skels[id];
export const setSkel = (id: string, s: Skel | undefined) => setSkels(id, s);
/** 这几张卡的内容淡回来，淡完清掉（中间又换成骨架线的不动） */
export function unskel(ids: string[]) {
  for (const id of ids) if (skels[id] === "out") setSkels(id, "in");
  setTimeout(() => { for (const id of ids) if (skels[id] === "in") setSkels(id, undefined); }, SKEL_IN + 50);
}
