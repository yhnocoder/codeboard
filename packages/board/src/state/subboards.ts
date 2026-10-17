// 子白板：宿主发来的骨架（只有框、名字、标记、连线、Section 色）、面包屑，和骨架在框里的摆法。
// 骨架画在框里（cards/BoardBody.tsx），连到骨架里某张卡的箭头（End.sub）按同一套摆法找那张卡的位置（canvas/Links.tsx）。
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { FRAME_HEAD, FRAME_PAD, skelHas, type BoardCard, type Crumb, type Rect, type Skeleton, type SkelCard } from "@codeboard/core";
import { ask } from "../host";
import { state, sync, rectOf } from "./store";

/** 子白板 id → 骨架；null = 那块白板没了；没有这一项 = 还没拿到 */
export const [skels, setSkels] = createStore<Record<string, Skeleton | null>>({});
/** 面包屑（从最外层到上一级）；顶层白板是空的 */
export const [crumbs, setCrumbs] = createSignal<Crumb[]>([]);

/** 白板上的子白板框 */
export const frames = createMemo(() => state.board.cards.filter((c): c is BoardCard => c.kind === "board"));
const frameById = createMemo(() => new Map(frames().map((c) => [c.id, c])));
export const frameOf = (id: string) => frameById().get(id);
export const skelOf = (frame: string): Skeleton | null | undefined => { const f = frameOf(frame); return f ? skels[f.board] : undefined; };

/** 换白板（init）时：骨架、面包屑都换掉 */
export function resetSubboards(c: Crumb[] | undefined) {
  setSkels(reconcile({}));
  setCrumbs(c ?? []);
  asked.clear();
}

/** 宿主发来的骨架（变了的那几块） */
export function putSkels(m: Record<string, Skeleton | null>) {
  for (const [id, s] of Object.entries(m)) setSkels(id, reconcile(s));
}

// 白板上出现了还没有骨架的框（新加的、Turn into Board 拆出来的）：问宿主要一次。宿主之后在子白板存盘时自己推
const asked = new Set<string>();
export function trackSkeletons() {
  createEffect(() => {
    if (!state.loaded) return;
    const want = [...new Set(frames().map((c) => c.board))].filter((id) => !(id in untrack(() => skels)) && !asked.has(id));
    if (!want.length) return;
    for (const id of want) asked.add(id);
    void ask("skeletons", { ids: want }).then((r) => { if (r) putSkels(r); }, () => { for (const id of want) asked.delete(id); });
  });
  // 连到骨架里某张卡的箭头：那张卡在子白板上没了 → lost（像代码更新后行没了一样，红色、等用户重连）；又出现了（子白板撤销）→ 去掉 lost。
  // 跟宿主同步来的一样走 sync：存盘、不进撤销栈
  createEffect(() => {
    if (!state.loaded) return;
    const fix: [string, boolean][] = [];
    for (const l of state.board.links) {
      if (l.to.sub === undefined) continue;
      const f = frameOf(l.to.card);
      if (!f) continue;
      const sk = skels[f.board];
      if (sk === undefined) continue; // 还没拿到
      const gone = sk === null || !skelHas(sk, l.to.sub);
      if (gone !== !!l.lost?.to) fix.push([l.id, gone]);
    }
    if (!fix.length) return;
    untrack(() => sync((b) => {
      for (const [id, gone] of fix) {
        const l = b.links.find((k) => k.id === id);
        if (!l || l.to.sub === undefined) continue;
        if (gone) l.lost = { ...l.lost, to: true };
        else if (l.lost) { delete l.lost.to; if (!l.lost.from) delete l.lost; }
      }
    }));
  });
}

// ---------- 骨架在框里的摆法 ----------

/** 框里放骨架的区域（世界坐标）：标题栏下面、四周留白 */
export function innerOf(r: Rect): Rect {
  return { x: r.x + FRAME_PAD, y: r.y + FRAME_HEAD + 4, w: Math.max(1, r.w - FRAME_PAD * 2), h: Math.max(1, r.h - FRAME_HEAD - 4 - FRAME_PAD) };
}
/** 骨架按比例缩进区域里（不放大），水平居中、顶对齐。s = 比例，ox / oy = 骨架 (0, 0) 在框里（相对框左上角）的位置 */
export function fitSkel(w: number, h: number, sk: Pick<Skeleton, "w" | "h">): { s: number; ox: number; oy: number } {
  const r = innerOf({ x: 0, y: 0, w, h });
  const s = Math.min(1, r.w / sk.w, r.h / sk.h);
  return { s, ox: r.x + (r.w - sk.w * s) / 2, oy: r.y };
}
/** 骨架里一张卡在框里的矩形（相对框左上角）。名字那一行至少 LABEL_H 高 */
export const LABEL_H = 16;
export function skelBox(c: SkelCard, f: { s: number; ox: number; oy: number }): Rect {
  return { x: f.ox + c.x * f.s, y: f.oy + c.y * f.s, w: Math.max(14, c.w * f.s), h: Math.max(LABEL_H, c.h * f.s) };
}

/** 骨架里这张卡（或折进去的那个「+N」）在画布上的矩形；骨架还没到 / 卡没了时 null */
export function subRect(frame: string, sub: string): Rect | null {
  if (state.host.settings?.subPreview === "title") return null; // 只画标题：箭头落在框上
  const sk = skelOf(frame);
  if (!sk) return null;
  const c = sk.cards.find((k) => k.id === sub) ?? sk.cards.find((k) => k.ids?.includes(sub));
  if (!c) return null;
  const r = rectOf(frame);
  const b = skelBox(c, fitSkel(r.w, r.h, sk));
  return { x: r.x + b.x, y: r.y + b.y, w: b.w, h: Math.min(b.h, LABEL_H) };
}
