// Link 层：SVG 箭头。走线规则见 route.ts（W03）；这里把卡、行、Compare 栏的位置读出来，按条建 memo，只在它两端的卡变了时重算。
// 线都画在所有卡下面那一层（见下面的「图层」），选中的、正拖着的、指针下那张卡的线临时浮到所有卡上面。
// 每条线：base（两端的矩形和行的 y）→ sides（走哪一侧，带缓冲）→ ends（端点，换边时滑过去）→ geo（路径、箭头）。
// 汇到同一处（同一张卡的卡头 / 同一行、同一侧）的几条线：各自画到合并点，合并点到终点的那一小段和箭头只画一次（<g class="merge">）。
import { Show, batch, createEffect, createMemo, createRenderEffect, createRoot, createSelector, createSignal, mapArray, on, onCleanup, untrack, type Accessor } from "solid-js";
import { headOf, type Link, type LinkSide, type Rect } from "@codeboard/core";
import { state, sel, select, rectOf, cardById, collapsedAway, placeOf, placed, live, beginGesture } from "../state/store";
import { geo, lineY } from "../state/geo";
import { frames, collapsedHome } from "../state/sections";
import { hoverLink, setHoverLink, hoverCard, setHoverCard, dragLink, setDragLink, rubber, popIn } from "../state/ui";
import { cam, toWorld, stillZ, lod, reduceMotion, camMoving } from "../state/camera";
import { lodOf } from "../state/lodcards";
import { boardOffset } from "../actions/common";
import { shape, fileHue, look } from "../state/look";
import { tune } from "../state/tune";
import { isDbl } from "../interact";
import * as A from "../actions";
import { LinkLabel } from "./Labels";
import { LinkStickers } from "../stickers/Picker";
import { subRect, frameOf } from "../state/subboards";
import { FRAME_HEAD } from "@codeboard/core";
import { chooseMode, sidesOf, anchorOn, slide, connect, selfArc, gutterLine, headPath, type Anchor, type Box, type Mode, type Side, type Shape } from "./route";
import { carAt, type CarPose, type Road } from "./city";
import { Car, Lane, trackTraffic } from "./Traffic";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** 卡（或 Compare 的一栏）的矩形；在折叠的 Section 里时是那个标题条 */
function endRect(id: string): { r: Rect; pill: boolean } | null {
  const f = cardById(id);
  if (!f) return null;
  const home = collapsedHome(placeOf(f.host.id).section);
  if (home) { const r = frames().get(home.id); return r ? { r, pill: true } : null; }
  const r = rectOf(f.host);
  const pi = popIn()[f.host.id];
  const base = pi ? { ...r, x: r.x + (1 - pi.v) * pi.ox, y: r.y + (1 - pi.v) * pi.oy } : r;
  const g = geo[id];
  if (f.host.id !== id && g?.colX !== undefined) return { r: { x: base.x + g.colX, y: base.y, w: g.colW ?? base.w / 2, h: base.h }, pill: false };
  return { r: base, pill: false };
}
/** 卡头那一行的 y（卡端落在左右边时用） */
function headY(id: string, r: Rect) {
  const f = cardById(id);
  const g = geo[id];
  if (f && f.host.id !== id && g) return r.y + g.head - 14; // Compare 栏头
  return r.y + 17;
}

/** 一端：矩形、是不是行端、行的 y（看不到那一行时 = 卡头）、Compare 的哪一栏 */
type End = {
  box: Box; /** 整张卡（Compare 栏 → 整张 Compare）：绕路时要避开的 */ outer: Box; line: boolean; y: number; /** 卡头那一行的 y（行端的卡在地图档时用） */ hy: number; col?: "left" | "right"; host: string; card: string; pill: boolean;
  /** 连到子白板骨架里的一张卡（End.sub）：那张卡在画布上的矩形。线先走到框边上的入口点（box 左右两边、对着那张卡的高度），再进去落到它上面 */
  inner?: Box;
};
type Base = { a: End; b: End; kind: "normal" | "self" | "gutter"; gx?: number };

/** 行端的那张卡在地图档（看不到行）：端点落到卡头 */
const mapHides = (e: Link["from"]) => { if (e.line === undefined) return false; const f = cardById(e.card); return !!f && lodOf(f.host.id) === "map"; };

function endOf(e: Link["from"]): End | null {
  const er = endRect(e.card);
  if (!er) return null;
  const f = cardById(e.card)!;
  const r = er.r;
  const line = e.line !== undefined;
  const hy = er.pill ? r.y + r.h / 2 : headY(e.card, r);
  let y = hy;
  // 行端：那一行的 y；行被折叠 / 藏起来时落到卡头，线的样子不变（W01 B 5）。卡在地图档（看不到行）时也落到卡头：那个在 ends 里挑（hy）
  if (line && !er.pill) {
    const p = lineY(e.card, e.seg, e.line);
    const row = p?.row !== undefined ? geo[e.card]?.rows[p.row] : undefined;
    if (p && row?.t === "line" && row.line === e.line) { const pi = popIn()[f.host.id]; y = p.y + (pi ? (1 - pi.v) * pi.oy : 0); }
  }
  let col: End["col"];
  const g = geo[e.card];
  if (!er.pill && f.host.id !== e.card && g?.colX !== undefined && (g.colW ?? 0) < rectOf(f.host).w - 1) col = g.colX > 1 ? "right" : "left";
  // 子白板骨架里的一张卡：像行端一样只走左右两边，入口点在框边上、对着那张卡（夹在标题栏下面）
  if (e.sub !== undefined && !er.pill && frameOf(e.card)) {
    const ir = subRect(e.card, e.sub);
    if (ir) return { box: r, outer: r, line: true, y: Math.max(r.y + FRAME_HEAD + 4, Math.min(r.y + r.h - 6, ir.y + ir.h / 2)), hy, host: f.host.id, card: e.card, pill: false, inner: ir };
  }
  let outer = r;
  if (col) { const h = rectOf(f.host), pi = popIn()[f.host.id]; outer = pi ? { ...h, x: h.x + (1 - pi.v) * pi.ox, y: h.y + (1 - pi.v) * pi.oy } : h; }
  return { box: r, outer, line, y, hy, col, host: f.host.id, card: e.card, pill: er.pill };
}

