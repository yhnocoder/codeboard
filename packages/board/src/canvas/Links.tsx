// Link 层：SVG 曲线 + 浮在中间的标签 / 变量 chip。端点每帧跟着卡片和行走（都是响应式的）。
import { For, Show, createMemo } from "solid-js";
import { findCard, varText, varKey, type Link, type PlainLink, type Rect } from "@codeboard/core";
import { state, sel, select, rectOf, cardById, collapsedAway, placeOf } from "../state/store";
import { geo, lineY } from "../state/geo";
import { frames, collapsedHome } from "../state/sections";
import { hoverLink, setHoverLink, rubber, editing, popIn } from "../state/ui";
import { cam } from "../state/camera";
import { Editable } from "../ui/Editable";
import { isDbl } from "../interact";
import * as A from "../actions";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// 离开连线后过 300ms 才算离开：鼠标从线移到 "+" 或变量框的路上不丢悬停（#30）
let leaveT: number | undefined;
const enterLink = (id: string) => { clearTimeout(leaveT); setHoverLink(id); };
const leaveLink = () => { clearTimeout(leaveT); leaveT = window.setTimeout(() => setHoverLink(null), 300); };

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

type Geo = { d: string; mx: number; my: number; head?: string; tail?: string; port?: { x: number; y: number } };

/** Call link：起点自动选边（#27）。子卡在右 → 从这一行右端出；在左 → 左端出、进子卡右侧；在下面 → 左端出绕进子卡左侧 */
function callGeo(L: Link): Geo | null {
  const p1 = lineAt(L.from.card, L.from.seg, L.from.line);
  const e2 = endRect(L.to.card);
  if (!p1 || !e2) return null;
  const a = p1.r, b = e2.r;
  const y1 = p1.y, y2 = e2.pill ? b.y + b.h / 2 : headY(L.to.card, b);
  const side = b.x >= a.x + a.w - 24 ? "right" : b.x + b.w <= a.x + 24 ? "left" : "below";
  let x1: number, x2: number, c1: number, c2: number, head: string;
  if (side === "right") {
    x1 = a.x + a.w; x2 = b.x - 6;
    const dx = clamp(Math.abs(x2 - x1) * 0.45, 24, 140);
    c1 = x1 + dx; c2 = x2 - dx;
    head = `M${x2 - 5} ${y2 - 4} L${x2} ${y2} L${x2 - 5} ${y2 + 4}`;
  } else if (side === "left") {
    x1 = a.x; x2 = b.x + b.w + 6;
    const dx = clamp(Math.abs(x1 - x2) * 0.45, 24, 140);
    c1 = x1 - dx; c2 = x2 + dx;
    head = `M${x2 + 5} ${y2 - 4} L${x2} ${y2} L${x2 + 5} ${y2 + 4}`;
  } else {
    x1 = a.x; x2 = b.x - 6;
    // 子卡在很远的下方：两端的水平控制柄要跟着距离变长，否则线先竖着下来、到卡前急拐一下
    const dx = clamp(Math.abs(y2 - y1) * 0.4 + Math.max(0, x1 - x2) * 0.6, 28, 280);
    c1 = x1 - dx; c2 = x2 - dx * 0.8;
    head = arrowHead(x2, y2, c2, y2);
  }
  return {
    d: `M${x1} ${y1} C${c1} ${y1} ${c2} ${y2} ${x2} ${y2}`,
    mx: (x1 + 3 * c1 + 3 * c2 + x2) / 8, my: (y1 + y2) / 2,
    head, port: { x: x1, y: y1 },
  };
}

