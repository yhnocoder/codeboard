// 子白板框：一张静态的预览。名字和卡数在框外上方（大字），框里一个 Section 一栏（栏名 + 卡数），栏里是固定字号的小卡片
// （出处、标题、一行摘要），右边、下边放不下的渐隐。不滚动、不画箭头，箭头只连到整个框。
// 排布在 state/subboards.ts 里算好（miniLayout），这里只把框里看得见的那些按位置拼成一段 HTML 一次放进去（不是每张小卡片一个组件）：
// 拖别的卡、平移缩放都不碰它，只有骨架换了（宿主推来新的）、框改大小改到露出 / 盖住一整张小卡片时才重新拼。
import { createMemo, Show } from "solid-js";
import { escHtml } from "@codeboard/core";
import type { BoardCard, SkelCard } from "@codeboard/core";
import { flows, placeOf, state } from "../state/store";
import { skels, layoutOf, COLS_TOP, type MiniLayout, type MiniBox, type MiniCol } from "../state/subboards";
import { assetSrc } from "../actions/web";
import { Icon, iconHtml } from "../ui/icons";
import { MarkView } from "./Card";

/** 框没定高度时的高（和 Turn into Board 拆出来的框差不多） */
const FRAME_H = 320;

/** 框里看得见的：每一栏和它露出来的小卡片（左上角在分栏区里的，含渐隐里露出一截的那一行、那一栏）；key 只在这一份变了时变 */
type Shown = { l: MiniLayout; cols: { col: MiniCol; cards: MiniBox[] }[]; key: string };
function shownIn(l: MiniLayout, w: number, h: number): Shown {
  const cols: Shown["cols"] = [];
  for (const col of l.cols) {
    if (col.x >= w) break;
    cols.push({ col, cards: col.cards.filter((b) => b.x < w && b.y < h) });
  }
  return { l, cols, key: cols.map((c) => c.cards.length).join() };
}

export function BoardBody(p: { card: BoardCard }) {
  const sk = () => skels[p.card.board];
  const pl = () => placeOf(p.card.id);
  // 父白板上的调用图连到这个框：名字前面是它的标记
  const node = createMemo(() => flows().byId.get(p.card.id));
  // 设置 Sub-board Preview = Title Only：框外只有名字和卡数，框里不画小卡片
  const titleOnly = () => state.host.settings.subPreview === "title";
  const layout = createMemo(() => (sk() && !titleOnly() ? layoutOf(p.card.board) : null));
  const size = () => ({ w: pl().w, h: (pl().h ?? FRAME_H) - COLS_TOP });
  const shown = createMemo(() => { const l = layout(); if (!l) return null; const s = size(); return shownIn(l, s.w, s.h); }, null,
    { equals: (a, b) => a?.l === b?.l && a?.key === b?.key });
  const html = createMemo(() => { const s = shown(); return s ? colsHtml(s) : ""; });
  // 放不下的那一边渐隐（不随别的变：框里不滚）
  const fadeR = () => { const l = layout(); return !!l && l.w > size().w + 1; };
  const fadeB = () => { const l = layout(); return !!l && l.h > size().h + 1; };
  const name = () => p.card.title || sk()?.name || (sk() === null ? "Board not found" : "Loading…");
  const count = () => { const s = sk(); return s ? String(s.n) : ""; };
  return (
    <>
      <div class="sbhead">
        <Show when={node()}><span class="step" data-drag><MarkView g={node()!} /></span></Show>
        <span class="sbname" data-drag title={name()}>{name()}</span>
        <Show when={sk()}><span class="sbmeta" data-drag title={`${sk()!.n} card${sk()!.n === 1 ? "" : "s"}`}>{count()}</span></Show>
        <Show when={sk()?.commit}><span class="sbcommit" data-drag>{sk()!.commit}</span></Show>
      </div>
      <Show when={sk() === null}><div class="sbgone" data-drag>This board was deleted or can’t be read.</div></Show>
      {/* 地图档时浮在框上面的名字（字号按 --iz 放大） */}
      <div class="sbfar">{p.card.title || sk()?.name || ""}</div>
      <Show when={titleOnly() && sk()} fallback={
        <div class="skel sbcols" classList={{ "fade-r": fadeR(), "fade-b": fadeB() }} data-drag innerHTML={html()} />
      }>
        <div class="sbonly" data-drag><Icon name="boards" size={28} /></div>
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

function miniHtml(b: MiniBox): string {
  const c = b.c;
  const pos = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;--tl:${b.tl}`;
  if (c.k === "more") return `<div class="mini k-more" data-sub="${escHtml(c.id)}" style="${pos}"><div class="ti sk-more">${escHtml(c.t)}</div></div>`;
  const m = c.m ?? (c.i ? "◆" : "");
  const [ico, src] = srcOf(c);
  const cls = `mini k-${c.k}${c.hand ? " sticky" : ""}${c.sec ? ` s-${escHtml(c.sec)}` : ""}`;
  const sub = c.hand ? "" : c.img ? `<img class="thumb" src="${escHtml(assetSrc(c.img) ?? "")}" alt="" loading="lazy" decoding="async" draggable="false">`
    : c.l ? `<div class="sub">lines ${c.l[0]}–${c.l[1]}</div>` : c.d ? `<div class="sub">${escHtml(c.d)}</div>` : "";
  return `<div class="${cls}" data-sub="${escHtml(c.id)}" style="${pos}" title="${escHtml(c.t)}"><div class="src">${iconHtml(ico, 11)}<span>${escHtml(src)}</span>`
    + `${m ? `<b class="mk">${escHtml(m)}</b>` : ""}</div><div class="ti">${c.k === "code" ? escHtml(c.t).replace(/([._])/g, "$1<wbr>") : escHtml(c.t)}</div>${sub}</div>`;
}

function colsHtml(s: Shown): string {
  const out: string[] = [`<div class="sbin">`];
  for (const { col, cards } of s.cols) {
    out.push(`<h4 class="sbcol${col.color ? ` c-${escHtml(col.color)}` : ""}" style="left:${col.x}px;width:${col.w}px" title="${escHtml(col.t)}"><span>${escHtml(col.t)}</span><em>${col.n}</em></h4>`);
    for (const b of cards) out.push(miniHtml(b));
  }
  out.push("</div>");
  return out.join("");
}