function baseOf(L: Link): Base | null {
  const a = endOf(L.from), b = endOf(L.to);
  if (!a || !b) return null;
  if (a.host === b.host && !a.pill) {
    // 同一张 Compare 的两栏之间、行对行：中缝的对照线（W01 B 11）
    if (a.card !== b.card && a.col && b.col && a.col !== b.col && a.line && b.line) return { a, b, kind: "gutter", gx: a.col === "left" ? a.box.x + a.box.w : b.box.x + b.box.w };
    return { a, b, kind: "self" };
  }
  return { a, b, kind: "normal" };
}

const okSide = (s: LinkSide | undefined, line: boolean): Side | undefined => (s && (!line || s === "left" || s === "right") ? s : undefined);

// 每条线上一次的摆法（换边缓冲要知道现在是哪种）。不是响应式的：只在这条线自己的 memo 里读写
const modes = new Map<string, Mode>();

/** 两端走哪一侧：用户指定（W03 10）> Compare 栏（左栏只走左侧、右栏只走右侧，W01 B 10 / 12）> 自动（W03 1–4，带缓冲） */
function sidesFor(L: Link, bs: Base, remember: boolean): [Side, Side] {
  const { a, b } = bs;
  const uf = okSide(L.sides?.from, a.line), ut = okSide(L.sides?.to, b.line);
  if (bs.kind !== "normal") {
    const s: Side = uf ?? a.col ?? "right";
    return [s, ut ?? (bs.kind === "self" ? s : b.col ?? "left")];
  }
  let auto: [Side, Side] = ["right", "left"];
  if (!((uf ?? a.col) && (ut ?? b.col))) {
    const m = chooseMode(a.box, b.box, !a.line && !b.line, modes.get(L.id), tune("sideBuffer"));
    if (remember) modes.set(L.id, m);
    auto = sidesOf(m);
  }
  return [uf ?? a.col ?? auto[0], ut ?? b.col ?? auto[1]];
}
/** atMap：两端各自是不是「行端、那张卡在地图档」（落到卡头） */
const anchorsFor = (bs: Base, s: [Side, Side], atMap: readonly [boolean, boolean]): [Anchor, Anchor] =>
  [anchorOn(bs.a.box, s[0], atMap[0] ? bs.a.hy : bs.a.y), anchorOn(bs.b.box, s[1], atMap[1] ? bs.b.hy : bs.b.y)];

export type Geo = { d: string; mx: number; my: number; head?: string | CarPose; tail?: string | CarPose; port?: { x: number; y: number }; port2?: { x: number; y: number }; pts: number[]; /** 子白板框上的入口点 */ entry?: { x: number; y: number } };

/** 粗细档 → 箭头放大多少 */
const headScale = (L: Link) => (L.style?.width === 1 ? 0.85 : L.style?.width === 3 ? 1.25 : 1);
/** 合并点离终点多远 */
const STUB = 28;

/** 箭头的 d；City（head = "car"）是那辆车的位置（Car 把它烤进 path） */
const headOrCar = (k: Shape0["head"], tx: number, ty: number, ux: number, uy: number, s: number) =>
  k === "car" ? carAt(tx, ty, ux, uy, s) : headPath(k, tx, ty, ux, uy, s);
type Shape0 = ReturnType<typeof shape>;
/** 箭头（或 City 的车）：同一份几何画成 path，或车的三条 path（见 Traffic.tsx） */
function Head(p: { cls: string; d: string | CarPose; road?: Road }) {
  return <>{shape().head === "car" ? <Car cls={p.cls} at={p.d as CarPose} road={p.road} /> : <path class={p.cls} d={p.d as string} />}</>;
}

function geoFrom(L: Link, bs: Base, p: Anchor, q: Anchor, merged: boolean): Geo {
  const route = shape().route, hd = headOf(L), hk = shape().head, s = headScale(L);
  let sh: Shape;
  if (bs.kind === "gutter") {
    sh = gutterLine(bs.gx!, p.y, q.y, bs.a.col === "left");
    return { d: sh.d, mx: sh.mx, my: sh.my, pts: sh.pts, port: { x: sh.pts[0], y: sh.pts[1] }, port2: { x: sh.pts[6], y: sh.pts[7] } };
  }
  const clear = shape().clear;
  if (bs.kind === "self") sh = selfArc(p, q, route, clear);
  else {
    const boxes = { a: bs.a.pill ? undefined : bs.a.outer, b: bs.b.pill ? undefined : bs.b.outer };
    sh = merged ? connect(p, { ...q, x: q.x + q.nx * STUB, y: q.y + q.ny * STUB }, route, { start: true, end: false }, boxes, clear) : connect(p, q, route, undefined, boxes, clear);
    // 子白板：线到框边上的入口点，再直着进去落到骨架里那张卡的名字上（箭头画在那里）
    const inn = bs.b.inner;
    if (inn && !merged) {
      const left = q.nx < 0, tx = left ? inn.x : inn.x + inn.w, ty = inn.y + inn.h / 2;
      const ux = Math.sign(tx - q.x) || (left ? 1 : -1);
      return {
        d: `${sh.d} L${tx} ${ty}`, mx: sh.mx, my: sh.my, pts: sh.pts,
        head: hd.end ? headOrCar(hk, tx, ty, ux, 0, s) : undefined,
        tail: hd.start ? headOrCar(hk, sh.pts[0], sh.pts[1], sh.outDir.x, sh.outDir.y, s) : undefined,
        port: { x: p.x, y: p.y }, entry: { x: q.x, y: q.y },
      };
    }
  }
  return {
    d: sh.d, mx: sh.mx, my: sh.my, pts: sh.pts,
    head: hd.end && !merged ? headOrCar(hk, sh.pts[6], sh.pts[7], sh.inDir.x, sh.inDir.y, s) : undefined,
    tail: hd.start ? headOrCar(hk, sh.pts[0], sh.pts[1], sh.outDir.x, sh.outDir.y, s) : undefined,
    port: { x: p.x, y: p.y },
  };
}

