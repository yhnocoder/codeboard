// 线上的标签框：↺、自己写的字、调用参数（一条线一个框，沿线拖动）。W01 C 13–21、D 23。
import { For, Show, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { varKey, callText, varGone, loopLine, segOf, isCode, type Link, type Rect } from "@codeboard/core";
import { sel, select, live, beginGesture, cardById, rectOf } from "../state/store";
import { hoverLink, editing, setDragLink } from "../state/ui";
import { toWorld } from "../state/camera";
import { boardOffset } from "../actions/common";
import { Editable } from "../ui/Editable";
import { isDbl } from "../interact";
import * as A from "../actions";
import { enterLink, leaveLink, type Geo } from "./Links";
import { bezAt, dragT, placeT, type Box } from "./labelpos";

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
 * 拖线上的标签框：只沿着这条线滑，框不压到两端的卡上（W01 C 19）；存的是线上的比例 at（20）。
 * 框的大小和两张卡的位置在开始拖时量一次，拖的过程中不读布局
 */
function labelDrag(e: PointerEvent, id: string, el: HTMLElement, pts: () => number[] | undefined, at: () => { x: number; y: number } | null, ends: () => Rect[]) {
  const sx = e.clientX, sy = e.clientY;
  const o0 = boardOffset(), w0 = toWorld(sx - o0.x, sy - o0.y), c0 = at();
  const grab = c0 ? { x: w0.x - c0.x, y: w0.y - c0.y } : { x: 0, y: 0 };
  let end: (() => void) | null = null;
  let box: Box = { w: 0, h: 0 }, rs: Rect[] = [];
  const move = (ev: PointerEvent) => {
    if (!end) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      end = beginGesture();
      setDragLink(id);
      box = { w: el.offsetWidth, h: el.offsetHeight };
      rs = ends();
    }
    const p = pts();
    if (!p) return;
    const o = boardOffset(), w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
    const t = dragT(p, w.x - grab.x, w.y - grab.y, box, rs);
    live((b) => { const k = b.links.find((l) => l.id === id); if (k && k.at !== t) k.at = t; });
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (end) setDragLink(null); end?.(); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

const NONE = new Set<string>();

/** 线中间的标签框（HTML，在这一层的 SVG 上面；Links.tsx 给每条线建一个，g 是那条线画出来的几何） */
export function LinkLabel(p: { L: Link; g: Accessor<Geo | null> }) {
  const L = p.L;
  const g = p.g;
  // 参数和 ↺ 只在有 Call 标记的线上（W01 C 14、15）；自己写的字任何线都能有（13）
  const vars = () => L.call?.vars ?? [];
  const loop = () => !!L.call?.loop;
  const editingLabel = () => editing()?.kind === "label" && editing()?.id === L.id;
  const head = () => loop() || !!L.label || editingLabel();
  const has = () => head() || vars().length > 0;
  // 普通箭头、出发行其实调用了目标卡：悬停时出 Call 按钮（右键菜单里也有 Call Mark）
  const mk = createMemo(() => !L.call && !!A.callOn(L.from, L.to));
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
  const style = () => { const q = pos()!; return { left: `${q.x}px`, top: `${q.y}px` }; };
  const plusBtn = (inside: boolean) => (
    <button class="vplus" classList={{ in: inside }} data-link={inside ? undefined : L.id} style={inside ? undefined : style()} data-tip="Arguments" aria-label="Arguments"
      onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} onPointerDown={(e) => e.stopPropagation()} onClick={() => A.openVars(L.id)}>+</button>
  );
  const callBtn = (inside: boolean) => (
    <button class="mkcall" classList={{ solo: !inside }} data-link={inside ? undefined : L.id} style={inside ? undefined : style()} data-tip="This line calls the target. Add the Call mark."
      onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink} onPointerDown={(e) => e.stopPropagation()} onClick={() => A.makeCall(L.id)}>+ Call</button>
  );

  return (
    <Show when={pos()}>
      <Show when={has()} fallback={<><Show when={plus()}>{plusBtn(false)}</Show><Show when={mk() && hov()}>{callBtn(false)}</Show></>}>
        <div class="vchips" classList={{ user: !L.call, on: sel.links.includes(L.id), argsonly: !head() }} data-link={L.id} style={style()}
          ref={(el) => watchSize(el, setBox)}
          onPointerEnter={() => enterLink(L.id)} onPointerLeave={leaveLink}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); A.labelMenu(L.id, e.clientX, e.clientY); }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            if ((e.target as HTMLElement).closest(".editing, .mkcall, .vplus")) return;
            e.preventDefault();
            if (isDbl(`l${L.id}`)) return A.setLinkEditing(L.id);
            select({ links: [L.id] }, e.shiftKey);
            labelDrag(e, L.id, e.currentTarget, () => g()?.pts, pos, ends);
          }}>
          <Show when={plus()}>{plusBtn(true)}</Show>
          {/* 一个框：上面一行是 ↺ 和自己写的字，下面一个参数一行；只有其中一样时就只是那一样（W01 C 16） */}
          <div class="vcard" classList={{ split: head() && vars().length > 0 }}>
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
                    </div>
                  );
                }}</For>
              </div>
            </Show>
          </div>
          <Show when={mk() && hov()}>{callBtn(true)}</Show>
        </div>
      </Show>
    </Show>
  );
}
