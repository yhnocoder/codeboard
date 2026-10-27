// 子白板框：标题（名字 · 卡数 · commit）+ 分栏（一个 Section 一栏，栏里是固定字号的小卡片：种类图标、标题、一行摘要），
// 右边、下边渐隐，不画箭头。排布在 state/subboards.ts 里算好（miniLayout），这里按位置拼成一段 HTML 一次放进去（不是每张小卡片一个组件）：
// 拖别的卡、平移缩放都不碰它，只有骨架换了（宿主推来新的）、连进来的箭头变了才重新拼。选中的框里滚轮滚分栏（interact.ts colsWheel）。
import { createEffect, createMemo, on, onCleanup, Show } from "solid-js";
import { escHtml } from "@codeboard/core";
import type { BoardCard, SkelCard } from "@codeboard/core";
import { flows, placeOf, state, isSel } from "../state/store";
import { dropTarget } from "../state/ui";
import { skels, layoutOf, colScroll, setColScroll, COLS_TOP, type MiniLayout, type MiniBox } from "../state/subboards";
import { linksInto } from "../actions/nav";
import { assetSrc } from "../actions/web";
import { colsWheel } from "../interact";
import { Icon, iconHtml } from "../ui/icons";
import { MarkView } from "./Card";

type Joined = { g: Set<number>; cards: Set<string> };
const key = (j: Joined) => `${[...j.g].join(",")}|${[...j.cards].join(",")}`;

export function BoardBody(p: { card: BoardCard }) {
  const sk = () => skels[p.card.board];
  const pl = () => placeOf(p.card.id);
  // 父白板上的调用图（框连进来的箭头）：它连到的那几张小卡片换成父白板的标记
  const node = createMemo(() => flows().byId.get(p.card.id));
  const joined = createMemo(() => {
    const s = sk(), out: Joined = { g: new Set(), cards: new Set() };
    if (!s) return out;
    for (const l of linksInto(p.card.id)) {
      if (l.to.card !== p.card.id || l.to.sub === undefined || !l.call) continue;
      const c = s.cards.find((k) => k.id === l.to.sub || k.ids?.includes(l.to.sub!));
      if (!c) continue;
      out.cards.add(c.id);
      if (c.g !== undefined) out.g.add(c.g);
    }
    return out;
  }, undefined, { equals: (a, b) => !!a && !!b && key(a) === key(b) });
  // 设置 Sub-board Preview = Title Only：框里只有名字和卡数
  const titleOnly = () => state.host.settings.subPreview === "title";
  const layout = createMemo(() => (sk() && !titleOnly() ? layoutOf(p.card.board) : null));
  const html = createMemo(() => { const l = layout(); return l ? colsHtml(l, joined(), node()?.label ?? "") : ""; });
  const name = () => p.card.title || sk()?.name || (sk() === null ? "Board not found" : "Loading…");
  const meta = () => { const s = sk(); return s ? `${s.n} card${s.n === 1 ? "" : "s"}${s.commit ? ` · ${s.commit}` : ""}` : ""; };

  let el: HTMLDivElement | undefined;
  // 连箭头时悬停 / 落点所在的那张小卡片：只改那一张的 class，不重拼
  createEffect(on(() => { const d = dropTarget(); return d?.card === p.card.id ? d.sub : undefined; }, (hot, was) => {
    if (!el) return;
    if (was) el.querySelector(`[data-sub="${CSS.escape(was)}"]`)?.classList.remove("hot");
    if (hot) el.querySelector(`[data-sub="${CSS.escape(hot)}"]`)?.classList.add("hot");
  }));
  // 分栏比框大的那一边渐隐；滚到头的那一边不再渐隐
  const scroll = () => colScroll[p.card.id] ?? { x: 0, y: 0 };
  const fadeR = () => { const l = layout(); return !!l && scroll().x + pl().w < l.w - 1; };
  const fadeB = () => { const l = layout(); return !!l && scroll().y + (pl().h ?? 320) - COLS_TOP < l.h - 1; };
  // 新骨架排出来的分栏可能比原来窄：滚出去的位置收回来
  createEffect(on(html, () => {
    if (!el) return;
    if (el.scrollLeft || el.scrollTop) { el.scrollLeft = Math.min(el.scrollLeft, el.scrollWidth - el.clientWidth); el.scrollTop = Math.min(el.scrollTop, el.scrollHeight - el.clientHeight); }
    remember();
  }, { defer: true }));
  const remember = () => {
    if (!el) return;
    const s = colScroll[p.card.id], x = el.scrollLeft, y = el.scrollTop;
    if ((s?.x ?? 0) !== x || (s?.y ?? 0) !== y) setColScroll(p.card.id, { x, y });
  };
  onCleanup(() => setColScroll(p.card.id, undefined as never));
  return (
    <>
      <div class="sbhead" data-drag>
        <Show when={node()}><span class="step"><MarkView g={node()!} /></span></Show>
        <Icon name="boards" size={14} />
        <span class="sbname">{name()}</span>
        <span class="sbmeta">{meta()}</span>
      </div>
      <Show when={sk() === null}><div class="sbgone" data-drag>This board was deleted or can’t be read.</div></Show>
      {/* 地图档时浮在框上面的名字（字号按 --iz 放大） */}
      <div class="sbfar">{p.card.title || sk()?.name || ""}</div>
      <Show when={titleOnly() && sk()} fallback={
        <div ref={el} class="skel sbcols" classList={{ "fade-r": fadeR(), "fade-b": fadeB() }} data-drag innerHTML={html()}
          onWheel={(e) => { if (el && colsWheel(e, el, isSel(p.card.id))) remember(); }} onScroll={remember} />
      }>
        <div class="sbonly" data-drag><b>{name()}</b><small>{meta()}</small></div>
      </Show>
    </>
  );
}

