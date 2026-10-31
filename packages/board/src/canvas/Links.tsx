// 走线规则见 route.ts。每条线按条建 memo，只在它两端的卡变了时重算：
// base（两端的矩形和行的 y）→ sides（走哪一侧，带缓冲）→ ends（端点，换边时滑过去）→ geo（路径、箭头）。
// 汇到同一处（同一张卡的卡头 / 同一行、同一侧）的几条线：合并点到终点的那一小段和箭头只画一次（<g class="merge">）。
import { Show, createComputed, createEffect, createMemo, createRenderEffect, createSignal, mapArray, on, onCleanup, untrack, type Accessor, type Signal } from "solid-js";
import { headOf, type Link, type LinkSide, type Rect } from "@codeboard/core";
import { state, sel, select, rectOf, cardById, hostOf, collapsedAway, placeOf, placed, live, beginGesture } from "../state/store";
import { geo, lineY, setCurveSource, HEAD_H } from "../state/geo";
import { blockY, hoverBlock, keepBlock, leaveBlock, watchBlockHover } from "../state/blocks";
import { portStyle } from "../state/hover";
import { frames, collapsedHome } from "../state/sections";
import { dragLink, setDragLink, rubber, popIn, husk, type Husk } from "../state/ui";
import { hoverLink, hoverCard, enterLink, leaveLink, watchHover } from "../state/hover";
import { cam, toWorld, stillZ, lod, reduceMotion, animate, frameTime } from "../state/camera";
import { lodOf } from "../state/lodcards";
import { boardOffset } from "../state/measure";
import { shape, fileHue, look } from "../state/look";
import { tune } from "../state/tune";
import { isDbl, linkPortDown } from "../interact";
import * as A from "../actions";
import { LinkLabel } from "./Labels";
import { LinkStickers } from "../stickers/Picker";
import { holdPointer } from "../ui/guard";
import { isBindHot } from "../state/stickers";
import { chooseMode, sidesOf, anchorOn, turnAnchor, slide, connect, selfArc, gutterLine, headPath, type Anchor, type Box, type Mode, type Side, type Shape } from "./route";
import { handLine } from "./hand";
import { carAt, type CarPose, type Road } from "./city";
import { Car, Lane, trackTraffic } from "./Traffic";
import { tiltOf } from "../state/tilt";

import { clamp } from "./geom";

/** 卡这一帧的弹出偏移。折叠、展开 Section 时线藏着（husk），不跟着卡每帧重新走线：不读 popIn，停在卡的终点 */
const popOf = (host: string) => (husk(host) ? undefined : popIn()[host]);
/** 线跟着两端的卡藏起来、淡回来（state/ui.ts husk）：一端藏着就藏着 */
function linkHusk(L: Link): Husk | undefined {
  const a = cardById(L.from.card)?.host.id, b = cardById(L.to.card)?.host.id;
  const ha = a ? husk(a) : undefined, hb = b ? husk(b) : undefined;
  return ha === "out" || hb === "out" ? "out" : ha ?? hb;
}
// 线（SVG 的 g）和标签框各用自己的 class：同一个 class 名下有 "> *" 的规则时，浏览器给每个带它的节点都把整棵子树重算一遍
const huskEls = (els: Element[], h: () => Husk | undefined) => createRenderEffect(() => {
  const v = h();
  for (const el of els) { const k = el instanceof HTMLElement ? "whusk" : "lhusk"; el.classList.toggle(k, v === "out"); el.classList.toggle(`${k}-in`, v === "in"); }
});

/** 在折叠的 Section 里时是那个标题条 */
function endRect(id: string): { r: Rect; pill: boolean } | null {
  const f = cardById(id);
  if (!f) return null;
  const home = collapsedHome(placeOf(f.host.id).section);
  if (home) { const r = frames().get(home.id); return r ? { r, pill: true } : null; }
  const r = rectOf(f.host);
  const pi = popOf(f.host.id);
  const base = pi ? { ...r, x: r.x + (1 - pi.v) * pi.ox, y: r.y + (1 - pi.v) * pi.oy } : r;
  const g = geo[id];
  if (f.host.id !== id && g?.colX !== undefined) return { r: { x: base.x + g.colX, y: base.y, w: g.colW ?? base.w / 2, h: base.h }, pill: false };
  return { r: base, pill: false };
}
function headY(id: string, r: Rect) {
  const f = cardById(id);
  const g = geo[id];
  if (f && f.host.id !== id && g) return r.y + g.head - 14; // Compare 栏头
  return r.y + (g?.head ?? HEAD_H) / 2;
}

