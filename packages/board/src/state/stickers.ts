// 每张卡、每条线只问自己那一组：拖一枚贴纸时索引重算一次，没变的组还是原来的数组，卡和线都不用重算
import { createMemo, createSelector, createSignal } from "solid-js";
import type { Sticker } from "@codeboard/core";
import { state } from "./store";
import { rooted, boardSignal } from "./root";

/** 选图标面板：开在哪个按钮上面 */
export const [stickerPick, setStickerPick] = createSignal<{ x: number; y: number } | null>(null);
/** 选图标面板里上次选的颜色 */
export const [stickerColor, setStickerColor] = createSignal<string | undefined>(undefined);
export const [selSticker, setSelSticker] = boardSignal<string | null>(null);
export const isSelSticker = rooted(() => createSelector(selSticker));

/** 拖贴纸时指针下面能绑的东西（亮起来） */
export type BindTarget = { card: string } | { link: string };
const [bindHot, setBindHotKey] = boardSignal<string | null>(null);
const keyOf = (t: BindTarget | null) => (!t ? null : "card" in t ? `card:${t.card}` : `link:${t.link}`);
export const setBindHot = (t: BindTarget | null) => setBindHotKey(keyOf(t));
/** 这张卡 / 这条线是不是拖动中的贴纸要绑上去的目标：只通知变了的那两个 */
export const isBindHot = rooted(() => createSelector(bindHot));

const NONE: Sticker[] = [];
type Groups = Map<string, Sticker[]>;
/** 绑在卡上的、贴在代码行上的（按卡）、绑在线上的（按线）、画布上没绑东西的 */
type Index = { bound: Groups; lines: Groups; links: Groups; free: Sticker[] };
const sameList = (a: readonly Sticker[], b: readonly Sticker[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
/** 和上一次一样的组沿用上一次的数组：下游按引用比较就知道没变 */
function keep(next: Groups, prev: Groups | undefined) {
  if (prev)
    for (const [k, a] of next) {
      const p = prev.get(k);
      if (p && sameList(p, a)) next.set(k, p);
    }
  return next;
}
const index = rooted(() =>
  createMemo<Index | undefined>((prev) => {
    const m: Index = { bound: new Map(), lines: new Map(), links: new Map(), free: [] };
    const add = (g: Groups, k: string, s: Sticker) => {
      const a = g.get(k);
      a ? a.push(s) : g.set(k, [s]);
    };
    for (const s of state.board.stickers) {
      const at = s.at;
      if (at.kind === "line") add(m.lines, at.card, s);
      else if (!at.on) m.free.push(s);
      else if ("card" in at.on) add(m.bound, at.on.card, s);
      else add(m.links, at.on.link, s);
    }
    return {
      bound: keep(m.bound, prev?.bound),
      lines: keep(m.lines, prev?.lines),
      links: keep(m.links, prev?.links),
      free: prev && sameList(prev.free, m.free) ? prev.free : m.free,
    };
  }),
);
const group = (k: "bound" | "lines" | "links") => (id: string) => index()![k].get(id) ?? NONE;
export const freeStickers = () => index()!.free;
export const boundStickers = group("bound");
export const lineStickers = group("lines");
export const linkStickers = group("links");
/** 一组贴纸的 memo（引用没变就不通知） */
export const stickerList = (f: () => Sticker[]) => createMemo(f, NONE, { equals: sameList });

/** 选中的贴纸绑在哪张卡上（那张卡画一圈虚线） */
const anchorCard = rooted(() =>
  createMemo(() => {
    const id = selSticker();
    const s = id ? state.board.stickers.find((k) => k.id === id) : undefined;
    return s?.at.kind === "canvas" && s.at.on && "card" in s.at.on ? s.at.on.card : null;
  }),
);
export const isBindAnchor = rooted(() => createSelector(anchorCard));
