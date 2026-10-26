// 代码卡上贴在字上的手写标注（Segment.annots）：选一段字加一条、双击改字、右键换颜色 / 上下 / 删。代码本身不动。
// 新加的一条先是草稿（annotDraft），写了字才进白板和撤销栈；什么都没写就消失
import { createSignal } from "solid-js";
import { findCard, isCode, HAND_COLORS, type Board, type CodeAnnot, type HandColor } from "@codeboard/core";
import { mutate } from "../state/store";
import { setEditing } from "../state/ui";
import { openMenu } from "../ui/Menu";

/** 正在写的新标注：哪张卡、哪一段、第几行、第几到第几个字 */
export type AnnotDraft = { card: string; seg: string; line: number; from: number; to: number };
export const [annotDraft, setAnnotDraft] = createSignal<AnnotDraft | null>(null);
/** 原地编辑（Editable）的 id：卡|段|第几条；草稿是 "draft" */
export const annotKey = (card: string, seg: string, i: number) => `${card}|${seg}|${i}`;

const segIn = (b: Board, card: string, seg: string) => { const c = findCard(b, card)?.card; return isCode(c) ? c.segments.find((s) => s.id === seg) : undefined; };

/** 选中的一段字（同一行）：先出草稿，写了字再加上 */
export function startAnnot(d: AnnotDraft) {
  if (d.to <= d.from) return;
  setAnnotDraft(d);
  setEditing({ kind: "annot", id: "draft" });
}
/** 草稿写完：有字就加上（和它重叠的旧标注换掉），没字就算了 */
export function commitDraft(text: string) {
  const d = annotDraft();
  setAnnotDraft(null);
  const t = text.trim();
  if (!d || !t) return;
  // 新标注接着用这张卡上一条的颜色
  mutate((b) => {
    const s = segIn(b, d.card, d.seg);
    if (!s) return;
    const color = s.annots?.[s.annots.length - 1]?.color;
    const a: CodeAnnot = { line: d.line, from: d.from, to: d.to, text: t, ...(color ? { color } : {}) };
    s.annots = [...(s.annots ?? []).filter((x) => x.line !== d.line || x.to <= d.from || x.from >= d.to), a];
  });
}

function edit(card: string, seg: string, i: number, f: (a: CodeAnnot) => void) {
  mutate((b) => { const a = segIn(b, card, seg)?.annots?.[i]; if (a) f(a); });
}
export function removeAnnot(card: string, seg: string, i: number) {
  mutate((b) => {
    const s = segIn(b, card, seg);
    if (!s?.annots?.[i]) return;
    const rest = s.annots.filter((_, k) => k !== i);
    if (rest.length) s.annots = rest; else delete s.annots;
  });
}
/** 改字；删空 = 删掉这条 */
export function setAnnotText(card: string, seg: string, i: number, text: string) {
  const t = text.trim();
  if (!t) return removeAnnot(card, seg, i);
  edit(card, seg, i, (a) => { a.text = t; });
}
export const setAnnotColor = (card: string, seg: string, i: number, color: HandColor) => edit(card, seg, i, (a) => { if (color === "blue") delete a.color; else a.color = color; });
export const setAnnotBelow = (card: string, seg: string, i: number, below: boolean) => edit(card, seg, i, (a) => { if (below) a.below = true; else delete a.below; });

/** 右键标签：颜色、上 / 下、改字、删 */
export function annotMenu(card: string, seg: string, i: number, a: CodeAnnot, x: number, y: number) {
  const cap = (k: string) => k[0].toUpperCase() + k.slice(1);
  openMenu([
    { label: "Edit Text", kbd: "Double-click", run: () => setEditing({ kind: "annot", id: annotKey(card, seg, i) }) },
    { label: "Color", sub: HAND_COLORS.map((k) => ({ label: cap(k), checked: (a.color ?? "blue") === k, run: () => setAnnotColor(card, seg, i, k) })) },
    { label: "Above the Line", checked: !a.below, run: () => setAnnotBelow(card, seg, i, false) },
    { label: "Below the Line", checked: !!a.below, run: () => setAnnotBelow(card, seg, i, true) },
    null,
    { label: "Remove Annotation", danger: true, run: () => removeAnnot(card, seg, i) },
  ], x, y);
}
