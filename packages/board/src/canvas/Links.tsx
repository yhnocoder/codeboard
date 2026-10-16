// Link 层：SVG 曲线 + 浮在中间的标签 / 变量 chip。端点每帧跟着卡片和行走（都是响应式的）。
import { For, Show, createMemo } from "solid-js";
import { findCard, varText, varKey, type Link, type PlainLink, type Rect } from "@codeboard/core";
import { state, sel, select, rectOf, cardById, collapsedAway, placeOf, live, beginGesture } from "../state/store";
import { geo, lineY } from "../state/geo";
import { frames, collapsedHome } from "../state/sections";
import { hoverLink, setHoverLink, rubber, editing, popIn } from "../state/ui";
import { cam, toWorld } from "../state/camera";
import { boardOffset } from "../actions/common";
import { shape, fileHue } from "../state/look";
import { tune } from "../state/tune";
import { Editable } from "../ui/Editable";
import { isDbl } from "../interact";
import * as A from "../actions";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// 离开连线后过 300ms 才算离开：鼠标从线移到 "+" 或变量框的路上不丢悬停（#30）
let leaveT: number | undefined;
const enterLink = (id: string) => { clearTimeout(leaveT); setHoverLink(id); };
const leaveLink = () => { clearTimeout(leaveT); leaveT = window.setTimeout(() => setHoverLink(null), tune("linkLeave")); };

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
function headY(id: string, r: Rect) {
  const f = cardById(id);
  const g = geo[id];
  if (f && f.host.id !== id && g) return r.y + g.head - 14; // Compare 栏头
  return r.y + 17;
}
function lineAt(id: string, seg?: string, line?: number) {
  const e = endRect(id);
  if (!e) return null;
  if (e.pill || line === undefined) return { x: e.r.x, y: e.pill ? e.r.y + e.r.h / 2 : headY(id, e.r), r: e.r };
  const p = lineY(id, seg, line);
  const pi = popIn()[cardById(id)!.host.id];
  const y = p ? p.y + (pi ? (1 - pi.v) * pi.oy : 0) : headY(id, e.r);
  return { x: e.r.x, y, r: e.r };
}

type Geo = { d: string; mx: number; my: number; head?: string; tail?: string; port?: { x: number; y: number }; pts: number[] };

/** 线的三次贝塞尔控制点 [x1 y1 c1x c1y c2x c2y x2 y2]（贴纸绑在线上时用） */
export function linkCurve(id: string): number[] | null {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || !visible(L)) return null;
  return (L.kind === "call" ? callGeo(L) : plainGeo(L))?.pts ?? null;
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

/** 箭头：tip 是尖，(ux, uy) 是来的方向（单位向量）。形状跟材质走（look.ts） */
function headPath(tx: number, ty: number, ux: number, uy: number) {
  const k = shape().head;
  if (k === "dot") return `M${tx - 3.5} ${ty} a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0`;
  const l = k === "triangle" ? 8 : 7, w = 4;
  const a = `M${tx - l * ux - w * uy} ${ty - l * uy + w * ux} L${tx} ${ty} L${tx - l * ux + w * uy} ${ty - l * uy - w * ux}`;
  return k === "triangle" ? a + " Z" : a;
}
function portPath(x: number, y: number) {
  const k = shape().port;
  if (k === "square") return `M${x - 3} ${y - 3} h6 v6 h-6 Z`;
  if (k === "diamond") return `M${x} ${y - 4} l4 4 -4 4 -4 -4 Z`;
  return `M${x - 3} ${y} a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0`;
}

/**
 * Call link 从这一行的哪一端出：子卡整个在右 → 右；整个在左 → 左；上下错开（横向重叠）时看子卡左边在不在父卡中线右边（宽松）。
 * 用户拖过起点或在菜单 Start From 里选过（L.side）就一直照用户的。
 */
export function callSide(L: Link, a: Rect, b: Rect): "left" | "right" {
  if (L.side) return L.side;
  if (b.x >= a.x + a.w - 24) return "right";
  if (b.x + b.w <= a.x + 24) return "left";
  return b.x >= a.x + a.w / 2 ? "right" : "left";
}

