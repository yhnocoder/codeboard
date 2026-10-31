// Section 的实际框：自己存的框 ∪ 成员卡（含边距）∪ 子 Section（core layout.sectionFrame，和子白板骨架同一套算法），框随内容自动撑大，也能拖边改大。
// 拖动中先预演（setMovingHome）：卡离开的 Section 回到没有它的框，要进的撑开、亮起来（.drop），松手时才真的改 place.section。
import { batch, createComputed, createMemo, createSignal, mapArray, on, untrack, type Signal } from "solid-js";
import { sectionFrame, sectionFit, sectionPill, estSize, type Board, type Rect, type Section } from "@codeboard/core";
import { state, rectOf, placed, hostOf, collapsedAway } from "./store";
import { rooted, boardSignal, onBoardSwitch } from "./root";
import { Spring, animate, reduceMotion, cam } from "./camera";

const byId = rooted(() => createMemo(() => new Map(state.board.sections.map((s) => [s.id, s]))));
export const sec = (id?: string) => (id ? byId().get(id) : undefined);

export function depthOf(s: Section): number {
  let d = 0;
  for (let q = sec(s.parent); q && d < 50; q = sec(q.parent)) d++;
  return d;
}
export function hiddenByAncestor(s: Section): boolean {
  for (let q = sec(s.parent), i = 0; q && i < 50; q = sec(q.parent), i++) if (q.collapsed) return true;
  return false;
}
// 父 → 子 Section、Section → 直属卡：一次分好组，算框时不用每个 Section 都扫一遍所有卡
const kids = rooted(() => createMemo(() => groupBy(state.board.sections, (s) => s.parent)));

/** 拖动中的卡松手后会在哪个 Section（卡 id → Section id，undefined = 不在 Section 里）；没在拖 = null。只在落点换了 Section 时才变 */
const [moving, setMoving] = boardSignal<ReadonlyMap<string, string | undefined> | null>(null, {
  equals: (a, b) => a === b || (!!a && !!b && a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k) === v)),
});
export { setMoving as setMovingHome };
/** 拖动中的卡要进的、和它现在不同的 Section：画成 .drop */
export const dropSections = rooted(() => createMemo(() => {
  const out = new Set<string>();
  for (const [id, s] of moving() ?? []) if (s && s !== state.board.place[id]?.section) out.add(s);
  return out;
}));
const homeOf = (id: string) => { const m = moving(); return m?.has(id) ? m.get(id) : state.board.place[id]?.section; };
const members = rooted(() => createMemo(() => groupBy(placed(), (c) => homeOf(c.id))));
function groupBy<T>(xs: T[], key: (x: T) => string | undefined) {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); if (k === undefined) continue; const a = m.get(k); a ? a.push(x) : m.set(k, [x]); }
  return m;
}
const childrenOf = (id: string) => kids().get(id) ?? [];
export function descSections(id: string): Section[] {
  const out: Section[] = [];
  const walk = (x: string) => childrenOf(x).forEach((c) => { if (!out.includes(c)) { out.push(c); walk(c.id); } });
  walk(id);
  return out;
}
const directMembers = (id: string) => members().get(id) ?? [];
export const allMembers = (id: string) => {
  const ids = new Set([id, ...descSections(id).map((s) => s.id)]);
  return placed().filter((c) => { const s = state.board.place[c.id]?.section; return !!s && ids.has(s); });
};

/** 展开着的 Section 的框（世界坐标）；skip = 拖动中的卡不算 */
export function frameOf(s: Section, skip?: Set<string>, seen = new Set<string>()): Rect {
  if (seen.has(s.id)) return { x: s.x, y: s.y, w: s.w, h: s.h };
  seen.add(s.id);
  const cards = directMembers(s.id).filter((c) => !skip?.has(c.id)).map(rectOf);
  return sectionFrame(s, [...cards, ...childrenOf(s.id).map((ch) => (ch.collapsed ? sectionPill(ch) : frameOf(ch, skip, seen)))]);
}
/** Fit Content 的框：刚好包住直属卡和子 Section（各加边距）；里面没东西 = undefined */
export function fitFrame(s: Section): Rect | undefined {
  return sectionFit([...directMembers(s.id).map(rectOf), ...childrenOf(s.id).map((ch) => (ch.collapsed ? sectionPill(ch) : frameOf(ch)))]);
}
/** 正在缓动到新框的 Section（Fit Content）：框和标签这一会儿带 transition（.fit） */
const [fitting, setFitting] = createSignal<ReadonlySet<string>>(new Set());
export { fitting, setFitting };