/** y：行的 y（看不到那一行时 = 卡头） */
type End = {
  box: Box; /** 整张卡（Compare 栏 → 整张 Compare）：绕路时要避开的 */ outer: Box; line: boolean; y: number; /** 卡头那一行的 y（行端的卡在地图档时用） */ hy: number; col?: "left" | "right"; host: string; card: string; pill: boolean;
};
type Base = { a: End; b: End; kind: "normal" | "self" | "gutter"; gx?: number };

/** 连着一行 / Note 的一块（不是整张卡）：只从左右两边进出 */
const subEnd = (e: Link["from"]) => e.line !== undefined || !!e.block;
/** 行端、块端的那张卡在地图档（看不到行和块）：端点落到卡头 */
const mapHides = (e: Link["from"]) => { if (!subEnd(e)) return false; const f = cardById(e.card); return !!f && lodOf(f.host.id) === "map"; };

function endOf(e: Link["from"]): End | null {
  const er = endRect(e.card);
  if (!er) return null;
  const f = cardById(e.card)!;
  const r = er.r;
  const line = subEnd(e);
  const hy = er.pill ? r.y + r.h / 2 : headY(e.card, r);
  let y = hy;
  // 块端：那一块的中线（state/blocks.ts 量的）；块没了、量不到时落到卡头，和行端一样
  if (e.block && !er.pill) {
    const by = blockY(e.card, e.block);
    if (by !== null) y = r.y + by;
  }
  // 行端：那一行的 y；行被折叠 / 藏起来时落到卡头，线的样子不变。卡在地图档（看不到行）时也落到卡头：那个在 ends 里挑（hy）
  else if (line && !er.pill) {
    const p = lineY(e.card, e.seg, e.line);
    const row = p?.row !== undefined ? geo[e.card]?.rows[p.row] : undefined;
    if (p && row?.t === "line" && row.line === e.line) { const pi = popOf(f.host.id); y = p.y + (pi ? (1 - pi.v) * pi.oy : 0); }
  }
  let col: End["col"];
  const g = geo[e.card];
  if (!er.pill && f.host.id !== e.card && g?.colX !== undefined && (g.colW ?? 0) < rectOf(f.host).w - 1) col = g.colX > 1 ? "right" : "left";
  let outer = r;
  if (col) { const h = rectOf(f.host), pi = popOf(f.host.id); outer = pi ? { ...h, x: h.x + (1 - pi.v) * pi.ox, y: h.y + (1 - pi.v) * pi.oy } : h; }
  return { box: r, outer, line, y, hy, col, host: f.host.id, card: e.card, pill: er.pill };
}

function baseOf(L: Link): Base | null {
  const a = endOf(L.from), b = endOf(L.to);
  if (!a || !b) return null;
  if (a.host === b.host && !a.pill) {
    // 同一张 Compare 的两栏之间、行对行：中缝的对照线
    if (a.card !== b.card && a.col && b.col && a.col !== b.col && a.line && b.line) return { a, b, kind: "gutter", gx: a.col === "left" ? a.box.x + a.box.w : b.box.x + b.box.w };
    return { a, b, kind: "self" };
  }
  return { a, b, kind: "normal" };
}

const okSide = (s: LinkSide | undefined, line: boolean): Side | undefined => (s && (!line || s === "left" || s === "right") ? s : undefined);

// 每条线上一次的摆法（换边缓冲要知道现在是哪种）。不是响应式的：只在这条线自己的 memo 里读写
const modes = new Map<string, Mode>();