/** 箭头头顺着线最后一段的方向（从控制点指向终点） */
function arrowHead(tx: number, ty: number, fx: number, fy: number) {
  const len = Math.hypot(tx - fx, ty - fy) || 1, ux = (tx - fx) / len, uy = (ty - fy) / len;
  return `M${tx - 5 * ux - 4 * uy} ${ty - 5 * uy + 4 * ux} L${tx} ${ty} L${tx - 5 * ux + 4 * uy} ${ty - 5 * uy - 4 * ux}`;
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
    x1 = right ? ra.x + ra.w : ra.x; x2 = right ? rb.x : rb.x + rb.w;
    y1 = la ? la.y : ca.y;
    y2 = lb ? lb.y : clamp(y1, rb.y + 18, rb.y + rb.h - 18);
    if (!lb && (rb.y > y1 + 60 || rb.y + rb.h < y1 - 60)) y2 = rb.y + Math.min(rb.h / 2, 18);
  } else if (rb.x > ra.x + ra.w + 16) { x1 = ra.x + ra.w; y1 = ca.y; x2 = rb.x; y2 = cb.y; }
  else if (rb.x + rb.w < ra.x - 16) { x1 = ra.x; y1 = ca.y; x2 = rb.x + rb.w; y2 = cb.y; }
  else if (rb.y > ra.y + ra.h) { h = false; x1 = ca.x; y1 = ra.y + ra.h; x2 = cb.x; y2 = rb.y; }
  else { h = false; x1 = ca.x; y1 = ra.y; x2 = cb.x; y2 = rb.y + rb.h; }
  let c1: number[], c2: number[];
  if (h) { const dx = Math.max(30, Math.abs(x2 - x1) * 0.45) * Math.sign(x2 - x1 || 1); c1 = [x1 + dx, y1]; c2 = [x2 - dx, y2]; }
  else { const dy = Math.max(30, Math.abs(y2 - y1) * 0.45) * Math.sign(y2 - y1 || 1); c1 = [x1, y1 + dy]; c2 = [x2, y2 - dy]; }
  const arrow = (tx: number, ty: number, fx: number, fy: number) => {
    const len = Math.hypot(tx - fx, ty - fy) || 1, ux = (tx - fx) / len, uy = (ty - fy) / len;
    return `M${tx - 7 * ux - 4 * uy} ${ty - 7 * uy + 4 * ux} L${tx} ${ty} L${tx - 7 * ux + 4 * uy} ${ty - 7 * uy - 4 * ux}`;
  };
  return {
    d: `M${x1} ${y1} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${x2} ${y2}`,
    mx: (x1 + 3 * c1[0] + 3 * c2[0] + x2) / 8, my: (y1 + 3 * c1[1] + 3 * c2[1] + y2) / 8,
    head: L.arrow === "end" || L.arrow === "both" ? arrow(x2, y2, c2[0], c2[1]) : undefined,
    tail: L.arrow === "both" ? arrow(x1, y1, c1[0], c1[1]) : undefined,
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

export function LinksSvg() {
  const links = createMemo(() => state.board.links.filter(visible));
  return (
    <svg class="edges" width="1" height="1">
      <For each={links()}>
        {(L) => {
          const g = createMemo(() => (L.kind === "call" ? callGeo(L) : plainGeo(L)));
          const on = () => sel.links.includes(L.id) || hoverLink() === L.id;
          const cls = () => `edge${L.kind === "plain" ? " plain" + ((L as PlainLink).solid ? " solid" : "") + ((L as PlainLink).color ? ` lc-${(L as PlainLink).color}` : "") : ""}${on() ? " on" : ""}`;
          return (
            <Show when={g()}>
              <path class={cls()} d={g()!.d} />
              <Show when={g()!.head}><path class={`ahead${L.kind === "plain" && L.color ? ` lc-${L.color}` : ""}${on() ? " on" : ""}`} d={g()!.head} /></Show>
              <Show when={g()!.tail}><path class={`ahead${L.kind === "plain" && L.color ? ` lc-${L.color}` : ""}${on() ? " on" : ""}`} d={g()!.tail} /></Show>
              <Show when={g()!.port}><circle class="port" r="3" cx={g()!.port!.x} cy={g()!.port!.y} /></Show>
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
        return (
          <Show when={g()}>
            <Show when={has()}>
              <div class="vchips" classList={{ user: L.kind === "plain", on: sel.links.includes(L.id) }} data-link={L.id} style={{ left: `${g()!.mx}px`, top: `${g()!.my}px` }}
                onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
                onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); if ((e.target as HTMLElement).closest(".editing, .mkcall, .vplus")) return; e.preventDefault(); if (isDbl(`l${L.id}`)) return A.setLinkEditing(L.id); select({ links: [L.id] }, e.shiftKey); }}>
                <Show when={plus() && vars().length}><button class="vplus in" data-tip="Variables on this call" aria-label="Variables on this call" onPointerDown={(e) => e.stopPropagation()} onClick={() => A.openVars(L.id)}>+</button></Show>
                <Show when={L.kind === "call" && L.loop}><span class="vchip loop" data-tip="Called inside a loop">↺</span></Show>
                <Show when={L.label || editingLabel()}>
                  <Editable class="vlabel" kind="label" id={L.id} value={L.label ?? ""} placeholder="Label" onCommit={(v) => A.setLinkLabel(L.id, v)} />
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
                <Show when={mk()}><button class="mkcall" data-tip="This line calls the target. Make it a numbered call." onPointerDown={(e) => e.stopPropagation()} onClick={() => A.makeCall(L.id)}>Make Call</button></Show>
              </div>
            </Show>
            <Show when={plus() && !vars().length}>
              <button class="vplus" style={{ left: `${g()!.mx}px`, top: `${g()!.my}px` }} data-tip="Variables on this call" aria-label="Variables on this call"
                onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} onPointerDown={(e) => e.stopPropagation()} onClick={() => A.openVars(L.id)}>+</button>
            </Show>
          </Show>
        );
      }}
    </For>
  );
}
void findCard;