// 渲染用：每个 Section 一个 memo（子 Section 用它自己的 memo）：拖一张卡时只重算它所在的 Section 和上面几层，不是 42 个全算。
// 子 Section 的 memo 还没建好（或者父子关系成了环，不该发生）时退回它自己存的框
const frameMemos = rooted(() => mapArray(() => state.board.sections, (s) => [s.id, createMemo<Rect | undefined>(() => sectionFrame(s, [
  ...directMembers(s.id).map(rectOf),
  ...childrenOf(s.id).map((ch): Rect => (ch.collapsed ? sectionPill(ch) : memoById().get(ch.id)?.() ?? ch)),
]), undefined, { equals: (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h })] as const));
const memoById = rooted(() => createMemo((): Map<string, () => Rect | undefined> => new Map(frameMemos())));
/** 渲染用：每个可见的 Section 的框（折叠的是标题条）。没变的框还是上一次的对象，全都没变就还是上一次的 Map */
export const frames = rooted(() => createMemo<Map<string, Rect>>((prev) => {
  const m = new Map<string, Rect>(), ms = memoById();
  let same = true;
  for (const s of state.board.sections) {
    if (hiddenByAncestor(s)) continue;
    const r = s.collapsed ? sectionPill(s) : ms.get(s.id)?.() ?? frameOf(s);
    const p = prev.get(s.id);
    if (p && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h) m.set(s.id, p); else { m.set(s.id, r); same = false; }
  }
  return same && m.size === prev.size ? prev : m;
}, new Map()));

// 拖卡时框的目标每一步都变：CSS transition 每步重新开始、每帧排版。改成弹簧追目标（接着上一步的速度），每帧只写一次框。
// 弹簧接近临界阻尼，和原来 .16s 的 --out 差不多快；只有拖动中（或还没停下的）框才缓动，别的改动（Section 自己的拖动、
// 改大小、撤销）照旧直接到位，Fit Content 走自己的 .fit transition。判断落点（homeFor 等）一律用 frames()，不用画出来的框
const EASE_K = 2500, EASE_C = 100, EASE_EPS = 0.05;
type Ease = { x: Spring; y: Spring; w: Spring; h: Spring };
const easing = new Map<string, Ease>();
// 每个 Section 一个 signal：一帧只通知正在缓动的那几个框和标签。画出来的框和卡一样取整到世界坐标的整像素（缩小时到
// 设备像素），没变一个像素的帧不写：带小数的框每帧都要重排、重画，拖得慢时目标每步只差一两像素，这是拖动每步最贵的一块
const sameRect = (a?: Rect, b?: Rect) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
const shown = new Map<string, Signal<Rect | undefined>>();
const shownOf = (id: string) => { let q = shown.get(id); if (!q) shown.set(id, (q = createSignal<Rect | undefined>(undefined, { equals: sameRect }))); return q; };
const show = (id: string, r?: Rect) => shownOf(id)[1](() => r);
function easedRect(e: Ease): Rect {
  const q = Math.min(1, cam.z * devicePixelRatio), px = (v: number) => Math.round(v * q) / q;
  return { x: px(e.x.v), y: px(e.y.v), w: px(e.w.v), h: px(e.h.v) };
}
function stopEasing() { batch(() => { for (const id of easing.keys()) show(id); }); easing.clear(); }
onBoardSwitch(stopEasing);
function easeStep(dt: number, instant: boolean) {
  batch(() => {
    for (const [id, e] of easing) {
      const sp = [e.x, e.y, e.w, e.h];
      for (const s of sp) instant ? s.set(s.t) : s.step(dt);
      if (sp.every((s) => s.done)) { easing.delete(id); show(id); } else show(id, easedRect(e));
    }
  });
  return !easing.size;
}
rooted(() => createComputed(on(frames, (f, prev) => {
  if (!prev) return;
  if (reduceMotion() || !(moving() || easing.size)) return stopEasing();
  for (const [id, r] of f) {
    const p = prev.get(id);
    if (p === r) continue;
    if (!p || fitting().has(id)) { if (easing.delete(id)) show(id); continue; }
    let e = easing.get(id);
    if (!e) {
      const from = untrack(shownOf(id)[0]) ?? p;
      const mk = (v: number) => new Spring(v, EASE_K, EASE_C, EASE_EPS);
      e = { x: mk(from.x), y: mk(from.y), w: mk(from.w), h: mk(from.h) };
      if (!easing.size) animate(easeStep);
      easing.set(id, e);
      // 这一次就画在弹簧现在的位置（不然先闪到目标，下一帧再退回来）
      show(id, easedRect(e));
    }
    e.x.t = r.x; e.y.t = r.y; e.w.t = r.w; e.h.t = r.h;
  }
  for (const id of [...easing.keys()]) if (!f.has(id)) { easing.delete(id); show(id); }
})));
/** 渲染用：这个 Section 的框画在哪：拖卡时正缓动的框在半路上，别的就是 frames() 里的框。框和标签都按它画 */
export const shownFrame = (id: string) => shownOf(id)[0]() ?? frames().get(id);

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
/** 矩形 r 有三分之一以上的面积在 f 里：算 r 在 f 里（homeFor、新画的 Section 收哪些卡，同一条规则） */
export const partlyIn = (r: Rect, f: Rect) => 3 * overlapArea(r, f) > r.w * r.h;
/**
 * 卡（矩形 r）属于哪个 Section：盖住它三分之一以上面积的展开 Section；有几个时，嵌套的取最深的，一样深取盖得多的；都不到 = 不在 Section 里。
 * 所有决定卡在哪个 Section 的地方都用它（拖动的预演和松手、粘贴、新建）。跟卡不相交的框一比就跳过
 */
export function homeFor(fr: Map<string, Rect>, r: Rect, skip?: Set<string>): Section | undefined {
  const third = (r.w * r.h) / 3;
  let best: Section | undefined, bd = -1, bo = 0;
  for (const s of state.board.sections) {
    if (s.collapsed || skip?.has(s.id)) continue;
    const f = fr.get(s.id);
    if (!f) continue;
    const o = overlapArea(r, f);
    if (o <= third) continue;
    const d = depthOf(s);
    if (d > bd || (d === bd && o > bo)) { best = s; bd = d; bo = o; }
  }
  return best;
}
/** 刚放到白板上的卡（还没量过尺寸，按估计的大小）进它落在的 Section：在 mutate 里调 */
export function settleHome(b: Board, id: string) {
  const p = b.place[id], c = b.cards.find((k) => k.id === id);
  if (!p || !c) return;
  const s = homeFor(frames(), { x: p.x, y: p.y, ...estSize(c, p) })?.id;
  if (s) p.section = s; else delete p.section;
}

/** 世界坐标 (x, y) 落在哪个最深的展开 Section 里（Section 的父级：画框、拖标签） */
export function deepestAt(fr: Map<string, Rect>, x: number, y: number, skip?: Set<string>): Section | undefined {
  let best: Section | undefined, bd = -1, ba = Infinity;
  for (const s of state.board.sections) {
    if (s.collapsed || skip?.has(s.id)) continue;
    const r = fr.get(s.id);
    if (!r || x <= r.x || x >= r.x + r.w || y <= r.y || y >= r.y + r.h) continue;
    const d = depthOf(s), a = r.w * r.h;
    if (d > bd || (d === bd && a < ba)) { best = s; bd = d; ba = a; }
  }
  return best;
}

/**
 * 这张卡（Compare 的栏按它的 Compare 算）现在藏着吗：在折叠的调用子树里，或在折叠的 Section 里。
 * 用户看不见的卡不能被框选、全选、吸附、删除，适应窗口也不算它
 */
export function isHidden(id: string): boolean {
  const h = hostOf(id);
  return collapsedAway().has(h) || !!collapsedHome(state.board.place[h]?.section);
}
/** 画布上看得见的卡，按叠放顺序 */
export const visibleCards = rooted(() => createMemo(() => placed().filter((c) => !isHidden(c.id))));

/** 卡片被藏起来了吗（在折叠的 Section 里）；返回最外层折叠的那个 */
export function collapsedHome(cardSection?: string): Section | undefined {
  let out: Section | undefined;
  for (let q = sec(cardSection), i = 0; q && i < 50; q = sec(q.parent), i++) if (q.collapsed) out = q;
  return out;
}