/** 两端走哪一侧：用户指定 > Compare 栏（左栏只走左侧、右栏只走右侧）> 自动（带缓冲） */
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
  [tilted(bs.a, anchorOn(bs.a.box, s[0], atMap[0] ? bs.a.hy : bs.a.y)), tilted(bs.b, anchorOn(bs.b.box, s[1], atMap[1] ? bs.b.hy : bs.b.y))];
/** 斜贴的卡：端点落在转过去的边上（state/tilt.ts，转动中每一帧都跟着） */
function tilted(e: End, a: Anchor): Anchor {
  const deg = e.pill ? 0 : tiltOf(e.host);
  return deg ? turnAnchor(a, e.outer, (deg * Math.PI) / 180) : a;
}

export type Geo = {
  d: string; mx: number; my: number; head?: string | CarPose; tail?: string | CarPose; port?: { x: number; y: number }; port2?: { x: number; y: number }; pts: number[];
  /** 手绘线（从 Mark 出发）：第二笔；head / tail 是手绘的箭头 path */
  d2?: string;
};

/** 从 Mark 出发的箭头画成手绘线：返回 Mark 的颜色，别的箭头 undefined */
export function handOf(L: Pick<Link, "from">) {
  const c = cardById(L.from.card)?.card;
  return c?.kind === "note" && c.look === "mark" ? c.hand : undefined;
}

const headScale = (L: Link) => (L.style?.width === 1 ? 0.85 : L.style?.width === 3 ? 1.25 : 1);
/** 合并点离终点多远 */
const STUB = 28;

/** 箭头的 d；City（head = "car"）是那辆车的位置（Car 把它烤进 path） */
const headOrCar = (k: Shape0["head"], tx: number, ty: number, ux: number, uy: number, s: number) =>
  k === "car" ? carAt(tx, ty, ux, uy, s) : headPath(k, tx, ty, ux, uy, s);
type Shape0 = ReturnType<typeof shape>;
/** 箭头（或 City 的车）：同一份几何画成 path，或车的三条 path（见 Traffic.tsx） */
function Head(p: { cls: string; d: string | CarPose; road?: Road; hand?: boolean }) {
  return <>{shape().head === "car" && !p.hand ? <Car cls={p.cls} at={p.d as CarPose} road={p.road} /> : <path class={p.cls} d={p.d as string} />}</>;
}

function geoFrom(L: Link, bs: Base, p: Anchor, q: Anchor, merged: boolean): Geo {
  const hd = headOf(L), hk = shape().head, s = headScale(L);
  // 手绘线：照曲线走（制图、City 的直角折线也一样），画的时候再抖；线头不画圆点（Mark 没有框）
  if (handOf(L) && bs.kind !== "gutter") {
    const sh = bs.kind === "self" ? selfArc(p, q, "curve") : connect(p, q, "curve", undefined, { a: bs.a.pill ? undefined : bs.a.outer, b: bs.b.pill ? undefined : bs.b.outer });
    const h = handLine(L.id, sh.pts, hd.end, hd.start, s);
    return { d: h.d, d2: h.d2, head: h.head, tail: h.tail, mx: sh.mx, my: sh.my, pts: sh.pts };
  }
  const route = shape().route;
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
  }
  return {
    d: sh.d, mx: sh.mx, my: sh.my, pts: sh.pts,
    head: hd.end && !merged ? headOrCar(hk, sh.pts[6], sh.pts[7], sh.inDir.x, sh.inDir.y, s) : undefined,
    tail: hd.start ? headOrCar(hk, sh.pts[0], sh.pts[1], sh.outDir.x, sh.outDir.y, s) : undefined,
    port: { x: p.x, y: p.y },
  };
}

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

