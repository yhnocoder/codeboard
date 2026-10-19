// 子白板框：标题栏（名字 · 卡数 · commit）+ 骨架（风格 C：带名字的骨架，跟 v0.1.5 概览档同一套样子：卡的框、名字、调用图标记、代码灰条、Section 色）。
// 整个骨架是一张 SVG，按骨架和框的大小拼成一段字符串一次放进去（不是每张卡一个组件）：拖别的卡、平移缩放都不碰它，
// 只有子白板存盘（宿主推来新骨架）、框改大小、连进来的箭头变了才重新拼。地图档只剩灰块和 Section 色（styles.css）。
import { createMemo, Show } from "solid-js";
import { escHtml } from "@codeboard/core";
import type { BoardCard, Skeleton } from "@codeboard/core";
import { flows, placeOf, state } from "../state/store";
import { dropTarget } from "../state/ui";
import { skels, fitSkel, skelBox, LABEL_H } from "../state/subboards";
import { linksInto } from "../actions/nav";
import { Icon } from "../ui/icons";
import { MarkView } from "./Card";

type Joined = { g: Set<number>; cards: Set<string> };
const key = (j: Joined) => `${[...j.g].join(",")}|${[...j.cards].join(",")}`;
/** 名字按宽度截断（11px 系统字体大约 6.2px 一个字） */
const clip = (t: string, w: number) => { const n = Math.max(1, Math.floor(w / 6.2)); return t.length <= n ? t : `${t.slice(0, Math.max(1, n - 1))}…`; };

export function BoardBody(p: { card: BoardCard }) {
  const sk = () => skels[p.card.board];
  const pl = () => placeOf(p.card.id);
  // 父白板上的调用图（框连进来的箭头）：它连到的骨架里那几张图改用父白板的标记
  const node = createMemo(() => flows().byId.get(p.card.id));
  // 连到的卡本身（不在子白板的调用图里也算）和它所在的调用图
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
  const hot = createMemo(() => { const d = dropTarget(); return d?.card === p.card.id ? d.sub : undefined; });
  // 设置 Sub-board Preview = Title Only：框里只有名字和卡数
  const titleOnly = () => state.host.settings.subPreview === "title";
  const svg = createMemo(() => {
    const s = sk();
    if (!s || titleOnly()) return "";
    const w = pl().w, h = pl().h ?? 320;
    return skelSvg(s, p.card.id, w, h, joined(), node()?.label ?? "", hot());
  });
  const meta = () => { const s = sk(); return s ? `${s.n} card${s.n === 1 ? "" : "s"}${s.commit ? ` · ${s.commit}` : ""}` : ""; };
  return (
    <>
      <div class="sbhead" data-drag>
        <Show when={node()}><span class="step"><MarkView g={node()!} /></span></Show>
        <Icon name="boards" size={13} />
        <span class="sbname">{p.card.title || sk()?.name || (sk() === null ? "Board not found" : "Loading…")}</span>
        <span class="sbmeta">{meta()}</span>
      </div>
      <Show when={sk() === null}><div class="sbgone" data-drag>This board was deleted or can’t be read.</div></Show>
      {/* 地图档时浮在框上面的名字（字号按 --iz 放大） */}
      <div class="sbfar">{p.card.title || sk()?.name || ""}</div>
      <Show when={titleOnly() && sk()} fallback={<svg class="skel" data-drag width={pl().w} height={pl().h ?? 320} innerHTML={svg()} />}>
        <div class="sbonly" data-drag><b>{p.card.title || sk()!.name}</b><small>{meta()}</small></div>
      </Show>
    </>
  );
}

/**
 * 骨架拼成 SVG。坐标是框里的（相对框左上角，世界坐标单位）。每张卡一个 <g data-sub>（箭头连到骨架里哪张卡靠它认），
 * 里面一个框、一行名字（标记 + 名字），够高的话名字下面是代码灰条（概览档同一套 --bar 颜色）
 */
