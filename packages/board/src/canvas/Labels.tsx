import { For, Show, createMemo, createRenderEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { callText, varGone, loopLine, segOf, isCode, type Link, type Rect } from "@codeboard/core";
import { varKey } from "@codeboard/analysis/basics";
import { state, sel, select, live, cardById, rectOf } from "../state/store";
import { editing, setDragLink } from "../state/ui";
import { hoverLink, enterLink, leaveLink } from "../state/hover";
import { toWorld } from "../state/camera";
import { boardOffset } from "../state/measure";
import { Editable } from "../ui/Editable";
import { isDbl } from "../interact";
import * as A from "../actions";
import { visible, type Geo } from "./Links";
import { dragT, placeT, type Box } from "./labelpos";
import { bezAt } from "./geom";
import { NODRAG } from "../ui/guard";
import { DRAG_SLOP, track, undoGesture } from "../gesture";
import { addExtra, keepSize, keptSize } from "../state/extent";

// 框的大小（世界坐标）：一个共用的 ResizeObserver，只在框的内容变了时回调，平移 / 缩放 / 拖卡时不读布局
const sizeCbs = new WeakMap<Element, (b: Box) => void>();
let ro: ResizeObserver | undefined;
function watchSize(el: HTMLElement, cb: (b: Box) => void) {
  if (typeof ResizeObserver === "undefined") return;
  ro ??= new ResizeObserver((es) => {
    for (const e of es) {
      const s = e.borderBoxSize?.[0];
      sizeCbs.get(e.target)?.(s ? { w: s.inlineSize, h: s.blockSize } : { w: (e.target as HTMLElement).offsetWidth, h: (e.target as HTMLElement).offsetHeight });
    }
  });
  sizeCbs.set(el, cb);
  ro.observe(el);
  onCleanup(() => { ro?.unobserve(el); sizeCbs.delete(el); });
}

/**
 * 拖线上的标签框：只沿着这条线滑，框不压到两端的卡上；存的是线上的比例 at。
 * 框的大小和两张卡的位置在开始拖时量一次，拖的过程中不读布局
 */
function labelDrag(e: PointerEvent, id: string, el: HTMLElement, pts: () => number[] | undefined, at: () => { x: number; y: number } | null, ends: () => Rect[]) {
  const o0 = boardOffset(), w0 = toWorld(e.clientX - o0.x, e.clientY - o0.y), c0 = at();
  const grab = c0 ? { x: w0.x - c0.x, y: w0.y - c0.y } : { x: 0, y: 0 };
  let g: ReturnType<typeof undoGesture> | null = null;
  let box: Box = { w: 0, h: 0 }, rs: Rect[] = [];
  track(e, (ev) => {
    if (!g) {
      g = undoGesture();
      setDragLink(id);
      box = { w: el.offsetWidth, h: el.offsetHeight };
      rs = ends();
    }
    const p = pts();
    if (!p) return;
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const t = dragT(p, w.x - grab.x, w.y - grab.y, box, rs);
    live((b) => { const k = b.links.find((l) => l.id === id); if (k && k.at !== t) k.at = t; });
  }, () => { if (g) { setDragLink(null); g.end(); } }, DRAG_SLOP, () => g?.drop());
}

const NONE = new Set<string>();

/** 证据标签的悬停：三档证据都列出来（线上只画最强的那档） */
const evTip = (L: Link) => ["Evidence for this call", ...A.evidenceLines(L)].join("\n");

/** The alternatives column: this far right of the target card, this wide (styles.css .altcol) */
const ALT_GAP = 28, ALT_W = 240;

/** 灰色备选：同一个调用点的别的实现 / 别的取值，虚线灰框排在目标卡右边；点一下换成它（原来的变灰）。map 缩放级别不画 */
export function AltBoxes() {
  const links = createMemo(() => state.board.links.filter((l) => l.call && (l.call.alts?.length || l.call.vals?.some((v) => (v.opts?.length ?? 0) > 1)) && visible(l)));
  return <For each={links()}>{(L) => <AltsOf L={L} />}</For>;
}
function AltsOf(p: { L: Link }) {
  const items = createMemo(() => A.altsOf(p.L));
  const r = () => { const t = cardById(p.L.to.card); return t ? rectOf(t.host) : null; };
  const at = () => { const q = r(); return q && { x: q.x + q.w + ALT_GAP, y: q.y }; };
  const key = `alts:${p.L.id}`;
  // Not measured yet (the board opened at the map level, where the column is not drawn): the CSS width, about one box per item
  onCleanup(addExtra({ kind: "alts", link: p.L.id, rect: () => {
    const q = at(), n = items().length;
    if (!q || !n) return null;
    const s = keptSize(key) ?? { w: ALT_W, h: 26 + n * 44 };
    return { ...q, ...s };
  } }));
  return (
    <Show when={items().length && at()}>
      <div class="altcol" data-link={p.L.id} style={{ left: `${at()!.x}px`, top: `${at()!.y}px` }} ref={(el) => watchSize(el, (b) => keepSize(key, b))}>
        <div class="alt-h">{p.L.call!.impls ? `${items().length} other implementation${items().length > 1 ? "s" : ""}` : "Other branches"}</div>
        <For each={items()}>{(it, k) => (
          <button class="altbox" classList={{ lib: !!it.alt.lib }} data-tip={it.alt.lib ? `Library code (${it.alt.lib}) · ${A.K.alt}-click to swap in` : "Click to swap in · the current one turns grey"}
            data-nodrag
            onClick={(e) => { A.setAltDown(e.altKey); void A.swapAlt(p.L.id, k()); }}>
            <span class="lb">{it.alt.label}</span>
            <Show when={it.alt.lib}><span class="lib-tag">library</span></Show>
            <Show when={it.alt.detail}><small>{it.alt.detail}</small></Show>
          </button>
        )}</For>
      </div>
    </Show>
  );
}

/** 线中间的标签框（HTML，在这一层的 SVG 上面；Links.tsx 给每条线建一个，g 是那条线画出来的几何） */
export function LinkLabel(p: { L: Link; g: Accessor<Geo | null> }) {
  const L = p.L;
  const g = p.g;
  // 参数和 ↺ 只在有 Call 标记的线上；自己写的字任何线都能有
  const vars = () => L.call?.vars ?? [];
  const loop = () => !!L.call?.loop;
  const editingLabel = () => editing()?.kind === "label" && editing()?.id === L.id;
  const head = () => loop() || !!L.label || editingLabel();
  // 跨边界 / 证据 / Generated from：框最上面一行是边界类型（或证据），下一行是取值
  const ev = () => L.call?.ev;
  const bvals = () => L.call?.vals ?? [];
  const [allVals, setAllVals] = createSignal(false);
  const shownVals = () => (allVals() || bvals().length <= 4 ? bvals() : bvals().slice(0, 3));
  // RPC：RPC · shm · "run"；回到起点的线：↩ back to A
  const rpcT = () => A.rpcLabel(L);
  const backT = () => (L.back ? A.backLabel(L) : "");
  // 运行时看到的实参（observed）：一次一组，◀ ▶ 切换（不存，默认第一次）
  const seen = () => L.call?.seen ?? [];
  const [si, setSi] = createSignal(0);
  const sample = () => seen()[Math.min(si(), seen().length - 1)];
  const valOf = (name: string) => sample()?.args.find((a) => a[0] === name)?.[1];
  const top = () => !!L.call?.bound || !!ev() || !!L.gen || bvals().length > 0 || !!rpcT() || !!backT();
  const has = () => head() || top() || vars().length > 0 || seen().length > 0;
  // 普通箭头、出发行其实调用了目标卡：悬停时出 Call 按钮（右键菜单里也有 Call Mark）
  const mk = createMemo(() => !L.call && !L.rpc && !!A.callOn(L.from, L.to));
  const hov = () => hoverLink() === L.id;
  const plus = () => !!L.call && hov();

  const fromSeg = () => {
    const f = cardById(L.from.card)?.card;
    return isCode(f) && L.from.seg ? segOf(f, L.from.seg) : undefined;
  };
  // 代码更新后不在了的参数：划掉变灰留着，用户自己去掉（只在代码变了时重算）
  const gone = createMemo(() => {
    const vs = vars();
    if (!vs.length) return NONE;
    const t = cardById(L.to.card)?.card;
    const s = fromSeg();
    const site = !s || L.lost?.from || L.from.line === undefined ? "" : callText(s, L.from.line, L.call?.col ?? 0);
    const callee = isCode(t) ? t.segments.map((x) => x.text.join("\n")).join("\n") : "";
    const out = new Set(vs.filter((v) => varGone(v, site, callee)).map(varKey));
    return out.size ? out : NONE;
  });
  // ↺ 悬停：是哪一行的循环（出发卡那一段的代码里往上找）
  const loopTip = createMemo(() => {
    if (!loop()) return "";
    const s = fromSeg();
    const ll = s && L.from.line !== undefined ? loopLine(s, L.from.line) : undefined;
    return ll ? `In a loop · L${ll.line}  ${ll.text}` : "Called inside a loop";
  });

  const [box, setBox] = createSignal<Box | null>(null, { equals: (a, b) => !!a && !!b && a.w === b.w && a.h === b.h });
  const ends = (): Rect[] => {
    const a = cardById(L.from.card), b = cardById(L.to.card);
    return a && b ? [rectOf(a.host), rectOf(b.host)] : [];
  };
  // 框的位置：拖过就按存的比例（框压到卡上时往中间让），否则在线中间
  const pos = createMemo(() => {
    const gg = g();
    if (!gg) return null;
    if (L.at === undefined) return { x: gg.mx, y: gg.my };
    const bx = box();
    return bezAt(gg.pts, bx ? placeT(gg.pts, L.at, bx, ends()) : L.at);
  });
  // 位置单独一个 effect，用 translate 摆：线的一端在动（弹出、收进 Section、拖卡）时标签每帧跟着走，
  // 只改这一项，不把框的 class 重算一遍；改 left / top 每帧要从整个文档排一遍版（~0.7ms），translate 不用排版
  const at = (el: HTMLElement) => {
    el.style.left = el.style.top = "0px";
    createRenderEffect(() => { const q = pos(); if (q) el.style.translate = `${q.x}px ${q.y}px`; });
  };
  const key = `label:${L.id}`;
  onCleanup(addExtra({ kind: "label", link: L.id, rect: () => {
    const q = has() ? pos() : null, s = keptSize(key);
    return q && s ? { x: q.x - s.w / 2, y: q.y - s.h / 2, w: s.w, h: s.h } : null;
  } }));
  const plusBtn = (inside: boolean) => (
    <button class="vplus" classList={{ in: inside }} data-link={inside ? undefined : L.id} ref={(el) => { if (!inside) at(el); }} data-tip="Arguments" aria-label="Arguments"
      onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} data-nodrag onClick={() => A.openVars(L.id)}>+</button>
  );
  const callBtn = (inside: boolean) => (
    <button class="mkcall" classList={{ solo: !inside }} data-link={inside ? undefined : L.id} ref={(el) => { if (!inside) at(el); }} data-tip="This line calls the target. Add the Call mark."
      onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} data-nodrag onClick={() => A.makeCall(L.id)}>+ Call</button>
  );

  return (
    <Show when={pos()}>
      <Show when={has()} fallback={<><Show when={plus()}>{plusBtn(false)}</Show><Show when={mk() && hov()}>{callBtn(false)}</Show></>}>
        <div class="vchips" classList={{ user: !L.call && !L.gen && !L.rpc && !L.back, rpc: !!L.rpc, on: sel.links.includes(L.id), argsonly: !head() && !top(), gen: !!L.gen, [`ev-${ev()?.kind}`]: !!ev() }} data-link={L.id}
          ref={(el) => { at(el); watchSize(el, (b) => { keepSize(key, b); setBox(b); }); }}
          onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); A.labelMenu(L.id, e.clientX, e.clientY); }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            if ((e.target as HTMLElement).closest(`${NODRAG}, .editing, .mkcall, .vplus, .vval.opt, .rpcl`)) return;
            e.preventDefault();
            if (isDbl(`l${L.id}`, e)) return A.setLinkEditing(L.id);
            select({ links: [L.id] }, e.shiftKey);
            labelDrag(e, L.id, e.currentTarget, () => g()?.pts, pos, ends);
          }}>
          <Show when={plus()}>{plusBtn(true)}</Show>
          {/* 一个框：上面一行是 ↺ 和自己写的字，下面一个参数一行；只有其中一样时就只是那一样 */}
          <div class="vcard" classList={{ split: (head() || top()) && (vars().length > 0 || seen().length > 0) }}>
            <Show when={top()}>
              <div class="vtop" classList={{ under: head() }}>
                <Show when={L.gen || L.call?.bound || ev() || rpcT() || backT()}>
                  <div class="vbnd">
                    <Show when={backT()}><span class="vbt back">{backT()}</span></Show>
                    <Show when={rpcT()}><span class="vbt rpcl" data-tip="RPC · click to edit" onClick={(e) => { e.stopPropagation(); A.markRpc(L.id, e.currentTarget.closest(".vchips") ?? undefined); }}>{rpcT()}</span></Show>
                    <Show when={L.gen}><span class="vbt">Generated from</span></Show>
                    <Show when={L.call?.bound}><span class="vbt">{L.call!.bound}</span></Show>
                    <Show when={ev()?.kind === "manual"}><span class="ev-tag manual" data-tip={evTip(L)}>{ev()!.via ? `via ${ev()!.via} · manual` : "manual"}</span></Show>
                    <Show when={ev()?.kind === "observed"}><span class="ev-tag observed" data-tip={evTip(L)}>OBSERVED<Show when={ev()!.count}> · {ev()!.count}×</Show></span></Show>
                  </div>
                </Show>
                <Show when={bvals().length}>
                  <div class="vvals">
                    <For each={shownVals()}>{(v, i) => (
                      <span class="vval" classList={{ opt: (v.opts?.length ?? 0) > 1 }} data-tip={(v.opts?.length ?? 0) > 1 ? `${v.opts!.length} possible values · click to pick` : v.from ? `From ${v.from}` : undefined}
                        onPointerDown={(e) => { if ((v.opts?.length ?? 0) > 1) e.stopPropagation(); }}
                        onClick={(e) => { if ((v.opts?.length ?? 0) > 1) A.openValPicker(L.id, i(), e.currentTarget); }}>
                        {v.name} → <b>{v.value}</b><Show when={(v.opts?.length ?? 0) > 1}><i>▾</i></Show>
                      </span>
                    )}</For>
                    <Show when={shownVals().length < bvals().length}>
                      <span class="vmore" data-nodrag onClick={() => setAllVals(true)}>+{bvals().length - shownVals().length} more</span>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={head()}>
              <div class="vhead">
                <Show when={loop()}><span class="vloop" data-tip={loopTip()}>↺<Show when={!L.label && !editingLabel()}><i>in a loop</i></Show></span></Show>
                <Show when={L.label || editingLabel()}>
                  <Editable class="vlabel" kind="label" id={L.id} value={L.label ?? ""} placeholder="Label" onCommit={(v) => A.setLinkLabel(L.id, v)} />
                </Show>
              </div>
            </Show>
            <Show when={vars().length}>
              <div class="vbox">
                <For each={vars()}>{(v) => {
                  const x = () => gone().has(varKey(v));
                  return (
                    <div class="vrow" classList={{ gone: x() }} data-k={varKey(v)} data-tip={x() ? "No longer in the code. Remove it in Arguments…" : undefined}
                      onPointerEnter={() => A.hiVar(L, v, true)} onPointerLeave={() => A.hiVar(L, v, false)}>
                      <span class="va">{v.ret ? "return" : v.a}</span><span class="vto">{v.ret || v.b ? "→" : ""}</span><span class="vb">{v.ret ? v.a : v.b ?? ""}</span>
                      <Show when={!v.ret && valOf(v.b ?? v.a)}>{(x) => <span class="vv">{x()}</span>}</Show>
                    </div>
                  );
                }}</For>
              </div>
            </Show>
            {/* 运行时的实参：没勾参数时整组列出来；勾了的参数值接在那一行后面（上面） */}
            <Show when={seen().length}>
              <div class="vrun">
                <Show when={!vars().length}>
                  <For each={sample()?.args ?? []}>{(a) => <div class="vrow"><span class="va">{a[0]}</span><span class="vv">{a[1]}</span></div>}</For>
                </Show>
                <div class="vstep">
                  <button class="vsb" aria-label="Previous call" disabled={si() <= 0} data-nodrag onClick={() => setSi((i) => Math.max(0, i - 1))}>◀</button>
                  <span>call {sample()?.n} / {ev()?.count ?? seen().length}</span>
                  <button class="vsb" aria-label="Next call" disabled={si() >= seen().length - 1} data-nodrag onClick={() => setSi((i) => Math.min(seen().length - 1, i + 1))}>▶</button>
                </div>
              </div>
            </Show>
          </div>
          <Show when={mk() && hov()}>{callBtn(true)}</Show>
        </div>
      </Show>
    </Show>
  );
}
