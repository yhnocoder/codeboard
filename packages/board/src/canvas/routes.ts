// How each arrow is routed, one memo chain per arrow (see the top of Links.tsx), and the geometry it ends up with: what Links.tsx
// draws, and what stickers and labels that ride along an arrow read (linkCurve)
import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
  type Signal,
} from "solid-js";
import { headOf, type Link, type LinkSide, type Rect } from "@codeboard/core";
import { state, rectOf, cardById, hostOf, placeOf } from "../state/store";
import { geo, lineY, HEAD_H } from "../state/geo";
import { blockY } from "../state/blocks";
import { frames, collapsedHome, linkVisible } from "../state/sections";
import { popIn } from "../state/ui";
import { foldAt, foldHome, frameAt, lerp, type Fold } from "../state/fold";
import { animate, frameTime } from "../state/camera";
import { reduceMotion } from "../state/motion";
import { shape } from "../state/look";
import { tune } from "../state/tune";
import {
  chooseMode,
  sidesOf,
  anchorOn,
  turnAnchor,
  slide,
  connect,
  selfArc,
  gutterLine,
  headPath,
  type Anchor,
  type Box,
  type Mode,
  type Side,
  type Shape,
} from "@codeboard/core/canvas";
import { carAt, type CarPose } from "./city";
import { tiltOf } from "../state/tilt";

export type Dom = {
  line: SVGGElement;
  casing: SVGGElement;
  kerb: SVGGElement;
  port?: SVGGElement;
  label?: HTMLElement;
};

/**
 * 卡端（不连行）落在哪张卡的哪一边：「卡 id|边」。那一边的圆点（.eport）就不画了，线头已经标出那个位置（圆点盖在箭头上很难看），
 * 鼠标移上去照样能拖。每条画着的线自己记下它落在哪（makeRoute），只在它换边、改端点时增减，每个「卡|边」一个信号：
 * 卡在动（弹出、收进 Section）时几乎每帧都有线换边，不能每次都把所有线扫一遍
 */
const landN = new Map<string, number>();
const landSig = new Map<string, Signal<boolean>>();
const landOf = (k: string) => {
  let q = landSig.get(k);
  if (!q) landSig.set(k, (q = createSignal(false)));
  return q;
};
function land(ks: string[], d: 1 | -1) {
  for (const k of ks) {
    const n = (landN.get(k) ?? 0) + d;
    if (n) landN.set(k, n);
    else landN.delete(k);
    landOf(k)[1](n > 0);
  }
}
export const landed = (k: string) => landOf(k)[0]();

const popOf = (host: string) => popIn()[host];
/** 两端都在同一个正在折叠、展开的 Section 里的线：那个 Section（这条线不重新走线，整条跟着卡缩放，Links 的 foldLink） */
export function innerFold(L: Link): string | undefined {
  const a = foldHome(hostOf(L.from.card));
  return a && a === foldHome(hostOf(L.to.card)) ? a : undefined;
}
/** 折叠、展开中，外面连进来的线在成员卡这一端落在哪：先从卡边滑到 Section 框的边上（v 从 0.95 到 0.7，开始折叠后很快），贴着框跟框一起收；
 *  端点的高度平滑地滑到标题那一行（smoothstep）。v = 0 时就是折叠后的框（落在标题那一行），和折叠后连在 Section 上的线一样。
 *  两头都是平的（v 在 0.95 以上就在卡边上）：弹簧停下时差的那一点点不会被放大成终点的一跳 */
const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function foldBox(f: Fold, r: Rect): Rect {
  const F = frameAt(f),
    k = smooth(0.7, 0.95, f.v);
  const x = lerp(F.x, r.x, k),
    y = lerp(F.y, r.y, k);
  return { x, y, w: lerp(F.x + F.w, r.x + r.w, k) - x, h: lerp(F.y + F.h, r.y + r.h, k) - y };
}
const foldY = (f: Fold, y: number) => lerp(f.shut.y + f.shut.h / 2, y, smooth(0, 1, f.v));