/** 小卡片上面那一行：种类图标 + 出处 */
function srcOf(c: SkelCard): [string, string] {
  if (c.hand) return ["mark", "Mark"];
  switch (c.k) {
    case "code": return ["code", c.f ?? "Code"];
    case "note": return ["note", "Note"];
    case "image": return ["image", c.f ?? "Image"];
    case "web": return ["web", c.f ?? "Web"];
    case "links": return ["link", "Links"];
    case "compare": return ["swap", "Compare"];
    case "board": return ["boards", "Board"];
    default: return ["note", ""];
  }
}

function miniHtml(b: MiniBox, joined: Joined, mark: string): string {
  const c = b.c;
  const pos = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;--tl:${b.tl}`;
  if (c.k === "more") return `<div class="mini k-more" data-sub="${escHtml(c.id)}" style="${pos}"><div class="ti sk-more">${escHtml(c.t)}</div></div>`;
  const isJoined = !!mark && ((c.g !== undefined && joined.g.has(c.g)) || joined.cards.has(c.id));
  const m = isJoined ? mark : c.m ?? (c.i ? "◆" : "");
  const [ico, src] = srcOf(c);
  const cls = `mini k-${c.k}${c.hand ? " sticky" : ""}${c.sec ? ` s-${escHtml(c.sec)}` : ""}`;
  const sub = c.hand ? "" : c.img ? `<img class="thumb" src="${escHtml(assetSrc(c.img) ?? "")}" alt="" loading="lazy" decoding="async" draggable="false">`
    : c.l ? `<div class="sub">lines ${c.l[0]}–${c.l[1]}</div>` : c.d ? `<div class="sub">${escHtml(c.d)}</div>` : "";
  return `<div class="${cls}" data-sub="${escHtml(c.id)}" style="${pos}" title="${escHtml(c.t)}"><div class="src">${iconHtml(ico, 11)}<span>${escHtml(src)}</span>`
    + `${m ? `<b class="mk${isJoined ? " joined" : ""}">${escHtml(m)}</b>` : ""}</div><div class="ti">${c.k === "code" ? escHtml(c.t).replace(/([._])/g, "$1<wbr>") : escHtml(c.t)}</div>${sub}</div>`;
}

function colsHtml(l: MiniLayout, joined: Joined, mark: string): string {
  const out: string[] = [`<div class="sbin" style="width:${l.w}px;height:${l.h}px">`];
  for (const col of l.cols) {
    out.push(`<h4 class="sbcol${col.color ? ` c-${escHtml(col.color)}` : ""}" style="left:${col.x}px;width:${col.w}px" title="${escHtml(col.t)}"><span>${escHtml(col.t)}</span><em>${col.n}</em></h4>`);
    for (const b of col.cards) out.push(miniHtml(b, joined, mark));
  }
  out.push("</div>");
  return out.join("");
}