// ---------- 每条线一份走线状态 ----------

type Route = {
  L: Link;
  base: Accessor<Base | null>;
  sides: Accessor<string>; // "right|left"；拿不到端点时 ""
  ends: Accessor<[Anchor, Anchor] | null>;
  /** 汇合用的签名：同一个终点、同一侧、有没有箭头都一样的才合并；自连 / 对照线 = "" */
  sig: Accessor<string>;
  /** 画出来的几何（含合并、滑动）；trackLinks 给要画的线填上 */
  geo?: Accessor<Geo | null>;
  /** 画在哪张卡的那一层（两端里叠放次序高的那张，见下面的「图层」） */
  owner?: Accessor<string>;
  /** 这条线的节点：只建一次，换层时整块搬过去 */
  dom?: Dom;
};
const routes = new Map<string, Route>();

// 换边时端点滑过去（W03 6）：只有正在换边的那几条线跟着 rAF 重算，别的线不动
const sliding = new Map<string, (t: number) => void>();
let slideRaf = 0;
function tickSlides(now: number) {
  slideRaf = 0;
  batch(() => { for (const f of [...sliding.values()]) f(now); });
  if (sliding.size) slideRaf = requestAnimationFrame(tickSlides);
}

function makeRoute(L: Link): Route {
  const base = createMemo(() => baseOf(L));
  // 卡的缩放分档一批批换（lodcards.ts）：只有进出地图档会挪行端（落到卡头）。每端一个布尔 memo，只接到 ends 上：
  // 别的换档不碰这条线，进出地图档也只重算端点和路径，两端的矩形、走哪一侧（base / sides）不重算
  const mapA = createMemo(() => mapHides(L.from)), mapB = createMemo(() => mapHides(L.to));
  const sides = createMemo(() => { const bs = base(); return bs ? sidesFor(L, bs, true).join("|") : ""; });
  // 滑动中：从哪一侧滑过来、进度 0..1（已缓动）
  const [sl, setSl] = createSignal<{ from: [Side, Side]; p: number } | null>(null);
  createEffect(on(sides, (now, before) => {
    if (!before || !now || now === before || reduceMotion()) return;
    const dur = tune("sideSlide") * (100 / tune("animSpeed"));
    if (dur <= 0) return;
    const from = before.split("|") as [Side, Side];
    let t0 = -1;
    setSl({ from, p: 0 });
    sliding.set(L.id, (t) => {
      if (t0 < 0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      if (p >= 1) { sliding.delete(L.id); setSl(null); } else setSl({ from, p: 1 - (1 - p) ** 3 });
    });
    if (!slideRaf) slideRaf = requestAnimationFrame(tickSlides);
  }, { defer: true }));
  onCleanup(() => { sliding.delete(L.id); modes.delete(L.id); });
  const ends = createMemo<[Anchor, Anchor] | null>(() => {
    const bs = base(), s = sides();
    if (!bs || !s) return null;
    const atMap = [mapA(), mapB()] as const;
    const now = anchorsFor(bs, s.split("|") as [Side, Side], atMap);
    const m = sl();
    if (!m) return now;
    const was = anchorsFor(bs, m.from, atMap);
    return [slide(was[0], now[0], m.p), slide(was[1], now[1], m.p)];
  });
  const sig = createMemo(() => {
    const bs = base(), s = sides();
    if (!bs || !s || bs.kind !== "normal" || bs.b.inner) return ""; // 连进子白板骨架的不合并（各自落到骨架里的卡上）
    return `${s.split("|")[1]}|${headOf(L).end ? 1 : 0}`;
  });
  return { L, base, sides, ends, sig };
}

/** 终点是同一处的几条线（同一张卡的卡头，或同一行）：终点的 key */
const toKey = (L: Link) => `${L.to.card}|${L.to.seg ?? ""}|${L.to.line ?? ""}${L.to.sub !== undefined ? `|${L.to.sub}` : ""}`;

/** 线的三次贝塞尔控制点 [x1 y1 c1x c1y c2x c2y x2 y2]（贴纸、标签沿线走时用） */
export function linkCurve(id: string): number[] | null {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || !visible(L)) return null;
  return geoOf(L)?.pts ?? null;
}
/** 一条线的几何：画着的就用画着的那份（含合并、滑动）；没画的现算一份（不合并） */
export function geoOf(L: Link): Geo | null {
  const r = routes.get(L.id);
  if (r?.L === L && r.geo) return r.geo();
  const bs = baseOf(L);
  if (!bs) return null;
  const [p, q] = anchorsFor(bs, sidesFor(L, bs, false), [mapHides(L.from), mapHides(L.to)]);
  return geoFrom(L, bs, p, q, false);
}
export function curveAt(p: number[], t: number) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7] };
}
/** 离 (x, y) 最近的那一点的 t */
export function nearestT(p: number[], x: number, y: number) {
  let best = 0.5, bd = Infinity;
  for (let i = 0; i <= 100; i++) { const q = curveAt(p, i / 100), d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = i / 100; } }
  return best;
}