/** 在折叠的 Section 里时是那个标题条。still：正在弹出的卡按它落定的地方算（不加弹出的位移） */
export function endRect(id: string, still = false): { r: Rect; pill: boolean } | null {
  const f = cardById(id);
  if (!f) return null;
  const home = collapsedHome(placeOf(f.host.id).section);
  if (home) {
    const r = frames().get(home.id);
    return r ? { r, pill: true } : null;
  }
  const r = rectOf(f.host);
  const pi = still ? undefined : popOf(f.host.id);
  const base = pi ? { ...r, x: r.x + (1 - pi.v) * pi.ox, y: r.y + (1 - pi.v) * pi.oy } : r;
  const g = geo[id];
  if (f.host.id !== id && g?.colX !== undefined)
    return { r: { x: base.x + g.colX, y: base.y, w: g.colW ?? base.w / 2, h: base.h }, pill: false };
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
  box: Box /** 整张卡（Compare 栏 → 整张 Compare）：绕路时要避开的 */;
  outer: Box;
  line: boolean;
  y: number;
  col?: "left" | "right";
  host: string;
  card: string;
  pill: boolean;
};
/** rest：一端的卡正在弹出（popCard / popAlong，不是 slideFrom 的滑动）时，两端都落定后的样子。摆法（哪一侧）和要不要绕开卡
 *  按它定，弹出的这几帧里线只跟着端点平滑地动，不会因为半路上的卡挡着、叠着而换一种走法（Ink Wash 展开调用时一帧跳 50px） */
type Base = { a: End; b: End; kind: "normal" | "self" | "gutter"; gx?: number; rest?: Base };

/** 连着一行 / Note 的一块（不是整张卡）：只从左右两边进出 */
export const subEnd = (e: Link["from"]) => e.line !== undefined || !!e.block;

/** 这一端的卡正在弹出（不是滑过去） */
const popping = (e: Link["from"]) => {
  const f = cardById(e.card),
    pi = f && popOf(f.host.id);
  return !!pi && !pi.slide;
};
/** moving：这一端的卡在正在折叠、展开的 Section 里时跟着动（外面连进来的线；两端都在里面的线整条缩放，不动端点）。
 *  still：正在弹出的卡按落定的地方算（Base.rest） */
function endOf(e: Link["from"], moving = true, still = false): End | null {
  const er = endRect(e.card, still);
  if (!er) return null;
  const f = cardById(e.card)!;
  const r = er.r;
  const line = subEnd(e);
  let y = er.pill ? r.y + r.h / 2 : headY(e.card, r);
  // 块端：那一块的中线（state/blocks.ts 量的）；块没了、量不到时落到卡头，和行端一样
  if (e.block && !er.pill) {
    const by = blockY(e.card, e.block);
    if (by !== null) y = r.y + by;
  }
  // 行端：那一行的 y；行被折叠 / 藏起来时落到卡头，线的样子不变
  else if (line && !er.pill) {
    const p = lineY(e.card, e.seg, e.line);
    const row = p?.row !== undefined ? geo[e.card]?.rows[p.row] : undefined;
    if (p && row?.t === "line" && row.line === e.line) {
      const pi = still ? undefined : popOf(f.host.id);
      y = p.y + (pi ? (1 - pi.v) * pi.oy : 0);
    }
  }
  let col: End["col"];
  const g = geo[e.card];
  if (!er.pill && f.host.id !== e.card && g?.colX !== undefined && (g.colW ?? 0) < rectOf(f.host).w - 1)
    col = g.colX > 1 ? "right" : "left";
  let outer = r;
  if (col) {
    const h = rectOf(f.host),
      pi = still ? undefined : popOf(f.host.id);
    outer = pi ? { ...h, x: h.x + (1 - pi.v) * pi.ox, y: h.y + (1 - pi.v) * pi.oy } : h;
  }
  const fo = moving ? foldAt(f.host.id) : undefined;
  if (fo) {
    const b = foldBox(fo, r);
    return {
      box: b,
      outer: col ? foldBox(fo, outer) : b,
      line,
      y: foldY(fo, y),
      col,
      host: f.host.id,
      card: e.card,
      pill: er.pill,
    };
  }
  return { box: r, outer, line, y, col, host: f.host.id, card: e.card, pill: er.pill };
}