function skelSvg(s: Skeleton, frame: string, w: number, h: number, joined: Joined, mark: string, hot?: string): string {
  const f = fitSkel(w, h, s);
  const out: string[] = [];
  const pid = `skb-${frame}`;
  out.push(`<defs><pattern id="${pid}" width="8" height="7" patternUnits="userSpaceOnUse"><rect class="sk-bar" x="0" y="1" width="8" height="3"/></pattern></defs>`);
  for (const sc of s.secs) {
    const x = f.ox + sc.x * f.s, y = f.oy + sc.y * f.s;
    out.push(`<rect class="sk-sec${sc.color ? ` c-${escHtml(sc.color)}` : ""}" x="${x}" y="${y}" width="${sc.w * f.s}" height="${sc.h * f.s}" rx="4"/>`);
    if (sc.t && sc.w * f.s > 40) out.push(`<text class="sk-t sk-st" x="${x + 5}" y="${y + 10}">${escHtml(clip(sc.t, sc.w * f.s - 10))}</text>`);
  }
  // 连线（Call 一条 path、普通箭头一条 path）：从名字那一行的右边出、进目标名字那一行的左边
  const boxes = s.cards.map((c) => skelBox(c, f));
  let call = "", plain = "";
  for (let i = 0; i < s.links.length; i += 3) {
    const a = boxes[s.links[i]], b = boxes[s.links[i + 1]];
    if (!a || !b) continue;
    const ay = a.y + LABEL_H / 2, by = b.y + LABEL_H / 2;
    let d: string;
    if (b.x >= a.x + a.w - 2) {
      const ax = a.x + a.w, dx = Math.max(10, (b.x - ax) / 2);
      d = `M${ax} ${ay}C${ax + dx} ${ay} ${b.x - dx} ${by} ${b.x} ${by}`;
    } else {
      // 目标在左边 / 下面：从左边出、绕进目标左边
      const ax = a.x, x0 = Math.min(a.x, b.x) - 10;
      d = `M${ax} ${ay}C${x0} ${ay} ${x0} ${by} ${b.x} ${by}`;
    }
    if (s.links[i + 2]) call += d; else plain += d;
  }
  if (call) out.push(`<path class="sk-l call" d="${call}"/>`);
  if (plain) out.push(`<path class="sk-l" d="${plain}"/>`);
  s.cards.forEach((c, i) => {
    const b = boxes[i];
    const more = c.k === "more";
    const cls = `sk-c k-${c.k}${c.sec ? ` s-${escHtml(c.sec)}` : ""}${hot && (c.id === hot || c.ids?.includes(hot)) ? " hot" : ""}`;
    out.push(`<g class="${cls}" data-sub="${escHtml(c.id)}">`);
    out.push(`<rect class="sk-box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${more ? 3 : 2.5}"/>`);
    if (!more && c.k === "code" && b.h > LABEL_H + 8) out.push(`<rect class="sk-bars" x="${b.x + 5}" y="${b.y + LABEL_H + 2}" width="${Math.max(0, b.w - 10)}" height="${b.h - LABEL_H - 6}" fill="url(#${pid})"/>`);
    let tx = b.x + 4;
    const isJoined = !!mark && ((c.g !== undefined && joined.g.has(c.g)) || joined.cards.has(c.id));
    const m = isJoined ? mark : c.m ?? (c.i ? "◆" : "");
    if (m && !more) {
      const mw = 6 + m.length * 6.5;
      out.push(`<rect class="sk-mk${isJoined ? " joined" : ""}" x="${tx}" y="${b.y + 2.5}" width="${mw}" height="${LABEL_H - 5}" rx="3"/>`);
      out.push(`<text class="sk-t sk-mt" x="${tx + mw / 2}" y="${b.y + LABEL_H / 2 + 3.5}">${escHtml(m)}</text>`);
      tx += mw + 4;
    }
    out.push(`<text class="sk-t${more ? " sk-more" : ""}" x="${tx}" y="${b.y + LABEL_H / 2 + 4}">${escHtml(clip(c.t, b.x + b.w - tx - 3))}</text>`);
    out.push(`</g>`);
  });
  return out.join("");
}