function portPath(x: number, y: number) {
  const k = shape().port;
  if (k === "square") return `M${x - 3} ${y - 3} h6 v6 h-6 Z`;
  if (k === "diamond") return `M${x} ${y - 4} l4 4 -4 4 -4 -4 Z`;
  if (k === "plaza") return `M${x - 6.5} ${y} a6.5 6.5 0 1 0 13 0 a6.5 6.5 0 1 0 -13 0`;
  return `M${x - 3} ${y} a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0`;
}

export function visible(L: Link) {
  const a = cardById(L.from.card), b = cardById(L.to.card);
  if (!a || !b) return false;
  if (collapsedAway().has(a.host.id) || collapsedAway().has(b.host.id)) return false;
  const ha = collapsedHome(placeOf(a.host.id).section), hb = collapsedHome(placeOf(b.host.id).section);
  if (ha && ha === hb) return false;
  return true;
}

/** 拖起点的小圆点：只能换到这一行的另一端（左 / 右），松手时看指针在卡中线哪边 */
function portDrag(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  const L = state.board.links.find((l) => l.id === id);
  if (!L || L.from.line === undefined) return;
  const a = endRect(L.from.card)?.r;
  if (!a) return;
  const end = beginGesture();
  setDragLink(id);
  const move = (ev: PointerEvent) => {
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const side = w.x >= a.x + a.w / 2 ? "right" : "left";
    live((b) => { const k = b.links.find((l) => l.id === id); if (k && k.sides?.from !== side) k.sides = { ...k.sides, from: side }; });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setDragLink(null); end(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}


/** 画着的线的走线状态（City 的车流要读） */
const [roads, setRoads] = createSignal<Accessor<Route[]>>(() => []);

/**
 * 卡端（不连行）落在哪张卡的哪一边：「卡 id|边」。那一边的圆点（.eport）就不画了，线头已经标出那个位置（圆点盖在箭头上很难看），
 * 鼠标移上去照样能拖。只读每条线的 sides memo：拖卡片时不重算，只在换边、增删线时变；createSelector 只通知结果变了的那几个圆点
 */
export const landed = createRoot(() => {
  const keys = createMemo(() => {
    const out = new Set<string>();
    for (const r of roads()()) {
      const s = r.sides();
      if (!s) continue;
      const [a, b] = s.split("|");
      if (r.L.from.line === undefined) out.add(`${r.L.from.card}|${a}`);
      if (r.L.to.line === undefined && r.L.to.sub === undefined) out.add(`${r.L.to.card}|${b}`);
    }
    return out;
  }, new Set<string>(), { equals: (x, y) => x.size === y.size && [...x].every((k) => y.has(k)) });
  return createSelector(keys, (k: string, set) => set.has(k));
});

// ---------- 图层 ----------
// 所有的线画在所有卡下面那一层（BOTTOM，Section 框上面、第一张卡前面），全白板共用一个 SVG：卡盖得住线，线不压任何卡。
// 同一层里按线两端里叠放次序（b.cards 的顺序）高的那张卡排，同一张卡的线保持 links 里的先后。
// 选中的线、正在拖 / 正在连的线、指针下那张卡的线临时放到最上面一层（.lyr.top），结束了回到下面。
// 线头的圆点（path.port、拖行端的 .porthit）落在卡边上，在卡下面会被盖住一半：圆点单独放在所有卡上面的一层（PORTS），浮上来的线的圆点跟线一起在最上面。
// 每条线的节点（线、City 的路沿和白边线、圆点、标签框和贴纸）只建一次，浮上来、落回去时整块搬（insertBefore），不拆掉重建：
// 几何 memo、量好的标签框大小、正拖着的元素都还在

const TOP = " top", BOTTOM = " bottom", PORTS = " ports";
type Dom = { line: SVGGElement; casing: SVGGElement; kerb: SVGGElement; port?: SVGGElement; label?: HTMLElement };
type MergeV = { members: Accessor<Link[]>; dom: Dom };
type Slot = { casings: SVGGElement; kerbs: SVGGElement; lines: SVGGElement; merges: SVGGElement; ports: SVGGElement; labels: HTMLDivElement; rs: Route[]; ms: MergeV[]; pt: Route[] };
/** pt：圆点放在 PORTS 层的线（没浮上来的） */
type Plan = { m: Map<string, { rs: Route[]; ms: MergeV[] }>; pt: Route[] };
const NO_PLAN: Plan = { m: new Map(), pt: [] };
const slots = new Map<string, Slot>();
const [slotTick, setSlotTick] = createSignal(0);
let plan: Accessor<Plan> = () => NO_PLAN;

const same = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * 让 p 里 ns 的这些子节点依次排好：已经在位置上的不动，只搬真要动的那几个。不在 ns 里的节点（要搬去别的层的）先跳过，留给那一层的 order 搬走；
 * 不跳过的话，一条线浮上去时它后面的每条线都要搬一遍（线全在一层里时就是整层，悬停一张卡要重算一百多条线的样式）
 */
function order(p: Element, ns: Element[]) {
  const want = new Set<Element>(ns);
  let at = p.firstElementChild;
  for (const n of ns) {
    while (at && at !== n && !want.has(at)) at = at.nextElementSibling;
    if (n === at) at = at.nextElementSibling; else p.insertBefore(n, at);
  }
}

// 指针下的卡：离开后过 linkLeave 才算离开，鼠标从卡移到它的线上时线不掉下去。镜头动的时候不换（内容从指针下滑过也会进出卡），停下再按最后的那张算
let hovNow: string | null = null, cardT: number | undefined;
const hostOf = (id: string) => cardById(id)?.host.id;
const settleHover = () => { clearTimeout(cardT); cardT = window.setTimeout(() => { if (!camMoving()) setHoverCard(hovNow); }, tune("linkLeave")); };
export const enterCard = (id: string) => { hovNow = id; clearTimeout(cardT); if (!camMoving()) setHoverCard(id); };
export const leaveCard = (id: string) => { if (hovNow === id) hovNow = null; settleHover(); };
// 不只靠 pointerleave：它会丢（卡在指针下被挪位置 / 重排、指针捕获刚释放、慢机器上事件挤在一起），丢了那张卡就一直算悬停，它的线一直浮在所有卡上面。
// 所以指针每动一下都核对一次：落点已经不在悬停的那张卡里 → 当它离开了；卡重排之后指针不动也在下一帧按指针下面是什么核对一次。
// 走的还是 leaveCard → settleHover，落回去照样过 linkLeave、照样淡出
let ptr: { x: number; y: number } | null = null;
const inHovered = (el: EventTarget | Element | null) => !!hovNow && el instanceof Element && !!el.closest(`.card[data-id="${CSS.escape(hovNow)}"]`);
const checkHover = (el: EventTarget | Element | null) => { if (hovNow && !inHovered(el)) leaveCard(hovNow); };
function watchHover() {
  const move = (e: PointerEvent) => { ptr = { x: e.clientX, y: e.clientY }; checkHover(e.target); };
  window.addEventListener("pointermove", move, { capture: true, passive: true });
  onCleanup(() => window.removeEventListener("pointermove", move, { capture: true }));
  // 只在有悬停的卡、而且是这张卡在 b.cards 里的位置变了（重排）时才看：撤销 / 重做 / 同步换掉 b.cards 不会每次都去读指针下面是什么（会强制排版）
  let raf = 0;
  createEffect(on(() => { const id = hoverCard(); return id ? `${id} ${state.board.cards.findIndex((c) => c.id === id)}` : ""; }, (k, prev) => {
    if (!k || !prev || k === prev || k.split(" ")[0] !== prev.split(" ")[0]) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (hovNow && ptr) checkHover(document.elementFromPoint(ptr.x, ptr.y)); });
  }));
  onCleanup(() => cancelAnimationFrame(raf));
}

