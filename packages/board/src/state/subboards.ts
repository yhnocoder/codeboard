// 骨架画在框里（cards/BoardBody.tsx）：一张静态的缩略地图，不滚动，箭头只连到整个框；点开的预览在框外（cards/SubPreviews.tsx）。
import { batch, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { mapFit, type BoardCard, type Crumb, type Rect, type Skeleton, type SubCard } from "@codeboard/core";
import { ask } from "../host";
import { placeOf, state, sync } from "./store";
import { rooted } from "./root";

/** 子白板 id → 骨架；null = 那块白板没了；没有这一项 = 还没拿到 */
export const [skels, setSkels] = createStore<Record<string, Skeleton | null>>({});
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
  setPvs(reconcile({}));
  setPvPeek(null);
  setPvHot(null);
  setSubCards(reconcile({}));
  setCrumbs(c ?? []);
  setWalkBack(null);
  asked.clear();
}

export function putSkels(m: Record<string, Skeleton | null>) {
  batch(() => {
    for (const [id, s] of Object.entries(m)) {
      setSkels(id, reconcile(s));
      // 子白板变了：缓存的卡作废；已经不在那块白板上的卡，它的预览关掉
      for (const k of Object.keys(subCards)) if (k.startsWith(`${id}/`)) setSubCards(k, undefined!);
      const have = new Set(s?.cards.map((c) => c.id));
      for (const f of frames()) {
        if (f.board !== id || !pvs[f.id]) continue;
        for (const c of pvs[f.id].open.filter((c) => !have.has(c))) togglePreview(f.id, c);
      }
    }
  });
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

// 框里是子白板的缩略地图（cards/BoardBody.tsx）：骨架按真实位置、大小等比缩进框里（core 的 mapFit），地图和预览的连线共用

/** 框没定高度时的高（和 Turn into Board 拆出来的框差不多） */
export const FRAME_H = 320;
/** 框在父白板上的位置和大小（世界坐标，和 BoardBody 画地图用的一样） */
export function frameRect(frame: string): Rect {
  const q = placeOf(frame);
  return { x: q.x, y: q.y, w: q.w, h: q.h ?? FRAME_H };
}
/** 地图上一块（子白板的卡 id）在父白板上的位置；框、骨架、那张卡没有时 null */
export function blockRect(frame: string, id: string): Rect | null {
  const sk = skelOf(frame), c = sk?.cards.find((k) => k.id === id);
  if (!sk || !c) return null;
  const f = frameRect(frame), m = mapFit(sk, f.w, f.h);
  return { x: f.x + m.ox + c.x * m.s, y: f.y + m.oy + c.y * m.s, w: c.w * m.s, h: c.h * m.s };
}

// 点开的预览：点地图上的一块，框外弹出那张卡的只读预览（cards/SubPreviews.tsx）。右边最多完整展开 PV_MAX 张（1 栏或 2 栏，哪栏矮放哪栏），
// 再开的只显示一行标题，排在框下面（一行排多少按框的宽）。不滚动：预览的正文有最大高度，放不下的渐隐。
// 点开的是看的时候的状态：不进撤销、不存盘，换白板就清掉；栏数是框自己的设置（BoardCard.pcols，sync 写，不进撤销）

/** 一个框点开的预览：open = 点开的先后（编号 = 下标 + 1），exp = 右边展开着的（摆放的先后），tit = 框下面只显示标题的，fold = 收起了 */
export type Pv = { open: string[]; exp: string[]; tit: string[]; fold: boolean };
export const [pvs, setPvs] = createStore<Record<string, Pv>>({});
/** 临时展开的那行标题（点别处收回） */
export const [pvPeek, setPvPeek] = createSignal<{ f: string; id: string } | null>(null);
/** 指针停着的预览：画一道虚线连到它在地图上的那一块 */
export const [pvHot, setPvHot] = createSignal<{ f: string; id: string } | null>(null);

/** 右边最多展开几张；预览宽、间距；标题行宽、高、行距；预览离框的距离（都是世界坐标，和 styles.css 的 .sbpv 一套） */
export const PV_MAX = 3, PV_W = 260, PV_GAP = 10, TIT_W = 200, TIT_H = 30, TIT_GAP = 6, PV_OFF = 14;
export const pvCols = (frame: string): 1 | 2 => (frameOf(frame)?.pcols === 1 ? 1 : 2);

export type PvBox = { id: string; x: number; y: number; w: number; h: number };
/** 预览的摆法：exp 按 cols 栏瀑布流放在框右边（一样高放左边），tit 一行行排在框下面；peek 的那行标题原地展开（宽 PV_W，高按它展开后的）。
 *  hOf = 量到的展开后的高（还没量到按 120 算）。right / titles = 右边、下面两块区域（拖动时的落点） */
export function pvLayout(f: Rect, p: Pick<Pv, "exp" | "tit">, cols: 1 | 2, hOf: (id: string) => number, peek?: string) {
  const boxes = new Map<string, PvBox>();
  const x0 = f.x + f.w + PV_OFF, colH = cols === 2 ? [0, 0] : [0];
  for (const id of p.exp) {
    const c = colH.length > 1 && colH[1] < colH[0] ? 1 : 0, h = hOf(id);
    boxes.set(id, { id, x: x0 + c * (PV_W + PV_GAP), y: f.y + colH[c], w: PV_W, h });
    colH[c] += h + PV_GAP;
  }
  const per = Math.max(1, Math.floor((f.w + PV_GAP) / (TIT_W + PV_GAP))), y0 = f.y + f.h + PV_OFF;
  p.tit.forEach((id, i) => {
    const pk = id === peek;
    boxes.set(id, { id, x: f.x + (i % per) * (TIT_W + PV_GAP), y: y0 + Math.floor(i / per) * (TIT_H + TIT_GAP), w: pk ? PV_W : TIT_W, h: pk ? hOf(id) : TIT_H });
  });
  const rows = Math.ceil(p.tit.length / per);
  return {
    boxes, per,
    right: { x: x0, y: f.y, w: cols * PV_W + (cols - 1) * PV_GAP, h: Math.max(f.h, ...colH.map((h) => h - PV_GAP)) },
    titles: { x: f.x, y: y0, w: f.w, h: Math.max(TIT_H, rows * (TIT_H + TIT_GAP) - TIT_GAP) },
  };
}

const pvEdit = (frame: string, fn: (p: Pv) => void) => setPvs(frame, produce((p) => { if (p) fn(p); }));
const drop = (p: Pv, id: string) => { for (const a of [p.exp, p.tit]) { const i = a.indexOf(id); if (i >= 0) a.splice(i, 1); } };

/** 点地图上的一块：没开的弹出预览（右边还有空就展开，满了放成框下面的一行标题；收起着的一起展开），开着的关掉 */
export function togglePreview(frame: string, id: string) {
  if (!pvs[frame]) setPvs(frame, { open: [], exp: [], tit: [], fold: false });
  if (pvPeek()?.f === frame && pvPeek()!.id === id) setPvPeek(null);
  pvEdit(frame, (p) => {
    const i = p.open.indexOf(id);
    if (i >= 0) { p.open.splice(i, 1); drop(p, id); return; }
    p.open.push(id);
    (p.exp.length < PV_MAX ? p.exp : p.tit).push(id);
    p.fold = false;
  });
}
export function clearPreviews(frame: string) {
  if (pvPeek()?.f === frame) setPvPeek(null);
  if (pvHot()?.f === frame) setPvHot(null);
  setPvs(frame, { open: [], exp: [], tit: [], fold: false });
}
export const foldPreviews = (frame: string) => { if (pvPeek()?.f === frame) setPvPeek(null); pvEdit(frame, (p) => { p.fold = !p.fold; }); };
export function setPreviewCols(frame: string, n: 1 | 2) {
  sync((b) => { const c = b.cards.find((k) => k.id === frame); if (c?.kind !== "board") return; if (n === 1) c.pcols = 1; else delete c.pcols; });
}
/**
 * 拖到右边松手（y = 松手时预览的上边）：插在落下的位置展开（压过哪张的中线之前就插在它前面）；右边多过 PV_MAX 张时，
 * 摆在最下面的那张（不算刚拖来的）收成框下面的第一行标题。layout = 按某个 exp 摆出来的样子（pvLayout，带着量到的高）
 */
export function dropRight(frame: string, id: string, y: number, layout: (exp: string[]) => Map<string, PvBox>) {
  setPvPeek(null);
  pvEdit(frame, (p) => {
    drop(p, id);
    const at0 = layout([...p.exp]);
    let at = p.exp.findIndex((k) => { const r = at0.get(k)!; return y < r.y + r.h / 2; });
    if (at < 0) at = p.exp.length;
    p.exp.splice(at, 0, id);
    if (p.exp.length <= PV_MAX) return;
    const l = layout([...p.exp]);
    const low = p.exp.filter((k) => k !== id).sort((a, b) => l.get(b)!.y + l.get(b)!.h - (l.get(a)!.y + l.get(a)!.h))[0];
    p.exp.splice(p.exp.indexOf(low), 1);
    p.tit.unshift(low);
  });
}
/** 右边展开着的拖到框下面松手：收成一行标题，插在落下的那一格（行 row、列 col，per = 一行几格） */
export function dropTitles(frame: string, id: string, row: number, col: number, per: number) {
  setPvPeek(null);
  pvEdit(frame, (p) => {
    drop(p, id);
    p.tit.splice(Math.max(0, Math.min(p.tit.length, row * per + col)), 0, id);
  });
}

// 预览的内容：点开时才问宿主要那一张卡（subCard），按子白板 / 卡缓存；子白板的骨架换了（存过盘）就作废那块子白板的，再开时重新要
const [subCards, setSubCards] = createStore<Record<string, SubCard | null>>({});
const asking = new Set<string>();
/** 子白板 board 上卡 card 的完整内容：还没拿到是 undefined（顺手去要），卡已经不在了是 null */
export function subCard(board: string, card: string): SubCard | null | undefined {
  const k = `${board}/${card}`, v = subCards[k];
  if (v !== undefined || asking.has(k)) return v;
  asking.add(k);
  void ask("subCard", { board, card }).then((r) => setSubCards(k, r), () => setSubCards(k, null)).finally(() => asking.delete(k));
  return undefined;
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
