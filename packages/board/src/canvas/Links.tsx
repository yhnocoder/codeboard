// Link 层：SVG 箭头。走线规则见 route.ts（W03）；这里把卡、行、Compare 栏的位置读出来，按条建 memo，只在它两端的卡变了时重算。
// 每条线：base（两端的矩形和行的 y）→ sides（走哪一侧，带缓冲）→ ends（端点，换边时滑过去）→ geo（路径、箭头）。
// 汇到同一处（同一张卡的卡头 / 同一行、同一侧）的几条线：各自画到合并点，合并点到终点的那一小段和箭头只画一次（<g class="merge">）。
import { For, Index, Show, batch, createEffect, createMemo, createRenderEffect, createSignal, mapArray, on, onCleanup, untrack, type Accessor, type Setter } from "solid-js";
import { headOf, type Link, type LinkSide, type Rect } from "@codeboard/core";
import { state, sel, select, rectOf, cardById, collapsedAway, placeOf, live, beginGesture } from "../state/store";
import { geo, lineY } from "../state/geo";
import { frames, collapsedHome } from "../state/sections";
import { hoverLink, setHoverLink, rubber, popIn } from "../state/ui";
import { cam, toWorld, stillZ, lod, reduceMotion, camMoving, worldView } from "../state/camera";
import { lodOf } from "../state/lodcards";
import { boardOffset } from "../actions/common";
import { shape, fileHue, look, traffic } from "../state/look";
import { tune } from "../state/tune";
import { isDbl } from "../interact";
import * as A from "../actions";
import { chooseMode, sidesOf, anchorOn, slide, connect, selfArc, gutterLine, headPath, carAt, carPaths, driveFrames, type Anchor, type Box, type Mode, type Side, type Shape } from "./route";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// 离开连线后过 300ms 才算离开：鼠标从线移到 "+" 或变量框的路上不丢悬停（#30）
let leaveT: number | undefined;
export const enterLink = (id: string) => { clearTimeout(leaveT); setHoverLink(id); };
export const leaveLink = () => { clearTimeout(leaveT); leaveT = window.setTimeout(() => setHoverLink(null), tune("linkLeave")); };

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
type End = { box: Box; /** 整张卡（Compare 栏 → 整张 Compare）：绕路时要避开的 */ outer: Box; line: boolean; y: number; /** 卡头那一行的 y（行端的卡在地图档时用） */ hy: number; col?: "left" | "right"; host: string; card: string; pill: boolean };
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

type Geo = { d: string; mx: number; my: number; head?: string; tail?: string; port?: { x: number; y: number }; port2?: { x: number; y: number }; pts: number[] };

/** 粗细档 → 箭头放大多少 */
const headScale = (L: Link) => (L.style?.width === 1 ? 0.85 : L.style?.width === 3 ? 1.25 : 1);
/** 合并点离终点多远 */
const STUB = 28;

/** 箭头的 d；City（head = "car"）是那辆车的 transform（Car 把它烤进 path） */
const headOrCar = (k: Shape0["head"], tx: number, ty: number, ux: number, uy: number, s: number) =>
  k === "car" ? carAt(tx, ty, ux, uy, s) : headPath(k, tx, ty, ux, uy, s);
type Shape0 = ReturnType<typeof shape>;
/** 箭头（或 City 的车）：同一份几何画成 path，或车的三条 path */
function Car(p: { cls: string; at: string }) {
  const c = createMemo(() => carPaths(p.at));
  return <g class={p.cls} data-at={p.at}><path class="cbody" d={c().body} /><path class="croof" d={c().roof} /><path class="clamp" d={c().lamp} /></g>;
}
function Head(p: { cls: string; d: string }) {
  return <>{shape().head === "car" ? <Car cls={p.cls} at={p.d} /> : <path class={p.cls} d={p.d} />}</>;
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
  geo?: Accessor<Geo | null>;
  /** 同一份几何，响应式地给 City 的路沿层、车流用（LinksSvg 画这条线时填上） */
  shown: Accessor<Accessor<Geo | null> | undefined>;
  setShown: Setter<Accessor<Geo | null> | undefined>;
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
    if (!bs || !s || bs.kind !== "normal") return "";
    return `${s.split("|")[1]}|${headOf(L).end ? 1 : 0}`;
  });
  const [shown, setShown] = createSignal<Accessor<Geo | null>>();
  return { L, base, sides, ends, sig, shown, setShown };
}