/**
 * Call link：起点自动选边（#27），也可以拖起点改（L.side）。
 * 右端出：子卡在右 → 进子卡左侧；子卡在下（或上）→ 从上（下）边进子卡。左端出：子卡在左 → 进子卡右侧；否则绕进子卡左侧。
 */
function callGeo(L: Link): Geo | null {
  const p1 = lineAt(L.from.card, L.from.seg, L.from.line);
  const e2 = endRect(L.to.card);
  if (!p1 || !e2) return null;
  const a = p1.r, b = e2.r;
  const y1 = p1.y;
  let y2 = e2.pill ? b.y + b.h / 2 : headY(L.to.card, b);
  const side = callSide(L, a, b);
  let x1: number, x2: number, c1x: number, c1y = y1, c2x: number, c2y: number, head: string;
  if (side === "right") {
    x1 = a.x + a.w;
    if (b.x >= x1 - 24) {
      x2 = b.x - 6;
      // 横向近、纵向远（子卡在右上 / 右下）：控制柄也跟着纵向距离变长，否则线竖着上去、到卡前急拐，箭头像是断开的
      const dx = clamp(Math.abs(x2 - x1) * 0.45 + Math.abs(y2 - y1) * 0.3, 24, 180);
      c1x = x1 + dx; c2x = x2 - dx; c2y = y2;
      head = headPath(x2, y2, 1, 0);
    } else {
      // 子卡在下面（或上面）、又在起点左边：从它的上（下）边进，箭头竖着
      const down = b.y + b.h / 2 >= y1;
      x2 = clamp(x1 + 48, b.x + 28, b.x + b.w - 28);
      y2 = down ? b.y - 6 : b.y + b.h + 6;
      const dx = clamp(Math.abs(x2 - x1) * 0.5 + 36, 36, 220), dy = clamp(Math.abs(y2 - y1) * 0.5, 30, 220);
      c1x = x1 + dx; c2x = x2; c2y = down ? y2 - dy : y2 + dy;
      head = arrowHead(x2, y2, c2x, c2y);
    }
  } else {
    x1 = a.x;
    if (b.x + b.w <= x1 + 24) {
      x2 = b.x + b.w + 6;
      const dx = clamp(Math.abs(x1 - x2) * 0.45 + Math.abs(y2 - y1) * 0.3, 24, 180);
      c1x = x1 - dx; c2x = x2 + dx; c2y = y2;
      head = headPath(x2, y2, -1, 0);
    } else {
      x2 = b.x - 6;
      // 子卡在很远的下方：两端的水平控制柄要跟着距离变长，否则线先竖着下来、到卡前急拐一下
      const dx = clamp(Math.abs(y2 - y1) * 0.4 + Math.max(0, x1 - x2) * 0.6, 28, 280);
      c1x = x1 - dx; c2x = x2 - dx * 0.8; c2y = y2;
      head = arrowHead(x2, y2, c2x, y2);
    }
  }
  if (shape().route === "elbow") {
    // 制图：直角折线，像标注引线
    const vert = c2x === x2; // 从上 / 下边进
    const xm = vert ? x2 : side === "left" && x2 > x1 ? Math.min(x1, x2) - 24 : x1 + (x2 - x1) * 0.5;
    const d = vert ? `M${x1} ${y1} H${x2} V${y2}` : `M${x1} ${y1} H${xm} V${y2} H${x2}`;
    return { d, mx: xm, my: (y1 + y2) / 2, head: vert ? headPath(x2, y2, 0, Math.sign(y2 - y1) || 1) : head, port: { x: x1, y: y1 }, pts: [x1, y1, xm, y1, xm, y2, x2, y2] };
  }
  return {
    d: `M${x1} ${y1} C${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`,
    mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8, my: (y1 + 3 * c1y + 3 * c2y + y2) / 8,
    head, port: { x: x1, y: y1 }, pts: [x1, y1, c1x, c1y, c2x, c2y, x2, y2],
  };
}

/** 箭头头顺着线最后一段的方向（从控制点指向终点） */
function arrowHead(tx: number, ty: number, fx: number, fy: number) {
  const len = Math.hypot(tx - fx, ty - fy) || 1;
  return headPath(tx, ty, (tx - fx) / len, (ty - fy) / len);
}

