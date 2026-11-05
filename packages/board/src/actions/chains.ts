import {
  uid,
  isCode,
  segOf,
  cardTitle,
  genWhat,
  sameCallSite,
  altIsSeg,
  baseName,
  type CallSpan,
  type CodeCard,
  type ExpandResult,
  type Link,
  type NameHit,
  type Segment,
  type SearchItem,
} from "@codeboard/core";
import type { CallAlt } from "@codeboard/analysis/basics";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { state, cardById } from "../state/store";
import { putViews } from "../state/views";
import { select } from "../state/selection";
import { toast } from "../state/toast";
import { openPop, type ImplPop, type NamesPop } from "../state/pop";
import { ask } from "../host";
import { K, hostRect, popCard, popAlong } from "./common";
import { expandCall, placeExpanded, isLibCall } from "./flow";
import { linksInto } from "./nav";
import { boardRef } from "../state/root";

/** library 包在不在 Study Scope 里：不在的要 ⌥ 才展开 */
const libBlocked = (lib?: string) => !!lib && isLibCall({ pkg: lib });

/** 选了一个实现：建卡连线，其余的留成灰色备选；why 写进箭头的标签框。library 的要 ⌥。回 false = 没展开 */
export function pickImpl(p: ImplPop, i: number, why: string, alt: boolean): boolean {
  const it = p.impls[i];
  if (!it) return false;
  if (libBlocked(it.lib) && !alt) {
    toast(`${it.label} is library code (${it.lib}). ${K.alt}-click to expand it anyway.`);
    return false;
  }
  if (p.link) {
    // 卡已经按定义建好了：选的就是它（基类自己的实现）不用动；别的实现换进来，原来那张变灰（抽象的不留）
    const L = state.board.links.find((l) => l.id === p.link);
    if (!L) return false;
    if (it.base) return true;
    const k = altsOf(L).findIndex((a) => altIsSeg(a.alt, { path: it.path, symbol: { qual: it.qual } }));
    if (k >= 0) {
      void swapAlt(p.link, k, { label: why.trim() || undefined, dropOld: p.abstract });
      return true;
    }
    // 这个实现从同一个调用点已经展开过（另一条分支）：照常再建一张
  }
  const alts = C.implAlts(p.impls.filter((_, k) => k !== i));
  void expandCall(p.card, p.seg, p.call, p.at, { path: it.path, line: it.line, qual: it.qual }, p.again, {
    mark: { impls: p.impls.length, ...(alts.length ? { alts } : {}) },
    label: why.trim() || undefined,
  });
  return true;
}

/** 一个备选：i = 在 call.alts 里的位置；opt = 由取值的 opts 派生的（val 是第几个取值） */
export type AltItem = { alt: CallAlt; i?: number; opt?: { val: number; value: string } };

/** 这条箭头的备选：call.alts（去掉同一个调用点已经展开了的实现）+ 有几个可能取值的那个值的其他取值 */
export function altsOf(L: Link): AltItem[] {
  const c = L.call;
  if (!c) return [];
  const out: AltItem[] = [];
  const open: Segment[] = [];
  for (const l of linksInto(L.to.card).length ? siblings(L) : []) {
    const t = cardById(l.to.card)?.card;
    if (isCode(t) && t.segments[0]) open.push(t.segments[0]);
  }
  (c.alts ?? []).forEach((a, i) => {
    if (!open.some((s) => altIsSeg(a, s))) out.push({ alt: a, i });
  });
  (c.vals ?? []).forEach((v, vi) => {
    for (const o of v.opts ?? [])
      if (o !== v.value)
        out.push({
          alt: { label: `${v.name} → ${o}`, vals: (c.vals ?? []).map((x, k) => (k === vi ? { ...x, value: o } : x)) },
          opt: { val: vi, value: o },
        });
  });
  return out;
}
/** 同一个调用点出去的 Call 箭头（含自己） */
function siblings(L: Link): Link[] {
  return state.board.links.filter((l) => sameCallSite(l, { ...L.from, name: L.call!.name }));
}

/** 段在宿主那边的路径（ExpandPick 用）：工作区仓库里的拼上仓库路径，工作区外的是绝对路径；GitHub、Free 没有 */
function hostPathOf(s: Segment): string | undefined {
  if (s.src.kind === "repo") return s.src.repo ? `${s.src.repo}/${s.path}` : s.path;
  if (s.src.kind === "external") return `${s.src.root.replace(/\/$/, "")}/${s.path}`;
  return undefined;
}