// 换边时端点滑过去：只有正在换边的那几条线每帧重算，别的线不动。
// 和卡的弹出、收进 Section 在同一个 animate 的同一批里：一端在动的线又在换边时，一帧只重算一遍（单独一个 rAF 时要两遍）
const sliding = new Map<string, (t: number) => void>();
let slideOn = false;
function tickSlides() {
  const now = frameTime();
  for (const f of [...sliding.values()]) f(now);
  slideOn = sliding.size > 0;
  return !slideOn;
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
    if (!slideOn) { slideOn = true; animate(tickSlides); }
  }, { defer: true }));
  onCleanup(() => { sliding.delete(L.id); modes.delete(L.id); });
  createComputed(() => {
    const s = sides();
    if (!s) return;
    const [a, b] = s.split("|");
    const ks = [...(!subEnd(L.from) ? [`${L.from.card}|${a}`] : []), ...(!subEnd(L.to) ? [`${L.to.card}|${b}`] : [])];
    untrack(() => land(ks, 1));
    onCleanup(() => untrack(() => land(ks, -1)));
  });
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
    if (!bs || !s || bs.kind !== "normal" || handOf(L)) return ""; // 手绘线各画各的
    return `${s.split("|")[1]}|${headOf(L).end ? 1 : 0}`;
  });
  return { L, base, sides, ends, sig };
}

const toKey = (L: Link) => `${L.to.card}|${L.to.seg ?? ""}|${L.to.line ?? (L.to.block ? `b${L.to.block.i}` : "")}`;

