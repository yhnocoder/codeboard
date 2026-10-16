// Section 的实际框：自己存的框 ∪ 成员卡（含边距）∪ 子 Section。框随内容自动撑大，也能拖边改大。
// 成员关系：卡片中心点落在哪个最深的框里（拖动结束时更新）。
import { createMemo, mapArray } from "solid-js";
import { union, type Rect } from "@codeboard/core";
import { state, rectOf, placed } from "./store";
import type { Section } from "@codeboard/core";

export const PAD = { l: 22, r: 22, t: 34, b: 22 };
export const PILL = { w: 220, h: 32 };

const byId = createMemo(() => new Map(state.board.sections.map((s) => [s.id, s])));
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
const kids = createMemo(() => groupBy(state.board.sections, (s) => s.parent));
const members = createMemo(() => groupBy(placed(), (c) => state.board.place[c.id]?.section));
function groupBy<T>(xs: T[], key: (x: T) => string | undefined) {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); if (k === undefined) continue; const a = m.get(k); a ? a.push(x) : m.set(k, [x]); }
  return m;
}
export const childrenOf = (id: string) => kids().get(id) ?? [];
export function descSections(id: string): Section[] {
  const out: Section[] = [];
  const walk = (x: string) => childrenOf(x).forEach((c) => { if (!out.includes(c)) { out.push(c); walk(c.id); } });
  walk(id);
  return out;
}
export const directMembers = (id: string) => members().get(id) ?? [];
export const allMembers = (id: string) => {
  const ids = new Set([id, ...descSections(id).map((s) => s.id)]);
  return placed().filter((c) => { const s = state.board.place[c.id]?.section; return !!s && ids.has(s); });
};

/** 展开着的 Section 的框（世界坐标）；skip = 拖动中的卡不算 */
export function frameOf(s: Section, skip?: Set<string>, seen = new Set<string>()): Rect {
  if (seen.has(s.id)) return { x: s.x, y: s.y, w: s.w, h: s.h };
  seen.add(s.id);
  let r: Rect = { x: s.x, y: s.y, w: s.w, h: s.h };
  for (const c of directMembers(s.id)) {
    if (skip?.has(c.id)) continue;
    const k = rectOf(c);
    r = union(r, { x: k.x - PAD.l, y: k.y - PAD.t, w: k.w + PAD.l + PAD.r, h: k.h + PAD.t + PAD.b });
  }
  for (const ch of childrenOf(s.id)) {
    const k = ch.collapsed ? { x: ch.x, y: ch.y, w: PILL.w, h: PILL.h } : frameOf(ch, skip, seen);
    r = union(r, { x: k.x - PAD.l, y: k.y - PAD.t, w: k.w + PAD.l + PAD.r, h: k.h + PAD.t + PAD.b });
  }
  return r;
}
/** 渲染用：每个可见的 Section 的框（折叠的是标题条） */
// 每个 Section 一个 memo（子 Section 用它自己的 memo）：拖一张卡时只重算它所在的 Section 和上面几层，不是 42 个全算
const pillOf = (s: Section): Rect => ({ x: s.x, y: s.y, w: PILL.w, h: PILL.h });
const frameMemos = mapArray(() => state.board.sections, (s) => [s.id, createMemo<Rect | undefined>(() => {
  let r: Rect = { x: s.x, y: s.y, w: s.w, h: s.h };
  for (const c of directMembers(s.id)) {
    const k = rectOf(c);
    r = union(r, { x: k.x - PAD.l, y: k.y - PAD.t, w: k.w + PAD.l + PAD.r, h: k.h + PAD.t + PAD.b });
  }
  for (const ch of childrenOf(s.id)) {
    // 子 Section 的 memo 还没建好（或者父子关系成了环，不该发生）时退回它自己存的框
    const k = ch.collapsed ? pillOf(ch) : memoById().get(ch.id)?.() ?? { x: ch.x, y: ch.y, w: ch.w, h: ch.h };
    r = union(r, { x: k.x - PAD.l, y: k.y - PAD.t, w: k.w + PAD.l + PAD.r, h: k.h + PAD.t + PAD.b });
  }
  return r;
}, undefined, { equals: (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h })] as const);
const memoById = createMemo(() => new Map(frameMemos()));
/** 渲染用：每个可见的 Section 的框（折叠的是标题条）。没变的框还是上一次的对象，全都没变就还是上一次的 Map */
export const frames = createMemo<Map<string, Rect>>((prev) => {
  const m = new Map<string, Rect>(), ms = memoById();
  let same = true;
  for (const s of state.board.sections) {
    if (hiddenByAncestor(s)) continue;
    const r = s.collapsed ? pillOf(s) : ms.get(s.id)?.() ?? frameOf(s);
    const p = prev.get(s.id);
    if (p && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h) m.set(s.id, p); else { m.set(s.id, r); same = false; }
  }
  return same && m.size === prev.size ? prev : m;
}, new Map());

/** 世界坐标 (x, y) 落在哪个最深的展开 Section 里 */
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

/** 卡片被藏起来了吗（在折叠的 Section 里）；返回最外层折叠的那个 */
export function collapsedHome(cardSection?: string): Section | undefined {
  let out: Section | undefined;
  for (let q = sec(cardSection), i = 0; q && i < 50; q = sec(q.parent), i++) if (q.collapsed) out = q;
  return out;
}