function plainGeo(L: PlainLink): Geo | null {
  const ea = endRect(L.from.card), eb = endRect(L.to.card);
  if (!ea || !eb) return null;
  const ra = ea.r, rb = eb.r;
  const la = L.from.line !== undefined && !ea.pill ? lineAt(L.from.card, L.from.seg, L.from.line) : null;
  const lb = L.to.line !== undefined && !eb.pill ? lineAt(L.to.card, L.to.seg, L.to.line) : null;
  const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
  let x1: number, y1: number, x2: number, y2: number, h = true;
  if (la || lb) {
    const right = cb.x >= ca.x;
    x1 = (L.side ?? (right ? "right" : "left")) === "right" ? ra.x + ra.w : ra.x; x2 = right ? rb.x : rb.x + rb.w;
    y1 = la ? la.y : ca.y;
    y2 = lb ? lb.y : clamp(y1, rb.y + 18, rb.y + rb.h - 18);
    if (!lb && (rb.y > y1 + 60 || rb.y + rb.h < y1 - 60)) y2 = rb.y + Math.min(rb.h / 2, 18);
  } else if (rb.x > ra.x + ra.w + 16) { x1 = ra.x + ra.w; y1 = ca.y; x2 = rb.x; y2 = cb.y; }
  else if (rb.x + rb.w < ra.x - 16) { x1 = ra.x; y1 = ca.y; x2 = rb.x + rb.w; y2 = cb.y; }
  else if (rb.y > ra.y + ra.h) { h = false; x1 = ca.x; y1 = ra.y + ra.h; x2 = cb.x; y2 = rb.y; }
  else { h = false; x1 = ca.x; y1 = ra.y; x2 = cb.x; y2 = rb.y + rb.h; }
  let c1: number[], c2: number[];
  if (h) {
    // 两端各自朝卡外出 / 进（起点被用户指定到另一边时线会先往外绕）
    const dx = Math.max(30, Math.abs(x2 - x1) * 0.45);
    const o1 = x1 >= ra.x + ra.w - 0.5 ? 1 : -1, o2 = x2 <= rb.x + 0.5 ? 1 : -1;
    c1 = [x1 + dx * o1, y1]; c2 = [x2 - dx * o2, y2];
  }
  else { const dy = Math.max(30, Math.abs(y2 - y1) * 0.45) * Math.sign(y2 - y1 || 1); c1 = [x1, y1 + dy]; c2 = [x2, y2 - dy]; }
  const arrow = arrowHead;
  if (shape().route === "elbow") {
    const xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
    const d = h ? `M${x1} ${y1} H${xm} V${y2} H${x2}` : `M${x1} ${y1} V${ym} H${x2} V${y2}`;
    const [e1, e2] = h ? [[xm, y2], [xm, y1]] : [[x2, ym], [x1, ym]];
    return {
      d, mx: h ? xm : (x1 + x2) / 2, my: ym,
      head: (L.arrow ?? "end") !== "none" ? arrow(x2, y2, e1[0], e1[1]) : undefined,
      tail: L.arrow === "both" ? arrow(x1, y1, e2[0], e2[1]) : undefined,
      pts: h ? [x1, y1, xm, y1, xm, y2, x2, y2] : [x1, y1, x1, ym, x2, ym, x2, y2],
    };
  }
  return {
    d: `M${x1} ${y1} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${x2} ${y2}`,
    mx: (x1 + 3 * c1[0] + 3 * c2[0] + x2) / 8, my: (y1 + 3 * c1[1] + 3 * c2[1] + y2) / 8,
    head: (L.arrow ?? "end") !== "none" ? arrow(x2, y2, c2[0], c2[1]) : undefined,
    tail: L.arrow === "both" ? arrow(x1, y1, c1[0], c1[1]) : undefined,
    pts: [x1, y1, c1[0], c1[1], c2[0], c2[1], x2, y2],
  };
}