// 离开连线后过 300ms 才算离开：鼠标从线移到 "+" 或变量框的路上不丢悬停（#30）。移到指针下那张卡的线上时，那张卡也还算悬停着
let leaveT: number | undefined;
export const enterLink = (id: string) => {
  clearTimeout(leaveT); setHoverLink(id);
  const L = routes.get(id)?.L, hc = untrack(hoverCard);
  if (L && hc && (hostOf(L.from.card) === hc || hostOf(L.to.card) === hc)) clearTimeout(cardT);
};
export const leaveLink = () => { clearTimeout(leaveT); leaveT = window.setTimeout(() => setHoverLink(null), tune("linkLeave")); if (untrack(hoverCard) !== hovNow) settleHover(); };

/** Canvas 里调用一次：每条线的走线、几何、节点，和它画在哪一层 */
export function trackLinks() {
  const links = createMemo(() => state.board.links.filter(visible));
  // 每条线的走线状态先全建好（合并要读别的线走哪一侧），再算几何
  const list = createMemo(mapArray(links, (L) => {
    const r = makeRoute(L);
    routes.set(L.id, r);
    onCleanup(() => { if (routes.get(L.id) === r) routes.delete(L.id); });
    return r;
  }));
  const byId = createMemo(() => new Map(list().map((r) => [r.L.id, r])));
  // 终点相同的线（至少两条）：只看两端的 id / 行，拖动卡片不会让它重算
  const groups = createMemo(() => {
    const m = new Map<string, Link[]>();
    for (const L of links()) { const k = toKey(L); const g = m.get(k); if (g) g.push(L); else m.set(k, [L]); }
    for (const [k, g] of m) if (g.length < 2) m.delete(k);
    return m;
  });
  const mergedWith = (L: Link, sig: string) => {
    if (!sig) return false;
    const g = groups().get(toKey(L));
    return !!g && g.some((o) => o !== L && byId().get(o.id)?.sig() === sig);
  };
  // 要画合并段的组：「终点 key # 签名」。只在某条线换了边、增删线时变
  const merges = createMemo(() => {
    const out: string[] = [];
    for (const [k, g] of groups()) {
      const seen = new Map<string, number>();
      for (const L of g) { const s = byId().get(L.id)?.sig(); if (s) seen.set(s, (seen.get(s) ?? 0) + 1); }
      for (const [s, n] of seen) if (n >= 2) out.push(`${k}#${s}`);
    }
    return out.join("\n");
  });
  const city = () => look() === "city";
  // 卡的叠放次序：b.cards 里第几张（placed() 跟它同序）。只在增删卡、Arrange 时变
  const rank = createMemo(() => new Map(placed().map((c, i) => [c.id, i])));
  const views = createMemo(mapArray(list, (r) => {
    const L = r.L;
    const merged = createMemo(() => mergedWith(L, r.sig()));
    const g = createMemo(() => { const bs = r.base(), e = r.ends(); return bs && e ? geoFrom(L, bs, e[0], e[1], merged()) : null; });
    r.geo = g;
    // 两端里叠放次序高的那张卡；两张都不在画布上时是 ""（画在所有卡上面那一层）
    r.owner = createMemo(() => {
      const a = hostOf(L.from.card), b = hostOf(L.to.card), k = rank();
      const ia = a ? k.get(a) ?? -1 : -1, ib = b ? k.get(b) ?? -1 : -1;
      return ia < 0 && ib < 0 ? "" : ia >= ib ? a! : b!;
    });
    const dom = linkDom(r, g, merged, city);
    r.dom = dom;
    onCleanup(() => { if (r.geo === g) r.geo = undefined; dom.line.remove(); dom.casing.remove(); dom.kerb.remove(); dom.port?.remove(); dom.label?.remove(); });
    return r;
  }));
  setRoads(() => views);
  const mviews = createMemo(mapArray(() => (merges() ? merges().split("\n") : []), (key) => {
    const st = stubOf(key, groups, byId);
    const dom = mergeDom(key, st, city);
    onCleanup(() => { dom.line.remove(); dom.casing.remove(); dom.kerb.remove(); });
    return { members: st.members, dom } as MergeV;
  }));
  // 临时放到最上面的线：选中的、正在拖的、指针下那张卡的
  const lifted = createMemo(() => {
    const out = new Set<string>(sel.links);
    const d = dragLink();
    if (d) out.add(d);
    const hc = hoverCard();
    if (hc) for (const r of list()) if (hostOf(r.L.from.card) === hc || hostOf(r.L.to.card) === hc) out.add(r.L.id);
    return out;
  }, new Set<string>(), { equals: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)) });
  // 每一层画哪些线、哪些合并段：浮上来的在最上面那层（合并段的成员里有浮上来的，合并段也一起浮上来）。
  // 同一层里按线所属的卡的叠放次序排，同一张卡的线保持 links 里的先后
  plan = createMemo<Plan>(() => {
    const lf = lifted(), rk = rank(), m: Plan["m"] = new Map();
    const slot = (k: string) => { let x = m.get(k); if (!x) m.set(k, (x = { rs: [], ms: [] })); return x; };
    const pt: Route[] = [];
    for (const r of views()) { const k = lf.has(r.L.id) ? TOP : BOTTOM; slot(k).rs.push(r); if (k !== TOP) pt.push(r); }
    const ord = (r: Route) => rk.get(r.owner!()) ?? -1;
    for (const x of m.values()) x.rs.sort((a, b) => ord(a) - ord(b));
    for (const x of mviews()) slot(x.members().some((L) => lf.has(L.id)) ? TOP : BOTTOM).ms.push(x);
    return { m, pt };
  });
  // 把节点搬到它该在的那一层：只动内容变了的层，层里已经在位置上的节点不动
  const was = new WeakMap<object, string>();
  createEffect(() => {
    const { m, pt } = plan();
    slotTick();
    // 在上下两层之间换了层的线和合并段：先在原来那层留个影子，再搬，然后淡入 / 淡出
    for (const [k, x] of m) {
      if (k !== TOP && k !== BOTTOM) continue;
      for (const r of x.rs) { const d = r.dom!; if (was.has(r) && was.get(r) !== k) crossfade(r, [d.casing, d.kerb, d.line, d.label!], k === TOP); was.set(r, k); }
      for (const v of x.ms) { if (was.has(v) && was.get(v) !== k) crossfade(v, [v.dom.casing, v.dom.kerb, v.dom.line], k === TOP); was.set(v, k); }
    }
    for (const [k, s] of slots) {
      const want = m.get(k) ?? { rs: [], ms: [] };
      // 圆点：没浮上来的线的在 PORTS 层，浮上来的跟线一起在最上面那层
      const wp = k === PORTS ? pt : k === TOP ? want.rs : [];
      if (!same(s.pt, wp)) { order(s.ports, wp.map((r) => r.dom!.port!)); s.pt = wp; }
      if (same(s.rs, want.rs) && same(s.ms, want.ms)) continue;
      order(s.casings, [...want.rs.map((r) => r.dom!.casing), ...want.ms.map((x) => x.dom.casing)]);
      order(s.kerbs, [...want.rs.map((r) => r.dom!.kerb), ...want.ms.map((x) => x.dom.kerb)]);
      order(s.lines, want.rs.map((r) => r.dom!.line));
      order(s.merges, want.ms.map((x) => x.dom.line));
      order(s.labels, want.rs.map((r) => r.dom!.label!));
      s.rs = want.rs; s.ms = want.ms;
    }
  });
  createEffect(on(camMoving, (mv) => { if (!mv) setHoverCard(hovNow); }, { defer: true }));
  watchHover();
  // City 的车流：挑哪几条路只在镜头停下时算一次（Traffic.tsx）
  trackTraffic(views);
}