function baseOf(L: Link): Base | null {
  const still = !innerFold(L);
  const a = endOf(L.from, still),
    b = endOf(L.to, still);
  const pa = popping(L.from),
    pb = popping(L.to);
  return baseFrom(a, b, pa || pb ? [pa ? endOf(L.from, still, true) : a, pb ? endOf(L.to, still, true) : b] : null);
}
function baseFrom(a: End | null, b: End | null, rest: [End | null, End | null] | null = null): Base | null {
  const bs = baseOf2(a, b);
  if (!bs || !rest) return bs;
  const r = baseOf2(rest[0], rest[1]);
  return r && r.kind === bs.kind ? { ...bs, rest: r } : bs;
}
function baseOf2(a: End | null, b: End | null): Base | null {
  if (!a || !b) return null;
  if (a.host === b.host && !a.pill) {
    // 同一张 Compare 的两栏之间、行对行：中缝的对照线
    if (a.card !== b.card && a.col && b.col && a.col !== b.col && a.line && b.line)
      return { a, b, kind: "gutter", gx: a.col === "left" ? a.box.x + a.box.w : b.box.x + b.box.w };
    return { a, b, kind: "self" };
  }
  return { a, b, kind: "normal" };
}

const okSide = (s: LinkSide | undefined, line: boolean): Side | undefined =>
  s && (!line || s === "left" || s === "right") ? s : undefined;

// 每条线上一次的摆法（换边缓冲要知道现在是哪种）。不是响应式的：只在这条线自己的 memo 里读写
const modes = new Map<string, Mode>();

/** 两端走哪一侧：用户指定 > Compare 栏（左栏只走左侧、右栏只走右侧）> 自动（带缓冲） */
function sidesFor(L: Link, bs: Base, remember: boolean): [Side, Side] {
  const { a, b } = bs;
  const uf = okSide(L.sides?.from, a.line),
    ut = okSide(L.sides?.to, b.line);
  if (bs.kind !== "normal") {
    const s: Side = uf ?? a.col ?? "right";
    return [s, ut ?? (bs.kind === "self" ? s : (b.col ?? "left"))];
  }
  let auto: [Side, Side] = ["right", "left"];
  if (!((uf ?? a.col) && (ut ?? b.col))) {
    const r = bs.rest ?? bs;
    const m = chooseMode(r.a.box, r.b.box, !a.line && !b.line, modes.get(L.id), tune("sideBuffer"));
    if (remember) modes.set(L.id, m);
    auto = sidesOf(m);
  }
  return [uf ?? a.col ?? auto[0], ut ?? b.col ?? auto[1]];
}
const anchorsFor = (bs: Base, s: [Side, Side]): [Anchor, Anchor] => [
  tilted(bs.a, anchorOn(bs.a.box, s[0], bs.a.y)),
  tilted(bs.b, anchorOn(bs.b.box, s[1], bs.b.y)),
];
/** 斜贴的卡：端点落在转过去的边上（state/tilt.ts，转动中每一帧都跟着） */
function tilted(e: End, a: Anchor): Anchor {
  const deg = e.pill ? 0 : tiltOf(e.host);
  return deg ? turnAnchor(a, e.outer, (deg * Math.PI) / 180) : a;
}

export type Geo = {
  d: string;
  mx: number;
  my: number;
  head?: string | CarPose;
  tail?: string | CarPose;
  port?: { x: number; y: number };
  port2?: { x: number; y: number };
  pts: number[];
};

/** 实线：材质可以把它画成一块填充的形状（look.ts 的 stroke：毛笔、收细的线）。虚线、点线（Generated）、点划线（RPC）、
 *  手动补的 Call 箭头照旧描边 */
export const solidLine = (L: Link) => !(L.style?.dash || L.gen || L.rpc || L.call?.ev?.kind === "manual");

export const headScale = (L: Link) => (L.style?.width === 1 ? 0.85 : L.style?.width === 3 ? 1.25 : 1);
/** 合并点离终点多远 */
export const STUB = 28;