/** 点灰色备选：换成它，原来的变灰。取值的备选只改箭头；别的实现要宿主建卡，原来的卡没有别的箭头就拿掉，有就留着（成了第二条分支） */
export async function swapAlt(linkId: string, k: number, o: { label?: string; dropOld?: boolean } = {}) {
  const L = state.board.links.find((l) => l.id === linkId);
  const item = L ? altsOf(L)[k] : undefined;
  if (!L?.call || !item) return;
  const a = item.alt;
  if (!a.path) {
    if (a.vals) C.swapValues(commandEnv, linkId, a.vals, item.opt ? undefined : item.i);
    return;
  }
  const from = cardById(L.from.card)?.card;
  const seg = isCode(from) && L.from.seg ? segOf(from, L.from.seg) : undefined;
  if (!seg || L.from.line === undefined) return;
  if (libBlocked(a.lib) && !altDown.v) {
    toast(`${a.label} is library code (${a.lib}). ${K.alt}-click to swap it in.`);
    return;
  }
  let r: ExpandResult;
  try {
    r = await ask("expand", {
      seg,
      line: L.from.line,
      col: L.call.col,
      name: L.call.name,
      pick: { path: a.path, line: a.line ?? 1, qual: a.qual },
    });
  } catch (e) {
    toast(`Could not swap in ${a.label}: ${(e as Error).message}`);
    return;
  }
  if (!("card" in r)) {
    toast(`Could not swap in ${a.label}.`);
    return;
  }
  const old = cardById(L.to.card)?.card;
  const os = isCode(old) ? old.segments[0] : undefined;
  const oldAlt: CallAlt | undefined =
    os && hostPathOf(os)
      ? {
          label: os.symbol?.qual ?? cardTitle(old!),
          detail: `${hostPathOf(os)}:${os.start}`,
          path: hostPathOf(os),
          line: os.start,
          qual: os.symbol?.qual,
          ...(L.call.vals ? { vals: L.call.vals } : {}),
        }
      : undefined;
  const newId = r.card.id;
  putViews(r.views);
  const kept = C.swapCall(commandEnv, linkId, r.card as CodeCard, {
    title: r.title,
    alt: item.i!,
    oldAlt: o.dropOld ? undefined : oldAlt,
    w: r.w ?? 560,
    label: o.label,
    vals: a.vals ?? r.mark?.vals,
  });
  if (kept) toast(`Kept ${old ? cardTitle(old) : "the previous card"}: it has its own arrows`);
  select({ cards: [newId] });
  requestAnimationFrame(() => popAlong(newId));
}

// ⌥ 按着没有（点灰色备选时）：备选框是 HTML 元素，点击事件里读
const altDown = boardRef(false);
export const setAltDown = (v: boolean) => {
  altDown.v = v;
};

export function openValPicker(linkId: string, vi: number, el: Element) {
  openPop({ kind: "vals", link: linkId, val: vi }, { el, prefer: "below" });
}
export const setVal = (linkId: string, vi: number, value: string) => C.setCallValue(commandEnv, linkId, vi, value);

/** 按名字搜到的一处 → 卡 + 虚线 Call 箭头（via registry · manual） */
export async function placeNameHit(p: NamesPop, h: NameHit) {
  const item: SearchItem =
    h.def && h.qual
      ? { kind: "symbol", label: h.qual, detail: h.detail, path: h.path, line: h.line, sym: h.qual, glyph: "ƒ" }
      : { kind: "entry", label: h.label, detail: h.detail, path: h.path, line: h.line, end: h.line + 2 };
  const nc = await ask("searchPick", { item }).catch(() => null);
  if (!nc || !isCode(nc.card)) return toast(`Could not open ${h.detail}`);
  // 按字符串转发的（call("run")）：箭头上写 via call("run")
  const via = p.call.dispatch ? `${p.call.name}("${p.call.dispatch}")` : "registry";
  placeExpanded(p.card, p.seg, p.call, nc.card, nc.views, [], undefined, nc.w, {
    mark: { ev: { kind: "manual", via } },
  });
}

/** 连接模式点到了卡：手动的 Call 箭头（虚线，证据 manual） */
export function manualCallTo(from: { card: string; seg?: string; line?: number; call: CallSpan }, to: string) {
  const r = C.manualCall(commandEnv, from, to);
  if (!r) return;
  if ("why" in r) return toast(r.why);
  toast(`Linked to ${cardTitle(cardById(to)!.card)} (manual)`);
}

const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 从这一行（或这张卡）加 Generated 卡：内容来自剪贴板或选的文件；Generated from 的点线连回这一行 */
export async function addGenerated(at: { card: string; seg?: string; line?: number }, from: "clipboard" | "file") {
  const src = await ask("genSource", { from }).catch(() => null);
  if (!src) return toast(from === "clipboard" ? "The clipboard has no text." : "No file chosen.");
  const lines = src.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const seg: Segment = {
    id: uid("s"),
    src: { kind: "free" },
    path: "",
    lang: src.lang,
    start: 1,
    end: lines.length,
    text: lines,
    version: { kind: "none" },
  };
  const name = baseName(src.name);
  const card: CodeCard = {
    id: uid("c"),
    kind: "code",
    segments: [seg],
    gen: { what: genWhat(src.lang, src.name, src.text), run: `${name ? `${name} · ` : "run "}${hhmm()}` },
  };
  const views = await ask("views", { segs: [seg] }).catch(() => ({}));
  putViews(views);
  const r = hostRect(at.card);
  // 放在来源卡下面（右边是灰色备选的位置）
  C.addGenerated(commandEnv, card, at, {
    x: Math.round((r?.x ?? 0) + 40),
    y: Math.round((r?.y ?? 0) + (r?.h ?? 200) + 80),
    w: 520,
  });
  select({ cards: [card.id] });
  requestAnimationFrame(() => popCard(card.id));
}

export const setGenRun = (id: string, v: string) => C.setGenRun(commandEnv, id, v);

/** 动态分发选出来的卡：「1 of N」 */
export function dispatchOf(id: string): number {
  return linksInto(id).find((l) => l.call?.impls)?.call?.impls ?? 0;
}