// 线浮上来、落回去时不硬切（Linda 10-17：太僵）：原来那层留一份影子，浮上来的那份从透明淡入（影子在卡下面垫着，没被卡盖住的那段一直在）；
// 落回去时影子留在上面一层淡出。影子只是拷贝的几条 path，去掉 data-lk / data-link，不接事件，动画完就删
const fading = new Map<object, () => void>();
function crossfade(key: object, els: Element[], up: boolean) {
  fading.get(key)?.();
  const ms = tune("liftFade") * (100 / tune("animSpeed"));
  if (ms <= 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  els = els.filter((el) => el.firstElementChild);
  const ghosts = els.map((el) => {
    const c = el.cloneNode(true) as Element;
    for (const x of [c, ...c.querySelectorAll("[data-lk],[data-link],[id]")]) { x.removeAttribute("data-lk"); x.removeAttribute("data-link"); x.removeAttribute("id"); }
    c.classList.add("ghost");
    el.before(c);
    return c;
  });
  // 标签框外面那层是 display: contents，透明度只能写在它里面的元素上
  const fx = (up ? els : ghosts).flatMap((el) => (el instanceof HTMLElement ? [...el.children] : [el])).map((el) => el.animate(up ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "ease-out" }));
  const done = () => { if (fading.get(key) !== done) return; fading.delete(key); for (const a of fx) a.cancel(); for (const g of ghosts) g.remove(); };
  fading.set(key, done);
  if (fx[0]) fx[0].onfinish = done; else done();
}