// 线的三次贝塞尔控制点（贴纸、标签沿线走时用）：登记给 state/geo 的 linkCurve
setCurveSource((id) => {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || !visible(L)) return null;
  return geoOf(L)?.pts ?? null;
});
/** 一条线的几何：画着的就用画着的那份（含合并、滑动）；没画的现算一份（不合并） */
export function geoOf(L: Link): Geo | null {
  const r = routes.get(L.id);
  if (r?.L === L && r.geo) return r.geo();
  const bs = baseOf(L);
  if (!bs) return null;
  const [p, q] = anchorsFor(bs, sidesFor(L, bs, false), [mapHides(L.from), mapHides(L.to)]);
  return geoFrom(L, bs, p, q, false);
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
  if (!L || !subEnd(L.from)) return;
  const a = endRect(L.from.card)?.r;
  if (!a) return;
  const end = beginGesture();
  setDragLink(id);
  holdPointer(e);
  const move = (ev: PointerEvent) => {
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const side = w.x >= a.x + a.w / 2 ? "right" : "left";
    live((b) => { const k = b.links.find((l) => l.id === id); if (k && k.sides?.from !== side) k.sides = { ...k.sides, from: side }; });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setDragLink(null); end(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * 卡端（不连行）落在哪张卡的哪一边：「卡 id|边」。那一边的圆点（.eport）就不画了，线头已经标出那个位置（圆点盖在箭头上很难看），
 * 鼠标移上去照样能拖。每条画着的线自己记下它落在哪（makeRoute），只在它换边、改端点时增减，每个「卡|边」一个信号：
 * 卡在动（弹出、收进 Section）时几乎每帧都有线换边，不能每次都把所有线扫一遍
 */
const landN = new Map<string, number>();
const landSig = new Map<string, Signal<boolean>>();
const landOf = (k: string) => { let q = landSig.get(k); if (!q) landSig.set(k, (q = createSignal(false))); return q; };
function land(ks: string[], d: 1 | -1) {
  for (const k of ks) { const n = (landN.get(k) ?? 0) + d; if (n) landN.set(k, n); else landN.delete(k); landOf(k)[1](n > 0); }
}
export const landed = (k: string) => landOf(k)[0]();

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
  watchHover();
  watchBlockHover();
  // City 的车流：挑哪几条路只在镜头停下时算一次（Traffic.tsx）
  trackTraffic(views);
}

// 线浮上来、落回去时不硬切：原来那层留一份影子，浮上来的那份从透明淡入（影子在卡下面垫着，没被卡盖住的那段一直在）；
// 落回去时影子留在上面一层淡出。影子只是拷贝的几条 path，去掉 data-lk / data-link，不接事件，动画完就删
const fading = new Map<object, () => void>();
function crossfade(key: object, els: Element[], up: boolean) {
  fading.get(key)?.();
  const ms = tune("liftFade") * (100 / tune("animSpeed"));
  if (ms <= 0 || reduceMotion()) return;
  els = els.filter((el) => el.firstElementChild);
  const ghosts = els.map((el) => {
    const c = el.cloneNode(true) as Element;
    for (const x of [c, ...c.querySelectorAll("[data-lk],[data-link],[id]")]) { x.removeAttribute("data-lk"); x.removeAttribute("data-link"); x.removeAttribute("id"); }
    c.classList.add("ghost"); c.setAttribute("data-export", "strip");
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
 * 悬停 Note 的一块：卡左右边上、那一块中线高度的两个圆点（哪一块由 state/blocks.ts 定），拖出去就是从这一块连箭头。
 * 在所有卡和线上面（.bports，比浮上来的线那层还高）：盖在连着这一块的线头上。斜贴的卡跟着边转过去，和线的端点一样
 */
export function BlockPorts() {
  const at = createMemo(() => {
    const h = hoverBlock();
    if (!h || rubber() || !cardById(h.card)) return null;
    const r = rectOf(h.card), rad = (tiltOf(h.card) * Math.PI) / 180, y = r.y + h.y;
    const pt = (side: Side) => { const a = anchorOn(r, side, y); return rad ? turnAnchor(a, r, rad) : a; };
    return { h, left: pt("left"), right: pt("right") };
  });
  return (
    <div class="bports" data-export="strip">
      <Show when={at()}>{(a) => (["left", "right"] as const).map((side) => (
        <span class={`bport ${side === "left" ? "l" : "r"}`} data-nodrag data-tip="Drag to link this block" style={{ left: `${a()[side].x}px`, top: `${a()[side].y}px`, ...portStyle(a().h.card) }}
          onPointerEnter={keepBlock} onPointerLeave={leaveBlock}
          onPointerDown={(e) => { const b = e.currentTarget.getBoundingClientRect(), h = a().h; linkPortDown(e, { card: h.card, block: h.ref }, b.left + b.width / 2, b.top + b.height / 2, side); }} />
      ))}</Show>
    </div>
  );
}

/**
 * 点击区的粗细（屏幕上 12px）：单独一个 effect。写在 JSX 的 style 里会和这条线的其它属性编进同一个 effect，
 * 镜头每次停下（stillZ 变）196 条线都要把 class、合并、路径整个重算一遍
 */
const hitWidth = (el: SVGPathElement) => createRenderEffect(() => el.style.setProperty("stroke-width", `${12 / stillZ()}px`));

const colorCls = (L: Link) => (L.style?.color ? ` lc-${L.style.color}` : "");
const widthCls = (L: Link) => (L.style?.width === 1 ? " w1" : L.style?.width === 3 ? " w3" : "");
const isOn = (id: string) => sel.links.includes(id) || hoverLink() === id || isBindHot(`link:${id}`);

/** 一条线的节点：线本身、City 的路沿和白边线、标签框和贴纸。外面各包一层不变的节点，换层时整块搬 */
function linkDom(r: Route, g: Accessor<Geo | null>, merged: Accessor<boolean>, city: () => boolean): Dom {
  const L = r.L;
  const on = () => isOn(L.id);
  // class 都做成 memo：一端的卡在动时线每帧都要重画，路径变了 class 没变，不用每帧重新拼一遍
  const toHue = createMemo(() => { const t = cardById(L.to.card)?.card; return t?.kind === "code" ? fileHue(t.segments[0]?.path) : 0; });
  // 证据（manual 虚线、observed 绿）、Generated from（点线）：同一层，只换样式
  // RPC（跨进程）：点划线；↩ back to：淡一点
  const hand = createMemo(() => handOf(L));
  const style = createMemo(() => `${hand() ? ` hand hc-${hand()}` : colorCls(L)}${widthCls(L)}${L.call?.ev ? ` ev-${L.call.ev.kind}` : ""}${L.gen ? " gen" : ""}${L.rpc ? " rpc" : ""}${L.back ? " back" : ""}`);
  const gutter = createMemo(() => r.base()?.kind === "gutter");
  const road: Road = L.call ? "main" : "street";
  const cls = createMemo(() => `edge${L.call ? "" : " plain"}${L.style?.dash ? " dashed" : ""}${style()}${L.lost ? " lost" : ""}${gutter() ? " cmpline" : ""}${on() ? " on" : ""}`);
  const headCls = createMemo(() => `ahead end ${hand() ? "chevron" : shape().head}${style()}${L.lost?.to ? " lost" : ""}${on() ? " on" : ""}`);
  const tailCls = createMemo(() => `ahead start ${hand() ? "chevron" : shape().head}${style()}${L.lost?.from ? " lost" : ""}${on() ? " on" : ""}`);
  const portCls = createMemo(() => `port fc-${toHue()}${L.lost?.from ? " lost" : ""}`);
  const line = (
    <g>
      <Show when={g()}>
        <g class="link" data-lk={L.id} data-from={L.from.card} data-to={L.to.card} data-call={L.call ? "" : undefined} data-merged={merged() ? "" : undefined} data-sides={r.sides()}>
          <path class={cls()} d={g()!.d} />
          <Show when={g()!.d2}><path class={`${cls()} p2`} d={g()!.d2} /></Show>
          <Show when={city() && !gutter() && !hand()}><Lane d={g()!.d} road={road} s={headScale(L)} start={!!g()!.tail} end={!!g()!.head} /></Show>
          <Show when={g()!.head}><Head cls={headCls()} d={g()!.head!} road={road} hand={!!hand()} /></Show>
          <Show when={g()!.tail}><Head cls={tailCls()} d={g()!.tail!} road={road} hand={!!hand()} /></Show>
          <path class="lhit" data-link={L.id} d={g()!.d} ref={hitWidth}
            onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
            onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (isDbl(`l${L.id}`, e)) return A.setLinkEditing(L.id); select({ links: [L.id] }, e.shiftKey); }} />
        </g>
      </Show>
    </g>
  ) as SVGGElement;
  // 线头的圆点：单独一组，放在卡上面那一层（见「图层」）
  const port = (
    <g data-lk={L.id}>
      <Show when={g()}>
        <Show when={g()!.port}><path class={portCls()} data-x={g()!.port!.x} d={portPath(g()!.port!.x, g()!.port!.y)} />
          <Show when={on() && subEnd(L.from) && r.base()?.kind === "normal"}><circle class="porthit" data-export="strip" onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} data-tip="Drag to the other end of the line" r={7 / stillZ()} cx={g()!.port!.x} cy={g()!.port!.y} onPointerDown={(e) => portDrag(e, L.id)} /></Show></Show>
        <Show when={g()!.port2}><path class={`port fc-${toHue()}`} d={portPath(g()!.port2!.x, g()!.port2!.y)} /></Show>
      </Show>
    </g>
  ) as SVGGElement;
  const casing = <g><Show when={city() && !gutter() && !hand() && g()}>{(gg) => <path class={`casing${L.call ? "" : " plain"}${widthCls(L)}`} d={gg().d} />}</Show></g> as SVGGElement;
  const kerb = <g><Show when={city() && L.call && !gutter() && !hand() && g()}>{(gg) => <path class={`kerb${widthCls(L)}`} d={gg().d} />}</Show></g> as SVGGElement;
  const label = <div class="lw"><LinkLabel L={L} g={g} /><LinkStickers link={L.id} /></div> as HTMLDivElement;
  huskEls([line, casing, kerb, port, label], createMemo(() => linkHusk(L)));
  return { line, casing, kerb, port, label };
}

/**
 * 几条线汇到同一处：合并点到终点的一小段 + 一个箭头。
 * 结构固定，方便材质另画（City 的路口等）：<g class="merge" data-card data-line data-side data-n> 里一条 .edge.stub 和一个 .ahead.end
 * 返回一个合并组：成员和合并段（Merge 和 City 的路沿、白边线共用）
 */
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
  const line = <g><Merge key={key} st={st} /></g> as SVGGElement;
  huskEls([line, casing, kerb], createMemo(() => {
    const hs = st.members().map(linkHusk);
    return hs.length && hs.every((h) => h === "out") ? "out" : hs.length && hs.every(Boolean) ? "in" : undefined;
  }));
  return { line, casing, kerb };
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