/** 箭头的 d；City（head = "car"）是那辆车的位置（Car 把它烤进 path） */
export const headOrCar = (k: Shape0["head"], tx: number, ty: number, ux: number, uy: number, s: number) =>
  k === "car" ? carAt(tx, ty, ux, uy, s) : headPath(k, tx, ty, ux, uy, s);
type Shape0 = ReturnType<typeof shape>;

/** rest：两端落定后的端点（Base.rest 在时，makeRoute 的 rest） */
export function geoFrom(L: Link, bs: Base, p: Anchor, q: Anchor, merged: boolean, rest?: [Anchor, Anchor] | null): Geo {
  const hd = headOf(L),
    hk = shape().head,
    s = headScale(L);
  const route = shape().route;
  let sh: Shape;
  if (bs.kind === "gutter") {
    sh = gutterLine(bs.gx!, p.y, q.y, bs.a.col === "left");
    return {
      d: sh.d,
      mx: sh.mx,
      my: sh.my,
      pts: sh.pts,
      port: { x: sh.pts[0], y: sh.pts[1] },
      port2: { x: sh.pts[6], y: sh.pts[7] },
    };
  }
  const clear = shape().clear;
  if (bs.kind === "self") sh = selfArc(p, q, route, clear);
  else {
    const boxesOf = (b: Base) => ({ a: b.a.pill ? undefined : b.a.outer, b: b.b.pill ? undefined : b.b.outer });
    const stub = (q: Anchor) => (merged ? { ...q, x: q.x + q.nx * STUB, y: q.y + q.ny * STUB } : q);
    const tilt = merged ? { start: true, end: false } : undefined;
    let boxes: { a?: Box; b?: Box } = boxesOf(bs);
    // 一端正在弹出：落定后不用绕开卡的线，弹出时也不绕（半路上的卡挡着、叠着时绕一下，等于一帧换一种走法）；只跟着端点动，
    // 落定的那一帧正好就是落定后的线
    if (bs.rest && rest) {
      const [p0, q0] = [rest[0], stub(rest[1])];
      if (connect(p0, q0, route, tilt, boxesOf(bs.rest), clear).d === connect(p0, q0, route, tilt, {}, clear).d)
        boxes = {};
    }
    sh = connect(p, stub(q), route, tilt, boxes, clear);
  }
  return {
    d: sh.d,
    mx: sh.mx,
    my: sh.my,
    pts: sh.pts,
    head: hd.end && !merged ? headOrCar(hk, sh.pts[6], sh.pts[7], sh.inDir.x, sh.inDir.y, s) : undefined,
    tail: hd.start ? headOrCar(hk, sh.pts[0], sh.pts[1], sh.outDir.x, sh.outDir.y, s) : undefined,
    port: { x: p.x, y: p.y },
  };
}

export type Route = {
  L: Link;
  base: Accessor<Base | null>;
  sides: Accessor<string>; // "right|left"；拿不到端点时 ""
  ends: Accessor<[Anchor, Anchor] | null>;
  /** 一端的卡正在弹出时，两端落定后的端点（Base.rest）；别的时候 null */
  rest: Accessor<[Anchor, Anchor] | null>;
  /** 汇合用的签名：同一个终点、同一侧、有没有箭头都一样的才合并；自连 / 对照线 = "" */
  sig: Accessor<string>;
  /** 画出来的几何（含合并、滑动）；trackLinks 给要画的线填上 */
  geo?: Accessor<Geo | null>;
  /** 画在哪张卡的那一层（两端里叠放次序高的那张，见下面的「图层」） */
  owner?: Accessor<string>;
  /** 这条线的节点：只建一次，换层时整块搬过去 */
  dom?: Dom;
};
// The links drawn now (trackLinks), so that a link's curve (linkCurve) is the drawn one, merged or sliding
const drawn = new Map<string, Route>();
/** trackLinks: this link is drawn with r until the returned function is called */
export function drawRoute(r: Route): () => void {
  drawn.set(r.L.id, r);
  return () => {
    if (drawn.get(r.L.id) === r) drawn.delete(r.L.id);
  };
}

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