/** 终点是同一处的几条线（同一张卡的卡头，或同一行）：终点的 key */
const toKey = (L: Link) => `${L.to.card}|${L.to.seg ?? ""}|${L.to.line ?? ""}`;

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
  const move = (ev: PointerEvent) => {
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const side = w.x >= a.x + a.w / 2 ? "right" : "left";
    live((b) => { const k = b.links.find((l) => l.id === id); if (k && k.sides?.from !== side) k.sides = { ...k.sides, from: side }; });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); end(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** 画着的线的走线状态（City 的车流要读） */
const [roads, setRoads] = createSignal<Accessor<Route[]>>(() => []);

/**
 * City 的车流（红绿灯是绿灯时）：镜头附近最多 MAX_ROADS 条调用路上各开两辆车。车是 HTML 小块，用 Web Animations 沿路走：
 * 关键帧只有 transform 和 opacity，整段交给合成器跑，主线程每帧什么都不做；只在路变了（拖卡片）时重建那条路上的两段动画。
 * 红灯、别的材质、系统开了「减少动态效果」时整层不存在（没有动画、没有计时器）。挑哪几条路只在镜头停下时算一次
 */
const MAX_ROADS = 16;
export function Traffic() {
  return <Show when={look() === "city" && traffic() && !reduceMotion()}><Movers /></Show>;
}
function Movers() {
  const pick = createMemo(on([camMoving, () => roads()()], ([moving], _, prev?: Route[]) => {
    if (moving && prev) return prev;
    return untrack(() => {
      const v = worldView(), m = 200;
      const out: Route[] = [];
      for (const r of roads()()) {
        if (!r.L.call || r.base()?.kind !== "normal") continue;
        const p = r.shown()?.()?.pts;
        if (!p) continue;
        const xs = [p[0], p[2], p[4], p[6]], ys = [p[1], p[3], p[5], p[7]];
        if (Math.max(...xs) < v.x - m || Math.min(...xs) > v.x + v.w + m || Math.max(...ys) < v.y - m || Math.min(...ys) > v.y + v.h + m) continue;
        out.push(r);
        if (out.length >= MAX_ROADS) break;
      }
      return out;
    });
  }));
  return (
    <div class="movers">
      <For each={pick()}>
        {(r, i) => {
          const d = () => r.shown()?.()?.d ?? "";
          return <Index each={[0, 1]}>{(k) => <Mover d={d} k={(i() + k()) % 3} phase={k() / 2 + i() * 0.17} />}</Index>;
        }}
      </For>
    </div>
  );
}
/** 一辆车：路（d）变了就换一段动画，接着原来开到的地方（按比例）往下开 */
function Mover(p: { d: () => string; k: number; phase: number }) {
  let el!: HTMLDivElement;
  let anims: Animation[] = [];
  const stop = () => { for (const a of anims) a.cancel(); anims = []; };
  createEffect(on(p.d, (d) => {
    const old = anims[0], was = old ? ((old.currentTime as number) ?? 0) / ((old.effect?.getTiming().duration as number) || 1) : p.phase;
    stop();
    const f = d ? driveFrames(d) : null;
    if (!f) return;
    // 车速大约 50px/s
    const ms = Math.max(3000, (f.len / 50) * 1000);
    const at = ((was % 1) + 1) % 1 * ms;
    const opt: KeyframeAnimationOptions = { duration: ms, iterations: Infinity, easing: "linear" };
    anims = [el.animate(f.frames, opt), el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.88 }, { opacity: 0 }], opt)];
    for (const a of anims) a.currentTime = at;
  }));
  onCleanup(stop);
  return <div ref={el} class={`mover k${p.k}`} />;
}

// 一条线的几何只算一次：LinksSvg 建的 memo，LinkLabels 直接拿来用（拿不到就自己算）
const shared = new WeakMap<Link, () => Geo | null>();
/** LinksSvg 建好的几何 memo（LinkLabels 复用） */
export const sharedGeo = (L: Link) => shared.get(L);

/**
 * 点击区的粗细（屏幕上 12px）：单独一个 effect。写在 JSX 的 style 里会和这条线的其它属性编进同一个 effect，
 * 镜头每次停下（stillZ 变）196 条线都要把 class、合并、路径整个重算一遍
 */
const hitWidth = (el: SVGPathElement) => createRenderEffect(() => el.style.setProperty("stroke-width", `${12 / stillZ()}px`));

const colorCls = (L: Link) => (L.style?.color ? ` lc-${L.style.color}` : "");
const widthCls = (L: Link) => (L.style?.width === 1 ? " w1" : L.style?.width === 3 ? " w3" : "");
const isOn = (id: string) => sel.links.includes(id) || hoverLink() === id || (A.bindHot() as { link?: string } | null)?.link === id;

