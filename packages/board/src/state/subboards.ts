// 骨架画在框里（cards/BoardBody.tsx）：一张静态的预览，不滚动，箭头只连到整个框。
import { batch, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { BoardCard, Crumb, Skeleton, SkelCard } from "@codeboard/core";
import { ask } from "../host";
import { state } from "./store";
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
}

// 一个 Section 一栏（栏名 + 卡数；不在 Section 里的卡单独一栏）。栏里是固定宽度的小卡片：3 张以内一列，4 张起两列瀑布流
// （按阅读顺序，每张放进当前较矮的那一列，列里卡片间距固定，两列不按行对齐，短卡下面不留空）。整个排布在这里算好（每张小卡片的位置、大小），
// 框里只是按算好的位置摆（cards/BoardBody.tsx），只摆框里看得见的那些。排布只跟骨架有关：框改大小只是多露出或盖住一些，平移缩放都不重算

/** 分栏的尺寸（世界坐标，和 styles.css 的 .sbcols 一套）：小卡片宽、卡片间距、栏距、左右留白、分栏区离框顶、
 * 栏头（两行高 2.7em = 32.4px，下面空 7px）；一栏最多两列 */
export const MINI_W = 124, MINI_GAP = 6, COL_GAP = 16, COLS_PAD = 18, COLS_TOP = 18, COL_HEAD = 32.4 + 7, MAX_STACKS = 2;
/** 一栏几列：3 张以内一列，4 张起两列 */
export const stacksFor = (n: number) => (n <= 3 ? 1 : MAX_STACKS);

export type MiniBox = { c: SkelCard; x: number; y: number; w: number; h: number };
export type MiniCol = { key: string; t: string; color?: string; n: number; x: number; w: number; cards: MiniBox[] };
export type MiniLayout = { cols: MiniCol[]; w: number; h: number };
/** 量小卡片的高（宽 MINI_W、内容和真摆出来的一样，cards/BoardBody.tsx）：标题折几行、有没有摘要和缩略图都按真排版算，算出来的高和画出来的一致 */
export type MeasureMinis = (cards: SkelCard[]) => number[];

/** 先上后左的阅读顺序 */
const reading = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x;

export function miniLayout(sk: Skeleton, measure: MeasureMinis): MiniLayout {
  const groups = new Map<number, SkelCard[]>();
  for (const c of sk.cards) { const k = c.si ?? -1; groups.set(k, [...(groups.get(k) ?? []), c]); }
  const order = [...groups.keys()].filter((k) => k >= 0 && sk.secs[k]).sort((a, b) => reading(sk.secs[a], sk.secs[b]));
  if (groups.has(-1)) order.push(-1);
  const sorted = order.map((k) => [...groups.get(k)!].sort(reading));
  // 一次量完所有小卡片（只在骨架或字体换了时）
  const hs = measure(sorted.flat());
  const cols: MiniCol[] = [];
  let x = COLS_PAD, h = 0, i = 0;
  order.forEach((k, gi) => {
    const cs = sorted[gi], n = stacksFor(cs.length);
    const sec = sk.secs[k];
    const col: MiniCol = { key: k >= 0 ? `s${k}` : "none", t: sec?.t || (k >= 0 ? "Section" : "No section"), n: cs.length, x, w: n * MINI_W + (n - 1) * MINI_GAP, cards: [] };
    if (sec?.color) col.color = sec.color;
    // 瀑布流：每张放进当前较矮的一列（一样高放左边），列底 = 下一张的顶
    const tops = Array.from({ length: n }, () => COL_HEAD);
    for (const c of cs) {
      const j = tops.indexOf(Math.min(...tops)), bh = hs[i++];
      col.cards.push({ c, x: x + j * (MINI_W + MINI_GAP), y: tops[j], w: MINI_W, h: bh });
      tops[j] += bh + MINI_GAP;
    }
    h = Math.max(h, ...tops.map((t) => t - MINI_GAP));
    cols.push(col);
    x += col.w + COL_GAP;
  });
  return { cols, w: x - COL_GAP + COLS_PAD, h };
}

/** 字体加载完了（主题的字体是 swap 的，先用后备字体排过一次）：排布要按真字体重量 */
const [fontsVer, setFontsVer] = createSignal(0);
if (typeof document !== "undefined") document.fonts?.addEventListener("loadingdone", () => setFontsVer((v) => v + 1));

/** 每块子白板的骨架排一次（同一块子白板的几个框共用）：骨架换了（skelVer 加一）、主题换了或者字体加载完了才重排 */
const layouts = new Map<string, { key: string; l: MiniLayout }>();
export function layoutOf(board: string, measure: MeasureMinis): MiniLayout | null {
  const sk = skels[board], key = `${skelVer[board] ?? 0}|${state.host.settings.theme ?? ""}|${fontsVer()}`;
  if (!sk) return null;
  const hit = layouts.get(board);
  if (hit?.key === key) return hit.l;
  const l = miniLayout(unwrap(sk), measure);
  layouts.set(board, { key, l });
  return l;
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