function visible(L: Link) {
  const a = cardById(L.from.card), b = cardById(L.to.card);
  if (!a || !b) return false;
  if (collapsedAway().has(a.host.id) || collapsedAway().has(b.host.id)) return false;
  const ha = collapsedHome(placeOf(a.host.id).section), hb = collapsedHome(placeOf(b.host.id).section);
  if (ha && ha === hb) return false;
  return true;
}

/** 拖线上的标签框：只能沿着这条线走（存沿线的位置 t） */
function labelDrag(e: PointerEvent, id: string) {
  const sx = e.clientX, sy = e.clientY;
  let end: (() => void) | null = null;
  const move = (ev: PointerEvent) => {
    if (!end) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return; end = beginGesture(); }
    const c = linkCurve(id);
    if (!c) return;
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const t = Math.round(Math.max(0.08, Math.min(0.92, nearestT(c, w.x, w.y))) * 100) / 100;
    live((b) => { const k = b.links.find((l) => l.id === id); if (k) k.at = t; });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); end?.(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** 拖起点的小圆点：只能换到这一行的另一端（左 / 右），松手时看指针在父卡中线哪边 */
function portDrag(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  const L = state.board.links.find((l) => l.id === id);
  if (L?.kind !== "call") return;
  const a = endRect(L.from.card)?.r;
  if (!a) return;
  const end = beginGesture();
  const move = (ev: PointerEvent) => {
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const side = w.x >= a.x + a.w / 2 ? "right" : "left";
    live((b) => { const k = b.links.find((l) => l.id === id); if (k?.kind === "call" && k.side !== side) k.side = side; });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); end(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function LinksSvg() {
  const links = createMemo(() => state.board.links.filter(visible));
  return (
    <svg class="edges" width="1" height="1">
      <For each={links()}>
        {(L) => {
          const g = createMemo(() => (L.kind === "call" ? callGeo(L) : plainGeo(L)));
          const on = () => sel.links.includes(L.id) || hoverLink() === L.id || (A.bindHot() as { link?: string } | null)?.link === L.id;
          const toHue = () => { const t = cardById(L.to.card)?.card; return t?.kind === "code" ? fileHue(t.segments[0]?.path) : 0; };
          const cls = () => `edge${L.kind === "plain" ? " plain" + ((L as PlainLink).solid === false ? " dashed" : "") + ((L as PlainLink).color ? ` lc-${(L as PlainLink).color}` : "") : ""}${on() ? " on" : ""}`;
          return (
            <Show when={g()}>
              <path class={cls()} d={g()!.d} />
              <Show when={g()!.head}><path class={`ahead ${shape().head}${L.kind === "plain" && L.color ? ` lc-${L.color}` : ""}${on() ? " on" : ""}`} d={g()!.head} /></Show>
              <Show when={g()!.tail}><path class={`ahead ${shape().head}${L.kind === "plain" && L.color ? ` lc-${L.color}` : ""}${on() ? " on" : ""}`} d={g()!.tail} /></Show>
              <Show when={g()!.port}><path class={`port fc-${toHue()}`} data-x={g()!.port!.x} d={portPath(g()!.port!.x, g()!.port!.y)} />
                <Show when={on() && L.kind === "call"}><circle class="porthit" onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} data-tip="Drag to the other end of the line" r={7 / cam.z} cx={g()!.port!.x} cy={g()!.port!.y} onPointerDown={(e) => portDrag(e, L.id)} /></Show></Show>
              <path class="lhit" data-link={L.id} d={g()!.d} style={{ "stroke-width": `${12 / cam.z}px` }}
                onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
                onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (isDbl(`l${L.id}`)) return A.setLinkEditing(L.id); select({ links: [L.id] }, e.shiftKey); }} />
            </Show>
          );
        }}
      </For>
      <Show when={rubber()}>
        {(r) => {
          const w0 = () => ({ x: (r().x1 - cam.x) / cam.z, y: (r().y1 - cam.y) / cam.z }), w1 = () => ({ x: (r().x2 - cam.x) / cam.z, y: (r().y2 - cam.y) / cam.z });
          const d = () => {
            const a = w0(), b = w1();
            if (r().plain) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
            const dx = clamp(Math.abs(b.y - a.y) * 0.3 + Math.max(0, a.x - b.x) * 0.6, 28, 130);
            return `M${a.x} ${a.y} C${a.x - dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
          };
          return <path class={`edge rubber${r().plain ? " plain" : ""}`} d={d()} />;
        }}
      </Show>
    </svg>
  );
}

/** 线中间的标签和变量 chip（HTML，在 SVG 上面） */
export function LinkLabels() {
  const links = createMemo(() => state.board.links.filter(visible));
  return (
    <For each={links()}>
      {(L) => {
        const g = createMemo(() => (L.kind === "call" ? callGeo(L) : plainGeo(L)));
        const vars = () => (L.kind === "call" ? L.vars ?? [] : []);
        const editingLabel = () => editing()?.kind === "label" && editing()?.id === L.id;
        const mk = createMemo(() => L.kind === "plain" && !!A.callOn(L.from, L.to));
        const has = () => L.label || editingLabel() || mk() || (L.kind === "call" && (vars().length || !!L.loop));
        const plus = () => L.kind === "call" && hoverLink() === L.id;
        // 标签框的位置：拖过就按沿线的 t，否则在中间
        const pos = () => { const gg = g()!; return L.at !== undefined ? curveAt(gg.pts, L.at) : { x: gg.mx, y: gg.my }; };
        return (
          <Show when={g()}>
            <Show when={has()}>
              <div class="vchips" classList={{ user: L.kind === "plain", on: sel.links.includes(L.id) }} data-link={L.id} style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
                onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
                onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); if ((e.target as HTMLElement).closest(".editing, .mkcall, .vplus")) return; e.preventDefault(); if (isDbl(`l${L.id}`)) return A.setLinkEditing(L.id); select({ links: [L.id] }, e.shiftKey); labelDrag(e, L.id); }}>
                <Show when={plus() && vars().length}><button class="vplus in" data-tip="Variables on this call" aria-label="Variables on this call" onPointerDown={(e) => e.stopPropagation()} onClick={() => A.openVars(L.id)}>+</button></Show>
                {/* 一个框：上面一行是 ↺ 和自己写的标签，下面是变量；只有其中一样时就只是那一样 */}
                <Show when={(L.kind === "call" && L.loop) || L.label || editingLabel() || vars().length}>
                  <div class="vcard" classList={{ split: !!((L.kind === "call" && L.loop) || L.label || editingLabel()) && !!vars().length }}>
                    <Show when={(L.kind === "call" && L.loop) || L.label || editingLabel()}>
                      <div class="vhead">
                        <Show when={L.kind === "call" && L.loop}><span class="vloop" data-tip="Called inside a loop">↺<Show when={!L.label && !editingLabel()}><i>in a loop</i></Show></span></Show>
                        <Show when={L.label || editingLabel()}>
                          <Editable class="vlabel" kind="label" id={L.id} value={L.label ?? ""} placeholder="Label" onCommit={(v) => A.setLinkLabel(L.id, v)} />
                        </Show>
                      </div>
                    </Show>
                    <Show when={vars().length}>
                      <div class="vbox">
                        <For each={vars()}>{(v) => (
                          <div class="vrow" data-k={varKey(v)} onPointerEnter={() => A.hiVar(L, v, true)} onPointerLeave={() => A.hiVar(L, v, false)}>
                            <span class="va">{v.ret ? "return" : v.a}</span><span class="vto">{v.ret || v.b ? "→" : ""}</span><span class="vb">{v.ret ? v.a : v.b ?? ""}</span>
                          </div>
                        )}</For>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={mk()}><button class="mkcall" data-tip="This line calls the target. Make it a numbered call." onPointerDown={(e) => e.stopPropagation()} onClick={() => A.makeCall(L.id)}>Make Call</button></Show>
              </div>
            </Show>
            <Show when={plus() && !vars().length}>
              <button class="vplus" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} data-tip="Variables on this call" aria-label="Variables on this call"
                onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} onPointerDown={(e) => e.stopPropagation()} onClick={() => A.openVars(L.id)}>+</button>
            </Show>
          </Show>
        );
      }}
    </For>
  );
}
void findCard;