export function LinksSvg() {
  const links = createMemo(() => state.board.links.filter(visible));
  // 每条线的走线状态先全建好（合并要读别的线走哪一侧），再画
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
  const mergeKeys = () => (merges() ? merges().split("\n") : []);
  setRoads(() => list);
  const city = () => look() === "city";
  return (
    <svg class="edges" classList={{ "lod-map": lod() === "map" }} width="1" height="1">
      {/* City：所有路的路沿画在最底下一层，几条路交叉、汇合时路面连成一片 */}
      <Show when={city()}>
        <g class="casings">
          <For each={list()}>
            {(r) => <Show when={r.base()?.kind !== "gutter" && r.shown()?.()}>{(g) => <path class={`casing${r.L.call ? "" : " plain"}${widthCls(r.L)}`} d={g().d} />}</Show>}
          </For>
          <For each={mergeKeys()}>{(key) => { const st = stubOf(key, groups, byId); return <Show when={st.g()}><path class={`casing${st.members().every((L) => !L.call) ? " plain" : ""}`} d={st.g()!.d} /></Show>; }}</For>
        </g>
      </Show>
      <For each={list()}>
        {(r) => {
          const L = r.L;
          const merged = createMemo(() => mergedWith(L, r.sig()));
          const g = createMemo(() => { const bs = r.base(), e = r.ends(); return bs && e ? geoFrom(L, bs, e[0], e[1], merged()) : null; });
          r.geo = g;
          r.setShown(() => g);
          shared.set(L, g);
          onCleanup(() => { if (shared.get(L) === g) shared.delete(L); if (r.geo === g) r.geo = undefined; if (r.shown() === g) r.setShown(undefined); });
          const on = () => isOn(L.id);
          const toHue = () => { const t = cardById(L.to.card)?.card; return t?.kind === "code" ? fileHue(t.segments[0]?.path) : 0; };
          const style = () => `${colorCls(L)}${widthCls(L)}`;
          const gutter = () => r.base()?.kind === "gutter";
          const cls = () => `edge${L.call ? "" : " plain"}${L.style?.dash ? " dashed" : ""}${style()}${L.lost ? " lost" : ""}${gutter() ? " cmpline" : ""}${on() ? " on" : ""}`;
          return (
            <Show when={g()}>
              <g class="link" data-lk={L.id} data-from={L.from.card} data-to={L.to.card} data-call={L.call ? "" : undefined} data-merged={merged() ? "" : undefined} data-sides={r.sides()}>
                <path class={cls()} d={g()!.d} />
                <Show when={city() && L.call && !gutter()}><path class="lane" d={g()!.d} /></Show>
                <Show when={g()!.head}><Head cls={`ahead end ${shape().head}${style()}${L.lost?.to ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.head!} /></Show>
                <Show when={g()!.tail}><Head cls={`ahead start ${shape().head}${style()}${L.lost?.from ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.tail!} /></Show>
                <Show when={g()!.port}><path class={`port fc-${toHue()}${L.lost?.from ? " lost" : ""}`} data-x={g()!.port!.x} d={portPath(g()!.port!.x, g()!.port!.y)} />
                  <Show when={on() && L.from.line !== undefined && r.base()?.kind === "normal"}><circle class="porthit" onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} data-tip="Drag to the other end of the line" r={7 / stillZ()} cx={g()!.port!.x} cy={g()!.port!.y} onPointerDown={(e) => portDrag(e, L.id)} /></Show></Show>
                <Show when={g()!.port2}><path class={`port fc-${toHue()}`} d={portPath(g()!.port2!.x, g()!.port2!.y)} /></Show>
                <path class="lhit" data-link={L.id} d={g()!.d} ref={hitWidth}
                  onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
                  onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (isDbl(`l${L.id}`)) return A.setLinkEditing(L.id); select({ links: [L.id] }, e.shiftKey); }} />
              </g>
            </Show>
          );
        }}
      </For>
      <For each={mergeKeys()}>
        {(key) => <Merge key={key} groups={groups} byId={byId} />}
      </For>
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
    </svg>
  );
}

/**
 * 几条线汇到同一处（W03 8 / 9）：合并点到终点的一小段 + 一个箭头。
 * 结构固定，方便材质另画（City 的路口等）：<g class="merge" data-card data-line data-side data-n> 里一条 .edge.stub 和一个 .ahead.end
 */
/** 一个合并组：成员和合并段（Merge 和 City 的路沿层共用） */
function stubOf(key: string, groups: Accessor<Map<string, Link[]>>, byId: Accessor<Map<string, Route>>) {
  const [k, sig] = key.split("#");
  const members = createMemo(() => (groups().get(k) ?? []).filter((L) => byId().get(L.id)?.sig() === sig));
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

function Merge(p: { key: string; groups: Accessor<Map<string, Link[]>>; byId: Accessor<Map<string, Route>> }) {
  const [k, sig] = p.key.split("#");
  const side = sig.split("|")[0];
  const [card, , line] = k.split("|");
  const { members, g } = stubOf(p.key, p.groups, p.byId);
  const on = () => members().some((L) => isOn(L.id));
  const style = () => {
    const ms = members(), L = ms[0];
    if (!L) return "";
    return `${ms.every((x) => x.style?.color === L.style?.color) ? colorCls(L) : ""}${widthCls(L)}`;
  };
  const lost = () => members().every((L) => L.lost?.to);
  return (
    <Show when={g()}>
      <g class="merge" data-card={card} data-line={line || undefined} data-side={side} data-n={members().length}>
        <path class={`edge stub${members().every((L) => L.style?.dash) ? " dashed" : ""}${style()}${lost() ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.d} />
        <Show when={look() === "city" && members().some((L) => L.call)}><path class="lane" d={g()!.d} /></Show>
        <Show when={g()!.head}><Head cls={`ahead end ${shape().head}${style()}${lost() ? " lost" : ""}${on() ? " on" : ""}`} d={g()!.head!} /></Show>
      </g>
    </Show>
  );
}