export function makeRoute(L: Link): Route {
  // 两端各一个 memo：一端的卡在动（收进 Section）时，另一端不用每帧重算
  const still = createMemo(() => !innerFold(L));
  const ea = createMemo(() => endOf(L.from, still())),
    eb = createMemo(() => endOf(L.to, still()));
  // 弹出中的那一端落定后的样子：只在弹出时算（弹出的每一帧这份不变）
  const pa = createMemo(() => popping(L.from)),
    pb = createMemo(() => popping(L.to));
  const ra = createMemo(() => (pa() ? endOf(L.from, still(), true) : null)),
    rb = createMemo(() => (pb() ? endOf(L.to, still(), true) : null));
  const base = createMemo(() => baseFrom(ea(), eb(), pa() || pb() ? [pa() ? ra() : ea(), pb() ? rb() : eb()] : null));
  const sides = createMemo(() => {
    const bs = base();
    return bs ? sidesFor(L, bs, true).join("|") : "";
  });
  // 滑动中：从哪一侧滑过来、进度 0..1（已缓动）
  const [sl, setSl] = createSignal<{ from: [Side, Side]; p: number } | null>(null);
  createEffect(
    on(
      sides,
      (now, before) => {
        if (!before || !now || now === before || reduceMotion()) return;
        const dur = tune("sideSlide") * (100 / tune("animSpeed"));
        if (dur <= 0) return;
        const from = before.split("|") as [Side, Side];
        let t0 = -1;
        setSl({ from, p: 0 });
        sliding.set(L.id, (t) => {
          if (t0 < 0) t0 = t;
          const p = Math.min(1, (t - t0) / dur);
          if (p >= 1) {
            sliding.delete(L.id);
            setSl(null);
          } else setSl({ from, p: 1 - (1 - p) ** 3 });
        });
        if (!slideOn) {
          slideOn = true;
          animate(tickSlides);
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    sliding.delete(L.id);
    modes.delete(L.id);
  });
  createComputed(() => {
    const s = sides();
    if (!s) return;
    const [a, b] = s.split("|");
    const ks = [...(!subEnd(L.from) ? [`${L.from.card}|${a}`] : []), ...(!subEnd(L.to) ? [`${L.to.card}|${b}`] : [])];
    untrack(() => land(ks, 1));
    onCleanup(() => untrack(() => land(ks, -1)));
  });
  const ends = createMemo<[Anchor, Anchor] | null>(() => {
    const bs = base(),
      s = sides();
    if (!bs || !s) return null;
    const now = anchorsFor(bs, s.split("|") as [Side, Side]);
    const m = sl();
    if (!m) return now;
    const was = anchorsFor(bs, m.from);
    return [slide(was[0], now[0], m.p), slide(was[1], now[1], m.p)];
  });
  const rest = createMemo<[Anchor, Anchor] | null>(() => {
    const bs = base(),
      s = sides();
    return bs?.rest && s ? anchorsFor(bs.rest, s.split("|") as [Side, Side]) : null;
  });
  const sig = createMemo(() => {
    const bs = base(),
      s = sides();
    if (!bs || !s || bs.kind !== "normal") return "";
    return `${s.split("|")[1]}|${headOf(L).end ? 1 : 0}`;
  });
  return { L, base, sides, ends, rest, sig };
}

export const toKey = (L: Link) =>
  `${L.to.card}|${L.to.seg ?? ""}|${L.to.line ?? (L.to.block ? `b${L.to.block.i}` : "")}`;

/** 一条线的几何：画着的就用画着的那份（含合并、滑动）；没画的现算一份（不合并） */
function geoOf(L: Link): Geo | null {
  const r = drawn.get(L.id);
  if (r?.L === L && r.geo) return r.geo();
  const bs = baseOf(L);
  if (!bs) return null;
  const s = sidesFor(L, bs, false);
  const [p, q] = anchorsFor(bs, s);
  return geoFrom(L, bs, p, q, false, bs.rest ? anchorsFor(bs.rest, s) : null);
}

/** 线的三次贝塞尔控制点 [x1 y1 c1x c1y c2x c2y x2 y2]（贴纸、标签沿线走时用）；线没画出来时是 null */
export function linkCurve(id: string): number[] | null {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || !linkVisible(L)) return null;
  return geoOf(L)?.pts ?? null;
}