/** 线的一层：bottom = 所有卡下面那一层；ports = 没浮上来的线的圆点；top = 临时浮上来的线和正在连的线 */
export function LinkLayer(p: { top?: boolean; bottom?: boolean; ports?: boolean }) {
  return <Layer k={p.top ? TOP : p.bottom ? BOTTOM : PORTS} />;
}
function Layer(p: { k: string }) {
  const top = p.k === TOP;
  const s = { rs: [], ms: [], pt: [] } as unknown as Slot;
  const el = (
    <div class="lyr" classList={{ top, bottom: p.k === BOTTOM, ports: p.k === PORTS, "lod-overview": lod() === "overview", "lod-map": lod() === "map" }}>
      <svg class="edges" width="1" height="1">
        {/* City：这一层所有路的路沿在最底下，再是大路两边的白边线，都在路面下面：同一层的几条路交叉、汇合时路面连成一片，路口里没有边线 */}
        <g class="casings" ref={s.casings} />
        <g class="kerbs" ref={s.kerbs} />
        <g ref={s.lines} />
        <g ref={s.merges} />
        <g ref={s.ports} />
        <Show when={top}><Rubber /></Show>
      </svg>
      <div class="lw" ref={s.labels} />
    </div>
  );
  slots.set(p.k, s);
  setSlotTick((t) => t + 1);
  onCleanup(() => { if (slots.get(p.k) === s) slots.delete(p.k); });
  return el;
}

/** 正在连的线（橡皮筋），在最上面那一层 */
function Rubber() {
  return (
    <Show when={rubber()}>
      {(rb) => {
        const w0 = () => ({ x: (rb().x1 - cam.x) / cam.z, y: (rb().y1 - cam.y) / cam.z }), w1 = () => ({ x: (rb().x2 - cam.x) / cam.z, y: (rb().y2 - cam.y) / cam.z });
        const d = () => {
          const a = w0(), b = w1();
          if (rb().plain) {
            // 从行旁的点拖出：先朝拖的方向水平出去，再弯到指针
            const dx = clamp(Math.abs(b.x - a.x) * 0.5, 20, 120) * (b.x >= a.x ? 1 : -1);
            return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx * 0.3} ${b.y} ${b.x} ${b.y}`;
          }
          const dx = clamp(Math.abs(b.y - a.y) * 0.3 + Math.max(0, a.x - b.x) * 0.6, 28, 130);
          return `M${a.x} ${a.y} C${a.x - dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
        };
        return <path class={`edge rubber${rb().plain ? " plain" : ""}`} d={d()} />;
      }}
    </Show>
  );
}

/**
 * 点击区的粗细（屏幕上 12px）：单独一个 effect。写在 JSX 的 style 里会和这条线的其它属性编进同一个 effect，
 * 镜头每次停下（stillZ 变）196 条线都要把 class、合并、路径整个重算一遍
 */
const hitWidth = (el: SVGPathElement) => createRenderEffect(() => el.style.setProperty("stroke-width", `${12 / stillZ()}px`));

const colorCls = (L: Link) => (L.style?.color ? ` lc-${L.style.color}` : "");
const widthCls = (L: Link) => (L.style?.width === 1 ? " w1" : L.style?.width === 3 ? " w3" : "");
const isOn = (id: string) => sel.links.includes(id) || hoverLink() === id || (A.bindHot() as { link?: string } | null)?.link === id;

/** 一条线的节点：线本身、City 的路沿和白边线、标签框和贴纸。外面各包一层不变的节点，换层时整块搬 */
function linkDom(r: Route, g: Accessor<Geo | null>, merged: Accessor<boolean>, city: () => boolean): Dom {
  const L = r.L;
  const on = () => isOn(L.id);
  const toHue = () => { const t = cardById(L.to.card)?.card; return t?.kind === "code" ? fileHue(t.segments[0]?.path) : 0; };
  // 证据（manual 虚线、observed 绿）、Generated from（点线）：同一层，只换样式
  // RPC（跨进程）：点划线；↩ back to：淡一点
  const style = () => `${colorCls(L)}${widthCls(L)}${L.call?.ev ? ` ev-${L.call.ev.kind}` : ""}${L.gen ? " gen" : ""}${L.rpc ? " rpc" : ""}${L.back ? " back" : ""}`;
  const gutter = () => r.base()?.kind === "gutter";
  const road: Road = L.call ? "main" : "street";
  const cls = () => `edge${L.call ? "" : " plain"}${L.style?.dash ? " dashed" : ""}${style()}${L.lost ? " lost" : ""}${gutter() ? " cmpline" : ""}${on() ? " on" : ""}`;
  const line = (
    <g>
      <Show when={g()}>
        <g class="link" data-lk={L.id} data-from={L.from.card} data-to={L.to.card} data-call={L.call ? "" : undefined} data-merged={merged() ? "" : undefined} data-sides={r.sides()}>
          <path class={cls()} d={g()!.d} />
          <Show when={city() && !gutter()}><Lane d={g()!.d} road={road} s={headScale(L)} start={!!g()!.tail} end={!!g()!.head} /></Show>
          <Show when={g()!.head}><Head cls={`ahead end ${shape().head}${style()}${L.lost?.to ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.head!} road={road} /></Show>
          <Show when={g()!.tail}><Head cls={`ahead start ${shape().head}${style()}${L.lost?.from ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.tail!} road={road} /></Show>
          <path class="lhit" data-link={L.id} d={g()!.d} ref={hitWidth}
            onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
            onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (isDbl(`l${L.id}`)) return A.setLinkEditing(L.id); select({ links: [L.id] }, e.shiftKey); }} />
        </g>
      </Show>
    </g>
  ) as SVGGElement;
  // 线头的圆点：单独一组，放在卡上面那一层（见「图层」）
  const port = (
    <g data-lk={L.id}>
      <Show when={g()}>
        <Show when={g()!.port}><path class={`port fc-${toHue()}${L.lost?.from ? " lost" : ""}`} data-x={g()!.port!.x} d={portPath(g()!.port!.x, g()!.port!.y)} />
          <Show when={on() && L.from.line !== undefined && r.base()?.kind === "normal"}><circle class="porthit" onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} data-tip="Drag to the other end of the line" r={7 / stillZ()} cx={g()!.port!.x} cy={g()!.port!.y} onPointerDown={(e) => portDrag(e, L.id)} /></Show></Show>
        <Show when={g()!.port2}><path class={`port fc-${toHue()}`} d={portPath(g()!.port2!.x, g()!.port2!.y)} /></Show>
        <Show when={g()!.entry}><circle class={`sbentry${L.lost?.to ? " lost" : ""}`} r="4" cx={g()!.entry!.x} cy={g()!.entry!.y} /></Show>
      </Show>
    </g>
  ) as SVGGElement;
  const casing = <g><Show when={city() && !gutter() && g()}>{(gg) => <path class={`casing${L.call ? "" : " plain"}${widthCls(L)}`} d={gg().d} />}</Show></g> as SVGGElement;
  const kerb = <g><Show when={city() && L.call && !gutter() && g()}>{(gg) => <path class={`kerb${widthCls(L)}`} d={gg().d} />}</Show></g> as SVGGElement;
  const label = <div class="lw"><LinkLabel L={L} g={g} /><LinkStickers link={L.id} /></div> as HTMLDivElement;
  return { line, casing, kerb, port, label };
}

