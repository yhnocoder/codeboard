import { batch, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { skelHas, type BoardCard, type Crumb, type Rect, type Skeleton, type SkelCard } from "@codeboard/core";
import { ask } from "../host";
import { state, sync, rectOf } from "./store";
import { rooted } from "./root";

/** 子白板 id → 骨架；null = 那块白板没了；没有这一项 = 还没拿到 */
export const [skels, setSkels] = createStore<Record<string, Skeleton | null>>({});
/** 骨架换过几次（reconcile 原地改，骨架对象本身不换）：排好的分栏按它作废 */
const [skelVer, setSkelVer] = createStore<Record<string, number>>({});
/** 面包屑（从最外层到上一级）；顶层白板是空的 */
export const [crumbs, setCrumbs] = createSignal<Crumb[]>([]);
/** 进子白板时名字正飞向面包屑：面包屑上「当前」那一格先不显示 */
export const [crumbMorph, setCrumbMorph] = createSignal(false);
/** 从父白板的讲解进来的：讲完（→ 走过最后一步 / ← 退过第一步）回到父白板，从这里接着讲 */
export const [walkBack, setWalkBack] = createSignal<{ root: string; i: number } | null>(null);

export const frames = rooted(() => createMemo(() => state.board.cards.filter((c): c is BoardCard => c.kind === "board")));
const frameById = rooted(() => createMemo(() => new Map(frames().map((c) => [c.id, c]))));
export const frameOf = (id: string) => frameById().get(id);
export const skelOf = (frame: string): Skeleton | null | undefined => { const f = frameOf(frame); return f ? skels[f.board] : undefined; };

export function resetSubboards(c: Crumb[] | undefined) {
  setSkels(reconcile({}));
  setSkelVer(reconcile({}));
  layouts.clear();
  setColScroll(reconcile({}));
  setCrumbs(c ?? []);
  setWalkBack(null);
  asked.clear();
}

export function putSkels(m: Record<string, Skeleton | null>) {
  batch(() => { for (const [id, s] of Object.entries(m)) { setSkels(id, reconcile(s)); setSkelVer(id, (v) => (v ?? 0) + 1); } });
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
      if (sk === undefined) continue;
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

// 一个 Section 一栏（栏名 + 卡数；不在 Section 里的卡单独一栏），栏里是固定字号的小卡片。整个排布在这里算好（每张小卡片的位置、大小），
// 框里只是按算好的位置摆（cards/BoardBody.tsx），箭头连到小卡片也按同一份位置（subRect）。只跟骨架有关：框改大小、平移缩放都不重算

/** 分栏的尺寸（世界坐标，和 styles.css 的 .sbcols 一套）：小卡片宽、间距、栏距、左右留白、分栏区离框顶、栏头高 */
export const MINI_W = 124, MINI_GAP = 6, COL_GAP = 16, COLS_PAD = 16, COLS_TOP = 46, COL_HEAD = 39;
/** 小卡片里的几行（px）：上下留白、出处一行、标题每行、摘要一行、缩略图 */
const PAD_T = 7, PAD_B = 8, SRC_H = 12, TI_GAP = 4, TI_LH = 15, SUB_H = 16, THUMB_H = 43;

export type MiniBox = { c: SkelCard; x: number; y: number; w: number; h: number; tl: number };
export type MiniCol = { key: string; t: string; color?: string; n: number; x: number; w: number; cards: MiniBox[] };
export type MiniLayout = { cols: MiniCol[]; w: number; h: number; at: Map<string, MiniBox> };

let ctx: CanvasRenderingContext2D | null | undefined;
/** 标题占几行（最多 max）：按字体量宽度，宁多勿少（少算了标题被截成 … 也不会压到下一行） */
function lines(t: string, font: string, width: number, max: number): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return max;
  ctx.font = font;
  return Math.max(1, Math.min(max, Math.ceil(ctx.measureText(t).width / (width * 0.9))));
}
/** 先上后左的阅读顺序 */
const reading = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x;

export function miniLayout(sk: Skeleton): MiniLayout {
  const root = getComputedStyle(document.documentElement);
  const sys = root.getPropertyValue("--sys") || "sans-serif", mono = root.getPropertyValue("--mono") || "monospace", hand = root.getPropertyValue("--hand") || "cursive";
  const groups = new Map<number, SkelCard[]>();
  for (const c of sk.cards) { const k = c.si ?? -1; groups.set(k, [...(groups.get(k) ?? []), c]); }
  const order = [...groups.keys()].filter((k) => k >= 0 && sk.secs[k]).sort((a, b) => reading(sk.secs[a], sk.secs[b]));
  if (groups.has(-1)) order.push(-1);
  const cols: MiniCol[] = [], at = new Map<string, MiniBox>();
  let x = COLS_PAD, h = 0;
  for (const k of order) {
    const cs = [...groups.get(k)!].sort(reading);
    const n = cs.length >= 12 ? 3 : cs.length >= 6 ? 2 : 1;
    const w = n * MINI_W + (n - 1) * MINI_GAP;
    const sec = sk.secs[k];
    const col: MiniCol = { key: k >= 0 ? `s${k}` : "none", t: sec?.t || (k >= 0 ? "Section" : "No section"), n: cs.length, x, w, cards: [] };
    if (sec?.color) col.color = sec.color;
    let y = COL_HEAD;
    for (let i = 0; i < cs.length; i += n) {
      let rh = 0;
      cs.slice(i, i + n).forEach((c, j) => {
        const sticky = !!c.hand, more = c.k === "more";
        const tl = more ? 1 : lines(c.t, sticky ? `14px ${hand}` : c.k === "code" ? `600 11px ${mono}` : `600 11.5px ${sys}`, MINI_W - 16, sticky ? 4 : 2);
        const bh = PAD_T + (more ? 0 : SRC_H + TI_GAP) + tl * (sticky ? 18 : TI_LH) + (c.img ? THUMB_H : (c.d || c.l) && !sticky ? SUB_H : 0) + PAD_B;
        const b: MiniBox = { c, x: x + j * (MINI_W + MINI_GAP), y, w: MINI_W, h: bh, tl };
        col.cards.push(b); at.set(c.id, b);
        for (const id of c.ids ?? []) at.set(id, b);
        rh = Math.max(rh, bh);
      });
      y += rh + MINI_GAP;
    }
    h = Math.max(h, y);
    cols.push(col);
    x += w + COL_GAP;
  }
  return { cols, w: x - COL_GAP + COLS_PAD, h: h + 12, at };
}

/** 每块子白板的骨架排一次（同一块子白板的几个框共用）：骨架换了（skelVer 加一）或者主题换了字体才重排 */
const layouts = new Map<string, { key: string; l: MiniLayout }>();
export function layoutOf(board: string): MiniLayout | null {
  const sk = skels[board], key = `${skelVer[board] ?? 0}|${state.host.settings.theme ?? ""}`;
  if (!sk) return null;
  const hit = layouts.get(board);
  if (hit?.key === key) return hit.l;
  const l = miniLayout(unwrap(sk));
  layouts.set(board, { key, l });
  return l;
}

/** 框里分栏滚到哪了（选中的框里滚轮滚的；箭头连到小卡片要跟着） */
export const [colScroll, setColScroll] = createStore<Record<string, { x: number; y: number }>>({});

/** 骨架里这张卡（或折进去的那个「+N」）的小卡片在画布上的矩形（名字那一截），夹在框里看得见的分栏区里；骨架还没到 / 卡没了时 null */
export function subRect(frame: string, sub: string): Rect | null {
  if (state.host.settings.subPreview === "title") return null; // 只画标题：箭头落在框上
  const sk = skelOf(frame);
  if (!sk) return null;
  const b = layoutOf(frameOf(frame)!.board)?.at.get(sub);
  if (!b) return null;
  const r = rectOf(frame), s = colScroll[frame] ?? { x: 0, y: 0 };
  const top = r.y + COLS_TOP, bottom = r.y + r.h - 6;
  const x = Math.max(r.x, Math.min(r.x + r.w - 20, r.x + b.x - s.x)), y = Math.max(top, Math.min(bottom - 20, top + b.y - s.y));
  return { x, y, w: Math.max(20, Math.min(b.w, r.x + r.w - x)), h: Math.min(b.h, 30) };
}

// 骨架带着子白板（一路往下）上有真正标题的卡（Skeleton.refs）。链接写成 [[子白板 › 卡]]（更深的一层层接上），按名字找回来

export const frameName = (f: BoardCard) => f.title || skels[f.board]?.name || state.boards.find((m) => m.id === f.board)?.name || "Board";
export const REF_SEP = " › ";
type SubRef = { id: string; label: string; k: string; frame: string };
export function subRefs(): SubRef[] {
  const out: SubRef[] = [], seen = new Set<string>();
  for (const f of frames()) {
    const sk = skels[f.board];
    if (!sk) continue;
    for (const r of sk.refs) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, label: [frameName(f), ...(r.via ?? []).map((v) => v.n), r.t].join(REF_SEP), k: r.k, frame: f.id });
    }
  }
  return out;
}
/** [[子白板 › … › 卡]] 或子白板里一张卡的 id → 那张卡（和它所在的、这块白板上的框） */
export function subRef(label: string): SubRef | undefined {
  const l = label.trim(), low = l.toLowerCase();
  const all = subRefs();
  return all.find((r) => r.id === l) ?? (l.includes(REF_SEP.trim()) ? all.find((r) => norm(r.label) === norm(low)) : undefined);
}
const norm = (s: string) => s.toLowerCase().split(/\s*›\s*/).map((x) => x.trim()).join("›");