/**
 * 几条线汇到同一处（W03 8 / 9）：合并点到终点的一小段 + 一个箭头。
 * 结构固定，方便材质另画（City 的路口等）：<g class="merge" data-card data-line data-side data-n> 里一条 .edge.stub 和一个 .ahead.end
 */
/** 一个合并组：成员和合并段（Merge 和 City 的路沿、白边线共用） */
function stubOf(key: string, groups: Accessor<Map<string, Link[]>>, byId: Accessor<Map<string, Route>>) {
  const [k, sig] = key.split("#");
  const members = createMemo(() => (groups().get(k) ?? []).filter((L) => byId().get(L.id)?.sig() === sig), [], { equals: same });
  const g = createMemo(() => {
    const ms = members(), r = byId().get(ms[0]?.id ?? ""), e = r?.ends();
    if (!r || !e) return null;
    const q = e[1], mx = q.x + q.nx * STUB, my = q.y + q.ny * STUB;
    return {
      d: `M${mx} ${my} L${q.x} ${q.y}`,
      head: ms.some((x) => headOf(x).end) ? headOrCar(shape().head, q.x, q.y, -q.nx, -q.ny, headScale(r.L)) : undefined,
    };
  });
  return { members, g };
}
type Stub = ReturnType<typeof stubOf>;

function mergeDom(key: string, st: Stub, city: () => boolean): Dom {
  const casing = <g><Show when={city() && st.g()}><path class={`casing${st.members().every((L) => !L.call) ? " plain" : ""}`} d={st.g()!.d} /></Show></g> as SVGGElement;
  const kerb = <g><Show when={city() && st.g() && st.members().some((L) => L.call)}><path class="kerb" d={st.g()!.d} /></Show></g> as SVGGElement;
  return { line: <g><Merge key={key} st={st} /></g> as SVGGElement, casing, kerb };
}

function Merge(p: { key: string; st: Stub }) {
  const [k, sig] = p.key.split("#");
  const side = sig.split("|")[0];
  const [card, , line] = k.split("|");
  const { members, g } = p.st;
  const on = () => members().some((L) => isOn(L.id));
  const style = () => {
    const ms = members(), L = ms[0];
    if (!L) return "";
    return `${ms.every((x) => x.style?.color === L.style?.color) ? colorCls(L) : ""}${widthCls(L)}`;
  };
  const lost = () => members().every((L) => L.lost?.to);
  const road = (): Road => (members().some((L) => L.call) ? "main" : "street");
  return (
    <Show when={g()}>
      <g class="merge" data-card={card} data-line={line || undefined} data-side={side} data-n={members().length}>
        <path class={`edge stub${members().every((L) => L.style?.dash) ? " dashed" : ""}${style()}${lost() ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.d} />
        <Show when={look() === "city"}><Lane d={g()!.d} road={road()} s={members()[0] ? headScale(members()[0]) : 1} start={false} end={!!g()!.head} /></Show>
        <Show when={g()!.head}><Head cls={`ahead end ${shape().head}${style()}${lost() ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.head!} road={road()} /></Show>
      </g>
    </Show>
  );
}
